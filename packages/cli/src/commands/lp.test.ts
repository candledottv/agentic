/**
 * Ember Phase 3 PR D, CLI half (BE-315, R4): `candle lp pools | add | positions | remove | claim`
 * against a routed fake of the LP server half (#1200) and a fake Solana RPC. Every write proves
 * the same four things `candle swap` does: the bound key authenticates, the server's build is
 * shown and confirmed before anything is signed, the relay signs the payer and nothing local
 * does, and the broadcast is followed by `/confirm` with the signature. Nothing in this file opens
 * a vault or a TEE key.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const TEE = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const TEE_2 = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const POOL = "GhaxKRBqxV1ZDKQQ4ZVgb9P2tKzHqmRrTV1Yb7d6Ug9Q"
const POSITION = "2smeu2LkAy7CjBPmohNreUWrB9J49Q5EyFrCgaktMMLj"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SOL = "So11111111111111111111111111111111111111112"
const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 9), Buffer.alloc(40)]).toString("base64")
const signature = base58.encode(Buffer.alloc(64, 9))
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface Options {
  scopes?: string[]
  prompt?: string
  /** What `getSignatureStatuses` answers, in order; the last repeats. */
  statuses?: Array<{ confirmationStatus: string | null; err: unknown } | null>
  /** The server already holds a confirmation for the build (a replay after a crash). */
  builtSignature?: string
  /** `LP_ENABLED` off: the router answers a bare 404. */
  lpDisabled?: boolean
  /** Which wallet's positions list holds POSITION; both by default hold none but the first. */
  holder?: "wallet" | "wallet-2" | "none"
  preview?: Record<string, unknown>
  teeWallets?: number
  /** BE-355 (T11, T12): RPC methods that always answer HTTP 429. */
  rpcRateLimit?: string[]
}

async function fixture(opts: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-lp-"))
  folders.push(dir)
  const calls: { path: string; query: string; method: string; body: Record<string, unknown> | undefined }[] = []
  let statusIndex = 0
  const statuses = opts.statuses ?? [{ confirmationStatus: "confirmed", err: null }]
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, query: url.search, method: init?.method ?? "GET", body })
    const ok = (value: unknown) => Response.json(value)
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["lp:write", "swap:write"],
        privyAppId: "app",
        page: Array.from({ length: opts.teeWallets ?? 2 }, (_unused, index) => ({
          id: index === 0 ? "wallet" : `wallet-${index + 1}`,
          address: index === 0 ? TEE : TEE_2,
          label: index === 0 ? "tee" : `tee-${index + 1}`,
          chain: "solana",
          active: true,
          allowLaunch: false,
          privyWalletId: `privy-${index}`,
        })),
        isDone: true,
      })
    if (path.startsWith("/api/v1/agent/lp/")) {
      if (opts.lpDisabled) return new Response("404 Not Found", { status: 404 })
      if (path.startsWith("/api/v1/agent/lp/pools/"))
        return ok({
          success: true,
          page: 1,
          pages: 1,
          pools: [
            {
              pool: POOL,
              tokens: [USDC_MINT, SOL],
              liquidityUsd: 125000.5,
              baseFeePercent: 0.25,
              volume24hUsd: 4200,
              estimatedAprPercent: 12.3,
            },
          ],
        })
      if (path === "/api/v1/agent/lp/positions") {
        const wallet = url.searchParams.get("linkedWalletId")
        const holder = opts.holder ?? "wallet"
        const held =
          wallet === holder
            ? [
                {
                  position: POSITION,
                  pool: POOL,
                  tokens: [
                    { mint: USDC_MINT, decimals: 6, amountRaw: "1500000", unclaimedFeesRaw: "2500", valueUsd: 1.5 },
                    { mint: SOL, decimals: 9, amountRaw: "10000000", unclaimedFeesRaw: "0", valueUsd: null },
                  ],
                  poolShare: 0.0001,
                  valueUsd: null,
                },
              ]
            : []
        return ok({ success: true, positions: held })
      }
      if (path.endsWith("/build")) {
        const action = path.split("/")[5]
        return ok({
          success: true,
          build: {
            action,
            pool: POOL,
            position: POSITION,
            transaction: "unsigned-lp",
            walletAddress: body.linkedWalletId === "wallet-2" ? TEE_2 : TEE,
            linkedWalletId: body.linkedWalletId,
            clientTradeId: body.clientTradeId,
            ...(opts.builtSignature ? { signature: opts.builtSignature } : {}),
          },
          preview: opts.preview ?? {
            amounts: [
              { mint: USDC_MINT, raw: "1000000", decimals: 6 },
              { mint: SOL, raw: "6666667", decimals: 9 },
            ],
            tokenRisks: [{ mint: USDC_MINT, message: "Transfer fee: 1% capped at 100 raw units." }],
            warnings: ["This pool holds under $10,000 of marked liquidity."],
            candleFeeBps: 0,
          },
          replay: false,
        })
      }
      if (path === "/api/v1/agent/lp/confirm")
        return ok({ success: true, status: "confirmed", signature: body.signature })
    }
    if (path.endsWith("/sign")) return ok({ signedTransaction: signed, encoding: "base64" })
    if (path === "/rpc") {
      if (opts.rpcRateLimit?.includes(body.method)) return new Response("rate limited", { status: 429 })
      const result =
        body.method === "getTokenSupply"
          ? { value: { decimals: 6 } }
          : body.method === "sendTransaction"
            ? signature
            : body.method === "getSignatureStatuses"
              ? { value: [statuses[Math.min(statusIndex++, statuses.length - 1)]] }
              : null
      return ok({ jsonrpc: "2.0", id: 1, result })
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_SOLANA_RPC_URL: "http://localhost/rpc" },
    store: createFakeStore({
      wallet_signer_wallet: pemToStoredSigner(pem),
      "wallet_signer_wallet-2": pemToStoredSigner(pem),
    }),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  return { deps, calls, stdout, stderr }
}

