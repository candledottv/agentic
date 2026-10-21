/**
 * Hyperliquid risk and visibility (BE-1582, spec 2026-10-17-hyperliquid-phase1-a-risk-visibility-design.md):
 * `candle perps account | risk | watch | thresholds`, and the table `candle perps positions` prints.
 *
 * Every venue read goes from this machine straight to Hyperliquid's public `/info` through the one
 * engine, `../hyperliquid-risk.ts` (the SDK's file byte for byte). Candle is asked only for the
 * key's EVM TEE wallet and its thresholds (`GET /keys/self/limits`). Nothing here signs, builds or
 * submits, and no vault or signer key is opened.
 *
 * `risk` and `watch` branch on the level by exit code: 0 ok, 10 warn, 11 critical. `unknown` (a
 * non-standard account mode, or a stale read) and every failed read exit 1 with a `PERPS_*` code,
 * so a script never mistakes "could not tell" for ok. Usage errors stay 2. Phase 1 has no
 * server-side monitor: nothing warns anyone unless they poll `risk` or run `watch`.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import {
  HYPERLIQUID_RISK_DEFAULTS,
  type HyperliquidInfoFetcher,
  HyperliquidReadError,
  PERPS_RECENT_MAX_MS,
  type PERPS_RISK_FIELDS,
  PERPS_WATCH_DEFAULT_HEARTBEAT_MS,
  PERPS_WATCH_MAX_INTERVAL_MS,
  PERPS_WATCH_MIN_INTERVAL_MS,
  type PerpsAccountLine,
  type PerpsAccountReport,
  type PerpsPositionRow,
  type PerpsRiskDriver,
  type PerpsRiskReport,
  type PerpsRiskThresholdsReport,
  type PerpsWatchEvent,
  perpsAccountReport,
  perpsRiskExitCode,
  perpsRiskFromLimits,
  readPerpsRecent,
  readPerpsRisk,
  watchPerpsRisk,
} from "../hyperliquid-risk"
import { renderTable, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { type Json, safeText, TradingError, tradingKey } from "../trading"
import { NO_DEVICE_TOKEN } from "./keys"
import { perpsNetwork, perpsWallet } from "./perps"
import { tradingFailure } from "./swap"
import { resolveTargetKey } from "./tee-rebind"

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

const fetcherOf = (ctx: CommandContext) => ctx.deps.fetch as unknown as HyperliquidInfoFetcher
const infoOpts = (ctx: CommandContext) => ({ sleep: ctx.deps.sleep })

/** The bound key's thresholds. A failed read or an API that predates them is the defaults, sourced so (E6). */
export async function perpsThresholdsFor(ctx: CommandContext, key: string): Promise<PerpsRiskThresholdsReport> {
  try {
    return await perpsThresholdsStrict(ctx, key)
  } catch {
    return perpsRiskFromLimits(null).thresholds
  }
}

