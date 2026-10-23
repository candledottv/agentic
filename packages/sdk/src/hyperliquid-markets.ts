/** Public main-perp reads (Spec B, BE-1581). Self-contained; byte-copied to CLI and MCP.
 * No signing, relay or exchange calls. readHyperliquidMarkets is also the shared Spec A reader.
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
  }
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
  return { universe: meta.universe as unknown as PerpsMarketMeta[], ctxs: ctxs as PerpsAssetContext[], marginTables }
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
export async function readHyperliquidMarkets(
  fetcher: PerpsMarketFetch,
  network: PerpsMarketNetwork,
): Promise<PerpsMarketSnapshot> {
  return parseMarkets(await info(fetcher, network, { type: "metaAndAssetCtxs" }))
}
/** Mirrors resolvePerpsMarket, including its mid fallback and rounded-UP USD micros. */
export function perpsMarketGate(
  meta: Pick<PerpsMarketMeta, "isDelisted">,
  ctx: PerpsAssetContext,
  minOpenInterestUsd: number,
): {
  tradeable: boolean
  reason: null | "delisted" | "noPrice" | "minOpenInterest"
} {
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
function resolve(snapshot: PerpsMarketSnapshot, coin: string): number {
  if (/^[A-Za-z0-9]{1,20}$/.test(coin)) {
    const exact = snapshot.universe.findIndex((row) => row.name === coin)
    if (exact !== -1) return exact
    const matches = snapshot.universe
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => row.name.toLowerCase() === coin.toLowerCase())
    if (matches.length === 1) return at(matches, 0).i
  }
  throw new PerpsMarketError("PERPS_MARKET_NOT_FOUND", `${coin} is not a market on Hyperliquid's main perp exchange.`)
}
export type PerpsMarketSort = "volume" | "oi" | "funding" | "change" | "name"
export interface PerpsMarketsOptions {
  sort?: PerpsMarketSort
  limit?: number
  all?: boolean
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
  gate: { minOpenInterestUsd: number; source: "server" | "default" }
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
  candle: { tradeable: boolean | null; reason: null | "delisted" | "noPrice" | "minOpenInterest" | "networkMismatch" }
}
export interface PerpsMarketsResult extends PerpsMarketEnvelope {
  markets: PerpsMarketRow[]
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
  warnings: string[]
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
        return {
          minOpenInterestUsd: value.limits.minOpenInterestUsd,
          source: "server" as const,
          network: value.network,
          warnings: [],
        }
      } catch {
        return {
          minOpenInterestUsd: 1_000_000,
          source: "default" as const,
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
      gate: { minOpenInterestUsd: config.minOpenInterestUsd, source: config.source },
      warnings: [
        ...config.warnings,
        ...warnings,
        ...(mismatch ? ["Candle and client networks differ; tradeability is unknown."] : []),
      ],
    }
  }
  private row(core: PerpsMarketSnapshot, extras: MarketExtras, config: GateConfig, asset: number): PerpsMarketRow {
    const meta = at(core.universe, asset)
    const ctx = at(core.ctxs, asset)
    const mark = ctx.markPx == null ? null : scaled(ctx.markPx)
    const oi = ctx.openInterest == null ? null : scaled(ctx.openInterest)
    const prev = ctx.prevDayPx == null ? null : scaled(ctx.prevDayPx)
    const predicted = extras.predicted?.get(meta.name)
    return {
      coin: meta.name,
      asset,
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
      onlyIsolated: meta.onlyIsolated === true,
      isDelisted: meta.isDelisted === true,
      atOpenInterestCap: extras.cap?.has(meta.name) ?? null,
      candle:
        config.network !== undefined && config.network !== this.opts.network
          ? { tradeable: null, reason: "networkMismatch" }
          : perpsMarketGate(meta, ctx, config.minOpenInterestUsd),
    }
  }
  async markets(opts: PerpsMarketsOptions = {}): Promise<PerpsMarketsResult> {
    this.key()
    const sort = opts.sort ?? "volume"
    if (!["volume", "oi", "funding", "change", "name"].includes(sort))
      return usage("sort must be volume, oi, funding, change or name.")
    const limit = opts.limit === undefined ? undefined : bounded(opts.limit, 500, 1, 500, "limit")
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()])
    const rows = core.universe
      .map((_, asset) => this.row(core, extras, config, asset))
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
    return {
      ...this.envelope(config, extras.warnings, Math.max(this.coreCache?.at ?? 0, this.extrasCache?.at ?? 0)),
      markets: limit === undefined ? rows : rows.slice(0, limit),
    }
  }
  async market(coin: string): Promise<PerpsMarketResult> {
    this.key()
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()])
    const asset = resolve(core, coin)
    const meta = at(core.universe, asset)
    const ctx = at(core.ctxs, asset)
    return {
      ...this.envelope(config, extras.warnings, Math.max(this.coreCache?.at ?? 0, this.extrasCache?.at ?? 0)),
      market: {
        ...this.row(core, extras, config, asset),
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
    const [config, core] = await Promise.all([this.config(), this.core()])
    const canonical = at(core.universe, resolve(core, coin)).name
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
    const [config, core] = await Promise.all([this.config(), this.core()])
    const canonical = at(core.universe, resolve(core, coin)).name
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
    const [config, core] = await Promise.all([this.config(), this.core()])
    const canonical = at(core.universe, resolve(core, coin)).name
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
