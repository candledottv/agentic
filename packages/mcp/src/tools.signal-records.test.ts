import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MEASURE } from "./signal-records"
import { registerToolSubset, resolveToolAllowlist, SIGNAL_RECORD_TOOL_NAMES, TOOL_NAMES } from "./tools"

/*
 * BE-3411 (hacc north-star CL1): the three stdio signal record tools, driven through a real MCP
 * client over an in-memory transport, against a faked hacc (no network). The rules worth failing
 * on: names, titles, input schemas and annotations exactly as hacc's generated catalog; the fixed
 * line in every result (success, empty, error, 404, transport, refused key); GET only, with the
 * production key as a Bearer to hacc and nowhere else.
 */

/**
 * The `candle_signal_scorecard`, `candle_signal_records` and `candle_signal_record` entries of
 * hacc's `docs/generated/mcp-tools.json` (wallet-track 321723e5, C2), copied verbatim.
 */
const CATALOG = [
  {
    name: "candle_signal_scorecard",
    title: "hacc signal scorecard",
    description:
      'The daily hacc scorecard\'s signal aggregates: signal lift against the matched baseline, and per source, rule and horizon counts, mean net returns, tails and delay. Every response carries measure: "Measured record, not a forecast." Quote that line with any figure you take from it. A record is a fact, never a forecast or advice.',
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          format: "date",
          description: "YYYY-MM-DD; absent is the latest.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "candle_signal_records",
    title: "hacc signal records",
    description:
      'Per-signal measured records, newest first: marks, conservative and priced net returns, the 24 h path and the matched baseline. Every response carries measure: "Measured record, not a forecast." Quote that line with any figure you take from it. A record is a fact, never a forecast or advice.',
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["pattern", "quant_call", "holder_band", "launch_read"],
        },
        before: {
          type: "integer",
          minimum: 1,
          description: "The previous page's next_before.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "candle_signal_record",
    title: "hacc signal record",
    description:
      'One signal\'s measured record. Every response carries measure: "Measured record, not a forecast." Quote that line with any figure you take from it. A record is a fact, never a forecast or advice.',
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["pattern", "quant_call", "holder_band", "launch_read"],
        },
        source_id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "The source's own id: the signal id for pattern, chain:mint for launch_read.",
        },
      },
      required: ["source", "source_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
] as const

const LIVE_KEY = "cndl_live_signalstestkey"
const scorecard = {
  date: "2026-11-12",
  as_of: "2026-11-13T00:05:00Z",
  signal_lift: 0.0123,
  signal_pairs: 412,
  pending_24h: 37,
  rows: [],
  measure: MEASURE,
}
const record = {
  source: "pattern",
  source_id: "12345",
  variant: "confluence",
  chain: "solana",
  emitted_at: "2026-11-12T10:00:00Z",
  backfilled: false,
  entry_status: "priced",
  outcome_status: { "15m": "priced", "1h": "stale", "4h": "none", "24h": null },
  net_return_conservative: { "15m": 0.031, "1h": -0.12, "4h": -1, "24h": null },
  net_return_priced: { "15m": 0.031, "1h": null, "4h": null, "24h": null },
  path_24h: {
    max_multiple: 1.4,
    hit_2x: false,
    hit_5x: false,
    hit_20x: false,
    drawdown_before_2x: -0.3,
    settled: false,
  },
  baseline: null,
  measure: MEASURE,
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>

async function connect(options: { apiKey?: string; env?: Record<string, string | undefined> } = {}) {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  let respond: Handler = () => Response.json({ error: "unset" }, { status: 500 })
  const server = new McpServer({ name: "t", version: "0" })
  registerToolSubset(server, {
    tools: SIGNAL_RECORD_TOOL_NAMES,
    getConfig: () => ({ apiUrl: "https://api.test", apiKey: "apiKey" in options ? options.apiKey : LIVE_KEY }),
    env: options.env ?? {},
    fetch: (async (url: unknown, init?: RequestInit) => {
      const parsed = new URL(String(url))
      requests.push({ url: parsed, init })
      return respond(parsed, init)
    }) as never,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "c", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    requests,
    respondWith(fn: Handler) {
      respond = fn
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      requests.length = 0
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>
        isError?: boolean
      }
      const text = result.content[0]?.text ?? ""
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(text)
      } catch {}
      return { text, body, isError: result.isError === true, requests: [...requests] }
    },
  }
}

