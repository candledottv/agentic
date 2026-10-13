import { afterEach, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const ADDRESS = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const EMBEDDED = "2smeu2LkAy7CjBPmohNreUWrB9J49Q5EyFrCgaktMMLj"
const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 9), Buffer.alloc(40)]).toString("base64")
const signature = base58.encode(Buffer.alloc(64, 9))
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
async function fixture(
  opts: {
    prompt?: string
    pending?: boolean
    refused?: boolean
    dropFirstSubmit?: boolean
    ready?: number
    wrongWallet?: boolean
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-stake-"))
  folders.push(dir)
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const stdout = createCapture()
  const stderr = createCapture()
  const position = (payer: string, address: string) => ({
    payer,
    address,
    ...(payer === "linked" ? { linkedWalletId: "wallet", tee: true, label: "tee" } : {}),
    cndl: { decimals: 6, amountRaw: "500000000" },
    staked: { decimals: 6, amountRaw: "300000000" },
    pendingWithdrawalRaw: "100",
    withdrawals: {
      active: Array.from({ length: opts.ready ?? 1 }, (_, i) => ({
        withdrawal: `withdrawal-${i}`,
        amountRaw: "100",
        endTime: "2026-01-01T00:00:00Z",
        claimable: true,
      })),
      finished: [],
    },
    unclaimedRewards: [{ rewardId: `${payer}-reward`, mint: "mint", amountRaw: "10" }],
  })
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    const ok = (value: unknown) => Response.json(value)
    if (path === "/api/v1/agent/staking")
      return ok({
        success: true,
        pool: { withdrawalTimelockSeconds: 604800, paused: false, maxActiveWithdrawals: 10 },
        notes: ["Pending CNDL counts toward nothing for Pro"],
        wallets: [position("main", EMBEDDED), position("linked", ADDRESS)],
      })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["swap:write"],
        privyAppId: "app",
        page: [
          {
            id: "wallet",
            address: ADDRESS,
            label: "tee",
            chain: "solana",
            active: true,
            privyWalletId: "privy",
            allowLaunch: false,
          },
        ],
        isDone: true,
      })
    if (path.endsWith("/build")) {
      if (opts.refused)
        return Response.json(
          { success: false, error: { code: "LAUNCH_DISABLED", message: "Agent staking is disabled" } },
          { status: 503 },
        )
      const action = path.split("/")[5]
      const wallet = opts.wrongWallet ? "stranger" : body.payer === "linked" ? ADDRESS : EMBEDDED
      return ok({
        success: true,
        ...body,
        action,
        wallet,
        amountRaw: body.amountRaw ?? "100",
        figures: { rentLamports: "20" },
        ...(body.dryRun
          ? {}
          : body.payer === "linked"
            ? { status: "built", transaction: "co-signed-build" }
            : { status: "confirmed", signature: "embedded-signature" }),
      })
    }
    if (path.endsWith("/sign")) return ok({ signedTransaction: signed, encoding: "base64" })
    if (path.endsWith("/submit") && opts.dropFirstSubmit && calls.filter((c) => c.path === path).length === 1)
      return new Response("unavailable", { status: 503 })
    if (path.endsWith("/submit") && opts.pending && calls.filter((c) => c.path === path).length === 1)
      return Response.json(
        {
          success: false,
          error: { code: "STAKING_TRANSACTION_PENDING", message: "Retry the same clientStakeId", retryable: true },
        },
        { status: 409 },
      )
    if (path.endsWith("/submit") || path.endsWith("/confirm"))
      return ok({ success: true, status: "confirmed", signature, clientStakeId: body.clientStakeId })
    if (path.endsWith("/claim")) return ok({ success: true, signature: "reward-signature" })
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "key" },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  return { calls, deps, stdout, stderr }
}

test("positions reads only and filters the named wallet in JSON", async () => {
  const f = await fixture()
  expect(await run(["stake", "--wallet", "tee", "--json"], f.deps)).toBe(0)
  expect(JSON.parse(f.stdout.text).wallets).toHaveLength(1)
  expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agent/staking"])
})
for (const verb of ["add", "remove", "finish"] as const) {
  test(`${verb} previews the wallet and costs before the embedded build`, async () => {
    const f = await fixture()
    expect(
      await run(
        ["stake", verb, ...(verb === "finish" ? [] : ["1.5"]), "--client-stake-id", `${verb}-id`, "--yes", "--json"],
        f.deps,
      ),
    ).toBe(0)
    const builds = f.calls.filter((c) => c.path.endsWith("/build"))
    expect(builds).toHaveLength(2)
    expect(builds[0]?.body).toMatchObject({ payer: "main", dryRun: true, clientStakeId: `${verb}-id` })
    expect(builds[1]?.body).not.toHaveProperty("dryRun")
    expect(builds[1]?.body).not.toHaveProperty("instant")
    expect(builds[1]?.body).toHaveProperty(
      verb === "finish" ? "withdrawal" : "amountRaw",
      verb === "finish" ? "withdrawal-0" : "1500000",
    )
    expect(f.stderr.text).toContain(EMBEDDED)
    expect(f.stderr.text).toContain("604800")
    expect(f.stderr.text).toContain("rentLamports")
  })
}

