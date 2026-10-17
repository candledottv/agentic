export type PerpsHistoryKind = "fills" | "funding";
export type PerpsHistoryNetwork = "mainnet" | "testnet";
/** Hyperliquid's public `/info` endpoint per network. Mirrors `HYPERLIQUID_INFO_URLS`. */
export declare const PERPS_HISTORY_INFO_URLS: Readonly<Record<PerpsHistoryNetwork, string>>;
/** Rows a page holds when the caller names no limit. */
export declare const PERPS_HISTORY_DEFAULT_LIMIT = 100;
/** The most rows one upstream response carries, and so the largest page: 2,000 fills, 500 funding rows. */
export declare const PERPS_HISTORY_MAX_LIMIT: Readonly<Record<PerpsHistoryKind, number>>;
/** The default window: the seven days before `endTime`. */
export declare const PERPS_HISTORY_DEFAULT_WINDOW_MS: number;
/** Upstream history requests one call may make before it stops with a resumable cursor. */
export declare const PERPS_HISTORY_REQUEST_BUDGET = 10;
/** Hyperliquid serves only an account's 10,000 most recent fills; a cursor chain scans no more. */
export declare const PERPS_HISTORY_FILL_RETENTION = 10000;
/** The longest cursor accepted, in characters. */
export declare const PERPS_HISTORY_MAX_CURSOR_LENGTH = 200000;
/** How long one upstream request may take. */
export declare const PERPS_HISTORY_TIMEOUT_MS = 15000;
export interface PerpsHistoryOptions {
    /** Inclusive epoch milliseconds. Default: seven days before `endTime`. */
    startTime?: number;
    /** Inclusive epoch milliseconds. Default: the first call's clock. */
    endTime?: number;
    /** Rows per page. Default 100; at most 2,000 for fills and 500 for funding. */
    limit?: number;
    /** `nextCursor` from the previous page. Other options, when given, must match it. */
    cursor?: string;
}
export interface PerpsHistoryWarning {
    code: "PERPS_HISTORY_RETENTION_LIMIT" | "PERPS_HISTORY_PAGE_BUDGET" | "PERPS_HISTORY_BOUNDARY_LIMIT";
    message: string;
}
/** One fill exactly as Hyperliquid reports it; decimal values stay strings. */
export type PerpsFillRow = Record<string, unknown> & {
    coin: string;
    time: number;
    tid: number;
    oid: number;
    px: string;
    sz: string;
    side: string;
    dir?: string;
    closedPnl: string;
    /** Already includes `builderFee`; never subtract the builder fee again. */
    fee: string;
    feeToken?: string;
    builderFee?: string;
};
/** One funding payment exactly as Hyperliquid reports it. `delta.usdc` is signed: negative is paid. */
export type PerpsFundingRow = Record<string, unknown> & {
    time: number;
    hash: string;
    delta: Record<string, unknown> & {
        coin: string;
        usdc: string;
        fundingRate: string;
        szi: string;
    };
};
interface PageBase {
    success: true;
    walletId: string;
    address: string;
    network: PerpsHistoryNetwork;
    source: "hyperliquid";
    /** When this page was read, epoch milliseconds. */
    readAt: number;
    startTime: number;
    endTime: number;
    /** Pass back as `cursor` for the next page; null when the window is read to its end. */
    nextCursor: string | null;
    hasMore: boolean;
    /** True when coverage stopped short of the window for a venue or budget limit, not for paging. */
    truncated: boolean;
    warnings: PerpsHistoryWarning[];
}
export type PerpsFillsPage = PageBase & {
    fills: PerpsFillRow[];
};
export type PerpsFundingPage = PageBase & {
    funding: PerpsFundingRow[];
};
/** A refusal or an upstream failure. `code` is `VALIDATION_FAILED` or `PERPS_UNAVAILABLE`. */
export declare class PerpsHistoryError extends Error {
    readonly code: "VALIDATION_FAILED" | "PERPS_UNAVAILABLE";
    readonly extra: {
        field?: string;
        retryable?: boolean;
        retryAfterMs?: number;
    };
    constructor(code: "VALIDATION_FAILED" | "PERPS_UNAVAILABLE", message: string, extra?: {
        field?: string;
        retryable?: boolean;
        retryAfterMs?: number;
    });
}
export type PerpsHistoryFetch = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    headers?: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
}>;
export interface PerpsHistoryRequest {
    kind: PerpsHistoryKind;
    network: PerpsHistoryNetwork;
    walletId: string;
    /** The wallet's EVM address: the Hyperliquid account. */
    address: string;
    options?: PerpsHistoryOptions;
    fetch: PerpsHistoryFetch;
    now: () => number;
}
/**
 * Read one page. Validation runs before any request, so a bad bound, limit or cursor makes no I/O.
 * A rate limit, a timeout, a malformed answer or an unreadable market list throws `PERPS_UNAVAILABLE`
 * and the caller's cursor stays good for a retry; nothing is ever reported as an empty success.
 */
export declare function readPerpsHistoryPage(req: PerpsHistoryRequest): Promise<PerpsFillsPage | PerpsFundingPage>;
/** Money for a table: two decimals, sign kept. JSON keeps the venue's exact strings. */
export declare function perpsHistoryMoney(value: unknown): string;
/** The human lines for one page: wallet, UTC window, rows, then how to read the next page. */
export declare function perpsHistoryLines(page: PerpsFillsPage | PerpsFundingPage, nextHint: (cursor: string) => string): string[];
export {};
//# sourceMappingURL=perps-history.d.ts.map