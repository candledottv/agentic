/**
 * Pure client tests with an injected fake fetch: request-shape snapshots (URL, method, headers,
 * body) for every method so the wire contract cannot drift silently, envelope-to-CandleApiError
 * mapping, the launch() retry policy, and waitForLaunch() polling. No server, no network.
 */

import { describe, expect, test } from "bun:test"
import {
  type AgentTierInfo,
  type BuildAtomicLaunchRequest,
  type BuildSelfLaunchRequest,
  type BuildTradeRequest,
  type BuildTradeResult,
  CandleClient,
  type CandleClientOptions,
  type ConfirmSelfLaunchRequest,
  type ConfirmTradeRequest,
  type EvmSignTransactionParams,
  type LaunchAtomicRequest,
  type LaunchRequest,
  type ListWalletsResult,
  type PresetsPayload,
  type SpendLimitsResult,
  type SubmitAtomicLaunchRequest,
  type SubmitTradeRequest,
} from "./client"

import { CandleApiError, JsonRpcError } from "./errors"
import { InMemorySecretStore, type SecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** Queue of responses (or Errors to throw as network failures), with an optional fallback factory. */
function fakeFetch(responses: (Response | Error)[], fallback?: () => Response) {
  const calls: RecordedRequest[] = []
  const queue = [...responses]
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      ...(init?.body !== undefined && init?.body !== null ? { body: init.body } : {}),
    })
    const next = queue.shift() ?? fallback?.()
    if (!next) throw new Error("fake fetch: no response queued")
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { calls, impl }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function envelope(
  status: number,
  code: string,
  opts: { retryable?: boolean; field?: string; message?: string } = {},
): Response {
  return json(status, {
    success: false,
    error: {
      code,
      message: opts.message ?? `${code} message`,
      ...(opts.field !== undefined ? { field: opts.field } : {}),
      retryable: opts.retryable === true,
    },
  })
}

function makeClient(
  opts: Partial<Omit<CandleClientOptions, "apiUrl" | "fetch">>,
  responses: (Response | Error)[],
  fallback?: () => Response,
) {
  const { calls, impl } = fakeFetch(responses, fallback)
  const client = new CandleClient({ apiUrl: "https://api.test", fetch: impl, ...opts })
  return { client, calls }
}

const KEYED = { apiKey: "cndl_test_key" }
const JSON_HEADERS = { "content-type": "application/json", "x-api-key": "cndl_test_key" }

const LAUNCH_REQ: LaunchRequest = {
  clientLaunchId: "run-1",
  chain: "solana",
  name: "Trend Coin",
  symbol: "TREND",
  imageUrl: "https://example.com/logo.png",
}

const LAUNCH_OK = {
  success: true,
  chain: "solana",
  mint: "Mint111",
  pool: "Pool111",
  signature: "Sig111",
  quoteAsset: "sol",
  mode: "open",
  stakerAllocationBps: 50,
  matrixVersion: 1,
  links: { candle: "https://candle.tv/token/Mint111", explorer: "https://solscan.io/tx/Sig111" },
  nextBuy: { market: "Pool111", quoteAsset: "sol", marketStateUrl: "/api/v1/markets/solana/Mint111" },
}

function jobBody(status: "submitted" | "confirming" | "confirmed" | "failed") {
  return {
    success: true,
    job: { clientLaunchId: "run-1", chain: "solana", status, createdAt: 1, updatedAt: 2 },
  }
}

