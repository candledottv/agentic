/**
 * Hyperliquid withdrawals (Candle spec 2026-10-17-hyperliquid-withdrawals-design.md, "Client checks
 * before each signature"): the client half of a withdrawal from the key's HyperCore balance,
 * through Relay, to the same key's own Solana or Hood TEE wallet.
 *
 * Candle's server builds both signatures; this machine checks each one before it asks the relay to
 * sign, and refuses with no relay call when anything differs from what it asked for:
 *
 *   - Before the NonceMapping: the domain and type list are Relay's, `wallet` and `depositor` are
 *     this key's own EVM TEE address, `id` is the build's Relay order id (not the step request
 *     id), and the destination the build names is one of this key's own wallets on the chain asked
 *     for. That `to` is the recipient check: it comes from Candle's quote record, which the server
 *     checked against Relay's quote echo of the recipient. Relay's own record of the request is not
 *     read: it needs a Relay key, and none ships in this client (BE-1777).
 *   - Before the SendAsset: the nonce is the mapping's, the amount parses exactly to the micros
 *     asked for (no float, no string compare), `fromSubAccount` and `sourceDex` are empty, `token`
 *     and `destinationDex` are the pinned values, `destination` is on the pinned depository
 *     allow-list, and the primary type, domain and action all match.
 *
 * The pins (`token`, `destinationDex`, the depository allow-list and the amount's string form) are
 * the values three live `/quote/v2` reads recorded on 2026-10-18 (V-A part 2). With no pins every
 * check refuses: nothing is guessed.
 *
 * `packages/cli/src/hyperliquid-withdraw.ts` is a byte-identical copy of this file (a drift test
 * enforces it). Self-contained on purpose: it imports nothing.
 */
export type WithdrawAmountForm = "canonical" | "fixed6";
export interface PerpsWithdrawPins {
    token: string;
    destinationDex: string;
    /** Lowercase depository addresses. */
    depositories: readonly string[];
    amountForm: WithdrawAmountForm;
}
/**
 * V-A part 2 (three live `/quote/v2` reads, 2026-10-18). One depository only, by the owner's D10
 * decision: if Relay rotates it, every withdrawal check refuses until a release records the new one.
 * Relay's guide example depository (0x865eb9ba...7081) is not on it.
 */
export declare const CANDLE_PERPS_WITHDRAW_PINS: PerpsWithdrawPins | null;
export declare const RELAY_NONCE_MAPPING_TYPES: {
    readonly NonceMapping: readonly [{
        readonly name: "chainId";
        readonly type: "string";
    }, {
        readonly name: "wallet";
        readonly type: "address";
    }, {
        readonly name: "depositor";
        readonly type: "address";
    }, {
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly name: "nonce";
        readonly type: "uint256";
    }];
};
export declare const HYPERLIQUID_SEND_ASSET_TYPES: {
    readonly "HyperliquidTransaction:SendAsset": readonly [{
        readonly name: "hyperliquidChain";
        readonly type: "string";
    }, {
        readonly name: "destination";
        readonly type: "string";
    }, {
        readonly name: "sourceDex";
        readonly type: "string";
    }, {
        readonly name: "destinationDex";
        readonly type: "string";
    }, {
        readonly name: "token";
        readonly type: "string";
    }, {
        readonly name: "amount";
        readonly type: "string";
    }, {
        readonly name: "fromSubAccount";
        readonly type: "string";
    }, {
        readonly name: "nonce";
        readonly type: "uint64";
    }];
};
/** A withdrawal amount in USDC, at most 6 dp, as micros. Null when it is not one, or zero. */
export declare function parseWithdrawAmount(value: string): bigint | null;
/** Micros as the canonical decimal: `5`, `5.5`, `0.000001`. */
export declare function formatWithdrawAmount(micros: bigint): string;
/** `sendAsset.amount` parsed exactly to micros, in the pinned form only. Null otherwise. */
export declare function parseSendAssetAmount(value: unknown, form: WithdrawAmountForm): bigint | null;
export type WithdrawCheck = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** What `POST /agent/perps/withdraw` answers for a quoted withdrawal. */
export interface PerpsWithdrawBuild {
    id: string;
    status: string;
    from: {
        walletId: string;
        address: string;
        network: string;
    };
    to: {
        chain: "solana" | "hood";
        walletId: string;
        address: string;
    };
    amountUsdc: string;
    feesUsdc: string;
    netUsdc: string;
    minimumOutUsdc: string;
    /** Relay's step tracking id, for status reads. It is not the NonceMapping id. */
    relayRequestId: string;
    /**
     * Relay `protocol.v2.orderId`. The NonceMapping `id` must equal this bytes32. Absent on a build
     * the server could not check; signing refuses, with no fallback to `relayRequestId`.
     */
    relayOrderId?: string;
    nonce: number;
    expiresAt: number;
    typedData?: {
        domain: unknown;
        types: unknown;
        primary_type: string;
        message: Record<string, unknown>;
    };
}
/** What `POST /agent/perps/withdraw/authorize` answers once Relay accepted the mapping. */
export interface PerpsWithdrawAuthorization {
    id: string;
    status: string;
    nonce: number;
    typedData: {
        domain: unknown;
        types: unknown;
        primary_type: string;
        message: Record<string, unknown>;
    };
    action: Record<string, unknown>;
}
/**
 * Before the NonceMapping is signed. `account` is this key's EVM TEE address; `ownDestinations`
 * holds this key's own wallet addresses on the chain asked for (the Solana TEE wallet, or the EVM
 * TEE wallet itself for Hood).
 */
export declare function verifyWithdrawMapping(build: PerpsWithdrawBuild, expect: {
    id: string;
    account: string;
    to: "solana" | "hood";
    amountMicros: bigint;
    ownDestinations: readonly string[];
    pins: PerpsWithdrawPins | null;
}): WithdrawCheck;
/** Before the SendAsset is signed: everything pinned, the nonce the mapping's, the amount exact. */
export declare function verifyWithdrawSendAsset(authorization: PerpsWithdrawAuthorization, expect: {
    mappingNonce: number;
    amountMicros: bigint;
    pins: PerpsWithdrawPins | null;
}): WithdrawCheck;
//# sourceMappingURL=hyperliquid-withdraw.d.ts.map