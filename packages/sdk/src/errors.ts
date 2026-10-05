/**
 * Structured errors for the Candle agent SDK.
 *
 * The Candle API's error contract (docs/headless-launch.md, Errors) is a structured envelope:
 * `{ success: false, error: { code, message, field?, retryable } }`. Every non-2xx response
 * that parses to that envelope throws a `CandleApiError` carrying the envelope's fields plus
 * the HTTP status. A non-2xx response that is NOT an envelope (a proxy error page, or one of
 * the legacy plain-shape endpoints like activity/report and the users routes) still throws
 * `CandleApiError`, with `code: "HTTP_" + status` and `retryable: false`, so callers always
 * catch one error type and always branch on `code`, never on `message`.
 */

export interface CandleRoutingDetail {
  /** Open string vocabulary for compatibility with additive server reasons. */
  reason: string
  adaptersAttempted?: string[]
  kyberAttempt?: string
}

export interface CandleErrorPayload {
  routing?: CandleRoutingDetail
  discovery?: Record<string, unknown>
  coverage?: unknown
  uiHint?: string
  docsPath?: string
  code: string
  message: string
  field?: string
  retryable?: boolean
  /**
   * How far a trade got when the refusal was answered (`"executed"` / `"reverted"`). A trade that
   * is `"executed"` is on chain: do not build it again.
   */
  stage?: string
  /** The transaction the refusal is about (the landed trade's hash or signature), when known. */
  signature?: string
  /** True when the server stored `signature` on the trade's row. */
  recorded?: boolean
  /** A Hood fee refusal's payment details: raw units owed, the quote asset id, the treasury address. */
  feeRaw?: string
  quoteAsset?: string
  treasury?: string
}

/**
 * The codes a TEE bridge between Solana and Hood adds (Ember Phase 4c). `code` stays an open
 * string; these are named so a caller can branch on them without spelling them.
 *
 * - `BRIDGE_DESTINATION_MISSING` (400): this key has no eligible TEE wallet on the other chain, or
 *   more than one and no `toWalletId`. Promote one onto the key, or name it.
 * - `RELAY_STEP_REFUSED` (502): Relay answered with a deposit Candle will not sign. Nothing was
 *   stamped; a later quote may pass.
 * - `BRIDGE_IN_FLIGHT` (409, or 503 when the state could not be read): a bridge into or out of
 *   the wallet is still open inside its two hours, so the sweep is not recorded. Retry once
 *   `GET /api/v1/agent/swap/jobs/{clientTradeId}` shows it closed or the two hours pass.
 */
export const BRIDGE_ERROR_CODES = ["BRIDGE_DESTINATION_MISSING", "RELAY_STEP_REFUSED", "BRIDGE_IN_FLIGHT"] as const
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

export class CandleApiError extends Error {
  /** The envelope's `error.code`, or `"HTTP_" + status` for non-envelope responses. */
  readonly code: string
  /** HTTP status of the response that produced this error. */
  readonly status: number
  /** The envelope's retryability hint; always false for non-envelope responses. */
  readonly retryable: boolean
  /** Present only for field-level validation errors. */
  readonly field?: string
  readonly routing?: CandleRoutingDetail
  readonly discovery?: Record<string, unknown>
  readonly coverage?: unknown
  readonly uiHint?: string
  readonly docsPath?: string
  /** See `CandleErrorPayload.stage`. Present when the server says how far the trade got. */
  readonly stage?: string
  /** See `CandleErrorPayload.signature`. */
  readonly signature?: string
  readonly recorded?: boolean
  readonly feeRaw?: string
  readonly quoteAsset?: string
  readonly treasury?: string

  constructor(args: CandleErrorPayload & { status: number; retryable: boolean }) {
    super(args.message)
    this.name = "CandleApiError"
    this.code = args.code
    this.status = args.status
    this.retryable = args.retryable
    if (args.field !== undefined) this.field = args.field
    this.routing = args.routing
    this.discovery = args.discovery
    this.coverage = args.coverage
    this.uiHint = args.uiHint
    this.docsPath = args.docsPath
    if (args.stage !== undefined) this.stage = args.stage
    if (args.signature !== undefined) this.signature = args.signature
    if (args.recorded !== undefined) this.recorded = args.recorded
    if (args.feeRaw !== undefined) this.feeRaw = args.feeRaw
    if (args.quoteAsset !== undefined) this.quoteAsset = args.quoteAsset
    if (args.treasury !== undefined) this.treasury = args.treasury
  }
}

