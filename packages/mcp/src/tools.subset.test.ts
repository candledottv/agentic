import { expect, test } from "bun:test"
import { MCP_CLIENT_SURFACE, withClientSurface } from "./client"
import { registerToolSubset, type ToolName } from "./tools"
import { SERVER_VERSION } from "./version"

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
function recorder() {
  const tools = new Map<string, { config: Record<string, unknown>; handler: Handler }>()
  return {
    tools,
    server: {
      registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
        tools.set(name, { config, handler })
      },
    } as unknown as Parameters<typeof registerToolSubset>[0],
  }
}

test("an explicit subset does not read ambient config, and resolves config at each invocation", async () => {
  const { server, tools } = recorder()
  let config = { apiUrl: "http://local-first", apiKey: "first-key" }
  const calls: Array<{ url: string; key: string | null }> = []
  registerToolSubset(server, {
    tools: ["candle_report_activity"],
    getConfig: () => config,
    fetch: async (url, init) => {
      calls.push({ url, key: new Headers(init?.headers).get("x-api-key") })
      return Response.json({ success: true })
    },
  })
  expect([...tools.keys()]).toEqual(["candle_report_activity"])
  const tool = tools.get("candle_report_activity") as { handler: Handler }
  await tool.handler({ chain: "solana", signature: "one" })
  config = { apiUrl: "http://local-second", apiKey: "second-key" }
  await tool.handler({ chain: "solana", signature: "two" })
  expect(calls).toEqual([
    { url: "http://local-first/api/v1/activity/report", key: "first-key" },
    { url: "http://local-second/api/v1/activity/report", key: "second-key" },
  ])
})

test("empty subsets stay empty and an unknown tool fails before registering anything", () => {
  const { server, tools } = recorder()
  const getConfig = () => {
    throw new Error("must not run during registration")
  }
  registerToolSubset(server, { tools: [], getConfig })
  expect(tools.size).toBe(0)
  expect(() => registerToolSubset(server, { tools: ["typo" as ToolName], getConfig })).toThrow("Unknown tool")
  expect(tools.size).toBe(0)
})

test("metadata overrides descriptions without changing the shared schema, and fetch covers plans and resolution", async () => {
  const { server, tools } = recorder()
  const requests: string[] = []
  registerToolSubset(server, {
    tools: ["candle_get_plans", "candle_resolve_token"],
    getConfig: () => ({ apiUrl: "http://local-api" }),
    metadata: {
      candle_get_plans: {
        description: "Hosted copy",
        annotations: { readOnlyHint: true },
        _meta: { securitySchemes: [{ type: "noauth" }] },
      },
    },
    fetch: async (url) => {
      requests.push(url)
      return Response.json(
        url.endsWith("/plans") ? { success: true, plans: [] } : { success: true, market: { name: "Example" } },
      )
    },
  })
  expect(tools.get("candle_get_plans")?.config.description).toBe("Hosted copy")
  expect(tools.get("candle_get_plans")?.config.inputSchema).toEqual({})
  const plans = await tools.get("candle_get_plans")?.handler({})
  expect(plans?.content).toHaveLength(2)
  const resolved = await tools
    .get("candle_resolve_token")
    ?.handler({ mint: "0x1111111111111111111111111111111111111111" })
  expect(JSON.parse(resolved?.content[0]?.text ?? "{}").chain).toBe("hood")
  expect(requests).toEqual([
    "http://local-api/api/v1/agent/plans",
    "http://local-api/api/v1/markets/hood/0x1111111111111111111111111111111111111111",
  ])
})

test("SEC-009: a keyed tool call redirected to another origin is refused without sending the key there", async () => {
  const { server, tools } = recorder()
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
  registerToolSubset(server, {
    tools: ["candle_report_activity"],
    getConfig: () => ({ apiUrl: "https://api.candle.example", apiKey: "secret-key" }),
    fetch: async (url, init) => {
      calls.push({ url, redirect: init?.redirect })
      return url.startsWith("https://api.candle.example")
        ? new Response(null, { status: 307, headers: { location: "https://attacker.example/report" } })
        : Response.json({ success: true })
    },
  })
  const tool = tools.get("candle_report_activity") as { handler: Handler }
  const outcome = await tool.handler({ chain: "solana", signature: "one" }).then(
    (result) => JSON.stringify(result),
    (error: unknown) => String(error),
  )
  expect(outcome).toContain("another origin")
  expect(outcome).not.toContain("secret-key")
  expect(calls).toEqual([{ url: "https://api.candle.example/api/v1/activity/report", redirect: "manual" }])
})

test("SEC-009: a same-origin redirect is followed with the key", async () => {
  const { server, tools } = recorder()
  const calls: Array<{ url: string; key: string | null }> = []
  registerToolSubset(server, {
    tools: ["candle_report_activity"],
    getConfig: () => ({ apiUrl: "https://api.candle.example", apiKey: "secret-key" }),
    fetch: async (url, init) => {
      calls.push({ url, key: new Headers(init?.headers).get("x-api-key") })
      return calls.length === 1
        ? new Response(null, { status: 308, headers: { location: "/api/v1/activity/report2" } })
        : Response.json({ success: true })
    },
  })
  const tool = tools.get("candle_report_activity") as { handler: Handler }
  const result = await tool.handler({ chain: "solana", signature: "one" })
  expect(result.isError).toBeUndefined()
  expect(calls).toEqual([
    { url: "https://api.candle.example/api/v1/activity/report", key: "secret-key" },
    { url: "https://api.candle.example/api/v1/activity/report2", key: "secret-key" },
  ])
})

test("BE-3919: every tool request to the API names the MCP server and its version, and only those", async () => {
  const { server, tools } = recorder()
  const calls: Array<{ url: string; client: string | null }> = []
  registerToolSubset(server, {
    tools: ["candle_report_activity"],
    getConfig: () => ({ apiUrl: "https://api.test", apiKey: "key" }),
    fetch: async (url, init) => {
      calls.push({ url, client: new Headers(init?.headers).get("x-candle-client") })
      return Response.json({ success: true })
    },
  })
  const tool = tools.get("candle_report_activity") as { handler: Handler }
  await tool.handler({ chain: "solana", signature: "one" })
  expect(calls).toEqual([{ url: "https://api.test/api/v1/activity/report", client: MCP_CLIENT_SURFACE }])
  expect(MCP_CLIENT_SURFACE).toBe(`mcp/${SERVER_VERSION}`)

  const seen: (string | null)[] = []
  const labelled = withClientSurface(
    async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("x-candle-client"))
      return Response.json({})
    },
    () => "https://api.test",
  )
  await labelled("https://api.hyperliquid.xyz/info", { method: "POST" })
  await labelled("https://api.test/api/v1/markets/feed", { headers: [["accept", "*/*"]] })
  await labelled("https://api.test/api/v1/markets/feed", { headers: { "X-Candle-Client": "mcp-hosted/1" } })
  expect(seen).toEqual([null, MCP_CLIENT_SURFACE, "mcp-hosted/1"])
})
