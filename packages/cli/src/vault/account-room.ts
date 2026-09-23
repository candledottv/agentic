/**
 * BE-288 (spec `2026-09-23-linked-wallet-cap-before-import-design.md`, D6 to D8): the one read of
 * the account's linked-wallet room that `vault promote` and `vault promote-batch` make BEFORE they
 * commit anything locally, and the three refusals it can produce.
 *
 * The server refuses an import at the cap before any key material leaves the machine (D1). This
 * read exists so the operator hears that before the AD-8 warning, before either typed
 * confirmation, and, for a batch, before the first of 146 keys rather than at the eleventh. The
 * numbers are the ones the import enforces (`GET /agent/wallets/room`), never the table cap that
 * `GET /agent/tier` reports, which ignores the env override.
 *
 * `promote-batch` refuses when the room cannot be read (D7): its promise is that it never starts
 * a run it already knows will stop partway. A single promotion proceeds with one stderr line (D8):
 * there is no partial run to avoid, and the server refuses a full account regardless.
 */
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { VaultError } from "./errors"

export interface AccountRoom {
  /** The live tier the import route checks: `pro`, `max`, `free`, `believer`. */
  tier: string
  active: number
  /** The enforced cap for Pro and Max (env override included), 0 for any other tier. */
  cap: number
  room: number
}

export type RoomRead = { ok: true; room: AccountRoom } | { ok: false; reason: string }

/**
 * One `GET /agent/wallets/room` with the same API key the import will use. Unreadable means a
 * network error, a non-2xx answer (a 404 from an API older than this change included), or a body
 * without numeric `active` and `cap`. The caller decides what unreadable means (D7 vs D8).
 */
export async function readAccountRoom(ctx: CommandContext): Promise<RoomRead> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) return { ok: false, reason: "no API key is available" }
  const result = await apiRequest("/api/v1/agent/wallets/room", {
    method: "GET",
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    return { ok: false, reason: result.status === 0 ? result.message : `HTTP ${result.status}` }
  }
  const body = (result.body ?? {}) as Record<string, unknown>
  const active = body.active
  const cap = body.cap
  if (typeof active !== "number" || typeof cap !== "number" || !Number.isFinite(active) || !Number.isFinite(cap)) {
    return { ok: false, reason: "the response carried no numeric active and cap" }
  }
  const tier = typeof body.tier === "string" ? body.tier : "unknown"
  return { ok: true, room: { tier, active, cap, room: Math.max(0, cap - active) } }
}

/** `pro` -> `Pro`, for the sentences below. */
export function tierName(tier: string): string {
  return tier.length === 0 ? tier : tier[0]?.toUpperCase() + tier.slice(1)
}

const IRREVERSIBLE = "Promotion is irreversible, so no row runs until every row can link."

/** The room-0 suggestion for a tier, without the batch sentence (§4.2, single promote). */
function revokeOrUpgrade(tier: string): string {
  return tier === "max"
    ? "Revoke linked wallets you no longer use."
    : "Upgrade to Max, or revoke linked wallets you no longer use."
}

/** The batch suggestion (§4.2's table): by tier, and by whether any room is left. */
function batchSuggestion(tier: string, room: number): string {
  if (room > 0) {
    const split = `split the file so this run acts on at most ${room} rows`
    return tier === "max"
      ? `Revoke linked wallets you no longer use, or ${split}. ${IRREVERSIBLE}`
      : `Upgrade to Max, revoke linked wallets you no longer use, or ${split}. ${IRREVERSIBLE}`
  }
  return `${revokeOrUpgrade(tier)} ${IRREVERSIBLE}`
}

/** `TIER_REQUIRED` for an account whose enforced cap is 0 (Free or Believer). */
function tierRefusal(room: AccountRoom): VaultError {
  return new VaultError(
    "TIER_REQUIRED",
    `Linked wallets need the Pro or Max tier, and this account is on ${tierName(room.tier)}. Nothing was written.`,
    { details: { active: String(room.active), cap: String(room.cap), room: String(room.room), tier: room.tier } },
  )
}

