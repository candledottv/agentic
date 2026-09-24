/**
 * Ember Phase 2 (BE-137, CC-05): resolve a TEE wallet address against the vault first, then the
 * Phase 1 store. When the vault holds the address, callers must write the vault and must not
 * rewrite `tee-wallets.enc` for that address.
 */
import { base58 } from "@scure/base"
import { isUsageError, type ParsedArgs } from "../args"
import { confirmLastSix, type OpenedVault } from "../commands/vault-support"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import type { KeystoreEntry, OpenKeystore, TeeWalletMeta } from "../wallet-keystore"
import { addressFromSecret64 } from "./ed25519"
import { isVaultError, VaultError } from "./errors"
import type { KeyEntry } from "./format"
import { wipe } from "./hygiene"
import { adoptGrantedRow, reconcileGrant } from "./reconcile-grant"
import { closeVault, commitVault, decryptKey, type UnlockedVault } from "./store"
import { findTeeInVault } from "./tee-lookup"

export type ResolvedTee =
  | {
      source: "vault"
      vault: UnlockedVault
      entry: KeyEntry
      /**
       * Phase 1-shaped view for paths that still speak KeystoreEntry. Its `privateKey` is the
       * decoded secret only under `access: "sign"`; a read resolve leaves it empty.
       */
      legacyView: KeystoreEntry
      /** Re-opens the vault with the factor that opened it (BE-140), whichever kind that was. */
      reopen: OpenedVault["reopen"]
      /** The secret, base58, only when resolved with `access: "sign"`; `null` otherwise. */
      privateKeyBase58: string | null
    }
  | {
      source: "legacy"
      entry: KeystoreEntry
      path: string
      store: OpenKeystore
      passphrase: string
      raw: string
    }

type LegacyOpen =
  | { ok: true; store: OpenKeystore; path: string; passphrase: string; raw: string | null }
  | { ok: false; code: number }

/**
 * What the caller will do with the entry (BE-178, finding 8). EVERY resolve decrypts the key blob
 * into a wipeable buffer, checks that it re-derives the entry's address, and zeroes it: a TEE
 * wallet whose sealed key is corrupt or tampered must be refused by `tee fund` before an operator
 * is told to send funds to it, and by `tee status` before it reports the wallet as usable. What
 * differs is what survives that check. Only a command that SIGNS with the key (`tee sweep`) may
 * ask for `"sign"`, which keeps the secret as a base58 string for the signer; `"read"` (`tee
 * status`, `tee fund`, `tee disable`, `vault demote`) keeps nothing, so no immutable copy of the
 * secret is made for a command that has no use for one.
 */
export type TeeAccess = "read" | "sign"

/**
 * Looks in the vault first. On a vault hit, decrypts and verifies the secret, keeps it as a
 * string only under `access: "sign"`, and builds a Phase 1-shaped view. The caller must
 * `releaseResolvedTee` in a finally block; on any failure inside this function the vault it
 * opened is closed here, on every path (finding 4).
 */
