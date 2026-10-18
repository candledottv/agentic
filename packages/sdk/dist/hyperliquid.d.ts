export type HyperliquidNetwork = "mainnet" | "testnet";
/** The L1 action types a Candle build may carry. Anything else is refused before signing. */
export declare const HYPERLIQUID_ALLOWED_ACTION_TYPES: readonly ["order", "cancel", "modify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel"];
/** Hyperliquid's `/exchange` endpoint per network. The client never takes this from the server. */
export declare const HYPERLIQUID_EXCHANGE_URLS: Readonly<Record<HyperliquidNetwork, string>>;
/** Hyperliquid's public `/info` endpoint per network. */
export declare const HYPERLIQUID_INFO_URLS: Readonly<Record<HyperliquidNetwork, string>>;
/**
 * Candle's public builder, confirmed by Andrew on BE-1583 on 2026-10-17 (decision 6a).
 * Rotation requires a reviewed client release; the API cannot replace this trust anchor.
 */
export declare const CANDLE_HYPERLIQUID_BUILDER_ADDRESS = "0xc43ff1f6ad9f93fc94558e07c2071b8458e7470b";
/** Resolve only local trust anchors. An explicit invalid override never falls back to the pin. */
export declare function resolveHyperliquidBuilder(override?: string, releasePin?: string | null): string;
/** The builder fee Candle charges at most, in tenths of a basis point (0.1%), and as setup signs it. */
export declare const HYPERLIQUID_MAX_BUILDER_FEE_TENTHS_BPS = 100;
export declare const HYPERLIQUID_MAX_BUILDER_FEE_RATE = "0.1%";
/** `signatureChainId` for the ApproveBuilderFee domain (chain id 42161). */
export declare const HYPERLIQUID_SIGNATURE_CHAIN_ID = "0xa4b1";
/** Python `msgpack.packb(value)` for the JSON-like values an action uses. Throws on anything else. */
export declare function msgpackEncode(value: unknown): Uint8Array;
/** The official SDK's `action_hash(action, None, nonce, None)`, as `0x` + 64 hex. */
export declare function hyperliquidActionHash(action: unknown, nonce: number | bigint): string;
export interface HyperliquidTypedData {
    domain: Record<string, unknown>;
    types: Record<string, {
        name: string;
        type: string;
    }[]>;
    primary_type: string;
    message: Record<string, unknown>;
}
export declare function hyperliquidL1TypedData(connectionId: string, network: HyperliquidNetwork): HyperliquidTypedData;
export declare function hyperliquidApproveBuilderFeeTypedData(builder: string, nonce: number): HyperliquidTypedData;
/**
 * Deterministic JSON with object keys sorted by UTF-16 code unit at every level: RFC 8785 for the
 * values a typed-data relay body holds (strings, safe integers, booleans, arrays, objects). Used to
 * compare two values structurally, and as the payload a Privy authorization signature covers.
 */
