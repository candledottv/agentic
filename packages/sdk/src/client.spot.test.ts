/**
 * BE-4216 (BE-4165 slice 02): the SDK client's Hyperliquid spot methods. Every order and cancel is
 * checked against this machine's own `spotMetaAndAssetCtxs` read (`verifySpotBuildAgainstVenue`,
 * faked here from the captured mainnet fixture) before the relay is asked to sign; a refused build
 * makes no relay call and no submit.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CandleClient, type PerpsBuild } from "./client"
import { hyperliquidActionHash, hyperliquidL1TypedData } from "./hyperliquid"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const WALLET = "wallet-123"
const PRIVY_WALLET = "privy-wallet-123"
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
const NONCE = 1_790_000_000_000
const CLOID = `0x${"1".repeat(32)}`
const INFO = "https://api.hyperliquid.xyz/info"
const EXCHANGE = "https://api.hyperliquid.xyz/exchange"

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "hyperliquid-spot.fixture.json"), "utf8")) as {
  meta: unknown
  ctxs: unknown[]
}
const SPOT = [fixture.meta, fixture.ctxs]

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Recorded {
  url: string
  body?: Record<string, unknown>
}

/**
 * Candle's answers are queued per path; Hyperliquid's `/info` answers from the fixture (and the
 * given `orderStatus`), the relay signs, and the exchange accepts.
 */
async function client(candle: Record<string, unknown>, opts: { orderStatus?: unknown } = {}) {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set(WALLET, privateKeyPem)
  const calls: Recorded[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ url, ...(body ? { body } : {}) })
    if (url === INFO) {
      if (body?.type === "spotMetaAndAssetCtxs") return json(200, SPOT)
      if (body?.type === "orderStatus") return json(200, opts.orderStatus ?? { status: "unknownOid" })
      return json(200, null)
    }
    if (url === EXCHANGE)
      return json(200, { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 77 } }] } } })
    if (url.endsWith(`/wallets/${WALLET}/sign`)) return json(200, { success: true, signature: SIGNATURE })
    const path = new URL(url).pathname
    if (path in candle) return json(200, candle[path])
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
  return {
    calls,
    client: new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "cndl_test_key",
      fetch: impl,
      privyAppId: "app-test",
      secretStore: store,
      hyperliquidBuilder: BUILDER,
    }),
  }
}

function spotBuild(action: Record<string, unknown>, over: Partial<PerpsBuild> = {}): PerpsBuild {
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: action.type === "cancel" ? "spotCancel" : "spotOrder",
    network: "mainnet",
    walletId: WALLET,
    address: ADDRESS,
    nonce: NONCE,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
    claimHash: "h",
    cloid: CLOID,
    notionalUsdMicros: 69_488_000,
    reservedUsdMicros: 69_488_000,
    windowKey: "daily:1",
    builder: null,
    exchangeUrl: "https://evil.example/exchange",
    preview: {
      venue: "hyperliquid-spot",
      builderFee: { address: null, feeTenthsBps: 0, feePct: "0", reason: "not charged on spot buys" },
    },
    ...over,
  }
}

// HYPE/USDC is `@107` (asset 10107) in the fixture; its mid there is about 69.
const buyOrder = { a: 10_107, b: true, p: "69.488", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }
const buyAction = { type: "order", orders: [buyOrder], grouping: "na" }
const BUY = { walletId: WALLET, privyWalletId: PRIVY_WALLET, market: "HYPE/USDC", side: "buy" as const, size: "1" }
const sellOrder = { ...buyOrder, b: false, p: "69", t: { limit: { tif: "Gtc" } } }
const sellAction = { type: "order", orders: [sellOrder], grouping: "na", builder: { b: BUILDER, f: 100 } }
const SELL = {
  walletId: WALLET,
  privyWalletId: PRIVY_WALLET,
  market: "@107",
  side: "sell" as const,
  size: "1",
  price: "69",
}

const ORDER_PATH = "/api/v1/agent/perps/spot/order"
const CANCEL_PATH = "/api/v1/agent/perps/spot/cancel"

