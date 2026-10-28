import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { registerToolSubset } from "./tools"

/*
 * BE-2095: the events read over `GET /api/v1/tokens/:chain/:mint/events`. These run the
 * arguments through the registered schema exactly as the MCP SDK does, then through the
 * handler, so the query string the API receives and the body the caller reads are both
 * covered. The two rules worth failing on: `kind` never reaches the route (it has no kind
 * parameter; the filter is this server's, applied to the relayed page), and the tool stays
 * keyless like the market and feed reads -- no credential header even when one is configured.
 */
describe("candle_token_events", () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const page = {
    success: true,
    nextCursor: "cur-1",
    events: [
      { id: "trade:1", kind: "trade", side: "sell", result: "W" },
      { id: "signal:1", kind: "signal", pattern: "dormant_buy" },
      { id: "callout:1", kind: "callout", caller: { handle: "@h" } },
    ],
  }
  type Fetcher = (url: unknown, init?: RequestInit) => Promise<Response>
  let fetchImpl: Fetcher = async () => Response.json(page)
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
      tools: ["candle_token_events"],
      // A key is deliberately configured: the assertions below prove none is sent.
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "configured-key" }),
      fetch: (async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), init })
        return fetchImpl(url as RequestInfo, init)
      }) as typeof fetch,
    },
  )

  async function call(args: Record<string, unknown>) {
    const parsed = await z
      .object(shape)
      .safeParseAsync({ chain: "solana", mint: "So11111111111111111111111111111111111111112", ...args })
    if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message) }
    requests.length = 0
    const result = (await handler(parsed.data as Record<string, unknown>)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return {
      query: new URL(requests[0]?.url ?? "https://api.test/").searchParams,
      headers: new Headers(requests[0]?.init?.headers),
      body: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
      isError: result.isError === true,
    }
  }

  test("maps the public route, sends no key, and relays the page verbatim", async () => {
    const r = await call({})
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/api/v1/tokens/solana/So11111111111111111111111111111111111111112/events",
    )
    expect(r.headers?.has("x-api-key")).toBe(false)
    expect(r.isError).toBe(false)
    expect(r.body).toEqual(page)
    expect(r.body?.filteredByKind).toBeUndefined()
  })

  test("since, limit and before go to the route; kind never does", async () => {
    const r = await call({ kind: "signal", since: "2026-10-28T00:00:00Z", limit: 500, before: "cur-0" })
    expect(r.query?.get("since")).toBe("2026-10-28T00:00:00Z")
    expect(r.query?.get("limit")).toBe("500")
    expect(r.query?.get("before")).toBe("cur-0")
    expect(r.query?.get("kind")).toBeNull()
  })

  test("kind narrows the relayed page, says so in filteredByKind, and keeps the cursor", async () => {
    const r = await call({ kind: "signal" })
    expect(r.body?.events).toEqual([{ id: "signal:1", kind: "signal", pattern: "dormant_buy" }])
    expect(r.body?.filteredByKind).toBe("signal")
    expect(r.body?.nextCursor).toBe("cur-1")
    expect(r.isError).toBe(false)
  })

  test("limit takes a number or a numeric string, with the route's bounds", async () => {
    expect((await call({ limit: 1000 })).query?.get("limit")).toBe("1000")
    expect((await call({ limit: "50" })).query?.get("limit")).toBe("50")
    expect((await call({ limit: "" })).query?.has("limit")).toBe(false)
    for (const limit of [0, 1001, 2.5, "abc", "-1"]) {
      expect((await call({ limit })).error).toEqual(["limit must be a whole number from 1 to 1000"])
    }
  })

  test("a switched-off deployment is an error result relayed verbatim, never filtered", async () => {
    const failing: Fetcher = async () =>
      Response.json(
        {
          success: false,
          error: { code: "TOKEN_EVENTS_DISABLED", message: "Token events are switched off.", retryable: false },
        },
        { status: 503 },
      )
    fetchImpl = failing
    try {
      const r = await call({ kind: "trade" })
      expect(r.isError).toBe(true)
      expect(r.body).toMatchObject({ success: false, error: { code: "TOKEN_EVENTS_DISABLED" } })
      expect(r.body?.filteredByKind).toBeUndefined()
    } finally {
      fetchImpl = async () => Response.json(page)
    }
  })
})
