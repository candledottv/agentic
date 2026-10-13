/**
 * The one-call write methods keep the idempotency id they send (BE-1359, spec
 * docs/superpowers/specs/2026-10-13-sdk-one-call-idempotency-id-design.md, section 7).
 *
 * T1 to T22 are the spec's table; each test names its row. They are built from the BE-1120 probe's
 * fake `fetch`: a handler that sees every request, where throwing from the handler is a lost
 * response. No server, RPC, key or network.
 *
 * The fakes mirror the REAL success bodies. The headless launch body and the atomic build body
 * carry NO `clientLaunchId` (apps/api/src/lib/launch-response.ts, routes/launch-atomic.ts), unlike
 * the probe's atomic fake, so a test that reads the id off a result proves the SDK supplied it.
 */

import { describe, expect, test } from "bun:test"
import type { BuildAtomicLaunchRequest, LaunchAtomicRequest, LaunchRequest, SelfLaunchRequest } from "./client"
import { CandleApiError, JsonRpcError, TradeLandedFeeLegError } from "./errors"
// T19: the new names come from the package root, as an integrator imports them.
import {
  CandleClient,
  CandleOperationError,
  type LaunchAtomicResult,
  type OperationIds,
  operationIds,
  type TradeJob,
} from "./index"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const API = "https://api.test"
const EVM_RPC = "https://rpc.test/evm"
const SOLANA_RPC = "https://rpc.test/solana"
const LINKED_WALLET_ID = "wallet-123"
const PRIVY_WALLET_ID = "privy-wallet-123"
const LOST = "fetch failed: socket hang up"

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function envelope(status: number, code: string, opts: { retryable?: boolean; message?: string } = {}): Response {
  return json(status, {
    success: false,
    error: { code, message: opts.message ?? `${code} message`, retryable: opts.retryable === true },
  })
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

/** A fake whose handler sees every request. Throwing from the handler is a lost response. */
function fakeServer(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    return handler(call, calls.length)
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** The rejection of `p`. A promise that resolves fails the test here, never silently. */
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw, but it returned")
}

/** What follows the original message in a wrapped error: the part the SDK wrote. */
function added(error: CandleOperationError, original: string): string {
  expect(error.message.startsWith(original)).toBe(true)
  return error.message.slice(original.length)
}

/** The server-executed variant: read the job, or retry with the same id. */
function expectServerExecutedMessage(error: CandleOperationError, original: string, idName: string, id: string): void {
  const text = added(error, original)
  expect(text).toContain(`${idName} ${id}`)
  expect(text).toContain("may or may not have reached Candle")
  expect(text).toContain(`retry the call with this same ${idName} and the same request`)
  expect(text).toContain("A call with a new id, or with none, is a second, independent")
}

/** The cautious variant: read the job and check the wallet. It must never say to retry with the id. */
function expectCautiousMessage(error: CandleOperationError, original: string, idName: string, id: string): void {
  const text = added(error, original)
  expect(text).toContain(`${idName} ${id}`)
  expect(text).toContain("may or may not have reached Candle")
  expect(text).toContain("read the job for this id")
  expect(text).toContain("check the wallet's recent transactions before sending again")
  expect(text).toContain("A call with a new id, or with none, is a second, independent")
  expect(text).not.toMatch(/retry/i)
}

async function keyedStore() {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set(LINKED_WALLET_ID, privateKeyPem)
  return store
}

async function linkedClient(impl: typeof fetch) {
  return new CandleClient({
    apiUrl: API,
    apiKey: "k",
    fetch: impl,
    secretStore: await keyedStore(),
    privyAppId: "app-test-123",
    evmRpcUrl: EVM_RPC,
    solanaRpcUrl: SOLANA_RPC,
  })
}

const SIGN_OK = { success: true, signedTransaction: "c2lnbmVkLXR4", encoding: "base64" }
const rpcOk = (result: unknown) => json(200, { jsonrpc: "2.0", id: 1, result })
const rpcError = (code: number, message: string, data?: unknown) =>
  json(200, { jsonrpc: "2.0", id: 1, error: { code, message, ...(data !== undefined ? { data } : {}) } })

// ---------------------------------------------------------------------------------------------
// trade()
// ---------------------------------------------------------------------------------------------

describe("trade(): the clientTradeId is on every outcome", () => {
  const REQ = { mint: "Mint111", side: "buy" as const, amountRaw: "1000000", from: "main" as const }

  /** A server that executes once per clientTradeId and replays after that. */
  function idempotentTradeServer(opts: { loseFirstResponse: boolean }) {
    const executed = new Map<string, number>()
    let lost = false
    const server = fakeServer((call) => {
      const id = String(call.body?.clientTradeId)
      // The same id never executes twice: the route's replay.
      if (!executed.has(id)) executed.set(id, 1)
      if (opts.loseFirstResponse && !lost) {
        lost = true
        throw new TypeError(LOST)
      }
      return json(200, {
        success: true,
        status: "executed",
        clientTradeId: id,
        chain: "solana",
        signature: `sig-for-${id}`,
        fee: { bps: 0, feeRaw: "0", treasury: null },
        amounts: { amountRaw: "1000000", expectedOutRaw: "1", minOutRaw: "1", quoteAsset: "sol" },
      })
    })
    return { ...server, executed }
  }

  test("T1: a main-payer trade with no id, response lost after the server executed, throws CandleOperationError carrying the id sent", async () => {
    const server = idempotentTradeServer({ loseFirstResponse: true })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade(REQ))
    const sent = String(server.calls[0]?.body?.clientTradeId)
    expect(sent.startsWith("sdk-")).toBe(true)
    expect(server.executed.size).toBe(1) // the trade ran: this is the response that was lost

    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.name).toBe("CandleOperationError")
    expect(wrapped.clientTradeId).toBe(sent)
    expect(wrapped.clientLaunchId).toBeUndefined()
    expect(wrapped.bundleId).toBeUndefined()
    // An own, enumerable property: a spread or a JSON log keeps it.
    expect(Object.keys(wrapped)).toContain("clientTradeId")
    expect(JSON.stringify({ ...wrapped })).toContain(sent)
    // The original is the cause, the very object fetch rejected with.
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expect((wrapped.cause as Error).message).toBe(LOST)
    expectServerExecutedMessage(wrapped, LOST, "clientTradeId", sent)
    expect(wrapped.message).toContain("getTradeJob()")
  })

  test("T2: retrying with operationIds(error).clientTradeId is a replay, one execution, one id on the wire", async () => {
    const server = idempotentTradeServer({ loseFirstResponse: true })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade(REQ))
    const { clientTradeId } = operationIds(error)
    expect(typeof clientTradeId).toBe("string")
    const result = await client.trade({ ...REQ, clientTradeId })
    expect(result.status).toBe("executed")
    expect(result.clientTradeId).toBe(String(clientTradeId))
    expect(server.executed.size).toBe(1)
    expect(new Set(server.calls.map((c) => c.body?.clientTradeId)).size).toBe(1)
  })

  test("T3: control, a caller-chosen id lost and retried is one execution, and the error carries that id", async () => {
    const server = idempotentTradeServer({ loseFirstResponse: true })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade({ ...REQ, clientTradeId: "mine-1" }))
    expect(error).toBeInstanceOf(CandleOperationError)
    expect(operationIds(error)).toEqual({ clientTradeId: "mine-1" })
    const second = await client.trade({ ...REQ, clientTradeId: "mine-1" })
    expect(second.status).toBe("executed")
    expect(server.executed.size).toBe(1)
    expect(server.calls.map((c) => c.body?.clientTradeId)).toEqual(["mine-1", "mine-1"])
  })

  test("T4: a 500 SWAP_FAILED stays a CandleApiError with code and status unchanged, and gains clientTradeId", async () => {
    const server = fakeServer(() => envelope(500, "SWAP_FAILED", { retryable: true, message: "Swap failed; retry" }))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade(REQ))
    const sent = String(server.calls[0]?.body?.clientTradeId)
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const api = error as CandleApiError
    expect(api.name).toBe("CandleApiError")
    expect(api.code).toBe("SWAP_FAILED")
    expect(api.status).toBe(500)
    expect(api.retryable).toBe(true)
    expect(api.message).toBe("Swap failed; retry")
    expect(api.clientTradeId).toBe(sent)
    expect(Object.keys(api)).toContain("clientTradeId")
    expect(api.clientLaunchId).toBeUndefined()
  })

  test("T5: with no API key it throws before any fetch, with no id and not a CandleOperationError", async () => {
    const server = idempotentTradeServer({ loseFirstResponse: false })
    const client = new CandleClient({ apiUrl: API, fetch: server.impl })
    const error = await caught(client.trade(REQ))
    expect(server.calls.length).toBe(0)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    expect((error as Error).message).toContain("requires an apiKey")
    expect(operationIds(error)).toEqual({})
    expect("clientTradeId" in (error as object)).toBe(false)
  })

  test("T6: a second trade() with no id sends a different id, the SDK does not deduplicate", async () => {
    const server = idempotentTradeServer({ loseFirstResponse: false })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const first = await client.trade(REQ)
    const second = await client.trade(REQ)
    const ids = server.calls.map((c) => String(c.body?.clientTradeId))
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(first.clientTradeId).toBe(String(ids[0]))
    expect(second.clientTradeId).toBe(String(ids[1]))
    expect(server.executed.size).toBe(2) // two calls with no id are two trades, as the server contract says
  })

  test("the result carries the id even if a server body omits it", async () => {
    const server = fakeServer(() =>
      json(200, { success: true, status: "executed", chain: "solana", signature: "sig", fee: {}, amounts: {} }),
    )
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const result = await client.trade(REQ)
    expect(result.clientTradeId).toBe(String(server.calls[0]?.body?.clientTradeId))
  })
})