/**
 * Thrown by `trade()` on Hood when the trade leg landed and the fee leg then failed or its
 * outcome is unknown. The trade is on chain, so rebuilding it would be a SECOND trade.
 *
 * `feeOutcome` says which recovery is safe:
 * - `not-broadcast` / `reverted`: the fee was not sent, or its receipt reverted. Pay the fee,
 *   then `confirmTrade({ clientTradeId, tradeTxHash, feeTxHash })` with the new payment.
 * - `unknown`: the broadcast or the receipt read did not say whether the fee landed. `feeTxHash`
 *   is that payment once it is known. Do not pay again. Re-confirm this clientTradeId with that
 *   same hash.
 */
export class TradeLandedFeeLegError extends Error {
  readonly clientTradeId: string
  readonly tradeTxHash: string
  /** Set once the fee transaction hash is known, including when its broadcast or receipt is unknown. */
  readonly feeTxHash?: string
  readonly feeOutcome: "not-broadcast" | "reverted" | "unknown"
  readonly stage = "executed" as const

  constructor(args: {
    clientTradeId: string
    tradeTxHash: string
    cause: unknown
    feeOutcome: "not-broadcast" | "reverted" | "unknown"
    feeTxHash?: string
  }) {
    const reason = args.cause instanceof Error ? args.cause.message : String(args.cause)
    const recover =
      args.feeOutcome === "unknown"
        ? args.feeTxHash
          ? `Do NOT repeat the trade. Do NOT pay again: the fee may already be pending or mined. Check feeTxHash ` +
            `${args.feeTxHash} and re-confirm clientTradeId ${args.clientTradeId} with tradeTxHash ` +
            `${args.tradeTxHash} and that same feeTxHash.`
          : `Do NOT repeat the trade. Do NOT pay again: the fee broadcast outcome is unknown and it may already ` +
            `be pending or mined. Check the payer wallet before any new payment, then re-confirm clientTradeId ` +
            `${args.clientTradeId} with tradeTxHash ${args.tradeTxHash} and the fee hash you find.`
        : `Do NOT repeat the trade: pay the fee, then call confirmTrade for clientTradeId ${args.clientTradeId} ` +
          `with tradeTxHash and the fee's feeTxHash.`
    super(
      `trade executed; fee/booking incomplete: the trade landed (tradeTxHash ${args.tradeTxHash}) but its fee ` +
        `transfer ${args.feeOutcome === "unknown" ? "outcome is unknown" : "failed"} (${reason}). The trade is ` +
        `NOT confirmed or booked. ${recover}`,
      { cause: args.cause },
    )
    this.name = "TradeLandedFeeLegError"
    this.clientTradeId = args.clientTradeId
    this.tradeTxHash = args.tradeTxHash
    this.feeOutcome = args.feeOutcome
    if (args.feeTxHash !== undefined) this.feeTxHash = args.feeTxHash
  }
}

/**
 * Structured error thrown by the SDK's internal `jsonRpcCall()`/`jsonRpcCallRaw()` (client.ts)
 * when a Solana or EVM JSON-RPC endpoint responds with a JSON-RPC `error` envelope. Unlike a
 * plain `Error`, this carries the RPC error's numeric `code` and its `data` field intact -- for a
 * Solana `-32002` "Transaction simulation failed", `data` is typically `{ err, logs }`, naming
 * the actual on-chain failure (e.g. `err: "BlockhashNotFound"`) that the top-level `message`
 * alone does not surface. `broadcastSignedTransaction()` lets this propagate unchanged, and the
 * `selfLaunch()` inspects `.data.err` to decide whether a failed broadcast is a blockhash expiry
 * worth rebuilding and retrying. `trade()` no longer does: it hands broadcast to the server and
 * has no client-side rebuild loop, so nothing there reads this field. (This sentence used to
 * name both; corrected 2026-08-27 after an integrator found the pair of claims disagreed.)
 */
