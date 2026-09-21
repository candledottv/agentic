import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { canonicalAuthorizationPayloadBytes } from "../../../sdk/src/authorization-signature"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import { authorizationSignature, rawAmount } from "../trading"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const mint = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
/** The account's embedded (main) Solana wallet, distinct from the TEE wallet's address. */
const embedded = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 5), Buffer.alloc(40)]).toString("base64")
const signature = base58.encode(Buffer.alloc(64, 5))
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(
  opts: {
    active?: boolean
    allowLaunch?: boolean
    scopes?: string[]
    risks?: unknown[]
    prompt?: string
    failure?: string
    venue?: string
    quoteAsset?: string
    /** BE-249: drop the TEE wallet, so the account's only payer is its embedded one. */
    teeWallets?: number
    /** BE-249: no embedded wallet on the account at all. */
    noEmbedded?: boolean
    /** BE-249: an API that predates /execute -- the shape a stale deployment answers with. */
    noExecuteRoute?: boolean
    /** BE-249: what a deferred build hands back. Defaults to the deferred (built) shape. */
    mainBuildStatus?: string
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-trade-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = []
  let built = false
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, headers: new Headers(init?.headers) })
    const ok = (value: unknown) => Response.json(value)
    if (opts.failure === path) throw new Error("lost response")
    if (path.includes("/jobs/"))
      return built
        ? ok({ success: true, job: { status: "built" } })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["swap:write", "launch:write"],
        privyAppId: "app",
        page: Array.from({ length: opts.teeWallets ?? 1 }, (_unused, index) => ({
          id: index === 0 ? "wallet" : `wallet-${index}`,
          address: index === 0 ? mint : `${index}`.repeat(32),
          label: index === 0 ? "tee" : `tee-${index}`,
          chain: "solana",
          active: opts.active ?? true,
          allowLaunch: opts.allowLaunch ?? true,
          privyWalletId: "privy",
        })),
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({ success: true, wallets: { solana: opts.noEmbedded ? null : { address: embedded }, evm: null } })
    if (path === "/api/v1/trade/agent/execute") {
      if (opts.noExecuteRoute) return new Response("404 Not Found", { status: 404 })
      // The support probe: no row for this id yet, so the real route answers JOB_NOT_FOUND. A
      // second call, after a build, is the execution itself.
      return built
        ? ok({ success: true, status: "executed", signature })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    }
    if (path.endsWith("/build")) {
      built = true
      if (path.includes("launch"))
        return ok({ success: true, transaction: "unsigned", maxDebitLamports: "30000000", expiresAt: 10000 })
      const quote = {
        status: "built",
        swapId: "server-swap",
        recipient: mint,
        minOutRaw: "123456",
        fee: { bps: 50, feeRaw: "5000" },
        expiresAt: 10000,
        venue: opts.venue ?? "jupiter",
        priceImpactPct: "0.1",
        tokenRisks: opts.risks ?? [],
        transactionsBase64: ["unsigned"],
      }
      const main = body?.payer?.type === "main"
      return path.includes("trade/agent")
        ? ok({
            ...quote,
            ...(main && opts.mainBuildStatus ? { status: opts.mainBuildStatus } : {}),
            chain: "solana",
            walletAddress: main ? embedded : mint,
            artifacts: { ...quote, quoteAsset: opts.quoteAsset ?? body.quoteAsset, transactionBase64: "unsigned" },
          })
        : ok({ success: true, payload: quote })
    }
    if (path.endsWith("/sign")) return ok({ signedTransaction: signed, encoding: "base64" })
    if (path.endsWith("/submit") || path.endsWith("/confirm"))
      return ok({ success: true, status: "executed", signature })
    if (path === "/rpc") {
      const result =
        body.method === "getTokenSupply"
          ? { value: { decimals: 6 } }
          : body.method === "getTokenAccountsByOwner"
            ? {
                value: [
                  {
                    pubkey: "ata",
                    account: {
                      owner: body.params[1].programId,
                      data: {
                        parsed: {
                          info: { mint, tokenAmount: { amount: "1000000", decimals: 6 }, state: "initialized" },
                        },
                      },
                    },
                  },
                ],
              }
            : body.method === "getBalance"
              ? { value: 2000000000 }
              : signature
      return ok({ jsonrpc: "2.0", id: 1, result })
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture(),
    stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_SOLANA_RPC_URL: "http://localhost/rpc" },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  return {
    deps,
    calls,
    stdout,
    stderr,
    setBuilt: () => {
      built = true
    },
  }
}
const swapArgs = [
  "swap",
  "SOL",
  "USDC",
  "--amount",
  "0.25",
  "--wallet",
  "tee",
  "--client-trade-id",
  "test-1",
  "--yes",
  "--json",
]
const launchArgs = [
  "launch",
  "--name",
  "Token",
  "--symbol",
  "TOK",
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  "tee",
  "--client-trade-id",
  "launch-1",
  "--yes",
  "--json",
]

