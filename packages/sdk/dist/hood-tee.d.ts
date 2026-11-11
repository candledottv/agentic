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
    status: "active" | "completed" | "failed" | "expired";
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
//# sourceMappingURL=hood-tee.d.ts.map