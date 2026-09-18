/**
 * Ember Phase 2 (BE-137, CC-05): look up a TEE wallet address in the vault before the Phase 1
 * store. A vault entry wins; the old files are then read-only for that address (one writer per key).
 */
import type { CommandContext } from "../deps"
import type { KeyEntry } from "./format"
import { readSidecar, sidecarPath } from "./sidecar"
import { closeVault, defaultVaultPath, readVaultRaw, type UnlockedVault, unlockWithPassphrase } from "./store"

export type VaultTeeHit = { hit: false } | { hit: true; vault: UnlockedVault; entry: KeyEntry; passphrase: string }

/**
 * If a vault exists, unlocks it and looks for `address`. A missing vault is not a hit. The caller
 * owns the returned vault and must `closeVault` it.
 */
export async function findTeeInVault(
  ctx: CommandContext,
  address: string,
  opts: { vaultPath?: string; passphrase?: string } = {},
): Promise<VaultTeeHit> {
  const path = opts.vaultPath ?? defaultVaultPath(ctx.deps.env)
  const raw = await readVaultRaw(path)
  if (raw === null) return { hit: false }

  let passphrase = opts.passphrase
  if (passphrase === undefined) {
    passphrase = (await ctx.deps.promptSecret("Vault passphrase (input hidden): ")).trim()
    if (passphrase === "") {
      throw new Error("A passphrase is required.")
    }
  }

  // ED-6 older-copy check is best-effort here: tee commands should not silently open a rolled-back
  // vault, but a missing sidecar is a warning rather than a refusal.
  const sidecar = await readSidecar(sidecarPath(path))
  if (sidecar !== null) {
    try {
      const parsed = JSON.parse(raw) as { generation?: number; vaultId?: string }
      if (
        parsed.vaultId === sidecar.vaultId &&
        typeof parsed.generation === "number" &&
        parsed.generation < sidecar.lastGeneration
      ) {
        ctx.deps.stderr.write(
          `Opening an older vault copy (generation ${parsed.generation} against ${sidecar.lastGeneration}).\n`,
        )
      }
    } catch {
      /* structural refusal happens inside unlock */
    }
  }

  const vault = await unlockWithPassphrase(path, raw, passphrase, {
    notice: (line) => ctx.deps.stderr.write(line),
  })
  const entry = vault.index.entries.find(
    (candidate) => candidate.address === address && candidate.role === "tee-wallet",
  )
  if (entry === undefined) {
    closeVault(vault)
    return { hit: false }
  }
  return { hit: true, vault, entry, passphrase }
}

/** True when this address lives in the vault as a TEE wallet (caller already holds the vault). */
export function vaultOwnsTeeAddress(vault: UnlockedVault, address: string): boolean {
  return vault.index.entries.some((entry) => entry.address === address && entry.role === "tee-wallet")
}
