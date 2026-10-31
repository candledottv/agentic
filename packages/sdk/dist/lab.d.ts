/**
 * Dependency-free hacc strategy lab client (BE-2038, strategy lab spec R18).
 * The CLI carries a byte-identical copy. Copy changes verbatim:
 * `cp packages/sdk/src/lab.ts packages/cli/src/lab.ts`.
 * Bodies, including refusals and older results without a lead card, are kept unchanged.
 */
export declare const LAB_DEFAULT_URL = "https://api.hacc.fun";
export declare const LAB_PATH = "/v1/strategy-lab";
export declare const LAB_CALL_TIMEOUT_MS = 10000;
export declare const LAB_REPLAY_INTERVAL_MS = 5000;
export declare const LAB_REPLAY_TIMEOUT_MS = 660000;
export type LabRecord = Record<string, unknown>;
export type LabJobId = string | number;
export interface LabStatus extends LabRecord {
    plan: string;
    allowed: boolean;
    replays: {
        cap: number | null;
        used: number | null;
        resets_at: string;
    };
    active_job_id: LabJobId | null;
}
export interface LabReplayInput {
    definition: LabRecord;
    from: string;
    to: string;
    asset_ids?: number[];
    cost?: {
        fee_bps_per_side?: number;
        slippage_bps_per_side?: number;
    };
}
export interface LabReplayStarted extends LabRecord {
    job_id: LabJobId;
}
export interface LabReplayJob extends LabReplayStarted {
    status: string;
    error?: string | null;
    result?: LabRecord | null;
}
export interface LabRefusal {
    status: number;
    code: string;
    message: string;
    /** The server's complete body, retained for machine output and future additive fields. */
    body?: unknown;
}
export type LabAnswer<T> = {
    ok: true;
    status: number;
    body: T;
} | {
    ok: false;
    refusal: LabRefusal;
};
export interface LabClientOptions {
    apiKey: string;
    /** Pass CANDLE_HACC_URL here; it must be HTTPS, including for local servers. */
    apiUrl?: string;
    fetch?: typeof fetch;
    callTimeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
export interface LabClient {
    status(): Promise<LabAnswer<LabStatus>>;
    replay(body: LabReplayInput): Promise<LabAnswer<LabReplayStarted>>;
    replayGet(id: LabJobId): Promise<LabAnswer<LabReplayJob>>;
    replayCancel(id: LabJobId): Promise<LabAnswer<LabRecord>>;
    runners(q?: {
        hours?: number;
        min_wallets?: number;
    }): Promise<LabAnswer<LabRecord>>;
    edges(q?: {
        days?: number;
        min_n?: number;
    }): Promise<LabAnswer<LabRecord>>;
    waitForReplay(id: LabJobId, options?: {
        intervalMs?: number;
        timeoutMs?: number;
    }): Promise<LabAnswer<LabReplayJob>>;
}
export declare function createLabClient(options: LabClientOptions): LabClient;
//# sourceMappingURL=lab.d.ts.map