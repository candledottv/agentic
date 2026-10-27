/** Public protocol for the optional cluster read. Unavailable never contains numeric analysis. */
export const CLUSTER_REASONS = [
  "disabled",
  "invalid_config",
  "unsupported_chain",
  "invalid_mint",
  "key_missing",
  "gate_uncalibrated",
  "market_data_missing",
  "market_data_stale",
  "token_too_new",
  "gate_not_met",
  "not_indexed",
  "empty_analysis",
  "invalid_response",
  "timeout",
  "upstream_unavailable",
  "upstream_4xx",
  "upstream_5xx",
  "rate_limited",
  "quota_exhausted",
  "budget_exhausted",
  "budget_unavailable",
  "request_in_progress",
  "transport_error",
  "internal_unavailable",
] as const
export type ClusterReason = (typeof CLUSTER_REASONS)[number]
export const CLUSTER_MESSAGE = "Cluster analysis not available for this token"
export const CLUSTER_LABEL = "Third-party cluster analysis"
export const CLUSTER_CAVEAT =
  "Third-party estimates of linked wallets. Exchange, pool and service wallets may be grouped together. These figures do not establish common ownership, insider conduct or wrongdoing."
export interface ClusterAnalysis {
  clusterSupplyPct: number
  clusters: { supplyPct: number; addresses: string[]; tags: string[] }[]
}
export type ClusterResult =
  | {
      status: "available"
      chain: "solana"
      mint: string
      source: "third_party"
      label: typeof CLUSTER_LABEL
      caveat: string
      fetchedAt: string
      expiresAt: string
      cache: "hit" | "miss"
      analysis: ClusterAnalysis
    }
  | { status: "unavailable"; mint: string; reason: ClusterReason; message: typeof CLUSTER_MESSAGE; retryAt?: string }
export function clusterUnavailable(mint: string, reason: ClusterReason, retryAt?: number): ClusterResult {
  return {
    status: "unavailable",
    mint,
    reason,
    message: CLUSTER_MESSAGE,
    ...(retryAt !== undefined && Number.isFinite(retryAt) ? { retryAt: new Date(retryAt).toISOString() } : {}),
  }
}

/** Construct only protocol fields; malformed/unknown server output is a client availability failure. */
export function readClusterResult(value: unknown, mint: string): ClusterResult | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (v.mint !== mint) return null
  if (v.status === "unavailable" && CLUSTER_REASONS.includes(v.reason as ClusterReason)) {
    const retry = v.retryAt === undefined ? undefined : typeof v.retryAt === "string" ? Date.parse(v.retryAt) : NaN
    if (retry !== undefined && !Number.isFinite(retry)) return null
    return clusterUnavailable(mint, v.reason as ClusterReason, retry)
  }
  if (
    v.status !== "available" ||
    v.chain !== "solana" ||
    v.source !== "third_party" ||
    !["hit", "miss"].includes(v.cache as string) ||
    typeof v.fetchedAt !== "string" ||
    typeof v.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(v.fetchedAt)) ||
    !(Date.parse(v.expiresAt) > Date.parse(v.fetchedAt))
  )
    return null
  const a = v.analysis as ClusterAnalysis | undefined
  const percent = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100
  if (!a || !percent(a.clusterSupplyPct) || !Array.isArray(a.clusters) || !a.clusters.length || a.clusters.length > 100)
    return null
  let addresses = 0
  for (const c of a.clusters) {
    if (
      !c ||
      !percent(c.supplyPct) ||
      c.supplyPct > a.clusterSupplyPct + 0.01 ||
      !Array.isArray(c.addresses) ||
      !Array.isArray(c.tags) ||
      c.tags.length > 32 ||
      c.tags.some((t) => typeof t !== "string" || t.length > 100) ||
      c.addresses.some((x) => typeof x !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x))
    )
      return null
    addresses += c.addresses.length
  }
  if (addresses > 1000 || (a.clusterSupplyPct === 0 && a.clusters.every((c) => c.supplyPct === 0))) return null
  return {
    status: "available",
    chain: "solana",
    mint,
    source: "third_party",
    label: CLUSTER_LABEL,
    caveat: CLUSTER_CAVEAT,
    fetchedAt: v.fetchedAt,
    expiresAt: v.expiresAt,
    cache: v.cache as "hit" | "miss",
    analysis: {
      clusterSupplyPct: a.clusterSupplyPct,
      clusters: a.clusters.map((c) => ({ supplyPct: c.supplyPct, addresses: [...c.addresses], tags: [...c.tags] })),
    },
  }
}