// ---------------------------------------------------------------------------------------------
// trade() with a linked payer: the caller broadcasts, so the wrapped message is the cautious one
// ---------------------------------------------------------------------------------------------

describe("trade() with a linked payer", () => {
  const FROM = { linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID }
  const REQ = { mint: "Mint111", side: "buy" as const, amountRaw: "500000", from: FROM }

  const solanaBuilt = (id: string) => ({
    success: true,
    status: "built",
    clientTradeId: id,
    chain: "solana",
    walletAddress: "LinkedSolanaWallet1",
    artifacts: { venue: "curve", transactionBase64: "AQADunsigned", quoteAsset: "sol", quoteDecimals: 9 },
    fee: { bps: 100, feeRaw: "2000", treasury: "TreasuryAddr1" },
    expectedOutRaw: "500000",
    minOutRaw: "495000",
    expiresAt: 1692345678000,
  })

  const hoodBuilt = (id: string) => ({
    success: true,
    status: "built",
    clientTradeId: id,
    chain: "hood",
    walletAddress: "0xLinkedWa11etAddress1",
    artifacts: { venue: "dex", trade: { to: "0xRouter1", data: "0xtrade", value: "0" }, quoteAsset: "eth" },
    fee: { bps: 0, feeRaw: "0", treasury: null },
    expectedOutRaw: "700000",
    minOutRaw: "693000",
    expiresAt: 1692345678000,
  })

  test("T21a: the sign relay rejecting after the build is a CandleApiError that keeps its class and gains clientTradeId", async () => {
    const server = fakeServer((call) => {
      if (call.url.endsWith("/trade/agent/build")) return json(200, solanaBuilt(String(call.body?.clientTradeId)))
      if (call.url.endsWith("/sign")) return envelope(403, "SPEND_POLICY_DENIED", { message: "Policy denied" })
      throw new Error(`unrouted ${call.url}`)
    })
    const error = await caught((await linkedClient(server.impl)).trade(REQ))
    const sent = String(server.calls[0]?.body?.clientTradeId)
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const api = error as CandleApiError
    expect(api.code).toBe("SPEND_POLICY_DENIED")
    expect(api.status).toBe(403)
    expect(api.message).toBe("Policy denied")
    expect(api.clientTradeId).toBe(sent)
  })

  test("T21a: a lost sign-relay response is wrapped with the cautious variant, never a plain retry", async () => {
    const server = fakeServer((call) => {
      if (call.url.endsWith("/trade/agent/build")) return json(200, solanaBuilt(String(call.body?.clientTradeId)))
      throw new TypeError(LOST)
    })
    const error = await caught((await linkedClient(server.impl)).trade(REQ))
    const sent = String(server.calls[0]?.body?.clientTradeId)
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientTradeId).toBe(sent)
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expectCautiousMessage(wrapped, LOST, "clientTradeId", sent)
    expect(wrapped.message).toContain("getTradeJob()")
  })

  test("T21a: a lost BUILD response for a linked payer is also the cautious variant (chosen by flow, not by stage)", async () => {
    const server = fakeServer(() => {
      throw new TypeError(LOST)
    })
    const error = await caught((await linkedClient(server.impl)).trade({ ...REQ, clientTradeId: "linked-1" }))
    expect(error).toBeInstanceOf(CandleOperationError)
    expectCautiousMessage(error as CandleOperationError, LOST, "clientTradeId", "linked-1")
  })

  test("T21b: a Hood leg's JsonRpcError keeps its class, code and data, and gains clientTradeId", async () => {
    const server = fakeServer((call) => {
      if (call.url.endsWith("/trade/agent/build")) return json(200, hoodBuilt(String(call.body?.clientTradeId)))
      if (call.url === EVM_RPC) {
        const method = String(call.body?.method)
        if (method === "eth_chainId") return rpcOk("0x2105")
        if (method === "eth_getTransactionCount") return rpcOk("0x5")
        if (method === "eth_maxPriorityFeePerGas") return rpcOk("0x3b9aca00")
        if (method === "eth_getBlockByNumber") return rpcOk({ baseFeePerGas: "0x77359400" })
        if (method === "eth_estimateGas") return rpcError(3, "execution reverted", "0x08c379a0")
      }
      throw new Error(`unrouted ${call.url} ${JSON.stringify(call.body)}`)
    })
    const error = await caught(
      (await linkedClient(server.impl)).trade({ ...REQ, mint: "0xMint", clientTradeId: "hood-1" }),
    )
    expect(error).toBeInstanceOf(JsonRpcError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const rpc = error as JsonRpcError
    expect(rpc.name).toBe("JsonRpcError")
    expect(rpc.code).toBe(3)
    expect(rpc.data).toBe("0x08c379a0")
    expect(rpc.message).toContain("execution reverted")
    expect(rpc.clientTradeId).toBe("hood-1")
    expect(Object.keys(rpc)).toContain("clientTradeId")
  })

  test("T21b: a plain Error from a Hood step (no evmRpcUrl, after the build) is wrapped with the cautious variant", async () => {
    const server = fakeServer((call) => json(200, hoodBuilt(String(call.body?.clientTradeId))))
    const client = new CandleClient({
      apiUrl: API,
      apiKey: "k",
      fetch: server.impl,
      secretStore: await keyedStore(),
      privyAppId: "app-test-123",
    })
    const error = await caught(client.trade({ ...REQ, mint: "0xMint", clientTradeId: "hood-2" }))
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientTradeId).toBe("hood-2")
    const original = (wrapped.cause as Error).message
    expect(original).toContain("requires evmRpcUrl")
    expectCautiousMessage(wrapped, original, "clientTradeId", "hood-2")
  })
})

