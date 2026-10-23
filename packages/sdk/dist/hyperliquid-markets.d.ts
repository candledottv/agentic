/** Public main-perp reads (Spec B, BE-1581). Self-contained; byte-copied to CLI and MCP.
 * No signing, relay or exchange calls. readHyperliquidMarkets is also the shared Spec A reader.
 */
export type PerpsMarketNetwork = "mainnet" | "testnet";
export type PerpsMarketFetch = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;
export declare class PerpsMarketError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, message: string);
}
export interface PerpsMarketMeta {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated?: boolean;
    isDelisted?: boolean;
    marginTableId?: number;
}
export interface PerpsAssetContext {
    markPx?: string | null;
    midPx?: string | null;
    oraclePx?: string | null;
    openInterest?: string | null;
    funding?: string | null;
    dayNtlVlm?: string | null;
    prevDayPx?: string | null;
    premium?: string | null;
    impactPxs?: [string, string] | null;
}
export interface PerpsMarginTier {
    lowerBoundUsd: string;
    maxLeverage: number;
}
export interface PerpsMarketSnapshot {
    universe: PerpsMarketMeta[];
    ctxs: PerpsAssetContext[];
    marginTables: Map<number, PerpsMarginTier[]>;
}
export declare function readHyperliquidMarkets(fetcher: PerpsMarketFetch, network: PerpsMarketNetwork): Promise<PerpsMarketSnapshot>;
/** Mirrors resolvePerpsMarket, including its mid fallback and rounded-UP USD micros. */
export declare function perpsMarketGate(meta: Pick<PerpsMarketMeta, "isDelisted">, ctx: PerpsAssetContext, minOpenInterestUsd: number): {
    tradeable: boolean;
    reason: null | "delisted" | "noPrice" | "minOpenInterest";
};
export type PerpsMarketSort = "volume" | "oi" | "funding" | "change" | "name";
export interface PerpsMarketsOptions {
    sort?: PerpsMarketSort;
    limit?: number;
    all?: boolean;
}
export interface PerpsBookOptions {
    depth?: number;
    sigFigs?: number;
}
export interface PerpsFundingHistoryOptions {
    /** ISO 8601 time or epoch milliseconds; default 24 hours before `end`. */
    start?: string | number;
    /** ISO 8601 time or epoch milliseconds; default now. */
    end?: string | number;
}
export interface PerpsCandlesOptions {
    interval?: string;
    count?: number;
    end?: string | number;
}
export declare const PERPS_CANDLE_INTERVALS: readonly ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"];
export declare function perpsCandleWindow(opts: PerpsCandlesOptions, now: number): {
    interval: string;
    count: number;
    startTime: number;
    endTime: number;
};
export declare const PERPS_FUNDING_HISTORY_MAX_MS: number;
export declare const PERPS_FUNDING_HISTORY_MAX_ROWS = 500;
/** Phase 3 (BE-1817): a funding-history window, at most 30 days, ending no later than now. */
export declare function perpsFundingWindow(opts: PerpsFundingHistoryOptions, now: number): {
    startTime: number;
    endTime: number;
};
export interface PerpsMarketEnvelope {
    success: true;
    network: PerpsMarketNetwork;
    readAt: number;
    gate: {
        minOpenInterestUsd: number;
        source: "server" | "default";
    };
    warnings: string[];
}
export interface PerpsMarketRow {
    coin: string;
    asset: number;
    markPx: string | null;
    oraclePx: string | null;
    midPx: string | null;
    fundingRate: string | null;
    fundingAprPct: string | null;
    predictedFundingRate: string | null;
    nextFundingTime: number | null;
    openInterest: string | null;
    openInterestUsd: string | null;
    dayNotionalVolumeUsd: string | null;
    prevDayPx: string | null;
    change24hPct: string | null;
    maxLeverage: number;
    onlyIsolated: boolean;
    isDelisted: boolean;
    atOpenInterestCap: boolean | null;
    candle: {
        tradeable: boolean | null;
        reason: null | "delisted" | "noPrice" | "minOpenInterest" | "networkMismatch";
    };
}
export interface PerpsMarketsResult extends PerpsMarketEnvelope {
    markets: PerpsMarketRow[];
}
export interface PerpsMarketResult extends PerpsMarketEnvelope {
    market: PerpsMarketRow & {
        szDecimals: number;
        maxPriceDecimals: number;
        priceRule: string;
        minOrderUsd: number;
        impactBidPx: string | null;
        impactAskPx: string | null;
        premium: string | null;
        marginTiers: PerpsMarginTier[];
    };
}
export interface PerpsBookLevel {
    px: string;
    sz: string;
    n: number;
}
export interface PerpsBookResult extends PerpsMarketEnvelope {
    coin: string;
    time: number;
    bids: PerpsBookLevel[];
    asks: PerpsBookLevel[];
    spreadPx: string | null;
    spreadBps: string | null;
    midPx: string | null;
}
export interface PerpsCandle {
    t: number;
    T: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    n: number;
}
export interface PerpsCandlesResult extends PerpsMarketEnvelope {
    coin: string;
    interval: string;
    candles: PerpsCandle[];
}
export interface PerpsFundingPoint {
    time: number;
    fundingRate: string;
    fundingAprPct: string;
    premium: string;
}
export interface PerpsFundingHistoryResult extends PerpsMarketEnvelope {
    coin: string;
    startTime: number;
    endTime: number;
    funding: PerpsFundingPoint[];
    /** True when the window held more than 500 rows; the earliest 500 are returned. */
    truncated: boolean;
}
export interface PerpsPredictedFundingRow {
    coin: string;
    fundingRate: string;
    fundingAprPct: string;
    nextFundingTime: number;
}
export interface PerpsPredictedFundingResult extends PerpsMarketEnvelope {
    predicted: PerpsPredictedFundingRow[];
}
/** Hyperliquid `fundingHistory` rows for `coin`, oldest first, within the window. */
export declare function parsePerpsFundingHistory(value: unknown, coin: string, window: {
    startTime: number;
    endTime: number;
}): {
    funding: PerpsFundingPoint[];
    truncated: boolean;
};
export interface PerpsMarketReaderOptions {
    apiKey?: string;
    network: PerpsMarketNetwork;
    fetcher: PerpsMarketFetch;
    readConfig: () => Promise<unknown>;
    /** SDK/local MCP: 5000. CLI: 0. Cache lifetime starts on completion, never caches core failures. */
    cacheMs?: number;
    now?: () => number;
}
/** One instance per SDK client / local MCP configuration; CLI constructs one per invocation. */
export declare class PerpsMarketReader {
    private readonly opts;
    private configPromise?;
    private coreCache?;
    private extrasCache?;
    private corePending?;
    private extrasPending?;
    private readonly now;
    constructor(opts: PerpsMarketReaderOptions);
    private key;
    private config;
    private core;
    private extras;
    private envelope;
    private row;
    markets(opts?: PerpsMarketsOptions): Promise<PerpsMarketsResult>;
    market(coin: string): Promise<PerpsMarketResult>;
    book(coin: string, opts?: PerpsBookOptions): Promise<PerpsBookResult>;
    candles(coin: string, opts?: PerpsCandlesOptions): Promise<PerpsCandlesResult>;
    /** Phase 3 (BE-1817): hourly funding for one coin over a window of at most 30 days. */
    fundingHistory(coin: string, opts?: PerpsFundingHistoryOptions): Promise<PerpsFundingHistoryResult>;
    /** Phase 3 (BE-1817): Hyperliquid's predicted next funding for every main-universe coin. */
    predictedFunding(): Promise<PerpsPredictedFundingResult>;
}
//# sourceMappingURL=hyperliquid-markets.d.ts.map