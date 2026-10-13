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
 * reads it back from any of them.
 */
/**
 * The idempotency ids a one-call write method sent, as `operationIds()` reads them back from one
 * of its errors. The ids are not secrets and may be logged.
 */
export interface OperationIds {
    /** The id `trade()` sent. Pass it back as `clientTradeId` to replay; `getTradeJob()` reads its job. */
    clientTradeId?: string;
    /** The id a launch method sent. Pass it back as `clientLaunchId`; `getLaunchJob()` reads its job. */
    clientLaunchId?: string;
    /**
     * `launchAtomic()` only, once its build answered. Single-use and never resubmitted: it is here
     * for log correlation. The launch's identity is `clientLaunchId`.
     */
    bundleId?: string;
}
export interface CandleRoutingDetail {
    /** Open string vocabulary for compatibility with additive server reasons. */
    reason: string;
    adaptersAttempted?: string[];
    kyberAttempt?: string;
}
export interface CandleErrorPayload {
    routing?: CandleRoutingDetail;
    discovery?: Record<string, unknown>;
    coverage?: unknown;
    uiHint?: string;
    docsPath?: string;
    code: string;
    message: string;
    field?: string;
    retryable?: boolean;
    /**
     * How far a trade got when the refusal was answered (`"executed"` / `"reverted"`). A trade that
     * is `"executed"` is on chain: do not build it again.
     */
    stage?: string;
    /** The transaction the refusal is about (the landed trade's hash or signature), when known. */
    signature?: string;
    /** A headless launch's mint, once the attempt has an identity. A retry must not launch another. */
    mint?: string;
    /** True when the server stored `signature` on the trade's row. */
    recorded?: boolean;
    /** A Hood fee refusal's payment details: raw units owed, the quote asset id, the treasury address. */
    feeRaw?: string;
    quoteAsset?: string;
    treasury?: string;
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
export declare const BRIDGE_ERROR_CODES: readonly ["BRIDGE_DESTINATION_MISSING", "RELAY_STEP_REFUSED", "BRIDGE_IN_FLIGHT"];
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export declare class CandleApiError extends Error {
    /** The envelope's `error.code`, or `"HTTP_" + status` for non-envelope responses. */
    readonly code: string;
    /** HTTP status of the response that produced this error. */
    readonly status: number;
    /** The envelope's retryability hint; always false for non-envelope responses. */
    readonly retryable: boolean;
    /** Present only for field-level validation errors. */
    readonly field?: string;
    readonly routing?: CandleRoutingDetail;
    readonly discovery?: Record<string, unknown>;
    readonly coverage?: unknown;
    readonly uiHint?: string;
    readonly docsPath?: string;
    /** See `CandleErrorPayload.stage`. Present when the server says how far the trade got. */
    readonly stage?: string;
    /** See `CandleErrorPayload.signature`. */
    readonly signature?: string;
    /** See `CandleErrorPayload.mint`. */
    readonly mint?: string;
    readonly recorded?: boolean;
    readonly feeRaw?: string;
    readonly quoteAsset?: string;
    readonly treasury?: string;
    /**
     * The idempotency id of the one-call method this error left (see `OperationIds`). Set by the
     * SDK from the request it sent, never read from the server envelope, and absent on an error
     * from any other method.
     */
    readonly clientTradeId?: string;
    /** See `clientTradeId` above: the launch methods' id. */
    readonly clientLaunchId?: string;
    /** See `OperationIds.bundleId`. */
    readonly bundleId?: string;
    constructor(args: CandleErrorPayload & {
        status: number;
        retryable: boolean;
    });
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
export declare class TradeLandedFeeLegError extends Error {
    readonly clientTradeId: string;
    readonly tradeTxHash: string;
    /** Set once the fee transaction hash is known, including when its broadcast or receipt is unknown. */
    readonly feeTxHash?: string;
    readonly feeOutcome: "not-broadcast" | "reverted" | "unknown";
    readonly stage: "executed";
    constructor(args: {
        clientTradeId: string;
        tradeTxHash: string;
        cause: unknown;
        feeOutcome: "not-broadcast" | "reverted" | "unknown";
        feeTxHash?: string;
    });
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
    err: unknown;
    logs: string[];
}
/**
 * Whether a `JsonRpcError.data` carries the Solana `{ err, logs }` shape.
 *
 * Checks `logs` is an array of strings rather than trusting the key's presence, because that is
 * the field callers iterate and a non-array there would throw at the call site instead of here.
 */
export declare function isSolanaRpcErrorData(data: unknown): data is SolanaRpcErrorData;
export declare class JsonRpcError extends Error {
    /** The JSON-RPC error's numeric code, e.g. -32002. */
    readonly code: number;
    /** The JSON-RPC error's `data` field, verbatim. Solana: typically `{ err, logs }`. */
    readonly data: unknown;
    /**
     * The idempotency id of the one-call method this error left (see `OperationIds`). Set by the
     * SDK; absent when the error came from `broadcastSignedTransaction()` called directly.
     */
    readonly clientTradeId?: string;
    /** See `clientTradeId` above: the launch methods' id. */
    readonly clientLaunchId?: string;
    /** See `OperationIds.bundleId`. */
    readonly bundleId?: string;
    constructor(args: {
        code: number;
        message: string;
        data?: unknown;
    });
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
export type OperationFlow = "server-executed" | "caller-broadcast";
/**
 * Thrown by a one-call write method (`trade()`, `launch()`, `launchAsync()`, `selfLaunch()`,
 * `buildAtomicLaunch()`, `launchAtomic()`) when it fails, after its first request was sent, with
 * anything that is not already a `CandleApiError`, `JsonRpcError` or `TradeLandedFeeLegError`: a
 * rejected `fetch` (a lost response, a proxy timeout, a socket reset), a 2xx body that is not
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
export declare class CandleOperationError extends Error {
    /** See `OperationIds.clientTradeId`. */
    readonly clientTradeId?: string;
    /** See `OperationIds.clientLaunchId`. */
    readonly clientLaunchId?: string;
    /** See `OperationIds.bundleId`. */
    readonly bundleId?: string;
    /** The value the method originally threw or was rejected with. */
    readonly cause: unknown;
    constructor(args: {
        cause: unknown;
        ids: OperationIds;
        flow: OperationFlow;
    });
}
/**
 * The idempotency ids on an error from a one-call write method, so a `catch (error: unknown)`
 * block needs no cast: `{ clientTradeId?, clientLaunchId?, bundleId? }` from a `CandleApiError`,
 * `JsonRpcError`, `TradeLandedFeeLegError` or `CandleOperationError`, and `{}` from anything else.
 *
 * `{}` means nothing was sent (a missing API key, for example), so there is nothing to replay.
 */
export declare function operationIds(error: unknown): OperationIds;
/**
 * SDK-internal (client.ts), not exported from the package root: the error a one-call method
 * throws for `error`, carrying `ids`. A `CandleApiError` or `JsonRpcError` is the SAME object
 * with the ids set on it as own, enumerable properties. A `TradeLandedFeeLegError` already names
 * its `clientTradeId` and passes through. Anything else is wrapped in a `CandleOperationError`.
 */
export declare function withOperationIds(error: unknown, ids: OperationIds, flow: OperationFlow): unknown;
/** Builds the `CandleApiError` for a non-2xx response body (envelope-aware, see module doc). */
export declare function candleApiErrorFromResponse(status: number, bodyText: string): CandleApiError;
//# sourceMappingURL=errors.d.ts.map