// ---------------------------------------------------------------------------------------------
// launch(), launchAsync()
// ---------------------------------------------------------------------------------------------

describe("launch() and launchAsync(): the clientLaunchId is on every outcome", () => {
  const REQ: LaunchRequest = { name: "T", symbol: "T", imageUrl: "https://img.test/a.png" }

  /** The real success body: no clientLaunchId (apps/api/src/lib/launch-response.ts). */
  const LAUNCH_BODY = {
    success: true,
    chain: "solana",
    mint: "Mint111",
    pool: "Pool111",
    signature: "Sig111",
    quoteAsset: "sol",
    mode: "open",
    stakerAllocationBps: 50,
    matrixVersion: 1,
    links: { candle: "https://candle.tv/token/Mint111" },
    nextBuy: { market: "Pool111", quoteAsset: "sol", marketStateUrl: "/api/v1/markets/solana/Mint111" },
  }

  /** Launches once per id. `lose(n)` says whether request n's response is lost. */
  function launchServer(lose: (n: number) => boolean) {
    const launched = new Set<string>()
    const server = fakeServer((call, n) => {
      launched.add(String(call.body?.clientLaunchId))
      if (lose(n)) throw new TypeError(LOST)
      return json(200, LAUNCH_BODY)
    })
    return { ...server, launched }
  }

  test("T7: every response lost with maxRetries 1 is two requests under one id, and the error carries it", async () => {
    const server = launchServer(() => true)
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl, maxRetries: 1 })
    const error = await caught(client.launch(REQ))
    expect(server.calls.length).toBe(2)
    expect(server.launched.size).toBe(1)
    const sent = String(server.calls[0]?.body?.clientLaunchId)
    expect(sent.startsWith("sdk-")).toBe(true)

    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientLaunchId).toBe(sent)
    expect(wrapped.clientTradeId).toBeUndefined()
    expect(Object.keys(wrapped)).toContain("clientLaunchId")
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expectServerExecutedMessage(wrapped, LOST, "clientLaunchId", sent)
    expect(wrapped.message).toContain("getLaunchJob()")
  })

  test("T8: calling launch() again with the id from that error reaches the server under one id", async () => {
    const server = launchServer((n) => n === 1)
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl, maxRetries: 0 })
    const error = await caught(client.launch(REQ))
    const { clientLaunchId } = operationIds(error)
    expect(typeof clientLaunchId).toBe("string")
    const result = await client.launch({ ...REQ, clientLaunchId })
    expect(result.mint).toBe("Mint111")
    expect(result.clientLaunchId).toBe(String(clientLaunchId))
    expect(server.calls.length).toBe(2)
    expect(server.launched.size).toBe(1)
  })

  test("T9: a successful launch returns the id sent, generated or the caller's, though the body has none", async () => {
    const server = launchServer(() => false)
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const generated = await client.launch(REQ)
    expect(generated.clientLaunchId).toBe(String(server.calls[0]?.body?.clientLaunchId))
    expect(generated.clientLaunchId.startsWith("sdk-")).toBe(true)
    expect(generated.mint).toBe("Mint111")
    const mine = await client.launch({ ...REQ, clientLaunchId: "mine-launch-1" })
    expect(mine.clientLaunchId).toBe("mine-launch-1")
    expect(server.calls[1]?.body?.clientLaunchId).toBe("mine-launch-1")
  })

  test("T10: retries that end on a retryable 5xx envelope throw that CandleApiError, with clientLaunchId", async () => {
    const server = fakeServer(() => envelope(503, "LAUNCH_FAILED", { retryable: true }))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl, maxRetries: 1 })
    const error = await caught(client.launch(REQ))
    expect(server.calls.length).toBe(2)
    const ids = new Set(server.calls.map((c) => c.body?.clientLaunchId))
    expect(ids.size).toBe(1)
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const api = error as CandleApiError
    expect(api.code).toBe("LAUNCH_FAILED")
    expect(api.status).toBe(503)
    expect(api.retryable).toBe(true)
    expect(api.clientLaunchId).toBe(String(server.calls[0]?.body?.clientLaunchId))
  })

  test("a non-retryable envelope is thrown at once, unchanged but for the id", async () => {
    const server = fakeServer(() => envelope(400, "VALIDATION_FAILED"))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.launch({ ...REQ, clientLaunchId: "mine-2" }))
    expect(server.calls.length).toBe(1)
    expect(error).toBeInstanceOf(CandleApiError)
    expect((error as CandleApiError).code).toBe("VALIDATION_FAILED")
    expect(operationIds(error)).toEqual({ clientLaunchId: "mine-2" })
  })

  test("T11: launchAsync() with the response lost throws an error carrying clientLaunchId", async () => {
    const server = fakeServer(() => {
      throw new TypeError(LOST)
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.launchAsync(REQ))
    expect(server.calls.length).toBe(1) // single attempt, as before
    expect(server.calls[0]?.body?.async).toBe(true)
    const sent = String(server.calls[0]?.body?.clientLaunchId)
    expect(error).toBeInstanceOf(CandleOperationError)
    expect((error as CandleOperationError).clientLaunchId).toBe(sent)
    expectServerExecutedMessage(error as CandleOperationError, LOST, "clientLaunchId", sent)
  })

  test("T11: launchAsync() success still returns the id to poll", async () => {
    const server = fakeServer((call) =>
      json(202, {
        success: true,
        accepted: true,
        clientLaunchId: call.body?.clientLaunchId,
        status: "submitted",
        jobUrl: `/api/v1/launch/headless/jobs/${String(call.body?.clientLaunchId)}`,
      }),
    )
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const accepted = await client.launchAsync(REQ)
    expect(accepted.clientLaunchId).toBe(String(server.calls[0]?.body?.clientLaunchId))
  })
})

