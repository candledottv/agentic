import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { launchFieldHelp } from "./launch-schema"
import type { FetchLike } from "./orchestrate"
import {
  buildRequest,
  PROFILE_EDIT_TOOL_NAMES,
  registerToolSubset,
  registerTools,
  resolveToolAllowlist,
  swapBody,
  TOOL_NAMES,
  type ToolName,
  VAMP_CANDIDATES_DESCRIPTION,
} from "./tools"

test("all registered tools are listed", () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    "candle_claim_fees",
    "candle_claim_staking_reward",
    "candle_create_post",
    "candle_delete_post",
    "candle_execution_status",
    "candle_finish_unstake",
    "candle_get_agent_profile",
    "candle_get_feed",
    "candle_get_fees",
    "candle_get_market",
    "candle_get_operation",
    "candle_get_plans",
    "candle_get_portfolio",
    "candle_get_profile_pnl",
    "candle_get_profile_trades",
    "candle_get_profile_wallets",
    "candle_get_staking",
    "candle_get_wallets",
    "candle_launch_and_seed",
    "candle_launch_token",
    "candle_list_agent_posts",
    "candle_list_agents",
    "candle_perps_account",
    "candle_perps_book",
    "candle_perps_cancel",
    "candle_perps_candles",
    "candle_perps_close",
    "candle_perps_deposit",
    "candle_perps_fills",
    "candle_perps_flatten",
    "candle_perps_funding",
    "candle_perps_leverage",
    "candle_perps_margin",
    "candle_perps_market",
    "candle_perps_markets",
    "candle_perps_modify",
    "candle_perps_open",
    "candle_perps_orders",
    "candle_perps_positions",
    "candle_perps_reduce_only",
    "candle_perps_risk",
    "candle_perps_schedule_cancel",
    "candle_perps_set_thresholds",
    "candle_perps_setup",
    "candle_perps_thresholds",
    "candle_perps_tpsl",
    "candle_report_activity",
    "candle_resolve_token",
    "candle_set_profile_wallets",
    "candle_stake",
    "candle_swap",
    "candle_sweep",
    "candle_token_card",
    "candle_token_events",
    "candle_token_forensics",
    "candle_trade",
    "candle_transfer",
    "candle_unstake",
    "candle_update_profile",
    "candle_upload_profile_image",
    "candle_vamp_candidates",
  ])
})

describe("buildRequest: the agent directory (FE-431)", () => {
  const cfg = { apiUrl: "https://api.test/", apiKey: "cndl_live_secret" }

  test("no arguments is the plain list, and a configured key is never sent", () => {
    const { url, init } = buildRequest("candle_list_agents", {}, cfg)
    expect(url).toBe("https://api.test/api/v1/agent/directory")
    expect(init.method).toBe("GET")
    expect(init.headers).toEqual({ "Content-Type": "application/json" })
    expect(init.body).toBeUndefined()
  })

  test("every knob is forwarded under the route's own name, encoded", () => {
    const { url } = buildRequest(
      "candle_list_agents",
      { sort: "pnl", strategy: "momentum", q: "@fox value", limit: 48, cursor: "pnl|momentum|12.5|42.5" },
      cfg,
    )
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/api/v1/agent/directory")
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      sort: "pnl",
      strategy: "momentum",
      q: "@fox value",
      limit: "48",
      cursor: "pnl|momentum|12.5|42.5",
    })
  })

  test("a blank knob is left off rather than sent empty, and there is no model argument", () => {
    const { url } = buildRequest(
      "candle_list_agents",
      { sort: "", strategy: "", q: "", cursor: "", model: "claude" },
      cfg,
    )
    expect(url).toBe("https://api.test/api/v1/agent/directory")
  })
})

describe("buildRequest: creator fees (FE-438)", () => {
  const cfg = { apiUrl: "https://api.test", apiKey: "k" }

  test("candle_get_fees reads the list with its cursor and limit", () => {
    expect(buildRequest("candle_get_fees", {}, cfg).url).toBe("https://api.test/api/v1/agent/fees")
    const r = buildRequest("candle_get_fees", { cursor: "c1", limit: 5 }, cfg)
    expect(r.url).toBe("https://api.test/api/v1/agent/fees?cursor=c1&limit=5")
    expect(r.init.method).toBe("GET")
  })

  test("candle_claim_fees posts the dry-run flag and nothing else, mint in the path", () => {
    const r = buildRequest("candle_claim_fees", { mint: "Mint/1", dryRun: true, to: "Elsewhere" }, cfg)
    expect(r.url).toBe("https://api.test/api/v1/agent/fees/Mint%2F1/claim")
    expect(r.init.method).toBe("POST")
    expect(JSON.parse(String(r.init.body))).toEqual({ dryRun: true })
    expect(JSON.parse(String(buildRequest("candle_claim_fees", { mint: "M" }, cfg).init.body))).toEqual({
      dryRun: false,
    })
  })

  test("both need a key", () => {
    expect(() => buildRequest("candle_get_fees", {}, { apiUrl: "https://api.test" })).toThrow()
    expect(() => buildRequest("candle_claim_fees", { mint: "M" }, { apiUrl: "https://api.test" })).toThrow()
  })
})

