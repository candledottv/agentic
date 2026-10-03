/**
 * BE-723 (Plans v2 P6): `candle_get_plans`, the keyless read of the served plan table. It returns
 * the server's JSON and the same table as Markdown, rendered by the SDK's own `plans.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { buildRequest, plansMarkdown, registerTools } from "./tools"

const TABLE = {
  success: true,
  plans: [
    {
      plan: "free",
      capabilities: { buyExternalTokens: false, sellExternalTokens: true },
      feeBps: 100,
      perpFeeBps: 10,
      price: null,
      limits: { rateLimitPerMin: 30, dailyLaunchCap: 5, uploadsPerMin: 10, linkedWallets: 0 },
    },
    {
      plan: "max",
      capabilities: { buyExternalTokens: true, sellExternalTokens: true },
      feeBps: 25,
      perpFeeBps: 0,
      price: { pricePerMonthUsd: 200, currency: "USDC", approval: "self_serve" },
      limits: { rateLimitPerMin: 600, dailyLaunchCap: 1000, uploadsPerMin: 60, linkedWallets: 1000 },
    },
  ],
  promoMaxDays: 30,
}

type Handler = () => Promise<{ content: { text: string }[]; isError?: boolean }>

function registered(env: Record<string, string | undefined>) {
  const tools: Record<string, { description: string; handler: Handler }> = {}
  const server = {
    registerTool(name: string, config: { description?: string }, handler: Handler) {
      tools[name] = { description: config.description ?? "", handler }
    },
  }
  registerTools(server as never, env)
  return tools
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("candle_get_plans", () => {
  test("GET /api/v1/agent/plans with no key header, even with a key configured", () => {
    const r = buildRequest("candle_get_plans", {}, { apiUrl: "https://api.test/", apiKey: "cndl_live_k" })
    expect(r.url).toBe("https://api.test/api/v1/agent/plans")
    expect(r.init.method).toBe("GET")
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })

  test("returns the server's JSON unchanged, then the Markdown table and the promotion", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(TABLE), { status: 200 })) as unknown as typeof fetch
    const tool = registered({ CANDLE_API_URL: "https://api.test" }).candle_get_plans
    const result = await (tool?.handler as Handler)()
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(TABLE)
    const md = result.content[1]?.text ?? ""
    expect(md).toContain("|  | Free | Max |")
    expect(md).toContain("| Price | free | $200 a month |")
    expect(md).toContain("| Agent trade fee | 1% | 0.25% |")
    expect(md).toContain("| Sell tokens not launched on Candle | yes | yes |")
    expect(md).toContain("| Buy tokens not launched on Candle | no | yes |")
    expect(md).toContain("A first Pro purchase includes Max for its first 30 days")
  })

  test("a failure is relayed as an error with no table", async () => {
    globalThis.fetch = (async () => new Response('{"success":false}', { status: 404 })) as unknown as typeof fetch
    const result = await (registered({ CANDLE_API_URL: "https://api.test" }).candle_get_plans?.handler as Handler)()
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
  })

  test("plansMarkdown renders nothing for a body that is not a table", () => {
    expect(plansMarkdown("not json")).toBe("")
    expect(plansMarkdown('{"success":true}')).toBe("")
  })

  test("the description names every capability and says not to quote from memory", () => {
    const d = registered({}).candle_get_plans?.description ?? ""
    for (const key of ["buyExternalTokens", "sellExternalTokens", "selfLaunch", "limitOrders", "promoMaxDays"]) {
      expect(d).toContain(key)
    }
    expect(d).toContain("never from memory")
  })

  test("the trade and perps descriptions point at the served fees and the sell-on-any-plan rule", () => {
    const tools = registered({})
    expect(tools.candle_trade?.description).toContain("SELL a token it holds")
    expect(tools.candle_perps_open?.description).toContain("candle_get_plans")
    expect(tools.candle_perps_open?.description).not.toContain("Believer")
  })
})
