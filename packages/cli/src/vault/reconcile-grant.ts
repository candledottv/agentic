/**
 * Ember Phase 2 (BE-137, CC-10): `reconcileGrant` and the adoption rule for a migrated (or
 * interrupted) TEE wallet entry.
 *
 * One path, four named verdicts. It reads; it never writes remote state. The stranded-import route
 * is PR C's, so a missing or failing route is `unreadable` rather than an empty answer treated as
 * evidence. T37 exercises the adoption path against a fake API after migration.
 */
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { VaultError } from "./errors"
import type { KeyEntry, TeeGrantIdentity, VaultTeeMeta } from "./format"
import { completeLinkedWalletRead, type LinkedWalletRow } from "./linked-wallets"

export type ReconcileVerdict =
  | { kind: "granted"; row: LinkedWalletRow; account: string }
  | { kind: "strand-final"; account: string; failure: StrandedFailure }
  | { kind: "unresolved"; account: string }
  | { kind: "unreadable"; reason: string }

export interface StrandedFailure {
  chain: string
  address: string
  stage: "privy_submit" | "convex_link"
  privyWalletId?: string
  createdAt?: string
}

export interface AdoptionResult {
  /** Fields to merge onto the entry. Absent when nothing should change. */
  patch: Partial<KeyEntry> & { tee?: VaultTeeMeta }
  /** What happened, for the command's output. */
  outcome: "adopted" | "verified" | "declined" | "unchanged" | "stranded" | "held"
}

/**
 * CC-10's four-verdict read. Identity is established first: a recorded `recorded-at-operation`
 * identity must match the configured profile (`GRANT_IDENTITY_MISMATCH`); an absent identity is
 * asserted by the operator typing the account's last six characters.
 */
export async function reconcileGrant(
  ctx: CommandContext,
  entry: KeyEntry,
  opts: {
    /** When the entry has no grantIdentity yet, the account the operator just confirmed. */
    assertedAccount?: string
  } = {},
): Promise<ReconcileVerdict> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    return { kind: "unreadable", reason: "no API key is available for this profile" }
  }

  const identity = entry.tee?.grantIdentity
  if (identity?.source === "recorded-at-operation") {
    if (identity.apiBaseUrl !== ctx.apiUrl) {
      throw new VaultError(
        "GRANT_IDENTITY_MISMATCH",
        `This entry was recorded against ${identity.apiBaseUrl}, and this command is using ${ctx.apiUrl}.`,
      )
    }
  }

  const wallets = await completeLinkedWalletRead(ctx, apiKey)
  if (!wallets.complete) {
    return { kind: "unreadable", reason: wallets.incompleteReason ?? "the linked-wallet read was incomplete" }
  }

  if (identity?.source === "recorded-at-operation" && identity.account !== wallets.account) {
    throw new VaultError(
      "GRANT_IDENTITY_MISMATCH",
      `This entry was recorded against account ${identity.account}, and this profile acts as ${wallets.account}.`,
    )
  }

  // Before an identity is recorded, an empty answer must never become "no authority".
  if (identity === undefined && opts.assertedAccount === undefined) {
    return { kind: "unreadable", reason: "no grant identity is recorded and none was asserted" }
  }
  if (identity === undefined && opts.assertedAccount !== undefined && opts.assertedAccount !== wallets.account) {
    throw new VaultError(
      "GRANT_IDENTITY_MISMATCH",
      `The asserted account ${opts.assertedAccount} does not match this profile's account ${wallets.account}.`,
    )
  }

  const row = wallets.rows.find((candidate) => candidate.address === entry.address)
  if (row !== undefined) {
    return { kind: "granted", row, account: wallets.account }
  }

  const stranded = await completeStrandedImportRead(ctx, apiKey)
  if (!stranded.complete) {
    return { kind: "unreadable", reason: stranded.incompleteReason ?? "the stranded-import read was incomplete" }
  }
  const failure = stranded.failures.find((candidate) => candidate.address === entry.address)
  if (failure?.stage === "convex_link") {
    return { kind: "strand-final", account: wallets.account, failure }
  }
  // privy_submit alone, or no record at all, with both reads complete: nothing established.
  // An operator-asserted identity never upgrades an empty answer into evidence of no authority.
  return { kind: "unresolved", account: wallets.account }
}

