/**
 * BE-3140 (R97): re-read how a one-shot `candle_swap` settled, by a hash it returned or by its
 * `clientSwapId`. One module for both surfaces that offer it, `candle_get_swap_receipt` (this
 * package, stdio and hosted) and `candle swap receipt` (packages/cli), so the reads, the skip rule
 * and the `next` texts cannot drift between them.
 *
 * Reads only. The two routes are GET `/api/v1/agent/swap/receipts/:hash` (BE-504, remeasures the
 * settlement on every read) and GET `/api/v1/agent/swap/by-client-id/:id` (BE-2656, the one-shot
 * swap's row). Nothing here sends a write, and nothing here waits or polls: each call is one
 * measurement.
 *
 * The clientSwapId form reads the row first and then the receipt of `hashes[0]`, and only for a
 * `confirmed` row with a hash: a receipt is written once every leg landed, so for any other outcome
 * a second read could only 404 (spec D4, I6).
 */

/** The receipt route's longest hash (packages/db/convex/agentSwapReceipts.ts `RECEIPT_MAX_HASH_CHARS`). */
export const SWAP_RECEIPT_MAX_HASH_CHARS = 128

export const SWAP_RECEIPT_EXACTLY_ONE = "Supply exactly one of hash or clientSwapId"

/** M1: a hash read answered 404 `RECEIPT_NOT_FOUND`. */
export const SWAP_RECEIPT_HASH_NOT_FOUND_NEXT =
  "No receipt for this hash on this key. Only the key that made a one-shot swap can read its receipt, and a " +
  "swap that answered receiptStored: false has none. The swap may still have landed: read candle_get_operation " +
  "by its clientSwapId. Do not resend it."

/** M2: the row is confirmed, but its receipt read answered 404. Never "no settlement". */
export const SWAP_RECEIPT_NOT_FOUND_NEXT =
  "The swap is confirmed, but this key cannot read its receipt: another key on the account made it, or its " +
  "receipt was not stored (receiptStored: false). Reconcile from chain with hashes. Do not resend it."

/** M3: the row was found; the receipt read failed for another reason (503, 429, ...). */
export const SWAP_RECEIPT_UNAVAILABLE_NEXT =
  "The swap was found, but its receipt could not be read just now. Try again in 15 seconds. Do not resend it."

/** M4's first sentence; `swapReceiptNoHashNext` adds the outcome's own. */
export const SWAP_RECEIPT_NO_HASH_NEXT = "No transaction hash yet, so there is no settlement to read."

/** M5: a leg was broadcast and the swap did not complete, so no receipt row exists. */
export const SWAP_RECEIPT_NOT_WRITTEN_NEXT =
  "A leg was broadcast but the swap did not complete, so no receipt was written. error says where the funds " +
  "are. Do not resend it."

/** M4 for one outcome. */
export function swapReceiptNoHashNext(outcome: string): string {
  if (outcome === "in_flight") return `${SWAP_RECEIPT_NO_HASH_NEXT} Read again later.`
  if (outcome === "failed") return `${SWAP_RECEIPT_NO_HASH_NEXT} Nothing was broadcast.`
  return SWAP_RECEIPT_NO_HASH_NEXT
}

export type SwapReceiptTarget = { hash: string } | { clientSwapId: string }

/**
 * Exactly one of `hash` or `clientSwapId`. Both, neither, an empty value or a hash past the route's
 * limit throws here, before anything is fetched.
 */
export function swapReceiptTarget(args: { hash?: unknown; clientSwapId?: unknown }): SwapReceiptTarget {
  const hasHash = args.hash !== undefined
  const hasId = args.clientSwapId !== undefined
  if (hasHash === hasId) throw new Error(SWAP_RECEIPT_EXACTLY_ONE)
  if (hasHash) {
    const hash = args.hash
    if (typeof hash !== "string" || hash.length === 0 || hash.length > SWAP_RECEIPT_MAX_HASH_CHARS) {
      throw new Error(`hash must be 1 to ${SWAP_RECEIPT_MAX_HASH_CHARS} characters`)
    }
    return { hash }
  }
  const clientSwapId = args.clientSwapId
  if (typeof clientSwapId !== "string" || clientSwapId.length === 0) {
    throw new Error("clientSwapId must be a non-empty string")
  }
  return { clientSwapId }
}

export function swapReceiptPath(hash: string): string {
  return `/api/v1/agent/swap/receipts/${encodeURIComponent(hash)}`
}

export function swapByClientIdPath(clientSwapId: string): string {
  return `/api/v1/agent/swap/by-client-id/${encodeURIComponent(clientSwapId)}`
}

/** The first read either form makes. */
export function swapReceiptFirstPath(target: SwapReceiptTarget): string {
  return "hash" in target ? swapReceiptPath(target.hash) : swapByClientIdPath(target.clientSwapId)
}

/** One GET's answer, as the caller's transport read it. A transport failure throws instead. */
export interface SwapReceiptResponse {
  ok: boolean
  status: number
  text: string
}

/** A GET of one of the two paths above. Never anything else. */
export type SwapReceiptGet = (path: string) => Promise<SwapReceiptResponse>

export type SwapReceiptState = "read" | "no_hash" | "not_written" | "not_found" | "unavailable"

export interface SwapReceiptResult {
  /** The answer as text: the API's own body, or the clientSwapId form's object. */
  text: string
  /** `text` parsed, when it is a JSON object. */
  body: Record<string, unknown> | null
  isError: boolean
  /** The clientSwapId form's `receipt`, when the row was read. */
  receipt?: SwapReceiptState
  /** The row's `job`, as the API sent it, when the row was read. Not part of `text`. */
  job?: Record<string, unknown>
}