const addArgs = [
  "lp",
  "add",
  POOL,
  "--amount",
  "1",
  "USDC",
  "--wallet",
  "tee",
  "--client-trade-id",
  "lp-1",
  "--yes",
  "--json",
]
const removeArgs = ["lp", "remove", POSITION, "--percent", "100", "--client-trade-id", "lp-2", "--yes", "--json"]
const claimArgs = ["lp", "claim", POSITION, "--wallet", "tee", "--client-trade-id", "lp-3", "--yes", "--json"]

describe("candle lp: the reads", () => {
  test("pools <token> reads the pools route with the bound key and prints one JSON document", async () => {
    const f = await fixture()
    expect(await run(["lp", "pools", "USDC", "--json"], f.deps)).toBe(0)
    expect(f.calls.map((c) => c.path)).toEqual([`/api/v1/agent/lp/pools/${USDC_MINT}`])
    expect(f.calls[0]?.query).toBe("?page=1")
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.pools[0]).toMatchObject({ pool: POOL, estimatedAprPercent: 12.3 })
    const text = await fixture()
    expect(await run(["lp", "pools", USDC_MINT, "--page", "2"], text.deps)).toBe(0)
    expect(text.calls[0]?.query).toBe("?page=2")
    expect(text.stdout.text).toContain("est. yield 12.30% APR (indexed, not a quote)")
  })

  test("positions lists every TEE wallet on the key without demanding lp:write, and --wallet narrows it", async () => {
    const f = await fixture({ scopes: ["account:read"] })
    expect(await run(["lp", "positions", "--json"], f.deps)).toBe(0)
    expect(f.calls.map((c) => `${c.path}${c.query}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/lp/positions?linkedWalletId=wallet",
      "/api/v1/agent/lp/positions?linkedWalletId=wallet-2",
    ])
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.wallets.map((w: { id: string; positions: unknown[] }) => [w.id, w.positions.length])).toEqual([
      ["wallet", 1],
      ["wallet-2", 0],
    ])
    const one = await fixture()
    expect(await run(["lp", "positions", "--wallet", "tee-2"], one.deps)).toBe(0)
    expect(one.calls.map((c) => `${c.path}${c.query}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/lp/positions?linkedWalletId=wallet-2",
    ])
    expect(one.stdout.text).toContain("No DAMM v2 positions across 1 TEE wallet(s).")
    const unknown = await fixture()
    expect(await run(["lp", "positions", "--wallet", "nobody", "--json"], unknown.deps)).toBe(1)
    expect(JSON.parse(unknown.stdout.text.trim()).code).toBe("TEE_WALLET_REQUIRED")
  })

  test("a deployment without LP routes is named, not reported as a generic failure", async () => {
    const f = await fixture({ lpDisabled: true })
    expect(await run(["lp", "pools", "USDC", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "LP_NOT_ENABLED" })
  })
})

