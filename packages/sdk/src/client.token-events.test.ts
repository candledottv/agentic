import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

const mint = "11111111111111111111111111111111"

function eventsFixture(status = 200, body?: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new CandleClient({
    apiUrl: "http://localhost",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json(
        body ?? {
          success: true,
          nextCursor: "cur-1",
          events: [
            {
              id: "trade:1",
              chain: "solana",
              mint,
              at: 1761652900000,
              kind: "trade",
              side: "sell",
              usd: 3000,
              tokenAmount: 62.5,
              priceUsd: 48,
              marketCapUsd: null,
              tx: "tx-1",
              result: "W",
              wallet: {
                address: "Wallet1111111111111111111111111111111111",
                name: "Starlight",
                walletKind: "smart",
                groups: [{ name: "winner", visibility: "public" }],
                image: null,
                isDev: false,
              },
            },
            {
              id: "signal:1",
              chain: "solana",
              mint,
              at: 1761652800000,
              kind: "signal",
              pattern: "dormant_buy",
              summary: "A wallet that had been quiet bought.",
              tx: null,
              wallet: null,
            },
          ],
        },
        { status },
      )
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

test("getTokenEvents maps the public route, unwraps the page and sends no key by default", async () => {
  const { client, calls } = eventsFixture()
  const page = await client.getTokenEvents("solana", mint)
  expect(calls[0]?.url).toBe(`http://localhost/api/v1/tokens/solana/${mint}/events`)
  expect(calls[0]?.init?.method).toBe("GET")
  expect(new Headers(calls[0]?.init?.headers).has("x-api-key")).toBe(false)
  expect(page.nextCursor).toBe("cur-1")
  expect(page.events).toHaveLength(2)
  expect(page.events[0]).toMatchObject({ kind: "trade", side: "sell", result: "W" })
  expect(page.events[1]).toMatchObject({ kind: "signal", pattern: "dormant_buy" })
})

test("since, limit and before go to the route; kind filters the page locally and keeps the cursor", async () => {
  const { client, calls } = eventsFixture()
  const page = await client.getTokenEvents("solana", mint, {
    kind: "signal",
    since: "2026-10-28T00:00:00Z",
    limit: 500,
    before: "cur-0",
  })
  const url = new URL(calls[0]?.url ?? "")
  expect(url.pathname).toBe(`/api/v1/tokens/solana/${mint}/events`)
  expect(url.searchParams.get("since")).toBe("2026-10-28T00:00:00Z")
  expect(url.searchParams.get("limit")).toBe("500")
  expect(url.searchParams.get("before")).toBe("cur-0")
  expect(url.searchParams.get("kind")).toBeNull()
  expect(page.events).toHaveLength(1)
  expect(page.events[0]?.kind).toBe("signal")
  expect(page.nextCursor).toBe("cur-1")
})

test("a switched-off route raises the API's own error code", async () => {
  const { client } = eventsFixture(503, {
    success: false,
    error: { code: "TOKEN_EVENTS_DISABLED", message: "Token events are switched off.", retryable: false },
  })
  try {
    await client.getTokenEvents("hood", "0x1234567890123456789012345678901234567890")
    throw new Error("expected refusal")
  } catch (e) {
    expect(e).toBeInstanceOf(CandleApiError)
    expect((e as CandleApiError).code).toBe("TOKEN_EVENTS_DISABLED")
  }
})