// ---------------------------------------------------------------------------------------------
// selfLaunch(): the caller broadcasts, so the wrapped message is the cautious one
// ---------------------------------------------------------------------------------------------

describe("selfLaunch(): the clientLaunchId is on every outcome", () => {
  const REQ: SelfLaunchRequest = {
    name: "T",
    symbol: "T",
    imageUrl: "https://img.test/a.png",
    linkedWalletId: LINKED_WALLET_ID,
    privyWalletId: PRIVY_WALLET_ID,
  }

  /** The self confirm success body is the launch body: no clientLaunchId. */
  const CONFIRM_BODY = {
    success: true,
    chain: "solana",
    mint: "MintA",
    pool: "PoolA",
    signature: "LaunchSig111",
    quoteAsset: "sol",
    mode: "open",
    stakerAllocationBps: 50,
    matrixVersion: 1,
    links: { candle: "https://candle.tv/token/MintA" },
    nextBuy: { market: "PoolA", quoteAsset: "sol", marketStateUrl: "/api/v1/markets/solana/MintA" },
  }

  function selfLaunchWorld(opts: { build?: () => Response; broadcast?: () => Response; confirm?: () => Response }) {
    const builtIds: string[] = []
    const world = fakeServer((call) => {
      if (call.url.endsWith("/launch/self/build")) {
        builtIds.push(String(call.body?.clientLaunchId))
        return (
          opts.build?.() ??
          json(200, {
            success: true,
            clientLaunchId: call.body?.clientLaunchId,
            mint: "MintA",
            pool: "PoolA",
            transaction: "AQADunsigned",
            expiresAt: 1692345678000,
          })
        )
      }
      if (call.url.endsWith("/sign")) return json(200, SIGN_OK)
      if (call.url === SOLANA_RPC) return opts.broadcast?.() ?? rpcOk("LaunchSig111")
      if (call.url.endsWith("/launch/self/confirm")) return opts.confirm?.() ?? json(200, CONFIRM_BODY)
      throw new Error(`unrouted ${call.url}`)
    })
    return { ...world, builtIds }
  }

  test("T12: a lost build response is wrapped with the cautious variant, never a plain retry", async () => {
    const world = selfLaunchWorld({
      build: () => {
        throw new TypeError(LOST)
      },
    })
    const error = await caught((await linkedClient(world.impl)).selfLaunch(REQ))
    const sent = String(world.builtIds[0])
    expect(sent.startsWith("sdk-")).toBe(true)
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientLaunchId).toBe(sent)
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expectCautiousMessage(wrapped, LOST, "clientLaunchId", sent)
    expect(wrapped.message).toContain("getLaunchJob()")
  })

  test("T12: a CandleApiError from confirm keeps its class and gains clientLaunchId", async () => {
    const world = selfLaunchWorld({
      confirm: () => envelope(404, "TX_NOT_FOUND", { retryable: true, message: "Transaction not found yet" }),
    })
    const error = await caught((await linkedClient(world.impl)).selfLaunch(REQ))
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const api = error as CandleApiError
    expect(api.code).toBe("TX_NOT_FOUND")
    expect(api.status).toBe(404)
    expect(api.retryable).toBe(true)
    expect(api.message).toBe("Transaction not found yet")
    expect(api.clientLaunchId).toBe(String(world.builtIds[0]))
  })

  test("T12: a JsonRpcError from the broadcast keeps its class, code and data, and gains clientLaunchId", async () => {
    const data = { err: { InstructionError: [3, "Custom"] }, logs: ["Program log: failed"] }
    const world = selfLaunchWorld({ broadcast: () => rpcError(-32002, "Transaction simulation failed", data) })
    const error = await caught((await linkedClient(world.impl)).selfLaunch(REQ))
    expect(error).toBeInstanceOf(JsonRpcError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const rpc = error as JsonRpcError
    expect(rpc.code).toBe(-32002)
    expect(rpc.data).toEqual(data)
    expect(rpc.message).toContain("Transaction simulation failed")
    expect(rpc.clientLaunchId).toBe(String(world.builtIds[0]))
    expect(world.builtIds.length).toBe(1) // not a blockhash expiry: no rebuild
  })

  test("T12: a blockhash-expiry JsonRpcError that survives every rebuild carries the one id all three builds used", async () => {
    const world = selfLaunchWorld({
      broadcast: () => rpcError(-32002, "Transaction simulation failed", { err: "BlockhashNotFound", logs: [] }),
    })
    const error = await caught((await linkedClient(world.impl)).selfLaunch(REQ))
    expect(error).toBeInstanceOf(JsonRpcError)
    expect(world.builtIds.length).toBe(3)
    expect(new Set(world.builtIds).size).toBe(1)
    expect((error as JsonRpcError).clientLaunchId).toBe(String(world.builtIds[0]))
  })

  test("T12: success returns the id sent, though the confirm body has none", async () => {
    const world = selfLaunchWorld({})
    const sdk = await linkedClient(world.impl)
    const generated = await sdk.selfLaunch(REQ)
    expect(generated.clientLaunchId).toBe(String(world.builtIds[0]))
    expect(generated.mint).toBe("MintA")
    const mine = await sdk.selfLaunch({ ...REQ, clientLaunchId: "mine-self-1" })
    expect(mine.clientLaunchId).toBe("mine-self-1")
  })

  test("confirmSelfLaunch() sets the id from its request", async () => {
    const server = fakeServer(() => json(200, CONFIRM_BODY))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const result = await client.confirmSelfLaunch({ clientLaunchId: "by-hand-1", signature: "LaunchSig111" })
    expect(result.clientLaunchId).toBe("by-hand-1")
  })
})

