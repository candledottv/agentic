/**
 * Hyperliquid risk and visibility (Candle spec 2026-10-17-hyperliquid-phase1-a-risk-visibility-design.md,
 * BE-1582): the one engine behind `candle perps account | positions | risk | watch`, the portfolio's
 * Hyperliquid section, the SDK's `perpsRisk()` and `watchPerpsRisk()`, and the MCP's
 * `candle_perps_risk` (spec A-1, invariant I1). No surface computes a level any other way.
 *
 * Every venue read goes from the caller's machine straight to Hyperliquid's public `/info`
 * (`clearinghouseState`, `metaAndAssetCtxs`, `userAbstraction`, and for the account line's recent
 * figures `userFillsByTime` and `userFunding`). Nothing here signs, builds or submits, and nothing
 * here calls Candle: the caller passes the thresholds it read from `GET /keys/self/limits`.
 *
 * Money fields are decimal strings as Hyperliquid sent them, or computed from those strings with
 * exact decimal arithmetic. Ratios and distances are reported as JSON numbers, but every level
 * decision compares the decimal strings exactly (`a / b < bps / 10000` as `a * 10000 < bps * b`),
 * so a value exactly on a threshold is the lower level and no float rounding moves a boundary.
 *
 * `metaAndAssetCtxs` is spec B's read (`readHyperliquidMarkets` in `hyperliquid-markets.ts`, BE-1581,
 * which landed first): this engine imports it rather than adding a second one (BE-1582 constraint 6).
 *
 * `packages/cli/src/hyperliquid-risk.ts` and `packages/mcp/src/hyperliquid-risk.ts` are
 * byte-identical copies of this file (drift tests enforce it). Its one import is
 * `hyperliquid-markets.ts`, which sits beside it, byte for byte, in all three packages.
 */
import {
  PerpsMarketError,
  type PerpsMarketFetch,
  type PerpsMarketSnapshot,
  readHyperliquidMarkets,
} from "./hyperliquid-markets"

export type HyperliquidRiskNetwork = "mainnet" | "testnet"

/** Hyperliquid's public `/info` per network; equal to `HYPERLIQUID_INFO_URLS` in hyperliquid.ts (a test checks). */
export const HYPERLIQUID_RISK_INFO_URLS: Readonly<Record<HyperliquidRiskNetwork, string>> = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
}

// ── Thresholds (spec A-4, D1) ─────────────────────────────────────────────────────────────────

export interface PerpsRiskThresholds {
  /** A position is `warn` when its liquidation distance is under this (bps of the mark). */
  warnDistanceBps: number
  /** A position is `critical` when its liquidation distance is under this. */
  criticalDistanceBps: number
  /** The margin level is `warn` when the cross margin ratio is above this (bps; 10000 is liquidation). */
  warnMarginRatioBps: number
  /** The margin level is `critical` when the cross margin ratio is above this. */
  criticalMarginRatioBps: number
  /** `watch` only: how far past a threshold a level must move before it clears (bps). */
  clearBandBps: number
}

/** What a key stores (`userApiKeys.perpsRisk`): any subset; an absent field takes the default. */
export type PerpsRiskSettings = Partial<PerpsRiskThresholds>

export const PERPS_RISK_FIELDS = [
  "warnDistanceBps",
  "criticalDistanceBps",
  "warnMarginRatioBps",
  "criticalMarginRatioBps",
  "clearBandBps",
] as const

/**
 * The defaults (D1: suggestions until Andrew confirms them, overridable per key). The same values
 * live in `packages/db/convex/lib/perpsRiskPolicy.ts`; a test asserts the two are equal.
 */
export const HYPERLIQUID_RISK_DEFAULTS: Readonly<PerpsRiskThresholds> = {
  warnDistanceBps: 1500,
  criticalDistanceBps: 700,
  warnMarginRatioBps: 6000,
  criticalMarginRatioBps: 8000,
  clearBandBps: 200,
}

export type PerpsRiskThresholdsSource = "defaults" | "key" | "defaults (server did not report)"

export type PerpsRiskThresholdsReport = PerpsRiskThresholds & { source: PerpsRiskThresholdsSource }

/** Defaults overlaid by the stored fields. */
export function effectivePerpsRisk(stored: PerpsRiskSettings | null | undefined): PerpsRiskThresholds {
  const out: PerpsRiskThresholds = { ...HYPERLIQUID_RISK_DEFAULTS }
  for (const field of PERPS_RISK_FIELDS) {
    const value = stored?.[field]
    if (typeof value === "number") out[field] = value
  }
  return out
}

/**
 * Why an effective set cannot mean what it appears to, or null. The same rule as the Convex
 * policy's `validatePerpsRisk`: whole numbers; distances 1 to 9900; ratios 1 to 9999; critical
 * distance under warn distance; warn ratio under critical ratio; band 0 to 1000.
 */
export function perpsRiskProblem(t: PerpsRiskThresholds): string | null {
  const ranges: Record<(typeof PERPS_RISK_FIELDS)[number], [number, number]> = {
    warnDistanceBps: [1, 9900],
    criticalDistanceBps: [1, 9900],
    warnMarginRatioBps: [1, 9999],
    criticalMarginRatioBps: [1, 9999],
    clearBandBps: [0, 1000],
  }
  for (const field of PERPS_RISK_FIELDS) {
    const value = t[field]
    const [min, max] = ranges[field]
    if (!Number.isInteger(value) || value < min || value > max)
      return `${field} must be a whole number of bps from ${min} to ${max}`
  }
  if (t.criticalDistanceBps >= t.warnDistanceBps) return "criticalDistanceBps must be below warnDistanceBps"
  if (t.warnMarginRatioBps >= t.criticalMarginRatioBps) return "warnMarginRatioBps must be below criticalMarginRatioBps"
  return null
}

/**
 * The thresholds a `GET /keys/self/limits` answer gives this key: the server's effective set when it
 * reports one, else the stored fields over the defaults, else the defaults with the source saying
 * the server did not report (an API that predates `perpsRisk`, E6). Never a refusal.
 */
