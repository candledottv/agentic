/**
 * BE-326 (Phase 2 ED-10 amendment of 2026-09-24): what `vault transfer` adds when it signs from a
 * promoted wallet (`role: "tee-wallet"`) rather than a vault key.
 *
 * The signing itself is `vault transfer`'s, unchanged. Three things are added around it, and only
 * for a TEE wallet source: a refusal while a sweep of the wallet is pending, a read of the
 * wallet's server state that warns (never refuses) when an agent may be trading it, and a report
 * of the finalized transfer to Candle's activity history so the account's books see it. The
 * owner's key does not depend on the server, so neither read nor report can stop a transfer.
 */
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { VaultError } from "./errors"
import type { KeyEntry } from "./format"

/**
 * Phase 1's pending-record discipline (SC-06) must not be interleaved with another signer: a sweep
 * that recorded a pending transaction reconciles against the balances it left, and a transfer in
 * between would make that reconciliation read a move the sweep did not make.
 */
export function assertNoPendingSweep(entry: KeyEntry): void {
  const pending = entry.tee?.sweepPending?.length ?? 0
  if (pending === 0) return
  throw new VaultError(
    "TRANSFER_SWEEP_PENDING",
    `${entry.label} (${entry.address}) has ${pending} pending sweep transaction(s); a transfer would interleave with that sweep.`,
    { suggestion: `Finish the sweep first: candle tee sweep ${entry.address}` },
  )
}

export type TeeServerState = { read: true; state: string } | { read: false; reason: string }

/** The wallet's server lifecycle, or why it could not be read. Never throws. */
export async function readTeeServerState(
  ctx: CommandContext,
  entry: KeyEntry,
  apiKey: string | undefined,
): Promise<TeeServerState> {
  if (entry.linkedWalletId === undefined) {
    return { read: false, reason: "this wallet has no linked wallet id recorded" }
  }
  if (apiKey === undefined) return { read: false, reason: "no API key for this profile" }
  try {
    const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(entry.linkedWalletId)}/lifecycle`, {
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) return { read: false, reason: result.message }
    const state = (result.body as { state?: unknown }).state
    if (typeof state !== "string") return { read: false, reason: "the lifecycle response carried no state" }
    return { read: true, state }
  } catch (error) {
    return { read: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The one line printed before the confirmation, or undefined when there is nothing to say. */
export function serverStateNotice(state: TeeServerState): string | undefined {
  if (!state.read) {
    return `Could not read this wallet's Candle state (${state.reason}); proceeding. An agent may be trading it.`
  }
  if (state.state === "enabled") {
    return "Warning: this wallet is enabled, so an agent may be trading it now; a trade may fail if this transfer leaves too little."
  }
  return undefined
}

export type ActivityReportOutcome = "reported" | "scope-missing" | "no-api-key" | "failed"

/**
 * Report a finalized transfer to `POST /api/v1/activity/report`. The server verifies it on chain
 * and needs the key's `activity:write` scope; the server is the authority on the scope, so the
 * CLI asks rather than guessing from a possibly stale local record. Never throws.
 */
export async function reportTransferActivity(
  ctx: CommandContext,
  apiKey: string | undefined,
  signature: string,
): Promise<{ outcome: ActivityReportOutcome; line: string }> {
  const unseen = "Candle's history will not show this transfer."
  if (apiKey === undefined) return { outcome: "no-api-key", line: `No API key for this profile, so ${unseen}` }
  try {
    const result = await apiRequest("/api/v1/activity/report", {
      method: "POST",
      body: { chain: "solana", signature },
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (result.ok) return { outcome: "reported", line: "Reported to Candle's history." }
    if (result.code === "SCOPE_MISSING") {
      return { outcome: "scope-missing", line: `This profile's API key lacks activity:write, so ${unseen}` }
    }
    return { outcome: "failed", line: `Could not report this transfer (${result.message}); ${unseen}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { outcome: "failed", line: `Could not report this transfer (${reason}); ${unseen}` }
  }
}
