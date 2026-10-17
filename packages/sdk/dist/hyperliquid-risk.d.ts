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
import { type PerpsMarketFetch, type PerpsMarketSnapshot } from "./hyperliquid-markets";
export type HyperliquidRiskNetwork = "mainnet" | "testnet";
/** Hyperliquid's public `/info` per network; equal to `HYPERLIQUID_INFO_URLS` in hyperliquid.ts (a test checks). */
export declare const HYPERLIQUID_RISK_INFO_URLS: Readonly<Record<HyperliquidRiskNetwork, string>>;
export interface PerpsRiskThresholds {
    /** A position is `warn` when its liquidation distance is under this (bps of the mark). */
    warnDistanceBps: number;
    /** A position is `critical` when its liquidation distance is under this. */
    criticalDistanceBps: number;
    /** The margin level is `warn` when the cross margin ratio is above this (bps; 10000 is liquidation). */
    warnMarginRatioBps: number;
    /** The margin level is `critical` when the cross margin ratio is above this. */
    criticalMarginRatioBps: number;
    /** `watch` only: how far past a threshold a level must move before it clears (bps). */
    clearBandBps: number;
}
/** What a key stores (`userApiKeys.perpsRisk`): any subset; an absent field takes the default. */
export type PerpsRiskSettings = Partial<PerpsRiskThresholds>;
export declare const PERPS_RISK_FIELDS: readonly ["warnDistanceBps", "criticalDistanceBps", "warnMarginRatioBps", "criticalMarginRatioBps", "clearBandBps"];
/**
 * The defaults (D1: suggestions until Andrew confirms them, overridable per key). The same values
 * live in `packages/db/convex/lib/perpsRiskPolicy.ts`; a test asserts the two are equal.
 */
export declare const HYPERLIQUID_RISK_DEFAULTS: Readonly<PerpsRiskThresholds>;
export type PerpsRiskThresholdsSource = "defaults" | "key" | "defaults (server did not report)";
export type PerpsRiskThresholdsReport = PerpsRiskThresholds & {
    source: PerpsRiskThresholdsSource;
};
/** Defaults overlaid by the stored fields. */
export declare function effectivePerpsRisk(stored: PerpsRiskSettings | null | undefined): PerpsRiskThresholds;
/**
 * Why an effective set cannot mean what it appears to, or null. The same rule as the Convex
 * policy's `validatePerpsRisk`: whole numbers; distances 1 to 9900; ratios 1 to 9999; critical
 * distance under warn distance; warn ratio under critical ratio; band 0 to 1000.
 */
export declare function perpsRiskProblem(t: PerpsRiskThresholds): string | null;
/**
 * The thresholds a `GET /keys/self/limits` answer gives this key: the server's effective set when it
 * reports one, else the stored fields over the defaults, else the defaults with the source saying
 * the server did not report (an API that predates `perpsRisk`, E6). Never a refusal.
 */
export declare function perpsRiskFromLimits(body: unknown): {
    thresholds: PerpsRiskThresholdsReport;
    stored: PerpsRiskSettings | null;
};
/** The fetch every read here takes; the same shape spec B's reader takes. */
export type HyperliquidInfoFetcher = PerpsMarketFetch;
/** A venue read that failed, timed out, or came back in a shape this engine does not know. */
export declare class HyperliquidReadError extends Error {
    readonly rateLimited: boolean;
    readonly code = "PERPS_READ_FAILED";
    constructor(message: string, rateLimited?: boolean);
}
export interface HyperliquidInfoOptions {
    /** Per-request timeout; 5 s like the server's reader. */
    timeoutMs?: number;
    /** How a 429 waits its one retry (1 s). Injected so tests run without real time. */
    sleep?: (ms: number) => Promise<void>;
}
/** One `/info` POST. A 429 is retried once after 1 s (E5); anything else that fails throws. */
export declare function hyperliquidInfo(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, body: Record<string, unknown>, opts?: HyperliquidInfoOptions): Promise<unknown>;
/** Hyperliquid's main perp universe and its contexts, as spec B's reader returns them. */
export type HyperliquidMarkets = PerpsMarketSnapshot;
/**
 * The shared `metaAndAssetCtxs` read (spec B's `readHyperliquidMarkets`), retried once after 1 s
 * (E5). That reader does not say why a read failed, so any failure is retried once, and a second
 * failure is `PERPS_READ_FAILED`. Watch's doubling back-off follows a 429 on the account read.
 */
