/**
 * Hyperliquid risk and visibility in the CLI (BE-1582, spec 2026-10-17-hyperliquid-phase1-a-risk-visibility-design.md):
 * `candle perps account | positions | risk | watch | thresholds` against a routed fake of Candle and
 * of Hyperliquid's `/info`. Proves the exit-code contract (0, 10, 11; 1 with a PERPS_* code when
 * there is no level), the positions JSON compatibility, watch's lines, hooks and exit, the
 * thresholds routes and credentials, and that nothing here signs, builds or submits (AC21).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { humanText } from "../human-output.test-support"
import { HYPERLIQUID_RISK_DEFAULTS, type PerpsPositionRow, readPerpsRisk } from "../hyperliquid-risk"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { parseSince, positionsTable, thresholdBps } from "./perps-risk"

const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** One BTC long at mark 100; its liquidation price sets the level (85 is exactly 15%: ok). */
function clearinghouse(liquidationPx: string | null = "50.0") {
  return {
    marginSummary: { accountValue: "1000.5", totalMarginUsed: "120.0" },
    crossMarginSummary: { accountValue: "900.0", totalMarginUsed: "100.0" },
    crossMaintenanceMarginUsed: "45.0",
    withdrawable: "800.25",
    assetPositions: [
      {
        type: "oneWay",
        position: {
          coin: "BTC",
          szi: "0.5",
          leverage: { type: "cross", value: 10 },
          entryPx: "95.0",
          positionValue: "50.0",
          unrealizedPnl: "2.5",
          returnOnEquity: "0.25",
          liquidationPx,
          marginUsed: "5.0",
          cumFunding: { allTime: "0.0", sinceOpen: "0.12", sinceChange: "0.0" },
        },
      },
    ],
  }
}

const SERVER_POSITIONS = {
  success: true,
  walletId: "wallet",
  address: ADDRESS,
  network: "mainnet",
  mode: "default",
  standardMode: true,
  account: { accountValue: "1000.5", totalMarginUsed: "120.0" },
  withdrawable: "800.25",
  positions: [{ coin: "BTC", szi: "0.5" }],
  openWithdrawals: [],
}

interface Options {
  /** Liquidation price per poll; the last repeats. */
  liq?: (string | null)[]
  mode?: string
  hyperliquid?: "down"
  /** Omit perpsRisk from /keys/self/limits (an older API). */
  oldApi?: boolean
  stored?: Record<string, number>
  putAnswer?: Response
  /** Advance the clock this much while the market read is in flight. */
  marketDelayMs?: number
  deviceToken?: boolean
  /** Answer /keys/self/limits with HTTP 500 from this call on (1-based). */
  limitsFailFrom?: number
}