describe("candle lp: the writes", () => {
  test("add: bound key, lp:write, the exact raw amount, preview shown, relay-signed, broadcast, confirmed with the signature", async () => {
    const f = await fixture()
    expect(await run(addArgs, f.deps)).toBe(0)
    const build = f.calls.find((c) => c.path === "/api/v1/agent/lp/add/build")
    expect(build?.body).toEqual({
      linkedWalletId: "wallet",
      clientTradeId: "lp-1",
      pool: POOL,
      token: USDC_MINT,
      amountRaw: "1000000",
      slippageBps: 100,
    })
    // The relay signed what the server built; the CLI signed nothing itself.
    const relay = f.calls.find((c) => c.path === "/api/v1/agent/wallets/wallet/sign")
    expect(relay?.body).toMatchObject({ body: { params: { transaction: "unsigned-lp" } } })
    expect(typeof relay?.body?.authorizationSignature).toBe("string")
    // Broadcast over the RPC, waited for `confirmed`, then confirmed on the server.
    const rpcMethods = f.calls.filter((c) => c.path === "/rpc").map((c) => c.body?.method)
    // USDC's decimals are known without a mint read; a bare mint reads getTokenSupply first.
    expect(rpcMethods).toEqual(["sendTransaction", "getSignatureStatuses"])
    expect(f.calls.find((c) => c.path === "/api/v1/agent/lp/confirm")?.body).toEqual({
      clientTradeId: "lp-1",
      signature,
    })
    // The preview went to stderr (json mode) with both amounts, the warning and the R5 risk.
    expect(f.stderr.text).toContain("Deposit (maximum, at the pool's ratio): 1.000000 USDC + 0.006666667 SOL")
    expect(f.stderr.text).toContain("Warning: This pool holds under $10,000 of marked liquidity.")
    expect(f.stderr.text).toContain(`Warning (${USDC_MINT}): Transfer fee: 1% capped at 100 raw units.`)
    expect(f.stderr.text).toContain("Candle LP fee: 0 bps")
    const out = JSON.parse(f.stdout.text.trim())
    expect(out).toMatchObject({
      success: true,
      kind: "lp",
      action: "add",
      clientTradeId: "lp-1",
      signature,
      wallet: TEE,
    })
    expect(out.preview.amounts).toHaveLength(2)

    const mint = await fixture()
    const other = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaC"
    expect(
      await run(
        [
          "lp",
          "add",
          POOL,
          "--amount",
          "2.5",
          other,
          "--wallet",
          "tee",
          "--client-trade-id",
          "lp-9",
          "--yes",
          "--json",
        ],
        mint.deps,
      ),
    ).toBe(0)
    expect(mint.calls.filter((c) => c.path === "/rpc").map((c) => c.body?.method)[0]).toBe("getTokenSupply")
    expect(mint.calls.find((c) => c.path === "/api/v1/agent/lp/add/build")?.body).toMatchObject({
      token: other,
      amountRaw: "2500000",
    })
  })

  test("add is refused when the bound key lacks lp:write, before any build", async () => {
    const f = await fixture({ scopes: ["swap:write"] })
    expect(await run(addArgs, f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "SCOPE_MISSING" })
    expect(f.calls.some((c) => c.path.endsWith("/build"))).toBe(false)
  })

  test("declining the prompt cancels: nothing is signed, broadcast or confirmed", async () => {
    const f = await fixture({ prompt: "n" })
    f.deps.isTTY.stdin = true
    expect(
      await run(
        addArgs.filter((arg) => arg !== "--yes"),
        f.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ success: true, status: "cancelled", action: "add" })
    expect(f.calls.some((c) => c.path.endsWith("/sign") || c.path.endsWith("/confirm"))).toBe(false)
    expect(f.calls.filter((c) => c.path === "/rpc")).toEqual([])
    // Without a terminal and without --yes, the prompt cannot be answered: refused, nothing built on.
    const headless = await fixture()
    headless.deps.isTTY = { stdin: false, stdout: false, stderr: false }
    expect(
      await run(
        addArgs.filter((arg) => arg !== "--yes"),
        headless.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(headless.stdout.text.trim()).code).toBe("CONFIRMATION_REQUIRED")
  })

  test("remove --percent 100 finds the holding wallet from the positions listing, and claim takes --wallet", async () => {
    const f = await fixture({ holder: "wallet-2" })
    expect(await run(removeArgs, f.deps)).toBe(0)
    expect(f.calls.map((c) => `${c.path}${c.query}`).slice(0, 3)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/lp/positions?linkedWalletId=wallet",
      "/api/v1/agent/lp/positions?linkedWalletId=wallet-2",
    ])
    expect(f.calls.find((c) => c.path === "/api/v1/agent/lp/remove/build")?.body).toEqual({
      linkedWalletId: "wallet-2",
      clientTradeId: "lp-2",
      position: POSITION,
      percent: 100,
      slippageBps: 100,
    })
    expect(f.calls.some((c) => c.path === "/api/v1/agent/wallets/wallet-2/sign")).toBe(true)
    expect(f.stderr.text).toContain("claim its fees and close it")
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ action: "remove", wallet: TEE_2 })

    const claim = await fixture()
    expect(await run(claimArgs, claim.deps)).toBe(0)
    expect(claim.calls.some((c) => c.path.includes("/lp/positions?"))).toBe(false)
    expect(claim.calls.find((c) => c.path === "/api/v1/agent/lp/claim/build")?.body).toEqual({
      linkedWalletId: "wallet",
      clientTradeId: "lp-3",
      position: POSITION,
    })

    const nobody = await fixture({ holder: "none" })
    expect(await run(removeArgs, nobody.deps)).toBe(1)
    expect(JSON.parse(nobody.stdout.text.trim()).code).toBe("LP_POSITION_NOT_FOUND")
    expect(nobody.calls.some((c) => c.path.endsWith("/build"))).toBe(false)
  })

  test("a partial remove carries the percent as given, and a bad percent is usage", async () => {
    const f = await fixture()
    expect(
      await run(
        [
          "lp",
          "remove",
          POSITION,
          "--percent",
          "12.5",
          "--wallet",
          "tee",
          "--client-trade-id",
          "lp-4",
          "--yes",
          "--json",
        ],
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls.find((c) => c.path === "/api/v1/agent/lp/remove/build")?.body).toMatchObject({ percent: 12.5 })
    expect(f.stderr.text).toContain("Remove 12.5% of the liquidity")
    for (const bad of ["0", "101", "12.345", "abc"]) {
      const usage = await fixture()
      expect(await run(["lp", "remove", POSITION, "--percent", bad, "--json"], usage.deps)).toBe(2)
      expect(JSON.parse(usage.stdout.text.trim()).code).toBe("USAGE")
      expect(usage.calls).toEqual([])
    }
  })

  test("the same client id never sends twice: a saved signature is confirmed again, a server-held one too", async () => {
    const f = await fixture()
    expect(await run(addArgs, f.deps)).toBe(0)
    const before = f.calls.length
    expect(await run(addArgs, f.deps)).toBe(0)
    const again = f.calls.slice(before)
    expect(again.map((c) => c.path)).toEqual(["/api/v1/agent/wallets/trading", "/api/v1/agent/lp/confirm"])
    expect(again[1]?.body).toEqual({ clientTradeId: "lp-1", signature })
    expect(JSON.parse(f.stdout.text.trim().split("\n").at(-1) as string)).toMatchObject({ resumed: true, signature })

    const server = await fixture({ builtSignature: "SrvSig" })
    expect(await run(claimArgs, server.deps)).toBe(0)
    expect(server.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
    expect(server.calls.find((c) => c.path === "/api/v1/agent/lp/confirm")?.body).toEqual({
      clientTradeId: "lp-3",
      signature: "SrvSig",
    })
  })

  test("a transaction that fails on chain, or one not confirmed in time, is reported with the id to retry", async () => {
    const failed = await fixture({
      statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }],
    })
    expect(await run(addArgs, failed.deps)).toBe(1)
    expect(JSON.parse(failed.stdout.text.trim())).toMatchObject({ ok: false, code: "LP_TRANSACTION_FAILED" })
    expect(failed.calls.some((c) => c.path === "/api/v1/agent/lp/confirm")).toBe(false)

    const slow = await fixture({ statuses: [null] })
    expect(await run(addArgs, slow.deps)).toBe(1)
    const out = JSON.parse(slow.stdout.text.trim())
    expect(out.code).toBe("LP_CONFIRM_PENDING")
    expect(out.message).toContain("--client-trade-id lp-1")
    expect(slow.calls.some((c) => c.path === "/api/v1/agent/lp/confirm")).toBe(false)
    // The signature was saved before the broadcast, so the retry confirms instead of resending.
    const retry = slow.calls.length
    slow.deps.fetch = (await fixture()).deps.fetch
    expect(await run(addArgs, slow.deps)).toBe(0)
    expect(slow.calls.length).toBe(retry)
  })

  test("a build that names another wallet or action is refused before signing", async () => {
    const f = await fixture()
    const original = f.deps.fetch
    f.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await original(input, init)
      if (!String(input).endsWith("/lp/add/build")) return response
      const body = (await response.json()) as { build: Record<string, unknown> }
      return Response.json({ ...body, build: { ...body.build, walletAddress: TEE_2 } })
    }) as typeof fetch
    expect(await run(addArgs, f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "INVALID_RESPONSE" })
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("usage: every write needs its positionals, and add needs --amount and --wallet", async () => {
    for (const argv of [
      ["lp", "add", POOL, "--wallet", "tee"],
      ["lp", "add", POOL, "USDC", "--amount", "1"],
      ["lp", "add", "--amount", "1", "--wallet", "tee"],
      ["lp", "remove", "--percent", "100"],
      ["lp", "claim"],
      ["lp", "pools"],
      ["lp", "positions", "extra"],
    ]) {
      const f = await fixture()
      expect(await run([...argv, "--json"], f.deps)).toBe(2)
      expect(JSON.parse(f.stdout.text.trim()).code).toBe("USAGE")
      expect(f.calls).toEqual([])
    }
  })
})

