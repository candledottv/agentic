import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

const mint = "11111111111111111111111111111111"

const card = {
  chain: "solana",
  mint,
  generatedAt: 1761652800000,
  identity: { name: "Cuzco the Goat", symbol: "CUZCO", launchpad: "pump.fun", isCandle: false },
  market: {
    priceUsd: 0.000018,
    marketCapUsd: 18200,
    liquidityUsd: 9100,
    change5mPct: -14,
    volume5mUsd: 5200,
    buys5m: 31,
    sells5m: 29,
    updatedAt: 1761652790000,
  },
  ath: null,
  forensics: { state: "not_covered", coverage: { covered: false } },
  events: { state: "ok", windowMinutes: 60, trackedBuys: 2, trackedSells: 1, signals: 0, callouts: 0, names: [] },
  hacc: { state: "off" },
  sameName: { state: "off" },
  sources: { identity: "candle feed", market: "candle feed" },
  links: { token: `https://candle.tv/token/${mint}` },
}

function cardFixture(status = 200, body: unknown = { success: true, card }, apiKey?: string) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new CandleClient({
    apiUrl: "http://localhost",
    ...(apiKey ? { apiKey } : {}),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json(body, { status })
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

test("getTokenCard reads the public card route, unwraps the card and sends no key by default", async () => {
  const { client, calls } = cardFixture()
  const read = await client.getTokenCard("solana", mint)
  expect(calls[0]?.url).toBe(`http://localhost/api/v1/tokens/solana/${mint}/card`)
  expect(calls[0]?.init?.method).toBe("GET")
  expect(new Headers(calls[0]?.init?.headers).has("x-api-key")).toBe(false)
  expect(read).toEqual(card as unknown as typeof read)
  expect(read.market.marketCapUsd).toBe(18200)
  expect(read.ath).toBeNull()
})

test("a card source tag travels as cst, encoded; no tag sends no query", async () => {
  const { client, calls } = cardFixture()
  await client.getTokenCard("hood", "0x1234567890123456789012345678901234567890", { tag: "v1.-100123.p1.c1" })
  const url = new URL(calls[0]?.url ?? "")
  expect(url.pathname).toBe("/api/v1/tokens/hood/0x1234567890123456789012345678901234567890/card")
  expect(url.searchParams.get("cst")).toBe("v1.-100123.p1.c1")
  expect([...url.searchParams.keys()]).toEqual(["cst"])
})

test("a switched-off route raises the API's own error code", async () => {
  const { client } = cardFixture(503, {
    success: false,
    error: { code: "TOKEN_CARD_DISABLED", message: "The token card is switched off.", retryable: false },
  })
  try {
    await client.getTokenCard("solana", mint)
    throw new Error("expected refusal")
  } catch (e) {
    expect(e).toBeInstanceOf(CandleApiError)
    expect((e as CandleApiError).code).toBe("TOKEN_CARD_DISABLED")
  }
})