interface Call {
  host: string
  path: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

async function fixture(opts: Options = {}, extra: Partial<Deps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-perps-risk-"))
  folders.push(dir)
  const calls: Call[] = []
  let clock = 1_800_000_000_000
  let poll = 0
  let limitsCalls = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({
      host: url.host,
      path: url.pathname,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    })
    if (url.host === "api.hyperliquid.xyz") {
      if (opts.hyperliquid === "down") return new Response("bad gateway", { status: 502 })
      if (body.type === "metaAndAssetCtxs") {
        if (opts.marketDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          clock += opts.marketDelayMs
        }
        return Response.json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: "100.0" }]])
      }
      if (body.type === "userAbstraction") return Response.json(opts.mode ?? "default")
      if (body.type === "userFillsByTime") return Response.json([{ coin: "BTC", closedPnl: "4.0", fee: "0.4" }])
      if (body.type === "userFunding")
        return Response.json([{ time: 1, hash: "0x0", delta: { type: "funding", coin: "BTC", usdc: "0.3" } }])
      if (body.type === "clearinghouseState") {
        const liqs = opts.liq ?? ["50.0"]
        const liq = liqs[Math.min(poll++, liqs.length - 1)] as string | null
        return Response.json(clearinghouse(liq))
      }
      throw new Error(`Unexpected /info ${body.type}`)
    }
    if (url.pathname === "/api/v1/agent/wallets/trading")
      return Response.json({
        scopes: ["account:read"],
        privyAppId: "app",
        page: [
          {
            id: "wallet",
            address: ADDRESS,
            label: "perps",
            chain: "evm",
            active: true,
            allowLaunch: false,
            privyWalletId: "p",
          },
        ],
        isDone: true,
      })
    if (url.pathname === "/api/v1/agent/keys/self/limits") {
      if (opts.limitsFailFrom !== undefined && ++limitsCalls >= opts.limitsFailFrom)
        return new Response("boom", { status: 500 })
    }
    if (url.pathname === "/api/v1/agent/keys/self/limits")
      return Response.json(
        opts.oldApi
          ? { success: true, keyLimits: null, perpsLimits: null }
          : {
              success: true,
              perpsRisk: opts.stored ?? null,
              perpsRiskEffective: { ...HYPERLIQUID_RISK_DEFAULTS, ...(opts.stored ?? {}) },
            },
      )
    if (url.pathname === "/api/v1/agent/perps/positions") return Response.json(SERVER_POSITIONS)
    if (url.pathname.endsWith("/perps-risk"))
      return (
        opts.putAnswer ??
        Response.json({
          success: true,
          keyPrefix: url.pathname.includes("/self/") ? "bound123" : url.pathname.split("/").at(-2),
          perpsRisk: body.perpsRisk,
          effective: { ...HYPERLIQUID_RISK_DEFAULTS, ...(body.perpsRisk ?? {}) },
        })
      )
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      ...(opts.deviceToken ? { CANDLE_DEVICE_TOKEN: "cndl_dvc_owner" } : {}),
    },
    stdout,
    stderr,
    now: () => clock,
    // Advances the fake clock, and yields a macrotask so a SIGTERM timer can fire between polls.
    sleep: async (ms) => {
      clock += ms
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    ...extra,
  })
  return { deps, calls, stdout, stderr }
}

const hyperliquidCalls = (calls: Call[]) => calls.filter((c) => c.host === "api.hyperliquid.xyz")
const signingCalls = (calls: Call[]) =>
  calls.filter((c) => /\/exchange$|\/sign$|\/perps\/(open|close|cancel|setup|leverage|modify|margin)$/.test(c.path))

describe("candle perps risk (A-8, AC7, AC8)", () => {
  test("ok, warn and critical exit 0, 10 and 11, with the JSON printed on every one", async () => {
    for (const [liq, level, code] of [
      ["50.0", "ok", 0],
      ["85.0001", "warn", 10],
      ["95.0", "critical", 11],
    ] as const) {
      const f = await fixture({ liq: [liq] })
      expect(await run(["perps", "risk", "--json"], f.deps)).toBe(code)
      const report = JSON.parse(f.stdout.text)
      expect(report).toMatchObject({ schema: "candle.perps.risk/1", walletId: "wallet", address: ADDRESS, level })
      expect(signingCalls(f.calls)).toEqual([])
    }
  })

  test("the JSON is the engine's own report", async () => {
    const f = await fixture({ liq: ["90.0"] })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(10)
    const g = await fixture({ liq: ["90.0"] })
    const direct = await readPerpsRisk({
      fetcher: g.deps.fetch as never,
      network: "mainnet",
      walletId: "wallet",
      address: ADDRESS,
      thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults" },
      now: g.deps.now,
    })
    expect(JSON.parse(f.stdout.text)).toEqual(direct)
  })

  test("text: the risk line, the account line and the table", async () => {
    const f = await fixture({ liq: ["87.9"] })
    expect(await run(["perps", "risk"], f.deps)).toBe(10)
    const out = f.stdout.text
    expect(out).toContain("WARN")
    expect(humanText(out)).toContain(humanText("BTC 12.1% from liquidation, warn under 15.0%"))
    expect(out).toContain("$1,000.50")
    expect(out).toContain("$900.00")
    expect(out).toContain("BTC")
    expect(out).toContain("long")
    expect(out).toContain("$95.00")
    expect(out).toContain("$100.00")
    expect(out).toContain("FUNDING")
    expect(humanText(out)).toContain(humanText("nothing warns you unless you poll"))
    expect(humanText(out)).toContain(humanText("candle perps watch"))
  })

  test("a non-standard account mode is unknown: exit 1 with PERPS_ACCOUNT_MODE, never a level", async () => {
    const f = await fixture({ mode: "unifiedAccount", liq: ["95.0"] })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(1)
    const envelope = JSON.parse(f.stdout.text)
    expect(envelope.code).toBe("PERPS_ACCOUNT_MODE")
    expect(envelope.details.report).toMatchObject({ level: "unknown", reason: "PERPS_ACCOUNT_MODE" })
  })

  test("reads 31 s apart are unknown: exit 1 with PERPS_READ_STALE", async () => {
    const f = await fixture({ marketDelayMs: 31_000 })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("PERPS_READ_STALE")
  })

  test("a failed Hyperliquid read exits 1 with PERPS_READ_FAILED", async () => {
    const f = await fixture({ hyperliquid: "down" })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("PERPS_READ_FAILED")
  })

  test("an API that predates perpsRisk: the defaults, and the source says so (AC15)", async () => {
    const f = await fixture({ oldApi: true, liq: ["90.0"] })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(10)
    expect(JSON.parse(f.stdout.text).thresholds.source).toBe("defaults (server did not report)")
  })

  test("the key's thresholds apply", async () => {
    const f = await fixture({ stored: { warnDistanceBps: 6000 } })
    expect(await run(["perps", "risk", "--json"], f.deps)).toBe(10)
    expect(JSON.parse(f.stdout.text).thresholds).toMatchObject({ warnDistanceBps: 6000, source: "key" })
  })

  test("usage errors stay 2", async () => {
    const f = await fixture()
    expect(await run(["perps", "risk", "extra"], f.deps)).toBe(2)
  })
})

