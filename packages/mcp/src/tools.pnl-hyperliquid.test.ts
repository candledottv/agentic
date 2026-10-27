import { expect, test } from "bun:test"
import { PROFILE_PNL_HYPERLIQUID, registerTools } from "./tools"

test("profile PnL tool relays the Hyperliquid section and perpsInTotal without changing amounts", async () => {
  let call: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> = async () => {
    throw new Error("not registered")
  }
  let description = ""
  const server = {
    registerTool(name: string, config: { description: string }, handler: typeof call) {
      if (name === "candle_get_profile_pnl") {
        call = handler
        description = config.description
      }
    },
  }
  registerTools(server as never, { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "test-key" })
  expect(description).toContain("perpsInTotal")
  const originalFetch = globalThis.fetch
  try {
    for (const [section, perpsInTotal, totalUsd] of [
      [{ read: false, code: "cutoff_unreconciled", reason: "Retry shortly" }, false, 9],
      [
        {
          read: true,
          coverage: "profile",
          realizedNetUsd: 8.5,
          fundingUsd: 2.5,
          feesUsd: 0.5,
          unrealizedUsd: "1.500000",
          netUsd: "10.000000",
          positions: [{ coin: "ETH", fundingNetUsd: "1.25" }],
          historyPartial: false,
          truncated: false,
        },
        true,
        19,
      ],
    ] as const) {
      const body = { success: true, pnl: { realizedNetUsd: 9, totalUsd }, hyperliquid: section, perpsInTotal }
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

test("profile PnL description: R7 amended, the net in the total, funding positive when received", () => {
  let description = ""
  registerTools(
    {
      registerTool(name: string, config: { description: string }) {
        if (name === "candle_get_profile_pnl") description = config.description
      },
    } as never,
    { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "test-key" },
  )
  expect(description).toContain(PROFILE_PNL_HYPERLIQUID)
  expect(description).toContain("every EVM TEE wallet bound to it, per binding period")
  expect(description).toContain("`unrealizedUsd` at each wallet's cutoff")
  expect(description).toContain("When `read` is true, `pnl.totalUsd` includes `netUsd` and `perpsInTotal` is true")
  expect(description).toContain("funding (positive received, negative paid)")
  expect(description).toContain("`fundingNetUsd` positive when earned")
  expect(description).toContain("console's P&L, plus the Hyperliquid net when `perpsInTotal` is true")
  expect(description).not.toContain("unrealized perps are excluded")
  expect(description).not.toContain("since the current TEE binding")
})
