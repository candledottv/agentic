import { describe, expect, test } from "bun:test"
import { buildRequest, TOOL_NAMES } from "./tools"

test("all registered tools are listed", () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    "candle_get_agent_profile",
    "candle_get_feed",
    "candle_get_market",
    "candle_launch_and_seed",
    "candle_launch_token",
    "candle_report_activity",
    "candle_swap",
    "candle_trade",
  ])
})

describe("buildRequest", () => {
  test("launch maps to POST /api/v1/launch/headless with the key header", () => {
    const r = buildRequest(
      "candle_launch_token",
      { clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x/y.png" },
      { apiUrl: "https://api.test", apiKey: "cndl_live_k" },
    )
    expect(r.url).toBe("https://api.test/api/v1/launch/headless")
    expect(r.init.method).toBe("POST")
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
  })
  test("dryRun routes to /dry-run", () => {
    const r = buildRequest(
      "candle_launch_token",
      { dryRun: true, clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x/y.png" },
      { apiUrl: "https://api.test", apiKey: "k" },
    )
    expect(r.url).toBe("https://api.test/api/v1/launch/headless/dry-run")
  })
  test("swap maps to POST /api/v1/agent/swap with the key header and the body verbatim", () => {
    const args = { from: "SOL", to: "USDG", amountRaw: "1000000000", maxSlippageBps: 50 }
    const r = buildRequest("candle_swap", args, { apiUrl: "https://api.test", apiKey: "cndl_live_k" })
    expect(r.url).toBe("https://api.test/api/v1/agent/swap")
    expect(r.init.method).toBe("POST")
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
    expect(JSON.parse(String(r.init.body))).toEqual(args)
  })
  test("swap without a key throws before any request is built", () => {
    expect(() =>
      buildRequest("candle_swap", { from: "SOL", to: "USDC", amountRaw: "1" }, { apiUrl: "https://api.test" }),
    ).toThrow(/CANDLE_AGENT_API_KEY/)
  })
  test("get_market is an unauthenticated GET", () => {
    const r = buildRequest("candle_get_market", { chain: "solana", mint: "M1" }, { apiUrl: "https://api.test" })
    expect(r.url).toBe("https://api.test/api/v1/markets/solana/M1")
    expect(r.init.method).toBe("GET")
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })
  test("launch without an api key throws a clear error", () => {
    expect(() => buildRequest("candle_launch_token", { clientLaunchId: "c" }, { apiUrl: "https://api.test" })).toThrow(
      /CANDLE_AGENT_API_KEY/,
    )
  })
})
