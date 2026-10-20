/**
 * BE-1665 (spec K-7): the executor runs the `candle mcp` tool code in-process with the Write key,
 * against a fake API here.
 */
import { describe, expect, test } from "bun:test"
import { mcpExecutor, outcomeOf } from "./executor"
import { WRITE_KEY } from "./test-fixtures"

const API = "https://staging.api.candle.tv"

function fakeApi(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return respond(String(url), init)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe("mcpExecutor", () => {
  test("a real operation read preserves a failed record for reconciliation", async () => {
    const body = { job: { status: "failed", errorCode: "TRADE_REVERTED" } }
    const api = fakeApi(() => Response.json(body))
    const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(
      "candle_get_operation",
      { clientId: "trade-failed", kind: "trade" },
      WRITE_KEY,
    )
    expect(outcome).toEqual({ state: "succeeded", result: body })
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.url).toContain("trade-failed")
  })

  test("sends the tool's own request with the Write key, under the id the card fixed", async () => {
    const api = fakeApi(() => Response.json({ success: true, signature: "sig1" }))
    const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(
      "candle_claim_staking_reward",
      { rewardId: "rw_1" },
      WRITE_KEY,
    )
    expect(outcome).toEqual({ state: "succeeded", result: { success: true, signature: "sig1" } })
    expect(api.calls.length).toBe(1)
    expect(api.calls[0]?.url).toBe(`${API}/api/v1/agent/staking/rewards/rw_1/claim`)
    expect(new Headers(api.calls[0]?.init?.headers).get("x-api-key")).toBe(WRITE_KEY)
  })

  test("input the tool's schema refuses is refused before anything is sent", async () => {
    const api = fakeApi(() => Response.json({}))
    const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(
      "candle_claim_staking_reward",
      { rewardId: "" },
      WRITE_KEY,
    )
    expect(outcome).toMatchObject({ state: "refused", error: { code: "MCP_VALIDATION" } })
    expect(api.calls).toEqual([])
  })

  test("a request that throws in transit is unknown, never failed", async () => {
    const api = fakeApi(() => {
      throw new TypeError("fetch failed")
    })
    const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(
      "candle_claim_staking_reward",
      { rewardId: "rw_2" },
      WRITE_KEY,
    )
    expect(outcome.state).toBe("unknown")
  })

  test("an API refusal is refused; a 5xx is unknown", async () => {
    const limit = fakeApi(() =>
      Response.json({ success: false, error: { code: "KEY_LIMIT_REACHED", message: "over" } }, { status: 403 }),
    )
    expect(
      await mcpExecutor({ apiUrl: API, fetch: limit.fetch }).execute(
        "candle_claim_staking_reward",
        { rewardId: "r" },
        WRITE_KEY,
      ),
    ).toMatchObject({
      state: "refused",
      error: { code: "KEY_LIMIT_REACHED" },
    })
    const broken = fakeApi(() =>
      Response.json({ success: false, error: { code: "SWAP_FAILED", message: "no" } }, { status: 500 }),
    )
    expect(
      await mcpExecutor({ apiUrl: API, fetch: broken.fetch }).execute(
        "candle_claim_staking_reward",
        { rewardId: "r" },
        WRITE_KEY,
      ),
    ).toMatchObject({
      state: "unknown",
    })
  })

  for (const tool of ["candle_trade", "candle_launch_and_seed"] as const) {
    const params =
      tool === "candle_trade"
        ? { clientTradeId: "trade-1", mint: "M1nt", side: "buy", amount: "0.5" }
        : { clientLaunchId: "launch-1", name: "Fixture", symbol: "FIX", imageUrl: "https://example.com/image.png" }
    const writePath = tool === "candle_trade" ? "/api/v1/trade/agent/build" : "/api/v1/launch/headless"
    const cases = [
      { name: "confirmed", body: { success: true, status: "confirmed" }, state: "succeeded" },
      { name: "running job", body: { success: true, job: { status: "running" } }, state: "pending" },
      { name: "built", body: { success: true, status: "built" }, state: "pending" },
      { name: "confirming", body: { success: true, status: "confirming" }, state: "pending" },
      { name: "failed job", body: { success: true, job: { status: "failed" } }, state: "failed" },
      {
        name: "key limit",
        status: 403,
        body: { error: { code: "KEY_LIMIT_REACHED", message: "over" } },
        state: "refused",
      },
      {
        name: "trading disabled",
        status: 403,
        body: { error: { code: "AGENT_TRADING_DISABLED", message: "off" } },
        state: "refused",
      },
      {
        name: "server error",
        status: 500,
        body: { error: { code: "SWAP_FAILED", message: "lost" } },
        state: "unknown",
      },
      {
        name: "5xx with refusal code",
        status: 503,
        body: { error: { code: "KEY_LIMIT_REACHED", message: "unavailable" } },
        state: "unknown",
      },
      {
        name: "undocumented error",
        status: 400,
        body: { error: { code: "UNRECOGNISED_ERROR", message: "uncertain" } },
        state: "unknown",
      },
    ] as const
    for (const scenario of cases) {
      test(`${tool}: ${scenario.name} through its real MCP handler`, async () => {
        const api = fakeApi((url) => {
          if (url.endsWith(writePath))
            return Response.json(scenario.body, { status: "status" in scenario ? scenario.status : 200 })
          if (url.endsWith("/api/v1/markets/solana/M1nt"))
            return Response.json({ market: { decimals: 6, quoteDecimals: 9 } })
          throw new Error(`unrouted fixture: ${url}`)
        })
        const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(tool, params, WRITE_KEY)
        expect(outcome.state).toBe(scenario.state)
        const write = api.calls.filter((call) => call.url.endsWith(writePath))
        expect(write).toHaveLength(1)
        const request = JSON.parse(String(write[0]?.init?.body))
        expect(request[tool === "candle_trade" ? "clientTradeId" : "clientLaunchId"]).toBe(
          tool === "candle_trade" ? "trade-1" : "launch-1",
        )
        expect(new Headers(write[0]?.init?.headers).get("x-api-key")).toBe(WRITE_KEY)
        if ("error" in scenario.body) expect(outcome).toMatchObject({ error: { code: scenario.body.error.code } })
      })
    }
  }

  test("a failed follow-up market read does not erase a confirmed launch", async () => {
    const api = fakeApi((url) =>
      url.endsWith("/api/v1/launch/headless")
        ? Response.json({ status: "confirmed", mint: "M1nt", chain: "solana" })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    )
    const outcome = await mcpExecutor({ apiUrl: API, fetch: api.fetch }).execute(
      "candle_launch_and_seed",
      { clientLaunchId: "launch-2", name: "Fixture", symbol: "FIX", imageUrl: "https://example.com/image.png" },
      WRITE_KEY,
    )
    expect(outcome.state).toBe("succeeded")
    expect(api.calls).toHaveLength(2)
  })

  test("a tool the MCP code does not register is refused", async () => {
    expect((await mcpExecutor({ apiUrl: API }).execute("candle_nonexistent", {}, WRITE_KEY)).state).toBe("refused")
  })
})

describe("outcomeOf", () => {
  const text = (value: unknown, isError?: boolean) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  })
  test("pending, transport and unreadable results", () => {
    expect(outcomeOf(text({ job: { status: "running" } })).state).toBe("pending")
    expect(outcomeOf(text({ success: false, error: { code: "MCP_TRANSPORT", message: "lost" } }, true)).state).toBe(
      "unknown",
    )
    expect(outcomeOf({ content: [{ type: "text", text: "Error: boom" }], isError: true }).state).toBe("unknown")
    expect(outcomeOf({ content: [{ type: "text", text: "not json" }] }).state).toBe("unknown")
    expect(outcomeOf(text({ api: "not json" })).state).toBe("unknown")
    expect(outcomeOf(text({ launch: null })).state).toBe("unknown")
    expect(outcomeOf(text([])).state).toBe("unknown")
  })
})