/**
 * The shape a Solana JSON-RPC error's `data` takes for a failed simulation or send.
 *
 * `JsonRpcError.data` stays `unknown`, deliberately: it is a third party's field and a different
 * endpoint may answer with anything. But the doc above has always told callers what to expect,
 * so the type is exported rather than left for each integration to hand-roll -- pair it with
 * `isSolanaRpcErrorData` instead of asserting.
 *
 * `logs` is the FULL array, untruncated. The preview inside `JsonRpcError.message` is three
 * lines from the tail; anything doing real diagnosis should read this.
 */
export interface SolanaRpcErrorData {
  /** The on-chain failure, e.g. `"BlockhashNotFound"` or `{ InstructionError: [3, ...] }`. */
  err: unknown
  logs: string[]
}

/**
 * Whether a `JsonRpcError.data` carries the Solana `{ err, logs }` shape.
 *
 * Checks `logs` is an array of strings rather than trusting the key's presence, because that is
 * the field callers iterate and a non-array there would throw at the call site instead of here.
 */
export function isSolanaRpcErrorData(data: unknown): data is SolanaRpcErrorData {
  if (typeof data !== "object" || data === null) return false
  const candidate = data as { err?: unknown; logs?: unknown }
  if (!("err" in candidate)) return false
  return Array.isArray(candidate.logs) && candidate.logs.every((line) => typeof line === "string")
}

export class JsonRpcError extends Error {
  /** The JSON-RPC error's numeric code, e.g. -32002. */
  readonly code: number
  /** The JSON-RPC error's `data` field, verbatim. Solana: typically `{ err, logs }`. */
  readonly data: unknown

  constructor(args: { code: number; message: string; data?: unknown }) {
    super(args.message)
    this.name = "JsonRpcError"
    this.code = args.code
    this.data = args.data
  }
}

/** Extracts the structured error payload when `body` is a Candle error envelope; null otherwise. */
function envelopeError(body: unknown): CandleErrorPayload | null {
  if (typeof body !== "object" || body === null) return null
  const candidate = body as { success?: unknown; error?: unknown }
  if (candidate.success !== false) return null
  if (typeof candidate.error !== "object" || candidate.error === null) return null
  const error = candidate.error as Record<string, unknown>
  if (typeof error.code !== "string" || typeof error.message !== "string") return null
  return {
    ...(typeof error.routing === "object" &&
    error.routing !== null &&
    typeof (error.routing as CandleRoutingDetail).reason === "string"
      ? { routing: error.routing as CandleRoutingDetail }
      : {}),
    ...(typeof error.discovery === "object" && error.discovery !== null
      ? { discovery: error.discovery as Record<string, unknown> }
      : {}),
    ...(error.coverage !== undefined ? { coverage: error.coverage } : {}),
    ...(typeof error.uiHint === "string" ? { uiHint: error.uiHint } : {}),
    ...(typeof error.docsPath === "string" ? { docsPath: error.docsPath } : {}),
    code: error.code,
    message: error.message,
    ...(typeof error.field === "string" ? { field: error.field } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(typeof error.stage === "string" ? { stage: error.stage } : {}),
    ...(typeof error.signature === "string" ? { signature: error.signature } : {}),
    ...(typeof error.recorded === "boolean" ? { recorded: error.recorded } : {}),
    ...(typeof error.feeRaw === "string" ? { feeRaw: error.feeRaw } : {}),
    ...(typeof error.quoteAsset === "string" ? { quoteAsset: error.quoteAsset } : {}),
    ...(typeof error.treasury === "string" ? { treasury: error.treasury } : {}),
  }
}

/** Builds the `CandleApiError` for a non-2xx response body (envelope-aware, see module doc). */
export function candleApiErrorFromResponse(status: number, bodyText: string): CandleApiError {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    parsed = undefined
  }
  const payload = envelopeError(parsed)
  if (payload) {
    return new CandleApiError({
      ...payload,
      code: payload.code,
      message: payload.message,
      status,
      retryable: payload.retryable === true,
      ...(payload.field !== undefined ? { field: payload.field } : {}),
    })
  }
  return new CandleApiError({
    code: `HTTP_${status}`,
    message: bodyText || `HTTP ${status}`,
    status,
    retryable: false,
  })
}