describe("TEE CLI trading", () => {
  test("base pair uses swap build, bound-key relay and submit, with exact decimal amount and one JSON result", async () => {
    const f = await fixture()
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("swap/build"))?.body).toMatchObject({
      amountRaw: "250000000",
      clientTradeId: "test-1",
      payer: { type: "linked", linkedWalletId: "wallet" },
    })
    expect(f.calls.find((call) => call.path.endsWith("swap/submit"))?.body).toMatchObject({
      clientTradeId: "test-1",
      swapId: "server-swap",
    })
    expect(f.calls.every((call) => call.headers.get("x-api-key") === "bound-key")).toBe(true)
    expect(JSON.parse(f.stdout.text).quote).toMatchObject({ venue: "jupiter", minimumReceived: "0.123456 USDC" })
    expect(f.stderr.text).toContain("Tier fee: 50 bps")
    expect(f.stderr.text).toContain("Price impact: 0.1%")
  })
  for (const venue of ["curve", "jupiter", "dflow"])
    test(`token rail displays ${venue} and R5 warnings before sign`, async () => {
      const f = await fixture({
        venue,
        risks: [{ mint, kind: "permanent_delegate", message: "Issuer can move or burn tokens." }],
      })
      expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", "tee", "--yes", "--json"], f.deps)).toBe(0)
      const build = f.calls.find((call) => call.path.endsWith("trade/agent/build"))
      expect(build?.body).toMatchObject({ mint, side: "buy", quoteAsset: "sol" })
      expect(f.stderr.text).toContain("Issuer can move or burn tokens.")
      expect(JSON.parse(f.stdout.text).quote.venue).toBe(venue)
    })
  test("percentage sell sums classic and Token-2022 holdings in raw units", async () => {
    const f = await fixture()
    expect(await run(["swap", mint, "SOL", "--percent", "12.5", "--wallet", "tee", "--yes"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("trade/agent/build"))?.body).toMatchObject({
      side: "sell",
      amountRaw: "250000",
    })
    expect(f.calls.filter((call) => call.body?.method === "getTokenAccountsByOwner")).toHaveLength(2)
  })
  test("a server-selected settlement asset cannot silently replace the requested pair", async () => {
    const f = await fixture({ quoteAsset: "usdc" })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", "tee", "--yes"], f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })
  test("curve sell minimum received is net of the appended tier fee", async () => {
    const f = await fixture({ venue: "curve" })
    expect(await run(["swap", mint, "SOL", "--amount", "1", "--wallet", "tee", "--yes", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).quote.minimumReceivedRaw).toBe("118456")
  })
  test("declining confirmation makes no sign or submit request", async () => {
    const f = await fixture({ prompt: "n" })
    expect(
      await run(
        swapArgs.filter((arg) => arg !== "--yes"),
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls.some((call) => /\/(sign|submit)$/.test(call.path))).toBe(false)
    expect(JSON.parse(f.stdout.text).status).toBe("cancelled")
  })
  test("--yes still displays every R5 warning", async () => {
    const messages = [
      "Permanent delegate",
      "Transfer hook unknown",
      "Transfer fee 50 bps cap 100",
      "Frozen by default",
      "Pause authority",
      "Non-transferable",
    ]
    const f = await fixture({ risks: messages.map((message) => ({ mint, message })) })
    expect(await run(swapArgs, f.deps)).toBe(0)
    for (const message of messages) expect(f.stderr.text).toContain(message)
  })
  for (const to of ["ETH", "USDG", "0x1234567890123456789012345678901234567890", "ethereum:ETH"])
    test(`refuses ${to} before any request`, async () => {
      const f = await fixture()
      expect(
        await run(
          swapArgs.map((arg) => (arg === "USDC" ? to : arg)),
          f.deps,
        ),
      ).toBe(1)
      expect(f.calls).toHaveLength(0)
    })
  for (const amount of ["0", "1e3", "0.0000000001", "9007199254740992"])
    test(`refuses invalid or inexact amount ${amount}`, async () => {
      const f = await fixture()
      expect(
        await run(
          swapArgs.map((arg) => (arg === "0.25" ? amount : arg)),
          f.deps,
        ),
      ).toBe(1)
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    })
  test("inactive or unbound wallet never builds", async () => {
    const f = await fixture({ active: false })
    expect(await run(swapArgs, f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
  })
  test("lost submit response plus retry looks up the original id without another write", async () => {
    const f = await fixture({ failure: "/api/v1/agent/swap/submit" })
    expect(await run(swapArgs, f.deps)).toBe(1)
    const count = f.calls.filter((call) => call.body).length
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.calls.filter((call) => call.body)).toHaveLength(count)
  })
  test("status is read-only and supports a launch id without sniffing its prefix", async () => {
    const f = await fixture()
    f.setBuilt()
    expect(await run(["swap", "status", "arbitrary", "--kind", "launch", "--json"], f.deps)).toBe(0)
    expect(f.calls.map((call) => call.path)).toEqual(["/api/v1/launch/headless/jobs/arbitrary"])
  })
  test("launch builds no first buy, uses relay and confirms the saved signature", async () => {
    const f = await fixture({ scopes: ["launch:write"] })
    expect(await run(launchArgs, f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("self/build"))?.body).toMatchObject({
      clientLaunchId: "launch-1",
      buyAmount: 0,
      chain: "solana",
      linkedWalletId: "wallet",
    })
    expect(f.calls.find((call) => call.path.endsWith("self/confirm"))?.body.signature).toBe(signature)
    expect(f.stderr.text).toContain("Maximum launch debit: 30000000")
  })
  for (const opts of [{ allowLaunch: false }, { scopes: ["swap:write"] }])
    test(`launch requires scope and operator capability ${JSON.stringify(opts)}`, async () => {
      const f = await fixture(opts)
      expect(await run(launchArgs, f.deps)).toBe(1)
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    })
  test("launch retry after lost confirmation confirms only, never builds or broadcasts again", async () => {
    const f = await fixture({ failure: "/api/v1/launch/self/confirm" })
    expect(await run(launchArgs, f.deps)).toBe(1)
    expect(await run(launchArgs, f.deps)).toBe(1)
    expect(f.calls.filter((call) => call.path.endsWith("/build"))).toHaveLength(1)
    expect(f.calls.filter((call) => call.body?.method === "sendTransaction")).toHaveLength(1)
    expect(f.calls.filter((call) => call.path.endsWith("/confirm"))).toHaveLength(2)
  })
  test("relay signature cryptographically matches the SDK canonical payload", () => {
    const wallet = { signer: pem, id: "wallet", address: mint, appId: "app", privyWalletId: "privy" }
    const result = authorizationSignature(wallet, "unsigned")
    const bytes = canonicalAuthorizationPayloadBytes({ appId: "app", privyWalletId: "privy", body: result.body })
    expect(verify("sha256", bytes, pair.publicKey, Buffer.from(result.authorizationSignature, "base64"))).toBe(true)
    expect(JSON.stringify(result)).not.toContain(pem)
  })
  test("a lost build response never triggers a second build under the same local id", async () => {
    const f = await fixture({ failure: "/api/v1/agent/swap/build" })
    expect(await run(swapArgs, f.deps)).toBe(1)
    expect(await run(swapArgs, f.deps)).toBe(1)
    expect(f.calls.filter((call) => call.path.endsWith("/build"))).toHaveLength(1)
  })
  test("concurrent invocations cannot both start the same local operation", async () => {
    const f = await fixture()
    await Promise.all([run(swapArgs, f.deps), run(swapArgs, f.deps)])
    expect(f.calls.filter((call) => call.path.endsWith("/build"))).toHaveLength(1)
    expect(f.calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(1)
  })
  test("a device credential alone cannot trade", async () => {
    const f = await fixture()
    delete f.deps.env.CANDLE_API_KEY
    f.deps.env.CANDLE_DEVICE_TOKEN = "device-only"
    expect(await run(swapArgs, f.deps)).toBe(1)
    expect(f.calls).toHaveLength(0)
  })
  test("unknown options fail before any request", async () => {
    const f = await fixture()
    expect(await run([...swapArgs, "--buy-amount", "1"], f.deps)).toBe(2)
    expect(f.calls).toHaveLength(0)
  })
  // ── BE-249: the embedded wallet as a payer ─────────────────────────────────────────────────
  test("a named embedded wallet builds deferred and executes only after the prompt", async () => {
    const f = await fixture()
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(0)
    const build = f.calls.find((call) => call.path.endsWith("trade/agent/build"))
    expect(build?.body).toMatchObject({ payer: { type: "main" }, deferExecution: true })
    // Nothing is relay-signed: Candle holds this wallet's delegation and signs server-side.
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
    expect(f.calls.some((call) => call.path.endsWith("trade/agent/submit"))).toBe(false)
    const executes = f.calls.filter((call) => call.path === "/api/v1/trade/agent/execute")
    // Two: the pre-build support probe, then the execution itself, after the quote was shown.
    expect(executes).toHaveLength(2)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ status: "executed", wallet: expect.any(String) })
  })
  test("declining an embedded quote executes nothing", async () => {
    const f = await fixture({ prompt: "n" })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", embedded, "--json"], f.deps)).toBe(0)
    // The probe is the only /execute call: it answers JOB_NOT_FOUND and writes nothing.
    expect(f.calls.filter((call) => call.path === "/api/v1/trade/agent/execute")).toHaveLength(1)
    expect(JSON.parse(f.stdout.text).status).toBe("cancelled")
  })
  test("an account whose only payer is embedded needs no --wallet", async () => {
    const f = await fixture({ teeWallets: 0 })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("trade/agent/build"))?.body).toMatchObject({
      payer: { type: "main" },
      deferExecution: true,
    })
  })
  test("with both kinds of payer available, an unnamed wallet refuses and names them", async () => {
    const f = await fixture()
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    const failure = JSON.parse(f.stdout.text)
    expect(failure.code).toBe("PAYER_REQUIRED")
    expect(failure.message).toContain(embedded)
    expect(failure.message).toContain("tee")
  })
  test("a wallet name that matches nothing lists what the account can actually pay from", async () => {
    const f = await fixture()
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", "nope", "--yes", "--json"], f.deps)).toBe(1)
    const message = JSON.parse(f.stdout.text).message
    expect(message).toContain(embedded)
    expect(message).toContain("wallet")
    expect(message).not.toContain("Name exactly one TEE wallet")
  })
  test("a base pair refuses the embedded payer rather than executing one-shot", async () => {
    const f = await fixture()
    expect(
      await run(["swap", "SOL", "USDC", "--amount", "0.25", "--wallet", embedded, "--yes", "--json"], f.deps),
    ).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    expect(JSON.parse(f.stdout.text).code).toBe("PAIR_UNSUPPORTED")
  })
  test("a deployment without /execute never builds an embedded trade", async () => {
    const f = await fixture({ noExecuteRoute: true })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    expect(JSON.parse(f.stdout.text).code).toBe("EMBEDDED_PAYER_UNSUPPORTED")
  })
  test("an account with no embedded wallet keeps naming its TEE wallet", async () => {
    const f = await fixture({ noEmbedded: true })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("trade/agent/build"))?.body).toMatchObject({
      payer: { type: "linked", linkedWalletId: "wallet" },
    })
  })
  test("raw sizing never passes through floating point", () => {
    expect(rawAmount("9007199254740993", 0)).toBe("9007199254740993")
    expect(rawAmount("0.000000001", 9)).toBe("1")
  })
})
