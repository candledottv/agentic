/**
 * Reading an interrupted money call back (BE-1665, spec R-2, and the V-5 notes on this card).
 *
 * The rule from `OPERATION_NOT_FOUND_RULE`: a missing record does not prove the write did not run,
 * so a 404 leaves an operation `unknown`, never `failed`; and an operation is never re-sent under a
 * new id. What can be read, by kind:
 *
 *   - `trade`, `launch`: `candle_get_operation {clientId: opId, kind}`. A record is terminal or
 *     still running; no record is `unknown`.
 *   - `candle_claim_fees`: no id and no record (V-5). The core reads the token's claimable amounts
 *     before it sends the claim and again on a check; the two are evidence shown on the reconcile
 *     card, never a verdict.
 *   - `swap`, `stake`, the staking-reward claim, profile and keyaccess writes: no read by an id the
 *     core keeps. The only check is a re-send of the same request under the same id, which the
 *     server coalesces (V-5), so these stay `unknown` until the user resolves them.
 *
 * Every read here uses the Write key, because the API's read routes are gated on the write scope
 * (`GET /trade/agent/jobs/:id` needs `swap:write`, the launch job read `launch:read`).
 */

import type { Executor } from "./cards"
import type { CardKind } from "./classify"

export type ReadVerdict =
  | { readable: false }
  | { readable: true; found: false; detail?: string }
  | { readable: true; found: true; state: "pending" | "succeeded" | "failed"; record: unknown }

export interface ReadTarget {
  opId: string
  kind: CardKind
  tool: string
  params: Record<string, unknown>
}

/** Whether R-2 can read this operation by its id. */
export function readsById(target: Pick<ReadTarget, "kind">): boolean {
  return target.kind === "trade" || target.kind === "launch"
}

const TRADE_STATES: Record<string, "pending" | "succeeded" | "failed"> = {
  built: "pending",
  confirmed: "succeeded",
  failed: "failed",
}
const LAUNCH_STATES: Record<string, "pending" | "succeeded" | "failed"> = {
  submitted: "pending",
  confirming: "pending",
  confirmed: "succeeded",
  failed: "failed",
}

/** One read of `target` by its id. */
export async function readOnce(executor: Executor, target: ReadTarget, writeKey: string): Promise<ReadVerdict> {
  if (!readsById(target)) return { readable: false }
  const kind = target.kind === "launch" ? "launch" : "trade"
  const outcome = await executor.execute("candle_get_operation", { clientId: target.opId, kind }, writeKey)
  if (outcome.state === "succeeded" || outcome.state === "pending") {
    const job = ((outcome.result as { job?: unknown } | undefined)?.job ?? outcome.result) as
      | { status?: unknown }
      | undefined
    const status = typeof job?.status === "string" ? job.status : ""
    const state = (kind === "launch" ? LAUNCH_STATES : TRADE_STATES)[status] ?? "pending"
    return { readable: true, found: true, state, record: job }
  }
  // A 404 is no record yet; any other failure of the READ says nothing about the write either.
  return { readable: true, found: false, detail: "error" in outcome ? outcome.error.code : undefined }
}

/** V-5: the claimable amounts `candle_get_fees` shows for one mint, or undefined when not listed. */
export async function claimableFor(executor: Executor, mint: unknown, writeKey: string): Promise<unknown> {
  if (typeof mint !== "string" || mint.length === 0) return undefined
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const outcome = await executor.execute("candle_get_fees", { limit: 50, ...(cursor ? { cursor } : {}) }, writeKey)
    if (outcome.state !== "succeeded") return undefined
    const body = outcome.result as { tokens?: unknown; continueCursor?: unknown }
    const rows = Array.isArray(body.tokens)
      ? (body.tokens as { mint?: unknown; claimableAmounts?: unknown; claimable?: unknown }[])
      : []
    const row = rows.find((candidate) => candidate.mint === mint)
    if (row) return { claimableAmounts: row.claimableAmounts ?? null, claimable: row.claimable ?? null }
    if (typeof body.continueCursor !== "string" || body.continueCursor === "") return undefined
    cursor = body.continueCursor
  }
  return undefined
}

/** R-2's polling cadence: every 5 seconds, every 30 after two minutes, for ten minutes at most. */
export function nextPollMs(startedAt: number, now: number): number | undefined {
  const elapsed = now - startedAt
  if (elapsed >= 10 * 60_000) return undefined
  return elapsed < 2 * 60_000 ? 5_000 : 30_000
}

/** What the reconcile card says, per kind (R-3, and V-5 note 3). */
export function reconcileMessage(kind: CardKind, readable: boolean): string {
  const what = kind === "launch" ? "launch" : kind === "trade" || kind === "swap" ? "trade" : "action"
  const check = readable ? " Check it again with your factor," : ""
  // S4 L-7: a launch re-send replays the same id and body; its dry run is not run again.
  const launch = kind === "launch" ? " The dry run is not run again." : ""
  return `Candle could not confirm this ${what}.${check} Re-send the same request (it can never run twice), or stop tracking it.${launch}`
}

/**
 * S4 T-8: what a transfer's reconcile card says. S1 R-3's "re-send the same request" is true for a
 * transfer only when the re-send is the same signed transaction, and an `embedded` one is never
 * re-sent at all.
 */
export function transferReconcileMessage(source: "vault" | "embedded", id: string | undefined): string {
  if (source === "embedded") {
    return "Candle could not confirm this transfer, and cannot read it back by an id. Check the source wallet in an explorer, then say what you found. It is never sent again; a new transfer is a new card."
  }
  return `Candle could not confirm this transfer${id ? ` (${id})` : ""}. Check it by its signature, send the same signed transaction again while it can still land (never a new one), or stop tracking it.`
}
