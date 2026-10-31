import { describe, expect, test } from "bun:test"
import type { CommandContext, Deps } from "../deps"
import {
  createCapture,
  createFakeClock,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { labEdges, labReplay, labRunners, labStatus } from "./lab"

const key = "cndl_live_lab_fixture"
const path = "/v1/strategy-lab"
const definition = { entry: { pattern: "new_ticker" }, exit: { max_hold_minutes: 60 } }
const replayArgs = [
  "--definition",
  "./definition.json",
  "--from",
  "2026-10-25T00:00:00Z",
  "--to",
  "2026-10-26T00:00:00Z",
]
const limitation = "Control arms are priced without tick marks outside the strategy's holding spans."
const lead = {
  version: 1,
  insufficient: false,
  control: { arms: 10, strategy_beats_arms: 9 },
  break_even: { cost_bps_per_side: 203, round_trip_pct: 4.06 },
  regime: { label: "busy" },
  summary: "Beat 9 of 10 random arms.",
  evidence_limitations: [limitation],
}
const job = {
  job_id: 42,
  status: "done",
  result: { lead_card: lead, verdict: "ok", trade_count: 37, pnl_usd: "412.10", max_drawdown_pct: 5 },
  error: null,
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
    readFile: async () => JSON.stringify(definition),
    ...overrides,
  })
  const ctx: CommandContext = { deps, json, apiUrl: "https://candle.example", verifyAccount: true }
  return { ctx, stdout, stderr, ...network }
}

