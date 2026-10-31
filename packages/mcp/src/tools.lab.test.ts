import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { LAB_TOOL_NAMES, registerToolSubset, resolveToolAllowlist, TOOL_NAMES, type ToolName } from "./tools"

/*
 * BE-2039 (strategy lab spec R25): the five stdio lab tools. Each call goes through its registered
 * schema as the MCP SDK sends it, then through its handler, so the request hacc receives and the
 * text the caller reads are both covered. The rules worth failing on: a production key only, sent
 * as a Bearer to hacc and never to anywhere else; HTTPS only and no redirect; the replay submits
 * once and never polls; bodies, lead card and refusals included, come back unchanged.
 */
type Registered = {
  shape: z.ZodRawShape
  annotations?: Record<string, boolean>
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
}
type Request = { url: string; init?: RequestInit }

const LIVE_KEY = "cndl_live_labtestkey"
const leadCard = {
  version: 1,
  insufficient: false,
  trades: 37,
  control: { basis: "universe_random_entry", arms: 10, strategy_beats_arms: 9 },
  break_even: { cost_bps_per_side: 203, round_trip_pct: 4.06 },
  regime: { label: "busy" },
  summary: "Beat 9 of 10 random arms; loses money above 2.03% a side; window was busy.",
  evidence_limitations: ["Control arms are priced without tick marks outside the strategy's holding spans."],
}

function harness(options: { apiKey?: string; env?: Record<string, string | undefined> } = {}) {
  const tools = new Map<string, Registered>()
  const requests: Request[] = []
  let respond: (url: string, init?: RequestInit) => Response = (url) =>
    url.endsWith("/api/v1/agent/tier")
      ? Response.json({ success: true, tier: "pro", feeBps: 40 })
      : Response.json({ ok: true })
  registerToolSubset(
    {
      registerTool(
        name: string,
        config: { inputSchema: z.ZodRawShape; annotations?: Record<string, boolean> },
        handler: Registered["handler"],
      ) {
        tools.set(name, { shape: config.inputSchema, annotations: config.annotations, handler })
      },
    } as never,
    {
      tools: LAB_TOOL_NAMES,
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "apiKey" in options ? options.apiKey : LIVE_KEY }),
      env: options.env ?? {},
      fetch: (async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), init })
        return respond(String(url), init)
      }) as typeof fetch,
    },
  )
  async function call(name: ToolName, args: Record<string, unknown> = {}) {
    const tool = tools.get(name)
    if (!tool) throw new Error(`${name} is not registered`)
    const parsed = await z.object(tool.shape).safeParseAsync(args)
    if (!parsed.success) return { invalid: parsed.error.issues.map((issue) => issue.path.join(".")) }
    requests.length = 0
    const result = await tool.handler(parsed.data as Record<string, unknown>)
    return {
      text: result.content[0]?.text ?? "",
      body: JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>,
      isError: result.isError === true,
      requests: [...requests],
    }
  }
  return {
    tools,
    call,
    respondWith(fn: typeof respond) {
      respond = fn
    },
  }
}

const hacc = (request: Request | undefined) => ({
  url: new URL(request?.url ?? "https://unset.invalid/"),
  method: request?.init?.method,
  headers: new Headers(request?.init?.headers),
  redirect: request?.init?.redirect,
  body: request?.init?.body === undefined ? undefined : JSON.parse(String(request.init.body)),
})

