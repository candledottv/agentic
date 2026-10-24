/** Solana graduation choices as `candle launch` flags. The server stays the authoritative validator. */
export const POOL_FLAGS = ["--pool-fee", "--pool-fee-from", "--pool-fee-minutes", "--pool-open", "--exp-pool-shape"]

type Flags = Partial<Record<string, string | undefined>>

const TIERS = ["25", "50", "100"]

/** The `poolFee`/`poolOpen`/`expPoolShape` request fields; empty when no flag is given. Throws a usage message. */
export function poolRequestFields(flags: Flags): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const fee = flags["--pool-fee"]
  const from = flags["--pool-fee-from"]
  const minutes = flags["--pool-fee-minutes"]
  if ((from !== undefined || minutes !== undefined) && fee === undefined)
    throw new Error("--pool-fee-from and --pool-fee-minutes need --pool-fee <25|50|100>, the rate the fall ends at")
  if (fee !== undefined) {
    if (!TIERS.includes(fee)) throw new Error("--pool-fee takes 25, 50 or 100 (bps)")
    if ((from === undefined) !== (minutes === undefined))
      throw new Error("A falling pool fee needs both --pool-fee-from <bps> and --pool-fee-minutes <minutes>")
    if (from === undefined) out.poolFee = { tier: Number(fee) }
    else {
      if (!/^\d+$/.test(from)) throw new Error("--pool-fee-from takes whole bps")
      const m = Number(minutes)
      if (!Number.isFinite(m) || m <= 0) throw new Error("--pool-fee-minutes takes a positive number of minutes")
      out.poolFee = { startBps: Number(from), endBps: Number(fee), minutes: m }
    }
  }
  const open = flags["--pool-open"]
  if (open !== undefined) {
    if (open !== "legacy" && open !== "curve_price") throw new Error("--pool-open takes legacy or curve_price")
    out.poolOpen = open
  }
  const shape = flags["--exp-pool-shape"]
  if (shape !== undefined) {
    if (shape !== "floor" && shape !== "full_range") throw new Error("--exp-pool-shape takes floor or full_range")
    out.expPoolShape = shape
  }
  return out
}
