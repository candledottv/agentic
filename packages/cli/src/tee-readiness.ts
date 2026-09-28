/**
 * `GET /keys/self/limits` reports which of the key's optional limits are set as `teeReadiness`: the
 * USD transaction limit and each asset's per-transaction cap. Only limits the owner set apply, so
 * neither is required for a TEE trade or swap; transfers, LP deposits and launches still need a
 * per-asset cap, which the server enforces. `doctor` reports these as information. An older API
 * omits the field, and then readiness is unknown. The server stays authoritative either way.
 */

export type TeeAsset = "SOL" | "USDC" | "CNDL" | "ETH" | "USDG"

/** The base assets a TEE wallet on each chain can spend. */
export const TEE_CHAIN_ASSETS: Record<"solana" | "hood", readonly TeeAsset[]> = {
  solana: ["SOL", "USDC", "CNDL"],
  hood: ["ETH", "USDG"],
}

const ASSETS: readonly TeeAsset[] = ["SOL", "USDC", "CNDL", "ETH", "USDG"]

export interface TeeReadiness {
  txLimit: boolean
  rawCaps: Record<TeeAsset, boolean>
}

/** The response's `teeReadiness`, or undefined when it is absent or not the shape this CLI knows. */
export function parseTeeReadiness(value: unknown): TeeReadiness | undefined {
  if (!value || typeof value !== "object") return undefined
  const { txLimit, rawCaps } = value as { txLimit?: unknown; rawCaps?: unknown }
  if (typeof txLimit !== "boolean" || !rawCaps || typeof rawCaps !== "object") return undefined
  const caps = rawCaps as Record<string, unknown>
  if (!ASSETS.every((asset) => typeof caps[asset] === "boolean")) return undefined
  return { txLimit, rawCaps: caps as Record<TeeAsset, boolean> }
}
