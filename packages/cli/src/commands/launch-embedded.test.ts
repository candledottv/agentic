/**
 * BE-1849: `candle launch --wallet embedded --buy <amount>` is the embedded-wallet atomic launch.
 * The account's embedded wallet is the creator and the only first buyer, on the route the TEE
 * `--buy` takes. The dry run comes first and writes nothing; the confirmed quote is the dry run's;
 * the build's floor must be at least the one shown; Candle signs both legs at one `/submit`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair } from "@solana/web3.js"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const EMBEDDED = Keypair.generate().publicKey.toBase58()
const MINT = Keypair.generate().publicKey.toBase58()
const MIN_OUT = "4000000"
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

type Submit = "landed" | "failed" | "timeout" | { status: number; error: Record<string, unknown> }

async function fixture(
  opts: {
    permission?: "allowed" | "denied"
    /** A Candle error `/launch/atomic/dry-run` answers, with its HTTP status. */
    dryRunError?: { status: number; error: Record<string, unknown> }
    /** The build's first-buy floor, when it differs from the dry run's. */
    buildFloor?: string
    /** The signer the build names for its buy leg. */
    buySigner?: "server" | "client"
    submit?: Submit
    /** What `GET /launch/headless/jobs/:id` answers once a build exists. */
    jobStatus?: string
    prompt?: string
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-embedded-launch-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  let built = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, body })
    const ok = (value: unknown, status = 200) => Response.json(value, { status })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({
        embeddedWalletPermission: opts.permission ?? "allowed",
        wallets: { solana: { address: EMBEDDED }, evm: null },
      })
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return built
        ? ok({ success: true, job: { status: opts.jobStatus ?? "built", clientLaunchId: "launch-1" } })
        : ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    if (path === "/api/v1/launch/atomic/dry-run") {
      if (opts.dryRunError) return ok({ success: false, error: opts.dryRunError.error }, opts.dryRunError.status)
      return ok({
        success: true,
        dryRun: true,
        launchWallet: EMBEDDED,
        launchSigner: "server",
        resolved: { chain: "solana", quoteAsset: body.quoteAsset ?? "sol", mode: "open" },
        fills: [
          {
            index: 1,
            signer: "server",
            payerType: "main",
            wallet: EMBEDDED,
            amountRaw: body.firstBuys[0].amountRaw,
            feeRaw: "50000",
            expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: MIN_OUT },
            supplyPct: 0.4,
          },
        ],
        graduatesInBundle: false,
      })
    }
    if (path === "/api/v1/launch/atomic/build") {
      built++
      return ok({
        bundleId: `bundle-${built}`,
        legs: [
          { index: 0, role: "launch", signer: "server" },
          {
            index: 1,
            role: "buy",
            signer: opts.buySigner ?? "server",
            expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: opts.buildFloor ?? MIN_OUT },
          },
        ],
        expiresAt: Date.now() + 600_000,
      })
    }
    if (path === "/api/v1/launch/atomic/submit") {
      const submit = opts.submit ?? "landed"
      if (submit === "landed")
        return ok({
          status: "landed",
          bundleId: body.bundleId,
          mint: MINT,
          signatures: ["launchSig", "buySig"],
          booking: { state: "booked", missing: [] },
        })
      if (submit === "failed" || submit === "timeout")
        return ok({ status: submit, bundleId: body.bundleId, retryable: false }, 502)
      return ok({ success: false, error: submit.error }, submit.status)
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "key" },
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  const operations = () => {
    try {
      return readdirSync(join(dir, "operations")).map((file) =>
        JSON.parse(readFileSync(join(dir, "operations", file), "utf8")),
      )
    } catch {
      return []
    }
  }
  return { deps, calls, stdout, stderr, operations, paths: () => calls.map((call) => call.path) }
}

const lastJson = (text: string) => JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")

const launchArgs = [
  "launch",
  "--name",
  "Demo",
  "--symbol",
  "DEMO",
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  "embedded",
  "--client-trade-id",
  "launch-1",
  "--json",
]
const buyArgs = [...launchArgs, "--buy", "0.01", "--yes"]
const PAYER = { type: "main" }
const atomicBody = {
  clientLaunchId: "launch-1",
  chain: "solana",
  name: "Demo",
  symbol: "DEMO",
  imageUrl: "https://example.test/image.png",
  payer: PAYER,
  firstBuys: [{ payer: PAYER, amountRaw: "10000000" }],
}