describe("request shapes", () => {
  test("getQuotePairs: GET /api/v1/launch/quote-pairs, no auth header without a key", async () => {
    const payload = { matrixVersion: 1, pairs: { solana: [] }, defaults: { solana: "sol" } }
    const { client, calls } = makeClient({}, [json(200, { payload })])
    const result = await client.getQuotePairs()
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/launch/quote-pairs", method: "GET", headers: {} })
    expect(result).toEqual(payload)
  })

  test("getQuotePairs with a chain filter", async () => {
    const { client, calls } = makeClient({}, [json(200, { payload: { matrixVersion: 1, pairs: {}, defaults: {} } })])
    await client.getQuotePairs("hood")
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/quote-pairs?chain=hood")
  })

  test("getPresets: GET /api/v1/launch/presets, unwraps the payload", async () => {
    const payload = { matrixVersion: 1, presets: [] }
    const { client, calls } = makeClient({}, [json(200, { payload })])
    const result = await client.getPresets()
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/launch/presets", method: "GET", headers: {} })
    expect(result).toEqual(payload)
  })

  test("dryRunLaunch: POST /api/v1/launch/headless/dry-run with key and JSON body", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, { success: true, dryRun: true })])
    await client.dryRunLaunch(LAUNCH_REQ)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/headless/dry-run",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(LAUNCH_REQ),
    })
  })

  test("launch: POST /api/v1/launch/headless with key and JSON body", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, LAUNCH_OK)])
    const result = await client.launch(LAUNCH_REQ)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/headless",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(LAUNCH_REQ),
    })
    expect(result).toEqual(LAUNCH_OK as never)
  })

  test("launch generates a sdk- prefixed clientLaunchId when the caller omits one", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, LAUNCH_OK)])
    const { clientLaunchId: _omitted, ...withoutId } = LAUNCH_REQ
    await client.launch(withoutId)
    const sent = JSON.parse(String(calls[0]?.body)) as { clientLaunchId: string }
    expect(sent.clientLaunchId).toMatch(/^sdk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("launchAsync: sends async: true and returns the 202 body", async () => {
    const accepted = {
      success: true,
      accepted: true,
      clientLaunchId: "run-1",
      status: "submitted",
      jobUrl: "/api/v1/launch/headless/jobs/run-1",
    }
    const { client, calls } = makeClient(KEYED, [json(202, accepted)])
    const result = await client.launchAsync(LAUNCH_REQ)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/headless",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...LAUNCH_REQ, async: true }),
    })
    expect(result).toEqual(accepted as never)
  })

  test("getLaunchJob: GET /jobs/:clientLaunchId with key, URL-encoded, unwraps the job", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, jobBody("confirmed"))])
    const job = await client.getLaunchJob("run 1/a")
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/headless/jobs/run%201%2Fa",
      method: "GET",
      headers: { "x-api-key": "cndl_test_key" },
    })
    expect(job.status).toBe("confirmed")
  })

  test("getMarket: GET /api/v1/markets/:chain/:mint, unwraps the market", async () => {
    const market = { chain: "solana", mint: "Mint111", lifecycle: "trading" }
    const { client, calls } = makeClient({}, [json(200, { success: true, market })])
    const result = await client.getMarket("solana", "Mint111")
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/markets/solana/Mint111", method: "GET", headers: {} })
    expect(result).toEqual(market as never)
  })

  test("getQuote: GET quote with side, amountIn, and explicit slippageBps", async () => {
    const { client, calls } = makeClient({}, [json(200, { success: true })])
    await client.getQuote("hood", "0xabc", { side: "buy", amountIn: "5000000000000000000", slippageBps: 75 })
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/markets/hood/0xabc/quote?side=buy&amountIn=5000000000000000000&slippageBps=75",
      method: "GET",
      headers: {},
    })
  })

  test("getQuote omits slippageBps when not provided (server default applies)", async () => {
    const { client, calls } = makeClient({}, [json(200, { success: true })])
    await client.getQuote("solana", "Mint111", { side: "sell", amountIn: "1000" })
    expect(calls[0]?.url).toBe("https://api.test/api/v1/markets/solana/Mint111/quote?side=sell&amountIn=1000")
  })

  test("getFeed: GET /api/v1/markets/feed with bucket, optional chain", async () => {
    const { client, calls } = makeClient({}, [
      json(200, { success: true, bucket: "new", tokens: [] }),
      json(200, { success: true, bucket: "onfire", tokens: [] }),
    ])
    await client.getFeed("new")
    await client.getFeed("onfire", "hood")
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/markets/feed?bucket=new", method: "GET", headers: {} })
    expect(calls[1]?.url).toBe("https://api.test/api/v1/markets/feed?bucket=onfire&chain=hood")
  })

  test("verify: GET /api/v1/verify/:chain/:mint returns the whole body", async () => {
    const body = { success: true, candleLaunched: false, chain: "solana", mint: "Mint111" }
    const { client, calls } = makeClient({}, [json(200, body)])
    const result = await client.verify("solana", "Mint111")
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/verify/solana/Mint111", method: "GET", headers: {} })
    expect(result).toEqual(body as never)
  })

  test("reportActivity: POST /api/v1/activity/report with key and { chain, signature }", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, { payload: { logged: true } })])
    await client.reportActivity("solana", "Sig111")
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/activity/report",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ chain: "solana", signature: "Sig111" }),
    })
  })

  test("getAgentProfile: GET /api/v1/users/:idOrWallet/agent, unwraps the agent", async () => {
    const agent = { enabled: true, address: "So1", username: "drew", launches: 3, launchesViaApi: 2 }
    const { client, calls } = makeClient({}, [json(200, { success: true, agent })])
    const result = await client.getAgentProfile("drew")
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/users/drew/agent", method: "GET", headers: {} })
    expect(result).toEqual(agent)
  })

  test("getAgentTier: GET /api/v1/agent/tier with the agent key header, returns the parsed payload", async () => {
    const payload: AgentTierInfo = {
      success: true,
      tier: "pro",
      liveTier: "pro",
      stakedCndl: 600_000,
      heldCndl: 0,
      thresholds: { minStakedCndl: 500_000, minHeldCndl: 1_000_000, graceMs: 172_800_000 },
      grace: { active: false, startedAt: null },
      maxTierExpiresAt: null,
      feeBps: 50,
      feeTotals: [{ chain: "solana", quoteAsset: "sol", feeRawSum: "9007199254740993", count: 3 }],
    }
    const { client, calls } = makeClient(KEYED, [json(200, payload)])
    const result = await client.getAgentTier()
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/agent/tier",
      method: "GET",
      headers: { "x-api-key": "cndl_test_key" },
    })
    expect(result).toEqual(payload)
  })

  test("getAgentTier: no auth header without a key (dual auth, session leg is the dashboard's job)", async () => {
    const payload = {
      success: true,
      tier: "free",
      liveTier: "free",
      stakedCndl: 0,
      heldCndl: 0,
      thresholds: { minStakedCndl: 500_000, minHeldCndl: 1_000_000, graceMs: 172_800_000 },
      grace: { active: false, startedAt: null },
      maxTierExpiresAt: null,
      feeBps: 100,
      feeTotals: [],
    }
    const { client, calls } = makeClient({}, [json(200, payload)])
    await client.getAgentTier()
    expect(calls[0]).toEqual({ url: "https://api.test/api/v1/agent/tier", method: "GET", headers: {} })
  })

  test("listWallets: GET /api/v1/agent/wallets with the agent key header, no query param by default", async () => {
    const body: ListWalletsResult = {
      success: true,
      page: [{ _id: "row-1", chain: "solana", address: "SoLWallet1", addedVia: "session" }],
      isDone: true,
      continueCursor: null,
    }
    const { client, calls } = makeClient(KEYED, [json(200, body)])
    const result = await client.listWallets()
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/agent/wallets",
      method: "GET",
      headers: { "x-api-key": "cndl_test_key" },
    })
    expect(result).toEqual(body)
  })

  test("listWallets: includeRevoked: false is the same as omitting it (no query param)", async () => {
    const body: ListWalletsResult = { success: true, page: [], isDone: true, continueCursor: null }
    const { client, calls } = makeClient(KEYED, [json(200, body)])
    await client.listWallets({ includeRevoked: false })
    expect(calls[0]?.url).toBe("https://api.test/api/v1/agent/wallets")
  })

  test("listWallets: includeRevoked: true appends ?includeRevoked=true", async () => {
    const body: ListWalletsResult = {
      success: true,
      page: [
        { _id: "row-1", chain: "solana", address: "SoLWallet1", addedVia: "session" },
        { _id: "row-2", chain: "evm", address: "0xAbC", addedVia: "agent", revokedAt: 1_700_000_000_000 },
      ],
      isDone: true,
      continueCursor: null,
    }
    const { client, calls } = makeClient(KEYED, [json(200, body)])
    const result = await client.listWallets({ includeRevoked: true })
    expect(calls[0]?.url).toBe("https://api.test/api/v1/agent/wallets?includeRevoked=true")
    expect(result).toEqual(body)
  })

  test("getSpendLimits: GET /api/v1/agent/keys/self/limits with the agent key header, returns the parsed shape", async () => {
    const payload: SpendLimitsResult = {
      success: true,
      keyLimits: [{ asset: "sol", maxPerTxRaw: "1000000000" }],
      accountLimits: {
        main: [{ asset: "sol", maxPerTxRaw: "5000000000" }],
        linked: null,
      },
    }
    const { client, calls } = makeClient(KEYED, [json(200, payload)])
    const result = await client.getSpendLimits()
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/agent/keys/self/limits",
      method: "GET",
      headers: { "x-api-key": "cndl_test_key" },
    })
    expect(result).toEqual(payload)
  })

  test("getSpendLimits: a key with no per-key caps returns keyLimits: null with the account fallback present", async () => {
    const payload: SpendLimitsResult = {
      success: true,
      keyLimits: null,
      accountLimits: { main: null, linked: [{ asset: "usdc", maxPerTxRaw: "1000000" }] },
    }
    const { client } = makeClient(KEYED, [json(200, payload)])
    const result = await client.getSpendLimits()
    expect(result).toEqual(payload)
  })

  test("swap: POST /api/v1/agent/swap with the key, unwrapping payload", async () => {
    const payload = {
      hashes: ["sig1"],
      expectedOutRaw: "990000",
      outDecimals: 6,
      statusChecks: [],
    }
    const { client, calls } = makeClient(KEYED, [json(200, { success: true, payload })])
    const result = await client.swap({ from: "SOL", to: "USDC", amountRaw: "1000000000" })
    expect(calls[0]?.url).toBe("https://api.test/api/v1/agent/swap")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ from: "SOL", to: "USDC", amountRaw: "1000000000" })
    // The useful object, not the envelope: same stance as getMarket/getAgentProfile.
    expect(result).toEqual(payload)
  })

  test("swap: a cross-chain fill reports every leg's hash and its status URLs", async () => {
    const payload = {
      hashes: ["solanaSig", "0xhoodTx"],
      expectedOutRaw: "5000000",
      outDecimals: 6,
      venueCostUsd: 0.42,
      statusChecks: ["https://relay.link/status/abc"],
    }
    const { client, calls } = makeClient(KEYED, [json(200, { success: true, payload })])
    const result = await client.swap({
      from: "SOL",
      to: "USDG",
      amountRaw: "2000000000",
      maxSlippageBps: 50,
      clientSwapId: "fund-hood-1",
    })
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      from: "SOL",
      to: "USDG",
      amountRaw: "2000000000",
      maxSlippageBps: 50,
      clientSwapId: "fund-hood-1",
    })
    expect(result.hashes).toEqual(["solanaSig", "0xhoodTx"])
    expect(result.statusChecks).toEqual(["https://relay.link/status/abc"])
    expect(result.venueCostUsd).toBe(0.42)
  })

  test("swap: never retries, so a funding call that already landed is not repeated", async () => {
    // launch() retries on a 5xx; swap() must not, since a second execution moves the funds twice.
    const { client, calls } = makeClient(KEYED, [json(500, { success: false, error: { code: "INTERNAL" } })])
    await expect(client.swap({ from: "SOL", to: "USDC", amountRaw: "1" })).rejects.toBeInstanceOf(CandleApiError)
    expect(calls).toHaveLength(1)
  })

  test("uploadImage: POST raw bytes with the caller's content-type and the key", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const { client, calls } = makeClient(KEYED, [json(200, { success: true, imageUrl: "https://gateway/img.png" })])
    const result = await client.uploadImage(bytes, "image/png")
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/uploads/agent-image",
      method: "POST",
      headers: { "content-type": "image/png", "x-api-key": "cndl_test_key" },
      body: bytes,
    })
    expect(result).toEqual({ imageUrl: "https://gateway/img.png" })
  })

  test("buildSelfLaunch (Solana): POST /api/v1/launch/self/build with key, returns unsigned transaction", async () => {
    const result = {
      success: true,
      transaction: "AQADABc5...",
      mint: "Mint111",
      pool: "Pool111",
      clientLaunchId: "run-1",
      expiresAt: 1692345678000,
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const buildReq = { ...LAUNCH_REQ, linkedWalletId: "wallet-123" }
    const buildResult = await client.buildSelfLaunch(buildReq)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/self/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(buildReq),
    })
    expect(buildResult).toEqual(result as never)
  })

  test("buildSelfLaunch (Hood): POST returns calldata and curve address", async () => {
    const result = {
      success: true,
      transaction: { to: "0xFactory123", data: "0xabcd1234" },
      curveAddress: "0xCurve456",
      clientLaunchId: "run-1",
      expiresAt: 1692345678000,
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const buildReq: BuildSelfLaunchRequest = {
      clientLaunchId: "run-1",
      chain: "hood",
      name: "Trend Coin",
      symbol: "TREND",
      imageUrl: "https://example.com/logo.png",
      dexVersion: "v4",
      linkedWalletId: "wallet-123",
    }
    const buildResult = await client.buildSelfLaunch(buildReq)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/self/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(buildReq),
    })
    expect(buildResult).toEqual(result as never)
  })

  test("confirmSelfLaunch: POST /api/v1/launch/self/confirm with signature", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, LAUNCH_OK)])
    const confirmReq = {
      clientLaunchId: "run-1",
      signature: "5hg7XuJ8ZKm4Y9PqW3nLmZ2oT6vS8xR1nD5kQ9mP7j2K",
    }
    const result = await client.confirmSelfLaunch(confirmReq)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/self/confirm",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(confirmReq),
    })
    expect(result).toEqual(LAUNCH_OK as never)
  })

  test("confirmSelfLaunch with optional devBuySignature", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, LAUNCH_OK)])
    const confirmReq = {
      clientLaunchId: "run-1",
      signature: "0xAbCdEf123456",
      devBuySignature: "0x123456AbCdEf",
    }
    await client.confirmSelfLaunch(confirmReq)
    const sent = JSON.parse(String(calls[0]?.body)) as typeof confirmReq
    expect(sent.devBuySignature).toBe("0x123456AbCdEf")
  })

  test("buildTrade (main payer): POST /api/v1/trade/agent/build, executed inline", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-1",
      chain: "solana",
      signature: "Sig222",
      fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
      amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: BuildTradeRequest = {
      clientTradeId: "trade-1",
      mint: "Mint111",
      side: "buy",
      amountRaw: "1000000",
      payer: { type: "main" },
    }
    const buildResult = await client.buildTrade(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(buildResult).toEqual(result as never)
  })

  test("buildTrade (linked payer, Solana): status built, an unsigned transaction to sign", async () => {
    const result = {
      success: true,
      status: "built",
      clientTradeId: "trade-2",
      chain: "solana",
      artifacts: {
        venue: "curve",
        transactionBase64: "AQADABc5...",
        quoteAsset: "sol",
        quoteMint: "So11111111111111111111111111111111111111112",
        quoteDecimals: 9,
      },
      fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
      expectedOutRaw: "500000",
      minOutRaw: "495000",
      expiresAt: 1692345678000,
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: BuildTradeRequest = {
      clientTradeId: "trade-2",
      mint: "Mint111",
      side: "buy",
      amountRaw: "1000000",
      payer: { type: "linked", linkedWalletId: "wallet-123" },
      maxSlippageBps: 100,
    }
    const buildResult = await client.buildTrade(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(buildResult).toEqual(result as never)
  })

  test("buildTrade (linked payer, Hood): status built, approval + trade + feeTransfer legs", async () => {
    const result = {
      success: true,
      status: "built",
      clientTradeId: "trade-3",
      chain: "hood",
      artifacts: {
        venue: "curve",
        trade: { to: "0xCurve456", data: "0xtrade", value: "0" },
        approval: { to: "0xQuoteToken", data: "0xapprove" },
        feeTransfer: { to: "0xTreasury", data: "0xfee", value: "0" },
        quoteAsset: "usdg",
        quoteDecimals: 18,
      },
      fee: { bps: 100, feeRaw: "3000", treasury: "0xTreasury" },
      expectedOutRaw: "700000",
      minOutRaw: "693000",
      expiresAt: 1692345678000,
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: BuildTradeRequest = {
      clientTradeId: "trade-3",
      mint: "0xMint",
      side: "sell",
      amountRaw: "500000",
      payer: { type: "linked", linkedWalletId: "wallet-456" },
    }
    const buildResult = await client.buildTrade(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(buildResult).toEqual(result as never)
  })

  test("buildTrade forwards quoteAsset when provided (arbitrary-mint trade, Pro/Max)", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-4",
      chain: "solana",
      signature: "Sig444",
      fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
      amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "usdc" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: BuildTradeRequest = {
      clientTradeId: "trade-4",
      mint: "ArbitraryMint111",
      side: "buy",
      amountRaw: "1000000",
      payer: { type: "main" },
      quoteAsset: "usdc",
    }
    await client.buildTrade(req)
    const sent = JSON.parse(String(calls[0]?.body)) as BuildTradeRequest
    expect(sent.quoteAsset).toBe("usdc")
  })

  test("buildTrade omits quoteAsset from the request body when not provided, so the server default applies", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-5",
      chain: "solana",
      signature: "Sig555",
      fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
      amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: BuildTradeRequest = {
      clientTradeId: "trade-5",
      mint: "Mint111",
      side: "buy",
      amountRaw: "1000000",
      payer: { type: "main" },
    }
    await client.buildTrade(req)
    const sent = JSON.parse(String(calls[0]?.body)) as BuildTradeRequest
    expect("quoteAsset" in sent).toBe(false)
  })

  test("confirmTrade (Solana): POST /api/v1/trade/agent/confirm with a signature", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-2",
      chain: "solana",
      signature: "Sig333",
      feeSignature: "Sig333",
      fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
      amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: ConfirmTradeRequest = { clientTradeId: "trade-2", signature: "Sig333" }
    const confirmResult = await client.confirmTrade(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/confirm",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(confirmResult).toEqual(result as never)
  })

  test("confirmTrade (Hood): POST with tradeTxHash and the required feeTxHash", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-3",
      chain: "hood",
      signature: "0xTradeHash",
      feeSignature: "0xFeeHash",
      fee: { bps: 100, feeRaw: "3000", treasury: "0xTreasury" },
      amounts: { amountRaw: "500000", expectedOutRaw: "700000", minOutRaw: "693000", quoteAsset: "usdg" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: ConfirmTradeRequest = { clientTradeId: "trade-3", tradeTxHash: "0xTradeHash", feeTxHash: "0xFeeHash" }
    const confirmResult = await client.confirmTrade(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/confirm",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(confirmResult).toEqual(result as never)
  })

  test("confirmTrade (Hood) without a fee omits feeTxHash from the body", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "trade-4",
      chain: "hood",
      signature: "0xTradeHash2",
      fee: { bps: 0, feeRaw: "0", treasury: null },
      amounts: { amountRaw: "500000", expectedOutRaw: "700000", minOutRaw: "693000", quoteAsset: "usdg" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: ConfirmTradeRequest = { clientTradeId: "trade-4", tradeTxHash: "0xTradeHash2" }
    await client.confirmTrade(req)
    const sent = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>
    expect("feeTxHash" in sent).toBe(false)
  })

  test("submit: POSTs the ordered signed legs to /api/v1/trade/agent/submit", async () => {
    const result = {
      success: true,
      status: "executed",
      clientTradeId: "cid",
      chain: "solana",
      signature: "Sig999",
      feeSignature: "Sig999",
      fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
      amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
    }
    const { client, calls } = makeClient(KEYED, [json(200, result)])
    const req: SubmitTradeRequest = { clientTradeId: "cid", signedTransactions: ["legA", "legB"] }
    const submitResult = await client.submit(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/trade/agent/submit",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(submitResult).toEqual(result as never)
    expect(submitResult.status).toBe("executed")
  })

  test("buildTrade surfaces a structured error (SPEND_LIMIT_EXCEEDED) as CandleApiError", async () => {
    const { client } = makeClient(KEYED, [envelope(400, "SPEND_LIMIT_EXCEEDED", { retryable: false })])
    const error = (await client
      .buildTrade({
        clientTradeId: "trade-5",
        mint: "Mint111",
        side: "buy",
        amountRaw: "1000000",
        payer: { type: "main" },
      })
      .catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("SPEND_LIMIT_EXCEEDED")
  })

  test("confirmTrade surfaces FEE_LEG_MISSING (402) as CandleApiError", async () => {
    const { client } = makeClient(KEYED, [envelope(402, "FEE_LEG_MISSING", { retryable: false })])
    const error = (await client
      .confirmTrade({ clientTradeId: "trade-5", tradeTxHash: "0xabc" })
      .catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("FEE_LEG_MISSING")
    expect(error.status).toBe(402)
  })

  test("public reads attach x-api-key when the client has one", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, { success: true, market: {} })])
    await client.getMarket("solana", "Mint111")
    expect(calls[0]?.headers).toEqual({ "x-api-key": "cndl_test_key" })
  })

  test("a trailing slash on apiUrl does not double up", async () => {
    const { calls, impl } = fakeFetch([json(200, { payload: { matrixVersion: 1, presets: [] } })])
    const client = new CandleClient({ apiUrl: "https://api.test/", fetch: impl })
    await client.getPresets()
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/presets")
  })
})