export function perpsRiskFromLimits(body: unknown): {
  thresholds: PerpsRiskThresholdsReport
  stored: PerpsRiskSettings | null
} {
  const record = isRecord(body) ? body : {}
  const reported = "perpsRisk" in record || "perpsRiskEffective" in record
  const stored = isRecord(record.perpsRisk) ? pickSettings(record.perpsRisk) : null
  if (!reported)
    return { thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" }, stored }
  const effective = isRecord(record.perpsRiskEffective)
    ? effectivePerpsRisk(pickSettings(record.perpsRiskEffective))
    : effectivePerpsRisk(stored)
  if (perpsRiskProblem(effective) !== null)
    return { thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" }, stored }
  const source: PerpsRiskThresholdsSource = stored && Object.keys(stored).length > 0 ? "key" : "defaults"
  return { thresholds: { ...effective, source }, stored }
}

function pickSettings(raw: Record<string, unknown>): PerpsRiskSettings {
  const out: PerpsRiskSettings = {}
  for (const field of PERPS_RISK_FIELDS) if (typeof raw[field] === "number") out[field] = raw[field] as number
  return out
}

// ── Reading Hyperliquid (spec A-1, E4, E5) ────────────────────────────────────────────────────

/** The fetch every read here takes; the same shape spec B's reader takes. */
export type HyperliquidInfoFetcher = PerpsMarketFetch

/** A venue read that failed, timed out, or came back in a shape this engine does not know. */
export class HyperliquidReadError extends Error {
  readonly code = "PERPS_READ_FAILED"
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = "HyperliquidReadError"
  }
}

export interface HyperliquidInfoOptions {
  /** Per-request timeout; 5 s like the server's reader. */
  timeoutMs?: number
  /** How a 429 waits its one retry (1 s). Injected so tests run without real time. */
  sleep?: (ms: number) => Promise<void>
}

const INFO_TIMEOUT_MS = 5_000
const RATE_LIMIT_RETRY_MS = 1_000

/** One `/info` POST. A 429 is retried once after 1 s (E5); anything else that fails throws. */
export async function hyperliquidInfo(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  body: Record<string, unknown>,
  opts: HyperliquidInfoOptions = {},
): Promise<unknown> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? INFO_TIMEOUT_MS)
    let res: Awaited<ReturnType<HyperliquidInfoFetcher>>
    let text: string
    try {
      res = await fetcher(HYPERLIQUID_RISK_INFO_URLS[network], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      text = res.ok ? await res.text() : ""
    } catch {
      throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} read failed or timed out`)
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 429) {
      if (attempt === 0) {
        await sleep(RATE_LIMIT_RETRY_MS)
        continue
      }
      throw new HyperliquidReadError(`Hyperliquid rate-limited the ${String(body.type)} read (HTTP 429)`, true)
    }
    if (!res.ok) throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} answered HTTP ${res.status ?? "?"}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} answered with something other than JSON`)
    }
  }
}

/** Hyperliquid's main perp universe and its contexts, as spec B's reader returns them. */
export type HyperliquidMarkets = PerpsMarketSnapshot

/**
 * The shared `metaAndAssetCtxs` read (spec B's `readHyperliquidMarkets`), retried once after 1 s
 * (E5). That reader does not say why a read failed, so any failure is retried once, and a second
 * failure is `PERPS_READ_FAILED`. Watch's doubling back-off follows a 429 on the account read.
 */
export async function readHyperliquidMarketSnapshot(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  opts: HyperliquidInfoOptions = {},
): Promise<HyperliquidMarkets> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  // The shared reader hides why a read failed; watch the status it saw so a 429 still backs off.
  let limited = false
  const watched: HyperliquidInfoFetcher = async (url, init) => {
    const res = await fetcher(url, init)
    limited = res.status === 429
    return res
  }
  try {
    return await readHyperliquidMarkets(watched, network)
  } catch {
    await sleep(RATE_LIMIT_RETRY_MS)
  }
  try {
    return await readHyperliquidMarkets(watched, network)
  } catch (error) {
    throw new HyperliquidReadError(
      `Hyperliquid metaAndAssetCtxs read failed${error instanceof PerpsMarketError ? ` (${error.code})` : ""}`,
      limited,
    )
  }
}

/** The coin's mark price, or null when the coin is not in the universe or its mark is null or not positive (E3). */
export function hyperliquidMark(markets: HyperliquidMarkets, coin: string): string | null {
  const index = markets.universe.findIndex((m) => m.name === coin)
  const mark = index < 0 ? undefined : markets.ctxs[index]?.markPx
  if (typeof mark !== "string") return null
  const parsed = dec(mark)
  return parsed !== null && parsed > 0n ? mark : null
}

/** `clearinghouseState` for one address, shape-checked for every field the report reads. */
export async function readHyperliquidClearinghouse(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  address: string,
  opts: HyperliquidInfoOptions = {},
): Promise<HyperliquidClearinghouse> {
  return parseClearinghouse(
    await hyperliquidInfo(fetcher, network, { type: "clearinghouseState", user: address.toLowerCase() }, opts),
  )
}

/** The account's abstraction mode (`default`, `disabled`, `unifiedAccount`, `portfolioMargin`, ...). */
export async function readHyperliquidAccountMode(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  address: string,
  opts: HyperliquidInfoOptions = {},
): Promise<string> {
  const body = await hyperliquidInfo(fetcher, network, { type: "userAbstraction", user: address.toLowerCase() }, opts)
  if (typeof body !== "string" || body === "") throw new HyperliquidReadError("Unexpected userAbstraction shape")
  return body
}

/** The account modes whose perps collateral `clearinghouseState` describes (`perps-gate.ts`). */
export const HYPERLIQUID_STANDARD_MODES: readonly string[] = ["default", "disabled"]

export interface HyperliquidPositionState {
  coin: string
  szi: string
  entryPx: string
  positionValue: string
  unrealizedPnl: string
  returnOnEquity: string
  leverage: { type: string; value: number }
  liquidationPx: string | null
  marginUsed: string
  cumFunding: { sinceOpen: string }
}

export interface HyperliquidClearinghouse {
  marginSummary: { accountValue: string; totalMarginUsed: string }
  crossMarginSummary: { accountValue: string; totalMarginUsed: string }
  crossMaintenanceMarginUsed: string
  withdrawable: string
  positions: HyperliquidPositionState[]
}