describe("BE-3411 signal record tools: the catalog's names, schemas and annotations", () => {
  test("all three are tool names, in the default allowlist, and listed exactly as hacc's catalog", async () => {
    for (const entry of CATALOG) {
      expect(TOOL_NAMES as readonly string[]).toContain(entry.name)
      expect(resolveToolAllowlist({}).has(entry.name as never)).toBe(true)
    }
    const { client } = await connect()
    const { tools } = await client.listTools()
    await client.close()
    expect(tools.map((t) => t.name).sort()).toEqual(CATALOG.map((e) => e.name).sort())
    for (const entry of CATALOG) {
      const tool = tools.find((t) => t.name === entry.name)
      expect(tool?.title).toBe(entry.title)
      expect(tool?.annotations).toEqual({ ...entry.annotations })
      expect(tool?.description?.startsWith(entry.description)).toBe(true)
      const { $schema: _ignored, ...schema } = (tool?.inputSchema ?? {}) as Record<string, unknown>
      expect([entry.name, schema]).toEqual([entry.name, JSON.parse(JSON.stringify(entry.inputSchema))])
    }
  })

  test("the input is strict, as the catalog's additionalProperties false: an unknown field is refused", async () => {
    const t = await connect()
    const r = await t.call("candle_signal_records", { source: "pattern", wallet: "x" })
    expect(r.isError).toBe(true)
    expect(r.body.measure).toBe(MEASURE)
    expect(r.text).toContain(MEASURE)
    expect(r.requests).toEqual([])
    await t.client.close()
  })
})

describe("BE-3411 signal record tools: reads", () => {
  test("scorecard GETs the latest or one day's route, with the key as a Bearer to hacc only", async () => {
    const t = await connect()
    t.respondWith(() => Response.json(scorecard))
    for (const [args, path] of [
      [{}, "/v1/public/scorecard"],
      [{ date: "2026-11-12" }, "/v1/public/scorecard/2026-11-12"],
    ] as const) {
      const r = await t.call("candle_signal_scorecard", args)
      expect(r.isError).toBe(false)
      expect(r.body).toEqual(scorecard)
      expect(r.text).toContain(`"measure":"${MEASURE}"`)
      expect(r.requests).toHaveLength(1)
      const [req] = r.requests
      expect(req?.url.origin).toBe("https://api.hacc.fun")
      expect(req?.url.pathname).toBe(path)
      expect(req?.init?.method).toBe("GET")
      expect(req?.init?.body).toBeUndefined()
      expect(new Headers(req?.init?.headers).get("authorization")).toBe(`Bearer ${LIVE_KEY}`)
    }
    await t.client.close()
  })

  test("records sends source, before and limit (default 50) and returns the page with the fixed line", async () => {
    const t = await connect()
    const page = { records: [record], next_before: 900, measure: MEASURE }
    t.respondWith(() => Response.json(page))
    let r = await t.call("candle_signal_records", { source: "holder_band", before: 1000, limit: 10 })
    expect(Object.fromEntries(r.requests[0]?.url.searchParams ?? [])).toEqual({
      source: "holder_band",
      before: "1000",
      limit: "10",
    })
    expect(r.body).toEqual(page)
    r = await t.call("candle_signal_records")
    expect(Object.fromEntries(r.requests[0]?.url.searchParams ?? [])).toEqual({ limit: "50" })
    await t.client.close()
  })

  test("one record reads its source and id, the id encoded as one path segment", async () => {
    const t = await connect()
    t.respondWith(() => Response.json(record))
    const r = await t.call("candle_signal_record", { source: "launch_read", source_id: "solana:Mint111" })
    expect(r.requests[0]?.url.pathname).toBe("/v1/public/signal-records/launch_read/solana%3AMint111")
    expect(r.isError).toBe(false)
    expect(r.body.measure).toBe(MEASURE)
    await t.client.close()
  })

  test("an empty page and a body missing measure both carry the fixed line", async () => {
    const t = await connect()
    t.respondWith(() => Response.json({ records: [], next_before: null }))
    const r = await t.call("candle_signal_records")
    expect(r.isError).toBe(false)
    expect(r.body).toEqual({ records: [], next_before: null, measure: MEASURE })
    await t.client.close()
  })
})

