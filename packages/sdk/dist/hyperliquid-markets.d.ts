/** Public perp market reads (Spec B, BE-1581). Self-contained; byte-copied to CLI and MCP.
 * No signing, relay or exchange calls. readHyperliquidMarkets is also the shared Spec A reader.
 *
 * BE-3755 (Hyperliquid HM1): builder-deployed (HIP-3) perp dexes. A builder market is named
 * `dex:COIN` (`xyz:TSLA`), lives in its own dex's universe (`metaAndAssetCtxs` with a `dex`), and
 * takes the asset id `100000 + perp_dex_index * 10000 + index_in_meta` (Hyperliquid's asset-id doc,
 * pinned by `__fixtures__/hyperliquid-markets/builder-dex.json`). Main-exchange names and reads are
 * unchanged.
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
    /** Builder dexes: `noCross` or `strictIsolated` mean isolated margin only. */
    marginMode?: string;
    /** Builder dexes: the deployer's fee share, a decimal (1.0 = 100% of the protocol fee). */
    deployerFeeScale?: string;
    /** Builder dexes: `enabled` when growth mode cuts the all-in fee by 90%. */
    growthMode?: string;
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
    /** The dex's collateral, a spot token index (0 is USDC). Absent from older answers: USDC. */
    collateralToken?: number;
}
/** One builder dex from `perpDexs`. Index 0 of that list is the main exchange (null), never a dex. */
export interface PerpsDex {
    /** `perp_dex_index`: the position in Hyperliquid's `perpDexs` answer, from 1. */
    index: number;
    name: string;
    fullName: string;
    deployer: string;
    /** The address that posts oracle prices, or null when the deployer (or a setOracle delegate) does. */
    oracleUpdater: string | null;
    /** Every address allowed to set this dex's oracle price: the updater, setOracle delegates, else the deployer. */
    oracleSetters: string[];
}
/**
 * Split a market name: `BTC` is the main exchange (dex ""), `xyz:TSLA` is builder dex `xyz`. The dex
 * folds to lower case (Hyperliquid's dex names are lower case); the coin keeps its case. Null for
 * anything else: an empty part, a second colon, a space, a slash, over-long parts.
 */
export declare function parsePerpsCoin(coin: unknown): {
    dex: string;
    coin: string;
} | null;
/** A dex filter: "" (main), a builder dex name (lower-cased), or null when malformed. */
export declare function parsePerpsDex(dex: unknown): string | null;
/** Hyperliquid's asset id: the meta index on the main exchange, `100000 + dex * 10000 + i` on a builder dex. */
export declare function perpsAssetId(dexIndex: number, indexInMeta: number): number;
/** Isolated-only when the market says so, or its margin mode forbids cross. */
export declare function perpsMarginMode(meta: Pick<PerpsMarketMeta, "onlyIsolated" | "marginMode">): "cross" | "isolated";
export declare function perpsCollateralName(token: number): string;
/** Hyperliquid's base-tier perp fees, in percent: what `feeMultiplier` scales. */
export declare const PERPS_MAIN_TAKER_FEE_PCT = "0.045";
export declare const PERPS_MAIN_MAKER_FEE_PCT = "0.015";
/** BE-3755 (decisions doc section 6, settled call 2): warn when a market's fee is above 2x the main exchange's. */
export declare const PERPS_FEE_WARNING_MULTIPLIER = 2;
/**
 * A builder market's fee as a multiple of the main exchange's fee at the same tier (Hyperliquid fee
 * doc): a deployer share `s` up to 1 adds `s` to the protocol fee (1 + s); above 1 the protocol fee
 * rises to match it (2s); growth mode cuts the all-in fee by 90%. The main exchange is 1. Exact
 * decimal (18 places, trailing zeros trimmed).
 */