export async function resolveTeeAddress(
  ctx: CommandContext,
  _parsed: ParsedArgs,
  address: string,
  openLegacy: () => Promise<LegacyOpen>,
  access: TeeAccess = "read",
): Promise<{ ok: true; resolved: ResolvedTee } | { ok: false; code: number; reported?: true }> {
  try {
    const hit = await findTeeInVault(ctx, address)
    if (hit.hit) {
      let privateKeyBase58: string | null = null
      try {
        const secret = await decryptKey(hit.vault, hit.entry.id)
        try {
          if (addressFromSecret64(secret) !== hit.entry.address) {
            writeLocalFailure(
              ctx.deps,
              {
                code: "VAULT_VERIFY_FAILED",
                message: `${address} in the vault does not re-derive from its stored secret.`,
              },
              ctx.json,
            )
            closeVault(hit.vault)
            return { ok: false, code: 1 }
          }
          // The one thing that cannot be wiped is made only for the command that signs.
          if (access === "sign") privateKeyBase58 = base58.encode(secret)
        } finally {
          wipe(secret)
        }
      } catch (error) {
        // A throw from decryptKey or addressFromSecret64 must not leave the DEK readable.
        closeVault(hit.vault)
        throw error
      }
      return {
        ok: true,
        resolved: {
          source: "vault",
          vault: hit.vault,
          entry: hit.entry,
          legacyView: keyEntryAsKeystore(hit.entry, privateKeyBase58),
          reopen: hit.reopen,
          privateKeyBase58,
        },
      }
    }
  } catch (error) {
    // `findTeeInVault` → `defaultVaultPath` → `candleConfigDir` (D4): a literal-`~`
    // `CANDLE_CONFIG_DIR` is a usage error, not a vault failure. Same exit 2 / USAGE envelope as
    // `vaultPathFor`. Do not rethrow: a real binary would print `Unexpected error:` and exit 1.
    if (isUsageError(error)) {
      writeUsageFailure(ctx.deps, error.message, ctx.json)
      return { ok: false, code: 2, reported: true }
    }
    if (isVaultError(error)) {
      // `reported`: the refusal is already on the screen (Phase 4a: `SOLANA_COMMAND_EVM_KEY` for
      // an EVM entry named to a tee command), so a caller must not write a second one over it.
      writeLocalFailure(
        ctx.deps,
        { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
        ctx.json,
      )
      return { ok: false, code: error.exitCode, reported: true }
    }
    throw error
  }

  const opened = await openLegacy()
  if (!opened.ok) return opened
  const entry = opened.store.entries.find((candidate) => candidate.address === address)
  if (entry === undefined) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "TEE_WALLET_UNKNOWN",
        message: `${address} is not a TEE wallet in ${opened.path}.`,
        suggestion: "Run: candle tee new",
      },
      ctx.json,
    )
    return { ok: false, code: 1 }
  }
  return {
    ok: true,
    resolved: {
      source: "legacy",
      entry,
      path: opened.path,
      store: opened.store,
      passphrase: opened.passphrase,
      raw: opened.raw ?? "",
    },
  }
}

export function releaseResolvedTee(resolved: ResolvedTee): void {
  if (resolved.source === "vault") closeVault(resolved.vault)
}

/** Refuses any attempt to rewrite the Phase 1 file for an address the vault owns. */
export function refuseLegacyWriteForVaultAddress(ctx: CommandContext, address: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: "TEE_STORE_CHANGED",
      message: `${address} lives in the vault; this CLI will not write it back to tee-wallets.enc.`,
      suggestion: "Operate on the vault entry; do not rewrite the Phase 1 store for a migrated address.",
    },
    ctx.json,
  )
  return 1
}

export async function commitVaultTeeEntry(
  ctx: CommandContext,
  vault: UnlockedVault,
  entryId: string,
  mutate: (entry: KeyEntry) => void,
): Promise<UnlockedVault> {
  const entries = vault.index.entries.map((entry) =>
    entry.id === entryId ? ({ ...entry, tee: entry.tee ? { ...entry.tee } : undefined } as KeyEntry) : entry,
  )
  const target = entries.find((entry) => entry.id === entryId)
  if (target === undefined) {
    throw new VaultError("VAULT_INDEX_INVALID", `Entry ${entryId} is not in the vault.`)
  }
  mutate(target)
  return commitVault(vault, { index: { hd: vault.index.hd, entries } }, ctx.deps)
}

/**
 * Caller of the shared reconcile path. CC-10's transition table differs: resume / status /
 * migrated-first-op hold on `unresolved` and refuse `unreadable`, while `vault demote` must
 * continue into adapter recovery (emergency sweep to a pinned destination) for both.
 */
export type VaultReconcileCaller = "default" | "demote"

/**
 * First operation on a migrated `local-candidate` / `import-pending`: reconcile, and adopt when
 * the server shows a grant. A declined confirmation leaves the entry byte-identical.
 * Pass `caller: "demote"` so `unresolved` / `unreadable` proceed to recovery instead of holding.
 */
