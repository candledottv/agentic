/**
 * Ember Phase 1 (BE-94, HW-07): how a PENDING sweep transaction (signed and handed to the RPC,
 * fate unknown) is resolved on a later run. Pure decisions over two separate RPC observations
 * (transaction status; blockhash validity), so every transition is unit-tested without a chain.
 *
 * The identity of a transaction is its first signature, known before submission; nothing here
 * ever replaces it. A pending record is discarded only on CONCLUSIVE evidence:
 *
 * - finalized without error: the transfer landed -> receipt
 * - finalized with error: the transfer can never land -> dropped, the balance is swept again
 * - no status at all, blockhash no longer valid, and STILL no status when re-read after the
 *   validity check: it can never be admitted -> dropped, the balance is swept again
 *
 * Everything else is uncertain and the record stays: a `processed`/`confirmed` observation (with
 * or without an error: a nonfinal error can still be rolled back with its fork, and a nonfinal
 * success can still finalize even after the blockhash it was admitted under expired), a missing
 * status while the blockhash is still valid, a validity answer that is not a boolean, and any
 * RPC failure. While anything is uncertain the sweep signs nothing new: a competing transfer of
 * the same balance would race the one in flight.
 */

export interface SignatureStatus {
  confirmationStatus: string | null
  err: unknown
}

export type PendingObservation =
  | { kind: "finalized" }
  | { kind: "failed"; err: unknown }
  | { kind: "nonfinal"; confirmationStatus: string | null; err: unknown }
  | { kind: "missing" }

/** What one `getSignatureStatuses` answer says about the transaction. */
export function classifyStatus(status: SignatureStatus | null | undefined): PendingObservation {
  if (status === null || status === undefined) return { kind: "missing" }
  if (status.confirmationStatus === "finalized") {
    return status.err === null || status.err === undefined ? { kind: "finalized" } : { kind: "failed", err: status.err }
  }
  return { kind: "nonfinal", confirmationStatus: status.confirmationStatus, err: status.err }
}

export type PendingResolution =
  | { kind: "finalized" }
  | { kind: "failed"; detail: string }
  | { kind: "expired"; detail: string }
  | { kind: "uncertain"; detail: string }

export interface PendingReads {
  /** Throws on RPC failure. */
  status(signature: string): Promise<SignatureStatus | null>
  /** Throws on RPC failure or a non-boolean answer. */
  blockhashValid(blockhash: string): Promise<boolean>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one pending record. Reads the status; only a MISSING status consults blockhash
 * validity, and an invalid blockhash is followed by one more status read, because a transaction
 * admitted just before expiry can show up between the two observations.
 */
export async function resolvePending(
  reads: PendingReads,
  pending: { signature: string; blockhash: string },
): Promise<PendingResolution> {
  let first: PendingObservation
  try {
    first = classifyStatus(await reads.status(pending.signature))
  } catch (error) {
    return { kind: "uncertain", detail: `status read failed (${describe(error)})` }
  }
  const settled = settle(first, pending.signature)
  if (settled) return settled
  if (first.kind === "nonfinal") {
    return {
      kind: "uncertain",
      detail: `observed ${first.confirmationStatus ?? "unknown"}${first.err !== null && first.err !== undefined ? ` with error ${JSON.stringify(first.err)}` : ""}, not yet finalized`,
    }
  }
  // Missing. Is the transaction still admissible?
  let valid: boolean
  try {
    valid = await reads.blockhashValid(pending.blockhash)
  } catch (error) {
    return { kind: "uncertain", detail: `not found, and blockhash validity is unknown (${describe(error)})` }
  }
  if (valid) return { kind: "uncertain", detail: "not found yet; its blockhash is still valid, so it may still land" }
  // Expired blockhash. Re-read the status: the transaction may have been admitted between the
  // first status read and the validity check.
  let second: PendingObservation
  try {
    second = classifyStatus(await reads.status(pending.signature))
  } catch (error) {
    return { kind: "uncertain", detail: `blockhash expired but the confirming status read failed (${describe(error)})` }
  }
  const settledLate = settle(second, pending.signature)
  if (settledLate) return settledLate
  if (second.kind === "nonfinal") {
    return {
      kind: "uncertain",
      detail: `observed ${second.confirmationStatus ?? "unknown"} after its blockhash expired, not yet finalized`,
    }
  }
  return { kind: "expired", detail: `never observed and its blockhash is no longer valid: it cannot land` }
}

function settle(observation: PendingObservation, signature: string): PendingResolution | null {
  if (observation.kind === "finalized") return { kind: "finalized" }
  if (observation.kind === "failed") {
    return { kind: "failed", detail: `transaction ${signature} failed on chain: ${JSON.stringify(observation.err)}` }
  }
  return null
}