describe("buildRequest: vamp candidates (BE-1504)", () => {
  const cfg = { apiUrl: "https://api.test/", apiKey: "k" }

  test("no arguments is the plain list, so the API's defaults apply", () => {
    const r = buildRequest("candle_vamp_candidates", {}, cfg)
    expect(r.url).toBe("https://api.test/api/v1/markets/vamp-candidates")
    expect(r.init.method).toBe("GET")
    expect(r.init.headers).toEqual({ "Content-Type": "application/json", "x-api-key": "k" })
    expect(r.init.body).toBeUndefined()
  })

  test("limit, minCopies24h and stage are forwarded when set, and nothing else is", () => {
    const r = buildRequest(
      "candle_vamp_candidates",
      { limit: 5, minCopies24h: 0, stage: "graduated", chain: "hood", where: "{}" },
      cfg,
    )
    expect(r.url).toBe("https://api.test/api/v1/markets/vamp-candidates?limit=5&minCopies24h=0&stage=graduated")
  })

  test("needs a key: the list is a launcher's tool, not a keyless read", () => {
    expect(() => buildRequest("candle_vamp_candidates", {}, { apiUrl: "https://api.test" })).toThrow(
      /CANDLE_AGENT_API_KEY/,
    )
  })
})

describe("buildRequest: the feed's server-side query", () => {
  const cfg = { apiUrl: "https://api.test" }

  test("a bare feed read is unchanged", () => {
    const r = buildRequest("candle_get_feed", { bucket: "new" }, cfg)
    expect(r.url).toBe("https://api.test/api/v1/markets/feed?bucket=new")
  })

  /*
    The knobs have to REACH the API. A tool whose schema advertises a filter that its request
    builder drops would return the whole feed while the model believed it had narrowed it, which
    is worse than not offering the filter at all.
  */
  test("every knob reaches the URL", () => {
    const r = buildRequest(
      "candle_get_feed",
      {
        bucket: "graduated",
        chain: "solana",
        where: '{"marketCap":{"lt":150000}}',
        sort: "marketCap:desc",
        fields: "symbol,marketCap",
        limit: "20",
      },
      cfg,
    )
    const url = new URL(r.url)
    expect(url.searchParams.get("bucket")).toBe("graduated")
    expect(url.searchParams.get("chain")).toBe("solana")
    expect(url.searchParams.get("where")).toBe('{"marketCap":{"lt":150000}}')
    expect(url.searchParams.get("sort")).toBe("marketCap:desc")
    expect(url.searchParams.get("fields")).toBe("symbol,marketCap")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  /*
    An empty string must not be forwarded. A blank `where` that the API read as "no filter" would
    hand back the whole feed to a caller who thought they had filtered.
  */
  test("empty knobs are omitted rather than sent blank", () => {
    const r = buildRequest("candle_get_feed", { bucket: "new", where: "", sort: "", fields: "", limit: "" }, cfg)
    const url = new URL(r.url)
    expect(url.searchParams.has("where")).toBe(false)
    expect(url.searchParams.has("sort")).toBe(false)
    expect(url.searchParams.has("fields")).toBe(false)
    expect(url.searchParams.has("limit")).toBe(false)
  })

  test("the JSON filter survives URL encoding intact", () => {
    // Braces and quotes are percent-encoded on the wire; what matters is that the API decodes
    // back to exactly the JSON the model wrote.
    const where = '{"mintAuthorityDisabled":{"eq":true},"liquidityUsd":{"gte":25000}}'
    const r = buildRequest("candle_get_feed", { bucket: "new", where }, cfg)
    expect(new URL(r.url).searchParams.get("where")).toBe(where)
  })

  test("the feed still needs no key", () => {
    const r = buildRequest("candle_get_feed", { bucket: "new" }, cfg)
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })
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
  test("path parameters are URL-encoded, so a hostile mint cannot restructure the request", () => {
    // `chain` and `mint` arrive as free-form strings from the tool call (the schema does not
    // constrain them), so an unencoded `../` or `?` walks the path or starts a query string
    // against our own API. The SDK has always encoded the equivalent segments.
    const r = buildRequest(
      "candle_get_market",
      { chain: "solana", mint: "../../agent/wallets?x=1" },
      { apiUrl: "https://api.test" },
    )
    expect(r.url).toBe("https://api.test/api/v1/markets/solana/..%2F..%2Fagent%2Fwallets%3Fx%3D1")
    expect(r.url).not.toContain("/agent/wallets")

    const forensics = buildRequest(
      "candle_token_forensics",
      { chain: "so/lana", mint: "M 1" },
      { apiUrl: "https://api.test" },
    )
    expect(forensics.url).toBe("https://api.test/api/v1/markets/so%2Flana/M%201/forensics")

    const profile = buildRequest("candle_get_agent_profile", { idOrWallet: "a/b?c" }, { apiUrl: "https://api.test" })
    expect(profile.url).toBe("https://api.test/api/v1/users/a%2Fb%3Fc/agent")
  })
  test("get_portfolio is a keyed GET of /api/v1/agent/portfolio with no body", () => {
    const r = buildRequest("candle_get_portfolio", {}, { apiUrl: "https://api.test", apiKey: "cndl_live_k" })
    expect(r.url).toBe("https://api.test/api/v1/agent/portfolio")
    expect(r.init.method).toBe("GET")
    expect(r.init.body).toBeUndefined()
    expect((r.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
  })
  test("get_portfolio without a key throws before any request is built", () => {
    expect(() => buildRequest("candle_get_portfolio", {}, { apiUrl: "https://api.test" })).toThrow(
      /CANDLE_AGENT_API_KEY/,
    )
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
    // The page-writing tools wait for the API to say this key may edit (`registerEligibleProfileTool`).
    const upFront = TOOL_NAMES.filter((name) => !(PROFILE_EDIT_TOOL_NAMES as readonly string[]).includes(name))
    expect(new Set(registered)).toEqual(new Set(upFront))
    expect(registered).toContain("candle_list_agent_posts")
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

describe("swapBody", () => {
  test("converts a decimal amount using the base asset's own decimals", () => {
    expect(swapBody({ from: "SOL", to: "USDC", amount: "0.5" })).toEqual({
      from: "SOL",
      to: "USDC",
      amountRaw: "500000000",
    })
    // USDC is 6, not 9. Reusing SOL's scale here would spend 1000x.
    expect(swapBody({ from: "USDC", to: "SOL", amount: "100" })).toEqual({
      from: "USDC",
      to: "SOL",
      amountRaw: "100000000",
    })
    // ETH is 18: the case a model is most likely to get wrong by hand.
    expect(swapBody({ from: "ETH", to: "USDG", amount: "0.003" })).toEqual({
      from: "ETH",
      to: "USDG",
      amountRaw: "3000000000000000",
    })
  })

  test("passes a raw amount through untouched, so existing callers are unaffected", () => {
    expect(swapBody({ from: "SOL", to: "USDC", amountRaw: "500000000" })).toEqual({
      from: "SOL",
      to: "USDC",
      amountRaw: "500000000",
    })
  })

  test("refuses both or neither rather than picking one", () => {
    expect(() => swapBody({ from: "SOL", to: "USDC", amount: "0.5", amountRaw: "1" })).toThrow(/exactly one/)
    expect(() => swapBody({ from: "SOL", to: "USDC" })).toThrow(/Pass an amount/)
  })

  test("carries the other fields through", () => {
    expect(swapBody({ from: "SOL", to: "ETH", amount: "1", maxSlippageBps: 50, clientSwapId: "abc" })).toEqual({
      from: "SOL",
      to: "ETH",
      maxSlippageBps: 50,
      clientSwapId: "abc",
      amountRaw: "1000000000",
    })
  })

  test("a bad decimal fails loudly instead of being truncated", () => {
    // 10 fraction digits against SOL's 9: truncating would silently swap a different size.
    expect(() => swapBody({ from: "SOL", to: "USDC", amount: "0.1234567891" })).toThrow(/fraction digits/)
    expect(() => swapBody({ from: "SOL", to: "USDC", amount: "-1" })).toThrow(/plain positive decimal/)
    expect(() => swapBody({ from: "SOL", to: "USDC", amount: "0" })).toThrow(/greater than zero/)
  })
})

/*
 * The tool DESCRIPTION is what an agent reads at call time.
 *
 * `instructions` are optional for a client to surface and easy to truncate; the description on
 * the tool it is about to invoke is not. So the two rules that were learned by actually
 * connecting -- the feed/market coverage boundary, and "retry with the SAME id" -- have to live
 * on the tools themselves, not only in the server preamble.
 */
describe("tool descriptions carry the rules an agent needs at call time", () => {
  const describeOf = (name: string): string => {
    const registered: Record<string, string> = {}
    const server = {
      registerTool(toolName: string, config: { description?: string }) {
        registered[toolName] = config.description ?? ""
      },
    }
    registerTools(server as never, {})
    return registered[name] ?? ""
  }

  test("the feed documents external discovery flags and drain as signal not block", () => {
    const d = describeOf("candle_get_feed")
    expect(d).toContain("organic0LiveOk")
    // Case-insensitive: the copy capitalises WIDER for emphasis, and the assertion is about the
    // claim being present, not about how it is typeset.
    expect(d.toLowerCase()).toContain("wider market")
    expect(d).toContain("liquidityDrawdownBps")
  })

  test("the Solana seed copy depends on whether the server seeds headlessly", () => {
    const describeWith = (options: { headlessSeed?: boolean }): string => {
      let text = ""
      const server = {
        registerTool(toolName: string, config: { description?: string }) {
          if (toolName === "candle_launch_and_seed") text = config.description ?? ""
        },
      }
      registerToolSubset(server as never, {
        tools: ["candle_launch_and_seed"],
        getConfig: () => ({ apiUrl: "https://api.test", apiKey: "cndl_live_k" }),
        ...options,
      })
      return text
    }
    const hosted = describeWith({ headlessSeed: true })
    expect(hosted).toContain("every plan, Free included, and needs no swap:write")
    expect(hosted).not.toContain("TIER_REQUIRED")
    const local = describeWith({})
    expect(local).toContain("Pro or Max (TIER_REQUIRED otherwise) and swap:write")
    expect(local).not.toContain("needs no swap:write")
  })

  test("vamp candidates says plainly it is for launching copies, in the spec's words (BE-1504)", () => {
    const d = describeOf("candle_vamp_candidates")
    expect(d).toBe(VAMP_CANDIDATES_DESCRIPTION)
    expect(d).toContain("whose ticker other tokens are copying")
    expect(d).toContain("candle_launch_token")
    expect(d).toContain("candle_launch_and_seed")
    expect(d).toContain("dryRun: true")
    expect(d).toContain("Counts exclude the candidate itself")
    expect(d).toContain("coverage.since")
    // Never calls a copy risky, "original" or "fake", and never names the data suppliers.
    expect(d).not.toMatch(/risk|original|fake|hacc|pump\.fun|helius|alchemy/i)
  })

  test("get_market explains routing, provenance and the general quote endpoint", () => {
    const d = describeOf("candle_get_market")
    expect(d).toContain("error.discovery")
    expect(d).toContain("trade.routable")
    expect(d).toContain("POST /api/v1/trade/agent/quote")
    expect(d).toContain("error.routing.reason")
  })

  test.each(["candle_get_market", "candle_resolve_token"])("%s identifies external placeholders", (name) => {
    const description = describeOf(name)
    for (const field of ["buysOpen", "sellsOpen", "quoteMint", "feeBps", "venue", "graduationVenue", "poolAddress"]) {
      expect(description).toContain(field)
    }
    expect(description).toContain("external: true")
    expect(description).toContain("compatibility placeholders, not measured facts")
    expect(description).toContain("trade.routable is stored eligibility")
    expect(description).toContain("does not verify those fields")
  })

  test("forensics refuses to let MARKET_NOT_FOUND read as clean", () => {
    const d = describeOf("candle_token_forensics")
    expect(d).toContain("MARKET_NOT_FOUND")
    expect(d).toContain("not 'clean'")
  })

  /*
   * The double-spend rule. `candle_swap` has carried it since it was written; `candle_trade` --
   * the tool this product exists for -- only said "a new id is a second trade" in passing, with
   * no mention of the read that answers "did it land" without re-sending.
   */
  // Ember 4c (4c-ED-12): the swap tool keeps its parameters and says where a TEE bridge runs.
  test("swap still bridges the embedded wallets, and names candle swap for a TEE wallet's bridge", () => {
    const d = describeOf("candle_swap")
    expect(d).toContain("BRIDGE")
    expect(d).toContain("candle swap")
    expect(d).toContain("same key's TEE wallet")
    expect(d).not.toContain("same-chain only")
  })

  test("trade names its pre-flight and points a lost result at get_operation, not a retry", () => {
    const d = describeOf("candle_trade")
    expect(d).toContain("candle_execution_status")
    expect(d).toContain("candle_token_forensics")
    expect(d).toContain("candle_get_operation")
    expect(d).toContain("SAME clientTradeId")
    expect(d).toContain("double-spend")
  })

  // BE-1411 T4 (R1, R2, I2). A missing row is "no record yet": a build can run for tens of seconds
  // before agentTrades.begin, so the 404 proves nothing about the write.
  test("a 404 from get_operation is no record yet, never proof, on get_operation and on trade", () => {
    for (const name of ["candle_get_operation", "candle_trade"]) {
      const d = describeOf(name)
      expect(d.toLowerCase()).not.toContain("nothing moved")
      expect(d.toLowerCase()).not.toContain("never reached")
      expect(d).not.toContain("safe to send again exactly as it was")
      expect(d).toContain("SAME request again with the SAME id")
      expect(d).toMatch(/new id/)
      // R2's four points: not proof, the same-id resend and what a refusal of it means, never a
      // new id, and the kind that was asked. Both local descriptions carry all four.
      expect(d).toContain("That does not prove the write did not run")
      expect(d).toContain("It never executes a second time")
      expect(d).toContain("is an answer about the resend, not about the write")
      expect(d).toContain("read candle_get_operation again before reporting an outcome")
      expect(d).toContain("a new id is a second trade or launch")
      expect(d).toContain("Check `kind`")
      expect(d).toContain("`clientSwapId`")
    }
    expect(describeOf("candle_get_operation")).not.toContain("This is a definite answer")
  })

  // BE-1411 R10: the swap text changes with the behaviour.
  test("swap says the id is generated and returned, and what to do with it after a timeout", () => {
    const d = describeOf("candle_swap")
    expect(d).not.toContain("never coalesces")
    expect(d).not.toContain("had no id")
    expect(d).toContain("Keep the returned `clientSwapId`")
    expect(d).toContain("`MCP_TRANSPORT`")
    expect(d).toContain("A new id is a second swap")
  })

  // Ember Phase 4d (4d-ED-11): both chains, and the facts an agent needs to read Hood correctly.
  test("get_portfolio names the hood section, the price keys, unpriced reasons and the scope", () => {
    const d = describeOf("candle_get_portfolio")
    expect(d).toContain("hood.embedded")
    expect(d).toContain("hood:native")
    expect(d).toContain("hood:<contract lowercased>")
    expect(d).toContain("unpricedReason")
    expect(d).toContain("complete")
    expect(d).toContain("walletsComplete")
    expect(d).toContain("account:read")
    expect(d).toContain("Vault and external wallets are not included")
  })

  test("get_profile_pnl explains chain and byChain", () => {
    const d = describeOf("candle_get_profile_pnl")
    expect(d).toContain("`chain`")
    expect(d).toContain("pnl.byChain")
    expect(d).toContain("both chains always present")
  })

  test("get_profile_pnl states the one-engine meaning and names the fields it added (P&L spec R4)", () => {
    const d = describeOf("candle_get_profile_pnl")
    expect(d).toContain("share of the account's P&L")
    expect(d).toContain("the same as the console's, to the cent")
    expect(d).toContain("the total is the sum of `pnl.byWallet`")
    expect(d).toContain("carries its cost and realizes nothing")
    for (const field of ["`pnl.totalUsd`", "`closed`", "`openPositionsExDust`", "`dust`", "`agent`", "`wallet`"]) {
      expect(d).toContain(field)
    }
    expect(d).toContain("`madeUsd` + `lostUsd` + `partialSellsUsd` = `realizedNetUsd`")
    // The pre-engine wording is gone: the rows now sum to the total, and transfers carry cost.
    expect(d).not.toContain("need not sum")
    expect(d).not.toContain("own fills")
    expect(d).not.toContain("transfers are excluded")
  })
})

/** Registers the named tools on a recorder and returns their handlers and schemas, wired to `doFetch`. */
function toolsWith(names: readonly ToolName[], doFetch: FetchLike) {
  type Result = { content: { type: string; text: string }[]; isError?: boolean }
  const tools = new Map<
    string,
    {
      inputSchema: Record<string, { description?: string }>
      handler: (args: Record<string, unknown>) => Promise<Result>
    }
  >()
  const server = {
    registerTool(
      name: string,
      definition: { inputSchema: Record<string, { description?: string }> },
      handler: (args: Record<string, unknown>) => Promise<Result>,
    ) {
      tools.set(name, { inputSchema: definition.inputSchema, handler })
    },
  } as unknown as Parameters<typeof registerToolSubset>[0]
  registerToolSubset(server, {
    tools: names,
    getConfig: () => ({ apiUrl: "https://api.test", apiKey: "cndl_live_k" }),
    fetch: doFetch,
  })
  const call = async (name: ToolName, args: Record<string, unknown>) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`${name} was not registered`)
    const result = await tool.handler(args)
    return { result, text: String(result.content[0]?.text) }
  }
  return { tools, call }
}

const answer = (status: number, text: string) => ({ ok: status < 400, status, text: async () => text })

// BE-1411 T5 (R3): the result carries the guidance, so a client that never read the description
// still gets it.
describe("candle_get_operation: what a 404 returns", () => {
  const NOT_FOUND = {
    success: false,
    error: { code: "JOB_NOT_FOUND", message: "No trade with that clientTradeId for this account" },
  }

  test("a 404 JOB_NOT_FOUND is the API's body plus outcome unknown and a next naming the id and kind", async () => {
    const urls: string[] = []
    const { call } = toolsWith(["candle_get_operation"], async (url) => {
      urls.push(url)
      return answer(404, JSON.stringify(NOT_FOUND))
    })
    for (const kind of ["trade", "launch"] as const) {
      const { result, text } = await call("candle_get_operation", { clientId: "op-1", kind })
      expect(result.isError).toBe(true)
      const body = JSON.parse(text)
      // The API's own fields are untouched; two are added.
      expect(body).toEqual({ ...NOT_FOUND, outcome: "unknown", next: body.next })
      expect(body.next).toContain('"op-1"')
      expect(body.next).toContain(`kind "${kind}"`)
      expect(body.next).toContain("That does not prove the write did not run")
      expect(body.next).toContain("SAME request again with the SAME id")
      expect(body.next).toContain("It never executes a second time")
      expect(body.next).toContain("is an answer about the resend, not about the write")
      expect(body.next).toContain("read candle_get_operation again before reporting an outcome")
      expect(body.next).toContain(`a new id is a second ${kind}`)
      expect(body.next).toContain("clientSwapId")
      expect(body.next.toLowerCase()).not.toContain("nothing moved")
      expect(body.next.toLowerCase()).not.toContain("never reached")
    }
    expect(urls).toEqual([
      "https://api.test/api/v1/trade/agent/jobs/op-1",
      "https://api.test/api/v1/launch/headless/jobs/op-1",
    ])
  })

  test("a 200, a 401, a 404 with another code and a 404 that is not JSON are relayed unchanged", async () => {
    const cases: [number, string][] = [
      [200, JSON.stringify({ success: true, job: { clientTradeId: "op-1", status: "confirmed", signature: "Sig" } })],
      [401, JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } })],
      [404, JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "No such route" } })],
      [404, "<html>404 Not Found</html>"],
      [404, JSON.stringify(["JOB_NOT_FOUND"])],
    ]
    for (const [status, sent] of cases) {
      const { call } = toolsWith(["candle_get_operation"], async () => answer(status, sent))
      const { result, text } = await call("candle_get_operation", { clientId: "op-1", kind: "trade" })
      expect(text).toBe(sent)
      expect(result.isError).toBe(status === 200 ? undefined : true)
    }
  })
})