describe("BE-2039 strategy lab tools: registration", () => {
  test("all five are MCP tool names, registered under their own names, in the default allowlist", () => {
    const { tools } = harness()
    expect([...tools.keys()].sort()).toEqual([...LAB_TOOL_NAMES].sort())
    for (const name of LAB_TOOL_NAMES) {
      expect(TOOL_NAMES as readonly string[]).toContain(name)
      expect(resolveToolAllowlist({}).has(name)).toBe(true)
    }
  })

  test("the four reads are read-only; the replay is not, because it queues a job and spends a replay", () => {
    const { tools } = harness()
    for (const name of ["candle_lab_status", "candle_lab_replay_result", "candle_lab_runners", "candle_lab_edges"]) {
      expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }
    expect(tools.get("candle_lab_replay")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
  })
})

describe("BE-2039 strategy lab tools: key and URL", () => {
  for (const apiKey of [undefined, "cndl_test_stagingkey"]) {
    test(`${apiKey ? "a test-environment key" : "no key"} is refused with the CLI's sentence, and nothing is sent`, async () => {
      const { call } = harness({ apiKey })
      const args: Partial<Record<ToolName, Record<string, unknown>>> = {
        candle_lab_replay: { definition: { kind: "x" }, from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" },
        candle_lab_replay_result: { job_id: 1 },
      }
      for (const name of LAB_TOOL_NAMES) {
        const r = await call(name, args[name] ?? {})
        if ("invalid" in r) throw new Error(`${name}: schema refused`)
        expect(r.isError).toBe(true)
        expect(r.body).toEqual({
          error: "The lab needs a production agent key. Create one with `candle keys create`.",
          code: "LAB_PRODUCTION_KEY_REQUIRED",
        })
        expect(r.requests).toEqual([])
      }
    })
  }

  test("an http CANDLE_HACC_URL is refused before the key is sent", async () => {
    const { call } = harness({ env: { CANDLE_HACC_URL: "http://api.hacc.fun" } })
    const r = await call("candle_lab_status")
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(true)
    expect(r.body.code).toBe("LAB_URL_INVALID")
    expect(r.requests).toEqual([])
  })

  test("an https CANDLE_HACC_URL replaces the default host", async () => {
    const { call } = harness({ env: { CANDLE_HACC_URL: " https://lab.example/ " } })
    const r = await call("candle_lab_status")
    if ("invalid" in r) throw new Error("schema refused")
    expect(hacc(r.requests[0]).url.href).toBe("https://lab.example/v1/strategy-lab/status")
  })
})

describe("BE-2039 strategy lab tools: calls", () => {
  test("status is one GET to hacc with the key as a Bearer, no redirect, and the body unchanged", async () => {
    const { call, respondWith } = harness()
    const status = {
      plan: "pro",
      allowed: true,
      lab_pro_mode_applies: true,
      replays: { cap: 5, used: 1, resets_at: "2026-11-01T00:00:00Z" },
      active_job_id: null,
      window_max_days: 14,
    }
    respondWith(() => Response.json(status))
    const r = await call("candle_lab_status")
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(false)
    expect(r.body).toEqual(status)
    expect(r.requests).toHaveLength(1)
    const sent = hacc(r.requests[0])
    expect(sent.url.href).toBe("https://api.hacc.fun/v1/strategy-lab/status")
    expect(sent.method).toBe("GET")
    expect(sent.headers.get("authorization")).toBe(`Bearer ${LIVE_KEY}`)
    expect(sent.headers.has("x-api-key")).toBe(false)
    expect(sent.redirect).toBe("error")
  })

  test("status against an older hacc without the route says so", async () => {
    const { call, respondWith } = harness()
    respondWith(() => Response.json({ error: "Not found" }, { status: 404 }))
    const r = await call("candle_lab_status")
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({ status: 404, code: "HTTP_404", body: { error: "Not found" } })
    expect(String(r.body.error)).toContain("predates candle_lab_status")
  })

  test("replay submits once with the plan fee from Candle, returns the job id, and never polls", async () => {
    const { call, respondWith } = harness()
    respondWith((url) =>
      url.endsWith("/api/v1/agent/tier")
        ? Response.json({ success: true, tier: "pro", feeBps: 40 })
        : Response.json({ job_id: 42, status: "pending" }, { status: 202 }),
    )
    const definition = { kind: "new_ticker", exit: { take_profit_pct: 50 }, usd_per_trade: 100 }
    const r = await call("candle_lab_replay", {
      definition,
      from: "2026-10-20T00:00:00Z",
      to: "2026-10-21T00:00:00Z",
      asset_ids: [7, 9],
      slippage_bps_per_side: 75,
    })
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(false)
    expect(r.body).toEqual({ job_id: 42, status: "pending" })
    expect(r.requests.map((request) => request.url)).toEqual([
      "https://api.test/api/v1/agent/tier",
      "https://api.hacc.fun/v1/strategy-lab/replay",
    ])
    // The Candle read carries the key the Candle way; hacc gets it only as a Bearer.
    expect(new Headers(r.requests[0]?.init?.headers).get("x-api-key")).toBe(LIVE_KEY)
    const sent = hacc(r.requests[1])
    expect(sent.method).toBe("POST")
    expect(sent.headers.get("authorization")).toBe(`Bearer ${LIVE_KEY}`)
    expect(sent.body).toEqual({
      definition,
      from: "2026-10-20T00:00:00Z",
      to: "2026-10-21T00:00:00Z",
      asset_ids: [7, 9],
      cost: { fee_bps_per_side: 40, slippage_bps_per_side: 75 },
    })
  })

  test("an explicit fee skips the Candle read; with no fee and no tier, no cost is sent", async () => {
    const { call, respondWith } = harness()
    const base = { definition: { kind: "x" }, from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" }
    respondWith(() => Response.json({ job_id: "j1" }))
    const explicit = await call("candle_lab_replay", { ...base, fee_bps_per_side: 0 })
    if ("invalid" in explicit) throw new Error("schema refused")
    expect(explicit.requests.map((request) => request.url)).toEqual(["https://api.hacc.fun/v1/strategy-lab/replay"])
    expect(hacc(explicit.requests[0]).body.cost).toEqual({ fee_bps_per_side: 0 })

    respondWith((url) =>
      url.endsWith("/api/v1/agent/tier")
        ? Response.json({ success: false }, { status: 500 })
        : Response.json({ job_id: "j2" }),
    )
    const fallback = await call("candle_lab_replay", base)
    if ("invalid" in fallback) throw new Error("schema refused")
    expect(fallback.body).toEqual({ job_id: "j2" })
    expect(hacc(fallback.requests[1]).body).toEqual(base)
  })

  test("a refusal keeps hacc's error, code, status and whole body", async () => {
    const { call, respondWith } = harness()
    const quota = {
      error: "Daily replay limit reached",
      code: "lab_quota",
      quota: 5,
      used: 5,
      resets_at: "2026-11-01T00:00:00Z",
    }
    respondWith(() => Response.json(quota, { status: 429 }))
    const r = await call("candle_lab_replay", {
      definition: { kind: "x" },
      from: "2026-10-20T00:00:00Z",
      to: "2026-10-21T00:00:00Z",
      fee_bps_per_side: 50,
    })
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(true)
    expect(r.body).toEqual({ error: "Daily replay limit reached", code: "lab_quota", status: 429, body: quota })
  })

  test("replay_result is one GET for the job, and the lead card comes back first and unchanged", async () => {
    const { call, respondWith } = harness()
    const job = {
      job_id: 42,
      status: "done",
      result: { lead_card: leadCard, verdict: "pass", trade_count: 37, pnl_usd: "412.10" },
    }
    respondWith(() => Response.json(job))
    const r = await call("candle_lab_replay_result", { job_id: 42 })
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(false)
    expect(r.body).toEqual(job)
    expect(Object.keys(r.body.result as object)[0]).toBe("lead_card")
    expect(r.text).toContain("Control arms are priced without tick marks outside the strategy's holding spans.")
    expect(r.requests).toHaveLength(1)
    expect(hacc(r.requests[0]).url.href).toBe("https://api.hacc.fun/v1/strategy-lab/replay/42")
    expect(hacc(r.requests[0]).method).toBe("GET")
  })

  test("another owner's job is hacc's 404, relayed as a refusal", async () => {
    const { call, respondWith } = harness()
    respondWith(() => Response.json({ error: "Job not found" }, { status: 404 }))
    const r = await call("candle_lab_replay_result", { job_id: "a/b" })
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({ error: "Job not found", status: 404 })
    expect(hacc(r.requests[0]).url.pathname).toBe("/v1/strategy-lab/replay/a%2Fb")
  })

  test("runners and edges forward only the knobs given", async () => {
    const { call, respondWith } = harness()
    respondWith(() => Response.json({ leaderboard: [], edges: [] }))
    const runners = await call("candle_lab_runners", { hours: 6, min_wallets: 3 })
    const edges = await call("candle_lab_edges", { days: 7 })
    const plain = await call("candle_lab_edges")
    if ("invalid" in runners || "invalid" in edges || "invalid" in plain) throw new Error("schema refused")
    expect(hacc(runners.requests[0]).url.href).toBe(
      "https://api.hacc.fun/v1/strategy-lab/runners?hours=6&min_wallets=3",
    )
    expect(hacc(edges.requests[0]).url.href).toBe("https://api.hacc.fun/v1/strategy-lab/edges?days=7")
    expect(hacc(plain.requests[0]).url.href).toBe("https://api.hacc.fun/v1/strategy-lab/edges")
    expect(runners.body).toEqual({ leaderboard: [], edges: [] })
  })

  test("an unreachable lab is a transport refusal, not a throw", async () => {
    const { call, respondWith } = harness()
    respondWith(() => {
      throw new TypeError("fetch failed")
    })
    const r = await call("candle_lab_runners")
    if ("invalid" in r) throw new Error("schema refused")
    expect(r.isError).toBe(true)
    expect(r.body).toEqual({ error: "Could not reach the lab.", code: "NETWORK_ERROR", status: 0 })
  })
})

describe("BE-2039 strategy lab tools: input bounds", () => {
  const { call } = harness()
  const base = { definition: { kind: "x" }, from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" }

  test("costs are integers from 0 to 1000 bps (spec R15)", async () => {
    expect(await call("candle_lab_replay", { ...base, fee_bps_per_side: 1001 })).toMatchObject({
      invalid: ["fee_bps_per_side"],
    })
    expect(await call("candle_lab_replay", { ...base, slippage_bps_per_side: -1 })).toMatchObject({
      invalid: ["slippage_bps_per_side"],
    })
    expect(await call("candle_lab_replay", { ...base, fee_bps_per_side: 12.5 })).toMatchObject({
      invalid: ["fee_bps_per_side"],
    })
  })

  test("a definition must be an object, and at most 50 asset ids", async () => {
    expect(await call("candle_lab_replay", { ...base, definition: [1] })).toMatchObject({ invalid: ["definition"] })
    expect(
      await call("candle_lab_replay", { ...base, asset_ids: Array.from({ length: 51 }, (_, i) => i + 1) }),
    ).toMatchObject({ invalid: ["asset_ids"] })
    expect(await call("candle_lab_replay", { from: base.from, to: base.to })).toMatchObject({
      invalid: ["definition"],
    })
  })

  test("a job id is required", async () => {
    expect(await call("candle_lab_replay_result", {})).toMatchObject({ invalid: ["job_id"] })
  })
})
