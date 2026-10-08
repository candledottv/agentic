import { expect, test } from "bun:test"
import { registerToolSubset, type ToolName } from "./tools"

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