export declare function readHyperliquidMarketSnapshot(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, opts?: HyperliquidInfoOptions): Promise<HyperliquidMarkets>;
/** The coin's mark price, or null when the coin is not in the universe or its mark is null or not positive (E3). */
export declare function hyperliquidMark(markets: HyperliquidMarkets, coin: string): string | null;
/** `clearinghouseState` for one address, shape-checked for every field the report reads. */
export declare function readHyperliquidClearinghouse(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, address: string, opts?: HyperliquidInfoOptions): Promise<HyperliquidClearinghouse>;
/** The account's abstraction mode (`default`, `disabled`, `unifiedAccount`, `portfolioMargin`, ...). */
export declare function readHyperliquidAccountMode(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, address: string, opts?: HyperliquidInfoOptions): Promise<string>;
/** The account modes whose perps collateral `clearinghouseState` describes (`perps-gate.ts`). */
export declare const HYPERLIQUID_STANDARD_MODES: readonly string[];
export interface HyperliquidPositionState {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    leverage: {
        type: string;
        value: number;
    };
    liquidationPx: string | null;
    marginUsed: string;
    cumFunding: {
        sinceOpen: string;
    };
}
export interface HyperliquidClearinghouse {
    marginSummary: {
        accountValue: string;
        totalMarginUsed: string;
    };
    crossMarginSummary: {
        accountValue: string;
        totalMarginUsed: string;
    };
    crossMaintenanceMarginUsed: string;
    withdrawable: string;
    positions: HyperliquidPositionState[];
}
export declare function parseClearinghouse(body: unknown): HyperliquidClearinghouse;
export type PerpsRiskLevel = "ok" | "warn" | "critical" | "unknown";
export type PerpsPositionLevel = "ok" | "warn" | "critical" | "none";
export type PerpsRiskReason = "PERPS_ACCOUNT_MODE" | "PERPS_READ_STALE" | "PERPS_READ_FAILED";
export interface PerpsPositionRow {
    coin: string;
    side: "long" | "short";
    size: string;
    entryPx: string;
    /** Null when the coin has no mark (E3, "unmarked"). */
    markPx: string | null;
    unrealizedPnlUsd: string;
    returnOnEquity: string;
    leverage: {
        value: number;
        type: string;
    };
    liquidationPx: string | null;
    /** `abs(mark - liquidation) / mark`, unrounded; null when either price is null. */
    liquidationDistance: number | null;
    /**
     * `cumFunding.sinceOpen`, Hyperliquid's sign: positive is funding the position PAID (verified
     * read-only on mainnet, 2026-10-17, against `userFunding`; E8). The opposite of `fundingUsd` in
     * the account's recent figures and in `candle pnl`, where positive is received.
     */
    fundingSinceOpenUsd: string;
    marginUsedUsd: string;
    positionValueUsd: string;
    /** This position alone; `none` when its distance is null. */
    level: PerpsPositionLevel;
}
export interface PerpsAccountLine {
    /** `marginSummary.accountValue`: cross plus isolated margin and isolated P&L. */
    accountValueUsd: string;
    /** `marginSummary.totalMarginUsed`, including isolated margin. */
    marginUsedUsd: string;
    /** `crossMarginSummary.accountValue`: the cross side only, the margin ratio's denominator. */
    crossAccountValueUsd: string;
    /** `accountValueUsd - marginUsedUsd`, floored at 0. An estimate; `withdrawableUsd` is what can leave. */
    freeMarginUsd: string;
    /** Hyperliquid's `withdrawable`, never derived from account value (I5). */
    withdrawableUsd: string;
    crossMaintenanceMarginUsedUsd: string;
    /** `crossMaintenanceMarginUsed / crossMarginSummary.accountValue`; liquidation at 1; 0 with no cross exposure; null only for E2. */
    marginRatio: number | null;
    unrealizedPnlUsd: string;
    positionCount: number;
    mode: string;
    level: PerpsRiskLevel;
}
export type PerpsRiskDriver = {
    kind: "position";
    coin: string;
    level: PerpsPositionLevel;
    liquidationDistance: number | null;
    threshold: number | null;
    reason?: "unmarked";
} | {
    kind: "margin";
    level: PerpsPositionLevel;
    marginRatio: number | null;
    threshold: number | null;
    reason?: "no equity";
};
export declare const PERPS_RISK_NOTE = "Phase 1 has no server-side monitor: nothing warns you unless you poll this or run candle perps watch.";
export interface PerpsRiskReport {
    schema: "candle.perps.risk/1";
    walletId: string;
    address: string;
    network: HyperliquidRiskNetwork;
    mode: string | null;
    /** The earlier of the reads' local completion times. */
    readAt: string;
    level: PerpsRiskLevel;
    reason: PerpsRiskReason | null;
    drivers: PerpsRiskDriver[];
    /** At `ok`, the driver nearest to warn; otherwise null. */
    closest: PerpsRiskDriver | null;
    thresholds: PerpsRiskThresholdsReport;
    /** Null when no level could be computed from the data (`unknown`). */
    account: PerpsAccountLine | null;
    positions: PerpsPositionRow[];
    note: string;
}
export interface PerpsRiskIdentity {
    walletId: string;
    address: string;
    network: HyperliquidRiskNetwork;
}
/**
 * The pure rule (A-5): one report from one read, no memory. `market` is spec B's market snapshot,
 * `state` is `clearinghouseState` (raw or parsed). A mode outside `default` and `disabled`
 * gives `unknown` with `PERPS_ACCOUNT_MODE` and no level from the data (A-7).
 */
