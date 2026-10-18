export type HyperliquidNetwork = "mainnet" | "testnet";
/** The L1 action types a Candle build may carry. Anything else is refused before signing. */
export declare const HYPERLIQUID_ALLOWED_ACTION_TYPES: readonly ["order", "cancel", "modify", "updateLeverage", "updateIsolatedMargin"];
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
     * The market an open or modify names, as Hyperliquid's own `/info` reports it
     * (`hyperliquidOrderMarket`), never as the build does. With it, every order leg must carry this
     * asset index, a market open's limit price must sit within its slippage of this mid, and a modify
     * that keeps its price must keep the resting order's price and side.
     */
    market?: HyperliquidOrderMarket;
    /** Bind the plaintext action to the method and arguments the caller actually requested. */
    intent?: {
        method: "setup" | "open" | "close" | "cancel" | "modify" | "leverage" | "margin";
        params: Record<string, unknown>;
    };
}
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
/** Read the position directly from the pinned venue before signing a close. The request
 * names no side and can omit size, so neither may be inferred from the build's preview.
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
    /** For a modify: the resting order it replaces, read from the venue by its cloid. */
    order?: {
        isBuy: boolean;
        limitPx: string;
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
//# sourceMappingURL=hyperliquid.d.ts.map