describe("lab commands (R19–R24)", () => {
  test("status shows plan, access, cap, reset and active job; JSON stays unchanged", async () => {
    const status = {
      plan: "pro",
      allowed: true,
      replays: { cap: 5, used: 2, resets_at: "2026-10-30T00:00:00Z" },
      active_job_id: 42,
      extra: true,
    }
    for (const json of [false, true]) {
      const t = setup({ [`${path}/status`]: () => jsonResponse(200, status) }, {}, json)
      expect(await labStatus([], t.ctx)).toBe(0)
      if (json) expect(JSON.parse(t.stdout.text)).toEqual(status)
      else
        for (const part of ["pro", "yes", "2 of 5", status.replays.resets_at, "42"])
          expect(t.stdout.text).toContain(part)
      expect(t.unmatched).toEqual([])
    }
  })

  test("a replay reads its file, gets the member fee, submits, waits and prints the lead card first", async () => {
    const clock = createFakeClock()
    const t = setup(
      {
        "/api/v1/agent/tier": () => jsonResponse(200, { success: true, feeBps: 40, planTable: {} }),
        [`${path}/replay`]: () => jsonResponse(202, { job_id: 42 }),
        [`${path}/replay/42`]: [
          () => jsonResponse(200, { job_id: 42, status: "pending" }),
          () => jsonResponse(200, job),
        ],
      },
      { now: clock.now, sleep: clock.sleep },
    )
    expect(await labReplay([...replayArgs, "--asset-ids", "1,2", "--slippage-bps", "75"], t.ctx)).toBe(0)
    const posted = t.calls.find((c) => c.init.method === "POST")
    expect(JSON.parse(String(posted?.init.body))).toEqual({
      definition,
      from: replayArgs[3],
      to: replayArgs[5],
      asset_ids: [1, 2],
      cost: { fee_bps_per_side: 40, slippage_bps_per_side: 75 },
    })
    expect(new Headers(t.calls[0]?.init.headers).get("x-api-key")).toBe(key)
    expect(new Headers(posted?.init.headers).get("authorization")).toBe(`Bearer ${key}`)
    expect(clock.calls).toEqual([5_000])
    const output = t.stdout.text
    expect(output.startsWith("Lead card")).toBe(true)
    const ordered = [
      "Control",
      "Break-even",
      "Regime",
      "Summary",
      limitation,
      "Backtests are a model of the past. The lab never trades.",
      "Replay",
    ]
    expect(ordered.map((s) => output.indexOf(s))).toEqual(ordered.map((s) => output.indexOf(s)).sort((a, b) => a - b))
    for (const part of ["9 of 10", "203 bps per side", "4.06%", "busy", "37", "412.10"]) expect(output).toContain(part)
    expect(t.unmatched).toEqual([])
  })

  test("an explicit zero fee skips Candle, stdin is supported, and no-wait prints the submitted job id only", async () => {
    for (const json of [false, true]) {
      const started = { job_id: 42, additional: "preserved" }
      const t = setup(
        { [`${path}/replay`]: () => jsonResponse(202, started) },
        { readStdin: async () => new TextEncoder().encode(JSON.stringify(definition)) },
        json,
      )
      const args = [...replayArgs]
      args[1] = "-"
      expect(await labReplay([...args, "--no-wait", "--fee-bps", "0"], t.ctx)).toBe(0)
      expect(t.calls).toHaveLength(1)
      expect(JSON.parse(String(t.calls[0]?.init.body)).cost).toEqual({ fee_bps_per_side: 0 })
      expect(t.stdout.text).toContain("42")
      if (json) expect(JSON.parse(t.stdout.text)).toEqual(started)
      expect(t.unmatched).toEqual([])
    }
  })

  test("a failed or unusable tier lookup sends no cost so hacc supplies its default", async () => {
    for (const tier of [
      () => jsonResponse(503, { error: "down" }),
      () => jsonResponse(200, { feeBps: "50" }),
      () => {
        throw new Error("offline")
      },
    ]) {
      const t = setup({ "/api/v1/agent/tier": tier, [`${path}/replay`]: () => jsonResponse(202, { job_id: 42 }) })
      expect(await labReplay([...replayArgs, "--slippage-bps", "90", "--no-wait"], t.ctx)).toBe(0)
      expect(JSON.parse(String(t.calls[1]?.init.body))).not.toHaveProperty("cost")
      expect(t.unmatched).toEqual([])
    }
  })

  test("JSON output is one unchanged final job, including the lead card and future fields", async () => {
    const final = { ...job, new_field: ["future"] }
    const t = setup(
      {
        [`${path}/replay`]: () => jsonResponse(202, { job_id: 42 }),
        [`${path}/replay/42`]: () => jsonResponse(200, final),
      },
      {},
      true,
    )
    expect(await labReplay([...replayArgs, "--fee-bps", "50"], t.ctx)).toBe(0)
    expect(JSON.parse(t.stdout.text)).toEqual(final)
    expect(t.stderr.text).toBe("")
  })

  test("get renders older hacc results without a lead card, and failed jobs exit 1", async () => {
    for (const status of ["running", "done", "failed"]) {
      const t = setup({
        [`${path}/replay/42`]: () =>
          jsonResponse(200, {
            ...job,
            status,
            result: { verdict: "baseline", trade_count: 3, pnl_usd: 12 },
            error: status === "failed" ? "worker timed out" : null,
          }),
      })
      expect(await labReplay(["get", "42"], t.ctx)).toBe(status === "failed" ? 1 : 0)
      expect(t.stdout.text).not.toContain("Lead card")
      expect(t.stdout.text).toContain("baseline")
      if (status === "failed") expect(t.stdout.text).toContain("worker timed out")
    }
  })

  test("cancel posts the named job's cancel route and preserves the response in JSON", async () => {
    const body = { cancelled: true }
    const t = setup({ [`${path}/replay/42/cancel`]: () => jsonResponse(200, body) }, {}, true)
    expect(await labReplay(["cancel", "42"], t.ctx)).toBe(0)
    expect(t.calls[0]?.init.method).toBe("POST")
    expect(JSON.parse(t.stdout.text)).toEqual(body)
  })

  test("insufficient and unavailable control evidence remains visible", async () => {
    const t = setup({
      [`${path}/replay/42`]: () =>
        jsonResponse(200, {
          ...job,
          result: { lead_card: { ...lead, insufficient: true, control: { unavailable: "no_priceable_universe" } } },
        }),
    })
    expect(await labReplay(["get", "42"], t.ctx)).toBe(0)
    expect(t.stdout.text).toContain("Insufficient evidence")
    expect(t.stdout.text).toContain("no_priceable_universe")
    expect(t.stdout.text).toContain(limitation)
  })

  test("refusals exit 1 with the server message, quota reset, and unchanged JSON body", async () => {
    for (const [status, code] of [
      [403, "lab_plan"],
      [429, "lab_quota"],
      [409, "lab_active"],
      [503, "lab_busy"],
      [400, "lab_window"],
    ] as const) {
      for (const json of [false, true]) {
        const body = { code, error: "server refusal", resets_at: "2026-10-30T00:00:00Z", job_id: 42 }
        const t = setup({ [`${path}/replay`]: () => jsonResponse(status, body) }, {}, json)
        expect(await labReplay([...replayArgs, "--fee-bps", "50"], t.ctx)).toBe(1)
        if (json) expect(JSON.parse(t.stdout.text)).toEqual(body)
        else {
          expect(t.stderr.text).toContain(body.error)
          if (status === 429) expect(t.stderr.text).toContain(body.resets_at)
        }
      }
    }
  })

  test("missing status on older hacc has the specified message", async () => {
    const t = setup({ [`${path}/status`]: () => jsonResponse(404, { error: "Not Found" }) })
    expect(await labStatus([], t.ctx)).toBe(1)
    expect(t.stderr.text).toContain("the lab on this server predates `candle lab status`")
  })

  test("device-only, missing and test keys get the production-key message without making a request", async () => {
    for (const store of [
      createFakeStore(),
      createFakeStore({ device_token: "cndl_dvc_fixture" }),
      createFakeStore({ api_key: "cndl_test_fixture" }),
    ]) {
      const t = setup({}, { store })
      expect(await labStatus([], t.ctx)).toBe(1)
      expect(t.stderr.text.trim()).toBe("The lab needs a production agent key. Create one with `candle keys create`.")
      expect(t.calls).toEqual([])
    }
  })

  test("the selected profile key is used without reading another profile or its device token", async () => {
    const t = setup(
      { [`${path}/status`]: () => jsonResponse(200, { plan: "max", allowed: true, replays: {}, active_job_id: null }) },
      {
        store: createFakeStore({
          api_key: "cndl_live_other",
          "profile:desk:api_key": key,
          "profile:desk:device_token": "cndl_dvc_do_not_send",
        }),
      },
    )
    t.ctx.profile = "desk"
    expect(await labStatus([], t.ctx)).toBe(0)
    expect(new Headers(t.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${key}`)
  })

  test("CANDLE_HACC_URL overrides only hacc; insecure URLs are refused before submission or fee lookup", async () => {
    const t = setup(
      {
        [`${path}/replay`]: () => jsonResponse(202, { job_id: 42 }),
        "/api/v1/agent/tier": () => jsonResponse(200, { feeBps: 50 }),
      },
      { env: { CANDLE_HACC_URL: "https://lab.example" } },
    )
    expect(await labReplay([...replayArgs, "--no-wait"], t.ctx)).toBe(0)
    expect(new URL(t.calls[0]?.url ?? "").origin).toBe("https://candle.example")
    expect(new URL(t.calls[1]?.url ?? "").origin).toBe("https://lab.example")
    const refused = setup({}, { env: { CANDLE_HACC_URL: "http://lab.example" } })
    expect(await labReplay(replayArgs, refused.ctx)).toBe(1)
    expect(refused.calls).toEqual([])
  })

  test("poll timeout exits 1 and gives the get command, without cancelling the server job", async () => {
    const t = setup({
      [`${path}/replay`]: () => jsonResponse(202, { job_id: 42 }),
      [`${path}/replay/42`]: () => jsonResponse(200, { job_id: 42, status: "running" }),
    })
    expect(await labReplay([...replayArgs, "--fee-bps", "50"], t.ctx)).toBe(1)
    expect(t.stderr.text).toContain("candle lab replay get 42")
    expect(t.calls.filter((c) => c.init.method === "POST")).toHaveLength(1)
    expect(t.unmatched).toEqual([])
  })

  test("runners and edges send their flags and show the server's net figures without another cost deduction", async () => {
    const t = setup({
      [`${path}/runners`]: () =>
        jsonResponse(200, {
          leaderboard: [{ asset_id: 1, symbol: "RUN", peak_gain_pct: 90, now_gain_pct: 30, wallets: 5 }],
        }),
      [`${path}/edges`]: () =>
        jsonResponse(200, {
          cost_pct: 2.5,
          edges: [{ pattern: "new_ticker", group_name: "book", n: 42, net_med_1h_pct: 12.3, net_med_24h_pct: -2 }],
        }),
    })
    expect(await labRunners(["--hours", "24", "--min-wallets", "5"], t.ctx)).toBe(0)
    expect(t.stdout.text).toContain("RUN")
    expect(new URL(t.calls[0]?.url ?? "").search).toBe("?hours=24&min_wallets=5")
    expect(await labEdges(["--days", "3", "--min-n", "12"], t.ctx)).toBe(0)
    expect(new URL(t.calls[1]?.url ?? "").search).toBe("?days=3&min_n=12")
    expect(t.stdout.text).toContain("net of 2.5% round-trip cost")
    expect(t.stdout.text).toContain("12.3")
    expect(t.stdout.text).toContain("new_ticker")
  })

  test("reports preserve JSON and have human empty states", async () => {
    for (const [name, command, body] of [
      ["runners", labRunners, { leaderboard: [] }],
      ["edges", labEdges, { cost_pct: 2.5, edges: [] }],
    ] as const) {
      for (const json of [false, true]) {
        const t = setup({ [`${path}/${name}`]: () => jsonResponse(200, body) }, {}, json)
        expect(await command([], t.ctx)).toBe(0)
        if (json) expect(JSON.parse(t.stdout.text)).toEqual(body)
        else expect(t.stdout.text).toContain(`No ${name} in this window.`)
      }
    }
  })

  test("malformed flags, windows, numeric values, ids and definitions exit 2 before network calls", async () => {
    for (const [command, args] of [
      [labStatus, ["--bogus"]],
      [labStatus, ["extra"]],
      [labReplay, []],
      [labReplay, ["get"]],
      [labReplay, ["cancel", "42", "extra"]],
      [labReplay, [...replayArgs, "--bogus"]],
      [labReplay, [...replayArgs, "--fee-bps", "1001"]],
      [labReplay, [...replayArgs, "--fee-bps", "1.5"]],
      [labReplay, [...replayArgs, "--slippage-bps", "NaN"]],
      [labReplay, [...replayArgs, "--asset-ids", "1,,2"]],
      [labReplay, [...replayArgs, "--asset-ids", "0"]],
      [labReplay, [...replayArgs, "--asset-ids", Array(51).fill("1").join(",")]],
      [labReplay, ["--definition", "x", "--from", "yesterday", "--to", "today"]],
      [labReplay, [...replayArgs, "--to", replayArgs[3] as string]],
      [labReplay, [...replayArgs, "--definition", "~/x"]],
      [labRunners, ["--hours", "49"]],
      [labRunners, ["--min-wallets", "0"]],
      [labEdges, ["--days", "31"]],
      [labEdges, ["--min-n", "0"]],
      [labEdges, ["--min-n", "1001"]],
    ] as const) {
      const t = setup({})
      expect(await command([...args], t.ctx)).toBe(2)
      expect(t.calls).toEqual([])
    }
    for (const readFile of [
      async () => "[]",
      async () => "null",
      async () => "bad json",
      async () => {
        throw new Error("missing")
      },
    ]) {
      const t = setup({}, { readFile })
      expect(await labReplay(replayArgs, t.ctx)).toBe(2)
      expect(t.calls).toEqual([])
    }
  })
})