describe("perpsSpotOrder: build, venue check, sign, submit", () => {
  test("a market buy that passes the venue check is signed through the relay and posted to Hyperliquid", async () => {
    const build = spotBuild(buyAction)
    const { client: c, calls } = await client({ [ORDER_PATH]: build })
    const result = await c.perpsSpotOrder(BUY)
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.test${ORDER_PATH}`,
      // This machine's own read of the pair, before anything is signed.
      INFO,
      `https://api.test/api/v1/agent/wallets/${WALLET}/sign`,
      // Never the server's exchangeUrl.
      EXCHANGE,
    ])
    expect(calls[0]?.body).toEqual({ walletId: WALLET, market: "HYPE/USDC", side: "buy", size: "1" })
    expect(calls[1]?.body).toEqual({ type: "spotMetaAndAssetCtxs" })
    expect((calls[2]?.body as { body: unknown }).body).toEqual({
      method: "eth_signTypedData_v4",
      params: { typed_data: build.typedData },
    })
    expect(calls[3]?.body).toMatchObject({ action: buyAction, nonce: NONCE })
    expect(result).toMatchObject({ signature: SIGNATURE, submitted: true, outcome: { status: "confirmed" } })
    expect((result as { build: PerpsBuild }).build.preview.builderFee).toMatchObject({ feeTenthsBps: 0 })
  })

  test("a limit sell carrying Candle's builder passes and is signed and submitted", async () => {
    const build = spotBuild(sellAction, { builder: { address: BUILDER, feeTenthsBps: 100 } })
    const { client: c, calls } = await client({ [ORDER_PATH]: build })
    const result = await c.perpsSpotOrder(SELL)
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.test${ORDER_PATH}`,
      INFO,
      `https://api.test/api/v1/agent/wallets/${WALLET}/sign`,
      EXCHANGE,
    ])
    expect(calls[0]?.body).toEqual({ walletId: WALLET, market: "@107", side: "sell", size: "1", price: "69" })
    expect(result).toMatchObject({ submitted: true, outcome: { status: "confirmed" } })
  })

  test("submit: false checks the build and stops: no relay call, no submit", async () => {
    const { client: c, calls } = await client({ [ORDER_PATH]: spotBuild(buyAction) })
    const result = await c.perpsSpotOrder({ ...BUY, submit: false })
    expect(calls.map((call) => call.url)).toEqual([`https://api.test${ORDER_PATH}`, INFO])
    expect(result).toMatchObject({ signature: null, submitted: false })
  })

  test("refuses before signing: another pair's asset, a builder field on a buy, a grouping", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...buyAction, orders: [{ ...buyOrder, a: 10_142 }] }, "not the requested pair's"],
      [{ ...buyAction, builder: { b: BUILDER, f: 100 } }, "no builder field"],
      [{ ...buyAction, grouping: "normalTpsl" }, "exactly one order with no grouping"],
    ]
    for (const [action, reason] of cases) {
      const { client: c, calls } = await client({ [ORDER_PATH]: spotBuild(action) })
      const err = await c.perpsSpotOrder(BUY).catch((e: unknown) => e as Error)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("refused to sign")
      expect((err as Error).message).toContain(reason)
      expect(calls.some((call) => call.url.endsWith("/sign"))).toBe(false)
      expect(calls.some((call) => call.url === EXCHANGE)).toBe(false)
    }
  })

  test("a reduce-only key's buy build is refused before signing", async () => {
    const { client: c, calls } = await client({ [ORDER_PATH]: spotBuild(buyAction, { perpsReduceOnly: true }) })
    await expect(c.perpsSpotOrder(BUY)).rejects.toThrow("reduce-only")
    expect(calls.some((call) => call.url.endsWith("/sign"))).toBe(false)
  })

  test("a client id is sent lowercased, and a replay of it returns the original operation unsigned", async () => {
    const clientId = `0x${"AB".repeat(16)}`
    const replay = {
      success: true,
      replayed: true,
      perpOrderId: "perp-1",
      kind: "spotOrder",
      network: "mainnet",
      walletId: WALLET,
      address: ADDRESS,
      clientId: clientId.toLowerCase(),
      cloid: clientId.toLowerCase(),
      childCloids: [],
      nonce: NONCE,
      status: "settled",
      venueStatus: "filled",
      filledSz: "1",
      notionalUsdMicros: 69_488_000,
      builtAt: 1,
      settledAt: 2,
      preview: null,
    }
    const { client: c, calls } = await client({ [ORDER_PATH]: replay })
    const result = await c.perpsSpotOrder({ ...BUY, clientId })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ clientId: clientId.toLowerCase() })
    expect(result).toMatchObject({ replayed: true, build: null, signature: null, submitted: false })
  })

  test('walletId "embedded" is refused without any request', async () => {
    const { client: c, calls } = await client({})
    await expect(c.perpsSpotOrder({ ...BUY, walletId: "embedded" })).rejects.toThrow("EVM TEE wallet")
    await expect(c.perpsSpotCancel({ walletId: "embedded", cloid: CLOID })).rejects.toThrow("EVM TEE wallet")
    await expect(c.perpsSpotBalances("embedded")).rejects.toThrow("EVM TEE wallet")
    expect(calls).toHaveLength(0)
  })
})

