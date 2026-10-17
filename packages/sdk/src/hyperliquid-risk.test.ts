/**
 * The Hyperliquid risk engine (BE-1582, spec 2026-10-17-hyperliquid-phase1-a-risk-visibility-design.md):
 * the A-2 fields, the A-5 rule and its boundaries, A-7 modes, the A-8 staleness rule, A-9 hysteresis
 * and the watch loop, A-6 recent figures and the A-11 portfolio section. Fixtures follow the shape
 * of a live mainnet `clearinghouseState` read on 2026-10-17 (V1).
 */
import { describe, expect, test } from "bun:test"
import { HYPERLIQUID_INFO_URLS } from "./hyperliquid"
import {
  HYPERLIQUID_RISK_DEFAULTS,
  HYPERLIQUID_RISK_INFO_URLS,
  type HyperliquidInfoFetcher,
  type HyperliquidMarkets,
  HyperliquidReadError,
  hyperliquidInfo,
  hyperliquidRiskReport,
  type PerpsRiskLevel,
  type PerpsRiskThresholdsReport,
  type PerpsWatchEvent,
  perpsAccountReport,
  perpsPortfolioSection,
  perpsRiskExitCode,
  perpsRiskFromLimits,
  perpsRiskStep,
  perpsWatchWeightPerMinute,
  readPerpsRisk,
  summarizePerpsRecent,
  watchPerpsRisk,
} from "./hyperliquid-risk"