export async function maybeReconcileVaultTee(
  ctx: CommandContext,
  resolved: Extract<ResolvedTee, { source: "vault" }>,
  caller: VaultReconcileCaller = "default",
): Promise<{ entry: KeyEntry; code: number | null }> {
  const lifecycle = resolved.entry.tee?.lifecycle
  if (lifecycle !== "local-candidate" && lifecycle !== "import-pending") {
    return { entry: resolved.entry, code: null }
  }

  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "PROMOTE_RECONCILE_INCOMPLETE",
        message: "No API key is available; reconciliation cannot run.",
        suggestion: "Run: candle keys create",
      },
      ctx.json,
    )
    return { entry: resolved.entry, code: 1 }
  }

  let assertedAccount: string | undefined
  if (resolved.entry.tee?.grantIdentity === undefined) {
    const config = await ctx.deps.readConfig()
    const name = ctx.profile ?? config.activeProfile
    const cached = name !== undefined ? config.profiles?.[name]?.account : undefined
    if (cached === undefined || cached === "") {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PROMOTE_RECONCILE_INCOMPLETE",
          message:
            "This entry has no grant identity, and this profile has no cached account to assert before querying.",
          suggestion: "Run candle auth login so this profile caches its account, then retry.",
        },
        ctx.json,
      )
      return { entry: resolved.entry, code: 1 }
    }
    ctx.deps.stdout.write(`This profile acts as account ${cached}.\n`)
    try {
      await confirmLastSix(ctx, cached, "that account")
      assertedAccount = cached
    } catch (error) {
      if (isVaultError(error)) {
        writeLocalFailure(ctx.deps, { code: error.code, message: error.message }, ctx.json)
        return { entry: resolved.entry, code: error.exitCode }
      }
      throw error
    }
  }

  let verdict: Awaited<ReturnType<typeof reconcileGrant>>
  try {
    verdict = await reconcileGrant(ctx, resolved.entry, { assertedAccount })
  } catch (error) {
    if (isVaultError(error)) {
      writeLocalFailure(
        ctx.deps,
        { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
        ctx.json,
      )
      return { entry: resolved.entry, code: error.exitCode }
    }
    throw error
  }

  if (verdict.kind === "unreadable") {
    if (caller === "demote") {
      // CC-10: recovery is not refused. No grant create/adopt; emergency sweep may proceed.
      return { entry: resolved.entry, code: null }
    }
    writeLocalFailure(ctx.deps, { code: "PROMOTE_RECONCILE_INCOMPLETE", message: verdict.reason }, ctx.json)
    return { entry: resolved.entry, code: 1 }
  }
  if (verdict.kind === "unresolved") {
    if (caller === "demote") {
      // CC-10: adapter recovery. A missing local id is not evidence of a missing grant.
      return { entry: resolved.entry, code: null }
    }
    writeLocalFailure(
      ctx.deps,
      {
        code: "PROMOTE_OUTCOME_UNRESOLVED",
        message: `No authoritative grant or stranding record for ${resolved.entry.address}; the outcome is not established.`,
        suggestion:
          "Nothing was written. Retry when the server is readable, or demote under --emergency if funds must move.",
      },
      ctx.json,
    )
    return { entry: resolved.entry, code: 3 }
  }
  if (verdict.kind === "strand-final") {
    const priorTee = resolved.entry.tee
    const next = await commitVaultTeeEntry(ctx, resolved.vault, resolved.entry.id, (entry) => {
      entry.tee = {
        network: "solana-mainnet",
        lifecycle: "stranded",
        grantIdentity: {
          account: verdict.account,
          apiBaseUrl: ctx.apiUrl,
          source: "recorded-at-operation",
        },
        // Preserve an already pinned destination (and Phase 1 sweep evidence) so demote adapter
        // recovery can still reach GRANT_DESTINATION_UNRESOLVED only when no pin exists.
        ...(priorTee?.vaultDestination !== undefined ? { vaultDestination: priorTee.vaultDestination } : {}),
        ...(priorTee?.sweepReceipts !== undefined ? { sweepReceipts: priorTee.sweepReceipts } : {}),
        ...(priorTee?.sweepPending !== undefined ? { sweepPending: priorTee.sweepPending } : {}),
      }
      delete entry.linkedWalletId
    })
    applyVault(resolved, next)
    return { entry: resolved.entry, code: null }
  }

  const adoption = await adoptGrantedRow(ctx, resolved.entry, verdict.row, verdict.account, {
    confirmDestination: async (destination) => {
      try {
        await confirmLastSix(ctx, destination, "the server-reported vault destination")
        return true
      } catch {
        return false
      }
    },
  })
  if (adoption.outcome === "declined") {
    writeLocalFailure(
      ctx.deps,
      {
        code: "GRANT_DESTINATION_UNRESOLVED",
        message: `Adoption of the server grant for ${resolved.entry.address} was declined; the entry was left unchanged.`,
      },
      ctx.json,
    )
    return { entry: resolved.entry, code: 1 }
  }
  if (adoption.patch.linkedWalletId === undefined && adoption.patch.tee === undefined) {
    return { entry: resolved.entry, code: null }
  }
  const next = await commitVaultTeeEntry(ctx, resolved.vault, resolved.entry.id, (entry) => {
    if (adoption.patch.linkedWalletId !== undefined) entry.linkedWalletId = adoption.patch.linkedWalletId
    if (adoption.patch.tee !== undefined) entry.tee = adoption.patch.tee
  })
  applyVault(resolved, next)
  return { entry: resolved.entry, code: null }
}