describe("atomic launch (build/submit request shapes, no linked signing)", () => {
  const ATOMIC_BUILD_REQ: BuildAtomicLaunchRequest = {
    clientLaunchId: "atomic-run-1",
    chain: "solana",
    name: "Atomic Coin",
    symbol: "ATOM",
    imageUrl: "https://example.com/atomic.png",
    payer: { type: "main" },
    firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
  }

  const ATOMIC_BUILD_RESULT_ALL_SERVER = {
    bundleId: "bundle-server-only",
    legs: [
      { index: 0, role: "launch", signer: "server" },
      { index: 1, role: "buy", signer: "server", expectedFill: { amountOutRaw: "500000" } },
    ],
    expiresAt: 1692345678000,
  }

  test("buildAtomicLaunch: POST /api/v1/launch/atomic/build with key and JSON body", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, ATOMIC_BUILD_RESULT_ALL_SERVER)])
    const result = await client.buildAtomicLaunch(ATOMIC_BUILD_REQ)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/atomic/build",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(ATOMIC_BUILD_REQ),
    })
    expect(result).toEqual(ATOMIC_BUILD_RESULT_ALL_SERVER as never)
  })

  test("buildAtomicLaunch generates a sdk- prefixed clientLaunchId when the caller omits one", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, ATOMIC_BUILD_RESULT_ALL_SERVER)])
    const { clientLaunchId: _omitted, ...withoutId } = ATOMIC_BUILD_REQ
    await client.buildAtomicLaunch(withoutId)
    const sent = JSON.parse(String(calls[0]?.body)) as BuildAtomicLaunchRequest
    expect(sent.clientLaunchId).toMatch(/^sdk-/)
  })

  test("submitAtomicLaunch: POSTs bundleId + signedTxsBase64 and returns the landed 200 result untouched", async () => {
    const landed = { status: "landed", bundleId: "bundle-1", mint: "Mint111", signatures: ["Sig0", "Sig1"] }
    const { client, calls } = makeClient(KEYED, [json(200, landed)])
    const req: SubmitAtomicLaunchRequest = { bundleId: "bundle-1", signedTxsBase64: ["legA"] }
    const result = await client.submitAtomicLaunch(req)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/launch/atomic/submit",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    })
    expect(result).toEqual(landed as never)
  })

  test("submitAtomicLaunch: a 502 failed outcome is RETURNED, not thrown", async () => {
    const failed = { status: "failed", bundleId: "bundle-2", retryable: false }
    const { client } = makeClient(KEYED, [json(502, failed)])
    const result = await client.submitAtomicLaunch({ bundleId: "bundle-2", signedTxsBase64: [] })
    expect(result).toEqual(failed as never)
  })

  test("submitAtomicLaunch: a 502 timeout outcome is RETURNED, not thrown, retryable reflects the resolution", async () => {
    const timeoutRetryable = { status: "timeout", bundleId: "bundle-3", retryable: true }
    const { client: client1 } = makeClient(KEYED, [json(502, timeoutRetryable)])
    const result1 = await client1.submitAtomicLaunch({ bundleId: "bundle-3", signedTxsBase64: [] })
    expect(result1).toEqual(timeoutRetryable as never)

    // retryable: false (the "ambiguous" resolution -- see task-4-report.md) is a DIFFERENT value,
    // not a default; both must survive the parse untouched.
    const timeoutNotRetryable = { status: "timeout", bundleId: "bundle-4", retryable: false }
    const { client: client2 } = makeClient(KEYED, [json(502, timeoutNotRetryable)])
    const result2 = await client2.submitAtomicLaunch({ bundleId: "bundle-4", signedTxsBase64: [] })
    expect(result2).toEqual(timeoutNotRetryable as never)
  })

  test("submitAtomicLaunch: every OTHER non-2xx status still throws CandleApiError (structured errorBody codes)", async () => {
    const { client } = makeClient(KEYED, [envelope(404, "JOB_NOT_FOUND", { retryable: false })])
    const error = (await client
      .submitAtomicLaunch({ bundleId: "unknown-bundle", signedTxsBase64: [] })
      .catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("JOB_NOT_FOUND")
    expect(error.status).toBe(404)
  })

  test("submitAtomicLaunch: a genuine non-envelope 502 (not this route's own shape) still throws CandleApiError", async () => {
    const { client } = makeClient(KEYED, [new Response("upstream blew up", { status: 502 })])
    const error = (await client
      .submitAtomicLaunch({ bundleId: "bundle-5", signedTxsBase64: [] })
      .catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("HTTP_502")
  })

  test("submitAtomicLaunch: an unexpected 200 response shape throws instead of being silently trusted", async () => {
    const { client } = makeClient(KEYED, [json(200, { success: true, foo: "bar" })])
    await expect(client.submitAtomicLaunch({ bundleId: "bundle-6", signedTxsBase64: [] })).rejects.toThrow(
      /unexpected 200 response shape/,
    )
  })

  test("submitAtomicLaunch: a malformed 200 'landed' body (missing mint/signatures) is REJECTED by the outcome guard, not silently trusted", async () => {
    const { client } = makeClient(KEYED, [json(200, { status: "landed", bundleId: "bundle-7" })])
    await expect(client.submitAtomicLaunch({ bundleId: "bundle-7", signedTxsBase64: [] })).rejects.toThrow(
      /unexpected 200 response shape/,
    )
  })

  test("submitAtomicLaunch: a malformed 502 body (retryable is not a boolean) is REJECTED by the outcome guard, still throws CandleApiError", async () => {
    const { client } = makeClient(KEYED, [json(502, { status: "timeout", bundleId: "bundle-8", retryable: "yes" })])
    const error = (await client
      .submitAtomicLaunch({ bundleId: "bundle-8", signedTxsBase64: [] })
      .catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("HTTP_502")
  })

  test("buildAtomicLaunch surfaces a structured error (TIER_REQUIRED) as CandleApiError", async () => {
    const { client } = makeClient(KEYED, [envelope(403, "TIER_REQUIRED", { retryable: false })])
    const error = (await client.buildAtomicLaunch(ATOMIC_BUILD_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("TIER_REQUIRED")
  })

  test("buildAtomicLaunch surfaces KEY_LIMIT_REACHED (403, with resetsAt) as CandleApiError", async () => {
    const { client } = makeClient(KEYED, [
      json(403, {
        success: false,
        error: {
          code: "KEY_LIMIT_REACHED",
          message: "firstBuys[0]: this key's transaction volume cap would be exceeded by this buy",
          retryable: true,
          resetsAt: 1755302400000,
        },
      }),
    ])
    const error = (await client.buildAtomicLaunch(ATOMIC_BUILD_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("KEY_LIMIT_REACHED")
    expect(error.retryable).toBe(true)
  })

  test("launchAtomic(): a server-legs-only bundle (every payer 'main') skips the signing round entirely, no secretStore/privyAppId needed", async () => {
    const landed = { status: "landed", bundleId: "bundle-server-only", mint: "Mint111", signatures: ["Sig0", "Sig1"] }
    // No secretStore, no privyAppId in KEYED -- proves this path never touches either.
    const { client, calls } = makeClient(KEYED, [json(200, ATOMIC_BUILD_RESULT_ALL_SERVER), json(200, landed)])
    const req: LaunchAtomicRequest = {
      ...ATOMIC_BUILD_REQ,
      payer: { type: "main" },
      firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
    }
    const result = await client.launchAtomic(req)
    expect(result).toEqual(landed as never)
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/launch/atomic/build",
      "https://api.test/api/v1/launch/atomic/submit",
    ])
    const submitSent = JSON.parse(String(calls[1]?.body)) as SubmitAtomicLaunchRequest
    expect(submitSent).toEqual({ bundleId: "bundle-server-only", signedTxsBase64: [] })
  })

  test("launchAtomic(): a server-legs-only bundle that fails is returned, not thrown", async () => {
    const failed = { status: "failed", bundleId: "bundle-server-only", retryable: false }
    const { client } = makeClient(KEYED, [json(200, ATOMIC_BUILD_RESULT_ALL_SERVER), json(502, failed)])
    const req: LaunchAtomicRequest = {
      ...ATOMIC_BUILD_REQ,
      payer: { type: "main" },
      firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
    }
    const result = await client.launchAtomic(req)
    expect(result).toEqual(failed as never)
  })

  test("launchAtomic(): a server-legs-only bundle that times out is returned, not thrown", async () => {
    const timedOut = { status: "timeout", bundleId: "bundle-server-only", retryable: true }
    const { client } = makeClient(KEYED, [json(200, ATOMIC_BUILD_RESULT_ALL_SERVER), json(502, timedOut)])
    const req: LaunchAtomicRequest = {
      ...ATOMIC_BUILD_REQ,
      payer: { type: "main" },
      firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
    }
    const result = await client.launchAtomic(req)
    expect(result).toEqual(timedOut as never)
  })
})

describe("linked-wallet signing relay + one-shot flows", () => {
  const PRIVY_APP_ID = "app-test-123"
  const SOLANA_RPC = "https://rpc.test/solana"
  const EVM_RPC = "https://rpc.test/evm"
  const LINKED_WALLET_ID = "wallet-123"
  const PRIVY_WALLET_ID = "privy-wallet-123"
  const SIGN_RELAY_URL = `https://api.test/api/v1/agent/wallets/${LINKED_WALLET_ID}/sign`

  async function keyedSecretStore(): Promise<SecretStore> {
    const store = new InMemorySecretStore()
    const { privateKeyPem } = await generateSignerKeypair()
    await store.set(LINKED_WALLET_ID, privateKeyPem)
    return store
  }

  function solanaRpcOk(result: string): Response {
    return json(200, { jsonrpc: "2.0", id: 1, result })
  }

  /** Same shape as solanaRpcOk, but `result` may be a string (call) or an object/null (callRaw). */
  function evmRpcOk(result: unknown): Response {
    return json(200, { jsonrpc: "2.0", id: 1, result })
  }

  /**
   * The four RPC round trips every Hood one-shot leg-loop makes ONCE up front, before touching any
   * leg: eth_chainId, eth_getTransactionCount("pending") (nonce 5), eth_maxPriorityFeePerGas, and
   * eth_getBlockByNumber("latest") (for the base fee). Order matches fetchChainId -> fetchNonce ->
   * fetchFeeData in client.ts's Hood branches.
   */
  function evmSetupResponses(): Response[] {
    return [
      evmRpcOk("0x2105"), // eth_chainId = 8453
      evmRpcOk("0x5"), // eth_getTransactionCount -> nonce 5
      evmRpcOk("0x3b9aca00"), // eth_maxPriorityFeePerGas = 1 gwei
      evmRpcOk({ baseFeePerGas: "0x77359400" }), // eth_getBlockByNumber -> base fee 2 gwei
    ]
  }

  /** The four calls one signed+broadcast+confirmed EVM leg makes: estimateGas, sign, broadcast, receipt. */
  function evmLegResponses(txHash: string): Response[] {
    return [
      evmRpcOk("0x186a0"), // eth_estimateGas
      json(200, SIGN_RELAY_OK), // POST .../sign
      evmRpcOk(txHash), // eth_sendRawTransaction
      evmRpcOk({ status: "0x1" }), // eth_getTransactionReceipt
    ]
  }

  const BUILD_TRADE_REQ = { mint: "Mint111", side: "buy" as const, amountRaw: "1000000" }

  const SOLANA_BUILT_TRADE = {
    success: true,
    status: "built",
    clientTradeId: "trade-linked-1",
    chain: "solana",
    artifacts: {
      venue: "curve",
      transactionBase64: "AQADABc5unsigned",
      quoteAsset: "sol",
      quoteMint: "So11111111111111111111111111111111111111112",
      quoteDecimals: 9,
    },
    fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
    expectedOutRaw: "500000",
    minOutRaw: "495000",
    expiresAt: 1692345678000,
  }

  const HOOD_WALLET_ADDRESS = "0xLinkedWa11etAddress1"

  const HOOD_BUILT_TRADE = {
    success: true,
    status: "built",
    clientTradeId: "trade-linked-2",
    chain: "hood",
    walletAddress: HOOD_WALLET_ADDRESS,
    artifacts: {
      venue: "curve",
      trade: { to: "0xCurve456", data: "0xtrade", value: "0" },
      quoteAsset: "usdg",
      quoteDecimals: 18,
    },
    fee: { bps: 0, feeRaw: "0", treasury: null },
    expectedOutRaw: "700000",
    minOutRaw: "693000",
    expiresAt: 1692345678000,
  }

  const HOOD_BUILT_TRADE_WITH_APPROVAL = {
    success: true,
    status: "built",
    clientTradeId: "trade-linked-3",
    chain: "hood",
    walletAddress: HOOD_WALLET_ADDRESS,
    artifacts: {
      venue: "curve",
      approval: { to: "0xToken789", data: "0xapprove" },
      trade: { to: "0xCurve456", data: "0xtrade", value: "0" },
      feeTransfer: { to: "0xTreasury1", data: "0xfeetransfer", value: "0" },
      quoteAsset: "usdg",
      quoteDecimals: 18,
    },
    fee: { bps: 100, feeRaw: "7000", treasury: "0xTreasury1" },
    expectedOutRaw: "700000",
    minOutRaw: "693000",
    expiresAt: 1692345678000,
  }

  const SIGN_RELAY_OK = { success: true, signedTransaction: "c2lnbmVkLXR4", encoding: "base64" }

  const CONFIRMED_TRADE = {
    success: true,
    status: "executed",
    clientTradeId: "trade-linked-1",
    chain: "solana",
    signature: "BroadcastSig111",
    feeSignature: "BroadcastSig111",
    fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
    amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
  }

  describe("signLinkedTransaction", () => {
    test("Solana: loads the PEM, computes a signature, and calls the relay with the right body", async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient({ ...KEYED, privyAppId: PRIVY_APP_ID, secretStore: store }, [
        json(200, SIGN_RELAY_OK),
      ])
      const result = await client.signLinkedTransaction({
        linkedWalletId: LINKED_WALLET_ID,
        privyWalletId: PRIVY_WALLET_ID,
        chain: "solana",
        unsignedTransactionBase64: "AQADABc5unsigned",
      })
      expect(result).toEqual({ signedTransaction: "c2lnbmVkLXR4", encoding: "base64" })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(SIGN_RELAY_URL)
      expect(calls[0]?.method).toBe("POST")
      const sent = JSON.parse(String(calls[0]?.body)) as { authorizationSignature: string; body: unknown }
      expect(sent.body).toEqual({
        method: "signTransaction",
        params: { transaction: "AQADABc5unsigned", encoding: "base64" },
      })
      expect(typeof sent.authorizationSignature).toBe("string")
      expect(sent.authorizationSignature.length).toBeGreaterThan(0)
    })

    test("a missing SecretStore key throws a clear error naming the wallet, without calling the relay", async () => {
      const { client, calls } = makeClient(
        { ...KEYED, privyAppId: PRIVY_APP_ID, secretStore: new InMemorySecretStore() },
        [],
      )
      await expect(
        client.signLinkedTransaction({
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
          chain: "solana",
          unsignedTransactionBase64: "AQADABc5unsigned",
        }),
      ).rejects.toThrow(new RegExp(LINKED_WALLET_ID))
      expect(calls).toHaveLength(0)
    })

    test("a missing privyAppId throws a clear error naming the option, without calling the relay or SecretStore", async () => {
      const store = await keyedSecretStore()
      let getCalls = 0
      const spyStore: SecretStore = {
        get: async (ref) => {
          getCalls++
          return store.get(ref)
        },
        set: (ref, pem) => store.set(ref, pem),
        delete: (ref) => store.delete(ref),
      }
      const { client, calls } = makeClient({ ...KEYED, secretStore: spyStore }, [])
      await expect(
        client.signLinkedTransaction({
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
          chain: "solana",
          unsignedTransactionBase64: "AQADABc5unsigned",
        }),
      ).rejects.toThrow(/privyAppId/)
      expect(calls).toHaveLength(0)
      expect(getCalls).toBe(0)
    })

    test("a missing secretStore throws a clear error naming the option", async () => {
      const { client, calls } = makeClient({ ...KEYED, privyAppId: PRIVY_APP_ID }, [])
      await expect(
        client.signLinkedTransaction({
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
          chain: "solana",
          unsignedTransactionBase64: "AQADABc5unsigned",
        }),
      ).rejects.toThrow(/secretStore/)
      expect(calls).toHaveLength(0)
    })

    test('chain "solana" without unsignedTransactionBase64 throws a clear error, without calling the relay', async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient({ ...KEYED, privyAppId: PRIVY_APP_ID, secretStore: store }, [])
      await expect(
        client.signLinkedTransaction({
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
          chain: "solana",
        }),
      ).rejects.toThrow(/unsignedTransactionBase64/)
      expect(calls).toHaveLength(0)
    })

    test('chain "evm" without evmTxParams throws a clear error, without calling the relay', async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient({ ...KEYED, privyAppId: PRIVY_APP_ID, secretStore: store }, [])
      await expect(
        client.signLinkedTransaction({
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
          chain: "evm",
        }),
      ).rejects.toThrow(/evmTxParams/)
      expect(calls).toHaveLength(0)
    })
  })

  describe("broadcastSignedTransaction", () => {
    test("Solana: POSTs sendTransaction to solanaRpcUrl and returns the signature", async () => {
      const { client, calls } = makeClient({ solanaRpcUrl: SOLANA_RPC }, [solanaRpcOk("BroadcastSig111")])
      const signature = await client.broadcastSignedTransaction("solana", "c2lnbmVkLXR4", "base64")
      expect(signature).toBe("BroadcastSig111")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(SOLANA_RPC)
      const sent = JSON.parse(String(calls[0]?.body)) as { method: string; params: unknown[] }
      expect(sent.method).toBe("sendTransaction")
      expect(sent.params).toEqual(["c2lnbmVkLXR4", { encoding: "base64" }])
    })

    test("EVM: POSTs eth_sendRawTransaction to evmRpcUrl and returns the tx hash", async () => {
      const { client, calls } = makeClient({ evmRpcUrl: EVM_RPC }, [
        json(200, { jsonrpc: "2.0", id: 1, result: "0xTxHash" }),
      ])
      const txHash = await client.broadcastSignedTransaction("evm", "0xSignedRlp", "hex")
      expect(txHash).toBe("0xTxHash")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(EVM_RPC)
      const sent = JSON.parse(String(calls[0]?.body)) as { method: string; params: unknown[] }
      expect(sent.method).toBe("eth_sendRawTransaction")
      expect(sent.params).toEqual(["0xSignedRlp"])
    })

    test("throws when solanaRpcUrl is unset", async () => {
      const { client, calls } = makeClient({}, [])
      await expect(client.broadcastSignedTransaction("solana", "c2lnbmVkLXR4", "base64")).rejects.toThrow(
        /solanaRpcUrl/,
      )
      expect(calls).toHaveLength(0)
    })

    test("throws when evmRpcUrl is unset", async () => {
      const { client, calls } = makeClient({}, [])
      await expect(client.broadcastSignedTransaction("evm", "0xSignedRlp", "hex")).rejects.toThrow(/evmRpcUrl/)
      expect(calls).toHaveLength(0)
    })

    test("throws a clear error naming the RPC method when the result is missing", async () => {
      const { client } = makeClient({ solanaRpcUrl: SOLANA_RPC }, [json(200, { jsonrpc: "2.0", id: 1 })])
      await expect(client.broadcastSignedTransaction("solana", "c2lnbmVkLXR4", "base64")).rejects.toThrow(
        /sendTransaction/,
      )
    })

    test("throws a clear error naming the RPC method when the result is non-string", async () => {
      const { client } = makeClient({ evmRpcUrl: EVM_RPC }, [
        json(200, { jsonrpc: "2.0", id: 1, result: { hash: "0xTxHash" } }),
      ])
      await expect(client.broadcastSignedTransaction("evm", "0xSignedRlp", "hex")).rejects.toThrow(
        /eth_sendRawTransaction/,
      )
    })

    test("a JSON-RPC error envelope throws a structured JsonRpcError carrying .code and .data (not a flattened message)", async () => {
      const { client } = makeClient({ solanaRpcUrl: SOLANA_RPC }, [
        json(200, {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32002,
            message: "Transaction simulation failed",
            data: { err: "BlockhashNotFound", logs: ["a", "b"] },
          },
        }),
      ])
      const error = await client.broadcastSignedTransaction("solana", "c2lnbmVkLXR4", "base64").catch((e) => e)
      expect(error).toBeInstanceOf(JsonRpcError)
      const rpcError = error as JsonRpcError
      expect(rpcError.code).toBe(-32002)
      expect(rpcError.data).toEqual({ err: "BlockhashNotFound", logs: ["a", "b"] })
    })

    test("a broadcast JSON-RPC error inlines data.err and the first logs into the thrown message", async () => {
      const { client } = makeClient({ solanaRpcUrl: SOLANA_RPC }, [
        json(200, {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32002,
            message: "Transaction simulation failed: Blockhash not found",
            data: {
              err: "BlockhashNotFound",
              logs: ["Program log: A", "Program log: B", "Program log: C", "Program log: D"],
            },
          },
        }),
      ])
      const error = await client.broadcastSignedTransaction("solana", "c2lnbmVkLXR4", "base64").catch((e) => e)
      expect(error).toBeInstanceOf(JsonRpcError)
      const rpcError = error as JsonRpcError
      expect(rpcError.code).toBe(-32002)
      // the human RPC message is preserved verbatim (isBlockhashExpiry's regex depends on it)
      expect(rpcError.message).toContain("Transaction simulation failed: Blockhash not found")
      // the structured cause is now inlined so the message is self-explaining
      expect(rpcError.message).toContain("BlockhashNotFound")
      expect(rpcError.message).toContain("Program log: A")
      // only the first few logs are inlined, not an unbounded dump
      expect(rpcError.message).not.toContain("Program log: D")
      // structured data is still attached, unchanged
      expect((rpcError.data as { err: string }).err).toBe("BlockhashNotFound")
    })
  })

  describe("trade()", () => {
    test('from: "main" takes the existing inline path and never calls the relay or SecretStore', async () => {
      const executed = {
        success: true,
        status: "executed",
        clientTradeId: "trade-main-1",
        chain: "solana",
        signature: "Sig222",
        fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
        amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
      }
      let getCalls = 0
      const spyStore: SecretStore = {
        get: async () => {
          getCalls++
          return null
        },
        set: async () => {},
        delete: async () => {},
      }
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: spyStore, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
        [json(200, executed)],
      )
      const result = await client.trade({ ...BUILD_TRADE_REQ, from: "main" })
      expect(result).toEqual(executed as never)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://api.test/api/v1/trade/agent/build")
      const sent = JSON.parse(String(calls[0]?.body)) as BuildTradeRequest
      expect(sent.payer).toEqual({ type: "main" })
      expect(getCalls).toBe(0)
    })

    test('from: "main" forwards quoteAsset into the build request when provided', async () => {
      const executed = {
        success: true,
        status: "executed",
        clientTradeId: "trade-main-2",
        chain: "solana",
        signature: "Sig223",
        fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
        amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "cndl" },
      }
      const { client, calls } = makeClient(KEYED, [json(200, executed)])
      const result = await client.trade({ ...BUILD_TRADE_REQ, from: "main", quoteAsset: "cndl" })
      expect(result).toEqual(executed as never)
      const sent = JSON.parse(String(calls[0]?.body)) as BuildTradeRequest
      expect(sent.quoteAsset).toBe("cndl")
    })

    test('from: "main" sends no quoteAsset in the build request when not provided, so the server default applies', async () => {
      const executed = {
        success: true,
        status: "executed",
        clientTradeId: "trade-main-3",
        chain: "solana",
        signature: "Sig224",
        fee: { bps: 50, feeRaw: "1000", treasury: "TreasuryAddr1" },
        amounts: { amountRaw: "1000000", expectedOutRaw: "500000", minOutRaw: "495000", quoteAsset: "sol" },
      }
      const { client, calls } = makeClient(KEYED, [json(200, executed)])
      const result = await client.trade({ ...BUILD_TRADE_REQ, from: "main" })
      expect(result).toEqual(executed as never)
      const sent = JSON.parse(String(calls[0]?.body)) as BuildTradeRequest
      expect("quoteAsset" in sent).toBe(false)
    })

    test("from: linked (Solana) defaults to build -> sign -> submit, needing no solanaRpcUrl, and returns the executed result", async () => {
      const store = await keyedSecretStore()
      // No solanaRpcUrl in these options at all: the default path never reads it.
      const { client, calls } = makeClient({ ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID }, [
        json(200, SOLANA_BUILT_TRADE),
        json(200, SIGN_RELAY_OK),
        json(200, CONFIRMED_TRADE),
      ])
      const result = await client.trade({
        ...BUILD_TRADE_REQ,
        from: { linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
      })
      expect(result).toEqual(CONFIRMED_TRADE as never)
      // build -> sign -> submit, in that order -- no client-side broadcast call at all.
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/trade/agent/build",
        SIGN_RELAY_URL,
        "https://api.test/api/v1/trade/agent/submit",
      ])
      const submitSent = JSON.parse(String(calls[2]?.body)) as SubmitTradeRequest
      expect(submitSent).toEqual({
        clientTradeId: SOLANA_BUILT_TRADE.clientTradeId,
        signedTransactions: [SIGN_RELAY_OK.signedTransaction],
      })
      // The default path does not call confirmTrade -- submit() already broadcasts and confirms.
      expect(calls.some((c) => c.url === "https://api.test/api/v1/trade/agent/confirm")).toBe(false)
    })

    test("lower-level path: explicit buildTrade -> signLinkedTransaction -> broadcastSignedTransaction -> confirmTrade (Solana) is unchanged, the opt-in client-broadcast route", async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
        [
          json(200, SOLANA_BUILT_TRADE),
          json(200, SIGN_RELAY_OK),
          solanaRpcOk("BroadcastSig111"),
          json(200, CONFIRMED_TRADE),
        ],
      )
      const built = await client.buildTrade({
        clientTradeId: SOLANA_BUILT_TRADE.clientTradeId,
        mint: "Mint111",
        side: "buy",
        amountRaw: "1000000",
        payer: { type: "linked", linkedWalletId: LINKED_WALLET_ID },
      })
      if (built.status !== "built" || built.chain !== "solana") {
        throw new Error("expected a built Solana trade")
      }
      const signed = await client.signLinkedTransaction({
        linkedWalletId: LINKED_WALLET_ID,
        privyWalletId: PRIVY_WALLET_ID,
        chain: "solana",
        unsignedTransactionBase64: built.artifacts.transactionBase64,
      })
      const signature = await client.broadcastSignedTransaction("solana", signed.signedTransaction, signed.encoding)
      const confirmed = await client.confirmTrade({ clientTradeId: built.clientTradeId, signature })
      expect(confirmed).toEqual(CONFIRMED_TRADE as never)
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/trade/agent/build",
        SIGN_RELAY_URL,
        SOLANA_RPC,
        "https://api.test/api/v1/trade/agent/confirm",
      ])
      const confirmSent = JSON.parse(String(calls[3]?.body)) as ConfirmTradeRequest
      expect(confirmSent).toEqual({ clientTradeId: SOLANA_BUILT_TRADE.clientTradeId, signature: "BroadcastSig111" })
    })

    test("from: linked (Hood) with an approval leg runs approval -> trade -> feeTransfer in order, sequential nonces, a receipt awaited between legs, and confirms with tradeTxHash + feeTxHash", async () => {
      const store = await keyedSecretStore()
      const confirmed = {
        success: true,
        status: "executed",
        clientTradeId: HOOD_BUILT_TRADE_WITH_APPROVAL.clientTradeId,
        chain: "hood",
        signature: "0xTradeTxHash",
        feeSignature: "0xFeeTxHash",
        fee: HOOD_BUILT_TRADE_WITH_APPROVAL.fee,
        amounts: { amountRaw: "500000", expectedOutRaw: "700000", minOutRaw: "693000", quoteAsset: "usdg" },
      }
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, evmRpcUrl: EVM_RPC },
        [
          json(200, HOOD_BUILT_TRADE_WITH_APPROVAL), // build
          ...evmSetupResponses(), // chainId, nonce, feeData
          ...evmLegResponses("0xApprovalTxHash"), // leg 0: approval
          ...evmLegResponses("0xTradeTxHash"), // leg 1: trade
          ...evmLegResponses("0xFeeTxHash"), // leg 2: feeTransfer
          json(200, confirmed), // confirm
        ],
      )
      const result = await client.trade({
        mint: "0xMint",
        side: "buy",
        amountRaw: "500000",
        from: { linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
      })
      expect(result).toEqual(confirmed as never)

      const signCalls = calls.filter((c) => c.url === SIGN_RELAY_URL)
      expect(signCalls).toHaveLength(3)
      const transactions = signCalls.map(
        (c) =>
          (JSON.parse(String(c.body)) as { body: { params: { transaction: EvmSignTransactionParams } } }).body.params
            .transaction,
      )
      // Sequential nonces N, N+1, N+2 off the fetched base nonce (5), in leg order.
      expect(transactions.map((tx) => tx.nonce)).toEqual([5, 6, 7])
      // The approval leg hits the token contract; the trade and feeTransfer legs hit curve/treasury.
      expect(transactions.map((tx) => tx.to)).toEqual(["0xToken789", "0xCurve456", "0xTreasury1"])
      for (const tx of transactions) {
        expect(tx.type).toBe(2)
        expect(typeof tx.nonce).toBe("number")
        expect(typeof tx.chain_id).toBe("number")
        expect(tx.chain_id).toBe(8453)
        expect(tx.value.startsWith("0x")).toBe(true)
        expect(tx.gas_limit.startsWith("0x")).toBe(true)
        expect(tx.max_fee_per_gas.startsWith("0x")).toBe(true)
        expect(tx.max_priority_fee_per_gas.startsWith("0x")).toBe(true)
      }

      // Each leg's receipt (eth_getTransactionReceipt) is awaited before the next leg's
      // eth_estimateGas: the full ordered call list is build, 4 setup calls, then 4 calls per leg
      // (estimateGas, sign, broadcast, receipt) x3, then confirm -- never all three legs' RPC
      // calls fired together.
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/trade/agent/build",
        EVM_RPC, // eth_chainId
        EVM_RPC, // eth_getTransactionCount
        EVM_RPC, // eth_maxPriorityFeePerGas
        EVM_RPC, // eth_getBlockByNumber
        EVM_RPC, // approval: eth_estimateGas
        SIGN_RELAY_URL,
        EVM_RPC, // approval: eth_sendRawTransaction
        EVM_RPC, // approval: eth_getTransactionReceipt
        EVM_RPC, // trade: eth_estimateGas
        SIGN_RELAY_URL,
        EVM_RPC, // trade: eth_sendRawTransaction
        EVM_RPC, // trade: eth_getTransactionReceipt
        EVM_RPC, // feeTransfer: eth_estimateGas
        SIGN_RELAY_URL,
        EVM_RPC, // feeTransfer: eth_sendRawTransaction
        EVM_RPC, // feeTransfer: eth_getTransactionReceipt
        "https://api.test/api/v1/trade/agent/confirm",
      ])

      const confirmCall = calls[calls.length - 1]
      const confirmSent = JSON.parse(String(confirmCall?.body)) as ConfirmTradeRequest
      expect(confirmSent).toEqual({
        clientTradeId: HOOD_BUILT_TRADE_WITH_APPROVAL.clientTradeId,
        tradeTxHash: "0xTradeTxHash",
        feeTxHash: "0xFeeTxHash",
      })
    })

    test("from: linked (Hood) with no approval and no fee leg confirms with just tradeTxHash", async () => {
      const store = await keyedSecretStore()
      const confirmed = {
        success: true,
        status: "executed",
        clientTradeId: HOOD_BUILT_TRADE.clientTradeId,
        chain: "hood",
        signature: "0xTradeTxHash",
        fee: HOOD_BUILT_TRADE.fee,
        amounts: { amountRaw: "500000", expectedOutRaw: "700000", minOutRaw: "693000", quoteAsset: "usdg" },
      }
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, evmRpcUrl: EVM_RPC },
        [
          json(200, HOOD_BUILT_TRADE),
          ...evmSetupResponses(),
          ...evmLegResponses("0xTradeTxHash"),
          json(200, confirmed),
        ],
      )
      const result = await client.trade({
        mint: "0xMint",
        side: "sell",
        amountRaw: "500000",
        from: { linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
      })
      expect(result).toEqual(confirmed as never)

      const confirmCall = calls[calls.length - 1]
      const confirmSent = JSON.parse(String(confirmCall?.body)) as ConfirmTradeRequest
      expect(confirmSent).toEqual({ clientTradeId: HOOD_BUILT_TRADE.clientTradeId, tradeTxHash: "0xTradeTxHash" })
      expect("feeTxHash" in confirmSent).toBe(false)

      // build, 4 setup calls, 4 leg calls, confirm -- nothing extra (no approval, no fee leg).
      expect(calls).toHaveLength(10)
    })

    test("from: linked (Hood) throws a clear error naming evmRpcUrl when unset, before any signing", async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient({ ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID }, [
        json(200, HOOD_BUILT_TRADE),
      ])
      await expect(
        client.trade({
          mint: "0xMint",
          side: "sell",
          amountRaw: "500000",
          from: { linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
        }),
      ).rejects.toThrow(/evmRpcUrl/)
      // Only the build call happened -- no chain id / nonce / fee reads, no sign relay call.
      expect(calls).toHaveLength(1)
    })
  })

  describe("selfLaunch()", () => {
    const BUILD_SELF_LAUNCH_SOLANA = {
      success: true,
      transaction: "AQADABc5unsignedlaunch",
      mint: "Mint111",
      pool: "Pool111",
      clientLaunchId: "run-linked-1",
      expiresAt: 1692345678000,
    }
    const BUILD_SELF_LAUNCH_HOOD = {
      success: true,
      transaction: { to: "0xFactory123", data: "0xabcd1234" },
      curveAddress: "0xCurve456",
      clientLaunchId: "run-linked-2",
      walletAddress: HOOD_WALLET_ADDRESS,
      expiresAt: 1692345678000,
    }

    const BUILD_SELF_LAUNCH_HOOD_WITH_FEE = {
      success: true,
      transaction: { to: "0xFactory123", data: "0xabcd1234" },
      curveAddress: "0xCurve456",
      clientLaunchId: "run-linked-3",
      walletAddress: HOOD_WALLET_ADDRESS,
      feeTransfer: { to: "0xTreasury1", data: "0xfeetransfer", value: "0" },
      fee: { bps: 100, feeRaw: "7000", treasury: "0xTreasury1" },
      expiresAt: 1692345678000,
    }

    test("Solana: runs build -> sign -> broadcast -> confirm in order and returns the confirmed launch", async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
        [
          json(200, BUILD_SELF_LAUNCH_SOLANA),
          json(200, SIGN_RELAY_OK),
          solanaRpcOk("BroadcastSig222"),
          json(200, LAUNCH_OK),
        ],
      )
      const result = await client.selfLaunch({
        ...LAUNCH_REQ,
        clientLaunchId: "run-linked-1",
        linkedWalletId: LINKED_WALLET_ID,
        privyWalletId: PRIVY_WALLET_ID,
      })
      expect(result).toEqual(LAUNCH_OK as never)
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/launch/self/build",
        SIGN_RELAY_URL,
        SOLANA_RPC,
        "https://api.test/api/v1/launch/self/confirm",
      ])
      const confirmSent = JSON.parse(String(calls[3]?.body)) as { clientLaunchId: string; signature: string }
      expect(confirmSent).toEqual({ clientLaunchId: "run-linked-1", signature: "BroadcastSig222" })
    })

    test("Hood: signs and broadcasts the createCurve tx (no approval leg, no dev buy) and confirms with { clientLaunchId, signature }", async () => {
      const store = await keyedSecretStore()
      const confirmed = { ...LAUNCH_OK, chain: "hood", signature: "0xCreateCurveTxHash" }
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, evmRpcUrl: EVM_RPC },
        [
          json(200, BUILD_SELF_LAUNCH_HOOD), // build
          ...evmSetupResponses(), // chainId, nonce, feeData
          ...evmLegResponses("0xCreateCurveTxHash"), // the single createCurve leg
          json(200, confirmed), // confirm
        ],
      )
      const result = await client.selfLaunch({
        ...LAUNCH_REQ,
        chain: "hood",
        clientLaunchId: "run-linked-2",
        linkedWalletId: LINKED_WALLET_ID,
        privyWalletId: PRIVY_WALLET_ID,
      })
      expect(result).toEqual(confirmed as never)
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/launch/self/build",
        EVM_RPC, // eth_chainId
        EVM_RPC, // eth_getTransactionCount
        EVM_RPC, // eth_maxPriorityFeePerGas
        EVM_RPC, // eth_getBlockByNumber
        EVM_RPC, // eth_estimateGas
        SIGN_RELAY_URL,
        EVM_RPC, // eth_sendRawTransaction
        EVM_RPC, // eth_getTransactionReceipt
        "https://api.test/api/v1/launch/self/confirm",
      ])
      const signCall = calls.find((c) => c.url === SIGN_RELAY_URL)
      const tx = (JSON.parse(String(signCall?.body)) as { body: { params: { transaction: EvmSignTransactionParams } } })
        .body.params.transaction
      expect(tx.to).toBe("0xFactory123")
      expect(tx.nonce).toBe(5)
      expect(tx.type).toBe(2)

      const confirmCall = calls[calls.length - 1]
      const confirmSent = JSON.parse(String(confirmCall?.body)) as ConfirmSelfLaunchRequest
      expect(confirmSent).toEqual({ clientLaunchId: "run-linked-2", signature: "0xCreateCurveTxHash" })
      expect("feeTxHash" in confirmSent).toBe(false)
    })

    test("Hood: does the fee-transfer leg when present (nonce+1) and confirms with feeTxHash", async () => {
      const store = await keyedSecretStore()
      const confirmed = { ...LAUNCH_OK, chain: "hood", signature: "0xCreateCurveTxHash" }
      const { client, calls } = makeClient(
        { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, evmRpcUrl: EVM_RPC },
        [
          json(200, BUILD_SELF_LAUNCH_HOOD_WITH_FEE),
          ...evmSetupResponses(),
          ...evmLegResponses("0xCreateCurveTxHash"), // createCurve leg
          ...evmLegResponses("0xFeeTxHash"), // fee-transfer leg
          json(200, confirmed),
        ],
      )
      const result = await client.selfLaunch({
        ...LAUNCH_REQ,
        chain: "hood",
        clientLaunchId: "run-linked-3",
        linkedWalletId: LINKED_WALLET_ID,
        privyWalletId: PRIVY_WALLET_ID,
      })
      expect(result).toEqual(confirmed as never)

      const signCalls = calls.filter((c) => c.url === SIGN_RELAY_URL)
      const transactions = signCalls.map(
        (c) =>
          (JSON.parse(String(c.body)) as { body: { params: { transaction: EvmSignTransactionParams } } }).body.params
            .transaction,
      )
      expect(transactions.map((tx) => tx.nonce)).toEqual([5, 6])
      expect(transactions.map((tx) => tx.to)).toEqual(["0xFactory123", "0xTreasury1"])

      const confirmCall = calls[calls.length - 1]
      const confirmSent = JSON.parse(String(confirmCall?.body)) as ConfirmSelfLaunchRequest
      expect(confirmSent).toEqual({
        clientLaunchId: "run-linked-3",
        signature: "0xCreateCurveTxHash",
        feeTxHash: "0xFeeTxHash",
      })
    })

    test("Hood: throws a clear error naming evmRpcUrl when unset, before any signing", async () => {
      const store = await keyedSecretStore()
      const { client, calls } = makeClient({ ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID }, [
        json(200, BUILD_SELF_LAUNCH_HOOD),
      ])
      await expect(
        client.selfLaunch({
          ...LAUNCH_REQ,
          chain: "hood",
          clientLaunchId: "run-linked-2",
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
        }),
      ).rejects.toThrow(/evmRpcUrl/)
      expect(calls).toHaveLength(1)
    })

    describe("Solana blockhash-expiry rebuild", () => {
      function blockhashNotFoundError(): Response {
        return json(200, {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32002,
            message: "Transaction simulation failed",
            data: { err: "BlockhashNotFound", logs: [] },
          },
        })
      }

      test("rebuilds once (same clientLaunchId) after a blockhash-expiry broadcast failure, re-signs, rebroadcasts, and confirms with the SECOND signature", async () => {
        const store = await keyedSecretStore()
        const rebuiltLaunch = { ...BUILD_SELF_LAUNCH_SOLANA, transaction: "AQADABc5rebuiltunsignedlaunch" }
        const confirmedSecondAttempt = { ...LAUNCH_OK, signature: "BroadcastSig333" }
        const { client, calls } = makeClient(
          { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
          [
            json(200, BUILD_SELF_LAUNCH_SOLANA), // build #1
            json(200, SIGN_RELAY_OK), // sign #1
            blockhashNotFoundError(), // broadcast #1 fails: BlockhashNotFound
            json(200, rebuiltLaunch), // build #2 (rebuild, same clientLaunchId)
            json(200, SIGN_RELAY_OK), // sign #2 (the rebuilt tx)
            solanaRpcOk("BroadcastSig333"), // broadcast #2 succeeds
            json(200, confirmedSecondAttempt), // confirm with the SECOND signature
          ],
        )
        const result = await client.selfLaunch({
          ...LAUNCH_REQ,
          clientLaunchId: "run-linked-1",
          linkedWalletId: LINKED_WALLET_ID,
          privyWalletId: PRIVY_WALLET_ID,
        })
        expect(result).toEqual(confirmedSecondAttempt as never)

        const buildCalls = calls.filter((c) => c.url === "https://api.test/api/v1/launch/self/build")
        expect(buildCalls).toHaveLength(2)
        const buildBodies = buildCalls.map((c) => JSON.parse(String(c.body)) as BuildSelfLaunchRequest)
        expect(buildBodies[0]?.clientLaunchId).toBe(buildBodies[1]?.clientLaunchId)

        const signCalls = calls.filter((c) => c.url === SIGN_RELAY_URL)
        expect(signCalls).toHaveLength(2)
        const signedTransactions = signCalls.map(
          (c) => (JSON.parse(String(c.body)) as { body: { params: { transaction: string } } }).body.params.transaction,
        )
        expect(signedTransactions).toEqual(["AQADABc5unsignedlaunch", "AQADABc5rebuiltunsignedlaunch"])

        expect(calls.filter((c) => c.url === SOLANA_RPC)).toHaveLength(2)

        const confirmCall = calls[calls.length - 1]
        const confirmSent = JSON.parse(String(confirmCall?.body)) as { clientLaunchId: string; signature: string }
        expect(confirmSent).toEqual({ clientLaunchId: "run-linked-1", signature: "BroadcastSig333" })
      })

      test("a non-blockhash broadcast error throws immediately with NO rebuild", async () => {
        const store = await keyedSecretStore()
        const { client, calls } = makeClient(
          { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
          [
            json(200, BUILD_SELF_LAUNCH_SOLANA), // build
            json(200, SIGN_RELAY_OK), // sign
            json(200, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal JSON-RPC error" } }),
          ],
        )
        const error = await client
          .selfLaunch({
            ...LAUNCH_REQ,
            clientLaunchId: "run-linked-1",
            linkedWalletId: LINKED_WALLET_ID,
            privyWalletId: PRIVY_WALLET_ID,
          })
          .catch((e) => e)
        expect(error).toBeInstanceOf(JsonRpcError)
        expect((error as JsonRpcError).code).toBe(-32603)
        expect(calls.filter((c) => c.url === "https://api.test/api/v1/launch/self/build")).toHaveLength(1)
        expect(calls.some((c) => c.url === "https://api.test/api/v1/launch/self/confirm")).toBe(false)
      })

      test("exhausting every rebuild throws the last JsonRpcError after exactly MAX_BLOCKHASH_REBUILDS + 1 (3) broadcast attempts", async () => {
        const store = await keyedSecretStore()
        const { client, calls } = makeClient(
          { ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID, solanaRpcUrl: SOLANA_RPC },
          [
            json(200, BUILD_SELF_LAUNCH_SOLANA), // build #1
            json(200, SIGN_RELAY_OK), // sign #1
            blockhashNotFoundError(), // broadcast #1 fails
            json(200, BUILD_SELF_LAUNCH_SOLANA), // build #2 (rebuild)
            json(200, SIGN_RELAY_OK), // sign #2
            blockhashNotFoundError(), // broadcast #2 fails
            json(200, BUILD_SELF_LAUNCH_SOLANA), // build #3 (rebuild)
            json(200, SIGN_RELAY_OK), // sign #3
            blockhashNotFoundError(), // broadcast #3 fails -- attempts exhausted, throw
          ],
        )
        const error = await client
          .selfLaunch({
            ...LAUNCH_REQ,
            clientLaunchId: "run-linked-1",
            linkedWalletId: LINKED_WALLET_ID,
            privyWalletId: PRIVY_WALLET_ID,
          })
          .catch((e) => e)
        expect(error).toBeInstanceOf(JsonRpcError)
        const err = error as JsonRpcError
        expect(err.code).toBe(-32002) // structured cause preserved through the hint wrapper
        expect(err.data).toEqual({ err: "BlockhashNotFound", logs: [] })
        expect(err.message).toContain("lagging or rate-limited")
        expect(err.message).toContain("Helius")
        expect(calls.filter((c) => c.url === "https://api.test/api/v1/launch/self/build")).toHaveLength(3)
        expect(calls.filter((c) => c.url === SOLANA_RPC)).toHaveLength(3)
        expect(calls.some((c) => c.url === "https://api.test/api/v1/launch/self/confirm")).toBe(false)
      })
    })
  })

  describe("launchAtomic() (mixed signer legs)", () => {
    const ATOMIC_LINKED_WALLET_ID_2 = "wallet-456"
    const ATOMIC_PRIVY_WALLET_ID_2 = "privy-wallet-456"
    const ATOMIC_SIGN_RELAY_URL_2 = `https://api.test/api/v1/agent/wallets/${ATOMIC_LINKED_WALLET_ID_2}/sign`

    /** A secretStore holding BOTH linked wallets' signer PEMs, so a bundle mixing two different linked payers can sign each leg. */
    async function twoWalletSecretStore(): Promise<SecretStore> {
      const store = new InMemorySecretStore()
      const { privateKeyPem: pem1 } = await generateSignerKeypair()
      const { privateKeyPem: pem2 } = await generateSignerKeypair()
      await store.set(LINKED_WALLET_ID, pem1)
      await store.set(ATOMIC_LINKED_WALLET_ID_2, pem2)
      return store
    }

    const ATOMIC_LAUNCH_REQ_BASE = {
      clientLaunchId: "atomic-run-linked-1",
      chain: "solana" as const,
      name: "Atomic Coin",
      symbol: "ATOM",
      imageUrl: "https://example.com/atomic.png",
    }

    /** Leg 0 (launch): client signer, LINKED_WALLET_ID. Leg 1 (buy): server signer (main payer), no unsignedTxBase64. Leg 2 (buy): client signer, the SECOND linked wallet, non-zero index -- Task 4's own review flagged this exact case (a client leg NOT at index 0). */
    const ATOMIC_BUILT_MIXED = {
      bundleId: "bundle-mixed-1",
      legs: [
        { index: 0, role: "launch", signer: "client", unsignedTxBase64: "unsigned-launch" },
        { index: 1, role: "buy", signer: "server", expectedFill: { amountOutRaw: "500000" } },
        {
          index: 2,
          role: "buy",
          signer: "client",
          unsignedTxBase64: "unsigned-buy-2",
          expectedFill: { amountOutRaw: "480000" },
        },
      ],
      expiresAt: 1692345678000,
    }

    test("signs every client leg in leg order and submits EXACTLY those, in order (server leg is skipped, not padded)", async () => {
      const store = await twoWalletSecretStore()
      const landed = {
        status: "landed",
        bundleId: "bundle-mixed-1",
        mint: "Mint111",
        signatures: ["SigLaunch", "SigBuy1", "SigBuy2"],
      }
      const { client, calls } = makeClient({ ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID }, [
        json(200, ATOMIC_BUILT_MIXED),
        json(200, { success: true, signedTransaction: "signed-launch-tx", encoding: "base64" }),
        json(200, { success: true, signedTransaction: "signed-buy-2-tx", encoding: "base64" }),
        json(200, landed),
      ])
      const req: LaunchAtomicRequest = {
        ...ATOMIC_LAUNCH_REQ_BASE,
        payer: { type: "linked", linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
        firstBuys: [
          { payer: { type: "main" }, amountRaw: "1000000" },
          {
            payer: {
              type: "linked",
              linkedWalletId: ATOMIC_LINKED_WALLET_ID_2,
              privyWalletId: ATOMIC_PRIVY_WALLET_ID_2,
            },
            amountRaw: "2000000",
          },
        ],
      }
      const result = await client.launchAtomic(req)
      expect(result).toEqual(landed as never)

      // build -> sign leg 0 (LINKED_WALLET_ID) -> sign leg 2 (the SECOND wallet) -> submit, in that
      // exact order; no call at all for leg 1 (the server/main-payer leg).
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.test/api/v1/launch/atomic/build",
        SIGN_RELAY_URL,
        ATOMIC_SIGN_RELAY_URL_2,
        "https://api.test/api/v1/launch/atomic/submit",
      ])

      const buildSent = JSON.parse(String(calls[0]?.body)) as BuildAtomicLaunchRequest
      expect(buildSent.payer).toEqual({ type: "linked", linkedWalletId: LINKED_WALLET_ID })
      expect(buildSent.firstBuys).toEqual([
        { payer: { type: "main" }, amountRaw: "1000000" },
        { payer: { type: "linked", linkedWalletId: ATOMIC_LINKED_WALLET_ID_2 }, amountRaw: "2000000" },
      ])
      // privyWalletId never leaves the process -- the server-bound build body carries neither.
      expect(JSON.stringify(buildSent)).not.toContain("privy-wallet")

      const leg0SignBody = JSON.parse(String(calls[1]?.body)) as { body: { params: { transaction: string } } }
      expect(leg0SignBody.body.params.transaction).toBe("unsigned-launch")
      const leg2SignBody = JSON.parse(String(calls[2]?.body)) as { body: { params: { transaction: string } } }
      expect(leg2SignBody.body.params.transaction).toBe("unsigned-buy-2")

      const submitSent = JSON.parse(String(calls[3]?.body)) as SubmitAtomicLaunchRequest
      expect(submitSent).toEqual({
        bundleId: "bundle-mixed-1",
        signedTxsBase64: ["signed-launch-tx", "signed-buy-2-tx"],
      })
    })

    test("a failed outcome after signing is returned, not thrown", async () => {
      const store = await twoWalletSecretStore()
      const failed = { status: "failed", bundleId: "bundle-mixed-1", retryable: false }
      const { client } = makeClient({ ...KEYED, secretStore: store, privyAppId: PRIVY_APP_ID }, [
        json(200, ATOMIC_BUILT_MIXED),
        json(200, { success: true, signedTransaction: "signed-launch-tx", encoding: "base64" }),
        json(200, { success: true, signedTransaction: "signed-buy-2-tx", encoding: "base64" }),
        json(502, failed),
      ])
      const result = await client.launchAtomic({
        ...ATOMIC_LAUNCH_REQ_BASE,
        payer: { type: "linked", linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
        firstBuys: [
          { payer: { type: "main" }, amountRaw: "1000000" },
          {
            payer: {
              type: "linked",
              linkedWalletId: ATOMIC_LINKED_WALLET_ID_2,
              privyWalletId: ATOMIC_PRIVY_WALLET_ID_2,
            },
            amountRaw: "2000000",
          },
        ],
      })
      expect(result).toEqual(failed as never)
    })

    test("a missing secretStore/privyAppId throws a clear error BEFORE any client leg is submitted", async () => {
      const { client, calls } = makeClient(KEYED, [json(200, ATOMIC_BUILT_MIXED)])
      await expect(
        client.launchAtomic({
          ...ATOMIC_LAUNCH_REQ_BASE,
          payer: { type: "linked", linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
          firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
        }),
      ).rejects.toThrow(/privyAppId/)
      // build already ran (the failure is discovered while signing leg 0), but submit never did.
      expect(calls.some((c) => c.url === "https://api.test/api/v1/launch/atomic/submit")).toBe(false)
    })
  })
})