describe("candle perps positions (A-3, AC2)", () => {
  test("a computed level prints as itself; no liquidation price is ok; no mark is n/a (BE-1749 item 12)", () => {
    // A 1x position Hyperliquid gives no liquidation price is not "none": nothing can liquidate
    // it, so the row says ok. A coin with no mark is unmeasurable (the account line carries the
    // warn it raised), so it says n/a. JSON keeps the engine's `level: "none"` either way.
    const row = (over: Partial<PerpsPositionRow>): PerpsPositionRow => ({
      coin: "BTC",
      side: "long",
      size: "0.5",
      entryPx: "95.0",
      markPx: "100.0",
      unrealizedPnlUsd: "2.5",
      returnOnEquity: "0.25",
      leverage: { value: 1, type: "cross" },
      liquidationPx: "50.0",
      liquidationDistance: 0.5,
      fundingSinceOpenUsd: "0",
      marginUsedUsd: "5.0",
      positionValueUsd: "50.0",
      level: "ok",
      ...over,
    })
    const table = positionsTable([
      row({ coin: "ETH", level: "ok" }),
      row({ coin: "SOL", level: "warn" }),
      row({ coin: "HYPE", level: "none", liquidationPx: null, liquidationDistance: null }),
      row({ coin: "DOGE", level: "none", markPx: null, liquidationDistance: null }),
      row({ coin: "PEPE", level: "none", markPx: null, liquidationPx: null, liquidationDistance: null }),
    ])
    // LEVEL is the last column, so the row line ends with its cell.
    const levelOf = (coin: string) => {
      const line = table.split("\n").find((row) => row.startsWith(coin))
      expect(line).toBeDefined()
      return (line as string).trimEnd().split(/\s+/).at(-1)
    }
    expect(levelOf("ETH")).toBe("ok")
    expect(levelOf("SOL")).toBe("warn")
    expect(levelOf("HYPE")).toBe("ok")
    expect(levelOf("DOGE")).toBe("n/a")
    // Neither mark nor liquidation price: the missing mark wins, the position is unmeasurable.
    expect(levelOf("PEPE")).toBe("n/a")
  })

  test("every field today's --json prints, key by key, plus rows, accountLine and risk", async () => {
    const f = await fixture({ liq: ["90.0"] })
    expect(await run(["perps", "positions", "--json"], f.deps)).toBe(0)
    const doc = JSON.parse(f.stdout.text)
    for (const [key, value] of Object.entries(SERVER_POSITIONS)) expect([key, doc[key]]).toEqual([key, value])
    expect(doc.rows).toHaveLength(1)
    expect(doc.rows[0]).toMatchObject({ coin: "BTC", side: "long", markPx: "100.0", liquidationDistance: 0.1 })
    expect(doc.accountLine).toMatchObject({ accountValueUsd: "1000.5", withdrawableUsd: "800.25", marginRatio: 0.05 })
    expect(doc.risk).toMatchObject({ level: "warn" })
    expect(doc.risk.positions).toBeUndefined()
  })

  test("a failed direct read still prints the server's answer, with the risk unknown", async () => {
    const f = await fixture({ hyperliquid: "down" })
    expect(await run(["perps", "positions", "--json"], f.deps)).toBe(0)
    const doc = JSON.parse(f.stdout.text)
    expect(doc.positions).toEqual(SERVER_POSITIONS.positions)
    expect(doc.rows).toEqual([])
    expect(doc.risk).toMatchObject({ level: "unknown", reason: "PERPS_READ_FAILED" })
  })

  test("text: the table, the account line, the risk line, then the withdrawable line", async () => {
    const f = await fixture({ liq: ["50.0"] })
    expect(await run(["perps", "positions"], f.deps)).toBe(0)
    const out = f.stdout.text
    expect(out.indexOf("COIN")).toBeLessThan(out.indexOf("Account value"))
    expect(out.indexOf("Account value")).toBeLessThan(out.indexOf("Risk: OK"))
    expect(out.indexOf("Risk: OK")).toBeLessThan(out.indexOf("Withdrawable now"))
  })
})

