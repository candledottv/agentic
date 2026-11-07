import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { registerToolSubset } from "./tools"

/*
 * BE-2654 (R2): one Solana token's price history over `GET /api/v1/markets/:chain/:mint/candles`.
 * The arguments go through the registered schema as the MCP SDK sends them, then through the
 * handler, so the URL the API receives and the body the caller reads are both covered. The rules
 * worth failing on: the tool is keyless, only the arguments given travel, chain defaults to
 * solana, and the body (including a refusal) is relayed verbatim.
 */
describe("candle_get_price_history", () => {
  const mint = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const history = {
    success: true,
    chain: "solana",
    mint,
    interval: "1h",
    source: "birdeye",
    volumeUnit: "token",
    candles: [{ time: 1_700_000_000, open: 0.1, high: 0.2, low: 0.05, close: 0.15, volume: 1000 }],
  }
  type Fetcher = (url: unknown, init?: RequestInit) => Promise<Response>
  let fetchImpl: Fetcher = async () => Response.json(history)
  let shape: z.ZodRawShape = {}
  let handler: (args: Record<string, unknown>) => Promise<unknown> = async () => undefined
  registerToolSubset(
    {
      registerTool(_name: string, config: { inputSchema: z.ZodRawShape }, h: typeof handler) {
        shape = config.inputSchema
        handler = h
      },
    } as never,
    {
      tools: ["candle_get_price_history"],
      // A key is deliberately configured: the assertions below prove none is sent.
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "configured-key" }),
      fetch: (async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), init })
        return fetchImpl(url as RequestInfo, init)
      }) as typeof fetch,
    },
  )

  async function call(args: Record<string, unknown>) {
    const parsed = await z.object(shape).safeParseAsync({ mint, ...args })
    if (!parsed.success) return { error: parsed.error.issues.map((i) => i.path.join(".")) }
    requests.length = 0
    const result = (await handler(parsed.data as Record<string, unknown>)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return {
      url: new URL(requests[0]?.url ?? "https://api.test/"),
      init: requests[0]?.init,
      headers: new Headers(requests[0]?.init?.headers),
      body: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
      isError: result.isError === true,
    }
  }

  test("maps the public candles route with GET, defaults chain to solana, sends no key, relays verbatim", async () => {
    const r = await call({})
    expect(r.url?.pathname).toBe(`/api/v1/markets/solana/${mint}/candles`)
    expect(r.url?.search).toBe("")
    expect(r.init?.method).toBe("GET")
    expect(r.headers?.has("x-api-key")).toBe(false)
    expect(r.headers?.has("authorization")).toBe(false)
    expect(r.isError).toBe(false)
    expect(r.body).toEqual(history)
  })

  test("interval, limit and to travel as query parameters, and only when given", async () => {
    const r = await call({ chain: "solana", interval: "15m", limit: 250, to: 1_700_003_600 })
    expect(r.url?.searchParams.get("interval")).toBe("15m")
    expect(r.url?.searchParams.get("limit")).toBe("250")
    expect(r.url?.searchParams.get("to")).toBe("1700003600")
    const only = await call({ interval: "1d" })
    expect([...(only.url?.searchParams.keys() ?? [])]).toEqual(["interval"])
  })

  test("the schema refuses an unknown interval and an out-of-range limit before any request", async () => {
    expect((await call({ interval: "2m" })).error).toEqual(["interval"])
    expect((await call({ limit: 0 })).error).toEqual(["limit"])
    expect((await call({ limit: 501 })).error).toEqual(["limit"])
    expect((await call({ to: -1 })).error).toEqual(["to"])
    expect((await z.object(shape).safeParseAsync({})).success).toBe(false)
  })

  test("the route's Hood refusal is an error result relayed verbatim", async () => {
    const refusal = {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        field: "chain",
        message: "Hood price history is served by GET /api/v1/hood/token/:address/candles?interval=1m|1h&limit=1-1000",
      },
    }
    fetchImpl = async () => Response.json(refusal, { status: 400 })
    try {
      const hood = "0x1234567890123456789012345678901234567890"
      const r = await call({ chain: "hood", mint: hood })
      expect(r.url?.pathname).toBe(`/api/v1/markets/hood/${hood}/candles`)
      expect(r.isError).toBe(true)
      expect(r.body).toEqual(refusal)
    } finally {
      fetchImpl = async () => Response.json(history)
    }
  })
})
