/**
 * Ember Phase 2 (BE-137, CC-05): `candle vault retire-legacy`.
 *
 * Renames the Phase 1 TEE wallet store (`tee-wallets.enc` / `hot-wallets.enc`) to
 * `*.migrated-<date>` once, and only once, every address it holds is already in the vault and a
 * verified backup of that vault exists. "Verified" means CC-07's full eight-step verifier has
 * passed on a backup (sidecar `lastVerifiedBackupAt`) and this command also runs
 * `verifyVaultIntegrity` on the live vault before the rename. A stamped sidecar alone is not
 * integrity of the live file.
 *
 * It never deletes. A missing address is `LEGACY_INCOMPLETE`; a backup that has not been verified
 * through `vault backup` / `vault verify-backup` is `LEGACY_UNVERIFIED_BACKUP`.
 */
import { rename, stat } from "node:fs/promises"
import { isUsageError, parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { VaultError } from "../vault/errors"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { verifyVaultIntegrity } from "../vault/verify"
import { defaultTeeKeystorePath, legacyTeeKeystorePath, readKeystore, TEE_KEYSTORE_PURPOSE } from "../wallet-keystore"
import {
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultRetireLegacy(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--from"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore", "--from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault retire-legacy")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const vaultPath = resolvedVault.path
  let fromPath = parsed.values["--from"]
  if (fromPath === undefined) {
    try {
      fromPath = await resolveLegacyPath(deps.env, deps.homedir())
    } catch (error) {
      if (isUsageError(error)) return usage(ctx, error.message)
      throw error
    }
  }

  return runVaultCommand(ctx, async ({ hold }) => {
    const vaultRaw = await requireVaultRaw(ctx, resolvedVault)
    const sidecar = await readSidecar(sidecarPath(vaultPath))
    if (sidecar?.lastVerifiedBackupAt === undefined) {
      throw new VaultError(
        "LEGACY_UNVERIFIED_BACKUP",
        "No verified backup of this vault is recorded on this machine.",
        {
          suggestion:
            "Run `candle vault backup --to <path>` (or `candle vault verify-backup <path>`) so CC-07's full verifier passes, then retry.",
        },
      )
    }

    let legacyRaw: string
    try {
      legacyRaw = await deps.readFile(fromPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") {
        throw new VaultError("VAULT_MISSING", `No TEE wallet store at ${fromPath}.`, {
          suggestion: `Nothing was renamed. Point at it with --from <path>, or check: ls -l ${fromPath}`,
        })
      }
      throw new VaultError("VAULT_UNREADABLE", `Could not read ${fromPath}.`)
    }

    const legacyPass = (await deps.promptSecret("TEE wallet store passphrase (input hidden): ")).trim()
    if (legacyPass === "") throw new VaultError("VAULT_UNLOCK_FAILED", "A passphrase is required.")

    let legacyAddresses: string[]
    try {
      const opened = await readKeystore(legacyRaw, legacyPass, { expectPurpose: TEE_KEYSTORE_PURPOSE })
      legacyAddresses = opened.entries.map((entry) => entry.address)
    } catch (error) {
      throw new VaultError(
        "VAULT_UNLOCK_FAILED",
        error instanceof Error ? error.message : "Could not open the TEE wallet store.",
      )
    }

    const opened = await unlockInteractively(ctx, vaultPath, vaultRaw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      promptText: "Vault passphrase (input hidden): ",
    })
    const vault = hold(opened.vault)
    // CC-07: the same eight-step verifier `backup`, `verify-backup` and `restore` call. The sidecar
    // stamp only proves a prior backup passed; this pass proves the live vault is intact now.
    await verifyVaultIntegrity(vault)

    const vaultAddresses = new Set(vault.index.entries.map((entry) => entry.address))
    const missing = legacyAddresses.filter((address) => !vaultAddresses.has(address))
    if (missing.length > 0) {
      throw new VaultError(
        "LEGACY_INCOMPLETE",
        `The vault is missing ${missing.length} address(es) still held in ${fromPath}.`,
        {
          suggestion: "Run `candle vault import-legacy --tee` first. The legacy file was not renamed.",
        },
      )
    }

    const date = new Date(deps.now()).toISOString().slice(0, 10)
    const retiredPath = `${fromPath}.migrated-${date}`
    try {
      await rename(fromPath, retiredPath)
    } catch (error) {
      throw new VaultError(
        "VAULT_WRITE_FAILED",
        `Could not rename ${fromPath} to ${retiredPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        from: fromPath,
        retiredTo: retiredPath,
        addresses: legacyAddresses.length,
        lastVerifiedBackupAt: sidecar.lastVerifiedBackupAt,
      })
      return 0
    }
    deps.stdout.write(`Renamed ${fromPath} to ${retiredPath}.\n`)
    deps.stdout.write(
      `Every address it held is in the vault, and the last verified backup was at ${sidecar.lastVerifiedBackupAt}.\n`,
    )
    deps.stdout.write(`The file was renamed, not deleted.\n`)
    return 0
  })
}

async function resolveLegacyPath(env: Record<string, string | undefined>, home: string): Promise<string> {
  const current = defaultTeeKeystorePath(env, home)
  try {
    await stat(current)
    return current
  } catch {
    return legacyTeeKeystorePath(env, home)
  }
}
