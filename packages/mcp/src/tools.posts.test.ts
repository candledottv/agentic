import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { buildRequest, PROFILE_EDIT_TOOL_NAMES, registerEligibleProfileTool, registerTools } from "./tools"

const cfg = { apiUrl: "https://api.test", apiKey: "fixture-key" }
const PROFILE = "prof_0123456789abcdef"
const MINT = "So11111111111111111111111111111111111111112"

test("create and delete map to key-authenticated post routes", () => {
  const body = { text: "thesis\nline two", token: { chain: "solana", mint: MINT } }
  const create = buildRequest("candle_create_post", body, cfg)
  expect(create.url).toBe("https://api.test/api/v1/agent/posts")
  expect(create.init.method).toBe("POST")
  expect(new Headers(create.init.headers).get("x-api-key")).toBe("fixture-key")
  expect(JSON.parse(String(create.init.body))).toEqual(body)

  const remove = buildRequest("candle_delete_post", { postId: "id with/slash" }, cfg)
  expect(remove.url).toBe("https://api.test/api/v1/agent/posts/id%20with%2Fslash")
  expect(remove.init.method).toBe("DELETE")
  expect(new Headers(remove.init.headers).get("x-api-key")).toBe("fixture-key")
  expect(remove.init.body).toBeUndefined()

  for (const [name, args] of [
    ["candle_create_post", body],
    ["candle_delete_post", { postId: "x" }],
  ] as const) {
    expect(() => buildRequest(name, args, { apiUrl: "https://api.test" })).toThrow(/key/i)
  }
})

test("the posts read is keyless and sends only the knobs that were set", () => {
  const first = buildRequest("candle_list_agent_posts", { profileId: PROFILE }, cfg)
  expect(first.url).toBe(`https://api.test/api/v1/agent/records/${PROFILE}/posts`)
  expect(first.init.method).toBe("GET")
  expect(new Headers(first.init.headers).has("x-api-key")).toBe(false)
  const next = buildRequest(
    "candle_list_agent_posts",
    { profileId: PROFILE, limit: 5, cursor: "1700000000000:1.5" },
    cfg,
  )
  expect(next.url).toBe(`https://api.test/api/v1/agent/records/${PROFILE}/posts?limit=5&cursor=1700000000000%3A1.5`)
  expect(new Headers(next.init.headers).has("x-api-key")).toBe(false)
})

test("the read registers up front; the two writes wait for the eligibility read and its allowlist", async () => {
  const fake = () => {
    const names: string[] = []
    const server = {
      registerTool(name: string) {
        names.push(name)
        return { enabled: true, enable() {}, disable() {} }
      },
    } as unknown as McpServer
    return { names, server }
  }
  const upFront = fake()
  registerTools(upFront.server, { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" })
  expect(upFront.names).toContain("candle_list_agent_posts")
  for (const name of PROFILE_EDIT_TOOL_NAMES) expect(upFront.names).not.toContain(name)

  const env = { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" }
  const readOnly = fake()
  expect(await registerEligibleProfileTool(readOnly.server, env, async () => Response.json({ canEdit: false }))).toBe(
    false,
  )
  expect(readOnly.names).toEqual([])

  const narrowed = fake()
  expect(
    await registerEligibleProfileTool(
      narrowed.server,
      { ...env, CANDLE_MCP_TOOLS: "candle_create_post,candle_get_market" },
      async () => Response.json({ canEdit: true }),
    ),
  ).toBe(true)
  expect(narrowed.names).toEqual(["candle_create_post"])
})

test("MCP refuses an unknown post field before sending a write, and relays the API's refusal", async () => {
  const server = new McpServer({ name: "posts-fixture", version: "1" })
  const writes: { url: string; method?: string; body: unknown }[] = []
  let answer: () => Response = () => Response.json({ success: true, profileId: PROFILE, post: { id: "p1" } })
  await registerEligibleProfileTool(
    server,
    { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" },
    async (url, init) => {
      if (init?.method === "GET") return Response.json({ success: true, canEdit: true })
      writes.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return answer()
    },
  )
  const client = new Client({ name: "fixture", version: "1" })
  const [caller, receiver] = InMemoryTransport.createLinkedPair()
  await server.connect(receiver)
  await client.connect(caller)
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort()
    expect(listed).toEqual([...PROFILE_EDIT_TOOL_NAMES].sort())
    for (const args of [
      { text: "x", reason: "conviction" },
      { text: "x", profileId: PROFILE },
      { text: "x", token: { chain: "solana", mint: MINT, symbol: "SOL" } },
      { text: "x", token: { chain: "base", mint: MINT } },
      { token: { chain: "solana", mint: MINT } },
    ]) {
      expect((await client.callTool({ name: "candle_create_post", arguments: args })).isError).toBe(true)
    }
    expect(
      (await client.callTool({ name: "candle_delete_post", arguments: { postId: "p1", force: true } })).isError,
    ).toBe(true)
    expect(writes).toEqual([])

    const text = "multi\nline https://example.com <b>plain</b>"
    expect((await client.callTool({ name: "candle_create_post", arguments: { text } })).isError).not.toBe(true)
    expect((await client.callTool({ name: "candle_delete_post", arguments: { postId: "p1" } })).isError).not.toBe(true)
    expect(writes).toEqual([
      { url: "https://api.test/api/v1/agent/posts", method: "POST", body: { text } },
      { url: "https://api.test/api/v1/agent/posts/p1", method: "DELETE", body: undefined },
    ])

    answer = () =>
      Response.json(
        { success: false, error: { code: "RATE_LIMITED", message: "30 posts per UTC day reached", retryable: false } },
        { status: 429 },
      )
    const refused = await client.callTool({ name: "candle_create_post", arguments: { text: "the 31st" } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain("RATE_LIMITED")
  } finally {
    await client.close()
    await server.close()
  }
})
