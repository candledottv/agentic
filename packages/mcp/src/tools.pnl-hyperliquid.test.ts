import { expect, test } from "bun:test"
import { registerTools } from "./tools"

test("profile PnL tool relays the optional Hyperliquid section without changing amounts", async () => {
  let call: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> = async () => {
    throw new Error("not registered")
  }
  const server = {
    registerTool(name: string, _config: unknown, handler: typeof call) {
      if (name === "candle_get_profile_pnl") call = handler
    },
  }
  registerTools(server as never, { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "test-key" })
  const originalFetch = globalThis.fetch
  try {
    for (const section of [
      { read: false, reason: "Retry shortly" },
      { read: true, realizedNetUsd: 8.5, fundingUsd: -1, feesUsd: 0.5, truncated: true },
    ]) {
      const body = { success: true, pnl: { realizedNetUsd: 9 }, hyperliquid: section }
      globalThis.fetch = (async (url, init) => {
        expect(String(url)).toBe("https://api.test/api/v1/agent/keys/own/pnl")
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key")
        return Response.json(body)
      }) as typeof fetch
      const result = await call({ keyPrefix: "own" })
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(body)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
