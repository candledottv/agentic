import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { canonicalAuthorizationPayloadBytes } from "../../../sdk/src/authorization-signature"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "../test-support"
import { authorizationSignature, rawAmount } from "../trading"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const mint = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
/** The account's embedded (main) Solana wallet, distinct from the TEE wallet's address. */
const embedded = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 5), Buffer.alloc(40)]).toString("base64")
const signature = base58.encode(Buffer.alloc(64, 5))
/** BE-1283: what POST /uploads/agent-image answers, and the smallest file that sniffs as a PNG. */
const hostedImage = "https://ipfs.candle.test/ipfs/bafyimage"
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
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
    /** BE-355 (T10, T11): RPC methods that always answer HTTP 429. */
    rpcRateLimit?: string[]
    /** BE-355: run as acting profile `work` instead of pre-profile mode. */
    profile?: boolean
    /** BE-500: `teeReadiness` on GET /keys/self/limits. Absent by default, as an older API answers. */
    readiness?: unknown
    /** BE-505: the body POST /agent/swap/submit answers with. Defaults to one without `settlement`. */
    swapBuildError?: Record<string, unknown>
    swapSubmitError?: Record<string, unknown>
    /** BE-1397: a Candle error the token trade's /execute (after the build) or /submit answers. */
    tradeExecuteError?: Record<string, unknown>
    tradeSubmitError?: Record<string, unknown>
    swapJob?: Record<string, unknown>
    swapSubmit?: unknown
    /** BE-503: `embeddedWalletPermission` on GET /wallets/embedded. Absent by default (an older API). */
    embeddedPermission?: "allowed" | "denied"
    /** BE-869: a Candle error POST /launch/self/build answers instead of a transaction. */
    launchBuildError?: Record<string, unknown>
    /** BE-1283: a Candle error POST /uploads/agent-image answers instead of a URL, until cleared. */
    uploadError?: { code: string; message: string } | null
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-trade-"))
  folders.push(dir)
  /** `claims` is how many operation ids this machine had claimed when the request was made. */
  const calls: { path: string; body: Record<string, unknown>; headers: Headers; claims: number }[] = []
  const claims = () => {
    try {
      return readdirSync(join(dir, "operations")).length
    } catch {
      return 0
    }
  }
  let built = false
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    // An image upload's body is the file's bytes, not JSON.
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, body, headers: new Headers(init?.headers), claims: claims() })
    const ok = (value: unknown) => Response.json(value)
    if (opts.failure === path) throw new Error("lost response")
    if (path === "/api/v1/uploads/agent-image")
      return opts.uploadError
        ? Response.json({ success: false, error: opts.uploadError }, { status: 429 })
        : ok({ success: true, imageUrl: hostedImage })
    if (path.includes("/jobs/"))
      return opts.swapJob
        ? path.includes("/agent/swap/jobs/")
          ? ok({ success: true, job: opts.swapJob })
          : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
        : built
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
      return ok({
        success: true,
        wallets: { solana: opts.noEmbedded ? null : { address: embedded }, evm: null },
        ...(opts.embeddedPermission !== undefined ? { embeddedWalletPermission: opts.embeddedPermission } : {}),
      })
    if (path === "/api/v1/agent/keys/self/limits")
      return ok({
        success: true,
        keyLimits: null,
        ...(opts.readiness !== undefined ? { teeReadiness: opts.readiness } : {}),
      })
    if (path === "/api/v1/trade/agent/execute") {
      if (opts.noExecuteRoute) return new Response("404 Not Found", { status: 404 })
      // The support probe: no row for this id yet, so the real route answers JOB_NOT_FOUND. A
      // second call, after a build, is the execution itself.
      if (built && opts.tradeExecuteError) return Response.json({ error: opts.tradeExecuteError }, { status: 500 })
      return built
        ? ok({ success: true, status: "executed", signature })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    }
    if (path.endsWith("/build")) {
      if (path === "/api/v1/agent/swap/build" && opts.swapBuildError)
        return Response.json({ error: opts.swapBuildError }, { status: 400 })
      if (path.includes("launch") && opts.launchBuildError)
        return Response.json({ success: false, error: opts.launchBuildError }, { status: 400 })
      built = true
      if (path.includes("launch"))
        return ok({ success: true, transaction: "unsigned", maxDebitLamports: "30000000", expiresAt: 10000 })
      const quote = {
        status: "built",
        swapId: "server-swap",
        recipient: body?.payer?.type === "main" ? embedded : mint,
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
    if (path === "/api/v1/agent/swap/submit" && opts.swapSubmitError)
      return Response.json({ error: opts.swapSubmitError }, { status: 400 })
    if (path === "/api/v1/agent/swap/submit" && opts.swapSubmit !== undefined) return ok(opts.swapSubmit)
    if (path === "/api/v1/trade/agent/submit" && opts.tradeSubmitError)
      return Response.json({ error: opts.tradeSubmitError }, { status: 500 })
    if (path.endsWith("/submit") || path.endsWith("/confirm"))
      return ok({ success: true, status: "executed", signature })
    if (path === "/rpc") {
      if (opts.rpcRateLimit?.includes(body.method)) return new Response("rate limited", { status: 429 })
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
    ...(opts.profile ? createFakeConfigStore({ profiles: { work: {} }, activeProfile: "work" }) : {}),
  })
  return {
    deps,
    calls,
    stdout,
    stderr,
    setBuilt: () => {
      built = true
    },
    /** BE-1283: writes a file beside the config and returns its path. */
    file: async (name: string, bytes: Uint8Array) => {
      const path = join(dir, name)
      await writeFile(path, bytes)
      return path
    },
    opts,
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
  // SOL to ETH or USDG is a bridge since Ember 4c (R1), covered in bridge.test.ts; a Hood token
  // or a malformed asset is still refused before any request.
  for (const to of ["0x1234567890123456789012345678901234567890", "ethereum:ETH"])
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
  test("BE-869: launch --buy sends the buy in lamports, says it rides in the launch transaction, and signs as before", async () => {
    const f = await fixture({ scopes: ["launch:write"] })
    expect(await run([...launchArgs, "--buy", "0.1"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("self/build"))?.body).toMatchObject({
      clientLaunchId: "launch-1",
      buyAmount: "100000000",
      chain: "solana",
      linkedWalletId: "wallet",
    })
    expect(f.stderr.text).toContain("Launch Token (TOK) with a first buy of 0.100000000 SOL")
    expect(f.stderr.text).toContain("spends 0.100000000 SOL on a first buy in the same transaction")
    expect(f.stderr.text).toContain("Minimum received: not quoted (the first buy on the new curve)")
    expect(f.stderr.text).not.toContain("separate candle swap")
    expect(f.calls.find((call) => call.path.endsWith("self/confirm"))?.body.signature).toBe(signature)
  })
  test("BE-869: launch --buy is in the quote asset's whole units: 2.5 USDC is 2500000", async () => {
    const f = await fixture({ scopes: ["launch:write"] })
    expect(await run([...launchArgs, "--quote-asset", "usdc", "--buy", "2.5"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path.endsWith("self/build"))?.body).toMatchObject({
      buyAmount: "2500000",
      quoteAsset: "usdc",
    })
  })
  for (const amount of ["0", "abc", "1e3", "0.0000000001"])
    test(`BE-869: launch --buy ${amount} is INVALID_AMOUNT before any build`, async () => {
      const f = await fixture()
      expect(await run([...launchArgs, "--buy", amount], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "").code).toBe("INVALID_AMOUNT")
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
    })
  test("BE-869: a server that refuses a TEE first buy is told plainly: TEE_LAUNCH_BUYS_ENABLED, nothing signed", async () => {
    const f = await fixture({
      launchBuildError: {
        code: "VALIDATION_FAILED",
        message: "A TEE wallet launches with buyAmount 0; buy the new token with a separate swap once it lands",
        field: "buyAmount",
      },
    })
    expect(await run([...launchArgs, "--buy", "0.1"], f.deps)).toBe(1)
    const failure = JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")
    expect(failure.code).toBe("VALIDATION_FAILED")
    expect(failure.message).toContain("Candle refused the first buy on this TEE launch")
    expect(failure.message).toContain("TEE_LAUNCH_BUYS_ENABLED")
    expect(failure.message).toContain("Nothing was built or signed")
    expect(failure.suggestion).toContain("Launch without --buy")
    expect(failure.details).toMatchObject({ field: "buyAmount" })
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
    expect(f.calls.some((call) => call.body?.method === "sendTransaction")).toBe(false)
  })
  test("BE-869: any other build refusal passes through unchanged", async () => {
    const f = await fixture({
      launchBuildError: { code: "VALIDATION_FAILED", message: "name is required", field: "name" },
    })
    expect(await run([...launchArgs, "--buy", "0.1"], f.deps)).toBe(1)
    const failure = JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")
    expect(failure.message).toStartWith("name is required")
    expect(failure.message).not.toContain("TEE_LAUNCH_BUYS_ENABLED")
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
  describe("BE-1283: launch --image uploads the file, then launches with the URL that came back", () => {
    /** `launchArgs` with its image, the value after `--image-url`, replaced by `flag value`. */
    const imageArgs = (flag: string, value: string) =>
      launchArgs.map((arg, i) => (arg === "--image-url" ? flag : launchArgs[i - 1] === "--image-url" ? value : arg))
    const withImage = (path: string) => imageArgs("--image", path)
    const uploads = <T extends { path: string }>(calls: T[]) =>
      calls.filter((call) => call.path.endsWith("/uploads/agent-image"))
    const lastJson = (text: string) => JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")

    test("one upload under the key, before the build and before the id is claimed; the build carries imageUrl and never a path", async () => {
      const f = await fixture({ scopes: ["launch:write"] })
      const path = await f.file("logo.png", pngBytes)
      expect(await run(withImage(path), f.deps)).toBe(0)
      const upload = uploads(f.calls)
      expect(upload).toHaveLength(1)
      expect(upload[0]?.headers.get("content-type")).toBe("image/png")
      expect(upload[0]?.headers.get("x-api-key")).toBe("bound-key")
      // Nothing was claimed when the file went up; the build is made under the claim.
      expect(upload[0]?.claims).toBe(0)
      const build = f.calls.find((call) => call.path.endsWith("self/build"))
      expect(build?.claims).toBe(1)
      expect(f.calls.indexOf(upload[0] as (typeof f.calls)[number])).toBeLessThan(f.calls.indexOf(build as never))
      expect(build?.body).toMatchObject({ clientLaunchId: "launch-1", chain: "solana", imageUrl: hostedImage })
      expect(JSON.stringify(build?.body)).not.toContain(path)
      expect(Object.keys(build?.body ?? {})).not.toContain("imagePath")
      // The publication is said before the confirm, and the result names the URL that was used.
      expect(f.stderr.text).toContain("The file becomes public and permanent")
      expect(f.stderr.text).toContain(`Image: ${hostedImage}`)
      expect(lastJson(f.stdout.text)).toMatchObject({ kind: "launch", imageUrl: hostedImage })
    })

    test("a resumed operation confirms the saved signature and uploads nothing", async () => {
      const f = await fixture({ failure: "/api/v1/launch/self/confirm" })
      const path = await f.file("logo.png", pngBytes)
      expect(await run(withImage(path), f.deps)).toBe(1)
      expect(await run(withImage(path), f.deps)).toBe(1)
      expect(uploads(f.calls)).toHaveLength(1)
      expect(f.calls.filter((call) => call.path.endsWith("/build"))).toHaveLength(1)
      expect(f.calls.filter((call) => call.path.endsWith("/confirm"))).toHaveLength(2)
    })

    test("a refused upload comes back unchanged, claims nothing, and leaves the launch id usable", async () => {
      const f = await fixture({
        uploadError: { code: "RATE_LIMITED", message: "Too many image uploads; retry shortly" },
      })
      const path = await f.file("logo.png", pngBytes)
      expect(await run(withImage(path), f.deps)).toBe(1)
      expect(lastJson(f.stdout.text)).toEqual({
        ok: false,
        code: "RATE_LIMITED",
        message: "Too many image uploads; retry shortly",
      })
      expect(f.stderr.text).toContain("The launch was not started, and its id launch-1 is unused.")
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
      expect(f.calls.at(-1)?.claims).toBe(0)
      // The same id launches once the route accepts the file: the failure did not consume it.
      f.opts.uploadError = null
      expect(await run(withImage(path), f.deps)).toBe(0)
      expect(f.calls.find((call) => call.path.endsWith("self/build"))?.body).toMatchObject({
        clientLaunchId: "launch-1",
        imageUrl: hostedImage,
      })
    })

    test("a file that is not an image, or is over 10MB, is refused with no request made", async () => {
      const f = await fixture()
      const text = await f.file("logo.png", new TextEncoder().encode("not an image"))
      expect(await run(withImage(text), f.deps)).toBe(1)
      expect(lastJson(f.stdout.text)).toMatchObject({ ok: false, code: "IMAGE_TYPE_UNSUPPORTED" })
      const big = new Uint8Array(11 * 1024 * 1024)
      big.set(pngBytes)
      expect(await run(withImage(await f.file("big.png", big)), f.deps)).toBe(1)
      const tooLarge = lastJson(f.stdout.text)
      expect(tooLarge).toMatchObject({ ok: false, code: "IMAGE_TOO_LARGE" })
      // No launch id is involved yet, so the failure sends nobody to `swap status`.
      expect(tooLarge.message).not.toContain("launch-1")
      expect(f.calls).toEqual([])
    })

    test("both image flags, or neither, is a usage refusal with no request made", async () => {
      const f = await fixture()
      const path = await f.file("logo.png", pngBytes)
      expect(await run([...launchArgs, "--image", path], f.deps)).toBe(2)
      expect(lastJson(f.stdout.text).message).toContain("not both")
      const neither = launchArgs.filter((arg, i) => arg !== "--image-url" && launchArgs[i - 1] !== "--image-url")
      expect(await run(neither, f.deps)).toBe(2)
      expect(lastJson(f.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
      expect(f.calls).toEqual([])
    })

    test("--image-url with anything but an https:// URL is refused here, naming --image", async () => {
      for (const value of ["./logo.png", "/Users/me/logo.png", "http://example.test/image.png", "logo.png"]) {
        const f = await fixture()
        expect(await run(imageArgs("--image-url", value), f.deps)).toBe(2)
        const failure = lastJson(f.stdout.text)
        expect(failure).toMatchObject({ ok: false, code: "USAGE" })
        expect(failure.message).toContain("--image <path>")
        expect(f.calls).toEqual([])
      }
    })

    test("with --image-url nothing is uploaded and the result is as before", async () => {
      const f = await fixture({ scopes: ["launch:write"] })
      expect(await run(launchArgs, f.deps)).toBe(0)
      expect(uploads(f.calls)).toEqual([])
      expect(lastJson(f.stdout.text)).not.toHaveProperty("imageUrl")
    })
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
  test("embedded SOL to USDC builds, confirms and submits without a sign relay or deferred execute probe", async () => {
    const f = await fixture({
      swapSubmit: {
        success: true,
        payload: { hashes: [signature], settlement: { state: "settled", settledOutRaw: "300000" } },
      },
    })
    expect(
      await run(["swap", "SOL", "USDC", "--amount", "0.25", "--wallet", embedded, "--yes", "--json"], f.deps),
    ).toBe(0)
    expect(f.calls.find((call) => call.path === "/api/v1/agent/swap/build")?.body.payer).toEqual({ type: "main" })
    expect(f.calls.find((call) => call.path === "/api/v1/agent/swap/submit")?.body).toMatchObject({
      swapId: "server-swap",
    })
    expect(f.calls.some((call) => call.path.includes("trade/agent/execute") || call.path.endsWith("/sign"))).toBe(false)
    expect(f.stderr.text).toContain("settled")
  })
  test("old API payer refusal maps to EMBEDDED_PAYER_UNSUPPORTED, no submit", async () => {
    const f = await fixture({
      swapBuildError: { code: "VALIDATION_FAILED", field: "payer", message: "main unsupported" },
    })
    expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("EMBEDDED_PAYER_UNSUPPORTED")
    expect(f.calls.some((call) => call.path.endsWith("/submit"))).toBe(false)
  })
  for (const terminal of [true, false])
    test(`not_broadcast terminal=${terminal} prints new-id instruction only for a terminal job`, async () => {
      const f = await fixture({
        swapSubmitError: { code: "SWAP_FAILED", message: "refused", stage: "not_broadcast", terminal },
      })
      expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(
        1,
      )
      expect(f.stderr.text.includes("retry with a new id")).toBe(terminal)
    })
  for (const leg of ["approval", "trade", 1])
    test(`unconfirmed ${leg} displays evidence and never retries`, async () => {
      const f = await fixture({
        swapSubmitError: {
          code: "SWAP_FAILED",
          message: "unknown",
          stage: "unconfirmed",
          leg,
          hashes: ["known-hash"],
          legs: [{ leg, outcome: "unknown", hashUnknown: true }],
        },
      })
      expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(
        3,
      )
      expect(f.stderr.text).toContain("known-hash")
      expect(f.stderr.text).toContain(`leg ${leg}`)
      expect(f.stderr.text).toContain("Do not automatically retry")
      expect(f.calls.filter((call) => call.path === "/api/v1/agent/swap/submit")).toHaveLength(1)
    })
  // ── BE-1397 (BE-1123 item 12): a token trade that may have landed ──────────────────────────
  for (const [rail, wallet, option, path] of [
    ["embedded /execute", embedded, "tradeExecuteError", "/api/v1/trade/agent/execute"],
    ["TEE /submit", "tee", "tradeSubmitError", "/api/v1/trade/agent/submit"],
  ] as const) {
    for (const stage of ["unconfirmed", "executed"])
      test(`a token trade refused at ${rail} with stage ${stage} exits 3 and keeps stage and signature`, async () => {
        const f = await fixture({
          [option]: {
            code: "SWAP_FAILED",
            message: "outcome unknown",
            retryable: false,
            stage,
            signature: "trade-sig",
            priorSignatures: ["approval-sig"],
          },
        })
        const args = ["swap", "SOL", mint, "--amount", "1", "--wallet", wallet, "--client-trade-id", "t-1", "--yes"]
        expect(await run([...args, "--json"], f.deps)).toBe(3)
        const failure = JSON.parse(f.stdout.text)
        expect(failure).toMatchObject({
          ok: false,
          code: "SWAP_FAILED",
          details: { stage, signature: "trade-sig", priorSignatures: ["approval-sig"], retryable: false },
        })
        expect(failure.message).toContain("candle swap status t-1")
        expect(f.stderr.text).toContain("trade-sig")
        expect(f.stderr.text).toContain(stage === "executed" ? "Do not retry" : "Do not automatically retry")
        // One call past the embedded rail's support probe: nothing is re-sent.
        expect(f.calls.filter((call) => call.path === path)).toHaveLength(rail.startsWith("embedded") ? 2 : 1)
      })
    for (const [stage, code] of [
      ["not_broadcast", "SWAP_FAILED"],
      ["reverted", "TRADE_REVERTED"],
    ])
      test(`a token trade refused at ${rail} with stage ${stage} is still exit 1, with its stage`, async () => {
        const f = await fixture({
          [option]: { code, message: "failed", stage, ...(stage === "reverted" ? { signature: "trade-sig" } : {}) },
        })
        expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", wallet, "--yes", "--json"], f.deps)).toBe(1)
        const failure = JSON.parse(f.stdout.text)
        expect(failure.code).toBe(code)
        expect(failure.details.stage).toBe(stage)
        expect(failure.details.signature).toBe(stage === "reverted" ? "trade-sig" : undefined)
      })
  }
  test("a refusal with no stage keeps exit 1 and adds no details", async () => {
    const f = await fixture({ tradeSubmitError: { code: "QUOTE_EXPIRED", message: "expired" } })
    expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", "tee", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).not.toHaveProperty("details")
  })
  test("swap status reads an embedded job with durable leg evidence and no write", async () => {
    const f = await fixture({
      swapJob: {
        status: "submitted",
        stage: "unconfirmed",
        leg: "approval",
        hashes: ["approval-hash"],
        signature: null,
      },
    })
    expect(await run(["swap", "status", "embedded-id", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).job.stage).toBe("unconfirmed")
    expect(f.stderr.text).toContain("approval-hash")
    expect(f.calls.some((call) => call.body)).toBe(false)
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
  describe("a key denied the embedded wallet (BE-503, R5.10)", () => {
    test("with one TEE wallet beside it, the TEE wallet is the payer and no --wallet is needed", async () => {
      const f = await fixture({ embeddedPermission: "denied" })
      expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(0)
      expect(f.calls.find((call) => call.path.endsWith("trade/agent/build"))?.body).toMatchObject({
        payer: { type: "linked", linkedWalletId: "wallet" },
      })
    })
    test("with only the embedded wallet, it refuses before any build, naming the refusal and the fix", async () => {
      const f = await fixture({ embeddedPermission: "denied", teeWallets: 0 })
      expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
      const failure = JSON.parse(f.stdout.text)
      expect(failure.code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
      expect(failure.message).toContain(embedded)
      expect(failure.suggestion).toContain("--embedded-wallet allow")
    })
    test("naming the embedded wallet refuses before any build and points at the TEE wallet instead", async () => {
      const f = await fixture({ embeddedPermission: "denied" })
      expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", embedded, "--yes", "--json"], f.deps)).toBe(1)
      expect(f.calls.some((call) => call.path.endsWith("/build"))).toBe(false)
      const failure = JSON.parse(f.stdout.text)
      expect(failure.code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
      expect(failure.message).toContain("tee (wallet,")
    })
    test("a miss lists only the payers this key may use", async () => {
      const f = await fixture({ embeddedPermission: "denied" })
      expect(await run(["swap", "SOL", mint, "--amount", "1", "--wallet", "nope", "--yes", "--json"], f.deps)).toBe(1)
      const message = JSON.parse(f.stdout.text).message
      expect(message).toContain("tee")
      expect(message).not.toContain(embedded)
    })
    test("allowed, or absent on an older API, keeps the embedded wallet a payer", async () => {
      for (const embeddedPermission of ["allowed", undefined] as const) {
        const f = await fixture({ embeddedPermission, teeWallets: 0 })
        expect(await run(["swap", "SOL", mint, "--amount", "1", "--yes", "--json"], f.deps)).toBe(0)
        expect(f.calls.find((call) => call.path.endsWith("trade/agent/build"))?.body).toMatchObject({
          payer: { type: "main" },
        })
      }
    })
  })
  test("raw sizing never passes through floating point", () => {
    expect(rawAmount("9007199254740993", 0)).toBe("9007199254740993")
    expect(rawAmount("0.000000001", 9)).toBe("1")
  })
})

/**
 * BE-355 (T10, T11). A swap's reads all come before any signature: a rate limit that survives the
 * client's retry is `RPC_RATE_LIMITED`, exit 1, and nothing is signed, relayed or submitted. A
 * launch signs through the relay and then sends over the RPC: a rate limit on that send is D4's
 * uncertain outcome, exit 3 with the saved signature, and the same `--client-trade-id` confirms
 * the saved signature on the next run without building or sending again. `launch`'s tests live
 * here because this file owns them.
 */
describe("BE-355: rate limits (T10, T11)", () => {
  const percentArgs = [
    "swap",
    "SOL",
    "USDC",
    "--percent",
    "50",
    "--wallet",
    "tee",
    "--client-trade-id",
    "test-1",
    "--yes",
    "--json",
  ]
  const rpcMethods = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.calls.filter((c) => c.path === "/rpc").map((c) => c.body?.method)

  test("T10: swap with the balance read rate-limited twice: exit 1, RPC_RATE_LIMITED, nothing signed or sent; profile set named for profile work", async () => {
    const f = await fixture({ rpcRateLimit: ["getBalance"], profile: true })
    expect(await run(percentArgs, f.deps)).toBe(1)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("RPC_RATE_LIMITED")
    expect(out.message).toContain(
      "The Solana RPC at localhost is rate-limiting this CLI (HTTP 429, retried once). Nothing was signed or sent.",
    )
    expect(out.suggestion).toBe(
      "candle profile set work --rpc-url https://<your-rpc>\nor, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL",
    )
    expect(rpcMethods(f)).toEqual(["getBalance", "getBalance"])
    expect(f.calls.some((c) => /\/(sign|submit|execute)$/.test(c.path))).toBe(false)
    expect(f.stderr.text).toContain("Solana RPC: localhost (CANDLE_SOLANA_RPC_URL)")
  })

  test("T10: pre-profile: the suggestion is D3's pre-profile text byte for byte", async () => {
    const f = await fixture({ rpcRateLimit: ["getBalance"] })
    expect(await run(percentArgs, f.deps)).toBe(1)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("RPC_RATE_LIMITED")
    expect(out.suggestion).toBe(
      "--rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command\nor sign in (candle auth login) to store one per profile",
    )
    expect(out.suggestion).not.toContain("profile set")
    expect(out.suggestion).not.toContain("<name>")
  })

  test("T11: launch with a rate-limited send: exit 3, the saved signature, one send; the re-run confirms and sends nothing", async () => {
    const f = await fixture({ rpcRateLimit: ["sendTransaction"] })
    expect(await run(launchArgs, f.deps)).toBe(3)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.ok).toBe(false)
    expect(out.code).toBe("RPC_RATE_LIMITED")
    expect(out.message).toContain(`It may still land: check ${signature} before anything else.`)
    expect(out.message).toContain("--client-trade-id launch-1")
    expect(rpcMethods(f)).toEqual(["sendTransaction"])
    expect(f.calls.some((c) => c.path === "/api/v1/launch/self/confirm")).toBe(false)

    const before = f.calls.length
    expect(await run(launchArgs, f.deps)).toBe(0)
    const again = f.calls.slice(before).map((c) => c.path)
    expect(again).not.toContain("/rpc")
    expect(again).not.toContain("/api/v1/launch/self/build")
    expect(again).toContain("/api/v1/launch/self/confirm")
    expect(f.calls.slice(before).find((c) => c.path === "/api/v1/launch/self/confirm")?.body).toEqual({
      clientLaunchId: "launch-1",
      signature,
    })
  })
})

// BE-500 (R4.6): a TEE payer's missing key limits, refused locally before any RPC or write, when
// the API reports readiness. Never assumed when the field is absent.
describe("TEE limits: only the server decides", () => {
  const NONE = { txLimit: false, rawCaps: { SOL: false, USDC: false, CNDL: false, ETH: false, USDG: false } }

  test("a TEE key with no limits set swaps: the CLI never refuses locally and never reads its limits", async () => {
    const f = await fixture({ readiness: NONE })
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.calls.some((call) => call.path === "/api/v1/agent/keys/self/limits")).toBe(false)
    expect(f.calls.some((call) => call.path.endsWith("swap/build"))).toBe(true)
  })

  test("a sell with no SOL cap goes to the server too", async () => {
    const f = await fixture({ readiness: NONE })
    expect(await run(["swap", mint, "SOL", "--amount", "1", "--wallet", "tee", "--yes", "--json"], f.deps)).toBe(0)
  })
})

describe("BE-505 (R8.4): the settled receipt of a base-pair swap", () => {
  const settlement = (fields: Record<string, unknown>) => ({
    legs: [{ chain: "solana", hash: signature, status: "confirmed" }],
    in: { asset: "SOL", raw: "250000000" },
    expectedOutRaw: "123500",
    ...fields,
  })
  const submitted = (value: unknown) => ({
    success: true,
    payload: { hashes: [signature], expectedOutRaw: "123500", ...(value === undefined ? {} : { settlement: value }) },
  })

  test("settled: prints the measured amount in the out asset and passes settlement through in --json", async () => {
    const measured = settlement({
      state: "settled",
      settledOutRaw: "123789",
      settledOutSource: "tx_balance_delta",
      measuredAt: { slot: 451209566 },
    })
    const f = await fixture({ swapSubmit: submitted(measured) })
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.stderr.text).toContain("settled 0.123789 USDC\n")
    expect(f.stderr.text).not.toContain("Re-check")
    const out = JSON.parse(f.stdout.text)
    expect(out.settlement).toEqual(measured)
    expect(out.payload.settlement).toEqual(measured)
  })

  for (const state of ["pending", "uncertain", "failed"]) {
    test(`${state}: prints the state and names the job read, never the receipt route`, async () => {
      const f = await fixture({ swapSubmit: submitted(settlement({ state })) })
      expect(await run(swapArgs, f.deps)).toBe(0)
      expect(f.stderr.text).toContain(
        `Settlement: ${state}. Re-check with GET /api/v1/agent/swap/jobs/test-1 (candle swap status test-1).`,
      )
      expect(f.stderr.text).not.toContain("receipts")
      expect(f.stderr.text).not.toMatch(/^settled /m)
      expect(JSON.parse(f.stdout.text).settlement.state).toBe(state)
    })
  }

  test("settled without a measured amount prints no number", async () => {
    const f = await fixture({ swapSubmit: submitted(settlement({ state: "settled" })) })
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.stderr.text).toContain(
      "Settlement: settled, amount not measured. Re-check with GET /api/v1/agent/swap/jobs/test-1",
    )
    expect(f.stderr.text).not.toMatch(/^settled /m)
  })

  test("an older API with no settlement is not measured: no amount, no zero, no settlement key invented", async () => {
    const f = await fixture({ swapSubmit: submitted(undefined) })
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.stderr.text).toContain("Settlement: not measured. Re-check with GET /api/v1/agent/swap/jobs/test-1")
    expect(f.stderr.text).not.toMatch(/settled 0/)
    const out = JSON.parse(f.stdout.text)
    expect("settlement" in out).toBe(false)
    expect(out.payload.expectedOutRaw).toBe("123500")
  })

  test("an unreadable settlement is not measured and is still passed through as sent", async () => {
    const odd = { state: "reconciling", settledOutRaw: "12" }
    const f = await fixture({ swapSubmit: submitted(odd) })
    expect(await run(swapArgs, f.deps)).toBe(0)
    expect(f.stderr.text).toContain("Settlement: not measured.")
    expect(JSON.parse(f.stdout.text).settlement).toEqual(odd)
  })

  test("a token trade reports no settlement line: that rail has no settlement", async () => {
    const f = await fixture()
    expect(await run(["swap", "SOL", mint, "--amount", "0.25", "--wallet", "tee", "--yes", "--json"], f.deps)).toBe(0)
    expect(f.stderr.text).not.toContain("Settlement")
    expect(f.stderr.text).not.toMatch(/^settled /m)
  })
})

for (const key of ["cndl_live_Abcd1234" + "x".repeat(35), "unrecognized-key"]) {
  test(`swap status unknown id names acting key and per-rail rule: ${key.slice(0, 20)}`, async () => {
    const f = await fixture()
    f.deps.env.CANDLE_API_KEY = key
    expect(await run(["swap", "status", "unknown-op", "--json"], f.deps)).toBe(1)
    const report = JSON.parse(f.stdout.text)
    expect(report.code).toBe("JOB_NOT_FOUND")
    expect(report.message).toContain(key.startsWith("cndl_live_") ? "key Abcd1234" : "key this key")
    expect(report.message).toContain("Nothing was resent")
    expect(report.suggestion).toContain("swap jobs only by the key that placed them")
  })
}