export function parseClearinghouse(body: unknown): HyperliquidClearinghouse {
  const bad = (what: string) => new HyperliquidReadError(`Unexpected clearinghouseState shape (${what})`)
  if (!isRecord(body)) throw bad("not an object")
  const summary = (value: unknown, name: string) => {
    if (!isRecord(value) || !isDecString(value.accountValue) || !isDecString(value.totalMarginUsed)) throw bad(name)
    return { accountValue: value.accountValue as string, totalMarginUsed: value.totalMarginUsed as string }
  }
  const marginSummary = summary(body.marginSummary, "marginSummary")
  const crossMarginSummary = summary(body.crossMarginSummary, "crossMarginSummary")
  if (!isDecString(body.crossMaintenanceMarginUsed)) throw bad("crossMaintenanceMarginUsed")
  if (!isDecString(body.withdrawable)) throw bad("withdrawable")
  if (!Array.isArray(body.assetPositions)) throw bad("assetPositions")
  const positions = (body.assetPositions as unknown[]).map((entry) => {
    const p = isRecord(entry) ? entry.position : undefined
    if (!isRecord(p) || typeof p.coin !== "string" || p.coin === "") throw bad("position")
    for (const field of ["szi", "entryPx", "positionValue", "unrealizedPnl", "returnOnEquity", "marginUsed"])
      if (!isDecString(p[field])) throw bad(`position ${field}`)
    const leverage = p.leverage
    if (!isRecord(leverage) || typeof leverage.type !== "string" || typeof leverage.value !== "number")
      throw bad("position leverage")
    if (p.liquidationPx !== null && p.liquidationPx !== undefined && !isDecString(p.liquidationPx))
      throw bad("position liquidationPx")
    const funding = p.cumFunding
    if (!isRecord(funding) || !isDecString(funding.sinceOpen)) throw bad("position cumFunding")
    return {
      coin: p.coin,
      szi: p.szi as string,
      entryPx: p.entryPx as string,
      positionValue: p.positionValue as string,
      unrealizedPnl: p.unrealizedPnl as string,
      returnOnEquity: p.returnOnEquity as string,
      leverage: { type: leverage.type, value: leverage.value },
      liquidationPx: (p.liquidationPx as string | null | undefined) ?? null,
      marginUsed: p.marginUsed as string,
      cumFunding: { sinceOpen: funding.sinceOpen as string },
    }
  })
  return {
    marginSummary,
    crossMarginSummary,
    crossMaintenanceMarginUsed: body.crossMaintenanceMarginUsed as string,
    withdrawable: body.withdrawable as string,
    positions,
  }
}

// ── The report (spec A-2, A-5, A-8) ───────────────────────────────────────────────────────────

export type PerpsRiskLevel = "ok" | "warn" | "critical" | "unknown"
export type PerpsPositionLevel = "ok" | "warn" | "critical" | "none"
export type PerpsRiskReason = "PERPS_ACCOUNT_MODE" | "PERPS_READ_STALE" | "PERPS_READ_FAILED"

export interface PerpsPositionRow {
  coin: string
  side: "long" | "short"
  size: string
  entryPx: string
  /** Null when the coin has no mark (E3, "unmarked"). */
  markPx: string | null
  unrealizedPnlUsd: string
  returnOnEquity: string
  leverage: { value: number; type: string }
  liquidationPx: string | null
  /** `abs(mark - liquidation) / mark`, unrounded; null when either price is null. */
  liquidationDistance: number | null
  /**
   * `cumFunding.sinceOpen`, Hyperliquid's sign: positive is funding the position PAID (verified
   * read-only on mainnet, 2026-10-17, against `userFunding`; E8). The opposite of `fundingUsd` in
   * the account's recent figures and in `candle pnl`, where positive is received.
   */
  fundingSinceOpenUsd: string
  marginUsedUsd: string
  positionValueUsd: string
  /** This position alone; `none` when its distance is null. */
  level: PerpsPositionLevel
}

export interface PerpsAccountLine {
  /** `marginSummary.accountValue`: cross plus isolated margin and isolated P&L. */
  accountValueUsd: string
  /** `marginSummary.totalMarginUsed`, including isolated margin. */
  marginUsedUsd: string
  /** `crossMarginSummary.accountValue`: the cross side only, the margin ratio's denominator. */
  crossAccountValueUsd: string
  /** `accountValueUsd - marginUsedUsd`, floored at 0. An estimate; `withdrawableUsd` is what can leave. */
  freeMarginUsd: string
  /** Hyperliquid's `withdrawable`, never derived from account value (I5). */
  withdrawableUsd: string
  crossMaintenanceMarginUsedUsd: string
  /** `crossMaintenanceMarginUsed / crossMarginSummary.accountValue`; liquidation at 1; 0 with no cross exposure; null only for E2. */
  marginRatio: number | null
  unrealizedPnlUsd: string
  positionCount: number
  mode: string
  level: PerpsRiskLevel
}

export type PerpsRiskDriver =
  | {
      kind: "position"
      coin: string
      level: PerpsPositionLevel
      liquidationDistance: number | null
      threshold: number | null
      reason?: "unmarked"
    }
  | {
      kind: "margin"
      level: PerpsPositionLevel
      marginRatio: number | null
      threshold: number | null
      reason?: "no equity"
    }

export const PERPS_RISK_NOTE =
  "Phase 1 has no server-side monitor: nothing warns you unless you poll this or run candle perps watch."

export interface PerpsRiskReport {
  schema: "candle.perps.risk/1"
  walletId: string
  address: string
  network: HyperliquidRiskNetwork
  mode: string | null
  /** The earlier of the reads' local completion times. */
  readAt: string
  level: PerpsRiskLevel
  reason: PerpsRiskReason | null
  drivers: PerpsRiskDriver[]
  /** At `ok`, the driver nearest to warn; otherwise null. */
  closest: PerpsRiskDriver | null
  thresholds: PerpsRiskThresholdsReport
  /** Null when no level could be computed from the data (`unknown`). */
  account: PerpsAccountLine | null
  positions: PerpsPositionRow[]
  note: string
}

export interface PerpsRiskIdentity {
  walletId: string
  address: string
  network: HyperliquidRiskNetwork
}

const RANK: Record<"ok" | "warn" | "critical", number> = { ok: 0, warn: 1, critical: 2 }