const T: PerpsRiskThresholdsReport = { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults" }
const ID = { walletId: "w1", address: "0x00000000000000000000000000000000000000aa", network: "mainnet" as const }

interface Pos {
  coin: string
  szi: string
  entryPx?: string
  liquidationPx?: string | null
  type?: "cross" | "isolated"
  unrealizedPnl?: string
  marginUsed?: string
  sinceOpen?: string
}

function position(p: Pos) {
  return {
    type: "oneWay",
    position: {
      coin: p.coin,
      szi: p.szi,
      leverage: { type: p.type ?? "cross", value: 10 },
      entryPx: p.entryPx ?? "100.0",
      positionValue: "1000.0",
      unrealizedPnl: p.unrealizedPnl ?? "0.0",
      returnOnEquity: "0.0",
      liquidationPx: p.liquidationPx === undefined ? "50.0" : p.liquidationPx,
      marginUsed: p.marginUsed ?? "100.0",
      maxLeverage: 50,
      cumFunding: { allTime: "0.0", sinceOpen: p.sinceOpen ?? "0.0", sinceChange: "0.0" },
    },
  }
}

function clearinghouse(
  o: {
    positions?: Pos[]
    accountValue?: string
    marginUsed?: string
    crossValue?: string
    crossMarginUsed?: string
    maint?: string
    withdrawable?: string
  } = {},
) {
  return {
    marginSummary: {
      accountValue: o.accountValue ?? "10000.0",
      totalNtlPos: "0.0",
      totalRawUsd: "0.0",
      totalMarginUsed: o.marginUsed ?? "1000.0",
    },
    crossMarginSummary: {
      accountValue: o.crossValue ?? o.accountValue ?? "10000.0",
      totalNtlPos: "0.0",
      totalRawUsd: "0.0",
      totalMarginUsed: o.crossMarginUsed ?? o.marginUsed ?? "1000.0",
    },
    crossMaintenanceMarginUsed: o.maint ?? "100.0",
    withdrawable: o.withdrawable ?? "9000.0",
    assetPositions: (o.positions ?? []).map(position),
    time: 1792267392990,
  }
}

function market(marks: Record<string, string | null>) {
  const names = Object.keys(marks)
  return [
    { universe: names.map((name) => ({ name, szDecimals: 3, maxLeverage: 40 })), marginTables: [] },
    names.map((name) => ({ markPx: marks[name], midPx: marks[name], funding: "0.0000125" })),
  ]
}

/** The same markets as spec B's reader parses them. */
function snapshot(marks: Record<string, string | null>): HyperliquidMarkets {
  const names = Object.keys(marks)
  return {
    universe: names.map((name) => ({ name, szDecimals: 3, maxLeverage: 40 })),
    ctxs: names.map((name) => ({ markPx: marks[name] ?? null, midPx: marks[name] ?? null })),
    marginTables: new Map(),
  }
}

const report = (state: unknown, marks: Record<string, string | null> = { BTC: "100.0" }, mode = "default") =>
  hyperliquidRiskReport(state, snapshot(marks), mode, T, 1_000, ID)

/** A long BTC position at mark 100 whose liquidation sits `distance` below it. */
const atDistance = (distance: number, extra: Partial<Pos> = {}) => ({
  coin: "BTC",
  szi: "1.0",
  liquidationPx: (100 - distance * 100).toFixed(6),
  ...extra,
})

describe("the info URLs", () => {
  test("are the same as hyperliquid.ts's", () => {
    expect(HYPERLIQUID_RISK_INFO_URLS).toEqual(HYPERLIQUID_INFO_URLS)
  })
})

describe("account line (A-2, AC1)", () => {
  test("total figures from marginSummary, the cross figure beside them, and only the ratio cross-based", () => {
    const r = report(
      clearinghouse({
        accountValue: "10500.25",
        marginUsed: "1200.0",
        crossValue: "10000.0",
        crossMarginUsed: "1000.0",
        maint: "500.0",
        withdrawable: "8800.5",
        positions: [
          {
            coin: "BTC",
            szi: "0.1",
            type: "cross",
            liquidationPx: "30000.0",
            unrealizedPnl: "100.5",
            sinceOpen: "2.5",
          },
          {
            coin: "ETH",
            szi: "-2.0",
            type: "isolated",
            liquidationPx: "3600.0",
            unrealizedPnl: "-200.25",
            marginUsed: "200.0",
          },
        ],
      }),
      { BTC: "61000.0", ETH: "3100.0" },
    )
    expect(r.account).toEqual({
      accountValueUsd: "10500.25",
      marginUsedUsd: "1200.0",
      crossAccountValueUsd: "10000.0",
      freeMarginUsd: "9300.25",
      withdrawableUsd: "8800.5",
      crossMaintenanceMarginUsedUsd: "500.0",
      marginRatio: 0.05,
      unrealizedPnlUsd: "-99.75",
      positionCount: 2,
      mode: "default",
      level: "ok",
    })
    const [btc, eth] = r.positions
    expect(btc).toMatchObject({ coin: "BTC", side: "long", size: "0.1", markPx: "61000.0", fundingSinceOpenUsd: "2.5" })
    expect(eth).toMatchObject({
      coin: "ETH",
      side: "short",
      size: "2.0",
      leverage: { value: 10, type: "isolated" },
      marginUsedUsd: "200.0",
    })
  })

  test("free margin is floored at 0, and withdrawable is never derived from account value (I5)", () => {
    const r = report(clearinghouse({ accountValue: "100.0", marginUsed: "250.0", withdrawable: "0.0", positions: [] }))
    expect(r.account?.freeMarginUsd).toBe("0")
    expect(r.account?.withdrawableUsd).toBe("0.0")
  })

  test("perps account carries the line, the recent window and the risk summary (A-10)", () => {
    const r = report(clearinghouse({ positions: [atDistance(0.5)] }))
    const recent = summarizePerpsRecent([], [], { startTime: 0, endTime: 1 })
    const account = perpsAccountReport(r, recent)
    expect(account).toMatchObject({
      schema: "candle.perps.account/1",
      walletId: "w1",
      accountValueUsd: "10000.0",
      recent: { realizedPnlUsd: "0", fills: 0 },
      risk: { level: "ok", reason: null, drivers: [] },
    })
    expect("level" in account).toBe(false)
  })
})

describe("liquidation distance (AC3)", () => {
  test("long, short, null liquidation and null mark", () => {
    const r = report(
      clearinghouse({
        positions: [
          { coin: "BTC", szi: "1.0", liquidationPx: "80.0" },
          { coin: "ETH", szi: "-1.0", liquidationPx: "125.0" },
          { coin: "SOL", szi: "1.0", liquidationPx: null },
          { coin: "XYZ", szi: "1.0", liquidationPx: "1.0" },
        ],
      }),
      { BTC: "100.0", ETH: "100.0", SOL: "100.0", XYZ: null },
    )
    const [long, short, noLiq, unmarked] = r.positions
    expect(long?.liquidationDistance).toBe(0.2)
    expect(short?.liquidationDistance).toBe(0.25)
    expect(noLiq).toMatchObject({ liquidationDistance: null, level: "none" })
    expect(unmarked).toMatchObject({ markPx: null, liquidationDistance: null, level: "none" })
  })

  test("a coin missing from the universe, or a non-positive mark, is unmarked (E3)", () => {
    const missing = report(clearinghouse({ positions: [{ coin: "GONE", szi: "1.0" }] }), { BTC: "100.0" })
    expect(missing.positions[0]?.markPx).toBeNull()
    const zero = report(clearinghouse({ positions: [{ coin: "BTC", szi: "1.0" }] }), { BTC: "0.0" })
    expect(zero.positions[0]?.markPx).toBeNull()
  })
})

describe("margin ratio (AC4)", () => {
  test("crossMaintenanceMarginUsed over cross account value", () => {
    const r = report(clearinghouse({ crossValue: "2000.0", maint: "500.0", positions: [atDistance(0.5)] }))
    expect(r.account?.marginRatio).toBe(0.25)
  })

  test("E2: cross maintenance above 0 with zero or negative cross equity is critical with ratio null", () => {
    for (const crossValue of ["0.0", "-5.0"]) {
      const r = report(clearinghouse({ crossValue, maint: "10.0", positions: [atDistance(0.5)] }))
      expect(r.level).toBe("critical")
      expect(r.account?.marginRatio).toBeNull()
      expect(r.drivers).toEqual([
        { kind: "margin", level: "critical", marginRatio: null, threshold: 0.8, reason: "no equity" },
      ])
    }
  })

  test("isolated only: cross maintenance 0 and cross value 0 is ok at ratio 0, not critical", () => {
    const r = report(
      clearinghouse({
        accountValue: "500.0",
        crossValue: "0.0",
        maint: "0.0",
        positions: [atDistance(0.5, { type: "isolated" })],
      }),
    )
    expect(r.level).toBe("ok")
    expect(r.account?.marginRatio).toBe(0)
  })

  test("no positions is ok whatever the summary says, at ratio 0", () => {
    const r = report(clearinghouse({ crossValue: "0.0", maint: "5.0", positions: [] }))
    expect(r).toMatchObject({ level: "ok", drivers: [], closest: null })
    expect(r.account?.marginRatio).toBe(0)
  })
})

describe("the level is the worse of margin and every position (AC5)", () => {
  // Position distance and margin ratio per level.
  const distance = { ok: 0.5, warn: 0.1, critical: 0.05 }
  const maint = { ok: "100.0", warn: "700.0", critical: "900.0" } // over cross value 1000
  const levels = ["ok", "warn", "critical"] as const
  for (const p of levels) {
    for (const m of levels) {
      test(`position ${p}, margin ${m}`, () => {
        const r = report(clearinghouse({ crossValue: "1000.0", maint: maint[m], positions: [atDistance(distance[p])] }))
        const expected = [p, m].includes("critical") ? "critical" : [p, m].includes("warn") ? "warn" : "ok"
        expect(r.level).toBe(expected)
        expect(r.account?.level).toBe(expected)
        expect(r.drivers.map((d) => `${d.kind}:${d.level}`).sort()).toEqual(
          [...(p === "ok" ? [] : [`position:${p}`]), ...(m === "ok" ? [] : [`margin:${m}`])].sort(),
        )
      })
    }
  }

  test("an unmarked position raises the level to at least warn (D2), and names itself", () => {
    const r = report(clearinghouse({ positions: [{ coin: "XYZ", szi: "1.0" }] }), { XYZ: null })
    expect(r.level).toBe("warn")
    expect(r.drivers).toEqual([
      { kind: "position", coin: "XYZ", level: "warn", liquidationDistance: null, threshold: null, reason: "unmarked" },
    ])
  })

  test("at ok, closest names the driver nearest to warn", () => {
    const r = report(
      clearinghouse({
        crossValue: "1000.0",
        maint: "100.0",
        positions: [atDistance(0.5), { coin: "ETH", szi: "1.0", liquidationPx: "80.0" }],
      }),
      { BTC: "100.0", ETH: "100.0" },
    )
    expect(r.closest).toEqual({ kind: "position", coin: "ETH", level: "ok", liquidationDistance: 0.2, threshold: 0.15 })
  })
})

describe("boundaries are strict (AC6)", () => {
  const level = (liquidationPx: string) =>
    report(clearinghouse({ positions: [{ coin: "BTC", szi: "1.0", liquidationPx }] })).level
  const marginLevel = (maint: string) =>
    report(clearinghouse({ crossValue: "1000.0", maint, positions: [atDistance(0.5)] })).level

  test("15%: exactly is ok, one unit of resolution under is warn", () => {
    expect(level("85.0")).toBe("ok")
    expect(level("85.0001")).toBe("warn")
    expect(level("84.9999")).toBe("ok")
  })

  test("7%: exactly is warn, one unit under is critical", () => {
    expect(level("93.0")).toBe("warn")
    expect(level("93.0001")).toBe("critical")
    expect(level("92.9999")).toBe("warn")
  })

  test("0.6: exactly is ok, one unit over is warn", () => {
    expect(marginLevel("600.0")).toBe("ok")
    expect(marginLevel("600.001")).toBe("warn")
    expect(marginLevel("599.999")).toBe("ok")
  })

  test("0.8: exactly is warn, one unit over is critical", () => {
    expect(marginLevel("800.0")).toBe("warn")
    expect(marginLevel("800.001")).toBe("critical")
    expect(marginLevel("799.999")).toBe("warn")
  })

  test("the key's own thresholds move the boundary", () => {
    const strict = { ...T, warnDistanceBps: 2500, source: "key" as const }
    const r = hyperliquidRiskReport(
      clearinghouse({ positions: [atDistance(0.2)] }),
      snapshot({ BTC: "100.0" }),
      "default",
      strict,
      1,
      ID,
    )
    expect(r.level).toBe("warn")
    expect(r.drivers[0]).toMatchObject({ threshold: 0.25 })
  })
})

describe("modes and staleness (A-7, AC8)", () => {
  test("a mode outside default and disabled is unknown with PERPS_ACCOUNT_MODE and no figures", () => {
    for (const mode of ["unifiedAccount", "portfolioMargin"]) {
      const r = report(clearinghouse({ positions: [atDistance(0.01)] }), { BTC: "100.0" }, mode)
      expect(r).toMatchObject({ level: "unknown", reason: "PERPS_ACCOUNT_MODE", mode, account: null, positions: [] })
    }
    expect(report(clearinghouse(), { BTC: "100.0" }, "disabled").level).toBe("ok")
  })

  test("halves completing more than 30 s apart are PERPS_READ_STALE", async () => {
    let clock = 0
    const answers: Record<string, unknown> = {
      clearinghouseState: clearinghouse({ positions: [atDistance(0.5)] }),
      metaAndAssetCtxs: market({ BTC: "100.0" }),
      userAbstraction: "default",
    }
    // The market read finishes 31 s after the other two.
    const fetcher: HyperliquidInfoFetcher = async (_url, init) => {
      const type = JSON.parse(String(init?.body)).type as string
      if (type === "metaAndAssetCtxs") {
        await new Promise((resolve) => setTimeout(resolve, 5))
        clock += 31_000
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(answers[type]) }
    }
    const r = await readPerpsRisk({ ...ID, fetcher, thresholds: T, now: () => clock })
    expect(r).toMatchObject({ level: "unknown", reason: "PERPS_READ_STALE" })
  })

  test("exit codes: 0 ok, 10 warn, 11 critical, 1 unknown", () => {
    expect([perpsRiskExitCode("ok"), perpsRiskExitCode("warn"), perpsRiskExitCode("critical")]).toEqual([0, 10, 11])
    expect(perpsRiskExitCode("unknown")).toBe(1)
  })
})

describe("reading Hyperliquid (E4, E5)", () => {
  test("a 429 is retried once after 1 s, then fails as rate-limited", async () => {
    const waits: number[] = []
    let calls = 0
    const fetcher: HyperliquidInfoFetcher = async () => {
      calls++
      return { ok: false, status: 429, text: async () => "" }
    }
    const error = await hyperliquidInfo(
      fetcher,
      "mainnet",
      { type: "clearinghouseState" },
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(HyperliquidReadError)
    expect((error as HyperliquidReadError).rateLimited).toBe(true)
    expect([calls, waits]).toEqual([2, [1000]])
  })

  test("an unexpected shape is PERPS_READ_FAILED", () => {
    expect(() => report({ marginSummary: {} })).toThrow(HyperliquidReadError)
    expect(() => hyperliquidRiskReport(clearinghouse(), { nope: true } as never, "default", T, 1, ID)).toThrow(
      /metaAndAssetCtxs/,
    )
  })

  test("only /info is ever requested (AC21)", async () => {
    const urls: string[] = []
    const fetcher = scriptedFetcher(
      {
        clearinghouseState: () => clearinghouse(),
        metaAndAssetCtxs: () => market({ BTC: "100.0" }),
        userAbstraction: () => "default",
      },
      urls,
    )
    await readPerpsRisk({ ...ID, network: "testnet", fetcher, thresholds: T, now: () => 0 })
    expect(new Set(urls)).toEqual(new Set(["https://api.hyperliquid-testnet.xyz/info"]))
  })
})

describe("thresholds from GET /keys/self/limits (A-4, E6)", () => {
  test("the server's effective set, sourced to the key when something is stored", () => {
    const body = {
      perpsRisk: { warnDistanceBps: 2000 },
      perpsRiskEffective: { ...HYPERLIQUID_RISK_DEFAULTS, warnDistanceBps: 2000 },
    }
    expect(perpsRiskFromLimits(body).thresholds).toEqual({ ...T, warnDistanceBps: 2000, source: "key" })
    expect(
      perpsRiskFromLimits({ perpsRisk: null, perpsRiskEffective: HYPERLIQUID_RISK_DEFAULTS }).thresholds.source,
    ).toBe("defaults")
  })

  test("an API that predates perpsRisk: the defaults, and the source says so", () => {
    expect(perpsRiskFromLimits({ success: true, perpsLimits: null }).thresholds).toEqual({
      ...HYPERLIQUID_RISK_DEFAULTS,
      source: "defaults (server did not report)",
    })
    expect(perpsRiskFromLimits(null).thresholds.source).toBe("defaults (server did not report)")
  })
})

describe("hysteresis (A-9, AC9)", () => {
  const at = (distance: number) => report(clearinghouse({ positions: [atDistance(distance)] }))

  test("rise immediate; 14.9% warn, 16% held, 17.0% exactly clears, 17.1% stays ok", () => {
    const seq = [0.149, 0.16, 0.17, 0.171]
    const levels: PerpsRiskLevel[] = []
    let level: PerpsRiskLevel = "ok"
    for (const d of seq) {
      level = perpsRiskStep(level, at(d))
      levels.push(level)
    }
    expect(levels).toEqual(["warn", "warn", "ok", "ok"])
  })

  test("critical falls straight to ok in one poll when the warn clear condition holds", () => {
    expect(perpsRiskStep("critical", at(0.2))).toBe("ok")
  })

  test("critical falls to warn at exactly threshold + band (9%), and holds just under it", () => {
    expect(perpsRiskStep("critical", at(0.09))).toBe("warn")
    expect(perpsRiskStep("critical", at(0.0899))).toBe("critical")
  })

  test("the ratio clears inclusively at threshold - band (0.58)", () => {
    const ratio = (maint: string) =>
      report(clearinghouse({ crossValue: "1000.0", maint, positions: [atDistance(0.5)] }))
    expect(perpsRiskStep("warn", ratio("590.0"))).toBe("warn")
    expect(perpsRiskStep("warn", ratio("580.0"))).toBe("ok")
  })

  test("an unmarked driver clears only when the position has a mark again, or is gone", () => {
    const unmarked = report(clearinghouse({ positions: [{ coin: "XYZ", szi: "1.0" }] }), { XYZ: null })
    let level = perpsRiskStep("ok", unmarked)
    expect(level).toBe("warn")
    expect(perpsRiskStep(level, unmarked)).toBe("warn")
    const marked = report(clearinghouse({ positions: [{ coin: "XYZ", szi: "1.0", liquidationPx: "10.0" }] }), {
      XYZ: "100.0",
    })
    expect(perpsRiskStep(level, marked)).toBe("ok")
    level = perpsRiskStep("ok", unmarked)
    expect(perpsRiskStep(level, report(clearinghouse({ positions: [] })))).toBe("ok")
  })

  test("a null liquidation price never blocks a clear (E1)", () => {
    const r = report(
      clearinghouse({ positions: [atDistance(0.5), { coin: "ETH", szi: "1.0", liquidationPx: null }] }),
      { BTC: "100.0", ETH: "100.0" },
    )
    expect(perpsRiskStep("warn", r)).toBe("ok")
  })

  test("from unknown the pure rule decides, with no band", () => {
    expect(perpsRiskStep("unknown", at(0.16))).toBe("ok")
  })
})

// ── The watch loop ──────────────────────────────────────────────────────────────────────────

type Script = Record<string, () => unknown>

function scriptedFetcher(script: Script, urls: string[] = []): HyperliquidInfoFetcher {
  return async (url, init) => {
    urls.push(url)
    const type = JSON.parse(String(init?.body)).type as string
    const answer = script[type]
    if (!answer) throw new Error(`unexpected ${type}`)
    const value = answer()
    if (value instanceof Error) throw value
    if (value === 429) return { ok: false, status: 429, text: async () => "" }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  }
}

/** Runs the loop over a scripted list of clearinghouse answers, one per poll, then aborts. */
async function runWatch(
  states: (unknown | Error)[],
  opts: { onceLevelChange?: boolean; heartbeatMs?: number; marks?: Record<string, string | null> } = {},
) {
  let clock = 0
  let poll = 0
  const controller = new AbortController()
  const events: PerpsWatchEvent[] = []
  let thresholdReads = 0
  let modeReads = 0
  const fetcher = scriptedFetcher({
    clearinghouseState: () => {
      const state = states[poll++]
      if (poll >= states.length) controller.abort()
      return state
    },
    metaAndAssetCtxs: () => market(opts.marks ?? { BTC: "100.0" }),
    userAbstraction: () => {
      modeReads++
      return "default"
    },
  })
  const result = await watchPerpsRisk({
    ...ID,
    fetcher,
    thresholds: async () => {
      thresholdReads++
      return T
    },
    intervalMs: 10_000,
    heartbeatMs: opts.heartbeatMs ?? 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    signal: controller.signal,
    onceLevelChange: opts.onceLevelChange,
    onEvent: (event) => {
      events.push(event)
    },
  })
  return { result, events, thresholdReads, modeReads, clock }
}

const levelEvents = (events: PerpsWatchEvent[]) =>
  events
    .filter((e) => e.event === "level")
    .map((e) => {
      const l = e as Extract<PerpsWatchEvent, { event: "level" }>
      return `${l.previous}->${l.level}${l.cleared ? " cleared" : ""}`
    })

describe("watchPerpsRisk (A-9, AC9, AC10)", () => {
  const ch = (distance: number) => clearinghouse({ positions: [atDistance(distance)] })

  test("start line, then a line per change only: rises immediate, the fall reported with cleared", async () => {
    const { result, events } = await runWatch([ch(0.5), ch(0.149), ch(0.16), ch(0.17), ch(0.171), ch(0.05), ch(0.2)])
    expect(events[0]).toMatchObject({ event: "start", intervalSeconds: 10, weightPerMinute: 136 })
    expect(levelEvents(events)).toEqual([
      "unknown->ok",
      "ok->warn",
      "warn->ok cleared",
      "ok->critical",
      "critical->ok cleared",
    ])
    expect(result.level).toBe("ok")
  })

  test("a failed poll keeps the level until the last good read is 30 s old, then unknown once, then recovers", async () => {
    const boom = new Error("socket hang up")
    const { events } = await runWatch([ch(0.1), boom, boom, boom, boom, boom, ch(0.5)])
    expect(levelEvents(events)).toEqual(["unknown->warn", "warn->unknown", "unknown->ok"])
    const stale = events.find((e) => e.event === "level" && e.level === "unknown") as { reason: string }
    expect(stale.reason).toBe("PERPS_READ_STALE")
    expect(events.filter((e) => e.event === "error")).toHaveLength(5)
  })

  test("a rate limit doubles the interval up to 300 s and reports it", async () => {
    // Each poll's 429 is retried once inside the read, so two answers per failed poll.
    const { events } = await runWatch([429, 429, 429, 429, 429, 429, ch(0.5)])
    const errors = events.filter((e) => e.event === "error") as { nextPollSeconds: number }[]
    expect(errors.map((e) => e.nextPollSeconds)).toEqual([20, 40, 80])
  })

  test("a market-data 429 doubles the interval too, one read per attempt plus its retry (E5)", async () => {
    let clock = 0
    let marketReads = 0
    const controller = new AbortController()
    const events: PerpsWatchEvent[] = []
    const base = scriptedFetcher({
      clearinghouseState: () => ch(0.5),
      metaAndAssetCtxs: () => 429,
      userAbstraction: () => "default",
    })
    const fetcher: HyperliquidInfoFetcher = async (url, init) => {
      if (JSON.parse(String(init?.body)).type === "metaAndAssetCtxs" && ++marketReads >= 6) controller.abort()
      return base(url, init)
    }
    await watchPerpsRisk({
      ...ID,
      fetcher,
      thresholds: async () => T,
      intervalMs: 10_000,
      heartbeatMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
      },
    })
    const errors = events.filter((e) => e.event === "error") as { nextPollSeconds: number }[]
    expect(errors.map((e) => e.nextPollSeconds)).toEqual([20, 40, 80])
    expect(marketReads).toBe(6)
  })

  test("a failed thresholds refresh keeps the last thresholds; a failed start uses the defaults (A-9, E6)", async () => {
    const strict = { ...T, warnDistanceBps: 2500 }
    let reads = 0
    const states = Array.from({ length: 40 }, () => ch(0.82 - 0.64)) // 18% from liquidation
    let poll = 0
    let clock = 0
    const controller = new AbortController()
    const events: PerpsWatchEvent[] = []
    await watchPerpsRisk({
      ...ID,
      fetcher: scriptedFetcher({
        clearinghouseState: () => {
          if (++poll >= states.length) controller.abort()
          return states[poll - 1]
        },
        metaAndAssetCtxs: () => market({ BTC: "100.0" }),
        userAbstraction: () => "default",
      }),
      thresholds: async () => {
        if (++reads === 1) return strict
        throw new Error("limits HTTP 500")
      },
      intervalMs: 10_000,
      heartbeatMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
      },
    })
    expect(reads).toBeGreaterThan(1)
    expect(levelEvents(events)).toEqual(["unknown->warn"])
  })

  test("heartbeats carry the current report at their interval", async () => {
    const { events } = await runWatch([ch(0.5), ch(0.5), ch(0.5), ch(0.5), ch(0.5)], { heartbeatMs: 20_000 })
    expect(events.filter((e) => e.event === "heartbeat")).toHaveLength(2)
  })

  test("--once-level-change returns at the first change after the first reading", async () => {
    const { result, events } = await runWatch([ch(0.5), ch(0.5), ch(0.1), ch(0.5)], { onceLevelChange: true })
    expect(result.level).toBe("warn")
    expect(levelEvents(events)).toEqual(["unknown->ok", "ok->warn"])
  })

  test("Candle is asked for thresholds at start and every 5 minutes; the mode is read the same way (I8)", async () => {
    const states = Array.from({ length: 61 }, () => ch(0.5))
    const { thresholdReads, modeReads } = await runWatch(states)
    // 61 polls at 10 s is 600 s: start, 300 s, 600 s.
    expect([thresholdReads, modeReads]).toEqual([3, 3])
  })

  test("the per-minute weight at the default interval sits well inside 1,200", () => {
    expect(perpsWatchWeightPerMinute(10_000)).toBe(136)
    expect(perpsWatchWeightPerMinute(5_000)).toBeLessThan(300)
  })
})

