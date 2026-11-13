import { describe, expect, test } from "bun:test"
import type { CommandContext, Deps } from "../deps"
import { MEASURE } from "../signal-records"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { signalsRecord, signalsRecords, signalsScorecard } from "./signals"

/*
 * BE-3411 (hacc north-star CL1): `candle signals`. Every request goes to a faked hacc; nothing
 * leaves the process. The rules worth failing on: the fixed line on every output (success, empty,
 * error, 404, usage, transport), GET only with the production key as a Bearer, HTTPS only, and
 * hacc's body unchanged under --json.
 */
const key = "cndl_live_signals_fixture"
const scorecard = {
  date: "2026-11-12",
  as_of: "2026-11-13T00:05:00Z",
  window: { from: "2026-11-11T00:00:00Z", to: "2026-11-12T00:00:00Z" },
  signal_lift: 0.0123,
  signal_pairs: 412,
  pending_24h: 37,
  baseline_universes: ["solana:age-mcap"],
  baseline_matches: { exact: 400 },
  rows: [
    {
      source: "pattern",
      rule_id: 7,
      variant: "new_ticker",
      shadow: false,
      backfilled: true,
      horizon: "24h",
      count: 120,
      measured: 110,
      paired: 100,
      mean_conservative: -0.041,
      mean_priced: 0.02,
      baseline_mean: -0.06,
      lift: 0.019,
      coverage: 0.52,
      beating_baseline: 0.55,
      tail_2x: 9,
      tail_5x: 2,
      tail_20x: 0,
      delay_n: 120,
      delay_p50_s: 4,
      delay_p95_s: 19,
    },
  ],
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
  baseline: {
    match: "exact",
    universe: "solana:age-mcap",
    net_return_conservative: { "15m": 0.0, "1h": -0.02, "4h": -0.05, "24h": null },
  },
  measure: MEASURE,
}

function setup(routes: Record<string, RouteHandler | RouteHandler[]>, overrides: Partial<Deps> = {}, json = false) {
  const network = createRoutedFetch(routes)
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: network.fetch,
    stdout,
    stderr,
    store: createFakeStore({ api_key: key }),
    ...overrides,
  })
  const ctx: CommandContext = { deps, json, apiUrl: "https://candle.example", verifyAccount: true }
  return { ctx, stdout, stderr, ...network }
}

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1)

