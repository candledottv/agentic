import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { buildRequest, registerEligibleProfileTool } from "./tools"

test("profile update maps to an authenticated PATCH", () => {
  const patch = { publicLinks: { website: "https://example.com" }, publicStrategyNote: "Trades dips" }
  const req = buildRequest("candle_update_profile", patch, { apiUrl: "https://api.test", apiKey: "fixture-key" })
  expect(req.url).toBe("https://api.test/api/v1/agent/keys/self/public-profile")
  expect(req.init.method).toBe("PATCH")
  expect(new Headers(req.init.headers).get("x-api-key")).toBe("fixture-key")
  expect(JSON.parse(String(req.init.body))).toEqual(patch)
  expect(() => buildRequest("candle_update_profile", patch, { apiUrl: "https://api.test" })).toThrow(/key/i)
})

test("local discovery only offers the tool when the server allows acting edits; refresh removes it", async () => {
  const names: string[] = []
  let enabled = false
  const server = {
    registerTool(name: string) {
      names.push(name)
      enabled = true
      return {
        get enabled() {
          return enabled
        },
        enable: () => {
          enabled = true
        },
        disable: () => {
          enabled = false
        },
      }
    },
  } as unknown as McpServer
  const env = { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" }
  let canEdit = false
  const fetcher = async () => Response.json({ success: true, canEdit })
  expect(await registerEligibleProfileTool(server, env, fetcher)).toBe(false)
  expect(names).toEqual([])
  canEdit = true
  expect(await registerEligibleProfileTool(server, env, fetcher)).toBe(true)
  expect(names).toEqual(["candle_update_profile"])
  canEdit = false
  expect(await registerEligibleProfileTool(server, env, fetcher)).toBe(false)
  expect(enabled).toBe(false)
  canEdit = true
  expect(await registerEligibleProfileTool(server, env, fetcher)).toBe(true)
  expect(enabled).toBe(true)
  expect(names).toHaveLength(1)
  expect(await registerEligibleProfileTool(server, { ...env, CANDLE_MCP_TOOLS: "candle_get_market" }, fetcher)).toBe(
    false,
  )
  expect(enabled).toBe(false)
})

test("anonymous, denied, and old/offline API discovery fail closed", async () => {
  let called = false
  const server = {
    registerTool() {
      throw new Error("Unexpected registration")
    },
  } as unknown as McpServer
  const fetcher = async () => {
    called = true
    return Response.json({ error: "denied" }, { status: 403 })
  }
  expect(await registerEligibleProfileTool(server, { CANDLE_API_URL: "https://api.test" }, fetcher)).toBe(false)
  expect(called).toBe(false)
  const env = { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" }
  expect(await registerEligibleProfileTool(server, env, fetcher)).toBe(false)
  expect(
    await registerEligibleProfileTool(server, env, async () => {
      throw new Error("Offline")
    }),
  ).toBe(false)
})

test("MCP rejects mixed patches containing owner-only fields before sending a write", async () => {
  const server = new McpServer({ name: "profile-fixture", version: "1" })
  let writes = 0
  await registerEligibleProfileTool(
    server,
    { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "fixture-key" },
    async (_url, init) => {
      if (init?.method === "PATCH") writes += 1
      return Response.json({ success: true, canEdit: true })
    },
  )
  const client = new Client({ name: "fixture", version: "1" })
  const [caller, receiver] = InMemoryTransport.createLinkedPair()
  await server.connect(receiver)
  await client.connect(caller)
  try {
    for (const field of ["publicName", "publicSlug", "visibility"]) {
      const result = await client.callTool({
        name: "candle_update_profile",
        arguments: { publicThesis: "Allowed bio", [field]: "refused" },
      })
      expect(result.isError).toBe(true)
    }
    expect(writes).toBe(0)
    expect(
      (await client.callTool({ name: "candle_update_profile", arguments: { publicThesis: "Allowed bio" } })).isError,
    ).not.toBe(true)
    expect(writes).toBe(1)
  } finally {
    await client.close()
    await server.close()
  }
})