// ---------------------------------------------------------------------------------------------
// buildAtomicLaunch(), launchAtomic()
// ---------------------------------------------------------------------------------------------

describe("buildAtomicLaunch() and launchAtomic(): the clientLaunchId is on every outcome", () => {
  const BUILD_REQ: BuildAtomicLaunchRequest = {
    name: "T",
    symbol: "T",
    imageUrl: "https://img.test/a.png",
    payer: { type: "main" },
    firstBuys: [{ payer: { type: "main" }, amountRaw: "1000" }],
  }
  const REQ: LaunchAtomicRequest = {
    name: "T",
    symbol: "T",
    imageUrl: "https://img.test/a.png",
    payer: { type: "main" },
    firstBuys: [{ payer: { type: "main" }, amountRaw: "1000" }],
  }

  /**
   * `/build` answers the real body, `{ bundleId, legs, expiresAt }` with NO clientLaunchId, unless
   * `build` overrides it. `submit(n)` decides the nth `/submit`.
   */
  function atomicServer(opts: {
    submit?: (n: number) => Response
    build?: (n: number, id: string) => Response | null
  }) {
    const builtIds: string[] = []
    let submits = 0
    const server = fakeServer((call) => {
      if (call.url.endsWith("/launch/atomic/build")) {
        builtIds.push(String(call.body?.clientLaunchId))
        const override = opts.build?.(builtIds.length, String(call.body?.clientLaunchId))
        if (override) return override
        return json(200, {
          bundleId: `bundle-${builtIds.length}`,
          legs: [
            { index: 0, role: "launch", signer: "server" },
            { index: 1, role: "buy", signer: "server" },
          ],
          expiresAt: 1692345678000,
        })
      }
      if (call.url.endsWith("/launch/atomic/submit")) {
        submits += 1
        if (!opts.submit) throw new Error("unexpected /submit")
        return opts.submit(submits)
      }
      throw new Error(`unrouted ${call.url}`)
    })
    return { ...server, builtIds }
  }

  const TIMEOUT = (bundleId: string) => json(502, { status: "timeout", bundleId, retryable: false })
  const FAILED = (bundleId: string) => json(502, { status: "failed", bundleId, retryable: false })
  const LANDED = (bundleId: string) =>
    json(200, { status: "landed", bundleId, mint: "Mint111", signatures: ["s0", "s1"] })
  const CONFLICT_UNRESOLVED = () =>
    envelope(409, "IDEMPOTENCY_CONFLICT", { message: "This launch was sent; its original attempt must be resolved" })

  test("T13: buildAtomicLaunch() success returns the id sent, though the body has none", async () => {
    const server = atomicServer({})
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const built = await client.buildAtomicLaunch(BUILD_REQ)
    expect(built.clientLaunchId).toBe(String(server.builtIds[0]))
    expect(built.clientLaunchId.startsWith("sdk-")).toBe(true)
    expect(built.bundleId).toBe("bundle-1")
    const mine = await client.buildAtomicLaunch({ ...BUILD_REQ, clientLaunchId: "mine-atomic-1" })
    expect(mine.clientLaunchId).toBe("mine-atomic-1")
  })

  test("T13: buildAtomicLaunch() with the response lost throws an error carrying the id", async () => {
    const server = atomicServer({
      build: () => {
        throw new TypeError(LOST)
      },
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.buildAtomicLaunch(BUILD_REQ))
    const sent = String(server.builtIds[0])
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientLaunchId).toBe(sent)
    expect(wrapped.bundleId).toBeUndefined()
    expectServerExecutedMessage(wrapped, LOST, "clientLaunchId", sent)
  })

  test("T14: timeout, failed and landed are each returned, not thrown, with clientLaunchId", async () => {
    const outcomes = [TIMEOUT, FAILED, LANDED]
    const server = atomicServer({ submit: (n) => (outcomes[n - 1] ?? LANDED)(`bundle-${n}`) })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })

    const timedOut: LaunchAtomicResult = await client.launchAtomic(REQ)
    expect(timedOut).toEqual({
      status: "timeout",
      bundleId: "bundle-1",
      retryable: false,
      clientLaunchId: String(server.builtIds[0]),
    })

    const failed = await client.launchAtomic(REQ)
    expect(failed).toEqual({
      status: "failed",
      bundleId: "bundle-2",
      retryable: false,
      clientLaunchId: String(server.builtIds[1]),
    })

    const landed = await client.launchAtomic({ ...REQ, clientLaunchId: "mine-atomic-2" })
    expect(landed).toEqual({
      status: "landed",
      bundleId: "bundle-3",
      mint: "Mint111",
      signatures: ["s0", "s1"],
      clientLaunchId: "mine-atomic-2",
    })
    expect(server.builtIds[2]).toBe("mine-atomic-2")
  })

  test("T15: a lost submit response throws CandleOperationError with clientLaunchId and bundleId", async () => {
    const server = atomicServer({
      submit: () => {
        throw new TypeError(LOST)
      },
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.launchAtomic(REQ))
    const sent = String(server.builtIds[0])
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.clientLaunchId).toBe(sent)
    expect(wrapped.bundleId).toBe("bundle-1")
    expect(operationIds(wrapped)).toEqual({ clientLaunchId: sent, bundleId: "bundle-1" })
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expectServerExecutedMessage(wrapped, LOST, "clientLaunchId", sent)
    // The bundle is named for the logs, and the message says it is not what to resubmit.
    expect(wrapped.message).toContain("bundleId bundle-1")
    expect(wrapped.message).toContain("never resubmitted")
  })

  test("T16: launchAtomic() again with the id from a timeout sends the same id to /build, and the 409 carries it", async () => {
    // #1913: a same-id rebuild after a send is refused while the first attempt is unresolved.
    const server = atomicServer({
      submit: () => TIMEOUT("bundle-1"),
      build: (n) => (n === 1 ? null : CONFLICT_UNRESOLVED()),
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const first = await client.launchAtomic(REQ)
    expect(first.status).toBe("timeout")

    const error = await caught(client.launchAtomic({ ...REQ, clientLaunchId: first.clientLaunchId }))
    expect(server.builtIds).toEqual([first.clientLaunchId, first.clientLaunchId])
    expect(new Set(server.builtIds).size).toBe(1)
    expect(error).toBeInstanceOf(CandleApiError)
    const api = error as CandleApiError
    expect(api.code).toBe("IDEMPOTENCY_CONFLICT")
    expect(api.status).toBe(409)
    expect(api.message).toBe("This launch was sent; its original attempt must be resolved")
    expect(api.clientLaunchId).toBe(first.clientLaunchId)
    expect(api.bundleId).toBeUndefined() // refused at build: there is no new bundle
  })

  test("T17: a non-JSON 502 from submit is a CandleApiError HTTP_502 with both ids", async () => {
    const server = atomicServer({
      submit: () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.launchAtomic(REQ))
    expect(error).toBeInstanceOf(CandleApiError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    const api = error as CandleApiError
    expect(api.code).toBe("HTTP_502")
    expect(api.status).toBe(502)
    expect(api.retryable).toBe(false)
    expect(api.clientLaunchId).toBe(String(server.builtIds[0]))
    expect(api.bundleId).toBe("bundle-1")
  })

  test("T22: a build response lost INSIDE launchAtomic() is wrapped once, and cause is the original TypeError", async () => {
    const server = atomicServer({
      build: () => {
        throw new TypeError(LOST)
      },
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.launchAtomic(REQ))
    const sent = String(server.builtIds[0])
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.cause).toBeInstanceOf(TypeError)
    expect(wrapped.cause).not.toBeInstanceOf(CandleOperationError)
    expect((wrapped.cause as Error).message).toBe(LOST)
    expect(wrapped.clientLaunchId).toBe(sent)
    expect(wrapped.bundleId).toBeUndefined() // the build never answered
    expectServerExecutedMessage(wrapped, LOST, "clientLaunchId", sent)
    // Named once: a second wrap would repeat the SDK's sentence.
    expect(wrapped.message.split("may or may not have reached Candle").length).toBe(2)
  })

  test("a failure at signing, after the build, carries both ids", async () => {
    const server = atomicServer({
      build: () =>
        json(200, {
          bundleId: "bundle-linked",
          legs: [
            { index: 0, role: "launch", signer: "client", unsignedTxBase64: "AQADunsigned" },
            { index: 1, role: "buy", signer: "server" },
          ],
          expiresAt: 1692345678000,
        }),
    })
    // No secretStore: signLinkedTransaction() throws a plain Error after the build answered.
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl, privyAppId: "app-test-123" })
    const error = await caught(
      client.launchAtomic({
        ...REQ,
        payer: { type: "linked", linkedWalletId: LINKED_WALLET_ID, privyWalletId: PRIVY_WALLET_ID },
      }),
    )
    expect(error).toBeInstanceOf(CandleOperationError)
    expect(operationIds(error)).toEqual({ clientLaunchId: String(server.builtIds[0]), bundleId: "bundle-linked" })
    expect((error as CandleOperationError).message).toContain("requires a secretStore")
    expect(server.calls.length).toBe(1) // nothing was submitted
  })
})