function worse<T extends "ok" | "warn" | "critical">(a: T, b: T): T {
  return RANK[a] >= RANK[b] ? a : b
}

/**
 * The pure rule (A-5): one report from one read, no memory. `market` is spec B's market snapshot,
 * `state` is `clearinghouseState` (raw or parsed). A mode outside `default` and `disabled`
 * gives `unknown` with `PERPS_ACCOUNT_MODE` and no level from the data (A-7).
 */
export function hyperliquidRiskReport(
  state: unknown,
  market: HyperliquidMarkets,
  mode: string,
  thresholds: PerpsRiskThresholdsReport,
  now: number,
  identity: PerpsRiskIdentity = { walletId: "", address: "", network: "mainnet" },
): PerpsRiskReport {
  const base = {
    schema: "candle.perps.risk/1" as const,
    walletId: identity.walletId,
    address: identity.address,
    network: identity.network,
    mode,
    readAt: new Date(now).toISOString(),
    thresholds,
    note: PERPS_RISK_NOTE,
  }
  if (!HYPERLIQUID_STANDARD_MODES.includes(mode)) {
    return {
      ...base,
      level: "unknown",
      reason: "PERPS_ACCOUNT_MODE",
      drivers: [],
      closest: null,
      account: null,
      positions: [],
    }
  }
  const ch = isParsedClearinghouse(state) ? state : parseClearinghouse(state)
  if (!market || !Array.isArray(market.universe) || !Array.isArray(market.ctxs))
    throw new HyperliquidReadError("Unexpected metaAndAssetCtxs shape")
  const markets = market
  const t = thresholds

  const drivers: PerpsRiskDriver[] = []
  const nearest: { driver: PerpsRiskDriver; headroom: number }[] = []
  let level: "ok" | "warn" | "critical" = "ok"
  let unrealized = 0n

  const positions: PerpsPositionRow[] = ch.positions.map((p) => {
    const szi = dec(p.szi) as bigint
    unrealized += dec(p.unrealizedPnl) as bigint
    const markPx = hyperliquidMark(markets, p.coin)
    const distance = markPx !== null && p.liquidationPx !== null ? distanceParts(markPx, p.liquidationPx) : null
    let rowLevel: PerpsPositionLevel = "none"
    if (distance) {
      rowLevel = fracLess(distance.num, distance.den, t.criticalDistanceBps)
        ? "critical"
        : fracLess(distance.num, distance.den, t.warnDistanceBps)
          ? "warn"
          : "ok"
    }
    const liquidationDistance = distance ? ratioNumber(distance.num, distance.den) : null
    if (markPx === null) {
      // E3 (D2): a position the engine cannot measure must not read as ok.
      drivers.push({
        kind: "position",
        coin: p.coin,
        level: "warn",
        liquidationDistance: null,
        threshold: null,
        reason: "unmarked",
      })
      level = worse(level, "warn")
    } else if (rowLevel === "warn" || rowLevel === "critical") {
      drivers.push({
        kind: "position",
        coin: p.coin,
        level: rowLevel,
        liquidationDistance,
        threshold: (rowLevel === "critical" ? t.criticalDistanceBps : t.warnDistanceBps) / 10_000,
      })
      level = worse(level, rowLevel)
    } else if (rowLevel === "ok" && liquidationDistance !== null) {
      nearest.push({
        driver: {
          kind: "position",
          coin: p.coin,
          level: "ok",
          liquidationDistance,
          threshold: t.warnDistanceBps / 10_000,
        },
        headroom: liquidationDistance / (t.warnDistanceBps / 10_000) - 1,
      })
    }
    return {
      coin: p.coin,
      side: szi < 0n ? "short" : "long",
      size: p.szi.replace(/^-/, ""),
      entryPx: p.entryPx,
      markPx,
      unrealizedPnlUsd: p.unrealizedPnl,
      returnOnEquity: p.returnOnEquity,
      leverage: { value: p.leverage.value, type: p.leverage.type },
      liquidationPx: p.liquidationPx,
      liquidationDistance,
      fundingSinceOpenUsd: p.cumFunding.sinceOpen,
      marginUsedUsd: p.marginUsed,
      positionValueUsd: p.positionValue,
      level: rowLevel,
    }
  })

  // Margin (A-5, E2): no cross exposure is `ok` at ratio 0; cross exposure with no cross equity is E2.
  const maint = dec(ch.crossMaintenanceMarginUsed) as bigint
  const crossValue = dec(ch.crossMarginSummary.accountValue) as bigint
  let marginRatio: number | null = 0
  if (positions.length > 0 && maint > 0n) {
    if (crossValue <= 0n) {
      marginRatio = null
      drivers.push({
        kind: "margin",
        level: "critical",
        marginRatio: null,
        threshold: t.criticalMarginRatioBps / 10_000,
        reason: "no equity",
      })
      level = "critical"
    } else {
      marginRatio = ratioNumber(maint, crossValue)
      const marginLevel = fracGreater(maint, crossValue, t.criticalMarginRatioBps)
        ? "critical"
        : fracGreater(maint, crossValue, t.warnMarginRatioBps)
          ? "warn"
          : "ok"
      if (marginLevel === "ok") {
        nearest.push({
          driver: { kind: "margin", level: "ok", marginRatio, threshold: t.warnMarginRatioBps / 10_000 },
          headroom: 1 - marginRatio / (t.warnMarginRatioBps / 10_000),
        })
      } else {
        drivers.push({
          kind: "margin",
          level: marginLevel,
          marginRatio,
          threshold: (marginLevel === "critical" ? t.criticalMarginRatioBps : t.warnMarginRatioBps) / 10_000,
        })
        level = worse(level, marginLevel)
      }
    }
  }

  drivers.sort((a, b) => RANK[b.level as "warn"] - RANK[a.level as "warn"])
  nearest.sort((a, b) => a.headroom - b.headroom)
  const accountValue = dec(ch.marginSummary.accountValue) as bigint
  const marginUsed = dec(ch.marginSummary.totalMarginUsed) as bigint
  const free = accountValue - marginUsed
  const account: PerpsAccountLine = {
    accountValueUsd: ch.marginSummary.accountValue,
    marginUsedUsd: ch.marginSummary.totalMarginUsed,
    crossAccountValueUsd: ch.crossMarginSummary.accountValue,
    freeMarginUsd: formatDec(free > 0n ? free : 0n),
    withdrawableUsd: ch.withdrawable,
    crossMaintenanceMarginUsedUsd: ch.crossMaintenanceMarginUsed,
    marginRatio,
    unrealizedPnlUsd: formatDec(unrealized),
    positionCount: positions.length,
    mode,
    level,
  }
  return {
    ...base,
    level,
    reason: null,
    drivers,
    closest: level === "ok" ? (nearest[0]?.driver ?? null) : null,
    account,
    positions,
  }
}