export declare function perpsFeeMultiplier(meta: Pick<PerpsMarketMeta, "deployerFeeScale" | "growthMode">, dex: string): string;
/** The terms a client shows before every order on a market (BE-3755, scope 4). */
export interface PerpsDexTerms {
    /** "" on Hyperliquid's main perp exchange, else the builder dex (`xyz`). */
    dex: string;
    dexName: string | null;
    /** The builder dex's deployer; null on the main exchange (validator-operated). */
    deployer: string | null;
    /** `validators` on the main exchange; `deployer` on a builder dex, with the addresses that may set it. */
    oracleSource: "validators" | "deployer";
    oracleSetters: string[];
    marginMode: "cross" | "isolated";
    collateral: string;
    /** Fee as a multiple of the main exchange's fee at the same tier, before Candle's builder fee. */
    feeMultiplier: string;
    takerFeePct: string;
    makerFeePct: string;
    /** Set when the fee is above 2x the main exchange's; never a refusal. */
    feeWarning: string | null;
}
export declare function perpsDexTerms(meta: PerpsMarketMeta, dex: PerpsDex | null, collateralToken: number): PerpsDexTerms;
/** Parse `perpDexs`: entry 0 is null (the main exchange); every other entry is a builder dex. */
export declare function parsePerpDexs(value: unknown): PerpsDex[];
export declare function readHyperliquidPerpDexs(fetcher: PerpsMarketFetch, network: PerpsMarketNetwork): Promise<PerpsDex[]>;
/** One dex's universe: the main exchange when `dex` is "" (the unchanged wire body), else that builder dex. */
export declare function readHyperliquidMarkets(fetcher: PerpsMarketFetch, network: PerpsMarketNetwork, dex?: string): Promise<PerpsMarketSnapshot>;
/** Mirrors resolvePerpsMarket, including its mid fallback and rounded-UP USD micros. */
export type PerpsMarketGateReason = null | "delisted" | "noPrice" | "minOpenInterest" | "collateral" | "dexOpensRefused";
/**
 * BE-3755: on a builder dex, a collateral other than USDC refuses (until Hyperliquid spot, HM2), and
 * the operations kill switch refuses new opens on a named dex. The floor applies on every dex.
 */
export declare function perpsMarketGate(meta: Pick<PerpsMarketMeta, "isDelisted">, ctx: PerpsAssetContext, minOpenInterestUsd: number, dex?: {
    name: string;
    collateralToken: number;
    opensRefused: readonly string[];
}): {
    tradeable: boolean;
    reason: PerpsMarketGateReason;
};
export type PerpsMarketSort = "volume" | "oi" | "funding" | "change" | "name";
export interface PerpsMarketsOptions {
    sort?: PerpsMarketSort;
    limit?: number;
    all?: boolean;
    /** BE-3755: "" or absent for the main exchange (unchanged), a builder dex name (`xyz`), or `all` for every dex. */
    dex?: string;
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
        dexOpensRefused?: string[];
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
        reason: PerpsMarketGateReason | "networkMismatch";
    };
    /** BE-3755: "" on the main exchange, else the builder dex. */
    dex: string;
    /** BE-3755: what a client shows before an order on this market (dex, oracle, deployer, margin, fee). */
    terms: PerpsDexTerms;
}
export interface PerpsMarketsResult extends PerpsMarketEnvelope {
    markets: PerpsMarketRow[];
    /** BE-3755: the builder dexes, when the list was asked with `dex`. */
    dexes?: (PerpsDex & {
        collateral: string | null;
        tradeable: boolean | null;
    })[];
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
    private readonly dexCache;
    private readonly dexPending;
    private dexesCache?;
    private dexesPending?;
    private readonly now;
    constructor(opts: PerpsMarketReaderOptions);
    private key;
    private config;
    private core;
    /** BE-3755: one builder dex's universe, cached like the main one. */
    private dexCore;
    /** BE-3755: the builder dexes (`perpDexs`). */
    private dexes;
    /** The named builder dex, or PERPS_MARKET_NOT_FOUND. */
    private dex;
    /** Find a market by name on its dex: `BTC` on the main exchange, `xyz:TSLA` on builder dex xyz. */
    private locate;
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