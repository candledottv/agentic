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
 *
 * The one-call write methods (`trade()`, `launch()`, `launchAsync()`, `selfLaunch()`,
 * `buildAtomicLaunch()`, `launchAtomic()`) also put the idempotency id they sent on every error
 * that leaves them after their first request went out: on `CandleApiError` and `JsonRpcError` as
 * extra fields, and on a `CandleOperationError` wrapped around anything else. `operationIds()`
 * reads it back from any of them. The typed outcome errors (`TradeLandedFeeLegError`,
 * `TradeLegOutcomeError`, `TradeLandedUnconfirmedError`, `SelfLaunchOutcomeError`) name the id
 * themselves and leave unwrapped.
 */

/**
 * The idempotency ids a one-call write method sent, as `operationIds()` reads them back from one
 * of its errors. The ids are not secrets and may be logged.
 */
export interface OperationIds {
  /** The id `trade()` sent. Pass it back as `clientTradeId` to replay; `getTradeJob()` reads its job. */
  clientTradeId?: string
  /** The id a launch method sent. Pass it back as `clientLaunchId`; `getLaunchJob()` reads its job. */
  clientLaunchId?: string
  /**
   * `launchAtomic()` only, once its build answered. Single-use and never resubmitted: it is here
   * for log correlation. The launch's identity is `clientLaunchId`.
   */
  bundleId?: string
}

export interface CandleRoutingDetail {
  /** Open string vocabulary for compatibility with additive server reasons. */
  reason: string
  adaptersAttempted?: string[]
  kyberAttempt?: string
}

export interface SignedTradeLeg {
  leg: "approval" | "permit2Approval" | "trade" | "feeTransfer"
  hash?: string
  nonce?: number
  outcome: "landed" | "reverted" | "pending" | "lapsed" | "forwarding" | "unknown" | "refused"
}

export interface CandleErrorPayload {
  legs?: SignedTradeLeg[]
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
  /** A headless launch's mint, once the attempt has an identity. A retry must not launch another. */
  mint?: string
  /** True when the server stored `signature` on the trade's row. */
  recorded?: boolean
  /** A Hood fee refusal's payment details: raw units owed, the quote asset id, the treasury address. */
  feeRaw?: string
  quoteAsset?: string
  treasury?: string
  /**
   * The named check behind a refusal whose `code` it shares with other causes. An open string.
   * On a repeat self-launch build: `prior_attempt_on_chain` (an earlier build of this
   * clientLaunchId landed: confirm it, do not build again), `prior_attempt_in_flight` (it can
   * still land: broadcast what was signed, or retry after `retryAfter`), `chain_read_failed`.
   */
  reason?: string
  /** Epoch milliseconds after which a retryable refusal is worth retrying, when the server knows. */
  retryAfter?: number
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
  readonly legs?: SignedTradeLeg[]
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
  /** See `CandleErrorPayload.mint`. */
  readonly mint?: string
  readonly recorded?: boolean
  readonly feeRaw?: string
  readonly quoteAsset?: string
  readonly treasury?: string
  /** See `CandleErrorPayload.reason`. */
  readonly reason?: string
  /** See `CandleErrorPayload.retryAfter`. */
  readonly retryAfter?: number
  /**
   * The idempotency id of the one-call method this error left (see `OperationIds`). Set by the
   * SDK from the request it sent, never read from the server envelope, and absent on an error
   * from any other method.
   */
  declare readonly clientTradeId?: string
  /** See `clientTradeId` above: the launch methods' id. */
  declare readonly clientLaunchId?: string
  /** See `OperationIds.bundleId`. */
  declare readonly bundleId?: string