test("declined approval creates no build or relay signature", async () => {
  const f = await fixture({ prompt: "n" })
  expect(await run(["stake", "add", "1"], f.deps)).toBe(0)
  expect(f.calls.filter((c) => c.path.endsWith("/build"))).toHaveLength(1)
  expect(f.stdout.text).toContain("cancelled")
})

test("TEE submit saves the signed transaction and a rerun posts it to /submit again", async () => {
  const f = await fixture({ pending: true })
  const args = ["stake", "remove", "1", "--wallet", "tee", "--client-stake-id", "resume-id", "--yes", "--json"]
  expect(await run(args, f.deps)).not.toBe(0)
  const before = f.calls.length
  expect(await run(args, f.deps)).toBe(0)
  expect(f.calls.slice(before)).toEqual([
    { path: "/api/v1/agent/staking/submit", body: { clientStakeId: "resume-id", signedTransaction: signed } },
  ])
  expect(f.calls.filter((c) => c.path.endsWith("/sign"))).toHaveLength(1)
  expect(f.calls.find((c) => c.path.endsWith("/sign"))?.body).toHaveProperty(
    "body.params.transaction",
    "co-signed-build",
  )
})

test("a rerun whose first /submit was dropped lands the same transaction", async () => {
  const f = await fixture({ dropFirstSubmit: true })
  const args = ["stake", "add", "1", "--wallet", "tee", "--client-stake-id", "dropped-id", "--yes", "--json"]
  expect(await run(args, f.deps)).not.toBe(0)
  expect(await run(args, f.deps)).toBe(0)
  const submits = f.calls.filter((c) => c.path.endsWith("/submit"))
  expect(submits).toHaveLength(2)
  expect(submits[1]?.body).toEqual(submits[0]?.body)
  expect(f.calls.filter((c) => c.path.endsWith("/confirm"))).toHaveLength(0)
  expect(f.calls.filter((c) => c.path.endsWith("/sign"))).toHaveLength(1)
})

test("an embedded rerun with a reused id and other input is an idempotency conflict", async () => {
  const f = await fixture()
  const run1 = (amount: string, extra: string[] = []) =>
    run(["stake", "add", amount, "--client-stake-id", "reused", "--yes", "--json", ...extra], f.deps)
  expect(await run1("1")).toBe(0)
  const before = f.calls.length
  expect(await run1("500")).not.toBe(0)
  expect(await run1("1", ["--wallet", "tee"])).not.toBe(0)
  expect(f.stdout.text).toContain("IDEMPOTENCY_CONFLICT")
  expect(f.calls.slice(before).filter((c) => c.path.endsWith("/build"))).toHaveLength(0)
  expect(await run1("1")).toBe(0)
})

for (const all of [false, true]) {
  test(`claim ${all ? "all" : "one"} posts only to the recorded reward ids`, async () => {
    const f = await fixture()
    expect(await run(["stake", "claim", ...(all ? ["--all"] : ["main-reward"]), "--yes", "--json"], f.deps)).toBe(0)
    expect(f.calls.filter((c) => c.path.endsWith("/claim")).map((c) => c.path)).toEqual(
      all
        ? ["/api/v1/agent/staking/rewards/main-reward/claim", "/api/v1/agent/staking/rewards/linked-reward/claim"]
        : ["/api/v1/agent/staking/rewards/main-reward/claim"],
    )
  })
}

test("invalid amount, instant flag, ambiguous finish, disabled rail and mismatched preview refuse safely", async () => {
  const f = await fixture({ ready: 2 })
  expect(await run(["stake", "add", "0", "--yes"], f.deps)).not.toBe(0)
  expect(f.calls).toHaveLength(0)
  expect(await run(["stake", "remove", "1", "--instant", "--yes"], f.deps)).toBe(2)
  expect(f.calls).toHaveLength(0)
  expect(await run(["stake", "finish", "--yes"], f.deps)).not.toBe(0)
  expect(f.calls.filter((c) => c.path.endsWith("/build"))).toHaveLength(0)
  for (const opts of [{ refused: true }, { wrongWallet: true }]) {
    const other = await fixture(opts)
    expect(await run(["stake", "add", "1", "--yes"], other.deps)).not.toBe(0)
    expect(other.calls.filter((c) => c.path.endsWith("/build"))).toHaveLength(1)
  }
})

test("embedded retry replays its saved build before another balance preview", async () => {
  const f = await fixture()
  const args = ["stake", "add", "1", "--client-stake-id", "embedded-retry", "--yes", "--json"]
  expect(await run(args, f.deps)).toBe(0)
  const before = f.calls.length
  expect(await run(args, f.deps)).toBe(0)
  expect(f.calls.slice(before)).toEqual([
    { path: "/api/v1/agent/staking" },
    {
      path: "/api/v1/agent/staking/stake/build",
      body: { payer: "main", clientStakeId: "embedded-retry", amountRaw: "1000000" },
    },
  ])
})