describe("candle perps account (A-10, AC1)", () => {
  test("JSON: the account line from the totals, the cross figure, and the recent window", async () => {
    const f = await fixture()
    expect(await run(["perps", "account", "--since", "7d", "--json"], f.deps)).toBe(0)
    const doc = JSON.parse(f.stdout.text)
    expect(doc).toMatchObject({
      schema: "candle.perps.account/1",
      walletId: "wallet",
      accountValueUsd: "1000.5",
      marginUsedUsd: "120.0",
      crossAccountValueUsd: "900.0",
      freeMarginUsd: "880.5",
      withdrawableUsd: "800.25",
      marginRatio: 0.05,
      recent: { realizedPnlUsd: "4", feesUsd: "0.4", fundingUsd: "0.3", fills: 1, fundingPayments: 1 },
      risk: { level: "ok" },
    })
    expect(doc.recent.endTime - doc.recent.startTime).toBe(7 * 86_400_000)
  })

  test("text, and exit 0 whatever the level", async () => {
    const f = await fixture({ liq: ["95.0"] })
    expect(await run(["perps", "account"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(
      humanText("Window last 24 h (main perps) Realized +$4.00 Fees $0.40 Funding +$0.30 (positive received)"),
    )
    expect(humanText(f.stdout.text)).toContain(humanText("Risk: CRITICAL"))
  })

  test("--since is checked before any request; a failed read exits 1", async () => {
    const f = await fixture()
    expect(await run(["perps", "account", "--since", "60d"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    const down = await fixture({ hyperliquid: "down" })
    expect(await run(["perps", "account", "--json"], down.deps)).toBe(1)
    expect(JSON.parse(down.stdout.text).code).toBe("PERPS_READ_FAILED")
  })

  test("parseSince", () => {
    expect(parseSince("30m", 10_000_000)).toBe(10_000_000 - 1_800_000)
    expect(parseSince("2026-10-17T00:00:00Z", Date.parse("2026-10-18T00:00:00Z"))).toBe(
      Date.parse("2026-10-17T00:00:00Z"),
    )
    expect(typeof parseSince("yesterday", 1)).toBe("string")
    expect(typeof parseSince("31d", 40 * 86_400_000)).toBe("string")
  })
})

describe("candle perps watch (A-9, AC9 to AC12)", () => {
  /** Ends the watch with SIGTERM after `polls` clearinghouse reads. */
  function terminateAfter(polls: () => number, at: number) {
    return (handler: () => void) => {
      const timer = setInterval(() => {
        if (polls() >= at) {
          clearInterval(timer)
          handler()
        }
      }, 1)
      return () => clearInterval(timer)
    }
  }

  test("NDJSON: start, a line per level change, and the last level's code on SIGTERM", async () => {
    let f: Awaited<ReturnType<typeof fixture>>
    const reads = () => hyperliquidCalls(f.calls).filter((c) => c.body?.type === "clearinghouseState").length
    f = await fixture(
      { liq: ["50.0", "86.0", "84.0", "83.0", "95.0"] },
      { onTerminate: terminateAfter(() => reads(), 5) },
    )
    const code = await run(["perps", "watch", "--heartbeat", "0"], f.deps)
    const lines = f.stdout.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ event: "start", intervalSeconds: 10, weightPerMinute: 136 })
    expect(lines.filter((l) => l.event === "level").map((l) => `${l.previous}->${l.level}`)).toEqual([
      "unknown->ok",
      "ok->warn",
      "warn->ok",
      "ok->critical",
    ])
    expect(code).toBe(11)
    expect(signingCalls(f.calls)).toEqual([])
  })

  test("a failed five-minute thresholds refresh keeps the last thresholds (A-9)", async () => {
    let f: Awaited<ReturnType<typeof fixture>>
    const reads = () => hyperliquidCalls(f.calls).filter((c) => c.body?.type === "clearinghouseState").length
    // 18% from liquidation: warn under the stored 25%, ok under the 15% default.
    f = await fixture(
      { liq: ["82.0"], stored: { warnDistanceBps: 2500 }, limitsFailFrom: 2 },
      { onTerminate: terminateAfter(() => reads(), 35) },
    )
    const code = await run(["perps", "watch", "--heartbeat", "0"], f.deps)
    const lines = f.stdout.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.filter((l) => l.event === "level").map((l) => `${l.previous}->${l.level}`)).toEqual(["unknown->warn"])
    expect(code).toBe(10)
  })

  test("--once-level-change exits at the first change with its code", async () => {
    const f = await fixture({ liq: ["50.0", "50.0", "90.0"] })
    expect(await run(["perps", "watch", "--once-level-change", "--heartbeat", "0"], f.deps)).toBe(10)
  })

  test("hooks run once per rise with the line on stdin and the level in the environment, killed at 30 s", async () => {
    const hooks: { command: string; stdin: string; env: Record<string, string>; timeoutMs: number }[] = []
    const f = await fixture(
      { liq: ["50.0", "90.0", "89.0", "95.0", "96.0", "50.0", "90.0"] },
      {
        runHook: async (command, stdin, env, timeoutMs) => {
          hooks.push({ command, stdin, env, timeoutMs })
          return { exitCode: null, signal: "SIGKILL", timedOut: true }
        },
      },
    )
    // Exits at nothing on its own: stop it after the scripted reads with --once-level-change off,
    // so run it with a terminate after 7 reads.
    const reads = () => hyperliquidCalls(f.calls).filter((c) => c.body?.type === "clearinghouseState").length
    f.deps.onTerminate = terminateAfter(reads, 7)
    const code = await run(
      ["perps", "watch", "--heartbeat", "0", "--on-warn", "notify warn", "--on-critical", "page me"],
      f.deps,
    )
    expect(code).toBe(10)
    // warn (rise), critical (rise), cleared to ok, warn again (rise): three hooks, none for 89.0 or 96.0.
    expect(hooks.map((h) => `${h.command}:${h.env.CANDLE_PERPS_RISK_LEVEL}`)).toEqual([
      "notify warn:warn",
      "page me:critical",
      "notify warn:warn",
    ])
    expect(hooks.every((h) => h.timeoutMs === 30_000)).toBe(true)
    expect(JSON.parse(hooks[0]?.stdin ?? "{}")).toMatchObject({ event: "level", level: "warn", previous: "ok" })
    const hookLines = f.stdout.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((l) => l.event === "hook")
    expect(hookLines).toHaveLength(3)
    expect(hookLines[1]).toMatchObject({ hook: "on-critical", level: "critical", timedOut: true, signal: "SIGKILL" })
  })

  test("a bad interval is a usage error before any request", async () => {
    const f = await fixture()
    for (const interval of ["4", "301", "2.5"])
      expect(await run(["perps", "watch", "--interval", interval], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})

describe("candle perps thresholds (A-4, AC13, E7)", () => {
  test("shows stored and effective for the bound key", async () => {
    const f = await fixture({ stored: { warnDistanceBps: 2000 } })
    expect(await run(["perps", "thresholds", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      stored: { warnDistanceBps: 2000 },
      effective: { ...HYPERLIQUID_RISK_DEFAULTS, warnDistanceBps: 2000 },
      source: "key",
    })
  })

  test("set as self: the agent route with the API key, percent and ratio flags sent as bps", async () => {
    const f = await fixture()
    expect(
      await run(
        ["perps", "thresholds", "set", "--warn-distance", "20", "--warn-margin-ratio", "0.55", "--clear-band", "2.5%"],
        f.deps,
      ),
    ).toBe(0)
    const put = f.calls.find((c) => c.method === "PUT")
    expect(put?.path).toBe("/api/v1/agent/keys/self/perps-risk")
    expect(put?.headers["x-api-key"]).toBe("bound-key")
    expect(put?.body).toEqual({ perpsRisk: { warnDistanceBps: 2000, warnMarginRatioBps: 5500, clearBandBps: 250 } })
    expect(humanText(f.stdout.text)).toContain(humanText("Stored on key bound123."))
  })

  test("a loosening as self is refused with the owner's command named, and exit 1", async () => {
    const f = await fixture({
      putAnswer: Response.json(
        { success: false, error: { code: "LOOSEN_REQUIRES_SESSION", message: "only the owner" } },
        { status: 403 },
      ),
    })
    expect(await run(["perps", "thresholds", "set", "--warn-distance", "5"], f.deps)).toBe(1)
    expect(humanText(f.stderr.text)).toContain(humanText("may only tighten its own thresholds"))
    expect(humanText(f.stderr.text)).toContain(humanText("candle perps thresholds set --key <prefix>"))
    const g = await fixture({
      putAnswer: Response.json(
        { success: false, error: { code: "LOOSEN_REQUIRES_SESSION", message: "only the owner" } },
        { status: 403 },
      ),
    })
    expect(await run(["perps", "thresholds", "set", "--warn-distance", "5", "--json"], g.deps)).toBe(1)
    expect(JSON.parse(g.stdout.text)).toMatchObject({ ok: false, code: "LOOSEN_REQUIRES_SESSION" })
  })

  test("--key <prefix> uses the device token on the owner route; clear sends null", async () => {
    const f = await fixture({ deviceToken: true })
    expect(await run(["perps", "thresholds", "clear", "--key", "AbCd1234"], f.deps)).toBe(0)
    const put = f.calls.find((c) => c.method === "PUT")
    expect(put?.path).toBe("/api/v1/agent/keys/AbCd1234/perps-risk")
    expect(put?.headers.authorization).toBe("Bearer cndl_dvc_owner")
    expect(put?.headers["x-api-key"]).toBeUndefined()
    expect(put?.body).toEqual({ perpsRisk: null })
  })

  test("bad values and no threshold are usage errors before any request", async () => {
    const f = await fixture()
    expect(await run(["perps", "thresholds", "set", "--warn-distance", "abc"], f.deps)).toBe(2)
    expect(await run(["perps", "thresholds", "set", "--warn-margin-ratio", "0.12345"], f.deps)).toBe(2)
    expect(await run(["perps", "thresholds", "set"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })

  test("thresholdBps", () => {
    expect(thresholdBps("15", "pct")).toBe(1500)
    expect(thresholdBps("7.25%", "pct")).toBe(725)
    expect(thresholdBps("0.6", "ratio")).toBe(6000)
    expect(thresholdBps("0.8125", "ratio")).toBe(8125)
    expect(thresholdBps("-1", "pct")).toBeNull()
    expect(thresholdBps("1.234", "pct")).toBeNull()
  })
})

describe("help (AC20)", () => {
  test("extended perps help names the exit codes and the no-monitor sentence", async () => {
    const f = await fixture()
    expect(await run(["help", "perps", "--more"], f.deps)).toBe(0)
    const out = f.stdout.text.replace(/\s+/g, " ")
    expect(humanText(out)).toContain(humanText("exit 0 (ok), 10 (warn) or 11 (critical), and 1 with a PERPS_* code"))
    expect(humanText(out)).toContain(
      humanText(
        "Until Candle's server-side monitor exists, nothing warns you unless you poll candle perps risk or run candle perps watch.",
      ),
    )
    expect(humanText(out)).toContain(humanText("136 of the 1,200 request weight per minute"))
    for (const word of ["account", "risk", "watch", "thresholds"]) expect(out).toContain(`${word} `)
  })
})