describe("BE-1849: candle launch --wallet embedded --buy is the embedded-wallet atomic launch", () => {
  test("the dry run first, then one build with the embedded wallet as creator and only first buyer, then /submit with no client legs", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    expect(f.paths()).toEqual([
      "/api/v1/launch/headless/jobs/launch-1",
      "/api/v1/agent/wallets/embedded",
      "/api/v1/launch/atomic/dry-run",
      "/api/v1/launch/atomic/build",
      "/api/v1/launch/atomic/submit",
    ])
    const [dryRun, build, submit] = ["dry-run", "build", "submit"].map(
      (step) => f.calls.find((call) => call.path === `/api/v1/launch/atomic/${step}`)?.body,
    )
    expect(dryRun).toEqual(atomicBody)
    expect(build).toEqual(atomicBody)
    expect(build).not.toHaveProperty("buyAmount")
    expect(submit).toEqual({ bundleId: "bundle-1", signedTxsBase64: [] })
    // Nothing is signed on this machine and nothing goes to the single-transaction routes.
    expect(f.paths().some((path) => path.endsWith("/sign") || path.includes("/launch/self/"))).toBe(false)
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
    expect(lastJson(f.stdout.text)).toMatchObject({
      success: true,
      status: "landed",
      bundleId: "bundle-1",
      mint: MINT,
      clientTradeId: "launch-1",
      kind: "launch",
    })
    expect(f.stderr.text).toContain(`Launched ${MINT}. Launch signature: launchSig. First buy signature: buySig.`)
    expect(f.operations()[0]).toMatchObject({ bundleId: "bundle-1", bundleSignatures: [], bundleOutcome: "landed" })
  })

  test("the quote is the dry run's: payer, fee, floor and the bundle notice", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    expect(f.stderr.text).toContain(
      "Launch Demo (DEMO) with a first buy of 0.010000000 SOL from the embedded wallet, as one Jito bundle",
    )
    expect(f.stderr.text).toContain(`Payer: ${EMBEDDED}`)
    expect(f.stderr.text).toContain("Candle fee: 0.000050000 SOL (the tier fee on the first buy, in its leg)")
    expect(f.stderr.text).toContain(`Minimum received: ${MIN_OUT} raw units of the new token`)
    expect(f.stderr.text).toContain("land together or not at all")
    expect(f.stderr.text).toContain("Candle signs both")
  })

  test("--dry-run stops after the preview: no build, no claim, the id unused", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--buy", "0.01", "--dry-run"], f.deps)).toBe(0)
    expect(f.paths()).toEqual(["/api/v1/agent/wallets/embedded", "/api/v1/launch/atomic/dry-run"])
    expect(f.operations()).toEqual([])
    expect(f.stderr.text).toContain("Dry run: nothing was built, signed or recorded, and launch id launch-1 is unused.")
    expect(lastJson(f.stdout.text)).toMatchObject({
      dryRun: true,
      clientTradeId: "launch-1",
      fills: [{ index: 1, amountRaw: "10000000" }],
    })
  })

  test("declining the quote builds nothing and claims nothing", async () => {
    const f = await fixture({ prompt: "n" })
    expect(await run([...launchArgs, "--buy", "0.01"], f.deps)).toBe(0)
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
    expect(f.operations()).toEqual([])
    expect(lastJson(f.stdout.text)).toMatchObject({ status: "cancelled", clientTradeId: "launch-1" })
  })

  test("without a terminal or --yes it asks for confirmation and builds nothing", async () => {
    const f = await fixture()
    f.deps.isTTY.stdin = false
    expect(await run([...launchArgs, "--buy", "0.01"], f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CONFIRMATION_REQUIRED")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
  })

  test.each([
    ["no --buy", [...launchArgs, "--yes"]],
    ["--dex-version", [...buyArgs, "--dex-version", "v4"]],
    ["a Hood quote asset", [...buyArgs, "--quote-asset", "eth"]],
  ])("%s is a usage error before any request", async (_name, args) => {
    const f = await fixture()
    expect(await run(args, f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(f.stdout.text + f.stderr.text).toContain("--wallet embedded launches on Solana as an atomic launch")
  })

  test("main names the embedded wallet too", async () => {
    const f = await fixture()
    expect(await run([...buyArgs.map((arg) => (arg === "embedded" ? "main" : arg))], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path === "/api/v1/launch/atomic/build")?.body).toEqual(atomicBody)
  })

  test("a key denied the embedded wallet is refused before the dry run, with the fix", async () => {
    const f = await fixture({ permission: "denied" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const error = lastJson(f.stdout.text)
    expect(error.code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
    expect(error.suggestion).toContain("--embedded-wallet allow")
    expect(f.paths()).toEqual(["/api/v1/launch/headless/jobs/launch-1", "/api/v1/agent/wallets/embedded"])
  })

  test("a --buy above the dev-buy ceiling is refused in the API's words before any request but the lookup", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--buy", "0.6", "--yes"], f.deps)).toBe(1)
    const error = lastJson(f.stdout.text)
    expect(error.code).toBe("DEV_BUY_TOO_HIGH")
    expect(error.message).toContain("buyAmount exceeds the per-launch dev-buy ceiling of 500000000 lamports")
    expect(f.paths()).toEqual(["/api/v1/launch/headless/jobs/launch-1"])
  })

  test("an exp-b CNDL --buy over 33,000 is refused with the whole rule, before any request but the lookup", async () => {
    const f = await fixture()
    expect(
      await run([...launchArgs, "--quote-asset", "cndl", "--mode", "exp-b", "--buy", "33000.000001", "--yes"], f.deps),
    ).toBe(1)
    const error = lastJson(f.stdout.text)
    expect(error.code).toBe("DEV_BUY_TOO_HIGH")
    expect(error.message).toContain(
      "buyAmount exceeds this launch's dev-buy ceiling of 33000 CNDL (33000000000 CNDL raw units): " +
        "at most 2000000 CNDL, or 10% of the threshold when that is lower",
    )
    expect(f.paths()).toEqual(["/api/v1/launch/headless/jobs/launch-1"])
  })

  test("an exp-b CNDL --buy at exactly 33,000 passes the local ceiling and reaches the dry run", async () => {
    const f = await fixture()
    expect(
      await run([...launchArgs, "--quote-asset", "cndl", "--mode", "exp-b", "--buy", "33000", "--dry-run"], f.deps),
    ).toBe(0)
    expect(f.paths()).toEqual(["/api/v1/agent/wallets/embedded", "/api/v1/launch/atomic/dry-run"])
    const dryRun = f.calls.find((call) => call.path === "/api/v1/launch/atomic/dry-run")?.body
    expect(dryRun).toMatchObject({
      quoteAsset: "cndl",
      mode: "exp-b",
      firstBuys: [{ payer: PAYER, amountRaw: "33000000000" }],
    })
  })

  test("a server ceiling tighter than this machine's is refused by the dry run in the API's words, and nothing is built", async () => {
    const f = await fixture({
      dryRunError: {
        status: 400,
        error: {
          code: "DEV_BUY_TOO_HIGH",
          message:
            "firstBuys[0] exceeds the per-launch dev-buy ceiling of 1000000000 CNDL raw units for cndl on solana",
          field: "firstBuys[0]",
          retryable: false,
        },
      },
    })
    expect(await run([...launchArgs, "--quote-asset", "cndl", "--buy", "2000", "--yes"], f.deps)).toBe(1)
    const error = lastJson(f.stdout.text)
    expect(error.code).toBe("DEV_BUY_TOO_HIGH")
    expect(error.message).toContain("ceiling of 1000000000 CNDL raw units")
    expect(f.paths()).toEqual([
      "/api/v1/launch/headless/jobs/launch-1",
      "/api/v1/agent/wallets/embedded",
      "/api/v1/launch/atomic/dry-run",
    ])
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
    expect(f.operations()).toEqual([])
  })

  test("a key without swap:write is told what the first buy needs, and nothing is built", async () => {
    const f = await fixture({
      dryRunError: { status: 403, error: { code: "SCOPE_MISSING", message: "This key lacks the swap:write scope" } },
    })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const error = lastJson(f.stdout.text)
    expect(error.code).toBe("SCOPE_MISSING")
    expect(error.message).toContain("needs swap:write as well as launch:write")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
    expect(f.operations()).toEqual([])
  })

  test("any other dry-run refusal (a Free plan's TIER_REQUIRED) passes through, and nothing is built", async () => {
    const f = await fixture({
      dryRunError: {
        status: 403,
        error: { code: "TIER_REQUIRED", message: "Atomic launches require Pro or Max tier" },
      },
    })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(lastJson(f.stdout.text)).toMatchObject({
      code: "TIER_REQUIRED",
      message: expect.stringContaining("Atomic launches require Pro or Max tier"),
    })
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
  })

  test("a build whose floor is below the confirmed one sends nothing, and a re-run builds again under the same id", async () => {
    const f = await fixture({ buildFloor: "3999999" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("QUOTE_CHANGED")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/submit")
    expect(f.operations()[0]).toMatchObject({ bundleId: "bundle-1", bundleOutcome: "unsigned" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/atomic/build")).toHaveLength(2)
  })

  test("a build that hands this machine a leg to sign is refused, and nothing is sent", async () => {
    const f = await fixture({ buySigner: "client" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/submit")
  })

  test("a failed bundle is exit 1, and a re-run builds again under the same id", async () => {
    const f = await fixture({ submit: "failed", jobStatus: "failed" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("BUNDLE_FAILED")
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/atomic/build")).toHaveLength(2)
  })

  test("a timeout is unresolved, exit 3; a re-run reads the job and builds and sends nothing", async () => {
    const f = await fixture({ submit: "timeout" })
    expect(await run(buyArgs, f.deps)).toBe(3)
    expect(lastJson(f.stdout.text).code).toBe("BUNDLE_UNRESOLVED")
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(3)
    expect(f.paths().slice(before)).toEqual(["/api/v1/launch/headless/jobs/launch-1"])
    expect(lastJson(f.stdout.text).code).toBe("OPERATION_IN_FLIGHT")
  })

  test("a 4xx refused submit sent nothing, so a re-run builds again under the same id", async () => {
    const f = await fixture({ submit: { status: 400, error: { code: "VALIDATION_FAILED", message: "bad" } } })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.operations()[0]).toMatchObject({ bundleOutcome: "refused" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/atomic/build")).toHaveLength(2)
  })
})
