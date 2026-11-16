/**
 * BE-3575: what the chain says about a Solana launch signature that Candle's headless route
 * answered with `stage: "unconfirmed"` (the server's confirmation wait ran out, or its outcome was
 * indeterminate). The route reports that as `LAUNCH_FAILED`, but the send may have landed, and a
 * caller that retries a `LAUNCH_FAILED` under a new id would launch, and spend, a second time.
 *
 * Only a finalized observation is conclusive, as in `sweep-pending.ts`: finalized without an error
 * is a launch that landed, and finalized with an error is one that can never land. Anything else
 * (no status, a processed or confirmed one, a failed RPC read) after every read is `unknown`, which
 * the caller reports as unresolved (exit 3), never as a failed launch.
 */
import { classifyStatus, type SignatureStatus } from "./sweep-pending"

export type LaunchSignatureCheck =
  | { kind: "landed"; slot?: number }
  | { kind: "reverted"; err: unknown }
  | { kind: "unknown"; detail: string }

/** Six reads, five seconds apart: about the time a confirmed transaction takes to finalize. */
export const LAUNCH_SIGNATURE_READS = 6
export const LAUNCH_SIGNATURE_POLL_MS = 5_000

export async function checkLaunchSignature(
  read: (signature: string) => Promise<SignatureStatus | null>,
  sleep: (ms: number) => Promise<void>,
  signature: string,
  reads: number = LAUNCH_SIGNATURE_READS,
): Promise<LaunchSignatureCheck> {
  let detail = "the RPC has no status for it"
  for (let attempt = 0; attempt < reads; attempt++) {
    if (attempt > 0) await sleep(LAUNCH_SIGNATURE_POLL_MS)
    let observed: ReturnType<typeof classifyStatus>
    try {
      observed = classifyStatus(await read(signature))
    } catch {
      // The message may carry the endpoint URL, which may carry a provider key: never repeat it.
      detail = "the RPC read failed"
      continue
    }
    if (observed.kind === "finalized")
      return observed.slot !== undefined ? { kind: "landed", slot: observed.slot } : { kind: "landed" }
    if (observed.kind === "failed") return { kind: "reverted", err: observed.err }
    detail =
      observed.kind === "missing"
        ? "the RPC has no status for it"
        : `the RPC sees it at ${observed.confirmationStatus ?? "an unknown"} commitment, not finalized`
  }
  return { kind: "unknown", detail }
}
