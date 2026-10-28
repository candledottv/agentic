import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { registerToolSubset } from "./tools"

/*
 * BE-2119: the token card read over `GET /api/v1/tokens/:chain/:mint/card` (BE-2118). The
 * arguments go through the registered schema as the MCP SDK sends them, then through the handler,
 * so the URL the API receives and the body the caller reads are both covered. The rules worth
 * failing on: the tool is keyless (the card is the same for every caller), the card source tag
 * travels only as `cst`, and the body is relayed verbatim, including a switched-off refusal.
 */
describe("candle_token_card", () => {
  const mint = "So11111111111111111111111111111111111111112"
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const card = {
    success: true,
    card: {
      chain: "solana",
      mint,
      market: { marketCapUsd: 18200, liquidityUsd: null },
      ath: null,
      forensics: { state: "not_covered", coverage: { covered: false } },
      sources: { market: "candle feed" },
      links: { token: `https://candle.tv/token/${mint}` },
    },
  }
  type Fetcher = (url: unknown, init?: RequestInit) => Promise<Response>
  let fetchImpl: Fetcher = async () => Response.json(card)
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
      tools: ["candle_token_card"],
      // A key is deliberately configured: the assertions below prove none is sent.
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "configured-key" }),
      fetch: (async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), init })
        return fetchImpl(url as RequestInfo, init)
      }) as typeof fetch,
    },
  )

  async function call(args: Record<string, unknown>) {
    const parsed = await z.object(shape).safeParseAsync({ chain: "solana", mint, ...args })
    if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message) }
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

  test("maps the public card route with GET, sends no key, and relays the card verbatim", async () => {
    const r = await call({})
    expect(r.url?.pathname).toBe(`/api/v1/tokens/solana/${mint}/card`)
    expect(r.url?.search).toBe("")
    expect(r.init?.method).toBe("GET")
    expect(r.headers?.has("x-api-key")).toBe(false)
    expect(r.headers?.has("authorization")).toBe(false)
    expect(r.isError).toBe(false)
    expect(r.body).toEqual(card)
  })

  test("a card source tag travels only as cst; an empty tag sends no query", async () => {
    const tagged = await call({ tag: "v1.-1001234567890.p1.c1" })
    expect(tagged.url?.searchParams.get("cst")).toBe("v1.-1001234567890.p1.c1")
    expect([...(tagged.url?.searchParams.keys() ?? [])]).toEqual(["cst"])
    expect((await call({ tag: "" })).url?.search).toBe("")
  })

  test("a Hood address is encoded into the path as given", async () => {
    const hood = "0x1234567890123456789012345678901234567890"
    const r = await call({ chain: "hood", mint: hood })
    expect(r.url?.pathname).toBe(`/api/v1/tokens/hood/${hood}/card`)
  })

  test("a switched-off deployment is an error result relayed verbatim", async () => {
    fetchImpl = async () =>
      Response.json(
        {
          success: false,
          error: { code: "TOKEN_CARD_DISABLED", message: "The token card is switched off.", retryable: false },
        },
        { status: 503 },
      )
    try {
      const r = await call({})
      expect(r.isError).toBe(true)
      expect(r.body).toMatchObject({ success: false, error: { code: "TOKEN_CARD_DISABLED", retryable: false } })
    } finally {
      fetchImpl = async () => Response.json(card)
    }
  })

  test("chain and mint are required", async () => {
    const parsed = await z.object(shape).safeParseAsync({})
    expect(parsed.success).toBe(false)
  })
})