describe("BE-3411 signal record tools: every error carries the fixed line", () => {
  test("omitting arguments entirely returns a measured validation error", async () => {
    const t = await connect()
    try {
      const result = await t.client.callTool({ name: "candle_signal_record" })
      expect(result.isError).toBe(true)
      const content = result.content as Array<{ type: string; text: string }>
      expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
        code: "SIGNAL_RECORDS_INVALID_ARGUMENTS",
        measure: MEASURE,
      })
      expect(t.requests).toEqual([])
    } finally {
      await t.client.close()
    }
  })

  test("a 404 is an error with hacc's message, status, body and the fixed line", async () => {
    const t = await connect()
    t.respondWith(() => Response.json({ error: "no such record", measure: MEASURE }, { status: 404 }))
    const r = await t.call("candle_signal_record", { source: "pattern", source_id: "9" })
    expect(r.isError).toBe(true)
    expect(r.body).toEqual({
      error: "no such record",
      code: "NOT_FOUND",
      status: 404,
      body: { error: "no such record", measure: MEASURE },
      measure: MEASURE,
    })
    await t.client.close()
  })

  test("auth and server errors without measure, and a network failure, still carry it", async () => {
    const t = await connect()
    for (const respond of [
      () => Response.json({ error: "invalid api key" }, { status: 401 }),
      () => Response.json({ error: "requires read scope" }, { status: 403 }),
      () => new Response("bad gateway", { status: 502 }),
      () => {
        throw new Error("offline")
      },
    ] as Handler[]) {
      t.respondWith(respond)
      const r = await t.call("candle_signal_scorecard")
      expect(r.isError).toBe(true)
      expect(r.body.measure).toBe(MEASURE)
      expect(r.text).toContain(MEASURE)
    }
    await t.client.close()
  })

  for (const apiKey of [undefined, "cndl_test_stagingkey"]) {
    test(`${apiKey ? "a test-environment key" : "no key"} is refused with the CLI's sentence and the fixed line; nothing is sent`, async () => {
      const t = await connect({ apiKey })
      const args: Record<string, Record<string, unknown>> = {
        candle_signal_record: { source: "pattern", source_id: "1" },
      }
      for (const name of SIGNAL_RECORD_TOOL_NAMES) {
        const r = await t.call(name, args[name] ?? {})
        expect(r.isError).toBe(true)
        expect(r.body).toEqual({
          error: "Signal records need a production agent key. Create one with `candle keys create`.",
          code: "SIGNAL_RECORDS_PRODUCTION_KEY_REQUIRED",
          measure: MEASURE,
        })
        expect(r.requests).toEqual([])
      }
      await t.client.close()
    })
  }

  test("an http CANDLE_HACC_URL is refused before the key is sent", async () => {
    const t = await connect({ env: { CANDLE_HACC_URL: "http://api.hacc.fun" } })
    const r = await t.call("candle_signal_scorecard")
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({ code: "SIGNAL_RECORDS_URL_INVALID", measure: MEASURE })
    expect(r.requests).toEqual([])
    await t.client.close()
  })

  test("CANDLE_HACC_URL overrides the host", async () => {
    const t = await connect({ env: { CANDLE_HACC_URL: "https://hacc.example" } })
    t.respondWith(() => Response.json(scorecard))
    const r = await t.call("candle_signal_scorecard")
    expect(r.requests[0]?.url.origin).toBe("https://hacc.example")
    await t.client.close()
  })

  test("invalid arguments return measured schema errors through the real client without requests", async () => {
    const t = await connect()
    for (const [name, args] of [
      ["candle_signal_scorecard", { date: "bad" }],
      ["candle_signal_scorecard", { date: "2026-13-01" }],
      ["candle_signal_scorecard", { date: 123 }],
      ["candle_signal_scorecard", { unknown: true }],
      ["candle_signal_records", { source: "trade_signal" }],
      ["candle_signal_records", { limit: 101 }],
      ["candle_signal_records", { limit: 0 }],
      ["candle_signal_records", { limit: 1.5 }],
      ["candle_signal_records", { limit: "10" }],
      ["candle_signal_records", { before: 0 }],
      ["candle_signal_records", { unknown: true }],
      ["candle_signal_record", {}],
      ["candle_signal_record", { source: "pattern" }],
      ["candle_signal_record", { source_id: "1" }],
      ["candle_signal_record", { source: "trade_signal", source_id: "1" }],
      ["candle_signal_record", { source: "pattern", source_id: "1", unknown: true }],
      ["candle_signal_record", { source: "pattern", source_id: "x".repeat(129) }],
      ["candle_signal_record", { source: "pattern", source_id: "" }],
    ] as const) {
      const r = await t.call(name, args)
      expect([name, r.isError]).toEqual([name, true])
      expect(r.body).toMatchObject({ code: "SIGNAL_RECORDS_INVALID_ARGUMENTS", measure: MEASURE })
      expect(r.body.error).toBeString()
      expect(r.text).toContain(MEASURE)
      expect(r.requests).toEqual([])
    }
    await t.client.close()
  })
})