// BE-1411 T7 to T10 (R6 to R9, I3, I4): the local swap always has an id.
describe("candle_swap: the request always carries an id, and every result returns it", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const SWAP = { from: "SOL", to: "USDC", amount: "0.5" }

  /** A swap fetch that records each posted body. */
  function swapWith(respond: () => ReturnType<FetchLike>) {
    const posted: Record<string, unknown>[] = []
    const { tools, call } = toolsWith(["candle_swap"], async (url, init) => {
      expect(url).toBe("https://api.test/api/v1/agent/swap")
      posted.push(JSON.parse(String(init?.body)))
      return respond()
    })
    return { tools, posted, swap: (args: Record<string, unknown>) => call("candle_swap", args) }
  }

  test("T7: no id posts a generated UUID, a caller's id is posted unchanged, an empty one is replaced", async () => {
    const { posted, swap } = swapWith(async () => answer(200, JSON.stringify({ success: true })))
    await swap(SWAP)
    await swap({ ...SWAP, clientSwapId: "mine-1" })
    await swap({ ...SWAP, clientSwapId: "" })
    expect(String(posted[0]?.clientSwapId)).toMatch(UUID)
    expect(posted[1]).toEqual({ from: "SOL", to: "USDC", amountRaw: "500000000", clientSwapId: "mine-1" })
    expect(String(posted[2]?.clientSwapId)).toMatch(UUID)
    // Two calls with no id are two swaps: nothing in the tool can tell a retry from a new intent.
    expect(posted[2]?.clientSwapId).not.toBe(posted[0]?.clientSwapId)
  })

  test("T8: a rejected fetch, an unreadable body and a non-JSON body return MCP_TRANSPORT with the id sent", async () => {
    const failures: (() => ReturnType<FetchLike>)[] = [
      async () => {
        throw new Error("socket hang up")
      },
      async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("body stream interrupted")
        },
      }),
      async () => answer(502, "<html>502 Bad Gateway</html>"),
      // A JSON body that is not an object has nowhere to carry the id, so it is not relayed bare.
      async () => answer(200, "null"),
    ]
    for (const respond of failures) {
      const { posted, swap } = swapWith(respond)
      const { result, text } = await swap(SWAP)
      expect(result.isError).toBe(true)
      const body = JSON.parse(text)
      expect(body.clientSwapId).toMatch(UUID)
      // I4: the id returned is the id that was sent.
      expect(body.clientSwapId).toBe(posted[0]?.clientSwapId)
      expect(body.success).toBe(false)
      expect(body.error.code).toBe("MCP_TRANSPORT")
      expect(body.error.retryable).toBe(true)
      expect(body.error.message).toContain(`SAME clientSwapId ("${body.clientSwapId}")`)
      expect(body.error.message).toContain("a NEW id is a second, independent swap")
    }
    const { swap } = swapWith(failures[0] as () => ReturnType<FetchLike>)
    const own = JSON.parse((await swap({ ...SWAP, clientSwapId: "mine-2" })).text)
    expect(own.clientSwapId).toBe("mine-2")
    expect(own.error.message).toContain("socket hang up")
  })

  test("T9: a 200 and a 4xx JSON body come back with clientSwapId added and every other field equal", async () => {
    const bodies: [number, Record<string, unknown>][] = [
      [200, { success: true, signature: "SwapSig", from: "SOL", to: "USDC", amounts: { inRaw: "500000000" } }],
      [
        409,
        { success: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "Swap still running", retryable: true } },
      ],
      [400, { success: false, error: { code: "VALIDATION_FAILED", message: "Unknown asset", field: "from" } }],
    ]
    for (const [status, sent] of bodies) {
      const { posted, swap } = swapWith(async () => answer(status, JSON.stringify(sent)))
      const { result, text } = await swap(SWAP)
      expect(result.isError).toBe(status === 200 ? undefined : true)
      const { clientSwapId, ...rest } = JSON.parse(text)
      expect(rest).toEqual(sent)
      expect(clientSwapId).toMatch(UUID)
      expect(clientSwapId).toBe(posted[0]?.clientSwapId)
    }
    // A body that already names the id (the hosted pending answer does) is relayed as it is.
    const pending = { success: false, error: { code: "OPERATION_PENDING", message: "…" }, clientSwapId: "mine-3" }
    const { swap } = swapWith(async () => answer(504, JSON.stringify(pending)))
    expect(JSON.parse((await swap({ ...SWAP, clientSwapId: "mine-3" })).text)).toEqual(pending)
  })

  test("T10: a refusal made before anything is sent is unchanged and makes no request", async () => {
    const { posted, swap } = swapWith(async () => answer(200, "{}"))
    await expect(swap({ from: "SOL", to: "USDC", amount: "0.5", amountRaw: "1" })).rejects.toThrow(/exactly one/)
    await expect(swap({ from: "SOL", to: "USDC" })).rejects.toThrow(/Pass an amount/)
    await expect(swap({ from: "DOGE", to: "USDC", amount: "1" })).rejects.toThrow(/Unknown decimals/)
    expect(posted).toEqual([])
  })

  test("R10: the clientSwapId field says it is generated when omitted and returned in the result", () => {
    const { tools } = swapWith(async () => answer(200, "{}"))
    const described = String(tools.get("candle_swap")?.inputSchema.clientSwapId?.description)
    expect(described).toContain("generated")
    expect(described).toContain("returned in the result")
    expect(described).not.toContain("nothing is coalesced")
  })
})