export declare function hyperliquidCanonicalJson(value: unknown): string;
/** The part of a Candle perps build response the check reads. */
export interface PerpsBuildToVerify {
    network?: string;
    nonce: number;
    action: Record<string, unknown>;
    typedData: HyperliquidTypedData;
    address?: string;
}
export interface VerifyPerpsBuildOptions {
    /** The network this client trades on. Default mainnet. */
    network?: HyperliquidNetwork;
    /**
     * Candle's builder address, as this client knows it independently of the build. Orders must
     * name exactly this builder (or none), and setup must approve exactly it.
     */
    builder: string;
    /** The wallet address this client expects to act for, when it knows it. */
    address?: string;
    closeOrder?: {
        asset: number;
        isBuy: boolean;
        size: string;
    };
    /**
     * Phase 1 D (spec 2026-10-17 D, section 4): the venue order a targeted cancel must name, read from
     * Hyperliquid by this client (`hyperliquidCancelTarget`).
     */
    cancelTarget?: {
        asset: number;
        oid: number;
    };
    /** Phase 1 D: the held position a take-profit / stop-loss attach protects, read from Hyperliquid. */
    tpslTarget?: {
        asset: number;
        isBuy: boolean;
        size: string;
        markPx: string;
    };
    /** Phase 1 D: an isolated top-up's market, where Hyperliquid shows an isolated position. */
    marginTarget?: {
        asset: number;
    };
    /**
     * Phase 1 D: a leverage or margin-mode change's market and the account's setting there, read from
     * Hyperliquid. `flat`: no position and no resting order in the coin, which a mode change needs.
     */
    leverageTarget?: {
        asset: number;
        leverage: number;
        mode: "cross" | "isolated";
        flat: boolean;
    };
    /** Phase 1 D: this client's clock, for a scheduled cancel's time. */
    clock?: {
        now: number;
    };
    /**
     * Phase 1 D, section 9: the key's reduce-only setting as Candle reports it. True refuses any build
     * that is not reducing, whatever the server checked; it is never a substitute for that check.
     */
    keyReduceOnly?: boolean;
    /**
     * Set only by `verifyPerpsBuildAgainstVenue`'s first pass: a fact only the venue can supply (the
     * current leverage an omitted `leverage` keeps) is left to its second pass. Never set it alone.
     */
    awaitingVenue?: boolean;
    /**
     * The market an open or modify names, as Hyperliquid's own `/info` reports it
     * (`hyperliquidOrderMarket`), never as the build does. With it, every order leg must carry this
     * asset index, a market open's limit price must sit within its slippage of this mid, and a modify
     * that keeps its price must keep the resting order's price and side.
     */
    market?: HyperliquidOrderMarket;
    /** Bind the plaintext action to the method and arguments the caller actually requested. */
    intent?: {
        method: PerpsIntentMethod;
        params: Record<string, unknown>;
    };
}
/** What a build may be bound to. `tpsl` attaches one leg; `scheduleCancel` sets or clears the timer. */
export type PerpsIntentMethod = "setup" | "open" | "close" | "cancel" | "modify" | "leverage" | "margin" | "tpsl" | "scheduleCancel";
export type PerpsBuildCheck = {
    ok: true;
    kind: "l1" | "approveBuilderFee";
} | {
    ok: false;
    reason: string;
};
/** A Hyperliquid cloid, lowercase: `0x` and 32 hex digits. Also the shape of a caller's client order id. */
export declare const HYPERLIQUID_CLOID_RE: RegExp;
/**
 * The account modes Candle builds for: Hyperliquid's standard mode (`default`, or `disabled` for an
 * account that never chose one). `unifiedAccount`, `portfolioMargin`, `dexAbstraction` and any
 * unknown string are not standard (spec 2026-10-17 C, section 5).
 */
export declare const HYPERLIQUID_STANDARD_ACCOUNT_MODES: readonly string[];
/**
 * The account's mode, read directly from the pinned venue's `userAbstraction` before setup is
 * requested, so a server cannot report a mode the venue does not. Throws when it cannot be read.
 */
export declare function hyperliquidAccountMode(fetcher: (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    text(): Promise<string>;
}>, network: HyperliquidNetwork, address: string): Promise<string>;
/**
 * Why a setup response must not be trusted, or null. Runs on every setup answer, the no-action
 * `ready: true` one included (it carries no action for `verifyPerpsBuild` to check): the wallet,
 * network and builder must be this client's, and the mode the one this client read from the venue,
 * which must be standard.
 */
export declare function perpsSetupStatusProblem(status: Record<string, unknown>, expect: {
    network: HyperliquidNetwork;
    address: string;
    builder: string;
    mode: string;
}): string | null;
/**
 * A close percentage (spec D, section 8): a decimal above 0 and at most 100 with at most four
 * decimals, as millionths of the position (`"25"` is 250000). Null when it is not one.
 */
export declare function hyperliquidClosePct(value: unknown): bigint | null;
/**
 * `floor(held * pct / 100)` at the market's size precision, as a wire decimal; 100% is the held size
 * itself. Never rounds up: a percentage too small for one size step is "0", which callers refuse.
 */
export declare function hyperliquidPctSize(held: string, pct: bigint, szDecimals: number): string;
/** A non-negative decimal rounded down to `szDecimals` decimals, as a wire decimal. */
export declare function hyperliquidFloorSize(value: string, szDecimals: number): string;
/** Read the position directly from the pinned venue before signing a close. The request
 * names no side and can omit size, so neither may be inferred from the build's preview. A `pct`
 * request is sized here from that position, independently of the server (spec D, section 8).
 */
