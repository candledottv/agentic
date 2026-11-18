/** Public perp market reads (Spec B, BE-1581). Self-contained; byte-copied to CLI and MCP.
 * No signing, relay or exchange calls. readHyperliquidMarkets is also the shared Spec A reader.
 *
 * BE-3755 (Hyperliquid HM1): builder-deployed (HIP-3) perp dexes. A builder market is named
 * `dex:COIN` (`xyz:TSLA`), lives in its own dex's universe (`metaAndAssetCtxs` with a `dex`), and
 * takes the asset id `100000 + perp_dex_index * 10000 + index_in_meta` (Hyperliquid's asset-id doc,
 * pinned by `__fixtures__/hyperliquid-markets/builder-dex.json`). Main-exchange names and reads are
 * unchanged.
 */
export type PerpsMarketNetwork = "mainnet" | "testnet"
export type PerpsMarketFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>
const INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
} as const
const ONE = 10n ** 18n
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/
export class PerpsMarketError extends Error {
  readonly retryable: boolean
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PerpsMarketError"
    this.retryable = code === "PERPS_UNAVAILABLE"
  }
}
function unavailable(): never {
  throw new PerpsMarketError("PERPS_UNAVAILABLE", "Hyperliquid market data is unavailable; retry shortly.")
}
function usage(message: string): never {
  throw new PerpsMarketError("PERPS_USAGE", message)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function decimal(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 100 && DECIMAL.test(value) && (value.split(".")[1]?.length ?? 0) <= 18
  )
}
function scaled(value: string): bigint {
  const negative = value.startsWith("-")
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".")
  const result = BigInt(whole) * ONE + BigInt(fraction.padEnd(18, "0"))
  return negative ? -result : result
}
function nonnegative(value: unknown): bigint | null {
  return decimal(value) && !value.startsWith("-") ? scaled(value) : null
}
/** Round derived display values to nearest, halves away from zero. Never used by the gate. */
function fixed(value: bigint, places: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const divisor = 10n ** BigInt(18 - places)
  const rounded = (abs + divisor / 2n) / divisor
  const digits = rounded.toString().padStart(places + 1, "0")
  return `${negative && rounded !== 0n ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`
}
export interface PerpsMarketMeta {
  name: string
  szDecimals: number
  maxLeverage: number
  onlyIsolated?: boolean
  isDelisted?: boolean
  marginTableId?: number
  /** Builder dexes: `noCross` or `strictIsolated` mean isolated margin only. */
  marginMode?: string
  /** Builder dexes: the deployer's fee share, a decimal (1.0 = 100% of the protocol fee). */
  deployerFeeScale?: string
  /** Builder dexes: `enabled` when growth mode cuts the all-in fee by 90%. */
  growthMode?: string
}
export interface PerpsAssetContext {
  markPx?: string | null
  midPx?: string | null
  oraclePx?: string | null
  openInterest?: string | null
  funding?: string | null
  dayNtlVlm?: string | null
  prevDayPx?: string | null
  premium?: string | null
  impactPxs?: [string, string] | null
}
export interface PerpsMarginTier {
  lowerBoundUsd: string
  maxLeverage: number
}
export interface PerpsMarketSnapshot {
  universe: PerpsMarketMeta[]
  ctxs: PerpsAssetContext[]
  marginTables: Map<number, PerpsMarginTier[]>
  /** The dex's collateral, a spot token index (0 is USDC). Absent from older answers: USDC. */
  collateralToken?: number
}

// ── Builder-deployed (HIP-3) dexes (BE-3755) ─────────────────────────────────────────────

/** One builder dex from `perpDexs`. Index 0 of that list is the main exchange (null), never a dex. */
export interface PerpsDex {
  /** `perp_dex_index`: the position in Hyperliquid's `perpDexs` answer, from 1. */
  index: number
  name: string
  fullName: string
  deployer: string
  /** The address that posts oracle prices, or null when the deployer (or a setOracle delegate) does. */
  oracleUpdater: string | null
  /** Every address allowed to set this dex's oracle price: the updater, setOracle delegates, else the deployer. */
  oracleSetters: string[]
}

/** `dex:COIN`: a dex of 1-12 letters and digits, a colon, a coin of 1-20. Main coins carry no colon. */
const DEX_COIN = /^([A-Za-z0-9]{1,12}):([A-Za-z0-9]{1,20})$/
const MAIN_COIN = /^[A-Za-z0-9]{1,20}$/

/**
 * Split a market name: `BTC` is the main exchange (dex ""), `xyz:TSLA` is builder dex `xyz`. The dex
 * folds to lower case (Hyperliquid's dex names are lower case); the coin keeps its case. Null for
 * anything else: an empty part, a second colon, a space, a slash, over-long parts.
 */
export function parsePerpsCoin(coin: unknown): { dex: string; coin: string } | null {
  if (typeof coin !== "string") return null
  if (MAIN_COIN.test(coin)) return { dex: "", coin }
  const m = DEX_COIN.exec(coin)
  if (!m || !m[1] || !m[2]) return null
  return { dex: m[1].toLowerCase(), coin: `${m[1].toLowerCase()}:${m[2]}` }
}

/** A dex filter: "" (main), a builder dex name (lower-cased), or null when malformed. */
export function parsePerpsDex(dex: unknown): string | null {
  if (dex === undefined || dex === null || dex === "") return ""
  if (typeof dex !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(dex)) return null
  return dex.toLowerCase()
}

/** Hyperliquid's asset id: the meta index on the main exchange, `100000 + dex * 10000 + i` on a builder dex. */
export function perpsAssetId(dexIndex: number, indexInMeta: number): number {
  return dexIndex === 0 ? indexInMeta : 100_000 + dexIndex * 10_000 + indexInMeta
}