/** A report with no level: a failed or stale read (I4). */
export function unknownRiskReport(
  identity: PerpsRiskIdentity,
  thresholds: PerpsRiskThresholdsReport,
  reason: PerpsRiskReason,
  now: number,
  mode: string | null = null,
): PerpsRiskReport {
  return {
    schema: "candle.perps.risk/1",
    ...identity,
    mode,
    readAt: new Date(now).toISOString(),
    level: "unknown",
    reason,
    drivers: [],
    closest: null,
    thresholds,
    account: null,
    positions: [],
    note: PERPS_RISK_NOTE,
  }
}

/** Two halves completing further apart than this yield no level (design 4, A-8). */
export const PERPS_RISK_STALE_MS = 30_000

export interface ReadPerpsRiskOptions extends HyperliquidInfoOptions {
  fetcher: HyperliquidInfoFetcher
  network: HyperliquidRiskNetwork
  walletId: string
  address: string
  thresholds: PerpsRiskThresholdsReport
  now: () => number
  /** A mode already read (watch reads it every 5 minutes); omitted, it is read with the rest. */
  mode?: string
}

/**
 * The A-8 read: `clearinghouseState`, `metaAndAssetCtxs` and (unless given) `userAbstraction` in
 * parallel, then the pure rule. Halves completing more than 30 s apart are `PERPS_READ_STALE`.
 * A failed read throws `HyperliquidReadError`; callers turn it into `PERPS_READ_FAILED`.
 */
export async function readPerpsRisk(opts: ReadPerpsRiskOptions): Promise<PerpsRiskReport> {
  const identity = { walletId: opts.walletId, address: opts.address, network: opts.network }
  const timed = async <T>(read: Promise<T>): Promise<{ value: T; at: number }> => {
    const value = await read
    return { value, at: opts.now() }
  }
  const [state, market, mode] = await Promise.all([
    timed(readHyperliquidClearinghouse(opts.fetcher, opts.network, opts.address, opts)),
    timed(readHyperliquidMarketSnapshot(opts.fetcher, opts.network, opts)),
    opts.mode !== undefined
      ? Promise.resolve({ value: opts.mode, at: Number.NaN })
      : timed(readHyperliquidAccountMode(opts.fetcher, opts.network, opts.address, opts)),
  ])
  const times = [state.at, market.at, mode.at].filter((at) => !Number.isNaN(at))
  const earliest = Math.min(...times)
  if (Math.max(...times) - earliest > PERPS_RISK_STALE_MS)
    return unknownRiskReport(identity, opts.thresholds, "PERPS_READ_STALE", earliest, mode.value)
  return hyperliquidRiskReport(state.value, market.value, mode.value, opts.thresholds, earliest, identity)
}

/** The exit code a level carries (A-8): 0 ok, 10 warn, 11 critical, 1 for unknown. */
export function perpsRiskExitCode(level: PerpsRiskLevel): 0 | 1 | 10 | 11 {
  return level === "ok" ? 0 : level === "warn" ? 10 : level === "critical" ? 11 : 1
}

// ── Recent realized P&L and funding (spec A-6) ────────────────────────────────────────────────

export interface PerpsRecentFigures {
  /** Epoch ms. */
  startTime: number
  endTime: number
  /** Sum of `closedPnl` over main-perp fills in the window. */
  realizedPnlUsd: string
  /** Venue fees, builder fees included; negative is a rebate. */
  feesUsd: string
  /** Positive is received, negative is paid. */
  fundingUsd: string
  fills: number
  fundingPayments: number
  /** Hyperliquid's response cap was hit (2,000 fills or 500 funding rows): the figures are partial. */
  truncated: boolean
}

export const PERPS_FILLS_RESPONSE_CAP = 2_000
export const PERPS_FUNDING_RESPONSE_CAP = 500
export const PERPS_RECENT_MAX_MS = 30 * 24 * 60 * 60 * 1_000

/** Main perps only: not a builder dex (`dex:COIN`), not spot (`@n` or `A/B`); the P&L section's filter. */
export function isMainPerpCoin(coin: unknown): boolean {
  return typeof coin === "string" && coin !== "" && !coin.includes(":") && !coin.includes("/") && !coin.startsWith("@")
}

export async function readPerpsRecent(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  address: string,
  window: { startTime: number; endTime: number },
  opts: HyperliquidInfoOptions = {},
): Promise<PerpsRecentFigures> {
  const user = address.toLowerCase()
  const [fills, funding] = await Promise.all([
    hyperliquidInfo(
      fetcher,
      network,
      { type: "userFillsByTime", user, startTime: window.startTime, endTime: window.endTime },
      opts,
    ),
    hyperliquidInfo(
      fetcher,
      network,
      { type: "userFunding", user, startTime: window.startTime, endTime: window.endTime },
      opts,
    ),
  ])
  return summarizePerpsRecent(fills, funding, window)
}