/**
 * D7: the whole batch is refused when its `promote` rows exceed the room. `acting` is the number
 * of rows that would take a slot: only `promote` rows do (a `skip` row is already linked, and a
 * `resume` row that passed Phase B is `granted`, so its link already exists). Returns the refusal
 * to throw, or null when the batch may continue.
 */
export function batchRoomRefusal(room: AccountRoom, acting: number): VaultError | null {
  if (room.cap === 0) return tierRefusal(room)
  if (acting <= room.room) return null
  const noun = acting === 1 ? "wallet" : "wallets"
  return new VaultError(
    "WALLET_LIMIT_REACHED",
    `This batch would link ${acting} ${noun} to this Candle account, and it has room for ${room.room}: ${room.active} of ${room.cap} linked wallets are active on the ${tierName(room.tier)} tier. Nothing was written.`,
    {
      suggestion: batchSuggestion(room.tier, room.room),
      // §4.1's document order: acting, active, cap, room, tier.
      details: {
        acting: String(acting),
        active: String(room.active),
        cap: String(room.cap),
        room: String(room.room),
        tier: room.tier,
      },
    },
  )
}

/** D8: a single promotion is refused only when there is no room at all. */
export function singleRoomRefusal(room: AccountRoom): VaultError | null {
  if (room.cap === 0) return tierRefusal(room)
  if (room.room > 0) return null
  return new VaultError(
    "WALLET_LIMIT_REACHED",
    `This promotion would link a wallet to this Candle account, and it has no room: ${room.active} of ${room.cap} linked wallets are active on the ${tierName(room.tier)} tier. Nothing was written.`,
    {
      suggestion: revokeOrUpgrade(room.tier),
      details: { active: String(room.active), cap: String(room.cap), room: String(room.room), tier: room.tier },
    },
  )
}

/** D7: the batch's refusal when the room could not be read. */
export function unreadableRoomRefusal(reason: string): VaultError {
  return new VaultError(
    "LINKED_WALLET_ROOM_UNREADABLE",
    `Could not read how many linked wallets this account has room for (${reason}). Nothing was written.`,
    {
      suggestion:
        "The batch refuses without it, so it never starts promotions it cannot finish. Check the API key and run again; an API older than this CLI answers 404 here until it is updated.",
    },
  )
}

/** D8: the one stderr line a single promotion prints when it proceeds without the room. */
export function unreadableRoomLine(reason: string): string {
  return `Could not read this account's linked-wallet room (${reason}); continuing. The server refuses before anything is sent if the account is full.\n`
}

/** D9: appended to an init failure's message once the pre-import entry is back. */
export const RESTORED_SENTENCE = "The vault entry is back as it was: nothing left this machine."

/**
 * D9: whether a returned import failure is one the CLI may undo locally. Only a definite HTTP
 * answer at `init` qualifies: init's body is `{ chain, address }`, so a response means the key did
 * not leave. `status === 0` (a transport failure, or `INSECURE_API_URL`) is ambiguous and stays
 * `import-pending`; a `submit` refusal is never restored, because the sealed key has reached
 * Candle's API by then, even when the server says `keyImported: false`.
 */
export function restoresPreImportEntry(failure: { stage?: "init" | "submit"; status?: number }): boolean {
  return failure.stage === "init" && failure.status !== undefined && failure.status !== 0
}

/**
 * D9: the failure to write when the restore's `commitVault` refused. `VAULT_CHANGED` keeps the
 * init reason, says the restore wrote nothing (the pre-import commit DID land, so the stock
 * "nothing was written" would deny it), and takes the stock suggestion. Any other throw is the
 * init message then the error's own, under the error's code when it is a `VaultError`.
 */
export function restoreRefusedFailure(
  init: { code: string; message: string; suggestion?: string },
  error: unknown,
): { code: string; message: string; suggestion?: string } {
  if (error instanceof VaultError && error.code === "VAULT_CHANGED") {
    return {
      code: "VAULT_CHANGED",
      message: `${init.message} The vault changed on disk while this command was running; the restore wrote nothing.`,
      suggestion: "Another candle command wrote to it. Run this one again.",
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: error instanceof VaultError ? error.code : "VAULT_UNREADABLE",
    message: `${init.message} ${message}`,
    ...(error instanceof VaultError && error.suggestion ? { suggestion: error.suggestion } : {}),
  }
}
