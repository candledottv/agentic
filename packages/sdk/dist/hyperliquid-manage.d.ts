/**
 * Hyperliquid phase 1 D (BE-1584, spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md,
 * sections 3, 6 and 8): the two multi-step management plans, post-open take-profit / stop-loss
 * changes and flatten, run the same way by every Candle surface.
 *
 * Neither is a new signer or a single venue action. Each step is one ordinary Candle build (a
 * targeted cancel, a reducing trigger, a reducing IOC close), checked by `verifyPerpsBuildAgainstVenue`
 * against this machine's own read of Hyperliquid, signed through the relay, submitted to
 * Hyperliquid from here, and judged on the venue's answer per leg. A step that is not confirmed
 * stops what depends on it; nothing is retried in a loop, no compensating order is ever placed, and
 * an incomplete plan is reported as incomplete with every confirmed effect and every remaining
 * target named.
 *
 * `packages/cli/src/hyperliquid-manage.ts` and `packages/mcp/src/hyperliquid-manage.ts` are
 * byte-identical copies of this file (drift tests enforce it). Its only import is `./hyperliquid`,
 * which is copied the same way.
 */
import { type HyperliquidNetwork, type HyperliquidTypedData } from "./hyperliquid";
/** At most this many signed steps per invocation (spec D, section 8); the caller invokes again. */
export declare const PERPS_FLATTEN_MAX_STEPS = 100;
export type PerpsStepStatus = "planned" | "built" | "submitted" | "confirmed" | "rejected" | "unknown" | "skipped";
/** One step of a plan, as it ended. `exchangeBody` is kept whenever a signature exists but did not settle. */
export interface PerpsWorkflowStep {
    step: number;
    kind: "cancel" | "attach" | "close";
    coin: string;
    leg?: "tp" | "sl";
    target: {
        oid: number;
        cloid: string | null;
    } | null;
    perpOrderId: string | null;
    nonce: number | null;
    /** The new order's cloid (an attach or a close), when it has one. */
    cloid: string | null;
    status: PerpsStepStatus;
    detail?: string;
    signature?: string;
    exchange?: unknown;
    exchangeBody?: unknown;
    /** A close: what the venue reports filled, and what of the planned size is left. */
    filledSz?: string;
    remainingSz?: string;
}
export interface PerpsWorkflowResult {
    operation: "tpsl" | "flatten";
    walletId: string;
    address: string;
    network: HyperliquidNetwork;
    /** Epoch ms of the last venue read this result rests on. */
    readAt: number;
    /** True only when every step settled as planned and, for flatten, a final read showed nothing left. */
    complete: boolean;
    steps: PerpsWorkflowStep[];
    /** What is still open: targets not acted on, positions not closed, legs not placed. */
    remaining: Record<string, unknown>[];
    warnings: string[];
    /** Flatten reaches Hyperliquid's main perp exchange only. */
    scope?: "main-perps";
    /** Take-profit / stop-loss legs on the venue that Candle did not build: listed, never touched. */
    unowned?: {
        leg: "tp" | "sl";
        oid: number;
        cloid: string | null;
        triggerPx: string | null;
    }[];
}
/** A refusal before anything was signed: the plan could not be made safely. */
export declare class PerpsWorkflowError extends Error {
    readonly code: string;
    readonly details: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
type Fetcher = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status?: number;
    text(): Promise<string>;
}>;
/**
 * What a surface supplies. `build` posts one Candle build and returns its body, or throws an Error
 * carrying the Candle `code`; `read` gets one Candle read. `sign` asks the relay for one signature.
 * `confirm` sees the whole plan once, before the first signature; a surface whose caller already
 * expressed intent (an SDK or MCP call) passes none, and never invents a prompt.
 */
export interface PerpsWorkflowIo {
    network: HyperliquidNetwork;
    walletId: string;
    address: string;
    builder: string;
    keyReduceOnly: boolean;
    fetcher: Fetcher;
    now: () => number;
    build(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    read(path: string): Promise<Record<string, unknown>>;
    sign(typedData: HyperliquidTypedData): Promise<string>;
    /** `no-submit` builds and checks the first step only; `sign-only` signs the first step only. */
    mode: "submit" | "no-submit" | "sign-only";
    confirm?(plan: {
        steps: PerpsWorkflowStep[];
        warnings: string[];
    }): Promise<boolean>;
    /** A random 16-byte cloid. */
    cloid(): string;
}
export interface PerpsTpslParams {
    coin: string;
    takeProfit?: string;
    stopLoss?: string;
    removeTp?: boolean;
    removeSl?: boolean;
    /** Which tracked leg to change or remove when more than one matches. */
    targetTp?: string;
    targetSl?: string;
}
/** Why a TP/SL request cannot be planned, before anything is read, or null. */
export declare function perpsTpslParamsProblem(p: PerpsTpslParams): string | null;
/**
 * Attach, change or remove the coin's take-profit and stop-loss. A change is explicit
 * cancel-and-replace: the old leg is canceled and seen gone, the position and mark are read again,
 * and only then is the new leg built; the protection gap between is named in the warnings. A cancel
 * that is not confirmed places no replacement; a replacement that fails leaves the old leg canceled
 * and the result incomplete. Omitting a leg never touches it. Legs Candle did not build are listed
 * and never overwritten; several matching tracked legs need an explicit target.
 */
export declare function runPerpsTpsl(io: PerpsWorkflowIo, params: PerpsTpslParams): Promise<PerpsWorkflowResult>;
/**
 * Cancel every open main-perp order on the wallet (triggers and reducing orders included), then
 * close every main-perp position with a full reducing IOC, re-reading before each close, then read
 * again. `complete` only when that final read shows no position and no order. Bounded at
 * `PERPS_FLATTEN_MAX_STEPS` signed steps; stops on an unknown submit, a rate limit or a failed
 * cancel; continues past a known close rejection. An observed snapshot, not a guarantee against
 * another client opening exposure afterwards, and never the whole wallet: spot, HIP-3 and vaults are
 * out of scope.
 */
export declare function runPerpsFlatten(io: PerpsWorkflowIo): Promise<PerpsWorkflowResult>;
export {};
//# sourceMappingURL=hyperliquid-manage.d.ts.map