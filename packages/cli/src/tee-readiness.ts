/**
 * What a TEE wallet's key needs before the server looks at any amount (BE-500, R4.5 and R4.6): a USD
 * transaction limit, and a per-transaction cap for the asset it spends. `GET /keys/self/limits`
 * reports it as `teeReadiness`. An older API omits the field, and then readiness is unknown: doctor
 * and `candle swap` never read an absent field as ready or as missing. The server stays
 * authoritative either way.
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

/** The same shape the server's `missingRequirements` uses. */
export type TeeRequirement = { kind: "raw_cap"; asset: TeeAsset } | { kind: "tx_limit" }

/** The response's `teeReadiness`, or undefined when it is absent or not the shape this CLI knows. */
export function parseTeeReadiness(value: unknown): TeeReadiness | undefined {
  if (!value || typeof value !== "object") return undefined
  const { txLimit, rawCaps } = value as { txLimit?: unknown; rawCaps?: unknown }
  if (typeof txLimit !== "boolean" || !rawCaps || typeof rawCaps !== "object") return undefined
  const caps = rawCaps as Record<string, unknown>
  if (!ASSETS.every((asset) => typeof caps[asset] === "boolean")) return undefined
  return { txLimit, rawCaps: caps as Record<TeeAsset, boolean> }
}

export function isTeeAsset(value: string | undefined): value is TeeAsset {
  return value !== undefined && (ASSETS as readonly string[]).includes(value)
}

/** Every requirement missing for `assets`, raw caps first, in the server's order. */
export function teeMissing(readiness: TeeReadiness, assets: readonly TeeAsset[]): TeeRequirement[] {
  const missing: TeeRequirement[] = assets
    .filter((asset) => !readiness.rawCaps[asset])
    .map((asset) => ({ kind: "raw_cap", asset }))
  if (!readiness.txLimit) missing.push({ kind: "tx_limit" })
  return missing
}

export function describeTeeRequirement(requirement: TeeRequirement): string {
  return requirement.kind === "raw_cap"
    ? `a maximum per transaction for ${requirement.asset}`
    : "a finite USD transaction limit"
}