/**
 * The adoption rule: verify what is recorded, fill only what is missing. A declined confirmation
 * leaves the entry byte-identical.
 */
export async function adoptGrantedRow(
  ctx: CommandContext,
  entry: KeyEntry,
  row: LinkedWalletRow,
  account: string,
  opts: {
    confirmDestination: (destination: string) => Promise<boolean>
    /**
     * Whether the server grant block below is written before the confirmation. Default true, the
     * single-promote ceremony; `vault promote-batch` passes false because its table already
     * printed the destination the callback will check (BE-285, D11).
     */
    announceGrant?: boolean
  },
): Promise<AdoptionResult> {
  const tee = entry.tee
  if (tee === undefined) {
    throw new VaultError("VAULT_INDEX_INVALID", `Entry ${entry.address} has no tee metadata.`)
  }

  // Fully recorded: verify every field, write nothing on match. The bound key prefix is the one
  // exception (BE-303 D9): the vault's copy is a cache the server overrides, never a gate, so a
  // prefix-only difference means the wallet was moved with `tee rebind` and the server value is
  // adopted, with one line saying so. The linked-wallet id and the destination are still
  // GRANT_BINDING_MISMATCH: the destination is the fund-safety invariant, the prefix is not.
  if (entry.linkedWalletId !== undefined && tee.vaultDestination !== undefined && tee.boundKeyPrefix !== undefined) {
    const moved = assertBinding(entry, row)
    if (moved !== undefined) {
      ctx.deps.stderr.write(
        `${entry.address}: bound key is now ${moved.to} (was ${moved.from}); it was moved with tee rebind.\n`,
      )
    }
    return {
      patch: {
        tee: {
          ...tee,
          ...(moved !== undefined ? { boundKeyPrefix: moved.to } : {}),
          grantIdentity: recordedIdentity(tee.grantIdentity, account, ctx.apiUrl),
          remoteAuthority: row.remoteAuthority ?? tee.remoteAuthority,
          remoteState: row.sweptAt !== undefined ? "swept" : row.revokedAt !== undefined ? "quarantined" : "enabled",
          lifecycle: "enabled",
        },
      },
      outcome: "verified",
    }
  }

  // Partly recorded (Phase 2 pre-import write): destination already confirmed; fill id and prefix.
  if (tee.vaultDestination !== undefined) {
    if (row.vaultDestination !== undefined && row.vaultDestination !== tee.vaultDestination) {
      throw new VaultError(
        "GRANT_BINDING_MISMATCH",
        `The recorded vault destination ${tee.vaultDestination} does not match the server's ${row.vaultDestination}.`,
      )
    }
    return {
      patch: {
        linkedWalletId: entry.linkedWalletId ?? row._id,
        tee: {
          ...tee,
          boundKeyPrefix: tee.boundKeyPrefix ?? row.boundKeyPrefix,
          grantIdentity: recordedIdentity(tee.grantIdentity, account, ctx.apiUrl),
          remoteAuthority: row.remoteAuthority ?? tee.remoteAuthority ?? "unknown",
          remoteState: "enabled",
          lifecycle: "enabled",
        },
      },
      outcome: "adopted",
    }
  }

  // Nothing recorded (migrated local-candidate): display and confirm the server-reported destination.
  if (row.vaultDestination === undefined) {
    throw new VaultError(
      "GRANT_DESTINATION_UNRESOLVED",
      `The server lists ${entry.address} but carries no vault destination to adopt.`,
      {
        suggestion: "Choose a vault key with `vault demote --sweep-to`, or wait until the grant records a destination.",
      },
    )
  }

  if (opts.announceGrant ?? true) {
    ctx.deps.stdout.write(
      `Server grant for ${entry.address}:\n` +
        `  linkedWalletId   ${row._id}\n` +
        `  boundKeyPrefix   ${row.boundKeyPrefix ?? "(none)"}\n` +
        `  vaultDestination ${row.vaultDestination}\n` +
        `  account          ${account}\n`,
    )
  }
  const accepted = await opts.confirmDestination(row.vaultDestination)
  if (!accepted) {
    return { patch: {}, outcome: "declined" }
  }

  return {
    patch: {
      linkedWalletId: row._id,
      tee: {
        network: "solana-mainnet",
        lifecycle: "enabled",
        vaultDestination: row.vaultDestination,
        ...(row.boundKeyPrefix !== undefined ? { boundKeyPrefix: row.boundKeyPrefix } : {}),
        ...(row.remoteAuthority !== undefined ? { remoteAuthority: row.remoteAuthority } : {}),
        grantIdentity: recordedIdentity(tee.grantIdentity, account, ctx.apiUrl),
        remoteState: "enabled",
        ...(tee.sweepPending !== undefined ? { sweepPending: tee.sweepPending } : {}),
        ...(tee.sweepReceipts !== undefined ? { sweepReceipts: tee.sweepReceipts } : {}),
      },
    },
    outcome: "adopted",
  }
}