describe("candle signals: success carries the fixed line", () => {
  test("scorecard renders hacc's figures as percents and ends with the fixed line; JSON is hacc's body", async () => {
    for (const json of [false, true]) {
      const t = setup({ "/v1/public/scorecard": () => jsonResponse(200, scorecard) }, {}, json)
      expect(await signalsScorecard([], t.ctx)).toBe(0)
      expect(t.unmatched).toEqual([])
      const call = t.calls[0]
      expect(new URL(call?.url ?? "").origin).toBe("https://api.hacc.fun")
      expect(call?.init.method).toBe("GET")
      expect(call?.init.redirect).toBe("error")
      expect(call?.init.body).toBeUndefined()
      expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${key}`)
      if (json) expect(JSON.parse(t.stdout.text)).toEqual(scorecard)
      else {
        for (const part of ["2026-11-12", "+1.23%", "412", "52.00%", "-4.10%", "9/2/0", "backfilled"])
          expect(t.stdout.text).toContain(part)
        expect(lastLine(t.stdout.text)).toBe(MEASURE)
      }
      expect(t.stdout.text).not.toMatch(/will win|recommend/i)
    }
  })

  test("scorecard --date reads that day's route", async () => {
    const t = setup({ "/v1/public/scorecard/2026-11-12": () => jsonResponse(200, scorecard) })
    expect(await signalsScorecard(["--date", "2026-11-12"], t.ctx)).toBe(0)
    expect(t.unmatched).toEqual([])
    expect(lastLine(t.stdout.text)).toBe(MEASURE)
  })

  test("records sends source, before and limit, prints the next page, and ends with the fixed line", async () => {
    const settled = {
      ...record,
      outcome_status: { ...record.outcome_status, "24h": "priced" },
      net_return_conservative: { ...record.net_return_conservative, "24h": 0.5 },
    }
    const page = { records: [settled], next_before: 900, measure: MEASURE }
    for (const json of [false, true]) {
      const t = setup({ "/v1/public/signal-records": () => jsonResponse(200, page) }, {}, json)
      expect(await signalsRecords(["--source", "pattern", "--before", "1000", "--limit", "20"], t.ctx)).toBe(0)
      const url = new URL(t.calls[0]?.url ?? "")
      expect(Object.fromEntries(url.searchParams)).toEqual({ source: "pattern", before: "1000", limit: "20" })
      if (json) expect(JSON.parse(t.stdout.text)).toEqual(page)
      else {
        for (const part of ["12345", "solana", "priced", "+50.00%", "--before 900 --source pattern"])
          expect(t.stdout.text).toContain(part)
        expect(lastLine(t.stdout.text)).toBe(MEASURE)
      }
    }
  })

  test("one record shows every horizon's status and both returns, then the fixed line", async () => {
    const t = setup({ "/v1/public/signal-records/pattern/12345": () => jsonResponse(200, record) })
    expect(await signalsRecord(["pattern", "12345"], t.ctx)).toBe(0)
    for (const part of ["confluence", "stale", "none", "+3.10%", "-12.00%", "-100.00%", "exact (solana:age-mcap)"])
      expect(t.stdout.text).toContain(part)
    expect(lastLine(t.stdout.text)).toBe(MEASURE)
  })

  test("a launch_read id with a colon is sent encoded in one path segment", async () => {
    const t = setup({ "/v1/public/signal-records/launch_read/solana%3AMint111": () => jsonResponse(200, record) })
    expect(await signalsRecord(["launch_read", "solana:Mint111"], t.ctx)).toBe(0)
    expect(t.unmatched).toEqual([])
  })

  test("a body without measure still gets the fixed line, in both modes", async () => {
    const { measure: _drop, ...bare } = record
    for (const json of [false, true]) {
      const t = setup({ "/v1/public/signal-records/pattern/1": () => jsonResponse(200, bare) }, {}, json)
      expect(await signalsRecord(["pattern", "1"], t.ctx)).toBe(0)
      if (json) expect(JSON.parse(t.stdout.text).measure).toBe(MEASURE)
      else expect(lastLine(t.stdout.text)).toBe(MEASURE)
    }
  })
})

describe("candle signals: empty results carry the fixed line", () => {
  test("an empty records page says so and ends with the fixed line", async () => {
    const page = { records: [], next_before: null, measure: MEASURE }
    for (const json of [false, true]) {
      const t = setup({ "/v1/public/signal-records": () => jsonResponse(200, page) }, {}, json)
      expect(await signalsRecords([], t.ctx)).toBe(0)
      if (json) expect(JSON.parse(t.stdout.text)).toEqual(page)
      else {
        expect(t.stdout.text).toContain("No signal records on this page.")
        expect(t.stdout.text).not.toContain("Next page")
        expect(lastLine(t.stdout.text)).toBe(MEASURE)
      }
    }
  })

  test("a scorecard with no rows says so and ends with the fixed line", async () => {
    const t = setup({ "/v1/public/scorecard": () => jsonResponse(200, { ...scorecard, rows: [] }) })
    expect(await signalsScorecard([], t.ctx)).toBe(0)
    expect(t.stdout.text).toContain("No scorecard rows for this day.")
    expect(lastLine(t.stdout.text)).toBe(MEASURE)
  })
})

describe("candle signals: errors carry the fixed line", () => {
  test("a 404 (no scorecard yet, no such record) exits 1 with hacc's error and the fixed line", async () => {
    const notFound = { error: "no scorecard yet", measure: MEASURE }
    for (const json of [false, true]) {
      const t = setup({ "/v1/public/scorecard": () => jsonResponse(404, notFound) }, {}, json)
      expect(await signalsScorecard([], t.ctx)).toBe(1)
      if (json) {
        expect(JSON.parse(t.stdout.text)).toEqual({
          ok: false,
          code: "NOT_FOUND",
          message: "no scorecard yet",
          details: { status: 404, body: notFound },
          measure: MEASURE,
        })
      } else {
        expect(t.stdout.text).toBe("")
        expect(t.stderr.text).toContain("no scorecard yet")
        expect(lastLine(t.stderr.text)).toBe(MEASURE)
      }
    }
    const t = setup({ "/v1/public/signal-records/pattern/9": () => jsonResponse(404, { error: "not found" }) })
    expect(await signalsRecord(["pattern", "9"], t.ctx)).toBe(1)
    expect(lastLine(t.stderr.text)).toBe(MEASURE)
  })

  test("an auth or server error without measure still carries the fixed line", async () => {
    for (const [status, body] of [
      [401, { error: "invalid api key" }],
      [403, { error: "requires read scope" }],
      [500, "oops"],
    ] as const) {
      for (const json of [false, true]) {
        const t = setup(
          {
            "/v1/public/signal-records": () =>
              typeof body === "string" ? new Response(body, { status }) : jsonResponse(status, body),
          },
          {},
          json,
        )
        expect(await signalsRecords([], t.ctx)).toBe(1)
        if (json) {
          const out = JSON.parse(t.stdout.text)
          expect(out.measure).toBe(MEASURE)
          expect(out.details.status).toBe(status)
          expect(out.details.body.measure).toBe(MEASURE)
        } else expect(lastLine(t.stderr.text)).toBe(MEASURE)
      }
    }
  })

  test("a network failure is NETWORK_ERROR with the fixed line", async () => {
    for (const json of [false, true]) {
      const t = setup({}, {}, json)
      expect(await signalsScorecard([], t.ctx)).toBe(1)
      if (json) expect(JSON.parse(t.stdout.text)).toMatchObject({ ok: false, code: "NETWORK_ERROR", measure: MEASURE })
      else expect(lastLine(t.stderr.text)).toBe(MEASURE)
    }
  })

  test("a test key or no key is refused before anything is sent, with the fixed line", async () => {
    for (const store of [createFakeStore({ api_key: "cndl_test_stagingkey" }), createFakeStore()]) {
      for (const json of [false, true]) {
        const t = setup({}, { store }, json)
        expect(await signalsScorecard([], t.ctx)).toBe(1)
        expect(t.calls).toEqual([])
        if (json)
          expect(JSON.parse(t.stdout.text)).toMatchObject({
            code: "SIGNAL_RECORDS_PRODUCTION_KEY_REQUIRED",
            measure: MEASURE,
          })
        else expect(lastLine(t.stderr.text)).toBe(MEASURE)
      }
    }
  })

  test("an http CANDLE_HACC_URL is refused before the key is sent", async () => {
    const t = setup({}, { env: { CANDLE_HACC_URL: "http://api.hacc.fun" } }, true)
    expect(await signalsRecords([], t.ctx)).toBe(1)
    expect(t.calls).toEqual([])
    expect(JSON.parse(t.stdout.text)).toMatchObject({ code: "SIGNAL_RECORDS_URL_INVALID", measure: MEASURE })
  })

  test("CANDLE_HACC_URL overrides the host", async () => {
    const t = setup(
      { "/v1/public/scorecard": () => jsonResponse(200, scorecard) },
      { env: { CANDLE_HACC_URL: "https://hacc.example/" } },
    )
    expect(await signalsScorecard([], t.ctx)).toBe(0)
    expect(new URL(t.calls[0]?.url ?? "").origin).toBe("https://hacc.example")
  })

  test("bad arguments are usage errors (exit 2) with the fixed line, and nothing is sent", async () => {
    const cases: Array<[typeof signalsScorecard, string[]]> = [
      [signalsScorecard, ["--date", "2026-13-01"]],
      [signalsScorecard, ["--date", "yesterday"]],
      [signalsScorecard, ["extra"]],
      [signalsRecords, ["--source", "trade_signal"]],
      [signalsRecords, ["--limit", "101"]],
      [signalsRecords, ["--limit", "0"]],
      [signalsRecords, ["--before", "-1"]],
      [signalsRecords, ["--before", "1.5"]],
      [signalsRecord, ["pattern"]],
      [signalsRecord, ["group_call", "1"]],
      [signalsRecord, ["pattern", "x".repeat(129)]],
    ]
    for (const [command, args] of cases) {
      for (const json of [false, true]) {
        const t = setup({}, {}, json)
        expect([args, await command(args, t.ctx)]).toEqual([args, 2])
        expect(t.calls).toEqual([])
        if (json) expect(JSON.parse(t.stdout.text)).toMatchObject({ ok: false, code: "USAGE", measure: MEASURE })
        else expect(lastLine(t.stderr.text)).toBe(MEASURE)
      }
    }
  })
})