export declare function hyperliquidRiskReport(state: unknown, market: HyperliquidMarkets, mode: string, thresholds: PerpsRiskThresholdsReport, now: number, identity?: PerpsRiskIdentity): PerpsRiskReport;
/** A report with no level: a failed or stale read (I4). */
export declare function unknownRiskReport(identity: PerpsRiskIdentity, thresholds: PerpsRiskThresholdsReport, reason: PerpsRiskReason, now: number, mode?: string | null): PerpsRiskReport;
/** Two halves completing further apart than this yield no level (design 4, A-8). */
export declare const PERPS_RISK_STALE_MS = 30000;
export interface ReadPerpsRiskOptions extends HyperliquidInfoOptions {
    fetcher: HyperliquidInfoFetcher;
    network: HyperliquidRiskNetwork;
    walletId: string;
    address: string;
    thresholds: PerpsRiskThresholdsReport;
    now: () => number;
    /** A mode already read (watch reads it every 5 minutes); omitted, it is read with the rest. */
    mode?: string;
}
/**
 * The A-8 read: `clearinghouseState`, `metaAndAssetCtxs` and (unless given) `userAbstraction` in
 * parallel, then the pure rule. Halves completing more than 30 s apart are `PERPS_READ_STALE`.
 * A failed read throws `HyperliquidReadError`; callers turn it into `PERPS_READ_FAILED`.
 */
