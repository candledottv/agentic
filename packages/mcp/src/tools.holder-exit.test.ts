/** BE-3794 (BE-3630 spec 6.3 and 10): candle_holder_exit and candle_claim_holder_exit against a mocked API. */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { HOLDER_EXIT_DISCLOSURE } from "./market-disclosure"
import { buildRequest, registerToolSubset, type ToolName } from "./tools"

const CURVE = "0x1111111111111111111111111111111111111111"
const TOKEN = "0x2222222222222222222222222222222222222222"
const ACCOUNT = "0x3333333333333333333333333333333333333333"
const cfg = { apiUrl: "https://api.test", apiKey: "k" }

type Tool = {
  definition: { inputSchema: z.ZodRawShape; description: string }
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
}

function harness(answer: (path: string) => Response, names: readonly ToolName[], apiKey: string | undefined = "k") {
  const tools = new Map<string, Tool>()
  const server = {
    registerTool(name: string, definition: Tool["definition"], handler: Tool["handler"]) {
      tools.set(name, { definition, handler })
    },
  } as unknown as Parameters<typeof registerToolSubset>[0]
  const calls: { path: string; method: string; body: unknown }[] = []
  registerToolSubset(server, {
    tools: names,
    getConfig: () => ({ apiUrl: "https://api.test", ...(apiKey ? { apiKey } : {}) }),
    fetch: async (url, init) => {
      const parsed = new URL(url)
      const path = `${parsed.pathname}${parsed.search}`
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return answer(path)
    },
  })
  const tool = (name: string) => {
    const found = tools.get(name)
    if (!found) throw new Error(`${name} was not registered`)
    return found
  }
  return { tool, calls }
}

const view = (state: string) => ({ state, disclosure: `disclosure for ${state}`, actions: [] })