describe("perpsSpotCancel", () => {
  const cancelAction = { type: "cancel", cancels: [{ a: 10_107, o: 77 }] }
  const resting = { status: "order", order: { order: { coin: "@107", oid: 77 }, status: "open" } }

  test("a cancel of the order Hyperliquid shows for the cloid is checked, signed and submitted", async () => {
    const build = spotBuild(cancelAction, { cloid: undefined, targetCloid: CLOID, notionalUsdMicros: null })
    const { client: c, calls } = await client({ [CANCEL_PATH]: build }, { orderStatus: resting })
    const result = await c.perpsSpotCancel({ walletId: WALLET, privyWalletId: PRIVY_WALLET, cloid: CLOID })
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.test${CANCEL_PATH}`,
      INFO,
      INFO,
      `https://api.test/api/v1/agent/wallets/${WALLET}/sign`,
      EXCHANGE,
    ])
    expect(calls[0]?.body).toEqual({ walletId: WALLET, cloid: CLOID })
    expect(calls[1]?.body).toEqual({ type: "orderStatus", user: ADDRESS, oid: CLOID })
    expect(result).toMatchObject({ submitted: true })
  })

  test("a cancel naming another oid is refused before signing", async () => {
    const build = spotBuild({ type: "cancel", cancels: [{ a: 10_107, o: 78 }] })
    const { client: c, calls } = await client({ [CANCEL_PATH]: build }, { orderStatus: resting })
    await expect(c.perpsSpotCancel({ walletId: WALLET, cloid: CLOID })).rejects.toThrow("does not name the order")
    expect(calls.some((call) => call.url.endsWith("/sign"))).toBe(false)
  })

  test("a malformed cloid is refused without a request", async () => {
    const { client: c, calls } = await client({})
    await expect(c.perpsSpotCancel({ walletId: WALLET, cloid: "0x12" })).rejects.toThrow("cloid must be")
    expect(calls).toHaveLength(0)
  })
})

describe("perpsSpotMarkets and perpsSpotBalances", () => {
  test("read the spot routes with the given query", async () => {
    const markets = {
      success: true,
      network: "mainnet",
      minDayVolumeUsd: 100_000,
      quote: "USDC",
      count: 0,
      markets: [],
    }
    const balances = { success: true, walletId: WALLET, address: ADDRESS, network: "mainnet", balances: [] }
    const { client: c, calls } = await client({
      "/api/v1/agent/perps/spot/markets": markets,
      "/api/v1/agent/perps/spot/balances": balances,
    })
    expect(await c.perpsSpotMarkets()).toEqual(markets as never)
    expect(await c.perpsSpotMarkets({ all: true, limit: 10 })).toEqual(markets as never)
    expect(await c.perpsSpotBalances(WALLET)).toEqual(balances as never)
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/agent/perps/spot/markets",
      "https://api.test/api/v1/agent/perps/spot/markets?limit=10&all=true",
      `https://api.test/api/v1/agent/perps/spot/balances?walletId=${WALLET}`,
    ])
  })
})