export declare function readPerpsRisk(opts: ReadPerpsRiskOptions): Promise<PerpsRiskReport>;
/** The exit code a level carries (A-8): 0 ok, 10 warn, 11 critical, 1 for unknown. */
export declare function perpsRiskExitCode(level: PerpsRiskLevel): 0 | 1 | 10 | 11;
export interface PerpsRecentFigures {
    /** Epoch ms. */
    startTime: number;
    endTime: number;
    /** Sum of `closedPnl` over main-perp fills in the window. */
    realizedPnlUsd: string;
    /** Venue fees, builder fees included; negative is a rebate. */
    feesUsd: string;
    /** Positive is received, negative is paid. */
    fundingUsd: string;
    fills: number;
    fundingPayments: number;
    /** Hyperliquid's response cap was hit (2,000 fills or 500 funding rows): the figures are partial. */
    truncated: boolean;
}
export declare const PERPS_FILLS_RESPONSE_CAP = 2000;
export declare const PERPS_FUNDING_RESPONSE_CAP = 500;
export declare const PERPS_RECENT_MAX_MS: number;
/** Main perps only: not a builder dex (`dex:COIN`), not spot (`@n` or `A/B`); the P&L section's filter. */
export declare function isMainPerpCoin(coin: unknown): boolean;
export declare function readPerpsRecent(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, address: string, window: {
    startTime: number;
    endTime: number;
}, opts?: HyperliquidInfoOptions): Promise<PerpsRecentFigures>;
export declare function summarizePerpsRecent(fills: unknown, funding: unknown, window: {
    startTime: number;
    endTime: number;
}): PerpsRecentFigures;
/** `candle perps account --json` and `perpsAccount()` (A-10). */
export interface PerpsAccountReport extends PerpsAccountLineFields {
    schema: "candle.perps.account/1";
    walletId: string;
    address: string;
    network: HyperliquidRiskNetwork;
    mode: string | null;
    readAt: string;
    recent: PerpsRecentFigures;
    risk: {
        level: PerpsRiskLevel;
        reason: PerpsRiskReason | null;
        drivers: PerpsRiskDriver[];
    };
}
type PerpsAccountLineFields = Partial<Omit<PerpsAccountLine, "mode" | "level">>;
/** One report plus the recent window, in the A-10 shape. */
export declare function perpsAccountReport(report: PerpsRiskReport, recent: PerpsRecentFigures): PerpsAccountReport;
/**
 * Whether every measured position and the margin ratio sit inclusively past `level`'s thresholds by
 * the band: distance `>=` threshold + band, ratio `<=` threshold - band. A null distance never
 * blocks (E1); an unmarked position blocks leaving `warn` (E3), since it holds the level there.
 */
export declare function perpsRiskClears(report: PerpsRiskReport, leaving: "warn" | "critical"): boolean;
/**
 * One watch step: the level after `report`, given the level before it. Rising is immediate (the pure
 * rule). Falling goes in one poll to the lowest level whose clear condition holds, so `critical` may
 * go straight to `ok`; if none holds, the level stays. From `unknown` (start, or after a stale
 * read) the pure rule decides, with no band. A one-shot `risk` never calls this.
 */
export declare function perpsRiskStep(previous: PerpsRiskLevel, report: PerpsRiskReport): PerpsRiskLevel;
export type PerpsWatchEvent = {
    event: "start";
    walletId: string;
    address: string;
    network: HyperliquidRiskNetwork;
    at: string;
    intervalSeconds: number;
    heartbeatSeconds: number;
    thresholds: PerpsRiskThresholdsReport;
    /** Hyperliquid request weight one watcher spends per minute at this interval (of 1,200 per IP). */
    weightPerMinute: number;
} | (Omit<PerpsRiskReport, "level"> & {
    event: "level";
    level: PerpsRiskLevel;
    /** What the pure rule says for this read; `level` is held by hysteresis. */
    ruleLevel: PerpsRiskLevel;
    previous: PerpsRiskLevel;
    cleared?: true;
}) | (Omit<PerpsRiskReport, "level"> & {
    event: "heartbeat";
    level: PerpsRiskLevel;
    ruleLevel: PerpsRiskLevel;
}) | {
    event: "error";
    at: string;
    code: string;
    message: string;
    nextPollSeconds: number;
};
export declare const PERPS_WATCH_DEFAULT_INTERVAL_MS = 10000;
export declare const PERPS_WATCH_MIN_INTERVAL_MS = 5000;
export declare const PERPS_WATCH_MAX_INTERVAL_MS = 300000;
export declare const PERPS_WATCH_DEFAULT_HEARTBEAT_MS = 60000;
/** Thresholds and the account mode are re-read this often (I8: Candle is called at start and then every 5 minutes). */
export declare const PERPS_WATCH_REFRESH_MS = 300000;
/**
 * Hyperliquid's weights (rate-limit page, read 2026-10-17): `clearinghouseState` 2; `metaAndAssetCtxs`
 * and `userAbstraction` are not named there, so they take the default 20. A poll is the first two;
 * the mode is read every 5 minutes.
 */
