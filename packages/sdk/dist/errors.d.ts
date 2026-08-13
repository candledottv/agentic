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
export interface CandleErrorPayload {
    code: string;
    message: string;
    field?: string;
    retryable?: boolean;
}
export declare class CandleApiError extends Error {
    /** The envelope's `error.code`, or `"HTTP_" + status` for non-envelope responses. */
    readonly code: string;
    /** HTTP status of the response that produced this error. */
    readonly status: number;
    /** The envelope's retryability hint; always false for non-envelope responses. */
    readonly retryable: boolean;
    /** Present only for field-level validation errors. */
    readonly field?: string;
    constructor(args: {
        code: string;
        message: string;
        status: number;
        retryable: boolean;
        field?: string;
    });
}
/**
 * Structured error thrown by the SDK's internal `jsonRpcCall()`/`jsonRpcCallRaw()` (client.ts)
 * when a Solana or EVM JSON-RPC endpoint responds with a JSON-RPC `error` envelope. Unlike a
 * plain `Error`, this carries the RPC error's numeric `code` and its `data` field intact -- for a
 * Solana `-32002` "Transaction simulation failed", `data` is typically `{ err, logs }`, naming
 * the actual on-chain failure (e.g. `err: "BlockhashNotFound"`) that the top-level `message`
 * alone does not surface. `broadcastSignedTransaction()` lets this propagate unchanged, and the
 * Solana linked one-shots (`trade()`/`selfLaunch()`) inspect `.data.err` to decide whether a
 * failed broadcast is a blockhash-expiry worth rebuilding and retrying.
 */
export declare class JsonRpcError extends Error {
    /** The JSON-RPC error's numeric code, e.g. -32002. */
    readonly code: number;
    /** The JSON-RPC error's `data` field, verbatim. Solana: typically `{ err, logs }`. */
    readonly data: unknown;
    constructor(args: {
        code: number;
        message: string;
        data?: unknown;
    });
}
/** Builds the `CandleApiError` for a non-2xx response body (envelope-aware, see module doc). */
export declare function candleApiErrorFromResponse(status: number, bodyText: string): CandleApiError;
//# sourceMappingURL=errors.d.ts.map