export declare function hyperliquidCloseOrder(fetcher: (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    text(): Promise<string>;
}>, network: HyperliquidNetwork, address: string, params: Record<string, unknown>): Promise<{
    asset: number;
    isBuy: boolean;
    size: string;
}>;
/**
 * The slippage a market open is held to when the request names none: the API's default
 * (`defaultSlippageBps`, 100), which is also what the build used.
 */
export declare const HYPERLIQUID_DEFAULT_SLIPPAGE_BPS = 100;
/**
 * Added to the requested slippage before a market open's price is refused. The build priced the
 * order from the API's read of the mid and this client checks it against its own, a moment later,
 * and the price is rounded to five significant figures; 100 bps covers both on any liquid market
 * while still refusing a price far from the venue's (a buy at twice the mid, a sell at half).
 */
export declare const HYPERLIQUID_MID_DRIFT_BPS = 100;
/**
 * The slippage a take-profit or stop-loss leg's limit price may carry past its trigger, before
 * `HYPERLIQUID_MID_DRIFT_BPS` is added for rounding. The API prices those legs at its
 * `maxSlippageBps` from the trigger, whatever the request's slippage: 500 unless
 * `HYPERLIQUID_MAX_SLIPPAGE_BPS` says otherwise (`apps/api/src/lib/perps-gate.ts`). A deployment
 * that raises it has its TP/SL legs refused here until this release follows.
 */
export declare const HYPERLIQUID_TPSL_SLIPPAGE_BPS = 500;
/** What Hyperliquid's own `/info` says about the market an open or modify names. */
export interface HyperliquidOrderMarket {
    /** The coin's index in Hyperliquid's main perp universe. */
    asset: number;
    /** Hyperliquid's mid for the coin (its mark price when the book has no mid). */
    midPx: string;
    /**
     * For a modify: the resting order it replaces, read from the venue by its cloid. Everything the
     * replacement keeps (spec D, section 5) is checked against this, never against the build.
     */
    order?: {
        isBuy: boolean;
        limitPx: string;
        size?: string;
        reduceOnly?: boolean;
        tif?: string;
        oid?: number;
    };
}
/**
 * Read the asset index and mid for an open (its `coin`) or a modify (the coin of the resting order
 * its `cloid` names) from the pinned venue before signing, the same way a close reads its position.
 * The build's own asset index and price are what this is checked against, so none of it may come
 * from the build or from Candle.
 */
export declare function hyperliquidOrderMarket(fetcher: (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    text(): Promise<string>;
}>, network: HyperliquidNetwork, address: string, method: "open" | "modify", params: Record<string, unknown>): Promise<HyperliquidOrderMarket>;
/**
 * Check a build before signing it. Never throws; a refusal names what failed. Callers must not
 * sign, and must not call the relay, unless this returns `ok: true`. An open or modify is not
 * fully checked until it passes with `market` read from Hyperliquid (`hyperliquidOrderMarket`).
 */
export declare function verifyPerpsBuild(build: PerpsBuildToVerify, opts: VerifyPerpsBuildOptions): PerpsBuildCheck;
/** Hyperliquid refuses a scheduled cancel less than five seconds ahead; so does this client. */
export declare const HYPERLIQUID_SCHEDULE_CANCEL_MIN_LEAD_MS = 5000;
/**
 * How far a scheduled cancel's fixed time may sit from this client's `now + seconds`: the build
 * fixed it a moment earlier, from Candle's clock.
 */
