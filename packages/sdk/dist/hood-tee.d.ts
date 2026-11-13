/** Public, redacted wallet guard contract. No signed bytes or provider details. */
export type GuardReason = "admitted" | "already_known" | "nonce_too_low" | "pending" | "transaction_missing" | "rpc_unavailable" | "rpc_hash_mismatch" | "nonce_conflict" | "persistence_pending" | "legacy_identity_missing" | "legacy_candidate_conflict" | "legacy_proof_incomplete" | "accounting_pending" | "receipt_conflict";
export interface GuardSummary {
    operationId: string;
    operationKind: "trade" | "swap" | "launch" | "transfer";
    refId: string;
    operationStatus: "active" | "completed" | "failed" | "expired";
    recoveryRequired: true;
    legIndex?: number;
    legKind?: string;
    legOutcome?: "uncertain";
    hash?: string;
    receipt?: {
        hash: string;
        blockHash: string;
        blockNumber: string;
        status: "success" | "reverted";
    };
    reason: GuardReason;
    safeAction: "read_status" | "supply_locator" | "contact_support";
    clearingCondition: string;
    statusPath: string;
    statusCommand: string;
    pollAfterMs?: number;
}
export interface HoodTeeOperation {
    operationId: string;
    kind: "trade" | "swap" | "launch" | "transfer";
    /** Displayed status; a reconciled legacy `failed` row reads `expired` (see `storedStatus`). */
    status: "active" | "completed" | "failed" | "expired";
    /** Present only when `status` was derived differently from the stored value. */
    storedStatus?: "active" | "completed" | "failed" | "expired";
    /** Whether this operation holds the wallet. The one field to read; `legs[].legacyHeld` is history. */
    held?: boolean;
    plannedLegCount: number;
    currentLegIndex: number;
    expiresAt: number;
    legs: Array<{
        kind: string;
        status: string;
        hash?: string;
        nonce?: number;
        outcome?: "uncertain" | "landed" | "reverted" | "not_sent";
        reason?: string;
        /** History marker stamped when a legacy leg was promoted; never a lock. Read `held`. */
        legacyHeld?: true;
        stampSuperseded?: true;
        conflictHash?: string;
        candidateHashes?: string[];
        receipt?: {
            hash: string;
            blockHash: string;
            blockNumber: string;
            status: "success" | "reverted";
        };
    }>;
    guard?: GuardSummary;
    recovery?: Record<string, unknown>;
    feeOwed?: Record<string, unknown>;
}
export interface WalletBusyDetails {
    operationId?: string;
    operationKind?: HoodTeeOperation["kind"];
    refId?: string;
    legIndex?: number;
    legKind?: string;
    reason?: GuardReason;
    clearingCondition?: string;
    statusPath?: string;
    statusCommand?: string;
}
/** Display-only Hood preview. It carries no nonce, transaction bytes or sign hash. */
export interface HoodPreview {
    success: true;
    mode: "preview";
    chain: "hood";
    walletAddress: string;
    artifacts: {
        venue: string;
        quoteSource: string;
        priceImpactPct: string | null;
        quoteAsset: string;
        tokenRisks: unknown[];
        route?: unknown;
    };
    fee: {
        bps: number;
        feeRaw: string;
    };
    expectedOutRaw: string;
    minOutRaw: string;
    legs: string[];
    firstLeg: {
        kind: string;
        gas: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
    };
    gas: {
        ok: true;
    } | {
        ok: false;
        shortfallWei: string;
        requiredWei: string;
        reserveWei: string;
        balanceWei: string;
    };
    wallet: {
        held: false;
    } | {
        held: true;
        guarded?: boolean;
        operationId: string;
        expiresAt?: number;
        cancelCommand?: string;
        statusCommand?: string;
    };
    limitsChecked: "raw caps only; the USD window is reserved on confirm";
    quotedAt: number;
}
//# sourceMappingURL=hood-tee.d.ts.map