// ---------------------------------------------------------------------------------------------
// operationIds(), the exports, getTradeJob()
// ---------------------------------------------------------------------------------------------

describe("operationIds()", () => {
  test("T18: reads the ids from each error class, and {} from an unrelated error or a non-object", () => {
    const api = Object.assign(new CandleApiError({ code: "X", message: "m", status: 500, retryable: false }), {
      clientLaunchId: "launch-1",
      bundleId: "bundle-1",
    })
    expect(operationIds(api)).toEqual({ clientLaunchId: "launch-1", bundleId: "bundle-1" })

    const rpc = Object.assign(new JsonRpcError({ code: -32002, message: "m" }), { clientTradeId: "trade-1" })
    expect(operationIds(rpc)).toEqual({ clientTradeId: "trade-1" })

    const feeLeg = new TradeLandedFeeLegError({
      clientTradeId: "trade-2",
      tradeTxHash: "0xabc",
      cause: new Error("fee failed"),
      feeOutcome: "not-broadcast",
    })
    expect(operationIds(feeLeg)).toEqual({ clientTradeId: "trade-2" })

    const wrapped = new CandleOperationError({
      cause: new TypeError(LOST),
      ids: { clientLaunchId: "launch-2", bundleId: "bundle-2" },
      flow: "server-executed",
    })
    expect(operationIds(wrapped)).toEqual({ clientLaunchId: "launch-2", bundleId: "bundle-2" })

    // An API error that never left a one-call method has no id.
    expect(operationIds(new CandleApiError({ code: "X", message: "m", status: 500, retryable: false }))).toEqual({})
    // Anything else is {}: an unrelated error, even one that happens to have the property, and non-objects.
    expect(operationIds(new Error("unrelated"))).toEqual({})
    expect(operationIds(Object.assign(new Error("unrelated"), { clientTradeId: "not-ours" }))).toEqual({})
    expect(operationIds(new TypeError(LOST))).toEqual({})
    expect(operationIds({ clientTradeId: "plain-object" })).toEqual({})
    expect(operationIds("a string")).toEqual({})
    expect(operationIds(42)).toEqual({})
    expect(operationIds(null)).toEqual({})
    expect(operationIds(undefined)).toEqual({})
  })
})