type Json = Record<string, unknown>

function parseObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null
  } catch {
    return null
  }
}

function errorCode(body: Json | null): unknown {
  const error = body?.error
  return error !== null && typeof error === "object" ? (error as Json).code : undefined
}

function result(body: Json, isError: boolean, receipt?: SwapReceiptState, job?: Json): SwapReceiptResult {
  return { text: JSON.stringify(body), body, isError, ...(receipt ? { receipt } : {}), ...(job ? { job } : {}) }
}

/** The receipt read's error for `unavailable`: the API's own, or one that names the status. */
function stepTwoError(status: number, body: Json | null): Json {
  const error = body?.error
  if (error !== null && typeof error === "object" && typeof (error as Json).code === "string") {
    const { code, message, retryable } = error as Json
    return {
      code,
      ...(typeof message === "string" ? { message } : {}),
      retryable: typeof retryable === "boolean" ? retryable : true,
    }
  }
  return { code: "RECEIPT_UNAVAILABLE", message: `The receipt read answered HTTP ${status}.`, retryable: true }
}

/**
 * Runs the read. `operationNotFoundNext` is handed in (it lives in tools.ts) so this module has no
 * import of its own and both packages can load it.
 */
export async function readSwapReceipt(
  target: SwapReceiptTarget,
  get: SwapReceiptGet,
  operationNotFoundNext: (clientId: string, kind: "swap") => string,
): Promise<SwapReceiptResult> {
  if ("hash" in target) {
    const res = await get(swapReceiptPath(target.hash))
    const body = parseObject(res.text)
    if (res.status === 404 && body && errorCode(body) === "RECEIPT_NOT_FOUND") {
      return result({ ...body, next: SWAP_RECEIPT_HASH_NOT_FOUND_NEXT }, true)
    }
    // Everything else is the API's answer as it sent it.
    return { text: res.text, body, isError: !res.ok }
  }

  const clientSwapId = target.clientSwapId
  const row = await get(swapByClientIdPath(clientSwapId))
  const rowBody = parseObject(row.text)
  if (!row.ok) {
    if (row.status === 404 && rowBody && errorCode(rowBody) === "JOB_NOT_FOUND") {
      return result({ ...rowBody, outcome: "unknown", next: operationNotFoundNext(clientSwapId, "swap") }, true)
    }
    return { text: row.text, body: rowBody, isError: true }
  }
  const job = rowBody?.job
  if (job === null || typeof job !== "object" || typeof (job as Json).outcome !== "string") {
    return result(
      {
        success: false,
        clientSwapId,
        error: { code: "INVALID_RESPONSE", message: "The swap row read returned no job.", retryable: true },
      },
      true,
    )
  }
  const jobRow = job as Json
  const outcome = jobRow.outcome as string
  const rawHashes = jobRow.hashes
  const hashes = Array.isArray(rawHashes) ? rawHashes.filter((hash): hash is string => typeof hash === "string") : []
  const jobError = jobRow.error
  const withJobError = jobError !== null && typeof jobError === "object" ? { error: jobError } : {}
  const base = { clientSwapId, outcome, hashes }

  if (outcome === "confirmed" && hashes.length > 0) {
    const receipt = await get(swapReceiptPath(hashes[0] as string))
    const receiptBody = parseObject(receipt.text)
    const settlement = receiptBody?.settlement
    if (receipt.ok && settlement !== null && typeof settlement === "object") {
      return result({ success: true, ...base, receipt: "read", settlement }, false, "read", jobRow)
    }
    if (receipt.status === 404 && errorCode(receiptBody) === "RECEIPT_NOT_FOUND") {
      // The swap is known and confirmed; only this key cannot read its receipt (I3).
      return result(
        { success: true, ...base, receipt: "not_found", next: SWAP_RECEIPT_NOT_FOUND_NEXT },
        false,
        "not_found",
        jobRow,
      )
    }
    return result(
      {
        success: false,
        ...base,
        receipt: "unavailable",
        error: stepTwoError(receipt.status, receiptBody),
        next: SWAP_RECEIPT_UNAVAILABLE_NEXT,
      },
      true,
      "unavailable",
      jobRow,
    )
  }
  if ((outcome === "partial" || outcome === "indeterminate") && hashes.length > 0) {
    return result(
      { success: true, ...base, receipt: "not_written", ...withJobError, next: SWAP_RECEIPT_NOT_WRITTEN_NEXT },
      false,
      "not_written",
      jobRow,
    )
  }
  return result(
    { success: true, ...base, receipt: "no_hash", ...withJobError, next: swapReceiptNoHashNext(outcome) },
    false,
    "no_hash",
    jobRow,
  )
}

/**
 * A read that failed in transit. The `MCP_TRANSPORT` envelope the write tools use, with words for a
 * read: nothing was sent that could move funds, so the move is to read again, never to resend the
 * swap.
 */
export function swapReceiptTransportError(target: SwapReceiptTarget, thrown: unknown): string {
  const detail = thrown instanceof Error ? thrown.message : String(thrown)
  return JSON.stringify({
    ...target,
    success: false,
    error: {
      code: "MCP_TRANSPORT",
      message:
        `The receipt read failed in transit (${detail}). A read moves nothing: read again with the same ` +
        `${"hash" in target ? "hash" : "clientSwapId"}. Do not resend the swap.`,
      retryable: true,
    },
  })
}