/** Isolated-only when the market says so, or its margin mode forbids cross. */
export function perpsMarginMode(meta: Pick<PerpsMarketMeta, "onlyIsolated" | "marginMode">): "cross" | "isolated" {
  return meta.onlyIsolated === true || meta.marginMode === "noCross" || meta.marginMode === "strictIsolated"
    ? "isolated"
    : "cross"
}

/** Spot token names for the collateral indexes seen on mainnet (2026-11-17). Display only; USDC is index 0. */
const COLLATERAL_NAMES: Record<number, string> = { 0: "USDC", 235: "USDE", 268: "USDT0", 360: "USDH" }

export function perpsCollateralName(token: number): string {
  return COLLATERAL_NAMES[token] ?? `spot token ${token}`
}

/** Hyperliquid's base-tier perp fees, in percent: what `feeMultiplier` scales. */
export const PERPS_MAIN_TAKER_FEE_PCT = "0.045"
export const PERPS_MAIN_MAKER_FEE_PCT = "0.015"
/** BE-3755 (decisions doc section 6, settled call 2): warn when a market's fee is above 2x the main exchange's. */
export const PERPS_FEE_WARNING_MULTIPLIER = 2

/**
 * A builder market's fee as a multiple of the main exchange's fee at the same tier (Hyperliquid fee
 * doc): a deployer share `s` up to 1 adds `s` to the protocol fee (1 + s); above 1 the protocol fee
 * rises to match it (2s); growth mode cuts the all-in fee by 90%. The main exchange is 1. Exact
 * decimal (18 places, trailing zeros trimmed).
 */
export function perpsFeeMultiplier(
  meta: Pick<PerpsMarketMeta, "deployerFeeScale" | "growthMode">,
  dex: string,
): string {
  if (dex === "") return "1"
  const share = nonnegative(meta.deployerFeeScale ?? "0") ?? 0n
  let multiple = share <= ONE ? ONE + share : 2n * share
  if (meta.growthMode === "enabled") multiple = multiple / 10n
  return trim(multiple)
}

function trim(value: bigint): string {
  return fixed(value, 18).replace(/\.?0+$/, "") || "0"
}

/** The terms a client shows before every order on a market (BE-3755, scope 4). */
export interface PerpsDexTerms {
  /** "" on Hyperliquid's main perp exchange, else the builder dex (`xyz`). */
  dex: string
  dexName: string | null
  /** The builder dex's deployer; null on the main exchange (validator-operated). */
  deployer: string | null
  /** `validators` on the main exchange; `deployer` on a builder dex, with the addresses that may set it. */
  oracleSource: "validators" | "deployer"
  oracleSetters: string[]
  marginMode: "cross" | "isolated"
  collateral: string
  /** Fee as a multiple of the main exchange's fee at the same tier, before Candle's builder fee. */
  feeMultiplier: string
  takerFeePct: string
  makerFeePct: string
  /** Set when the fee is above 2x the main exchange's; never a refusal. */
  feeWarning: string | null
}

export function perpsDexTerms(meta: PerpsMarketMeta, dex: PerpsDex | null, collateralToken: number): PerpsDexTerms {
  const name = dex?.name ?? ""
  const multiplier = perpsFeeMultiplier(meta, name)
  const scaledMultiplier = scaled(multiplier)
  const pct = (base: string) => trim((scaled(base) * scaledMultiplier) / ONE)
  return {
    dex: name,
    dexName: dex?.fullName ?? null,
    deployer: dex?.deployer ?? null,
    oracleSource: dex ? "deployer" : "validators",
    oracleSetters: dex?.oracleSetters ?? [],
    marginMode: perpsMarginMode(meta),
    collateral: perpsCollateralName(collateralToken),
    feeMultiplier: multiplier,
    takerFeePct: pct(PERPS_MAIN_TAKER_FEE_PCT),
    makerFeePct: pct(PERPS_MAIN_MAKER_FEE_PCT),
    feeWarning:
      scaledMultiplier > BigInt(PERPS_FEE_WARNING_MULTIPLIER) * ONE
        ? `${meta.name} charges ${multiplier}x the main exchange's fee (its deployer sets it), above Candle's ${PERPS_FEE_WARNING_MULTIPLIER}x warning line`
        : null,
  }
}

function address(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
}

/** Parse `perpDexs`: entry 0 is null (the main exchange); every other entry is a builder dex. */
export function parsePerpDexs(value: unknown): PerpsDex[] {
  if (!Array.isArray(value)) return unavailable()
  const dexes: PerpsDex[] = []
  for (const [index, entry] of value.entries()) {
    if (index === 0 || entry === null) continue
    if (
      !object(entry) ||
      typeof entry.name !== "string" ||
      !/^[a-z0-9]{1,12}$/.test(entry.name) ||
      !address(entry.deployer) ||
      (entry.oracleUpdater !== null && entry.oracleUpdater !== undefined && !address(entry.oracleUpdater))
    )
      return unavailable()
    const setters = new Set<string>()
    if (address(entry.oracleUpdater)) setters.add(entry.oracleUpdater.toLowerCase())
    if (Array.isArray(entry.subDeployers))
      for (const pair of entry.subDeployers)
        if (Array.isArray(pair) && pair[0] === "setOracle" && Array.isArray(pair[1]))
          for (const a of pair[1]) if (address(a)) setters.add(a.toLowerCase())
    if (setters.size === 0) setters.add(entry.deployer.toLowerCase())
    dexes.push({
      index,
      name: entry.name,
      fullName: typeof entry.fullName === "string" ? entry.fullName : entry.name,
      deployer: entry.deployer.toLowerCase(),
      oracleUpdater: address(entry.oracleUpdater) ? entry.oracleUpdater.toLowerCase() : null,
      oracleSetters: [...setters].sort(),
    })
  }
  return dexes
}