describe("recent figures (A-6)", () => {
  test("main perps only; funding positive is received; truncation flagged at the response caps", () => {
    const fills = [
      { coin: "BTC", closedPnl: "12.5", fee: "0.5", time: 1 },
      { coin: "xyz:TSLA", closedPnl: "100.0", fee: "1.0", time: 2 },
      { coin: "@107", closedPnl: "100.0", fee: "1.0", time: 3 },
      { coin: "ETH", closedPnl: "-2.25", fee: "-0.1", time: 4 },
    ]
    const funding = [
      {
        time: 1,
        hash: "0x0",
        delta: { type: "funding", coin: "BTC", usdc: "-0.59496", szi: "0.7", fundingRate: "0.00001" },
      },
      { time: 2, hash: "0x0", delta: { type: "funding", coin: "SOL", usdc: "1.1", szi: "-3", fundingRate: "0.00001" } },
    ]
    expect(summarizePerpsRecent(fills, funding, { startTime: 0, endTime: 10 })).toEqual({
      startTime: 0,
      endTime: 10,
      realizedPnlUsd: "10.25",
      feesUsd: "0.4",
      fundingUsd: "0.50504",
      fills: 2,
      fundingPayments: 2,
      truncated: false,
    })
    const many = Array.from({ length: 2000 }, () => ({ coin: "BTC", closedPnl: "0.0", fee: "0.0" }))
    expect(summarizePerpsRecent(many, [], { startTime: 0, endTime: 1 }).truncated).toBe(true)
  })
})

