/**
 * Multi-EVM F5 (BE-2959, spec A6): through the registered tools, a disabled or unknown chain is a
 * refusal that never reaches the API, and an enabled `testevm` reaches the request builder.
 */
import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { __resetChainRegistryForTest, __setChainRegistryForTest } from "./chain-registry"
import { registryWithTestevm } from "./chain-test-fixtures"
import type * as toolsModule from "./tools"

const realFetch = globalThis.fetch
afterEach(() => {
  __resetChainRegistryForTest()
  globalThis.fetch = realFetch
})

/** The tool shapes are built when `tools` loads, so a registry change needs a fresh copy of the module. */
let fresh = 0
async function freshTools(): Promise<typeof toolsModule> {
  fresh += 1
  return (await import(`./tools?fresh=${fresh}`)) as typeof toolsModule
}

async function call(chain: string) {
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return Response.json({ success: true })
  }) as typeof fetch
  const server = new McpServer({ name: "t", version: "0" })
  ;(await freshTools()).registerTools(server, {
    CANDLE_API_URL: "https://api.test",
    CANDLE_AGENT_API_KEY: "fixture-key",
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "c", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  const result = await client.callTool({
    name: "candle_get_market",
    arguments: { chain, mint: "0x0000000000000000000000000000000000000001" },
  })
  await client.close()
  return { result, urls }
}

test("a disabled testevm is refused by name and nothing is fetched", async () => {
  __setChainRegistryForTest(registryWithTestevm("disabled"))
  const { result, urls } = await call("testevm")
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain("chain must be one of solana or hood")
  expect(urls).toEqual([])
})

test("an enabled testevm passes the parse and reaches the API with its own slug", async () => {
  __setChainRegistryForTest(registryWithTestevm("enabled"))
  const { result, urls } = await call("testevm")
  expect(result.isError).not.toBe(true)
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain("testevm")
  expect(urls[0]).not.toContain("chain=hood")
})

test("every tool with a chain parameter emits an enum of the enabled chains in its JSON Schema (A9)", async () => {
  const server = new McpServer({ name: "t", version: "0" })
  ;(await freshTools()).registerTools(server, {
    CANDLE_API_URL: "https://api.test",
    CANDLE_AGENT_API_KEY: "fixture-key",
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "c", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  await client.close()
  // Tools whose chain parameter is a registry enum; a few take a free string (price history, positions filter).
  const withChain = tools.filter(
    (t) => (t.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.chain?.enum !== undefined,
  )
  expect(withChain.length).toBeGreaterThanOrEqual(10)
  for (const tool of withChain) {
    const chain = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).chain
    expect({ tool: tool.name, enum: chain?.enum }).toEqual({ tool: tool.name, enum: ["solana", "hood"] })
  }
  expect(withChain.map((t) => t.name)).toEqual(expect.arrayContaining(["candle_transfer", "candle_sweep"]))
})
