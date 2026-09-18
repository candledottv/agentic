/**
 * Ember Phase 2 (BE-137, CC-05): resolve a TEE wallet address against the vault first, then the
 * Phase 1 store. When the vault holds the address, callers must write the vault and must not
 * rewrite `tee-wallets.enc` for that address.
 */
import { base58 } from "@scure/base"
import type { ParsedArgs } from "../args"
import { confirmLastSix } from "../commands/vault-support"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { writeLocalFailure } from "../render"
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
      /** Phase 1-shaped view for read paths that still speak KeystoreEntry. */
      legacyView: KeystoreEntry
      passphrase: string
      privateKeyBase58: string
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
 * Looks in the vault first. On a vault hit, decrypts the secret once for the caller's use and
 * builds a Phase 1-shaped view. The caller must `releaseResolvedTee` in a finally block.
 */
export async function resolveTeeAddress(
  ctx: CommandContext,
  _parsed: ParsedArgs,
  address: string,
  openLegacy: () => Promise<LegacyOpen>,
): Promise<{ ok: true; resolved: ResolvedTee } | { ok: false; code: number }> {
  try {
    const hit = await findTeeInVault(ctx, address)
    if (hit.hit) {
      const secret = await decryptKey(hit.vault, hit.entry.id)
      let privateKeyBase58: string
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
        privateKeyBase58 = base58.encode(secret)
      } finally {
        wipe(secret)
      }
      return {
        ok: true,
        resolved: {
          source: "vault",
          vault: hit.vault,
          entry: hit.entry,
          legacyView: keyEntryAsKeystore(hit.entry, privateKeyBase58),
          passphrase: hit.passphrase,
          privateKeyBase58,
        },
      }
    }
  } catch (error) {
    if (isVaultError(error)) {
      writeLocalFailure(
        ctx.deps,
        { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
        ctx.json,
      )
      return { ok: false, code: error.exitCode }
    }
    // No vault, or the operator cancelled before a vault existed: fall through to the legacy store.
    if (error instanceof Error && error.message === "A passphrase is required.") {
      writeLocalFailure(ctx.deps, { code: "VAULT_UNLOCK_FAILED", message: error.message }, ctx.json)
      return { ok: false, code: 1 }
    }
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
 * First operation on a migrated `local-candidate` / `import-pending`: reconcile, and adopt when
 * the server shows a grant. A declined confirmation leaves the entry byte-identical.
 */
export async function maybeReconcileVaultTee(
  ctx: CommandContext,
  resolved: Extract<ResolvedTee, { source: "vault" }>,
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
    writeLocalFailure(ctx.deps, { code: "PROMOTE_RECONCILE_INCOMPLETE", message: verdict.reason }, ctx.json)
    return { entry: resolved.entry, code: 1 }
  }
  if (verdict.kind === "unresolved") {
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
    const next = await commitVaultTeeEntry(ctx, resolved.vault, resolved.entry.id, (entry) => {
      entry.tee = {
        network: "solana-mainnet",
        lifecycle: "stranded",
        grantIdentity: {
          account: verdict.account,
          apiBaseUrl: ctx.apiUrl,
          source: "recorded-at-operation",
        },
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

function keyEntryAsKeystore(entry: KeyEntry, privateKeyBase58: string): KeystoreEntry {
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
    privateKey: privateKeyBase58,
    imported: entry.linkedWalletId !== undefined || tee?.lifecycle === "enabled" || tee?.lifecycle === "retired",
    ...(entry.linkedWalletId !== undefined ? { linkedWalletId: entry.linkedWalletId } : {}),
    ...(meta !== undefined ? { tee: meta } : {}),
  }
}