export function summarizePerpsRecent(
  fills: unknown,
  funding: unknown,
  window: { startTime: number; endTime: number },
): PerpsRecentFigures {
  if (!Array.isArray(fills)) throw new HyperliquidReadError("Unexpected userFillsByTime shape")
  if (!Array.isArray(funding)) throw new HyperliquidReadError("Unexpected userFunding shape")
  let realized = 0n
  let fees = 0n
  let paid = 0n
  let fillCount = 0
  let fundingCount = 0
  for (const row of fills) {
    if (!isRecord(row)) throw new HyperliquidReadError("Unexpected fill row")
    if (!isMainPerpCoin(row.coin)) continue
    const closed = dec(row.closedPnl)
    const fee = dec(row.fee)
    if (closed === null || fee === null) throw new HyperliquidReadError("Unexpected fill amount")
    realized += closed
    fees += fee
    fillCount++
  }
  for (const row of funding) {
    const delta = isRecord(row) ? row.delta : undefined
    if (!isRecord(delta)) throw new HyperliquidReadError("Unexpected funding row")
    if (delta.type !== "funding" || !isMainPerpCoin(delta.coin)) continue
    const usdc = dec(delta.usdc)
    if (usdc === null) throw new HyperliquidReadError("Unexpected funding amount")
    paid += usdc
    fundingCount++
  }
  return {
    startTime: window.startTime,
    endTime: window.endTime,
    realizedPnlUsd: formatDec(realized),
    feesUsd: formatDec(fees),
    fundingUsd: formatDec(paid),
    fills: fillCount,
    fundingPayments: fundingCount,
    truncated: fills.length >= PERPS_FILLS_RESPONSE_CAP || funding.length >= PERPS_FUNDING_RESPONSE_CAP,
  }
}

/** `candle perps account --json` and `perpsAccount()` (A-10). */
export interface PerpsAccountReport extends PerpsAccountLineFields {
  schema: "candle.perps.account/1"
  walletId: string
  address: string
  network: HyperliquidRiskNetwork
  mode: string | null
  readAt: string
  recent: PerpsRecentFigures
  risk: { level: PerpsRiskLevel; reason: PerpsRiskReason | null; drivers: PerpsRiskDriver[] }
}

type PerpsAccountLineFields = Partial<Omit<PerpsAccountLine, "mode" | "level">>

/** One report plus the recent window, in the A-10 shape. */
export function perpsAccountReport(report: PerpsRiskReport, recent: PerpsRecentFigures): PerpsAccountReport {
  const { mode: _mode, level: _level, ...line } = report.account ?? ({} as Partial<PerpsAccountLine>)
  return {
    schema: "candle.perps.account/1",
    walletId: report.walletId,
    address: report.address,
    network: report.network,
    mode: report.mode,
    readAt: report.readAt,
    ...line,
    recent,
    risk: { level: report.level, reason: report.reason, drivers: report.drivers },
  }
}

// ── Hysteresis and the watch loop (spec A-9) ──────────────────────────────────────────────────

/**
 * Whether every measured position and the margin ratio sit inclusively past `level`'s thresholds by
 * the band: distance `>=` threshold + band, ratio `<=` threshold - band. A null distance never
 * blocks (E1); an unmarked position blocks leaving `warn` (E3), since it holds the level there.
 */
export function perpsRiskClears(report: PerpsRiskReport, leaving: "warn" | "critical"): boolean {
  const t = report.thresholds
  const account = report.account
  if (!account) return false
  const distanceBps = (leaving === "warn" ? t.warnDistanceBps : t.criticalDistanceBps) + t.clearBandBps
  const ratioBps = (leaving === "warn" ? t.warnMarginRatioBps : t.criticalMarginRatioBps) - t.clearBandBps
  for (const p of report.positions) {
    if (p.markPx === null) {
      if (leaving === "warn") return false
      continue
    }
    if (p.liquidationPx === null) continue
    const d = distanceParts(p.markPx, p.liquidationPx)
    if (d && fracLess(d.num, d.den, distanceBps)) return false
  }
  const maint = dec(account.crossMaintenanceMarginUsedUsd) as bigint
  if (report.positions.length > 0 && maint > 0n) {
    const crossValue = dec(account.crossAccountValueUsd) as bigint
    if (crossValue <= 0n) return false
    if (fracGreater(maint, crossValue, ratioBps)) return false
  }
  return true
}

/**
 * One watch step: the level after `report`, given the level before it. Rising is immediate (the pure
 * rule). Falling goes in one poll to the lowest level whose clear condition holds, so `critical` may
 * go straight to `ok`; if none holds, the level stays. From `unknown` (start, or after a stale
 * read) the pure rule decides, with no band. A one-shot `risk` never calls this.
 */
export function perpsRiskStep(previous: PerpsRiskLevel, report: PerpsRiskReport): PerpsRiskLevel {
  const rule = report.level
  if (rule === "unknown" || previous === "unknown") return rule
  if (RANK[rule] >= RANK[previous]) return rule
  if (rule === "ok" && perpsRiskClears(report, "warn")) return "ok"
  if (previous === "critical" && perpsRiskClears(report, "critical")) return "warn"
  return previous
}

export type PerpsWatchEvent =
  | {
      event: "start"
      walletId: string
      address: string
      network: HyperliquidRiskNetwork
      at: string
      intervalSeconds: number
      heartbeatSeconds: number
      thresholds: PerpsRiskThresholdsReport
      /** Hyperliquid request weight one watcher spends per minute at this interval (of 1,200 per IP). */
      weightPerMinute: number
    }
  | (Omit<PerpsRiskReport, "level"> & {
      event: "level"
      level: PerpsRiskLevel
      /** What the pure rule says for this read; `level` is held by hysteresis. */
      ruleLevel: PerpsRiskLevel
      previous: PerpsRiskLevel
      cleared?: true
    })
  | (Omit<PerpsRiskReport, "level"> & { event: "heartbeat"; level: PerpsRiskLevel; ruleLevel: PerpsRiskLevel })
  | { event: "error"; at: string; code: string; message: string; nextPollSeconds: number }

export const PERPS_WATCH_DEFAULT_INTERVAL_MS = 10_000
export const PERPS_WATCH_MIN_INTERVAL_MS = 5_000
export const PERPS_WATCH_MAX_INTERVAL_MS = 300_000
export const PERPS_WATCH_DEFAULT_HEARTBEAT_MS = 60_000
/** Thresholds and the account mode are re-read this often (I8: Candle is called at start and then every 5 minutes). */
export const PERPS_WATCH_REFRESH_MS = 300_000

/**
 * Hyperliquid's weights (rate-limit page, read 2026-10-17): `clearinghouseState` 2; `metaAndAssetCtxs`
 * and `userAbstraction` are not named there, so they take the default 20. A poll is the first two;
 * the mode is read every 5 minutes.
 */
export const HYPERLIQUID_INFO_WEIGHTS = { clearinghouseState: 2, metaAndAssetCtxs: 20, userAbstraction: 20 } as const