export declare const HYPERLIQUID_SCHEDULE_CANCEL_DRIFT_MS = 60000;
/** A venue read older than this is stale for a management decision (slice A's freshness ceiling). */
export declare const HYPERLIQUID_SNAPSHOT_MAX_AGE_MS = 30000;
type InfoFetcher = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status?: number;
    text(): Promise<string>;
}>;
/** One open order on the main perp exchange, as this client read it from `frontendOpenOrders`. */
export interface HyperliquidSnapshotOrder {
    coin: string;
    asset: number;
    oid: number;
    cloid: string | null;
    isBuy: boolean;
    sz: string;
    limitPx: string;
    reduceOnly: boolean;
    isTrigger: boolean;
    triggerPx: string | null;
    /** `tp` or `sl` for a take-profit or stop-loss trigger, null for any other order. */
    tpsl: "tp" | "sl" | null;
}
/** One main-perp position, as this client read it from `clearinghouseState`. */
export interface HyperliquidSnapshotPosition {
    coin: string;
    asset: number;
    szi: string;
    leverage: {
        type: "cross" | "isolated";
        value: number;
    };
}
/**
 * The wallet's main-perp state, read directly from Hyperliquid in one moment: the universe (with
 * each market's size precision), marks, positions and every open order including triggers.
 * `unsupported` names any row outside the main perp universe or that could not be classified;
 * flatten refuses on one rather than silently skip it (spec D, section 8). Throws on a failed or
 * malformed read: that is an error, never permission to trust a server's preview.
 */
export interface HyperliquidWalletSnapshot {
    readAt: number;
    universe: {
        name: string;
        szDecimals: number;
        maxLeverage: number;
        onlyIsolated: boolean;
    }[];
    /** Mark price per asset index, null when the venue gave none. */
    marks: (string | null)[];
    positions: HyperliquidSnapshotPosition[];
    orders: HyperliquidSnapshotOrder[];
    unsupported: string[];
}
export declare function hyperliquidWalletSnapshot(fetcher: InfoFetcher, network: HyperliquidNetwork, address: string, now?: () => number): Promise<HyperliquidWalletSnapshot>;
/** The snapshot's position in `coin` (case-insensitive), or null. */
export declare function snapshotPosition(snapshot: HyperliquidWalletSnapshot, coin: string): HyperliquidSnapshotPosition | null;
/** The size a take-profit / stop-loss attach protects: the held size, at the market's precision. */
export declare function hyperliquidTpslTarget(snapshot: HyperliquidWalletSnapshot, coin: string): NonNullable<VerifyPerpsBuildOptions["tpslTarget"]>;
/**
 * `verifyPerpsBuild`, then the same check again against what this client reads from Hyperliquid
 * itself for the request (the market, the position, the resting order, the account's leverage, the
 * clock). Every Candle surface calls this one function before it asks the relay to sign, so the
 * rules cannot fork between the SDK, the CLI and the MCP server. Never throws: a venue that could
 * not be read is a refusal.
 */
export declare function verifyPerpsBuildAgainstVenue(build: PerpsBuildToVerify, opts: VerifyPerpsBuildOptions & {
    intent: NonNullable<VerifyPerpsBuildOptions["intent"]>;
    address: string;
    fetcher: InfoFetcher;
    now?: () => number;
}): Promise<PerpsBuildCheck>;
/**
 * Hyperliquid's answer to one submitted action, per leg (spec D, section 3: "HTTP 200 alone is not
 * confirmation"). `confirmed` only when the venue said `ok` and no leg carries an error; `rejected`
 * when it said `err` or any leg did; `unknown` for anything else, which callers must reconcile
 * before acting again.
 */
export type HyperliquidSubmitOutcome = {
    status: "confirmed";
    legs: unknown[];
} | {
    status: "rejected";
    error: string;
    legs: unknown[];
} | {
    status: "unknown";
    error: string;
};
export declare function hyperliquidExchangeOutcome(exchange: unknown): HyperliquidSubmitOutcome;
/** A 65-byte `0x` signature split the way `/exchange` takes it. */
export declare function hyperliquidSplitSignature(signature: string): {
    r: string;
    s: string;
    v: number;
};
/** The `/exchange` request body for a signed action. */
export declare function hyperliquidExchangeBody(action: Record<string, unknown>, nonce: number, signature: string): {
    action: Record<string, unknown>;
    nonce: number;
    signature: {
        r: string;
        s: string;
        v: number;
    };
    vaultAddress: null;
    expiresAfter: null;
};
/** The relay body (Privy's wallet-RPC wire shape) for typed data. */
export declare function hyperliquidRelayBody(typedData: HyperliquidTypedData): {
    method: "eth_signTypedData_v4";
    params: {
        typed_data: HyperliquidTypedData;
    };
};
export {};
//# sourceMappingURL=hyperliquid.d.ts.map