describe("portfolio section (A-11, AC1 subtotal)", () => {
  test("one market read, accounts with value listed, empties counted, the subtotal on total account value", async () => {
    const byUser: Record<string, unknown> = {
      "0xa": clearinghouse({
        accountValue: "100.5",
        crossValue: "50.0",
        maint: "1.0",
        positions: [atDistance(0.5, { unrealizedPnl: "1.5" })],
      }),
      "0xb": clearinghouse({ accountValue: "0.0", crossValue: "0.0", maint: "0.0", positions: [] }),
      "0xc": clearinghouse({
        accountValue: "20.0",
        maint: "1.0",
        positions: [atDistance(0.1, { unrealizedPnl: "-0.5" })],
      }),
    }
    let marketReads = 0
    const fetcher: HyperliquidInfoFetcher = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.type === "metaAndAssetCtxs") marketReads++
      const value = body.type === "metaAndAssetCtxs" ? market({ BTC: "100.0" }) : byUser[body.user]
      if (value === undefined) return { ok: false, status: 500, text: async () => "" }
      return { ok: true, status: 200, text: async () => JSON.stringify(value) }
    }
    const section = await perpsPortfolioSection(fetcher, "mainnet", [
      { address: "0xA", label: "one" },
      { address: "0xB" },
      { address: "0xC" },
      { address: "0xD", label: "broken" },
    ])
    expect(marketReads).toBe(1)
    expect(section).toEqual({
      read: true,
      network: "mainnet",
      accounts: [
        {
          address: "0xA",
          label: "one",
          accountValueUsd: "100.5",
          unrealizedPnlUsd: "1.5",
          positionCount: 1,
          level: "ok",
        },
        { address: "0xC", accountValueUsd: "20.0", unrealizedPnlUsd: "-0.5", positionCount: 1, level: "warn" },
      ],
      subtotal: { accountValueUsd: "120.5", unrealizedPnlUsd: "1" },
      empty: 1,
      unread: [{ address: "0xD", label: "broken", reason: "Hyperliquid clearinghouseState answered HTTP 500" }],
      thresholds: "defaults",
    })
  })

  test("a failed market read leaves the whole section unread", async () => {
    const fetcher: HyperliquidInfoFetcher = async () => ({ ok: false, status: 502, text: async () => "" })
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    expect(await perpsPortfolioSection(fetcher, "mainnet", [{ address: "0xA" }], { sleep })).toEqual({
      read: false,
      reason: "Hyperliquid metaAndAssetCtxs read failed (PERPS_UNAVAILABLE)",
    })
    // Spec B's reader does not say why it failed, so the shared read is retried once after 1 s (E5).
    expect(waits).toEqual([1000])
  })

  test("past 100 addresses the rest are not read, and say why", async () => {
    const fetcher = scriptedFetcher({
      metaAndAssetCtxs: () => market({ BTC: "100.0" }),
      clearinghouseState: () => clearinghouse({ accountValue: "0.0", maint: "0.0", positions: [] }),
    })
    const wallets = Array.from({ length: 102 }, (_, i) => ({ address: `0x${i}` }))
    const section = await perpsPortfolioSection(fetcher, "mainnet", wallets)
    expect(section.read && section.unread.map((u) => u.reason)).toEqual([
      "past the 100-address cap",
      "past the 100-address cap",
    ])
    expect(section.read && section.empty).toBe(100)
  })
})