export function perpsWatchWeightPerMinute(intervalMs: number): number {
  const polls = 60_000 / intervalMs
  const modeReads = 60_000 / PERPS_WATCH_REFRESH_MS
  return Math.round(
    polls * (HYPERLIQUID_INFO_WEIGHTS.clearinghouseState + HYPERLIQUID_INFO_WEIGHTS.metaAndAssetCtxs) +
      modeReads * HYPERLIQUID_INFO_WEIGHTS.userAbstraction,
  )
}

export interface WatchPerpsRiskOptions {
  fetcher: HyperliquidInfoFetcher
  network: HyperliquidRiskNetwork
  walletId: string
  address: string
  /** Called at start and every 5 minutes; a failed re-read keeps the last (A-9). */
  thresholds: () => Promise<PerpsRiskThresholdsReport>
  intervalMs?: number
  /** 0 turns heartbeats off. */
  heartbeatMs?: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
  /** Return at the first level change after the first reading, with that level. */
  onceLevelChange?: boolean
  onEvent: (event: PerpsWatchEvent) => void | Promise<void>
}

/**
 * The loop `candle perps watch` wraps, and an always-on bot can run as is. Polls until `signal`
 * aborts (or the first change with `onceLevelChange`) and resolves with the last known level.
 */
export async function watchPerpsRisk(opts: WatchPerpsRiskOptions): Promise<{ level: PerpsRiskLevel }> {
  const baseInterval = opts.intervalMs ?? PERPS_WATCH_DEFAULT_INTERVAL_MS
  const heartbeatMs = opts.heartbeatMs ?? PERPS_WATCH_DEFAULT_HEARTBEAT_MS
  const identity = { walletId: opts.walletId, address: opts.address, network: opts.network }
  const sleep = (ms: number) => abortableSleep(opts.sleep, ms, opts.signal)
  const info = { sleep: opts.sleep }

  let thresholds: PerpsRiskThresholdsReport
  try {
    thresholds = await opts.thresholds()
  } catch {
    thresholds = { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" }
  }
  let thresholdsAt = opts.now()
  let mode: string | undefined
  let modeAt = Number.NEGATIVE_INFINITY
  let level: PerpsRiskLevel = "unknown"
  let lastGoodAt: number | null = null
  let staleReported = false
  let interval = baseInterval
  let lastHeartbeat = opts.now()
  let established = false

  await opts.onEvent({
    event: "start",
    ...identity,
    at: new Date(opts.now()).toISOString(),
    intervalSeconds: baseInterval / 1_000,
    heartbeatSeconds: heartbeatMs / 1_000,
    thresholds,
    weightPerMinute: perpsWatchWeightPerMinute(baseInterval),
  })

  while (!opts.signal?.aborted) {
    if (opts.now() - thresholdsAt >= PERPS_WATCH_REFRESH_MS) {
      thresholdsAt = opts.now()
      try {
        thresholds = await opts.thresholds()
      } catch {
        // A failed re-read keeps the last thresholds.
      }
    }
    let report: PerpsRiskReport | null = null
    try {
      if (mode === undefined || opts.now() - modeAt >= PERPS_WATCH_REFRESH_MS) {
        mode = await readHyperliquidAccountMode(opts.fetcher, opts.network, opts.address, info)
        modeAt = opts.now()
      }
      report = await readPerpsRisk({ ...identity, fetcher: opts.fetcher, thresholds, now: opts.now, mode, ...info })
      interval = baseInterval
    } catch (error) {
      const rateLimited = error instanceof HyperliquidReadError && error.rateLimited
      if (rateLimited) interval = Math.min(interval * 2, PERPS_WATCH_MAX_INTERVAL_MS)
      await opts.onEvent({
        event: "error",
        at: new Date(opts.now()).toISOString(),
        code: error instanceof HyperliquidReadError ? error.code : "PERPS_READ_FAILED",
        message: error instanceof Error ? error.message : "Hyperliquid read failed",
        nextPollSeconds: interval / 1_000,
      })
      // A failed poll changes nothing until the last good read is older than 30 s (A-9, AC10).
      if (
        level !== "unknown" &&
        !staleReported &&
        lastGoodAt !== null &&
        opts.now() - lastGoodAt > PERPS_RISK_STALE_MS
      ) {
        const previous: PerpsRiskLevel = level
        level = "unknown"
        staleReported = true
        const stale = unknownRiskReport(identity, thresholds, "PERPS_READ_STALE", opts.now(), mode ?? null)
        await opts.onEvent({ ...stale, event: "level", level, ruleLevel: "unknown", previous })
        if (opts.onceLevelChange && established) return { level }
      }
    }

    if (report) {
      const previous: PerpsRiskLevel = level
      const next = perpsRiskStep(previous, report)
      if (report.level !== "unknown") {
        lastGoodAt = opts.now()
        staleReported = false
      }
      if (next !== previous) {
        level = next
        const cleared = next === "ok" && (previous === "warn" || previous === "critical")
        await opts.onEvent({
          ...report,
          event: "level",
          level: next,
          ruleLevel: report.level,
          previous,
          ...(cleared ? { cleared: true as const } : {}),
        })
        if (opts.onceLevelChange && established) return { level }
        if (next !== "unknown") established = true
      } else if (next !== "unknown") {
        established = true
      }
      if (heartbeatMs > 0 && opts.now() - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = opts.now()
        await opts.onEvent({ ...report, event: "heartbeat", level, ruleLevel: report.level })
      }
    }
    if (opts.signal?.aborted) break
    await sleep(interval)
  }
  return { level }
}

function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
    sleep(ms).then(done, done)
  })
}

// ── The portfolio's Hyperliquid section (spec A-11) ───────────────────────────────────────────

export interface PerpsPortfolioAccount {
  address: string
  label?: string
  walletId?: string
  accountValueUsd: string
  unrealizedPnlUsd: string
  positionCount: number
  /** At the default thresholds (portfolio is account-wide; thresholds are per key). */
  level: PerpsRiskLevel
}

