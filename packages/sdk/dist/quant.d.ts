/**
 * Quant over an agent key (BE-1678's `/api/v1/agent/quant/*`; spec S5 Q-2, BE-1737): a plain HTTP
 * client for the five key routes, with the route spec's timing rules. It holds no state: the caller
 * keeps the `clientTurnId`, the poll cursor and anything it shows.
 *
 *   GET  /status                     5 s
 *   POST /turns {text, clientTurnId}  5 s   (resend the same `clientTurnId` after a lost answer)
 *   GET  /turns/:id/events?after=    35 s  (one held poll, about 25 s on the server)
 *   POST /turns/:id/cancel           5 s
 *   GET  /history?before=&limit=     5 s
 *
 * A refusal is read as `body.code ?? body.error?.code`: the Quant handlers answer `{code, ...}` (the
 * relay shape), the key middleware answers `{success: false, error: {code}}` (the envelope shape),
 * and `RATE_LIMITED` comes in both, meaning different limits. `shape` says which one arrived.
 *
 * The key is sent as `x-api-key` and never follows a redirect (`redirect: "error"`), so it cannot be
 * forwarded to another host. Use a Read key (`account:read`): Quant needs nothing more.
 *
 * Dependency-free on purpose. The CLI carries a byte-identical copy (`packages/cli/src/quant.ts`,
 * kept equal by `quant.drift.test.ts`). Copy any change verbatim:
 * `cp packages/sdk/src/quant.ts packages/cli/src/quant.ts`.
 */
export declare const QUANT_AGENT_PATH = "/api/v1/agent/quant";
export declare const QUANT_CALL_TIMEOUT_MS = 5000;
export declare const QUANT_POLL_TIMEOUT_MS = 35000;
/** hacc's B0 figure, used until a status read says otherwise (the route's `DEFAULT_MAX_TEXT_CHARS`). */
export declare const QUANT_DEFAULT_MAX_TEXT_CHARS = 4000;
/** `GET /status`. With the switch off the route answers `{enabled: false}` and nothing else. */
export interface QuantKeyStatus {
    enabled: boolean;
    allowed?: boolean;
    tier?: string | null;
    marketAccess?: boolean;
    linked?: boolean;
    remaining?: number | null;
    maxTextChars?: number | null;
    activeTurnId?: string | null;
}
export interface QuantTurnStarted {
    turnId: string;
    cursor?: number;
}
/** One event of a turn: `turn_started`, `working`, `tool_started`, `tool_finished`, `text`, `done`, `error`. */
export interface QuantTurnEvent {
    seq: number;
    kind: string;
    data: Record<string, unknown>;
    createdAt?: string;
}
export interface QuantEventsPage {
    events: QuantTurnEvent[];
    next: number;
    /** `running`, or the terminal state (`done`, `error`, `cancelled`, ...). */
    status: string;
}
export interface QuantHistoryItem {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
}
export interface QuantHistoryPage {
    items: QuantHistoryItem[];
    next: string | null;
}
/**
 * Why a call did not succeed. `shape` is `relay` for `{code}`, `envelope` for `{error: {code}}`, and
 * `transport` when no answer arrived (`NETWORK_ERROR`, `TIMEOUT`) or it could not be read
 * (`BAD_RESPONSE`): a lost answer to `POST /turns` is safe to resend with the same `clientTurnId`.
 */
export interface QuantRefusal {
    code: string;
    status: number;
    shape: "relay" | "envelope" | "transport";
    retryable?: boolean;
    resetsAt?: string | number;
    turnId?: string;
    limit?: number;
}
export type QuantAnswer<T> = {
    ok: true;
    status: number;
    body: T;
} | {
    ok: false;
    refusal: QuantRefusal;
};
export interface QuantKeyClientOptions {
    apiUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
    callTimeoutMs?: number;
    pollTimeoutMs?: number;
}
export interface QuantKeyClient {
    status(): Promise<QuantAnswer<QuantKeyStatus>>;
    sendTurn(input: {
        text: string;
        clientTurnId: string;
    }): Promise<QuantAnswer<QuantTurnStarted>>;
    events(turnId: string, after: number, options?: {
        signal?: AbortSignal;
    }): Promise<QuantAnswer<QuantEventsPage>>;
    cancel(turnId: string): Promise<QuantAnswer<Record<string, unknown>>>;
    history(input?: {
        before?: string;
        limit?: number;
    }): Promise<QuantAnswer<QuantHistoryPage>>;
}
/** Unicode code points, the unit hacc counts `maxTextChars` in. */
export declare function quantCodePoints(text: string): number;
/** A `clientTurnId`: a uuid v4, kept with the draft until a `turnId` arrives. */
export declare function newClientTurnId(): string;
/** The refusal code of a body in either shape, or undefined when it names none. */
export declare function quantRefusalCode(body: unknown): string | undefined;
/** The key client. Refuses an `http://` API URL other than this machine's: the key would travel in clear. */
export declare function createQuantKeyClient(options: QuantKeyClientOptions): QuantKeyClient;
//# sourceMappingURL=quant.d.ts.map