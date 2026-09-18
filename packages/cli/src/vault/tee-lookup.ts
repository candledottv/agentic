/**
 * Ember Phase 2 (BE-137, CC-05): look up a TEE wallet address in the vault before the Phase 1
 * store. A vault entry wins; the old files are then read-only for that address (one writer per key).
 *
 * The open goes through the shared factor-aware flow (BE-140): `--factor` and `--device` are
 * honoured here exactly as on every other command that opens the vault, so a security key opens a
 * migrated TEE entry and a passphrase is never substituted for an explicitly selected factor.
 */
import type { OpenedVault } from "../commands/vault-support"
import { unlockInteractively } from "../commands/vault-support"
import type { CommandContext } from "../deps"
import type { KeyEntry } from "./format"
import { closeVault, defaultVaultPath, readVaultRaw, type UnlockedVault } from "./store"

export type VaultTeeHit =
  | { hit: false }
  | { hit: true; vault: UnlockedVault; entry: KeyEntry; reopen: OpenedVault["reopen"] }

/**
 * If a vault exists, unlocks it and looks for `address`. A missing vault is not a hit. The caller
 * owns the returned vault and must `closeVault` it.
 *
 * ED-6's older-copy check stays best effort on the tee commands, as it was: an older whole-file
 * copy is opened with the warning on stderr rather than refused, because these commands take no
 * `--accept-older-copy` and a refusal here would strand a recovery.
 */
export async function findTeeInVault(
  ctx: CommandContext,
  address: string,
  opts: { vaultPath?: string } = {},
): Promise<VaultTeeHit> {
  const path = opts.vaultPath ?? defaultVaultPath(ctx.deps.env)
  const raw = await readVaultRaw(path)
  if (raw === null) return { hit: false }

  const opened = await unlockInteractively(ctx, path, raw, { acceptOlderCopy: true })
  const vault = opened.vault
  const entry = vault.index.entries.find(
    (candidate) => candidate.address === address && candidate.role === "tee-wallet",
  )
  if (entry === undefined) {
    closeVault(vault)
    return { hit: false }
  }
  return { hit: true, vault, entry, reopen: opened.reopen }
}

/** True when this address lives in the vault as a TEE wallet (caller already holds the vault). */
export function vaultOwnsTeeAddress(vault: UnlockedVault, address: string): boolean {
  return vault.index.entries.some((entry) => entry.address === address && entry.role === "tee-wallet")
}