describe("expandPreset (local, no fetch)", () => {
  const presets: PresetsPayload = {
    matrixVersion: 1,
    presets: [
      {
        name: "hood-open-eth-v4",
        description: "ETH-quoted Open launch on Hood",
        chain: "hood",
        quoteAsset: "eth",
        mode: "open",
        dexVersion: "v4",
        stakerAllocationBps: 50,
        terms: {
          symbol: "ETH",
          thresholdRaw: "4000000000000000000",
          raise: 4,
          startFdv: 1,
          bondingFdv: 8,
          supplySoldPct: 50,
        },
      },
    ],
  }

  test("merges the preset fragment with overrides, overrides winning", () => {
    const { client, calls } = makeClient({}, [])
    const req = client.expandPreset(presets, "hood-open-eth-v4", {
      name: "Trend Coin",
      symbol: "TREND",
      imageUrl: "https://example.com/logo.png",
      stakerAllocationBps: 100,
    })
    expect(req).toEqual({
      chain: "hood",
      quoteAsset: "eth",
      mode: "open",
      dexVersion: "v4",
      stakerAllocationBps: 100,
      name: "Trend Coin",
      symbol: "TREND",
      imageUrl: "https://example.com/logo.png",
    })
    expect(calls.length).toBe(0)
  })

  test("throws on an unknown preset name, listing the known ones", () => {
    const { client } = makeClient({}, [])
    expect(() => client.expandPreset(presets, "nope")).toThrow(/Unknown preset "nope".*hood-open-eth-v4/)
  })
})

