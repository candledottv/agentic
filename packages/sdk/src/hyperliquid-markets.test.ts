import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CandleClient } from "./client"
import {
  PERPS_CANDLE_INTERVALS,
  type PerpsMarketFetch,
  PerpsMarketReader,
  perpsCandleWindow,
} from "./hyperliquid-markets"

const NOW = 1_792_267_200_000
const context = {
  markPx: "100",
  midPx: "100",
  oraclePx: "99",
  openInterest: "10000",
  funding: "0.0000125",
  dayNtlVlm: "2000000",
  prevDayPx: "80",
  impactPxs: ["99", "101"],
  premium: "0.001",
}
function fixtures() {
  return {
    metaAndAssetCtxs: [
      {
        universe: [
          { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
          { name: "kPEPE", szDecimals: 0, maxLeverage: 10, onlyIsolated: true },
          { name: "DELIST", szDecimals: 1, maxLeverage: 3, isDelisted: true },
          { name: "TINY", szDecimals: 2, maxLeverage: 5 },
        ],
        marginTables: [
          [
            56,
            {
              marginTiers: [
                { lowerBound: "0.0", maxLeverage: 40 },
                { lowerBound: "150000000.0", maxLeverage: 20 },
              ],
            },
          ],
        ],
      },
      [context, { ...context, dayNtlVlm: "3000000", funding: "-0.00002" }, context, { ...context, openInterest: "1" }],
    ],
    predictedFundings: [
      [
        "BTC",
        [
          ["BinPerp", { fundingRate: "99", nextFundingTime: NOW }],
          ["HlPerp", { fundingRate: "0.0000125", nextFundingTime: NOW + 3600000 }],
        ],
      ],
    ],
    perpsAtOpenInterestCap: ["BTC"],
    l2Book: {
      coin: "BTC",
      time: NOW,
      levels: [
        [
          { px: "99", sz: "2", n: 1 },
          { px: "98", sz: "3", n: 2 },
        ],
        [
          { px: "101", sz: "4", n: 1 },
          { px: "102", sz: "5", n: 2 },
        ],
      ],
    },
    candleSnapshot: Array.from({ length: 4 }, (_, i) => ({
      t: NOW - (4 - i) * 3600000,
      T: NOW - (3 - i) * 3600000 - 1,
      s: "BTC",
      i: "1h",
      o: "90",
      h: "101",
      l: "89",
      c: "100",
      v: "12.3",
      n: 10,
    })),
  } as Record<string, unknown>
}
function fake(
  overrides: Record<string, unknown> = {},
  config: unknown = { network: "mainnet", limits: { minOpenInterestUsd: 1_000_000 } },
  key: string | undefined = "key",
) {
  const data = { ...fixtures(), ...overrides }
  const calls: { url: string; body?: Record<string, unknown>; init?: RequestInit }[] = []
  let configCalls = 0
  let clock = NOW
  const fetcher: PerpsMarketFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ url, body, init })
    const value = data[body.type]
    if (value instanceof Error) throw value
    return new Response(JSON.stringify(value), { status: value === "HTTP_ERROR" ? 429 : 200 })
  }
  const reader = new PerpsMarketReader({
    apiKey: key,
    network: "mainnet",
    fetcher,
    now: () => clock,
    readConfig: async () => {
      configCalls++
      if (config instanceof Error) throw config
      return config
    },
  })
  return {
    reader,
    calls,
    fetcher,
    data,
    configCalls: () => configCalls,
    tick: (n: number) => {
      clock += n
    },
  }
}
describe("Spec B public market reads", () => {
  test("AC1/2 fields, volume default, all, filters and sorts", async () => {
    const f = fake()
    const result = await f.reader.markets()
    expect(result.markets.map((row) => row.coin)).toEqual(["kPEPE", "BTC"])
    expect(result.markets[1]).toEqual({
      coin: "BTC",
      asset: 0,
      markPx: "100",
      midPx: "100",
      oraclePx: "99",
      fundingRate: "0.0000125",
      fundingAprPct: "10.95",
      predictedFundingRate: "0.0000125",
      nextFundingTime: NOW + 3600000,
      openInterest: "10000",
      openInterestUsd: "1000000.00",
      dayNotionalVolumeUsd: "2000000",
      prevDayPx: "80",
      change24hPct: "25.0",
      maxLeverage: 40,
      onlyIsolated: false,
      isDelisted: false,
      atOpenInterestCap: true,
      candle: { tradeable: true, reason: null },
    })
    const all = await f.reader.markets({ all: true, sort: "name" })
    expect(all.markets.map((row) => [row.coin, row.candle.reason])).toEqual([
      ["BTC", null],
      ["DELIST", "delisted"],
      ["TINY", "minOpenInterest"],
      ["kPEPE", null],
    ])
    for (const sort of ["volume", "oi", "funding", "change", "name"] as const)
      expect((await f.reader.markets({ all: true, sort, limit: 1 })).markets).toHaveLength(1)
    expect((await f.reader.markets({ sort: "funding" })).markets.map((row) => row.coin)).toEqual(["BTC", "kPEPE"])
  })
  test("missing mark remains visible under all, null mid falls back for gate, zero previous day has no change", async () => {
    const data = fixtures().metaAndAssetCtxs as [unknown, Record<string, unknown>[]]
    data[1][0] = { ...context, markPx: null, prevDayPx: "0" }
    data[1][1] = { ...context, midPx: null, prevDayPx: "0" }
    const f = fake({ metaAndAssetCtxs: data })
    const rows = await f.reader.markets({ all: true })
    expect(rows.markets.find((row) => row.coin === "BTC")).toMatchObject({
      markPx: null,
      openInterestUsd: null,
      change24hPct: null,
      candle: { tradeable: false, reason: "noPrice" },
    })
    expect(rows.markets.find((row) => row.coin === "kPEPE")).toMatchObject({
      midPx: null,
      change24hPct: null,
      candle: { tradeable: true, reason: null },
    })
  })
  test("AC4 tiers, impact, case resolution, fallback tier", async () => {
    const { reader } = fake()
    const { market } = await reader.market("btc")
    expect(market).toMatchObject({
      coin: "BTC",
      asset: 0,
      szDecimals: 5,
      maxPriceDecimals: 1,
      priceRule: "at most 5 significant figures",
      minOrderUsd: 10,
      impactBidPx: "99",
      impactAskPx: "101",
      premium: "0.001",
      marginTiers: [
        { lowerBoundUsd: "0.0", maxLeverage: 40 },
        { lowerBoundUsd: "150000000.0", maxLeverage: 20 },
      ],
    })
    expect((await reader.market("kpepe")).market).toMatchObject({
      coin: "kPEPE",
      onlyIsolated: true,
      marginTiers: [{ lowerBoundUsd: "0", maxLeverage: 10 }],
    })
    for (const coin of ["NOPE", "dex:BTC", "@1", "", "BTC\n"])
      await expect(reader.market(coin)).rejects.toMatchObject({ code: "PERPS_MARKET_NOT_FOUND" })
  })
  test("AC4 exact wins; ambiguous folded match fails", async () => {
    const data = fixtures().metaAndAssetCtxs as [{ universe: { name: string }[] }, unknown[]]
    data[0].universe[1]!.name = "btc"
    const { reader } = fake({ metaAndAssetCtxs: data })
    expect((await reader.market("BTC")).market.asset).toBe(0)
    await expect(reader.market("bTc")).rejects.toMatchObject({ code: "PERPS_MARKET_NOT_FOUND" })
  })
  test("AC5 book precision, depth and request; book itself is never cached", async () => {
    const f = fake()
    const result = await f.reader.book("btc", { depth: 1, sigFigs: 3 })
    expect(result).toMatchObject({
      coin: "BTC",
      bids: [{ px: "99", sz: "2", n: 1 }],
      asks: [{ px: "101", sz: "4", n: 1 }],
      spreadPx: "2",
      midPx: "100",
      spreadBps: "200.00",
    })
    expect(f.calls.at(-1)?.body).toEqual({ type: "l2Book", coin: "BTC", nSigFigs: 3 })
    await f.reader.book("BTC")
    expect(f.calls.filter((c) => c.body?.type === "l2Book")).toHaveLength(2)
    expect(f.calls.some((c) => c.body?.type === "predictedFundings")).toBe(false)
  })
  test("empty book sides give null spread; unknown coin never reaches book/candles", async () => {
    const f = fake({ l2Book: { coin: "BTC", time: NOW, levels: [[], []] } })
    expect(await f.reader.book("BTC")).toMatchObject({
      bids: [],
      asks: [],
      spreadPx: null,
      spreadBps: null,
      midPx: null,
    })
    await expect(f.reader.book("NOPE")).rejects.toMatchObject({ code: "PERPS_MARKET_NOT_FOUND" })
    await expect(f.reader.candles("NOPE")).rejects.toMatchObject({ code: "PERPS_MARKET_NOT_FOUND" })
    expect(f.calls.filter((c) => c.body?.type === "l2Book")).toHaveLength(1)
    expect(f.calls.some((c) => c.body?.type === "candleSnapshot")).toBe(false)
  })
  test("AC6 all intervals and calendar-month window, limits and bad end", async () => {
    const minutes = [1, 3, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 4320, 10080, 44640]
    for (const [index, interval] of PERPS_CANDLE_INTERVALS.entries()) {
      const w = perpsCandleWindow({ interval, count: 2 }, NOW)
      expect(w.endTime).toBe(NOW)
      expect(w.startTime).toBe(NOW - 2 * (minutes[index] as number) * 60000)
    }
    expect(perpsCandleWindow({ interval: "1M", count: 2, end: String(NOW) }, NOW).startTime).toBe(NOW - 62 * 86400000)
    expect(perpsCandleWindow({ end: new Date(NOW).toISOString() }, NOW).endTime).toBe(NOW)
    for (const opts of [
      { count: 5001 },
      { count: 0 },
      { count: 1.2 },
      { interval: "2M" },
      { end: "nope" },
      { end: NOW + 1 },
      { end: "yesterday" },
    ])
      expect(() => perpsCandleWindow(opts, NOW)).toThrow()
    expect(perpsCandleWindow({ count: 5000 }, NOW).count).toBe(5000)
  })
  test("AC6 newest count, chronological, request window, no cache", async () => {
    const f = fake()
    const result = await f.reader.candles("btc", { count: 2 })
    expect(result.candles.map((c) => c.t)).toEqual([NOW - 2 * 3600000, NOW - 3600000])
    expect(f.calls.at(-1)?.body).toEqual({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1h", startTime: NOW - 2 * 3600000, endTime: NOW },
    })
    await f.reader.candles("BTC", { count: 100 })
    expect(f.calls.filter((c) => c.body?.type === "candleSnapshot")).toHaveLength(2)
  })
  test("AC7 only public info URLs, no credentials; 5s timeout on each HL request", async () => {
    const f = fake()
    await f.reader.markets()
    await f.reader.book("BTC")
    await f.reader.candles("BTC")
    for (const call of f.calls) {
      expect(call.url).toBe("https://api.hyperliquid.xyz/info")
      expect(call.init?.headers).toEqual({ "Content-Type": "application/json" })
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      expect(call.init?.redirect).toBe("error")
    }
  })
  for (const value of [new Error("down"), "HTTP_ERROR", {}, [[], []], [{ universe: [] }, [{}]]])
    test(`AC8 core failure ${JSON.stringify(value)}`, async () => {
      await expect(fake({ metaAndAssetCtxs: value }).reader.markets()).rejects.toMatchObject({
        code: "PERPS_UNAVAILABLE",
        retryable: true,
      })
    })
  test("AC8 degraded optional reads and default config", async () => {
    const f = fake({ predictedFundings: new Error("down"), perpsAtOpenInterestCap: {} }, new Error("config"))
    const result = await f.reader.markets()
    expect(result.gate).toEqual({ source: "default", minOpenInterestUsd: 1_000_000 })
    expect(result.warnings).toHaveLength(3)
    expect(result.markets[0]).toMatchObject({
      predictedFundingRate: null,
      nextFundingTime: null,
      atOpenInterestCap: null,
    })
    await f.reader.market("BTC")
    expect(f.configCalls()).toBe(1)
  })
  test("AC8 server/client network mismatch makes tradeability unknown", async () => {
    const f = fake({}, { network: "testnet", limits: { minOpenInterestUsd: 0 } })
    const result = await f.reader.markets({ all: true })
    expect(
      result.markets.every((row) => row.candle.tradeable === null && row.candle.reason === "networkMismatch"),
    ).toBe(true)
    expect(result.warnings).toHaveLength(1)
  })
  test("AC9 keyless fails every read before any request", async () => {
    const f = fake({}, undefined, "")
    for (const read of [
      () => f.reader.markets(),
      () => f.reader.market("BTC"),
      () => f.reader.book("BTC"),
      () => f.reader.candles("BTC"),
    ])
      await expect(read()).rejects.toMatchObject({ code: "PERPS_KEY_REQUIRED" })
    expect(f.calls).toHaveLength(0)
    expect(f.configCalls()).toBe(0)
  })
  test("5s cache coalesces concurrent reads, expires and does not cache core failures", async () => {
    const f = fake()
    await Promise.all([f.reader.markets(), f.reader.market("BTC")])
    expect(f.calls).toHaveLength(3)
    expect(f.configCalls()).toBe(1)
    f.tick(4999)
    expect((await f.reader.markets()).readAt).toBe(NOW)
    expect(f.calls).toHaveLength(3)
    f.tick(1)
    await f.reader.markets()
    expect(f.calls).toHaveLength(6)
    const g = fake({ metaAndAssetCtxs: new Error("down") })
    await expect(g.reader.markets()).rejects.toThrow()
    g.data.metaAndAssetCtxs = fixtures().metaAndAssetCtxs
    expect((await g.reader.markets()).markets).toHaveLength(2)
  })
  test("AC14 recorded live shapes parse, match universe count and margin tiers", async () => {
    const data = Object.fromEntries(
      ["metaAndAssetCtxs", "predictedFundings", "perpsAtOpenInterestCap", "l2Book", "candleSnapshot"].map((type) => [
        type,
        JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/hyperliquid-markets", `${type}.json`), "utf8")),
      ]),
    )
    const f = fake(data)
    const rows = await f.reader.markets({ all: true })
    expect(rows.markets).toHaveLength(234)
    expect((await f.reader.market("BTC")).market.marginTiers.length).toBeGreaterThan(1)
    expect((await f.reader.book("BTC")).bids).toHaveLength(20)
    expect((await f.reader.candles("BTC")).candles.length).toBeGreaterThan(0)
  })
  test("AC12 SDK methods: config is the only Candle path, key never goes to HL, testnet works", async () => {
    const f = fake()
    const urls: string[] = []
    const client = new CandleClient({
      apiUrl: "https://candle.test",
      apiKey: "key",
      hyperliquidNetwork: "testnet",
      fetch: (async (url, init) => {
        urls.push(String(url))
        if (String(url).startsWith("https://candle.test")) {
          expect(init?.headers).toMatchObject({ "x-api-key": "key" })
          return new Response(JSON.stringify({ network: "testnet", limits: { minOpenInterestUsd: 0 } }))
        }
        return f.fetcher(String(url), init)
      }) as typeof fetch,
    })
    expect((await client.perpsMarkets()).network).toBe("testnet")
    expect((await client.perpsMarket("BTC")).market.coin).toBe("BTC")
    await client.perpsBook("BTC")
    await client.perpsCandles("BTC")
    expect(urls.filter((u) => u.startsWith("https://candle.test"))).toEqual([
      "https://candle.test/api/v1/agent/perps/config",
    ])
    expect(
      urls
        .filter((u) => !u.startsWith("https://candle.test"))
        .every((u) => u === "https://api.hyperliquid-testnet.xyz/info"),
    ).toBe(true)
    const keyless = new CandleClient({
      apiUrl: "https://candle.test",
      fetch: (() => {
        throw new Error("must not fetch")
      }) as unknown as typeof fetch,
    })
    await expect(keyless.perpsMarkets()).rejects.toMatchObject({ code: "PERPS_KEY_REQUIRED" })
  })
})
