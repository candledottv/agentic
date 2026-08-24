import { describe, expect, test } from "bun:test"
import { buildRequest, registerTools, resolveToolAllowlist, TOOL_NAMES } from "./tools"

test("all registered tools are listed", () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    "candle_get_agent_profile",
    "candle_get_feed",
    "candle_get_market",
    "candle_launch_and_seed",
    "candle_launch_token",
    "candle_report_activity",
    "candle_swap",
    "candle_sweep",
    "candle_trade",
    "candle_transfer",
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

describe("resolveToolAllowlist", () => {
  test("unset or blank means every tool", () => {
    expect(resolveToolAllowlist({})).toEqual(new Set(TOOL_NAMES))
    expect(resolveToolAllowlist({ CANDLE_MCP_TOOLS: "  " })).toEqual(new Set(TOOL_NAMES))
  })
  test("a comma-separated subset is honored, whitespace-tolerant", () => {
    expect(resolveToolAllowlist({ CANDLE_MCP_TOOLS: "candle_get_market, candle_trade" })).toEqual(
      new Set(["candle_get_market", "candle_trade"]),
    )
  })
  test("an unknown name throws at startup, naming the valid tools", () => {
    expect(() => resolveToolAllowlist({ CANDLE_MCP_TOOLS: "candle_get_market,candle_frobnicate" })).toThrow(
      /candle_frobnicate/,
    )
    expect(() => resolveToolAllowlist({ CANDLE_MCP_TOOLS: "," })).toThrow(/Valid names/)
  })
})

describe("registerTools: CANDLE_MCP_TOOLS filtering", () => {
  /** A registerTool-shaped recorder; only the name matters to the filter under test. */
  function fakeServer() {
    const registered: string[] = []
    return {
      registered,
      server: {
        registerTool: (name: string) => {
          registered.push(name)
        },
      } as unknown as Parameters<typeof registerTools>[0],
    }
  }

  test("no allowlist: all eight tools register", () => {
    const { server, registered } = fakeServer()
    registerTools(server, {})
    expect(new Set(registered)).toEqual(new Set(TOOL_NAMES))
  })

  test("an allowlist registers exactly the named tools", () => {
    const { server, registered } = fakeServer()
    registerTools(server, { CANDLE_MCP_TOOLS: "candle_get_market,candle_get_feed,candle_get_agent_profile" })
    expect(registered.sort()).toEqual(["candle_get_agent_profile", "candle_get_feed", "candle_get_market"])
  })

  test("a bad allowlist fails registration before any tool is wired", () => {
    const { server, registered } = fakeServer()
    expect(() => registerTools(server, { CANDLE_MCP_TOOLS: "nope" })).toThrow(/Valid names/)
    expect(registered).toHaveLength(0)
  })
})

describe("buildRequest: candle_transfer", () => {
  test("maps to POST /api/v1/agent/transfer with the key header and the body verbatim", () => {
    const args = { chain: "solana", asset: "SOL", amountRaw: "max", to: "SomeOwnWallet" }
    const r = buildRequest("candle_transfer", args, { apiUrl: "https://api.test", apiKey: "cndl_live_k" })
    expect(r.url).toBe("https://api.test/api/v1/agent/transfer")
    expect(r.init.method).toBe("POST")
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
    expect(JSON.parse(String(r.init.body))).toEqual(args)
  })
  test("transfer without a key throws before any request is built", () => {
    expect(() =>
      buildRequest(
        "candle_transfer",
        { chain: "solana", asset: "SOL", amountRaw: "1", to: "x" },
        { apiUrl: "https://api.test" },
      ),
    ).toThrow(/CANDLE_AGENT_API_KEY/)
  })
})