export async function readHyperliquidPerpDexs(
  fetcher: PerpsMarketFetch,
  network: PerpsMarketNetwork,
): Promise<PerpsDex[]> {
  return parsePerpDexs(await info(fetcher, network, { type: "perpDexs" }))
}
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) return unavailable()
  return value
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function parseMarkets(value: unknown): PerpsMarketSnapshot {
  if (!Array.isArray(value) || value.length !== 2) return unavailable()
  const [meta, ctxs] = value
  if (!object(meta) || !Array.isArray(meta.universe) || !Array.isArray(ctxs) || meta.universe.length !== ctxs.length)
    return unavailable()
  for (const row of meta.universe) {
    if (
      !object(row) ||
      typeof row.name !== "string" ||
      !integer(row.szDecimals) ||
      row.szDecimals > 6 ||
      !integer(row.maxLeverage)
    )
      return unavailable()
    for (const key of ["isDelisted", "onlyIsolated"])
      if (row[key] !== undefined && typeof row[key] !== "boolean") return unavailable()
    if (row.marginTableId !== undefined && !integer(row.marginTableId)) return unavailable()
    for (const key of ["marginMode", "growthMode"])
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") return unavailable()
    if (row.deployerFeeScale !== undefined && nonnegative(row.deployerFeeScale) === null) return unavailable()
  }
  if (meta.collateralToken !== undefined && !integer(meta.collateralToken)) return unavailable()
  for (const ctx of ctxs) {
    if (!object(ctx)) return unavailable()
    for (const key of ["markPx", "midPx", "oraclePx", "openInterest", "funding", "dayNtlVlm", "prevDayPx", "premium"]) {
      if (ctx[key] !== undefined && ctx[key] !== null && !decimal(ctx[key])) return unavailable()
    }
    if (
      ctx.impactPxs != null &&
      (!Array.isArray(ctx.impactPxs) || ctx.impactPxs.length !== 2 || !ctx.impactPxs.every(decimal))
    )
      return unavailable()
  }
  const marginTables = new Map<number, PerpsMarginTier[]>()
  if (meta.marginTables !== undefined) {
    if (!Array.isArray(meta.marginTables)) return unavailable()
    for (const entry of meta.marginTables) {
      if (!Array.isArray(entry) || !integer(entry[0]) || !object(entry[1]) || !Array.isArray(entry[1].marginTiers))
        return unavailable()
      const tiers: PerpsMarginTier[] = []
      for (const tier of entry[1].marginTiers) {
        if (!object(tier) || nonnegative(tier.lowerBound) === null || !integer(tier.maxLeverage)) return unavailable()
        tiers.push({ lowerBoundUsd: tier.lowerBound as string, maxLeverage: tier.maxLeverage })
      }
      marginTables.set(entry[0], tiers)
    }
  }
  return {
    universe: meta.universe as unknown as PerpsMarketMeta[],
    ctxs: ctxs as PerpsAssetContext[],
    marginTables,
    ...(meta.collateralToken === undefined ? {} : { collateralToken: meta.collateralToken as number }),
  }
}
async function info(fetcher: PerpsMarketFetch, network: PerpsMarketNetwork, body: object): Promise<unknown> {
  try {
    const response = await fetcher(INFO_URLS[network], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    })
    if (!response.ok) return unavailable()
    return JSON.parse(await response.text())
  } catch {
    return unavailable()
  }
}
/** One dex's universe: the main exchange when `dex` is "" (the unchanged wire body), else that builder dex. */
export async function readHyperliquidMarkets(
  fetcher: PerpsMarketFetch,
  network: PerpsMarketNetwork,
  dex = "",
): Promise<PerpsMarketSnapshot> {
  return parseMarkets(
    await info(fetcher, network, dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }),
  )
}
/** Mirrors resolvePerpsMarket, including its mid fallback and rounded-UP USD micros. */
export type PerpsMarketGateReason = null | "delisted" | "noPrice" | "minOpenInterest" | "collateral" | "dexOpensRefused"
/**
 * BE-3755: on a builder dex, a collateral other than USDC refuses (until Hyperliquid spot, HM2), and
 * the operations kill switch refuses new opens on a named dex. The floor applies on every dex.
 */