/*
  BE-1515: the launcher-chosen curve on the agent surface (spec
  2026-10-16-launcher-chosen-curves-design.md, section 5). No new tool: both launch tools take
  `curve` beside mode exp-custom, and their descriptions carry the section 3 rule and the dry run.
*/
describe("exp-custom on both launch tools", () => {
  const LAUNCH_TOOLS = ["candle_launch_token", "candle_launch_and_seed"] as const
  const registered = () => {
    const tools: Record<string, { description: string; inputSchema: z.ZodRawShape }> = {}
    const server = {
      registerTool(name: string, config: { description?: string; inputSchema: z.ZodRawShape }) {
        tools[name] = { description: config.description ?? "", inputSchema: config.inputSchema }
      },
    }
    registerTools(server as never, {})
    return tools
  }
  const CURVE = { virtualQuote: "12", threshold: "40" }
  const BASE = { clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x/y.png" }

  test("descriptions state the shared exp-custom, poolOpen and expPoolShape sentences", () => {
    const virtual = launchFieldHelp("curve.virtualQuote")
    const threshold = launchFieldHelp("curve.threshold")
    const poolOpen = launchFieldHelp("poolOpen")
    const shape = launchFieldHelp("expPoolShape")
    for (const name of LAUNCH_TOOLS) {
      const description = registered()[name]?.description ?? ""
      expect(description).toContain(virtual)
      expect(description).toContain(threshold)
      expect(description).toContain(poolOpen)
      expect(description).toContain(shape)
      expect(description).not.toContain("(V + 20G)^2")
      expect(description).not.toContain("CURVE_OUT_OF_RANGE")
    }
  })

  test.each([...LAUNCH_TOOLS])("%s describes exp-custom and takes curve", (name) => {
    const tool = registered()[name]
    expect(tool?.description).toContain(launchFieldHelp("curve.virtualQuote"))
    expect(tool?.inputSchema.mode?.description).toContain("exp-custom")
    expect(tool?.inputSchema.curve?.description).toContain(launchFieldHelp("curve.threshold"))
    // The schema the MCP SDK parses with keeps curve, so it reaches the API.
    const parsed = z.object(tool?.inputSchema ?? {}).parse({ ...BASE, mode: "exp-custom", curve: CURVE })
    expect(parsed.curve).toEqual(CURVE)
    // An unknown curve key is refused here rather than stripped, so the API never sees a curve
    // with a field missing from what the caller meant.
    expect(() => z.object(tool?.inputSchema ?? {}).parse({ ...BASE, curve: { ...CURVE, v: "1" } })).toThrow()
    expect(() =>
      z.object(tool?.inputSchema ?? {}).parse({ ...BASE, curve: { virtualQuote: 12, threshold: "40" } }),
    ).toThrow()
  })

  test("candle_launch_token forwards curve verbatim, to the dry run and to the launch", () => {
    for (const dryRun of [true, false]) {
      const r = buildRequest(
        "candle_launch_token",
        { ...BASE, mode: "exp-custom", curve: CURVE, dryRun },
        { apiUrl: "https://api.test", apiKey: "k" },
      )
      expect(r.url).toBe(`https://api.test/api/v1/launch/headless${dryRun ? "/dry-run" : ""}`)
      expect(JSON.parse(String(r.init.body))).toEqual({ ...BASE, mode: "exp-custom", curve: CURVE })
    }
  })

  test("candle_launch_and_seed forwards curve with its converted seed", async () => {
    const bodies: unknown[] = []
    const fetchLike: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ success: true, dryRun: true }), { status: 200 })
    }
    const { call } = toolsWith(["candle_launch_and_seed"], fetchLike)
    await call("candle_launch_and_seed", { ...BASE, mode: "exp-custom", curve: CURVE, devBuy: "0.4", dryRun: true })
    // BE-1849: a Solana seed is the atomic launch's first buy, on its dry run.
    const payer = { type: "main" }
    expect(bodies).toEqual([
      { ...BASE, mode: "exp-custom", curve: CURVE, payer, firstBuys: [{ payer, amountRaw: "400000000" }] },
    ])
  })
})