describe("errors", () => {
  test("a structured envelope throws CandleApiError with code/status/retryable/field", async () => {
    const { client } = makeClient({}, [
      envelope(400, "VALIDATION_FAILED", { field: "chain", message: "chain must be solana or hood" }),
    ])
    const error = await client.getMarket("solana", "Mint111").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CandleApiError)
    const apiError = error as CandleApiError
    expect(apiError.code).toBe("VALIDATION_FAILED")
    expect(apiError.status).toBe(400)
    expect(apiError.retryable).toBe(false)
    expect(apiError.field).toBe("chain")
    expect(apiError.message).toBe("chain must be solana or hood")
  })

  test("a retryable envelope surfaces retryable: true", async () => {
    const { client } = makeClient({}, [envelope(404, "MARKET_NOT_FOUND", { retryable: true })])
    const error = (await client.getMarket("solana", "Mint111").catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("MARKET_NOT_FOUND")
    expect(error.retryable).toBe(true)
  })

  test("a non-envelope non-2xx throws CandleApiError with code HTTP_<status>", async () => {
    const { client } = makeClient({}, [json(404, { error: "User not found" })])
    const error = (await client.getAgentProfile("nobody").catch((e: unknown) => e)) as CandleApiError
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error.code).toBe("HTTP_404")
    expect(error.status).toBe(404)
    expect(error.retryable).toBe(false)
  })
})