/**
 * The binding check (BE-303 D9): the linked-wallet id and the vault destination must match the
 * server's, or the entry is refused. A bound key prefix that differs is not a mismatch since
 * 0.11.6: it is the server's record of a `tee rebind`, returned so the caller adopts it.
 */
export function assertBinding(entry: KeyEntry, row: LinkedWalletRow): { from: string; to: string } | undefined {
  if (entry.linkedWalletId !== undefined && entry.linkedWalletId !== row._id) {
    throw new VaultError(
      "GRANT_BINDING_MISMATCH",
      `The recorded linkedWalletId ${entry.linkedWalletId} does not match the server's ${row._id}.`,
    )
  }
  if (
    entry.tee?.vaultDestination !== undefined &&
    row.vaultDestination !== undefined &&
    entry.tee.vaultDestination !== row.vaultDestination
  ) {
    throw new VaultError(
      "GRANT_BINDING_MISMATCH",
      `The recorded vault destination ${entry.tee.vaultDestination} does not match the server's ${row.vaultDestination}.`,
    )
  }
  if (
    entry.tee?.boundKeyPrefix !== undefined &&
    row.boundKeyPrefix !== undefined &&
    entry.tee.boundKeyPrefix !== row.boundKeyPrefix
  ) {
    return { from: entry.tee.boundKeyPrefix, to: row.boundKeyPrefix }
  }
  return undefined
}

function recordedIdentity(
  previous: TeeGrantIdentity | undefined,
  account: string,
  apiBaseUrl: string,
): TeeGrantIdentity {
  return {
    account: previous?.account && previous.account !== "" ? previous.account : account,
    apiBaseUrl: previous?.apiBaseUrl && previous.apiBaseUrl !== "" ? previous.apiBaseUrl : apiBaseUrl,
    source: "recorded-at-operation",
  }
}

interface StrandedRead {
  failures: StrandedFailure[]
  complete: boolean
  incompleteReason?: string
}

/**
 * PR C's stranded-import route. A 404 or transport failure is `complete: false`
 * (`unreadable`), never an empty list treated as "no stranding happened".
 */
async function completeStrandedImportRead(ctx: CommandContext, apiKey: string): Promise<StrandedRead> {
  const result = await apiRequest("/api/v1/agent/wallets/import-failures", {
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    return {
      failures: [],
      complete: false,
      incompleteReason: `the stranded-import route failed (${result.message})`,
    }
  }
  const body = result.body as { failures?: unknown; complete?: unknown }
  if (!Array.isArray(body.failures)) {
    return {
      failures: [],
      complete: false,
      incompleteReason: "the stranded-import response carried no failures array",
    }
  }
  if (body.complete === false) {
    return { failures: [], complete: false, incompleteReason: "the stranded-import read reported incomplete" }
  }
  return { failures: body.failures as StrandedFailure[], complete: true }
}

/**
 * Ensures an operation that needs a pinned destination finds one, or refuses by name.
 */
export function requireTeeDestination(entry: KeyEntry): string {
  const destination = entry.tee?.vaultDestination
  if (destination === undefined || destination === "") {
    throw new VaultError("GRANT_DESTINATION_UNRESOLVED", `${entry.address} has no pinned vault destination.`, {
      suggestion:
        "Adopt the server's pin (the first operation that reconciles a grant will ask), or choose a vault key with `vault demote --sweep-to`.",
    })
  }
  return destination
}