describe("pool choices on both launch tools", () => {
  const tools: Record<string, { inputSchema: z.ZodRawShape }> = {}
  registerTools(
    {
      registerTool(name: string, config: { inputSchema: z.ZodRawShape }) {
        tools[name] = { inputSchema: config.inputSchema }
      },
    } as never,
    {},
  )
  const BASE = { clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x/y.png" }
  const FALL = { startBps: 2500, endBps: 25, minutes: 30 }

  test.each([
    "candle_launch_token",
    "candle_launch_and_seed",
  ])("%s describes the conditional pool opening default", (name) => {
    const description = tools[name]?.inputSchema.poolOpen?.description
    expect(description).toBe(launchFieldHelp("poolOpen"))
    expect(description).toContain("graduation.maxStakerCarveBps")
    expect(description).toContain("otherwise legacy")
    expect(tools[name]?.inputSchema.expPoolShape?.description).toBe(launchFieldHelp("expPoolShape"))
  })

  test.each(["candle_launch_token", "candle_launch_and_seed"])("%s parses a tier, a fall and each shape", (name) => {
    const schema = z.object(tools[name]?.inputSchema ?? {})
    expect(schema.parse({ ...BASE, poolFee: { tier: 25 }, poolOpen: "curve_price" })).toMatchObject({
      poolFee: { tier: 25 },
      poolOpen: "curve_price",
    })
    expect(schema.parse({ ...BASE, mode: "exp-b", poolFee: FALL, expPoolShape: "full_range" })).toMatchObject({
      mode: "exp-b",
      poolFee: FALL,
      expPoolShape: "full_range",
    })
    // Omitted stays omitted: a default launch adds no field.
    const plain = schema.parse(BASE)
    for (const field of ["poolFee", "poolOpen", "expPoolShape"]) expect(plain).not.toHaveProperty(field)
    // A misspelled economic field is refused here, not stripped.
    expect(() => schema.parse({ ...BASE, poolFee: { tier: 30 } })).toThrow()
    expect(() => schema.parse({ ...BASE, poolFee: { tier: 25, extra: 1 } })).toThrow()
    expect(() => schema.parse({ ...BASE, poolOpen: "last_price" })).toThrow()
  })

  test("candle_launch_token forwards the parsed choices to the dry run and the launch", () => {
    const preset = { poolFee: FALL, poolOpen: "curve_price" }
    const experimental = { mode: "exp-b", expPoolShape: "full_range" }
    const schema = z.object(tools.candle_launch_token?.inputSchema ?? {})
    const presetArgs = schema.parse({ ...BASE, ...preset })
    const expArgs = schema.parse({ ...BASE, ...experimental })
    for (const dryRun of [true, false]) {
      const presetRequest = buildRequest(
        "candle_launch_token",
        { ...presetArgs, dryRun },
        { apiUrl: "https://api.test", apiKey: "k" },
      )
      expect(JSON.parse(String(presetRequest.init.body))).toEqual({ ...BASE, ...preset })
      const expRequest = buildRequest(
        "candle_launch_token",
        { ...expArgs, dryRun },
        { apiUrl: "https://api.test", apiKey: "k" },
      )
      expect(JSON.parse(String(expRequest.init.body))).toEqual({ ...BASE, ...experimental })
    }
  })

  test("candle_launch_and_seed forwards the choices with its converted seed", async () => {
    const bodies: unknown[] = []
    const fetchLike: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ success: true, dryRun: true }), { status: 200 })
    }
    const { call } = toolsWith(["candle_launch_and_seed"], fetchLike)
    await call("candle_launch_and_seed", {
      ...BASE,
      poolFee: { tier: 100 },
      poolOpen: "curve_price",
      devBuy: "0.4",
      dryRun: true,
    })
    // BE-1849: a Solana seed is the atomic launch's first buy, and the pool choices ride that body.
    // 0.4 SOL is under the local ceiling, so the dry run is the request this assertion sees.
    const payer = { type: "main" }
    expect(bodies).toEqual([
      {
        ...BASE,
        poolFee: { tier: 100 },
        poolOpen: "curve_price",
        payer,
        firstBuys: [{ payer, amountRaw: "400000000" }],
      },
    ])
  })
})