export type PerpsPortfolioSection =
  | {
      read: true
      network: HyperliquidRiskNetwork
      /** Accounts with a position or a non-zero account value. */
      accounts: PerpsPortfolioAccount[]
      /** Sum of the total (`marginSummary`) account value and unrealized P&L of the accounts read. */
      subtotal: { accountValueUsd: string; unrealizedPnlUsd: string }
      /** Read, holding nothing on Hyperliquid: counted, not listed. */
      empty: number
      /** Not read: a failed read, or past the 100-address cap. Never zero. */
      unread: { address: string; label?: string; walletId?: string; reason: string }[]
      thresholds: "defaults"
    }
  | { read: false; reason: string }

export const PERPS_PORTFOLIO_MAX_ACCOUNTS = 100
const PORTFOLIO_READS_IN_FLIGHT = 8

/**
 * One shared `metaAndAssetCtxs`, then `clearinghouseState` per address, at most 8 in flight and at
 * most 100 addresses. Every level is at the defaults. A failed market read leaves the whole section
 * unread; a failed account read leaves that account unread. Not added to any portfolio total (D4).
 */
export async function perpsPortfolioSection(
  fetcher: HyperliquidInfoFetcher,
  network: HyperliquidRiskNetwork,
  wallets: readonly { address: string; label?: string; walletId?: string }[],
  opts: HyperliquidInfoOptions & { now?: () => number } = {},
): Promise<PerpsPortfolioSection> {
  const now = opts.now ?? Date.now
  const considered = wallets.slice(0, PERPS_PORTFOLIO_MAX_ACCOUNTS)
  const unread: { address: string; label?: string; walletId?: string; reason: string }[] = wallets
    .slice(PERPS_PORTFOLIO_MAX_ACCOUNTS)
    .map((w) => ({ ...w, reason: `past the ${PERPS_PORTFOLIO_MAX_ACCOUNTS}-address cap` }))
  let markets: HyperliquidMarkets = { universe: [], ctxs: [], marginTables: new Map() }
  if (considered.length > 0) {
    try {
      markets = await readHyperliquidMarketSnapshot(fetcher, network, opts)
    } catch (error) {
      return { read: false, reason: error instanceof Error ? error.message : "Hyperliquid market read failed" }
    }
  }
  const thresholds: PerpsRiskThresholdsReport = { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults" }
  const results: (PerpsPortfolioAccount | null)[] = new Array(considered.length).fill(null)
  const failures: (string | null)[] = new Array(considered.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < considered.length) {
      const at = next++
      const wallet = considered[at] as (typeof considered)[number]
      try {
        const state = await readHyperliquidClearinghouse(fetcher, network, wallet.address, opts)
        const report = hyperliquidRiskReport(state, markets, "default", thresholds, now())
        results[at] = {
          address: wallet.address,
          ...(wallet.label !== undefined ? { label: wallet.label } : {}),
          ...(wallet.walletId !== undefined ? { walletId: wallet.walletId } : {}),
          accountValueUsd: report.account?.accountValueUsd ?? "0",
          unrealizedPnlUsd: report.account?.unrealizedPnlUsd ?? "0",
          positionCount: report.positions.length,
          level: report.level,
        }
      } catch (error) {
        failures[at] = error instanceof Error ? error.message : "read failed"
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_READS_IN_FLIGHT, considered.length) }, worker))
  const accounts: PerpsPortfolioAccount[] = []
  let empty = 0
  let value = 0n
  let pnl = 0n
  considered.forEach((wallet, at) => {
    const result = results[at]
    if (!result) {
      unread.push({ ...wallet, reason: failures[at] ?? "read failed" })
      return
    }
    if (result.positionCount === 0 && dec(result.accountValueUsd) === 0n) {
      empty++
      return
    }
    accounts.push(result)
    value += dec(result.accountValueUsd) as bigint
    pnl += dec(result.unrealizedPnlUsd) as bigint
  })
  return {
    read: true,
    network,
    accounts,
    subtotal: { accountValueUsd: formatDec(value), unrealizedPnlUsd: formatDec(pnl) },
    empty,
    unread,
    thresholds: "defaults",
  }
}

// ── Exact decimals ────────────────────────────────────────────────────────────────────────────

const SCALE = 18
const ONE = 10n ** BigInt(SCALE)
const DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/
// Hyperliquid writes some whole numbers with leading zeros stripped and some with a trailing ".0".
const LOOSE_DEC_RE = /^-?[0-9]+(\.[0-9]{1,18})?$/

function isDecString(value: unknown): value is string {
  return typeof value === "string" && (DEC_RE.test(value) || LOOSE_DEC_RE.test(value))
}

/** A signed decimal string scaled by 10^18, or null when it is not one. */
function dec(value: unknown): bigint | null {
  if (!isDecString(value)) return null
  const negative = value.startsWith("-")
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".")
  const scaled = BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, "0"))
  return negative ? -scaled : scaled
}

/** A scaled value as the shortest decimal string ("0", "-12.5"). */
function formatDec(value: bigint): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / ONE
  const fraction = (abs % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "")
  const text = fraction ? `${whole}.${fraction}` : `${whole}`
  return negative && text !== "0" ? `-${text}` : text
}

/** `abs(mark - liquidation)` over `mark`, as scaled numerator and denominator; null without a positive mark. */
function distanceParts(markPx: string, liquidationPx: string): { num: bigint; den: bigint } | null {
  const mark = dec(markPx)
  const liq = dec(liquidationPx)
  if (mark === null || liq === null || mark <= 0n) return null
  const diff = mark - liq
  return { num: diff < 0n ? -diff : diff, den: mark }
}

/** `num / den < bps / 10000`, exactly (den > 0). */
function fracLess(num: bigint, den: bigint, bps: number): boolean {
  return num * 10_000n < BigInt(bps) * den
}

/** `num / den > bps / 10000`, exactly (den > 0). */
function fracGreater(num: bigint, den: bigint, bps: number): boolean {
  return num * 10_000n > BigInt(bps) * den
}

/** `num / den` as a JSON number (for display; never compared). */
function ratioNumber(num: bigint, den: bigint): number {
  const micro = (num * 1_000_000_000_000n) / den
  return Number(micro) / 1e12
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isParsedClearinghouse(value: unknown): value is HyperliquidClearinghouse {
  return isRecord(value) && Array.isArray(value.positions) && !("assetPositions" in value)
}