function applyVault(resolved: Extract<ResolvedTee, { source: "vault" }>, next: UnlockedVault): void {
  resolved.vault.raw = next.raw
  resolved.vault.file = next.file
  resolved.vault.index = next.index
  const updated = next.index.entries.find((entry) => entry.id === resolved.entry.id)
  if (updated === undefined) {
    throw new VaultError("VAULT_INDEX_INVALID", `Entry ${resolved.entry.id} vanished after the vault write.`)
  }
  resolved.entry = updated
  resolved.legacyView = keyEntryAsKeystore(updated, resolved.privateKeyBase58)
}

function keyEntryAsKeystore(entry: KeyEntry, privateKeyBase58: string | null): KeystoreEntry {
  const tee = entry.tee
  const meta: TeeWalletMeta | undefined =
    tee === undefined
      ? undefined
      : {
          network: tee.network,
          ...(tee.vaultDestination !== undefined ? { vaultDestination: tee.vaultDestination } : {}),
          ...(tee.boundKeyPrefix !== undefined ? { boundKeyPrefix: tee.boundKeyPrefix } : {}),
          ...(tee.remoteAuthority !== undefined ? { remoteAuthority: tee.remoteAuthority } : {}),
          ...(tee.enabledAt !== undefined ? { enabledAt: tee.enabledAt } : {}),
          ...(tee.stopRequestedAt !== undefined ? { stopRequestedAt: tee.stopRequestedAt } : {}),
          ...(tee.sweepReceipts !== undefined
            ? { sweepReceipts: tee.sweepReceipts as TeeWalletMeta["sweepReceipts"] }
            : {}),
          ...(tee.sweepPending !== undefined
            ? { sweepPending: tee.sweepPending as TeeWalletMeta["sweepPending"] }
            : {}),
          ...(tee.sweptAt !== undefined ? { sweptAt: tee.sweptAt } : {}),
        }
  return {
    index: 0,
    chain: "solana",
    address: entry.address,
    label: entry.label,
    createdAt: entry.createdAt,
    // Empty under a read resolve: no command that reads may see the secret (finding 8).
    privateKey: privateKeyBase58 ?? "",
    imported: entry.linkedWalletId !== undefined || tee?.lifecycle === "enabled" || tee?.lifecycle === "retired",
    ...(entry.linkedWalletId !== undefined ? { linkedWalletId: entry.linkedWalletId } : {}),
    ...(meta !== undefined ? { tee: meta } : {}),
  }
}