/** The same read, but a failed one throws: watch keeps its last thresholds on a failed refresh (A-9). */
async function perpsThresholdsStrict(ctx: CommandContext, key: string): Promise<PerpsRiskThresholdsReport> {
  const result = await apiRequest("/api/v1/agent/keys/self/limits", {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) throw new Error("thresholds read failed")
  return perpsRiskFromLimits(result.body).thresholds
}

/** A venue read failure, as the CLI's failure envelope reports it. */
function readFailure(error: unknown): unknown {
  if (error instanceof HyperliquidReadError)
    return new TradingError("PERPS_READ_FAILED", `${error.message}. No level was computed.`)
  return error
}

/** `unknown` is not a level: exit 1 with the reason as the code, and the report in the envelope's details. */
function unknownFailure(report: PerpsRiskReport): TradingError {
  const message =
    report.reason === "PERPS_ACCOUNT_MODE"
      ? `Hyperliquid reports this account in ${safeText(report.mode)} mode, whose perps margin clearinghouseState does not describe. No level was computed.`
      : report.reason === "PERPS_READ_STALE"
        ? "The Hyperliquid reads completed more than 30 s apart. No level was computed; run it again."
        : "Hyperliquid could not be read. No level was computed."
  return new TradingError(report.reason ?? "PERPS_READ_FAILED", message, { details: { report } })
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────

const usd = (value: string | null | undefined) => {
  if (value === null || value === undefined) return "-"
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : safeText(value)
}
const pct = (fraction: number | null) => (fraction === null ? "-" : `${(fraction * 100).toFixed(1)}%`)

function describeDriver(d: PerpsRiskDriver): string {
  if (d.kind === "position") {
    if (d.reason === "unmarked") return `${safeText(d.coin)} has no Hyperliquid mark, so its distance is unknown`
    return `${safeText(d.coin)} ${pct(d.liquidationDistance)} from liquidation, ${d.level === "ok" ? "warn" : d.level} under ${pct(d.threshold)}`
  }
  if (d.reason === "no equity") return "cross margin in use with no cross equity"
  return `margin ratio ${d.marginRatio === null ? "-" : d.marginRatio.toFixed(2)}, ${d.level === "ok" ? "warn" : d.level} above ${d.threshold === null ? "-" : d.threshold.toFixed(2)}`
}

/** `Risk: WARN (BTC 12.1% from liquidation, warn under 15.0%)`. */
export function riskLine(report: Pick<PerpsRiskReport, "level" | "reason" | "drivers" | "closest">): string {
  if (report.level === "unknown") return `Risk: UNKNOWN (${safeText(report.reason ?? "not read")})`
  const lead = report.drivers[0] ?? report.closest
  const more = report.drivers.length > 1 ? `; ${report.drivers.length - 1} more` : ""
  return `Risk: ${report.level.toUpperCase()}${lead ? ` (${report.level === "ok" ? "closest: " : ""}${describeDriver(lead)}${more})` : ""}`
}

/**
 * The LEVEL cell. A row whose level the engine could not compute (`none`, BE-1749 item 12) still
 * owes the reader a word: a position Hyperliquid gives no liquidation price (1x, nothing to
 * liquidate) is `ok`, while one with no mark is unmeasurable, so `n/a` — the account line and the
 * warn driver it raised say the rest. JSON keeps `level: "none"` as the engine reported it.
 */
function levelCell(row: Pick<PerpsPositionRow, "level" | "markPx" | "liquidationPx">): string {
  if (row.level !== "none") return row.level
  if (row.markPx === null) return "n/a"
  return row.liquidationPx === null ? "ok" : "n/a"
}

function accountText(line: PerpsAccountLine): string {
  return `Account value ${usd(line.accountValueUsd)} USD (cross ${usd(line.crossAccountValueUsd)}), margin used ${usd(line.marginUsedUsd)}, free margin ${usd(line.freeMarginUsd)}, withdrawable ${usd(line.withdrawableUsd)}, margin ratio ${line.marginRatio === null ? "none (no cross equity)" : line.marginRatio.toFixed(4)}, unrealized ${usd(line.unrealizedPnlUsd)}, ${line.positionCount} ${line.positionCount === 1 ? "position" : "positions"}, ${safeText(line.mode)} mode`
}

/** The section 4 table (spec A-2). Funding is Hyperliquid's sign: positive is paid (E8). */
export function positionsTable(rows: PerpsPositionRow[]): string {
  if (rows.length === 0) return "No open positions."
  return renderTable(
    [
      "COIN",
      "SIDE",
      "SIZE",
      "ENTRY",
      "MARK",
      "UPNL",
      "ROE",
      "LEV",
      "LIQ",
      "DIST",
      "FUNDING PAID",
      "MARGIN",
      "VALUE",
      "LEVEL",
    ],
    rows.map((r) =>
      [
        r.coin,
        r.side,
        r.size,
        r.entryPx,
        r.markPx ?? "no mark",
        usd(r.unrealizedPnlUsd),
        pct(Number(r.returnOnEquity)),
        `${r.leverage.value}x ${r.leverage.type}`,
        r.liquidationPx ?? "none",
        pct(r.liquidationDistance),
        usd(r.fundingSinceOpenUsd),
        usd(r.marginUsedUsd),
        usd(r.positionValueUsd),
        levelCell(r),
      ].map((cell) => safeText(cell)),
    ),
  )
}

function thresholdsText(t: PerpsRiskThresholdsReport): string {
  return `Thresholds (${t.source}): warn under ${(t.warnDistanceBps / 100).toFixed(1)}% or ratio above ${(t.warnMarginRatioBps / 10_000).toFixed(2)}; critical under ${(t.criticalDistanceBps / 100).toFixed(1)}% or above ${(t.criticalMarginRatioBps / 10_000).toFixed(2)}; clear band ${(t.clearBandBps / 100).toFixed(1)} points`
}

const NO_MONITOR =
  "Until Candle's server-side monitor exists, nothing warns you unless you poll candle perps risk or run candle perps watch."

// ── risk ────────────────────────────────────────────────────────────────────────────────────

/** `candle perps risk`: one stateless read; exit 0, 10 or 11 by level, 1 when there is none. */
export async function perpsRisk(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps risk [--wallet <tee>] [--json]")
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const thresholds = await perpsThresholdsFor(ctx, key)
    const report = await readPerpsRisk({
      fetcher: fetcherOf(ctx),
      network: perpsNetwork(ctx),
      walletId: row.id,
      address: row.address,
      thresholds,
      now: ctx.deps.now,
      ...infoOpts(ctx),
    }).catch((error) => {
      throw readFailure(error)
    })
    if (report.level === "unknown") throw unknownFailure(report)
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(report)}\n`)
    else {
      const out = ctx.deps.stdout
      out.write(`${riskLine(report)}\n`)
      for (const d of report.drivers.slice(1)) out.write(`  also: ${describeDriver(d)}\n`)
      if (report.account) out.write(`${accountText(report.account)}\n`)
      out.write(`${positionsTable(report.positions)}\n`)
      out.write(`${thresholdsText(report.thresholds)}\n${NO_MONITOR}\n`)
    }
    return perpsRiskExitCode(report.level)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── account ─────────────────────────────────────────────────────────────────────────────────

const DURATION_RE = /^([1-9][0-9]*)(m|h|d)$/

/** `--since`: a duration back from now (`30m`, `24h`, `7d`) or an ISO time; within 30 days. */
export function parseSince(value: string, now: number): number | string {
  const duration = DURATION_RE.exec(value)
  let start: number
  if (duration) {
    const n = Number(duration[1])
    start = now - n * (duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000)
  } else {
    start = Date.parse(value)
    if (!Number.isFinite(start)) return "--since takes a duration (30m, 24h, 7d) or an ISO time."
  }
  if (start >= now) return "--since must be in the past."
  if (now - start > PERPS_RECENT_MAX_MS) return "--since reaches back 30 days at most."
  return start
}

/** `candle perps account`: the account line and the recent window. Exit 0 on a read, whatever the level. */
export async function perpsAccount(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet", "--since"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0)
    return usage(ctx, "Usage: candle perps account [--wallet <tee>] [--since <30m|24h|7d|ISO>] [--json]")
  const now = ctx.deps.now()
  const startTime = parseSince(parsed.values["--since"] ?? "24h", now)
  if (typeof startTime === "string") return usage(ctx, startTime)
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const thresholds = await perpsThresholdsFor(ctx, key)
    const network = perpsNetwork(ctx)
    const [report, recent] = await Promise.all([
      readPerpsRisk({
        fetcher: fetcherOf(ctx),
        network,
        walletId: row.id,
        address: row.address,
        thresholds,
        now: ctx.deps.now,
        ...infoOpts(ctx),
      }),
      readPerpsRecent(fetcherOf(ctx), network, row.address, { startTime, endTime: now }, infoOpts(ctx)),
    ]).catch((error) => {
      throw readFailure(error)
    })
    const account = perpsAccountReport(report, recent)
    if (ctx.json) {
      ctx.deps.stdout.write(`${JSON.stringify(account)}\n`)
      return 0
    }
    writeAccountText(ctx, account, report)
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

function writeAccountText(ctx: CommandContext, account: PerpsAccountReport, report: PerpsRiskReport): void {
  const out = ctx.deps.stdout
  out.write(`${safeText(account.address)} on Hyperliquid ${account.network}, read ${account.readAt}\n`)
  if (report.account) out.write(`${accountText(report.account)}\n`)
  else out.write(`No account figures: ${safeText(report.reason)}.\n`)
  const r = account.recent
  const hours = Math.round((r.endTime - r.startTime) / 3_600_000)
  out.write(
    `Last ${hours} h (main perps): realized ${usd(r.realizedPnlUsd)}, fees ${usd(r.feesUsd)}, funding ${usd(r.fundingUsd)} (positive received); ${r.fills} fills, ${r.fundingPayments} funding payments${r.truncated ? "; Hyperliquid's response cap was hit, so these are partial" : ""}\n`,
  )
  out.write(`${riskLine(report)}\n`)
}

// ── positions (spec A-3): the text half; perps.ts keeps the server read and the JSON ─────────

/**
 * The direct read `perps positions` adds: `rows`, `accountLine`, `risk`. A failed read is never a
 * failed command (the server's answer still prints): `risk` is `unknown` with `PERPS_READ_FAILED`.
 */
export async function positionsAdditions(
  ctx: CommandContext,
  key: string,
  row: { id: string; address: string },
): Promise<{
  rows: PerpsPositionRow[]
  accountLine: PerpsAccountLine | null
  risk: Omit<PerpsRiskReport, "positions">
}> {
  const thresholds = await perpsThresholdsFor(ctx, key)
  const identity = { walletId: row.id, address: row.address, network: perpsNetwork(ctx) }
  let report: PerpsRiskReport
  try {
    report = await readPerpsRisk({
      ...identity,
      fetcher: fetcherOf(ctx),
      thresholds,
      now: ctx.deps.now,
      ...infoOpts(ctx),
    })
  } catch {
    report = {
      schema: "candle.perps.risk/1",
      ...identity,
      mode: null,
      readAt: new Date(ctx.deps.now()).toISOString(),
      level: "unknown",
      reason: "PERPS_READ_FAILED",
      drivers: [],
      closest: null,
      thresholds,
      account: null,
      positions: [],
      note: NO_MONITOR,
    }
  }
  const { positions, ...risk } = report
  return { rows: positions, accountLine: report.account, risk }
}

export function writePositionsText(
  ctx: CommandContext,
  additions: Awaited<ReturnType<typeof positionsAdditions>>,
): void {
  const out = ctx.deps.stdout
  out.write(`${positionsTable(additions.rows)}\n`)
  if (additions.accountLine) out.write(`${accountText(additions.accountLine)}\n`)
  out.write(`${riskLine(additions.risk)}\n`)
}

// ── watch (spec A-9) ────────────────────────────────────────────────────────────────────────

const WATCH_USAGE =
  "Usage: candle perps watch [--wallet <tee>] [--interval <seconds>] [--heartbeat <seconds>] [--on-warn <command>] [--on-critical <command>] [--once-level-change]"
const HOOK_TIMEOUT_MS = 30_000
const RANK: Record<"ok" | "warn" | "critical", number> = { ok: 0, warn: 1, critical: 2 }

/**
 * `candle perps watch`: polls Hyperliquid from this machine and prints one JSON line per event
 * (start, each level change, heartbeats, errors, hooks), whatever `--json`. Runs until SIGINT or
 * SIGTERM and exits with the last level's code; `--once-level-change` exits at the first change.
 */
export async function perpsWatch(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--interval", "--heartbeat", "--on-warn", "--on-critical"],
    booleanFlags: ["--once-level-change"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, WATCH_USAGE)
  const interval = Number(parsed.values["--interval"] ?? "10")
  if (
    !Number.isInteger(interval) ||
    interval * 1_000 < PERPS_WATCH_MIN_INTERVAL_MS ||
    interval * 1_000 > PERPS_WATCH_MAX_INTERVAL_MS
  )
    return usage(ctx, "--interval is a whole number of seconds from 5 to 300.")
  const heartbeat = Number(parsed.values["--heartbeat"] ?? String(PERPS_WATCH_DEFAULT_HEARTBEAT_MS / 1_000))
  if (!Number.isInteger(heartbeat) || heartbeat < 0 || heartbeat > 86_400)
    return usage(ctx, "--heartbeat is a whole number of seconds (0 turns heartbeats off).")
  const onWarn = parsed.values["--on-warn"]
  const onCritical = parsed.values["--on-critical"]
  const out = ctx.deps.stdout
  const line = (event: unknown) => out.write(`${JSON.stringify(event)}\n`)

  let key: string
  let row: { id: string; address: string }
  try {
    key = await tradingKey(ctx)
    row = (await perpsWallet(ctx, key, parsed.values["--wallet"])).row
  } catch (error) {
    return tradingFailure(ctx, error)
  }

  const controller = new AbortController()
  const unsubscribe = ctx.deps.onTerminate?.(() => controller.abort()) ?? (() => {})
  const hooks: Promise<void>[] = []
  // A hook runs once per rise: against the last level that was not `unknown`, so a stale read
  // and its recovery do not run it again.
  let basis: "ok" | "warn" | "critical" = "ok"
  const runHook = (name: "on-warn" | "on-critical", command: string, event: PerpsWatchEvent, level: string) => {
    const started = ctx.deps.now()
    const stdin = `${JSON.stringify(event)}\n`
    const run = ctx.deps.runHook
      ? ctx.deps.runHook(command, stdin, { CANDLE_PERPS_RISK_LEVEL: level }, HOOK_TIMEOUT_MS)
      : Promise.resolve({ exitCode: null, signal: null, timedOut: false, error: "hooks are not available here" })
    hooks.push(
      run.then((result) => {
        line({ event: "hook", hook: name, level, ...result, durationMs: ctx.deps.now() - started })
      }),
    )
  }
  try {
    const result = await watchPerpsRisk({
      fetcher: fetcherOf(ctx),
      network: perpsNetwork(ctx),
      walletId: row.id,
      address: row.address,
      thresholds: () => perpsThresholdsStrict(ctx, key),
      intervalMs: interval * 1_000,
      heartbeatMs: heartbeat * 1_000,
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      signal: controller.signal,
      onceLevelChange: parsed.booleans.has("--once-level-change"),
      onEvent: (event) => {
        line(event)
        if (event.event !== "level" || event.level === "unknown") return
        const level = event.level
        if (level !== "ok" && RANK[level] > RANK[basis]) {
          if (level === "critical" && onCritical !== undefined) runHook("on-critical", onCritical, event, level)
          else if (onWarn !== undefined) runHook("on-warn", onWarn, event, level)
        }
        basis = level
      },
    })
    await Promise.all(hooks)
    return perpsRiskExitCode(result.level)
  } finally {
    unsubscribe()
  }
}

// ── thresholds (spec A-4) ───────────────────────────────────────────────────────────────────

const THRESHOLDS_USAGE =
  "Usage: candle perps thresholds [--json] | candle perps thresholds set [--warn-distance <pct>] [--critical-distance <pct>] [--warn-margin-ratio <r>] [--critical-margin-ratio <r>] [--clear-band <pct>] [--key <prefix|label|self>] | candle perps thresholds clear [--key <prefix|label|self>]"

const SET_FLAGS: Record<string, { field: (typeof PERPS_RISK_FIELDS)[number]; kind: "pct" | "ratio" }> = {
  "--warn-distance": { field: "warnDistanceBps", kind: "pct" },
  "--critical-distance": { field: "criticalDistanceBps", kind: "pct" },
  "--warn-margin-ratio": { field: "warnMarginRatioBps", kind: "ratio" },
  "--critical-margin-ratio": { field: "criticalMarginRatioBps", kind: "ratio" },
  "--clear-band": { field: "clearBandBps", kind: "pct" },
}

/** `17` or `17.5%` (percent) and `0.6` (ratio) to whole bps; null when it is not exactly that. */
export function thresholdBps(value: string, kind: "pct" | "ratio"): number | null {
  const text = kind === "pct" ? value.replace(/%$/, "") : value
  const re = kind === "pct" ? /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/ : /^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$/
  if (!re.test(text)) return null
  const [whole = "0", fraction = ""] = text.split(".")
  const digits = kind === "pct" ? 2 : 4
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"))
}

/** `candle perps thresholds [set|clear]`. */
export async function perpsThresholds(args: string[], ctx: CommandContext): Promise<number> {
  const [verb, ...rest] = args
  if (verb === "set" || verb === "clear") return thresholdsWrite(verb, rest, ctx)
  const parsed = parseArgs(args, { valueFlags: [] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, THRESHOLDS_USAGE)
  try {
    const key = await tradingKey(ctx)
    const result = await apiRequest("/api/v1/agent/keys/self/limits", {
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
      return 1
    }
    const { thresholds, stored } = perpsRiskFromLimits(result.body)
    const { source, ...effective } = thresholds
    if (ctx.json) {
      ctx.deps.stdout.write(`${JSON.stringify({ stored, effective, source, defaults: HYPERLIQUID_RISK_DEFAULTS })}\n`)
      return 0
    }
    ctx.deps.stdout.write(`${thresholdsText(thresholds)}\n`)
    ctx.deps.stdout.write(
      stored && Object.keys(stored).length > 0
        ? `Stored on this key: ${Object.entries(stored)
            .map(([field, value]) => `${field} ${value}`)
            .join(", ")}\n`
        : "Nothing stored on this key; the defaults apply.\n",
    )
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

async function thresholdsWrite(verb: "set" | "clear", args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--key", ...(verb === "set" ? Object.keys(SET_FLAGS) : [])] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, THRESHOLDS_USAGE)
  let body: Json
  if (verb === "clear") body = { perpsRisk: null }
  else {
    const fields: Record<string, number> = {}
    for (const [flag, spec] of Object.entries(SET_FLAGS)) {
      const raw = parsed.values[flag]
      if (raw === undefined) continue
      const bps = thresholdBps(raw, spec.kind)
      if (bps === null)
        return usage(
          ctx,
          `${flag} takes ${spec.kind === "pct" ? "a percentage such as 17 or 17.5" : "a ratio such as 0.6"}, not ${raw}.`,
        )
      fields[spec.field] = bps
    }
    if (Object.keys(fields).length === 0) return usage(ctx, `Name at least one threshold. ${THRESHOLDS_USAGE}`)
    body = { perpsRisk: fields }
  }
  const target = parsed.values["--key"] ?? "self"
  const self = target === "self"
  let result: ApiResult
  let keyPrefix = "self"
  if (self) {
    let key: string
    try {
      key = await tradingKey(ctx)
    } catch (error) {
      return tradingFailure(ctx, error)
    }
    result = await apiRequest("/api/v1/agent/keys/self/perps-risk", {
      method: "PUT",
      body,
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  } else {
    // The owner's route (D3): the device token, as `keys access <prefix>` uses it.
    const deviceToken = await resolveDeviceToken(ctx.deps, ctx.profile)
    if (!deviceToken) {
      writeLocalFailure(ctx.deps, NO_DEVICE_TOKEN, ctx.json)
      return 1
    }
    const resolved = await resolveTargetKey(ctx, deviceToken, target, { codePrefix: "PERPS_THRESHOLDS" })
    if (!resolved.ok) return resolved.code
    keyPrefix = resolved.keyPrefix
    result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/perps-risk`, {
      method: "PUT",
      body,
      apiUrl: ctx.apiUrl,
      credentials: { deviceToken },
      auth: "device",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  }
  if (!result.ok) {
    if (result.code === "LOOSEN_REQUIRES_SESSION") {
      // E7: nothing was written; the owner loosens.
      writeLocalFailure(
        ctx.deps,
        {
          code: "LOOSEN_REQUIRES_SESSION",
          message:
            "This key may only tighten its own thresholds, judged against what applies now (defaults included), so nothing was written.",
          suggestion:
            "Ask the owner to run: candle perps thresholds set --key <prefix> ... (the device token), or to change it from a signed-in session.",
        },
        ctx.json,
      )
      return 1
    }
    if (result.status === 404 && result.code === undefined) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PERPS_THRESHOLDS_UNSUPPORTED",
          message: "This Candle API cannot store risk thresholds yet; nothing changed. The defaults apply.",
        },
        ctx.json,
      )
      return 1
    }
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: self ? "key" : "device" }, ctx.json)
    return 1
  }
  const answer = result.body as { keyPrefix?: string; perpsRisk?: unknown; effective?: Record<string, number> }
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify(answer)}\n`)
    return 0
  }
  const effective = { ...HYPERLIQUID_RISK_DEFAULTS, ...(answer.effective ?? {}) }
  ctx.deps.stdout.write(
    `${verb === "clear" ? "Cleared" : "Stored"} on key ${safeText(answer.keyPrefix ?? keyPrefix)}. ${thresholdsText({ ...effective, source: answer.perpsRisk ? "key" : "defaults" })}\n`,
  )
  return 0
}