  constructor(args: CandleErrorPayload & { status: number; retryable: boolean }) {
    super(args.message)
    this.name = "CandleApiError"
    this.legs = args.legs
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
    if (args.mint !== undefined) this.mint = args.mint
    if (args.recorded !== undefined) this.recorded = args.recorded
    if (args.feeRaw !== undefined) this.feeRaw = args.feeRaw
    if (args.quoteAsset !== undefined) this.quoteAsset = args.quoteAsset
    if (args.treasury !== undefined) this.treasury = args.treasury
    if (args.reason !== undefined) this.reason = args.reason
    if (args.retryAfter !== undefined) this.retryAfter = args.retryAfter
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

/** A Hood leg failed after this call acquired at least one transaction hash. */
export class TradeLegOutcomeError extends Error {
  readonly clientTradeId: string
  readonly leg: SignedTradeLeg["leg"]
  readonly outcome: "not-broadcast" | "reverted" | "unknown"
  readonly txHash?: string
  readonly landedLegs: Array<{ leg: SignedTradeLeg["leg"]; txHash: string }>
  override readonly cause: unknown
  constructor(args: {
    clientTradeId: string
    leg: SignedTradeLeg["leg"]
    outcome: "not-broadcast" | "reverted" | "unknown"
    txHash?: string
    landedLegs: Array<{ leg: SignedTradeLeg["leg"]; txHash: string }>
    cause: unknown
  }) {
    super(
      (args.cause instanceof Error ? args.cause.message + ". " : "") +
        "A Hood trade leg failed. Inspect txHash and landedLegs on chain; read getTradeJob(clientTradeId) or call trade with the same id and body for Candle's view. Never retry a retryable:false answer.",
      { cause: args.cause },
    )
    this.name = "TradeLegOutcomeError"
    this.clientTradeId = args.clientTradeId
    this.leg = args.leg
    this.outcome = args.outcome
    this.txHash = args.txHash
    this.landedLegs = args.landedLegs
    this.cause = args.cause
  }
}

/** All Hood legs landed, but the confirmation response was refused or lost. */
export class TradeLandedUnconfirmedError extends Error {
  readonly clientTradeId: string
  readonly tradeTxHash: string
  readonly feeTxHash?: string
  readonly stage = "executed" as const
  override readonly cause: unknown
  constructor(args: { clientTradeId: string; tradeTxHash: string; feeTxHash?: string; cause: unknown }) {
    super(
      "The trade is on chain and not booked. Read getTradeJob(clientTradeId) before calling confirmTrade again with these hashes. If the row is failed, this id cannot be recorded with /confirm; retain the hashes and do not retry or rebuild.",
      { cause: args.cause },
    )
    this.name = "TradeLandedUnconfirmedError"
    this.clientTradeId = args.clientTradeId
    this.tradeTxHash = args.tradeTxHash
    this.feeTxHash = args.feeTxHash
    this.cause = args.cause
  }
}

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

/** What `SelfLaunchOutcomeError` knows about the Hood fee transfer. See the class doc. */
export type SelfLaunchFeeOutcome = "not-required" | "not-broadcast" | "reverted" | "unknown" | "landed"

/**
 * `SelfLaunchOutcomeError`'s constructor arguments. A fee-transfer failure never claims the fee
 * landed, and a confirm failure names the landed fee hash or says the build had no fee leg.
 */
export type SelfLaunchOutcomeErrorArgs = {
  clientLaunchId: string
  createCurveTxHash: string
  cause: unknown
} & (
  | { step: "feeTransfer"; feeOutcome: "not-broadcast" | "reverted" | "unknown"; feeTxHash?: string }
  | { step: "confirm"; feeOutcome: "landed"; feeTxHash: string }
  | { step: "confirm"; feeOutcome: "not-required" }
)

function selfLaunchOutcomeMessage(args: SelfLaunchOutcomeErrorArgs): string {
  const reason = args.cause instanceof Error ? args.cause.message : String(args.cause)
  const feeTxHash = "feeTxHash" in args ? args.feeTxHash : undefined
  const head =
    `launch executed; ${args.step === "confirm" ? "confirmation" : "fee"} incomplete: the Hood curve is on chain ` +
    `(createCurveTxHash ${args.createCurveTxHash}, clientLaunchId ${args.clientLaunchId}), and a later step ` +
    `failed (${reason}). Do NOT call selfLaunch() or buildSelfLaunch() again for this attempt, under this id ` +
    `or a new one: a rebuild can create a second curve. Keep the id and every hash on this error.`
  const confirmWith = (fee: string) =>
    `confirmSelfLaunch({ clientLaunchId, signature: createCurveTxHash${fee} }) for clientLaunchId ${args.clientLaunchId}`
  if (args.step === "confirm") {
    const fee =
      args.feeOutcome === "landed"
        ? `The fee transfer landed (feeTxHash ${feeTxHash}).`
        : "This build had no fee transfer, so none is owed."
    return (
      `${head} ${fee} The confirm call was refused or its answer was lost, so Candle may or may not have ` +
      `recorded the launch: read getLaunchJob(clientLaunchId). If the job is not confirmed and this error's ` +
      `cause allows it, call ${confirmWith(args.feeOutcome === "landed" ? ", feeTxHash" : "")} with these same ` +
      `hashes. Nothing needs signing or sending.`
    )
  }
  if (args.feeOutcome === "unknown") {
    return (
      `${head} The fee transfer MAY have paid: its outcome is unknown. Do NOT pay it again. ` +
      (feeTxHash
        ? `Check feeTxHash ${feeTxHash} and the payer wallet's history; a hash alone does not prove payment. `
        : "Its hash is not known: reconcile the payer wallet's transactions before any payment decision. ") +
      `Once that exact fee is verified successful, call ${confirmWith(", feeTxHash")}.`
    )
  }
  const proof =
    args.feeOutcome === "reverted"
      ? `its receipt reverted${feeTxHash ? ` (feeTxHash ${feeTxHash})` : ""}`
      : `it was not broadcast${feeTxHash ? ` (feeTxHash ${feeTxHash} names the refused transaction, not a payment)` : ""}`
  return (
    `${head} The fee transfer did NOT pay: ${proof}. The launch is not recorded without it. Pay only the ` +
    `missing fee, to the original build's treasury in its quote asset and raw amount, then call ` +
    `${confirmWith(", feeTxHash")} with the successful fee hash.`
  )
}

/**
 * Thrown by `selfLaunch()` on Hood when the create-curve transaction was mined successfully and
 * the fee transfer or the confirm call then failed. The curve exists, so a second `selfLaunch()`
 * or `buildSelfLaunch()` for this attempt, under the same id or a new one, can create a SECOND
 * curve. Persist `clientLaunchId`, `createCurveTxHash` and `feeTxHash` before recovering.
 *
 * `stage: "executed"` means the create-curve transaction succeeded. It does not say Candle
 * recorded the launch or collected a fee: on `step: "confirm"` the answer may have been lost
 * after the launch was booked, so read `getLaunchJob(clientLaunchId)` first.
 *
 * `step` and `feeOutcome` say which recovery is safe:
 * - `confirm` with `landed` (the fee paid, `feeTxHash` is its hash) or `not-required` (the build
 *   had no fee leg, `feeTxHash` is absent): once the job read and `cause` allow it, call
 *   `confirmSelfLaunch({ clientLaunchId, signature: createCurveTxHash, feeTxHash? })` with these
 *   same hashes. Nothing is signed or sent.
 * - `feeTransfer` with `unknown`: the broadcast or the receipt read did not say whether the fee
 *   paid. Do not pay again. Check `feeTxHash` and the payer's history, then confirm with that
 *   same hash once the fee is verified.
 * - `feeTransfer` with `not-broadcast` or `reverted`: the fee did not pay. Complete only the
 *   missing fee with the original build's treasury, quote asset and raw amount, then confirm with
 *   the create-curve hash and the successful fee hash.
 *
 * `feeTxHash` is every fee hash this call learned, including a refused or reverted one. A hash
 * alone does not prove payment. There is no `retryable` field: the original error is `cause`,
 * untouched, with its own `code`, `status`, `retryable` and `reason` when it is a
 * `CandleApiError`.
 */
export class SelfLaunchOutcomeError extends Error {
  override readonly name = "SelfLaunchOutcomeError" as const
  readonly chain = "hood" as const
  readonly clientLaunchId: string
  /** The successfully mined create-curve transaction. */
  readonly createCurveTxHash: string
  readonly stage = "executed" as const
  /** The step that failed after the curve landed. */
  readonly step: "feeTransfer" | "confirm"
  readonly feeOutcome: SelfLaunchFeeOutcome
  /**
   * Set whenever a fee hash is known, whatever `feeOutcome` says about it. Declared, not
   * initialized: with no known hash the property is absent, not `undefined`.
   */
  declare readonly feeTxHash?: string
  /** The value the failed step originally threw or was rejected with. */
  override readonly cause: unknown

  constructor(args: SelfLaunchOutcomeErrorArgs) {
    super(selfLaunchOutcomeMessage(args), { cause: args.cause })
    this.clientLaunchId = args.clientLaunchId
    this.createCurveTxHash = args.createCurveTxHash
    this.step = args.step
    this.feeOutcome = args.feeOutcome
    if ("feeTxHash" in args && args.feeTxHash !== undefined) this.feeTxHash = args.feeTxHash
    this.cause = args.cause
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
  /**
   * The idempotency id of the one-call method this error left (see `OperationIds`). Set by the
   * SDK; absent when the error came from `broadcastSignedTransaction()` called directly.
   */
  declare readonly clientTradeId?: string
  /** See `clientTradeId` above: the launch methods' id. */
  declare readonly clientLaunchId?: string
  /** See `OperationIds.bundleId`. */
  declare readonly bundleId?: string

  constructor(args: { code: number; message: string; data?: unknown }) {
    super(args.message)
    this.name = "JsonRpcError"
    this.code = args.code
    this.data = args.data
  }
}

/**
 * Which of the two recovery messages a `CandleOperationError` carries. Chosen by the flow the
 * method was running, never by the stage it failed at, because agent callers act on the text.
 *
 * - `server-executed`: Candle broadcasts (`trade({ from: "main" })`, `launch()`, `launchAsync()`,
 *   `buildAtomicLaunch()`, `launchAtomic()`). A same-id call is a replay.
 * - `caller-broadcast`: the caller signs and broadcasts (`selfLaunch()`, `trade()` with a linked
 *   payer). A same-id call can sign and broadcast a second transaction (BE-1126), so the message
 *   never says to retry with the id.
 */
export type OperationFlow = "server-executed" | "caller-broadcast"

function operationErrorMessage(cause: unknown, ids: OperationIds, flow: OperationFlow): string {
  const original = cause instanceof Error ? cause.message : String(cause)
  const isTrade = ids.clientTradeId !== undefined
  const idName = isTrade ? "clientTradeId" : "clientLaunchId"
  const noun = isTrade ? "trade" : "launch"
  const read = isTrade ? "getTradeJob()" : "getLaunchJob()"
  const bundle =
    ids.bundleId !== undefined ? ` (bundleId ${ids.bundleId}, single-use: for logs only, never resubmitted)` : ""
  const head =
    `${original} -- ${idName} ${ids.clientTradeId ?? ids.clientLaunchId}${bundle}: ` +
    "the request may or may not have reached Candle."
  const tail = `A call with a new id, or with none, is a second, independent ${noun}.`
  if (flow === "server-executed") {
    return `${head} Read the job for this id (${read}), or retry the call with this same ${idName} and the same request. ${tail}`
  }
  return (
    `${head} This id identifies the job: read the job for this id (${read}), and check the wallet's recent ` +
    `transactions before sending again, because a call under the same id can sign and broadcast a second ` +
    `transaction. ${tail}`
  )
}

/**
 * Thrown by a one-call write method (`trade()`, `launch()`, `launchAsync()`, `selfLaunch()`,
 * `buildAtomicLaunch()`, `launchAtomic()`) when it fails, after its first request was sent, with
 * anything that is not already a `CandleApiError`, `JsonRpcError` or one of the typed outcome
 * errors (`TradeLandedFeeLegError`, `TradeLegOutcomeError`, `TradeLandedUnconfirmedError`,
 * `SelfLaunchOutcomeError`): a rejected `fetch` (a lost response, a proxy timeout, a socket reset), a 2xx body that is not
 * JSON, a plain `Error` from one of the method's own steps, or a thrown value that is not an
 * `Error`. The original is `cause`, untouched.
 *
 * The request may or may not have reached Candle, so this error carries the idempotency id the
 * method sent: without it the only retry is a call with a new id, which is a second trade or
 * launch. `message` starts with the original message, then names the id and says what to do with
 * it. It has two forms (see `OperationFlow`): a server-executed flow says to read the job or
 * retry with the same id; `selfLaunch()` and a linked `trade()` say to read the job and check the
 * wallet's recent transactions first, because a same-id call there can broadcast again.
 *
 * An error is wrapped once, at the outermost method, so `cause` is never a `CandleOperationError`.
 */
export class CandleOperationError extends Error {
  /** See `OperationIds.clientTradeId`. */
  declare readonly clientTradeId?: string
  /** See `OperationIds.clientLaunchId`. */
  declare readonly clientLaunchId?: string
  /** See `OperationIds.bundleId`. */
  declare readonly bundleId?: string
  /** The value the method originally threw or was rejected with. */
  declare readonly cause: unknown

  constructor(args: { cause: unknown; ids: OperationIds; flow: OperationFlow }) {
    super(operationErrorMessage(args.cause, args.ids, args.flow), { cause: args.cause })
    this.name = "CandleOperationError"
    Object.assign(this, definedIds(args.ids))
  }
}

function definedIds(ids: OperationIds): OperationIds {
  return {
    ...(typeof ids.clientTradeId === "string" ? { clientTradeId: ids.clientTradeId } : {}),
    ...(typeof ids.clientLaunchId === "string" ? { clientLaunchId: ids.clientLaunchId } : {}),
    ...(typeof ids.bundleId === "string" ? { bundleId: ids.bundleId } : {}),
  }
}

/**
 * The idempotency ids on an error from a one-call write method, so a `catch (error: unknown)`
 * block needs no cast: `{ clientTradeId?, clientLaunchId?, bundleId? }` from a `CandleApiError`,
 * `JsonRpcError`, `TradeLandedFeeLegError`, `TradeLegOutcomeError`, `TradeLandedUnconfirmedError`,
 * `SelfLaunchOutcomeError` or `CandleOperationError`, and `{}` from anything else.
 *
 * `{}` means nothing was sent (a missing API key, for example), so there is nothing to replay.
 */
export function operationIds(error: unknown): OperationIds {
  if (
    error instanceof CandleApiError ||
    error instanceof JsonRpcError ||
    error instanceof TradeLandedFeeLegError ||
    error instanceof TradeLegOutcomeError ||
    error instanceof TradeLandedUnconfirmedError ||
    error instanceof SelfLaunchOutcomeError ||
    error instanceof CandleOperationError
  ) {
    return definedIds(error)
  }
  return {}
}

/**
 * SDK-internal (client.ts), not exported from the package root: the error a one-call method
 * throws for `error`, carrying `ids`. A `CandleApiError` or `JsonRpcError` is the SAME object
 * with the ids set on it as own, enumerable properties. A `TradeLandedFeeLegError` already names
 * its `clientTradeId` and passes through, as do the other typed outcome errors, among them
 * `SelfLaunchOutcomeError` with its `clientLaunchId`. Anything else is wrapped in a
 * `CandleOperationError`.
 */
export function withOperationIds(error: unknown, ids: OperationIds, flow: OperationFlow): unknown {
  if (error instanceof CandleApiError || error instanceof JsonRpcError) return Object.assign(error, definedIds(ids))
  if (
    error instanceof TradeLandedFeeLegError ||
    error instanceof TradeLegOutcomeError ||
    error instanceof TradeLandedUnconfirmedError ||
    error instanceof SelfLaunchOutcomeError
  )
    return error
  // Never a wrapper around a wrapper: keep the original as `cause` and the ids it already named.
  if (error instanceof CandleOperationError) {
    return new CandleOperationError({ cause: error.cause, ids: { ...operationIds(error), ...definedIds(ids) }, flow })
  }
  return new CandleOperationError({ cause: error, ids, flow })
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
    ...(Array.isArray(error.legs) ? { legs: error.legs as SignedTradeLeg[] } : {}),
    ...(typeof error.stage === "string" ? { stage: error.stage } : {}),
    ...(typeof error.signature === "string" ? { signature: error.signature } : {}),
    ...(typeof error.mint === "string" ? { mint: error.mint } : {}),
    ...(typeof error.recorded === "boolean" ? { recorded: error.recorded } : {}),
    ...(typeof error.feeRaw === "string" ? { feeRaw: error.feeRaw } : {}),
    ...(typeof error.quoteAsset === "string" ? { quoteAsset: error.quoteAsset } : {}),
    ...(typeof error.treasury === "string" ? { treasury: error.treasury } : {}),
    ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
    ...(typeof error.retryAfter === "number" ? { retryAfter: error.retryAfter } : {}),
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