describe("api key requirement", () => {
  test("keyed methods throw a plain Error naming apiKey before any fetch", async () => {
    const { client, calls } = makeClient({}, [])
    const attempts: (() => Promise<unknown>)[] = [
      () => client.launch(LAUNCH_REQ),
      () => client.launchAsync(LAUNCH_REQ),
      () => client.dryRunLaunch(LAUNCH_REQ),
      () => client.getLaunchJob("run-1"),
      () => client.reportActivity("solana", "Sig111"),
      () => client.uploadImage(new Uint8Array([1]), "image/png"),
      () => client.listWallets(),
      () => client.getSpendLimits(),
      () => client.swap({ from: "SOL", to: "USDC", amountRaw: "1000000" }),
      () =>
        client.buildTrade({
          clientTradeId: "trade-1",
          mint: "Mint111",
          side: "buy",
          amountRaw: "1000000",
          payer: { type: "main" },
        }),
      () => client.confirmTrade({ clientTradeId: "trade-1", signature: "Sig111" }),
      () => client.submit({ clientTradeId: "trade-1", signedTransactions: ["legA"] }),
      () => client.trade({ mint: "Mint111", side: "buy", amountRaw: "1000000", from: "main" }),
      () =>
        client.signLinkedTransaction({
          linkedWalletId: "wallet-1",
          privyWalletId: "privy-1",
          chain: "solana",
          unsignedTransactionBase64: "AQ==",
        }),
      () => client.selfLaunch({ ...LAUNCH_REQ, linkedWalletId: "wallet-1", privyWalletId: "privy-1" }),
      () =>
        client.buildAtomicLaunch({
          ...LAUNCH_REQ,
          payer: { type: "main" },
          firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
        }),
      () => client.submitAtomicLaunch({ bundleId: "bundle-1", signedTxsBase64: [] }),
      () =>
        client.launchAtomic({
          ...LAUNCH_REQ,
          payer: { type: "main" },
          firstBuys: [{ payer: { type: "main" }, amountRaw: "1000000" }],
        }),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/apiKey/)
    }
    expect(calls.length).toBe(0)
  })

  test("public reads work without a key", async () => {
    const { client } = makeClient({}, [json(200, { success: true, bucket: "new", tokens: [] })])
    const feed = await client.getFeed("new")
    expect(feed.tokens).toEqual([])
  })
})