describe("buildRequest", () => {
  test("candle_holder_exit reads the curve, keyless, with the account when given", () => {
    const plain = buildRequest("candle_holder_exit", { curve: CURVE }, { apiUrl: "https://api.test" })
    expect(plain.url).toBe(`https://api.test/api/v1/hood/curves/${CURVE}/holder-exit`)
    expect(plain.init.method).toBe("GET")
    expect((plain.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
    expect(buildRequest("candle_holder_exit", { curve: CURVE, account: ACCOUNT }, cfg).url).toBe(
      `https://api.test/api/v1/hood/curves/${CURVE}/holder-exit?account=${ACCOUNT}`,
    )
  })

  test("candle_claim_holder_exit forwards only its own fields, dryRun defaulting to true", () => {
    const r = buildRequest(
      "candle_claim_holder_exit",
      { curve: CURVE, action: "claim_recovery", amountRaw: "5", wallet: ACCOUNT, to: "0xelsewhere", recipient: "x" },
      cfg,
    )
    expect(r.url).toBe(`https://api.test/api/v1/agent/hood/holder-exit/${CURVE}`)
    expect(r.init.method).toBe("POST")
    expect(JSON.parse(String(r.init.body))).toEqual({
      action: "claim_recovery",
      amountRaw: "5",
      dryRun: true,
      wallet: ACCOUNT,
    })
    const send = buildRequest("candle_claim_holder_exit", { curve: CURVE, action: "claim_team", dryRun: false }, cfg)
    expect(JSON.parse(String(send.init.body))).toEqual({ action: "claim_team", dryRun: false })
  })

  test("candle_claim_holder_exit needs a key", () => {
    expect(() =>
      buildRequest(
        "candle_claim_holder_exit",
        { curve: CURVE, action: "enter_recovery" },
        { apiUrl: "https://api.test" },
      ),
    ).toThrow("API_KEY")
  })
})

describe("candle_holder_exit", () => {
  for (const state of ["none", "awaiting_migration", "recovery_open", "recovery", "rescue_pending", "rescued"]) {
    test(`relays the ${state} read as sent`, async () => {
      const body = { payload: { curve: CURVE, token: TOKEN, holderExit: view(state) } }
      const h = harness(() => Response.json(body), ["candle_holder_exit"])
      const result = await h.tool("candle_holder_exit").handler({ curve: CURVE, account: ACCOUNT })
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(body)
      expect(h.calls).toEqual([
        { path: `/api/v1/hood/curves/${CURVE}/holder-exit?account=${ACCOUNT}`, method: "GET", body: undefined },
      ])
    })
  }

  test("a token resolves its curve from the market, then reads it", async () => {
    const h = harness(
      (path) =>
        path.startsWith("/api/v1/markets/")
          ? Response.json({ success: true, market: { chain: "hood", mint: TOKEN, curveAddress: CURVE } })
          : Response.json({ payload: { curve: CURVE, token: TOKEN, holderExit: view("recovery") } }),
      ["candle_holder_exit"],
    )
    const result = await h.tool("candle_holder_exit").handler({ token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(h.calls.map((c) => c.path)).toEqual([
      `/api/v1/markets/hood/${TOKEN}`,
      `/api/v1/hood/curves/${CURVE}/holder-exit`,
    ])
  })

  test("a token with no curve answers NO_HOOD_CURVE; a market error is relayed", async () => {
    const noCurve = harness(
      () => Response.json({ success: true, market: { curveAddress: null } }),
      ["candle_holder_exit"],
    )
    const result = await noCurve.tool("candle_holder_exit").handler({ token: TOKEN })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]?.text ?? "").error.code).toBe("NO_HOOD_CURVE")

    const missing = { success: false, error: { code: "MARKET_NOT_FOUND", message: "none" } }
    const notFound = harness(() => Response.json(missing, { status: 404 }), ["candle_holder_exit"])
    const relayed = await notFound.tool("candle_holder_exit").handler({ token: TOKEN })
    expect(relayed.isError).toBe(true)
    expect(JSON.parse(relayed.content[0]?.text ?? "")).toEqual(missing)
  })

  test("neither curve nor token is refused before any request", async () => {
    const h = harness(() => Response.json({}), ["candle_holder_exit"])
    const result = await h.tool("candle_holder_exit").handler({})
    expect(result.isError).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  test("a 404 and a 503 read are relayed as errors", async () => {
    for (const [status, body] of [
      [404, { error: true, payload: "No Candle curve at this address" }],
      [503, { error: true, code: "FEED_UNAVAILABLE", payload: "Holder-exit read unavailable" }],
    ] as const) {
      const h = harness(() => Response.json(body, { status }), ["candle_holder_exit"])
      const result = await h.tool("candle_holder_exit").handler({ curve: CURVE })
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(body)
    }
  })

  test("the schema refuses a non-address", () => {
    const h = harness(() => Response.json({}), ["candle_holder_exit"])
    const schema = z.object(h.tool("candle_holder_exit").definition.inputSchema)
    expect(schema.safeParse({ curve: "abc" }).success).toBe(false)
    expect(schema.safeParse({ curve: CURVE, account: ACCOUNT }).success).toBe(true)
  })
})

describe("candle_claim_holder_exit", () => {
  test("a dry run by default; the refusal is relayed with its code", async () => {
    const refusal = {
      success: false,
      error: {
        code: "HOOD_RECOVERY_NOT_READY",
        message: "Recovery isn't open",
        retryable: false,
        stage: "not_broadcast",
        details: { creatorMayEnterAt: "1", anyoneMayEnterAt: "2" },
      },
    }
    const h = harness(() => Response.json(refusal, { status: 409 }), ["candle_claim_holder_exit"])
    const schema = z.object(h.tool("candle_claim_holder_exit").definition.inputSchema)
    const result = await h
      .tool("candle_claim_holder_exit")
      .handler(schema.parse({ curve: CURVE, action: "enter_recovery" }))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(refusal)
    expect(h.calls[0]?.body).toEqual({ action: "enter_recovery", dryRun: true })
  })

  test("a partial outcome is relayed with its calls", async () => {
    const partial = {
      success: false,
      error: { code: "HOOD_EXIT_FAILED", message: "did not complete", retryable: true, stage: "reverted" },
      outcome: "partial",
      calls: [
        { kind: "approve", status: "confirmed" },
        { kind: "claim_recovery", status: "reverted" },
      ],
    }
    const h = harness(() => Response.json(partial, { status: 409 }), ["candle_claim_holder_exit"])
    const result = await h
      .tool("candle_claim_holder_exit")
      .handler({ curve: CURVE, action: "claim_recovery", dryRun: false })
    expect(JSON.parse(result.content[0]?.text ?? "").outcome).toBe("partial")
  })

  test("the schema takes only the three actions and a positive raw amount", () => {
    const h = harness(() => Response.json({}), ["candle_claim_holder_exit"])
    const schema = z.object(h.tool("candle_claim_holder_exit").definition.inputSchema)
    expect(schema.safeParse({ curve: CURVE, action: "rescue" }).success).toBe(false)
    expect(schema.safeParse({ curve: CURVE, action: "claim_recovery", amountRaw: "0" }).success).toBe(false)
    expect(schema.safeParse({ curve: CURVE, action: "claim_recovery", amountRaw: "12" }).success).toBe(true)
  })
})

test("every holder-exit surface quotes the holder-exit disclosure", () => {
  const h = harness(() => Response.json({}), ["candle_get_market", "candle_holder_exit", "candle_claim_holder_exit"])
  for (const name of ["candle_get_market", "candle_holder_exit", "candle_claim_holder_exit"])
    expect(h.tool(name).definition.description).toContain(HOLDER_EXIT_DISCLOSURE)
})
