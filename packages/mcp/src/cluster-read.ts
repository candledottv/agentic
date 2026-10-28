/**
 * `candle_token_clusters` (BE-2006): the optional third-party cluster read,
 * `GET /api/v1/tokens/:mint/clusters`. Unlike the relayed tools, this one never reports an error:
 * the API's availability union is the answer, and a request or response this server cannot use
 * becomes the same union with reason `transport_error`. The CLI (`candle token clusters`) and the
 * SDK (`getTokenClusters`) map failures the same way. Sends no key; nothing is cached here.
 */
import { z } from "zod"
import type { RequestConfig } from "./client"
import type { FetchLike } from "./orchestrate"
import { type ClusterResult, clusterUnavailable, readClusterResult } from "./token-clusters"
import { noteVersionHeaders } from "./update-notice"

/** The same bound the CLI puts on this read. The server's own provider deadline is shorter. */
export const CLUSTER_READ_TIMEOUT_MS = 12000

export const tokenClustersShape = {
  mint: z.string().min(1).describe("Solana token mint"),
  chain: z
    .enum(["solana", "hood"])
    .optional()
    .describe('Default "solana". Hood is not covered and returns reason unsupported_chain'),
}

export const CLUSTER_READ_DESCRIPTION =
  "Optional third-party cluster analysis for a Solana token: groups of linked wallets and the share of supply " +
  "they hold. No key needed. Always returns a result, never an error. status 'available' carries label, caveat, " +
  "fetchedAt, expiresAt and analysis { clusterSupplyPct, clusters[{ supplyPct, addresses, tags }] }. status " +
  "'unavailable' carries reason and message 'Cluster analysis not available for this token', with retryAt when a " +
  "retry time is known; most tokens are unavailable, and unavailable is not zero clustered supply or a clean bill " +
  "of health. These are third-party estimates: exchange, pool and service wallets may be grouped together, and " +
  "the figures do not establish common ownership, insider conduct or wrongdoing. Report the caveat with any " +
  "figure. Keep them separate from candle_token_forensics; never combine the two into one score."

export async function readTokenClusters(
  args: { mint: string; chain?: string | undefined },
  cfg: RequestConfig,
  doFetch: FetchLike,
): Promise<ClusterResult> {
  const { mint } = args
  const chain = args.chain ?? "solana"
  try {
    const base = cfg.apiUrl.replace(/\/$/, "")
    const res = await doFetch(
      `${base}/api/v1/tokens/${encodeURIComponent(mint)}/clusters?chain=${encodeURIComponent(chain)}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(CLUSTER_READ_TIMEOUT_MS) },
    )
    noteVersionHeaders(res)
    if (res.ok) {
      const body = JSON.parse(await res.text()) as { success?: unknown; data?: unknown } | null
      if (body?.success === true)
        return readClusterResult(body.data, mint) ?? clusterUnavailable(mint, "transport_error")
    }
  } catch {
    /* A failed or unreadable request is a normal unavailable result for this optional read. */
  }
  return clusterUnavailable(mint, "transport_error")
}
