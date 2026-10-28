/** Public protocol for the optional cluster read. Unavailable never contains numeric analysis. */
export declare const CLUSTER_REASONS: readonly ["disabled", "invalid_config", "unsupported_chain", "invalid_mint", "key_missing", "gate_uncalibrated", "market_data_missing", "market_data_stale", "token_too_new", "gate_not_met", "not_indexed", "empty_analysis", "invalid_response", "timeout", "upstream_unavailable", "upstream_4xx", "upstream_5xx", "rate_limited", "quota_exhausted", "budget_exhausted", "budget_unavailable", "request_in_progress", "transport_error", "internal_unavailable"];
export type ClusterReason = (typeof CLUSTER_REASONS)[number];
export declare const CLUSTER_MESSAGE = "Cluster analysis not available for this token";
export declare const CLUSTER_LABEL = "Third-party cluster analysis";
export declare const CLUSTER_CAVEAT = "Third-party estimates of linked wallets. Exchange, pool and service wallets may be grouped together. These figures do not establish common ownership, insider conduct or wrongdoing.";
export interface ClusterAnalysis {
    clusterSupplyPct: number;
    clusters: {
        supplyPct: number;
        addresses: string[];
        tags: string[];
    }[];
}
export type ClusterResult = {
    status: "available";
    chain: "solana";
    mint: string;
    source: "third_party";
    label: typeof CLUSTER_LABEL;
    caveat: string;
    fetchedAt: string;
    expiresAt: string;
    cache: "hit" | "miss";
    analysis: ClusterAnalysis;
} | {
    status: "unavailable";
    mint: string;
    reason: ClusterReason;
    message: typeof CLUSTER_MESSAGE;
    retryAt?: string;
};
export declare function clusterUnavailable(mint: string, reason: ClusterReason, retryAt?: number): ClusterResult;
/** Construct only protocol fields; malformed/unknown server output is a client availability failure. */
export declare function readClusterResult(value: unknown, mint: string): ClusterResult | null;
//# sourceMappingURL=token-clusters.d.ts.map