export function perpsMarketGate(
  meta: Pick<PerpsMarketMeta, "isDelisted">,
  ctx: PerpsAssetContext,
  minOpenInterestUsd: number,
  dex: { name: string; collateralToken: number; opensRefused: readonly string[] } = {
    name: "",
    collateralToken: 0,
    opensRefused: [],
  },
): {
  tradeable: boolean
  reason: PerpsMarketGateReason
} {
  if (dex.name !== "" && dex.collateralToken !== 0) return { tradeable: false, reason: "collateral" }
  if (dex.name !== "" && dex.opensRefused.includes(dex.name)) return { tradeable: false, reason: "dexOpensRefused" }
  if (meta.isDelisted === true) return { tradeable: false, reason: "delisted" }
  const mark = nonnegative(ctx.markPx)
  const mid = nonnegative(typeof ctx.midPx === "string" ? ctx.midPx : ctx.markPx)
  const oi = nonnegative(ctx.openInterest)
  if (mark === null || mid === null || oi === null) return { tradeable: false, reason: "noPrice" }
  const divisor = 10n ** 30n
  const micros = (oi * mark + divisor - 1n) / divisor
  // The server refuses overflows rather than returning a usable market.
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable()
  if (minOpenInterestUsd > 0 && micros < BigInt(minOpenInterestUsd) * 1_000_000n)
    return { tradeable: false, reason: "minOpenInterest" }
  return { tradeable: true, reason: null }
}
/** The index of `coin` (already split by parsePerpsCoin) in its dex's universe: exact, else one case-folded match. */
function resolve(snapshot: PerpsMarketSnapshot, coin: string): number {
  const exact = snapshot.universe.findIndex((row) => row.name === coin)
  if (exact !== -1) return exact
  const matches = snapshot.universe
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row.name.toLowerCase() === coin.toLowerCase())
  if (matches.length === 1) return at(matches, 0).i
  return notFound(coin)
}
function notFound(coin: string): never {
  throw new PerpsMarketError(
    "PERPS_MARKET_NOT_FOUND",
    coin.includes(":")
      ? `${coin} is not a market on that Hyperliquid builder dex.`
      : `${coin} is not a market on Hyperliquid's main perp exchange.`,
  )
}
export type PerpsMarketSort = "volume" | "oi" | "funding" | "change" | "name"
export interface PerpsMarketsOptions {
  sort?: PerpsMarketSort
  limit?: number
  all?: boolean
  /** BE-3755: "" or absent for the main exchange (unchanged), a builder dex name (`xyz`), or `all` for every dex. */
  dex?: string
}
export interface PerpsBookOptions {
  depth?: number
  sigFigs?: number
}
export interface PerpsFundingHistoryOptions {
  /** ISO 8601 time or epoch milliseconds; default 24 hours before `end`. */
  start?: string | number
  /** ISO 8601 time or epoch milliseconds; default now. */
  end?: string | number
}
export interface PerpsCandlesOptions {
  interval?: string
  count?: number
  end?: string | number
}
export const PERPS_CANDLE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const
const INTERVAL_MS = [
  60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 43_200_000, 86_400_000,
  259_200_000, 604_800_000, 2_678_400_000,
]
export function perpsCandleWindow(opts: PerpsCandlesOptions, now: number) {
  const interval = opts.interval ?? "1h"
  const index = (PERPS_CANDLE_INTERVALS as readonly string[]).indexOf(interval)
  if (index < 0) return usage(`interval must be one of ${PERPS_CANDLE_INTERVALS.join(" ")}.`)
  const count = bounded(opts.count, 100, 1, 5_000, "count")
  const raw = opts.end
  const endTime = raw === undefined ? now : epoch(raw)
  const startTime = endTime - count * at(INTERVAL_MS, index)
  if (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > now || startTime < 0)
    return usage("end must be an ISO 8601 time or epoch milliseconds, no later than now.")
  return { interval, count, startTime, endTime }
}
function epoch(raw: string | number): number {
  return typeof raw === "number" || /^\d+$/.test(raw)
    ? Number(raw)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)
      ? Date.parse(raw)
      : NaN
}
export const PERPS_FUNDING_HISTORY_MAX_MS = 30 * 86_400_000
export const PERPS_FUNDING_HISTORY_MAX_ROWS = 500
/** Phase 3 (BE-1817): a funding-history window, at most 30 days, ending no later than now. */
export function perpsFundingWindow(opts: PerpsFundingHistoryOptions, now: number) {
  const endTime = opts.end === undefined ? now : epoch(opts.end)
  if (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > now)
    return usage("end must be an ISO 8601 time or epoch milliseconds, no later than now.")
  const startTime = opts.start === undefined ? endTime - 86_400_000 : epoch(opts.start)
  if (!Number.isSafeInteger(startTime) || startTime < 0 || startTime > endTime)
    return usage("start must be an ISO 8601 time or epoch milliseconds, no later than end.")
  if (endTime - startTime > PERPS_FUNDING_HISTORY_MAX_MS) return usage("start must be at most 30 days before end.")
  return { startTime, endTime }
}
function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < min || n > max) return usage(`${name} must be an integer from ${min} to ${max}.`)
  return n
}
export interface PerpsMarketEnvelope {
  success: true
  network: PerpsMarketNetwork
  readAt: number
  gate: { minOpenInterestUsd: number; source: "server" | "default"; dexOpensRefused?: string[] }
  warnings: string[]
}
export interface PerpsMarketRow {
  coin: string
  asset: number
  markPx: string | null
  oraclePx: string | null
  midPx: string | null
  fundingRate: string | null
  fundingAprPct: string | null
  predictedFundingRate: string | null
  nextFundingTime: number | null
  openInterest: string | null
  openInterestUsd: string | null
  dayNotionalVolumeUsd: string | null
  prevDayPx: string | null
  change24hPct: string | null
  maxLeverage: number
  onlyIsolated: boolean
  isDelisted: boolean
  atOpenInterestCap: boolean | null
  candle: { tradeable: boolean | null; reason: PerpsMarketGateReason | "networkMismatch" }
  /** BE-3755: "" on the main exchange, else the builder dex. */
  dex: string
  /** BE-3755: what a client shows before an order on this market (dex, oracle, deployer, margin, fee). */
  terms: PerpsDexTerms
}
export interface PerpsMarketsResult extends PerpsMarketEnvelope {
  markets: PerpsMarketRow[]
  /** BE-3755: the builder dexes, when the list was asked with `dex`. */
  dexes?: (PerpsDex & { collateral: string | null; tradeable: boolean | null })[]
}
export interface PerpsMarketResult extends PerpsMarketEnvelope {
  market: PerpsMarketRow & {
    szDecimals: number
    maxPriceDecimals: number
    priceRule: string
    minOrderUsd: number
    impactBidPx: string | null
    impactAskPx: string | null
    premium: string | null
    marginTiers: PerpsMarginTier[]
  }
}
export interface PerpsBookLevel {
  px: string
  sz: string
  n: number
}
export interface PerpsBookResult extends PerpsMarketEnvelope {
  coin: string
  time: number
  bids: PerpsBookLevel[]
  asks: PerpsBookLevel[]
  spreadPx: string | null
  spreadBps: string | null
  midPx: string | null
}
export interface PerpsCandle {
  t: number
  T: number
  o: string
  h: string
  l: string
  c: string
  v: string
  n: number
}
export interface PerpsCandlesResult extends PerpsMarketEnvelope {
  coin: string
  interval: string
  candles: PerpsCandle[]
}
export interface PerpsFundingPoint {
  time: number
  fundingRate: string
  fundingAprPct: string
  premium: string
}
export interface PerpsFundingHistoryResult extends PerpsMarketEnvelope {
  coin: string
  startTime: number
  endTime: number
  funding: PerpsFundingPoint[]
  /** True when the window held more than 500 rows; the earliest 500 are returned. */
  truncated: boolean
}
export interface PerpsPredictedFundingRow {
  coin: string
  fundingRate: string
  fundingAprPct: string
  nextFundingTime: number
}
export interface PerpsPredictedFundingResult extends PerpsMarketEnvelope {
  predicted: PerpsPredictedFundingRow[]
}
/** Hyperliquid `fundingHistory` rows for `coin`, oldest first, within the window. */
export function parsePerpsFundingHistory(
  value: unknown,
  coin: string,
  window: { startTime: number; endTime: number },
): { funding: PerpsFundingPoint[]; truncated: boolean } {
  if (!Array.isArray(value)) return unavailable()
  const funding: PerpsFundingPoint[] = []
  for (const row of value) {
    if (!object(row) || row.coin !== coin || !integer(row.time) || !decimal(row.fundingRate) || !decimal(row.premium))
      return unavailable()
    if (row.time >= window.startTime && row.time <= window.endTime)
      funding.push({
        time: row.time,
        fundingRate: row.fundingRate,
        fundingAprPct: fixed(scaled(row.fundingRate) * 876_000n, 2),
        premium: row.premium,
      })
  }
  funding.sort((a, b) => a.time - b.time)
  return {
    funding: funding.slice(0, PERPS_FUNDING_HISTORY_MAX_ROWS),
    truncated: funding.length > PERPS_FUNDING_HISTORY_MAX_ROWS,
  }
}
interface GateConfig {
  minOpenInterestUsd: number
  source: "server" | "default"
  network?: PerpsMarketNetwork
  /** BE-3755: builder dexes the server's operations kill switch refuses new opens on. */
  dexOpensRefused: string[]
  warnings: string[]
}
/** A located market: its dex's snapshot, its index there, and the dex (null on the main exchange). */
interface Located {
  snapshot: PerpsMarketSnapshot
  index: number
  dex: PerpsDex | null
}
interface MarketExtras {
  predicted: Map<string, { fundingRate: string; nextFundingTime: number }> | null
  cap: Set<string> | null
  warnings: string[]
}
export interface PerpsMarketReaderOptions {
  apiKey?: string
  network: PerpsMarketNetwork
  fetcher: PerpsMarketFetch
  readConfig: () => Promise<unknown>
  /** SDK/local MCP: 5000. CLI: 0. Cache lifetime starts on completion, never caches core failures. */
  cacheMs?: number
  now?: () => number
}
/** One instance per SDK client / local MCP configuration; CLI constructs one per invocation. */
export class PerpsMarketReader {
  private configPromise?: Promise<GateConfig>
  private coreCache?: { value: PerpsMarketSnapshot; at: number }
  private extrasCache?: { value: MarketExtras; at: number }
  private corePending?: Promise<PerpsMarketSnapshot>
  private extrasPending?: Promise<MarketExtras>
  private readonly dexCache = new Map<string, { value: PerpsMarketSnapshot; at: number }>()
  private readonly dexPending = new Map<string, Promise<PerpsMarketSnapshot>>()
  private dexesCache?: { value: PerpsDex[]; at: number }
  private dexesPending?: Promise<PerpsDex[]>
  private readonly now: () => number
  constructor(private readonly opts: PerpsMarketReaderOptions) {
    this.now = opts.now ?? Date.now
  }
  private key() {
    if (!this.opts.apiKey?.trim())
      throw new PerpsMarketError(
        "PERPS_KEY_REQUIRED",
        "Configure a Candle agent key (any scope) to read perps markets.",
      )
  }
  private config(): Promise<GateConfig> {
    this.key()
    this.configPromise ??= (async () => {
      try {
        const value = await this.opts.readConfig()
        if (
          !object(value) ||
          !object(value.limits) ||
          !integer(value.limits.minOpenInterestUsd) ||
          (value.network !== "mainnet" && value.network !== "testnet")
        )
          throw new Error("config shape")
        const refused = value.limits.dexOpensRefused
        return {
          minOpenInterestUsd: value.limits.minOpenInterestUsd,
          source: "server" as const,
          network: value.network,
          // An older server sends no list: nothing refused.
          dexOpensRefused: Array.isArray(refused) ? refused.filter((d): d is string => typeof d === "string") : [],
          warnings: [],
        }
      } catch {
        return {
          minOpenInterestUsd: 1_000_000,
          source: "default" as const,
          dexOpensRefused: [],
          warnings: ["Candle config unavailable; using the release's default OI floor."],
        }
      }
    })()
    return this.configPromise
  }
  private core(): Promise<PerpsMarketSnapshot> {
    const ttl = this.opts.cacheMs ?? 5_000
    if (this.coreCache && ttl > 0 && this.now() - this.coreCache.at < ttl) return Promise.resolve(this.coreCache.value)
    this.corePending ??= readHyperliquidMarkets(this.opts.fetcher, this.opts.network)
      .then((value) => {
        this.coreCache = { value, at: this.now() }
        return value
      })
      .finally(() => {
        this.corePending = undefined
      })
    return this.corePending
  }
  /** BE-3755: one builder dex's universe, cached like the main one. */
  private dexCore(dex: string): Promise<PerpsMarketSnapshot> {
    const ttl = this.opts.cacheMs ?? 5_000
    const hit = this.dexCache.get(dex)
    if (hit && ttl > 0 && this.now() - hit.at < ttl) return Promise.resolve(hit.value)
    let pending = this.dexPending.get(dex)
    if (!pending) {
      pending = readHyperliquidMarkets(this.opts.fetcher, this.opts.network, dex)
        .then((value) => {
          this.dexCache.set(dex, { value, at: this.now() })
          return value
        })
        .finally(() => {
          this.dexPending.delete(dex)
        })
      this.dexPending.set(dex, pending)
    }
    return pending
  }
  /** BE-3755: the builder dexes (`perpDexs`). */
  private dexes(): Promise<PerpsDex[]> {
    const ttl = this.opts.cacheMs ?? 5_000
    if (this.dexesCache && ttl > 0 && this.now() - this.dexesCache.at < ttl)
      return Promise.resolve(this.dexesCache.value)
    this.dexesPending ??= readHyperliquidPerpDexs(this.opts.fetcher, this.opts.network)
      .then((value) => {
        this.dexesCache = { value, at: this.now() }
        return value
      })
      .finally(() => {
        this.dexesPending = undefined
      })
    return this.dexesPending
  }
  /** The named builder dex, or PERPS_MARKET_NOT_FOUND. */
  private async dex(name: string): Promise<PerpsDex> {
    const found = (await this.dexes()).find((d) => d.name === name)
    if (!found) throw new PerpsMarketError("PERPS_MARKET_NOT_FOUND", `${name} is not a Hyperliquid builder dex.`)
    return found
  }
  /** Find a market by name on its dex: `BTC` on the main exchange, `xyz:TSLA` on builder dex xyz. */
  private async locate(coin: string): Promise<Located> {
    const parsed = parsePerpsCoin(coin)
    if (!parsed) return notFound(coin)
    if (parsed.dex === "") {
      const snapshot = await this.core()
      return { snapshot, index: resolve(snapshot, parsed.coin), dex: null }
    }
    // The dex is checked first, so an unknown dex never costs a universe read.
    const dex = await this.dex(parsed.dex)
    const snapshot = await this.dexCore(dex.name)
    return { snapshot, index: resolve(snapshot, parsed.coin), dex }
  }
  private extras(): Promise<MarketExtras> {
    const ttl = this.opts.cacheMs ?? 5_000
    if (this.extrasCache && ttl > 0 && this.now() - this.extrasCache.at < ttl)
      return Promise.resolve(this.extrasCache.value)
    this.extrasPending ??= (async () => {
      const warnings: string[] = []
      const [predicted, cap] = await Promise.all([
        info(this.opts.fetcher, this.opts.network, { type: "predictedFundings" })
          .then((value) => {
            if (!Array.isArray(value)) return unavailable()
            const map = new Map<string, { fundingRate: string; nextFundingTime: number }>()
            for (const entry of value) {
              if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1]))
                return unavailable()
              for (const venue of entry[1]) {
                if (!Array.isArray(venue) || typeof venue[0] !== "string") return unavailable()
                if (venue[0] === "HlPerp" && venue[1] !== null) {
                  if (!object(venue[1]) || !decimal(venue[1].fundingRate) || !integer(venue[1].nextFundingTime))
                    return unavailable()
                  map.set(entry[0], { fundingRate: venue[1].fundingRate, nextFundingTime: venue[1].nextFundingTime })
                }
              }
            }
            return map
          })
          .catch(() => {
            warnings.push("Predicted funding unavailable.")
            return null
          }),
        info(this.opts.fetcher, this.opts.network, { type: "perpsAtOpenInterestCap" })
          .then((value) => {
            if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return unavailable()
            return new Set<string>(value)
          })
          .catch(() => {
            warnings.push("Open-interest caps unavailable.")
            return null
          }),
      ])
      const value = { predicted, cap, warnings: warnings.sort() }
      this.extrasCache = { value, at: this.now() }
      return value
    })().finally(() => {
      this.extrasPending = undefined
    })
    return this.extrasPending
  }
  private envelope(config: GateConfig, warnings: string[] = [], readAt = this.now()): PerpsMarketEnvelope {
    const mismatch = config.network !== undefined && config.network !== this.opts.network
    return {
      success: true,
      network: this.opts.network,
      readAt,
      gate: {
        minOpenInterestUsd: config.minOpenInterestUsd,
        source: config.source,
        ...(config.dexOpensRefused.length > 0 ? { dexOpensRefused: config.dexOpensRefused } : {}),
      },
      warnings: [
        ...config.warnings,
        ...warnings,
        ...(mismatch ? ["Candle and client networks differ; tradeability is unknown."] : []),
      ],
    }
  }
  private row(
    core: PerpsMarketSnapshot,
    extras: MarketExtras,
    config: GateConfig,
    asset: number,
    dex: PerpsDex | null = null,
  ): PerpsMarketRow {
    const meta = at(core.universe, asset)
    const ctx = at(core.ctxs, asset)
    const collateralToken = core.collateralToken ?? 0
    const mark = ctx.markPx == null ? null : scaled(ctx.markPx)
    const oi = ctx.openInterest == null ? null : scaled(ctx.openInterest)
    const prev = ctx.prevDayPx == null ? null : scaled(ctx.prevDayPx)
    const predicted = extras.predicted?.get(meta.name)
    return {
      coin: meta.name,
      asset: perpsAssetId(dex?.index ?? 0, asset),
      markPx: ctx.markPx ?? null,
      oraclePx: ctx.oraclePx ?? null,
      midPx: ctx.midPx ?? null,
      fundingRate: ctx.funding ?? null,
      fundingAprPct: ctx.funding == null ? null : fixed(scaled(ctx.funding) * 876_000n, 2),
      predictedFundingRate: predicted?.fundingRate ?? null,
      nextFundingTime: predicted?.nextFundingTime ?? null,
      openInterest: ctx.openInterest ?? null,
      openInterestUsd: oi === null || mark === null ? null : fixed((oi * mark) / ONE, 2),
      dayNotionalVolumeUsd: ctx.dayNtlVlm ?? null,
      prevDayPx: ctx.prevDayPx ?? null,
      change24hPct:
        prev === null || prev === 0n || mark === null ? null : fixed(((mark - prev) * 100n * ONE) / prev, 1),
      maxLeverage: meta.maxLeverage,
      onlyIsolated: perpsMarginMode(meta) === "isolated",
      isDelisted: meta.isDelisted === true,
      // The cap list is the main exchange's.
      atOpenInterestCap: dex ? null : (extras.cap?.has(meta.name) ?? null),
      candle:
        config.network !== undefined && config.network !== this.opts.network
          ? { tradeable: null, reason: "networkMismatch" }
          : perpsMarketGate(meta, ctx, config.minOpenInterestUsd, {
              name: dex?.name ?? "",
              collateralToken,
              opensRefused: config.dexOpensRefused,
            }),
      dex: dex?.name ?? "",
      terms: perpsDexTerms(meta, dex, collateralToken),
    }
  }
  async markets(opts: PerpsMarketsOptions = {}): Promise<PerpsMarketsResult> {
    this.key()
    const sort = opts.sort ?? "volume"
    if (!["volume", "oi", "funding", "change", "name"].includes(sort))
      return usage("sort must be volume, oi, funding, change or name.")
    const limit = opts.limit === undefined ? undefined : bounded(opts.limit, 500, 1, 500, "limit")
    const dexFilter = opts.dex === "all" ? "all" : parsePerpsDex(opts.dex)
    if (dexFilter === null) return usage("dex must be a builder dex name such as xyz, or all.")
    const main = dexFilter === "" || dexFilter === "all"
    const [config, core, extras] = await Promise.all([this.config(), main ? this.core() : null, this.extras()])
    const listed: { snapshot: PerpsMarketSnapshot; dex: PerpsDex | null }[] = []
    let dexes: PerpsDex[] | null = null
    const skipped: string[] = []
    if (core) listed.push({ snapshot: core, dex: null })
    if (dexFilter !== "") {
      dexes = await this.dexes()
      const wanted = dexFilter === "all" ? dexes : [await this.dex(dexFilter)]
      // One unreadable dex does not sink the whole list: it is left out, with a warning.
      const settled = await Promise.allSettled(wanted.map((d) => this.dexCore(d.name)))
      for (const [i, d] of wanted.entries()) {
        const result = at(settled, i)
        if (result.status === "fulfilled") listed.push({ snapshot: result.value, dex: d })
        else if (dexFilter === "all") skipped.push(d.name)
        else throw result.reason
      }
    }
    const rows = listed
      .flatMap(({ snapshot, dex }) =>
        snapshot.universe.map((_, asset) => this.row(snapshot, extras, config, asset, dex)),
      )
      .filter((row) => opts.all || row.candle.tradeable !== false)
    const field = {
      volume: "dayNotionalVolumeUsd",
      oi: "openInterestUsd",
      funding: "fundingRate",
      change: "change24hPct",
    } as const
    rows.sort((a, b) => {
      if (sort !== "name") {
        const av = a[field[sort]]
        const bv = b[field[sort]]
        if (av === null && bv !== null) return 1
        if (bv === null && av !== null) return -1
        if (av !== null && bv !== null) {
          const diff = scaled(bv) - scaled(av)
          if (diff !== 0n) return diff > 0n ? 1 : -1
        }
      }
      return a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0
    })
    const dexRows =
      dexes === null
        ? undefined
        : await Promise.all(
            (dexFilter === "all" ? dexes : dexes.filter((d) => d.name === dexFilter)).map(async (d) => {
              if (skipped.includes(d.name)) return { ...d, collateral: null, tradeable: null }
              const token = (await this.dexCore(d.name)).collateralToken ?? 0
              return {
                ...d,
                collateral: perpsCollateralName(token),
                tradeable: token === 0 && !config.dexOpensRefused.includes(d.name),
              }
            }),
          )
    const warnings = [...extras.warnings, ...skipped.map((d) => `Builder dex ${d} markets unavailable.`)]
    return {
      ...this.envelope(config, warnings, Math.max(this.coreCache?.at ?? 0, this.extrasCache?.at ?? 0)),
      markets: limit === undefined ? rows : rows.slice(0, limit),
      ...(dexRows ? { dexes: dexRows } : {}),
    }
  }
  async market(coin: string): Promise<PerpsMarketResult> {
    this.key()
    const [config, located, extras] = await Promise.all([this.config(), this.locate(coin), this.extras()])
    const core = located.snapshot
    const asset = located.index
    const meta = at(core.universe, asset)
    const ctx = at(core.ctxs, asset)
    const readAt = located.dex ? (this.dexCache.get(located.dex.name)?.at ?? 0) : (this.coreCache?.at ?? 0)
    return {
      ...this.envelope(config, extras.warnings, Math.max(readAt, this.extrasCache?.at ?? 0)),
      market: {
        ...this.row(core, extras, config, asset, located.dex),
        szDecimals: meta.szDecimals,
        maxPriceDecimals: 6 - meta.szDecimals,
        priceRule: "at most 5 significant figures",
        minOrderUsd: 10,
        impactBidPx: ctx.impactPxs?.[0] ?? null,
        impactAskPx: ctx.impactPxs?.[1] ?? null,
        premium: ctx.premium ?? null,
        marginTiers: core.marginTables.get(meta.marginTableId ?? -1) ?? [
          { lowerBoundUsd: "0", maxLeverage: meta.maxLeverage },
        ],
      },
    }
  }
  async book(coin: string, opts: PerpsBookOptions = {}): Promise<PerpsBookResult> {
    this.key()
    const depth = bounded(opts.depth, 20, 1, 20, "depth")
    if (opts.sigFigs !== undefined) bounded(opts.sigFigs, 5, 2, 5, "sigFigs")
    const [config, located] = await Promise.all([this.config(), this.locate(coin)])
    const canonical = at(located.snapshot.universe, located.index).name
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "l2Book",
      coin: canonical,
      ...(opts.sigFigs === undefined ? {} : { nSigFigs: opts.sigFigs }),
    })
    if (
      !object(value) ||
      value.coin !== canonical ||
      !integer(value.time) ||
      !Array.isArray(value.levels) ||
      value.levels.length !== 2
    )
      return unavailable()
    const sides: PerpsBookLevel[][] = []
    for (const side of value.levels) {
      if (!Array.isArray(side)) return unavailable()
      const levels: PerpsBookLevel[] = []
      for (const level of side) {
        if (!object(level) || nonnegative(level.px) === null || nonnegative(level.sz) === null || !integer(level.n))
          return unavailable()
        levels.push({ px: level.px as string, sz: level.sz as string, n: level.n })
      }
      sides.push(levels)
    }
    const bids = at(sides, 0)
      .sort((a, b) => (scaled(a.px) > scaled(b.px) ? -1 : scaled(a.px) < scaled(b.px) ? 1 : 0))
      .slice(0, depth)
    const asks = at(sides, 1)
      .sort((a, b) => (scaled(a.px) < scaled(b.px) ? -1 : scaled(a.px) > scaled(b.px) ? 1 : 0))
      .slice(0, depth)
    const bid = bids[0]
    const ask = asks[0]
    const spread = bid && ask ? scaled(ask.px) - scaled(bid.px) : null
    const mid = bid && ask ? (scaled(ask.px) + scaled(bid.px)) / 2n : null
    return {
      ...this.envelope(config),
      coin: canonical,
      time: value.time,
      bids,
      asks,
      spreadPx: spread === null ? null : fixed(spread, 18).replace(/\.?0+$/, ""),
      midPx: mid === null ? null : fixed(mid, 18).replace(/\.?0+$/, ""),
      spreadBps: spread === null || mid === null || mid === 0n ? null : fixed((spread * 10_000n * ONE) / mid, 2),
    }
  }
  async candles(coin: string, opts: PerpsCandlesOptions = {}): Promise<PerpsCandlesResult> {
    this.key()
    const window = perpsCandleWindow(opts, this.now())
    const [config, located] = await Promise.all([this.config(), this.locate(coin)])
    const canonical = at(located.snapshot.universe, located.index).name
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "candleSnapshot",
      req: { coin: canonical, interval: window.interval, startTime: window.startTime, endTime: window.endTime },
    })
    if (!Array.isArray(value)) return unavailable()
    const candles: PerpsCandle[] = []
    for (const c of value) {
      if (
        !object(c) ||
        !integer(c.t) ||
        !integer(c.T) ||
        !integer(c.n) ||
        ![c.o, c.h, c.l, c.c, c.v].every((v) => nonnegative(v) !== null) ||
        c.s !== canonical ||
        c.i !== window.interval
      )
        return unavailable()
      if (c.t <= window.endTime && c.T >= window.startTime)
        candles.push({
          t: c.t,
          T: c.T,
          o: c.o as string,
          h: c.h as string,
          l: c.l as string,
          c: c.c as string,
          v: c.v as string,
          n: c.n,
        })
    }
    candles.sort((a, b) => a.t - b.t)
    return {
      ...this.envelope(config),
      coin: canonical,
      interval: window.interval,
      candles: candles.slice(-window.count),
    }
  }
  /** Phase 3 (BE-1817): hourly funding for one coin over a window of at most 30 days. */
  async fundingHistory(coin: string, opts: PerpsFundingHistoryOptions = {}): Promise<PerpsFundingHistoryResult> {
    this.key()
    const window = perpsFundingWindow(opts, this.now())
    const [config, located] = await Promise.all([this.config(), this.locate(coin)])
    const canonical = at(located.snapshot.universe, located.index).name
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "fundingHistory",
      coin: canonical,
      startTime: window.startTime,
      endTime: window.endTime,
    })
    return {
      ...this.envelope(config),
      coin: canonical,
      startTime: window.startTime,
      endTime: window.endTime,
      ...parsePerpsFundingHistory(value, canonical, window),
    }
  }
  /** Phase 3 (BE-1817): Hyperliquid's predicted next funding for every main-universe coin. */
  async predictedFunding(): Promise<PerpsPredictedFundingResult> {
    this.key()
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()])
    if (extras.predicted === null) return unavailable()
    const predicted: PerpsPredictedFundingRow[] = []
    for (const meta of core.universe) {
      const row = extras.predicted.get(meta.name)
      if (row)
        predicted.push({
          coin: meta.name,
          fundingRate: row.fundingRate,
          fundingAprPct: fixed(scaled(row.fundingRate) * 876_000n, 2),
          nextFundingTime: row.nextFundingTime,
        })
    }
    predicted.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0))
    return { ...this.envelope(config, extras.warnings, this.extrasCache?.at ?? this.now()), predicted }
  }
}
