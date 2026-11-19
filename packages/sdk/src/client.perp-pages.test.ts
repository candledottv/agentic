import { expect, test } from "bun:test"
import { CandleClient } from "./client"

const PROFILE = "prof_0123456789abcdef"
function recorder(answer: unknown) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init })
    return Response.json(answer)
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

test("getAgentPerpRound returns the round without success", async () => {
  const { calls, fetcher } = recorder({
    success: true,
    round: { id: "rnd_0123456789abcdef", coin: "xyz:TSLA" },
    seq: 4,
  })
  const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "fixture-key", fetch: fetcher })
  const round = await client.getAgentPerpRound(PROFILE, "open:xyz:TSLA")
  expect(round).toEqual({ id: "rnd_0123456789abcdef", coin: "xyz:TSLA", seq: 4 } as never)
  expect(calls[0]?.url.pathname).toBe(`/api/v1/agent/records/${PROFILE}/perps/rounds/open%3Axyz%3ATSLA`)
})

test("getAgentOpenOrders returns the orders; getPerpCandles encodes a dex coin and forwards the knobs", async () => {
  const orders = recorder({ success: true, orders: [], readAt: 1, stale: false, dexes: [] })
  const a = new CandleClient({ apiUrl: "https://api.test", fetch: orders.fetcher })
  expect(await a.getAgentOpenOrders(PROFILE)).toEqual({ orders: [], readAt: 1, stale: false, dexes: [] })
  expect(orders.calls[0]?.url.pathname).toBe(`/api/v1/agent/records/${PROFILE}/open-orders`)
  const candles = recorder({ success: true, coin: "xyz:TSLA", interval: "4h", candles: [], readAt: 1, stale: false })
  const b = new CandleClient({ apiUrl: "https://api.test", fetch: candles.fetcher })
  await b.getPerpCandles("xyz:TSLA", { interval: "4h", count: 50, end: 99 })
  expect(`${candles.calls[0]?.url.pathname}${candles.calls[0]?.url.search}`).toBe(
    "/api/v1/agent/perps-candles/xyz%3ATSLA?interval=4h&count=50&end=99",
  )
})

test("getPerpMarket reads the public market route, encodes a dex coin and drops success", async () => {
  const market = recorder({ success: true, market: { coin: "xyz:TSLA" }, agents: null, agentsUnavailable: true })
  const client = new CandleClient({ apiUrl: "https://api.test", fetch: market.fetcher })
  const answer = await client.getPerpMarket("xyz:TSLA")
  expect(market.calls[0]?.url.pathname).toBe("/api/v1/agent/perps-markets/xyz%3ATSLA")
  expect(answer).toEqual({ market: { coin: "xyz:TSLA" }, agents: null, agentsUnavailable: true } as never)
})
