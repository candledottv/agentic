import { expect, test } from "bun:test"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createPerpsMarketExecutor, PERPS_MARKET_TOOL_NAMES } from "./perps-markets"
import { registerToolSubset } from "./tools"

test("AC11 four local read-only tools have schemas, metadata and executable handlers", async () => {
  const registered = new Map<
    string,
    { definition: Record<string, unknown>; handler: (args: object) => Promise<unknown> }
  >()
  const server = {
    registerTool: (name: string, definition: Record<string, unknown>, handler: (args: object) => Promise<unknown>) =>
      registered.set(name, { definition, handler }),
  } as unknown as McpServer
  registerToolSubset(server, {
    tools: [...PERPS_MARKET_TOOL_NAMES],
    getConfig: () => ({ apiUrl: "https://api.test" }),
    env: {},
    fetch: async () => {
      throw new Error("no request without key")
    },
  })
  expect([...registered.keys()]).toEqual([...PERPS_MARKET_TOOL_NAMES])
  for (const tool of registered.values()) {
    expect(tool.definition.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(tool.definition.description).toContain("hosted connector offers the same four reads")
    expect(await tool.handler({ coin: "BTC" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("PERPS_KEY_REQUIRED") }],
    })
  }
})
test("MCP uses one config read, caches for 5 seconds, key only goes to Candle; no signer needed", async () => {
  const urls: string[] = []
  let clock = 1_792_267_200_000
  const execute = createPerpsMarketExecutor(
    () => ({ apiUrl: "https://api.test", apiKey: "key" }),
    {},
    async (url, init) => {
      urls.push(url)
      if (url.startsWith("https://api.test")) {
        expect(url).toBe("https://api.test/api/v1/agent/perps/config")
        expect(new Headers(init?.headers).get("x-api-key")).toBe("key")
        return new Response(JSON.stringify({ network: "mainnet", limits: { minOpenInterestUsd: 0 } }))
      }
      expect(url).toBe("https://api.hyperliquid.xyz/info")
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false)
      const body = JSON.parse(String(init?.body))
      if (body.type === "metaAndAssetCtxs")
        return new Response(
          JSON.stringify([
            { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
            [{ markPx: "1", midPx: null, openInterest: "0" }],
          ]),
        )
      if (body.type === "l2Book") return new Response(JSON.stringify({ coin: "BTC", time: 1, levels: [[], []] }))
      return new Response("[]")
    },
    () => clock,
  )
  expect(JSON.parse((await execute("candle_perps_markets", {})).text).markets).toHaveLength(1)
  expect(JSON.parse((await execute("candle_perps_market", { coin: "btc" })).text).market.coin).toBe("BTC")
  expect(urls).toHaveLength(4)
  clock += 5000
  await execute("candle_perps_markets", {})
  expect(urls).toHaveLength(7)
  await execute("candle_perps_book", { coin: "BTC" })
  await execute("candle_perps_candles", { coin: "BTC" })
  expect(urls).toHaveLength(9)
  expect(urls.filter((u) => u.startsWith("https://api.test"))).toHaveLength(1)
  const before = urls.length
  expect(await execute("candle_perps_book", { coin: "BTC", depth: 21 })).toMatchObject({ isError: true })
  expect(await execute("candle_perps_markets", { wallet: "no" })).toMatchObject({ isError: true })
  expect(urls).toHaveLength(before)
})