export declare const HYPERLIQUID_INFO_WEIGHTS: {
    readonly clearinghouseState: 2;
    readonly metaAndAssetCtxs: 20;
    readonly userAbstraction: 20;
};
export declare function perpsWatchWeightPerMinute(intervalMs: number): number;
export interface WatchPerpsRiskOptions {
    fetcher: HyperliquidInfoFetcher;
    network: HyperliquidRiskNetwork;
    walletId: string;
    address: string;
    /** Called at start and every 5 minutes; a failed re-read keeps the last (A-9). */
    thresholds: () => Promise<PerpsRiskThresholdsReport>;
    intervalMs?: number;
    /** 0 turns heartbeats off. */
    heartbeatMs?: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    /** Return at the first level change after the first reading, with that level. */
    onceLevelChange?: boolean;
    onEvent: (event: PerpsWatchEvent) => void | Promise<void>;
}
/**
 * The loop `candle perps watch` wraps, and an always-on bot can run as is. Polls until `signal`
 * aborts (or the first change with `onceLevelChange`) and resolves with the last known level.
 */
export declare function watchPerpsRisk(opts: WatchPerpsRiskOptions): Promise<{
    level: PerpsRiskLevel;
}>;
export interface PerpsPortfolioAccount {
    address: string;
    label?: string;
    walletId?: string;
    accountValueUsd: string;
    unrealizedPnlUsd: string;
    positionCount: number;
    /** At the default thresholds (portfolio is account-wide; thresholds are per key). */
    level: PerpsRiskLevel;
}
export type PerpsPortfolioSection = {
    read: true;
    network: HyperliquidRiskNetwork;
    /** Accounts with a position or a non-zero account value. */
    accounts: PerpsPortfolioAccount[];
    /** Sum of the total (`marginSummary`) account value and unrealized P&L of the accounts read. */
    subtotal: {
        accountValueUsd: string;
        unrealizedPnlUsd: string;
    };
    /** Read, holding nothing on Hyperliquid: counted, not listed. */
    empty: number;
    /** Not read: a failed read, or past the 100-address cap. Never zero. */
    unread: {
        address: string;
        label?: string;
        walletId?: string;
        reason: string;
    }[];
    thresholds: "defaults";
} | {
    read: false;
    reason: string;
};
export declare const PERPS_PORTFOLIO_MAX_ACCOUNTS = 100;
/**
 * One shared `metaAndAssetCtxs`, then `clearinghouseState` per address, at most 8 in flight and at
 * most 100 addresses. Every level is at the defaults. A failed market read leaves the whole section
 * unread; a failed account read leaves that account unread. Not added to any portfolio total (D4).
 */
export declare function perpsPortfolioSection(fetcher: HyperliquidInfoFetcher, network: HyperliquidRiskNetwork, wallets: readonly {
    address: string;
    label?: string;
    walletId?: string;
}[], opts?: HyperliquidInfoOptions & {
    now?: () => number;
}): Promise<PerpsPortfolioSection>;
export {};
//# sourceMappingURL=hyperliquid-risk.d.ts.map