describe("launch retry policy", () => {
  test("a bare 500 then 200 succeeds with the SAME clientLaunchId and exactly 2 calls", async () => {
    const { client, calls } = makeClient(KEYED, [
      new Response("upstream blew up", { status: 500 }),
      json(200, LAUNCH_OK),
    ])
    const result = await client.launch(LAUNCH_REQ)
    expect(result.mint).toBe("Mint111")
    expect(calls.length).toBe(2)
    const first = JSON.parse(String(calls[0]?.body)) as { clientLaunchId: string }
    const second = JSON.parse(String(calls[1]?.body)) as { clientLaunchId: string }
    expect(first.clientLaunchId).toBe("run-1")
    expect(second.clientLaunchId).toBe("run-1")
    expect(calls[0]?.body).toEqual(calls[1]?.body)
  })

  test("a network error is retried with the same generated id", async () => {
    const { client, calls } = makeClient(KEYED, [new TypeError("fetch failed"), json(200, LAUNCH_OK)])
    const { clientLaunchId: _omitted, ...withoutId } = LAUNCH_REQ
    await client.launch(withoutId)
    expect(calls.length).toBe(2)
    const first = JSON.parse(String(calls[0]?.body)) as { clientLaunchId: string }
    const second = JSON.parse(String(calls[1]?.body)) as { clientLaunchId: string }
    expect(first.clientLaunchId).toMatch(/^sdk-/)
    expect(second.clientLaunchId).toBe(first.clientLaunchId)
  })

  test("a non-retryable 400 envelope throws after exactly 1 call", async () => {
    const { client, calls } = makeClient(KEYED, [envelope(400, "VALIDATION_FAILED", { field: "symbol" })])
    const error = (await client.launch(LAUNCH_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("VALIDATION_FAILED")
    expect(calls.length).toBe(1)
  })

  test("a retryable 409 (launch in flight) is retried", async () => {
    const { client, calls } = makeClient(KEYED, [
      envelope(409, "IDEMPOTENCY_CONFLICT", { retryable: true }),
      json(200, LAUNCH_OK),
    ])
    const result = await client.launch(LAUNCH_REQ)
    expect(result.signature).toBe("Sig111")
    expect(calls.length).toBe(2)
    expect(calls[0]?.body).toEqual(calls[1]?.body)
  })

  test("a non-retryable 409 (same id, different body) throws after 1 call", async () => {
    const { client, calls } = makeClient(KEYED, [envelope(409, "IDEMPOTENCY_CONFLICT", { retryable: false })])
    const error = (await client.launch(LAUNCH_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT")
    expect(error.status).toBe(409)
    expect(calls.length).toBe(1)
  })

  test("a non-retryable 5xx envelope (LAUNCH_DISABLED) is never retried", async () => {
    const { client, calls } = makeClient(KEYED, [envelope(503, "LAUNCH_DISABLED", { retryable: false })])
    const error = (await client.launch(LAUNCH_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("LAUNCH_DISABLED")
    expect(calls.length).toBe(1)
  })

  test("retries are bounded by maxRetries", async () => {
    const { client, calls } = makeClient({ ...KEYED, maxRetries: 1 }, [
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ])
    const error = (await client.launch(LAUNCH_REQ).catch((e: unknown) => e)) as CandleApiError
    expect(error.code).toBe("HTTP_500")
    expect(calls.length).toBe(2)
  })
})

describe("waitForLaunch", () => {
  test("polls until the job is confirmed", async () => {
    const { client, calls } = makeClient(KEYED, [
      json(200, jobBody("submitted")),
      json(200, jobBody("confirming")),
      json(200, jobBody("confirmed")),
    ])
    const job = await client.waitForLaunch("run-1", { pollMs: 1 })
    expect(job.status).toBe("confirmed")
    expect(calls.length).toBe(3)
  })

  test("returns a failed job as terminal (the caller branches on status)", async () => {
    const { client, calls } = makeClient(KEYED, [json(200, jobBody("failed"))])
    const job = await client.waitForLaunch("run-1", { pollMs: 1 })
    expect(job.status).toBe("failed")
    expect(calls.length).toBe(1)
  })

  test("times out cleanly when the job never turns terminal", async () => {
    const { client } = makeClient(KEYED, [], () => json(200, jobBody("submitted")))
    await expect(client.waitForLaunch("run-1", { timeoutMs: 5, pollMs: 1 })).rejects.toThrow(/timed out after 5ms/)
  })
})

describe("BuildTradeResult chain discriminant (type-level)", () => {
  // `bun test` transpiles TypeScript without type-checking it, so a broken discriminant would
  // still pass every runtime assertion above. This function is never called for its behavior --
  // it exists so `bun run typecheck` (tsc --noEmit) catches a regression that widens
  // BuildTradeBuiltResult's `artifacts` back into one shared shape instead of narrowing per
  // `chain`. The `@ts-expect-error` lines are the actual assertions: each one FAILS typecheck
  // (removing the regression it guards against) if the field it names becomes reachable on the
  // wrong chain's branch.
  function assertDiscriminantNarrows(result: BuildTradeResult): string {
    if (result.status !== "built") return result.signature // "executed": chain-agnostic fields only

    if (result.chain === "solana") {
      const transactionBase64: string = result.artifacts.transactionBase64
      // @ts-expect-error narrowed to chain: "solana" -- `trade` only exists on the hood artifacts
      const _hoodOnly = result.artifacts.trade
      return transactionBase64
    }

    const trade: { to: string; data: string; value: string } = result.artifacts.trade
    // @ts-expect-error narrowed to chain: "hood" -- `transactionBase64` only exists on the solana artifacts
    const _solanaOnly = result.artifacts.transactionBase64
    return trade.to
  }

  test("compiles (see the function's own doc comment for what this actually pins)", () => {
    expect(typeof assertDiscriminantNarrows).toBe("function")
  })
})

describe("AgentTierInfo.feeTotals (type-level)", () => {
  // Same transpile-only caveat as the discriminant check above: this function is never called
  // for its behavior, only typechecked by `bun run typecheck`. feeRawSum must stay a raw-unit
  // BigInt string -- widening it to number would silently lose precision above 2^53.
  type FeeTotalRow = AgentTierInfo["feeTotals"][number]
  function assertFeeRawSumIsString(row: FeeTotalRow): string {
    const feeRawSum: string = row.feeRawSum
    // @ts-expect-error feeRawSum is a raw-unit BigInt string, never a number
    const _notNumber: number = row.feeRawSum
    return feeRawSum
  }

  test("compiles (see the function's own doc comment for what this actually pins)", () => {
    expect(typeof assertFeeRawSumIsString).toBe("function")
  })
})

describe("swapFromLinked", () => {
  test("build -> relay-sign per transaction -> submit, returning the submit payload", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "ck_live_x",
      privyAppId: "app1",
      secretStore: await (async () => {
        const store = new InMemorySecretStore()
        const { privateKeyPem } = await generateSignerKeypair()
        await store.set("lw-1", privateKeyPem)
        return store
      })(),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        calls.push({ url: u, body })
        if (u.endsWith("/agent/swap/build")) {
          return json(200, {
            success: true,
            payload: { swapId: "swap-1", transactionsBase64: ["dW5zaWduZWQ="] },
          })
        }
        if (u.includes("/agent/wallets/lw-1/sign")) {
          return json(200, { success: true, signedTransaction: "c2lnbmVk", encoding: "base64" })
        }
        if (u.endsWith("/agent/swap/submit")) {
          return json(200, {
            success: true,
            payload: {
              hashes: ["DepositHash1"],
              expectedOutRaw: "16000000000000000",
              outDecimals: 18,
              statusChecks: ["https://api.relay.link/intents/status?requestId=r1"],
              recipient: "0x00000000000000000000000000000000000000BB",
            },
          })
        }
        throw new Error(`unexpected fetch ${u}`)
      }) as typeof fetch,
    })

    const result = await client.swapFromLinked({
      from: "SOL",
      to: "ETH",
      amountRaw: "3000000000",
      payer: { linkedWalletId: "lw-1", privyWalletId: "pw-1" },
      toWalletId: "lw-evm-1",
    })

    expect(result.hashes).toEqual(["DepositHash1"])
    expect(result.recipient).toBe("0x00000000000000000000000000000000000000BB")
    expect(result.statusChecks.length).toBe(1)

    const build = calls.find((c) => c.url.endsWith("/agent/swap/build"))
    expect(build?.body.payer).toEqual({ type: "linked", linkedWalletId: "lw-1" })
    expect(build?.body.toWalletId).toBe("lw-evm-1")
    const submit = calls.find((c) => c.url.endsWith("/agent/swap/submit"))
    expect(submit?.body.swapId).toBe("swap-1")
    expect(submit?.body.signedTransactionsBase64).toEqual(["c2lnbmVk"])
  })
})