describe("the package root", () => {
  test("T19: the new names import from the package root", () => {
    expect(typeof CandleOperationError).toBe("function")
    expect(typeof operationIds).toBe("function")
    expect(typeof CandleClient.prototype.getTradeJob).toBe("function")
    // The type-only names: these lines compile only if the root exports them.
    const ids: OperationIds = { clientTradeId: "t", clientLaunchId: "l", bundleId: "b" }
    const result: LaunchAtomicResult = { status: "failed", bundleId: "b", retryable: false, clientLaunchId: "l" }
    const job: Pick<TradeJob, "clientTradeId" | "status"> = { clientTradeId: "t", status: "confirmed" }
    expect(ids.bundleId).toBe("b")
    expect(result.clientLaunchId).toBe("l")
    expect(job.status).toBe("confirmed")
    // An error from the SDK is a CandleOperationError at the root too.
    expect(new CandleOperationError({ cause: "x", ids, flow: "caller-broadcast" })).toBeInstanceOf(Error)
  })
})

describe("getTradeJob()", () => {
  const JOB: TradeJob = {
    clientTradeId: "trade/with space",
    chain: "solana",
    side: "buy",
    mint: "Mint111",
    quoteAsset: "sol",
    amountRaw: "1000000",
    status: "confirmed",
    signature: "Sig111",
    createdAt: 1,
    updatedAt: 2,
  }

  test("T20: GET /api/v1/trade/agent/jobs/{clientTradeId} with the key, returning the unwrapped job", async () => {
    const server = fakeServer(() => json(200, { success: true, job: JOB }))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const job = await client.getTradeJob("trade/with space")
    expect(job).toEqual(JOB)
    expect(server.calls.length).toBe(1)
    expect(server.calls[0]?.url).toBe(`${API}/api/v1/trade/agent/jobs/trade%2Fwith%20space`)
    expect(server.calls[0]?.method).toBe("GET")
    expect(server.calls[0]?.headers).toEqual({ "x-api-key": "k" })
    expect(server.calls[0]?.body).toBeUndefined()
  })

  test("T20: a missing row throws CandleApiError JOB_NOT_FOUND, with no id attached to a plain read", async () => {
    const server = fakeServer(() =>
      envelope(404, "JOB_NOT_FOUND", { message: "No trade with that clientTradeId for this account" }),
    )
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.getTradeJob("never-began"))
    expect(error).toBeInstanceOf(CandleApiError)
    expect((error as CandleApiError).code).toBe("JOB_NOT_FOUND")
    expect((error as CandleApiError).status).toBe(404)
    expect(operationIds(error)).toEqual({})
  })

  test("T20: it refuses to fetch without an API key", async () => {
    const server = fakeServer(() => json(200, { success: true, job: JOB }))
    const client = new CandleClient({ apiUrl: API, fetch: server.impl })
    const error = await caught(client.getTradeJob("t"))
    expect((error as Error).message).toContain("getTradeJob() requires an apiKey")
    expect(server.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Edge cases the spec names in section 7
// ---------------------------------------------------------------------------------------------

describe("edge cases", () => {
  const TRADE_REQ = { mint: "Mint111", side: "buy" as const, amountRaw: "1000000", from: "main" as const }

  test("a thrown value that is not an Error is wrapped, so the id is never lost to a throw of a string", async () => {
    const calls: unknown[] = []
    const impl = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      throw "socket closed"
    }) as unknown as typeof fetch
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: impl })
    const error = await caught(client.trade(TRADE_REQ))
    const sent = String((calls[0] as { clientTradeId?: string }).clientTradeId)
    expect(error).toBeInstanceOf(CandleOperationError)
    const wrapped = error as CandleOperationError
    expect(wrapped.cause).toBe("socket closed")
    expect(wrapped.clientTradeId).toBe(sent)
    expectServerExecutedMessage(wrapped, "socket closed", "clientTradeId", sent)
  })

  test("a 2xx body that is not JSON is wrapped, with the parse error as cause", async () => {
    const server = fakeServer(() => new Response("<html>ok</html>", { status: 200 }))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade({ ...TRADE_REQ, clientTradeId: "mine-3" }))
    expect(error).toBeInstanceOf(CandleOperationError)
    expect((error as CandleOperationError).cause).toBeInstanceOf(SyntaxError)
    expect(operationIds(error)).toEqual({ clientTradeId: "mine-3" })
  })

  test("a main-payer build that answers 'built' is a plain Error from the method's own step, wrapped with the id", async () => {
    const server = fakeServer((call) =>
      json(200, { success: true, status: "built", clientTradeId: call.body?.clientTradeId, chain: "solana" }),
    )
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade({ ...TRADE_REQ, clientTradeId: "mine-4" }))
    expect(error).toBeInstanceOf(CandleOperationError)
    expect((error as CandleOperationError).message).toContain("expected an executed result")
    expect(operationIds(error)).toEqual({ clientTradeId: "mine-4" })
  })

  test("a body that cannot be serialized throws before anything is sent: no fetch, no id, not wrapped", async () => {
    const server = fakeServer(() => json(200, {}))
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    const error = await caught(client.trade({ ...TRADE_REQ, amountRaw: 10n as unknown as string }))
    expect(server.calls.length).toBe(0)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(CandleOperationError)
    expect(operationIds(error)).toEqual({})
  })

  test("the SDK remembers nothing between calls: after a lost response, a call with no id is a new id", async () => {
    const ids: string[] = []
    const server = fakeServer((call, n) => {
      ids.push(String(call.body?.clientTradeId))
      if (n === 1) throw new TypeError(LOST)
      return json(200, { success: true, status: "executed", clientTradeId: call.body?.clientTradeId, chain: "solana" })
    })
    const client = new CandleClient({ apiUrl: API, apiKey: "k", fetch: server.impl })
    await caught(client.trade(TRADE_REQ))
    await client.trade(TRADE_REQ)
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })
})