/*
  BE-1806: the same launch inputs on every surface (spec
  2026-10-23-launch-reliability-and-parity-design.md, section 4). The API is the validator; these
  tools forward what the HTTP body takes, and relay the dry run's answer verbatim.
*/
describe("launch parity (BE-1806)", () => {
  const BASE = { clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x/y.png" }
  const CUSTOM = { mode: "exp-custom", curve: { virtualQuote: "4", threshold: "20" }, creatorFeeBps: 100 }
  const RESOLVED = {
    chain: "solana",
    quoteAsset: "sol",
    mode: "exp-custom",
    stakerAllocationBps: 500,
    creatorFeeBps: 100,
    curve: { virtualQuoteRaw: "4000000000", thresholdRaw: "20000000000" },
    dexVersion: null,
    visibility: "production",
    buyAmount: "300000000",
  }

  test("candle_launch_token sends exp-custom with curve and creatorFeeBps, and relays the resolved block", async () => {
    const sent: { url: string; body: unknown }[] = []
    const { tools, call } = toolsWith(["candle_launch_token"], async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return answer(200, JSON.stringify({ success: true, dryRun: true, resolved: RESOLVED, devBuyMax: "500000000" }))
    })
    const schema = z.object(tools.get("candle_launch_token")?.inputSchema as z.ZodRawShape)
    const args = schema.parse({ ...BASE, ...CUSTOM, buyAmount: "300000000", dryRun: true })
    const { result, text } = await call("candle_launch_token", args)
    expect(result.isError).toBeUndefined()
    expect(sent).toEqual([
      {
        url: "https://api.test/api/v1/launch/headless/dry-run",
        body: { ...BASE, ...CUSTOM, buyAmount: "300000000" },
      },
    ])
    expect(JSON.parse(text).resolved).toEqual(RESOLVED)
  })

  test("creatorFeeBps takes 0, 100 or 200 and nothing else", () => {
    const shape = z.object(
      toolsWith(["candle_launch_token"], async () => answer(200, "{}")).tools.get("candle_launch_token")
        ?.inputSchema as z.ZodRawShape,
    )
    for (const creatorFeeBps of [0, 100, 200])
      expect(shape.parse({ ...BASE, creatorFeeBps }).creatorFeeBps).toBe(creatorFeeBps)
    expect(() => shape.parse({ ...BASE, creatorFeeBps: 150 })).toThrow()
    expect(() => shape.parse({ ...BASE, creatorFeeBps: "100" })).toThrow()
  })

  test("candle_launch_and_seed forwards creatorFeeBps beside its converted seed", async () => {
    const bodies: unknown[] = []
    const { call } = toolsWith(["candle_launch_and_seed"], async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return answer(200, JSON.stringify({ success: true, dryRun: true }))
    })
    await call("candle_launch_and_seed", { ...BASE, ...CUSTOM, devBuy: "0.3", dryRun: true })
    // BE-1849: a Solana seed is the atomic launch's first buy; creatorFeeBps and the curve ride that body.
    const payer = { type: "main" }
    expect(bodies).toEqual([{ ...BASE, ...CUSTOM, payer, firstBuys: [{ payer, amountRaw: "300000000" }] }])
  })
})
