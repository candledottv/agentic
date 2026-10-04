export type HyperliquidNetwork = "mainnet" | "testnet";
/** The L1 action types a Candle build may carry. Anything else is refused before signing. */
export declare const HYPERLIQUID_ALLOWED_ACTION_TYPES: readonly ["order", "cancel", "modify", "updateLeverage", "updateIsolatedMargin"];
/** Hyperliquid's `/exchange` endpoint per network. The client never takes this from the server. */
export declare const HYPERLIQUID_EXCHANGE_URLS: Readonly<Record<HyperliquidNetwork, string>>;
/** Hyperliquid's public `/info` endpoint per network. */
export declare const HYPERLIQUID_INFO_URLS: Readonly<Record<HyperliquidNetwork, string>>;
/**
 * Candle's builder address as this release knows it, for `verifyPerpsBuild`. Null until the address
 * is fixed for a published release; until then a client pins it from its own configuration.
 */
export declare const CANDLE_HYPERLIQUID_BUILDER_ADDRESS: string | null;
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
 * Check a build before signing it. Never throws; a refusal names what failed. Callers must not
 * sign, and must not call the relay, unless this returns `ok: true`.
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