/**
 * BE-355 (D4, T11, T12): a rate limit on the send, or on a status read after it, is the uncertain
 * outcome for an LP write: exit 3 with `RPC_RATE_LIMITED` and the saved signature, nothing
 * re-sent, and the re-run confirming the saved signature instead of building or sending again.
 */
describe("BE-355: rate limits after the signature (T11, T12)", () => {
  const rpcMethods = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.calls.filter((c) => c.path === "/rpc").map((c) => c.body?.method)

  test("T11: a rate-limited send exits 3 with the saved signature and one send; the re-run confirms and sends nothing", async () => {
    const f = await fixture({ rpcRateLimit: ["sendTransaction"] })
    expect(await run(addArgs, f.deps)).toBe(3)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.ok).toBe(false)
    expect(out.code).toBe("RPC_RATE_LIMITED")
    expect(out.message).toContain(`It may still land: check ${signature} before anything else.`)
    expect(out.message).toContain("--client-trade-id lp-1")
    // Pre-profile (this fixture has no profiles): the two pre-profile lines, and never profile set.
    expect(out.suggestion).toBe(
      "--rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command\nor sign in (candle auth login) to store one per profile",
    )
    expect(rpcMethods(f)).toEqual(["sendTransaction"])
    expect(f.calls.some((c) => c.path === "/api/v1/agent/lp/confirm")).toBe(false)

    // The signature was saved before the send: the same id confirms it and sends nothing new.
    const fresh = await fixture()
    f.deps.fetch = fresh.deps.fetch
    expect(await run(addArgs, f.deps)).toBe(0)
    expect(fresh.calls.map((c) => c.path)).toEqual(["/api/v1/agent/wallets/trading", "/api/v1/agent/lp/confirm"])
    expect(fresh.calls[1]?.body).toEqual({ clientTradeId: "lp-1", signature })
  })

  test("T12: a rate-limited status read after the send retries once, then exits 3 with the signature", async () => {
    const f = await fixture({ rpcRateLimit: ["getSignatureStatuses"] })
    expect(await run(addArgs, f.deps)).toBe(3)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("RPC_RATE_LIMITED")
    expect(out.message).toContain(signature)
    expect(rpcMethods(f)).toEqual(["sendTransaction", "getSignatureStatuses", "getSignatureStatuses"])
    expect(f.calls.some((c) => c.path === "/api/v1/agent/lp/confirm")).toBe(false)
  })
})
