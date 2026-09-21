/**
 * Ember Phase 2 PR D (BE-139, CC-07): `candle vault export-key <label> --to <new-file>`.
 *
 * This is the one path where an individual vault key leaves the vault as plaintext. The ceremony
 * is the feature, and the ordering is the substance of it:
 *
 *   Both stdin and stdout are TTYs, or nothing is written at all.
 *   Target path checks run before the passphrase is asked: existing file, symlink, missing parent,
 *     or an unwritable directory are refused without unlocking.
 *   A fresh factor prompt, then the operator types the address's last six characters.
 *   `exposure.everExported: true` is committed to the vault FIRST, so the record precedes the
 *     file and a crash between the write and the file leaves the vault saying the key may be out.
 *   Only then the key's native form is written 0600 (Solana: the JSON array of 64 bytes
 *     solana-keygen writes; EVM: 0x-prefixed hex). Nothing secret reaches stdout or `--json`.
 *
 * It is an escape hatch outside every vault guarantee, and the output says so.
 */
import { access, chmod, constants, lstat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { findEntryByLabelOrAddress } from "../vault/promote-support"
import { commitVault, decryptKey } from "../vault/store"
import {
  confirmLastSix,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultExportKey(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--to"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore", "--to"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [label, extra] = parsed.positionals
  if (label === undefined || extra !== undefined) {
    return usage(ctx, "Usage: candle vault export-key <label> --to <new-file>")
  }
  const to = parsed.values["--to"]
  if (to === undefined) return usage(ctx, "--to <new-file> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault export-key")) return 1

  const destination = resolve(to)
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    // Destination rules before the passphrase prompt: an operator whose path is refused should
    // learn that without having typed a vault passphrase for a file that is not going to be made.
    await assertExportTargetWritable(destination)

    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      promptText: "Vault passphrase (input hidden): ",
    })
    let vault = hold(opened.vault)

    const entry = findEntryByLabelOrAddress(vault.index, label)
    if (entry === undefined) {
      return usage(ctx, `No vault key matches ${label}.`)
    }

    const warning =
      `This writes the private key for ${entry.label ?? entry.address} to ${destination} as plaintext.\n` +
      `That file sits outside every vault guarantee: anyone who can read it can move the funds.\n` +
      `The vault will record that this key was exported, and that record never resets.\n`
    // Human mode puts the warning on stdout before the confirmation; `--json` keeps stdout for
    // the single result value and puts the same warning on stderr.
    if (ctx.json) ctx.deps.stderr.write(`${warning}\n`)
    else ctx.deps.stdout.write(`\n${warning}\n`)
    await confirmLastSix(ctx, entry.address, "the key being exported")

    // The record precedes the exposure: a vault write, generation increments, and the flag never
    // resets. A crash between here and the file write leaves a vault that says the key may be out,
    // which is the safe direction to be wrong in. The target is not re-checked here on purpose: a
    // destination that becomes unwritable after confirmation is exactly the crash window T46
    // exercises, and `wx` still refuses an existing path.
    vault = hold(await markEverExported(vault, entry, ctx))

    const secret = await decryptKey(vault, entry.id)
    try {
      const body = nativeKeyFileContents(entry, secret)
      await writeExportFile(destination, body)
    } finally {
      wipe(secret)
    }

    if (ctx.json) {
      writeJson(ctx.deps, {
        ok: true,
        path: destination,
        address: entry.address,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        everExported: true,
      })
      return 0
    }
    ctx.deps.stdout.write(
      `Wrote the key for ${entry.label ?? entry.address} to ${destination} (mode 0600).\n` +
        `This vault now records that the key was exported; that record never resets.\n` +
        `Treat the file as a secret. This CLI will not print its contents.\n`,
    )
    return 0
  })
}

/** Solana: JSON array of 64 bytes. EVM: 0x-prefixed hex of the 32-byte scalar. */
export function nativeKeyFileContents(entry: KeyEntry, secret: Uint8Array): string {
  if (entry.curve === "ed25519") {
    if (secret.length !== 64) {
      throw new VaultError(
        "VAULT_INDEX_INVALID",
        `Key ${entry.id} is ed25519 but its secret is ${secret.length} bytes, not 64.`,
      )
    }
    return `${JSON.stringify([...secret])}\n`
  }
  if (secret.length !== 32) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `Key ${entry.id} is secp256k1 but its secret is ${secret.length} bytes, not 32.`,
    )
  }
  const hex = Array.from(secret, (b) => b.toString(16).padStart(2, "0")).join("")
  return `0x${hex}\n`
}

async function markEverExported(
  vault: Awaited<ReturnType<typeof unlockInteractively>>["vault"],
  entry: KeyEntry,
  ctx: CommandContext,
): Promise<typeof vault> {
  const entries = vault.index.entries.map((candidate) =>
    candidate.id === entry.id
      ? {
          ...candidate,
          exposure: {
            ...candidate.exposure,
            everExported: true,
          },
        }
      : candidate,
  )
  return commitVault(vault, { index: { ...vault.index, entries } }, ctx.deps)
}

/**
 * CC-07's target rules, before any factor is collected: the path must not exist, must not be a
 * symlink, and must sit in a directory that already exists and is writable. This CLI does not
 * create the parent directory.
 */
export async function assertExportTargetWritable(destination: string): Promise<void> {
  try {
    const info = await lstat(destination)
    if (info.isSymbolicLink()) {
      throw new VaultError(
        "EXPORT_TARGET_SYMLINK",
        `${destination} is a symlink; this CLI refuses to write a private key through one.`,
        { suggestion: "Nothing was written. Choose a path that does not exist yet." },
      )
    }
    throw new VaultError(
      "EXPORT_TARGET_EXISTS",
      `${destination} already exists; this CLI does not overwrite an export.`,
      { suggestion: "Nothing was written. Choose a path that does not exist yet." },
    )
  } catch (error) {
    if (error instanceof VaultError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const parent = dirname(destination)
  try {
    const parentInfo = await lstat(parent)
    if (parentInfo.isSymbolicLink()) {
      throw new VaultError(
        "EXPORT_TARGET_SYMLINK",
        `${parent} is a symlink; this CLI refuses to write a private key into a symlinked directory.`,
        { suggestion: "Nothing was written. Choose a --to path whose parent directory is a real directory." },
      )
    }
    if (!parentInfo.isDirectory()) {
      throw new VaultError("VAULT_WRITE_FAILED", `${parent} is not a directory.`, {
        suggestion: "Create the directory yourself, then run this command again.",
      })
    }
  } catch (error) {
    if (error instanceof VaultError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VaultError(
        "VAULT_WRITE_FAILED",
        `${parent} does not exist; this CLI does not create the directory for an export.`,
        {
          suggestion: "Create the directory yourself, then run this command again.",
        },
      )
    }
    throw error
  }

  try {
    await access(parent, constants.W_OK)
  } catch {
    throw new VaultError("VAULT_WRITE_FAILED", `${parent} is not writable.`, {
      suggestion: "Choose a directory you can write to, or fix its permissions, then retry.",
    })
  }
}

/**
 * Creates the export file and nothing else: `wx` refuses an existing path, mode 0600, and the
 * parent is not created. A failure here leaves the vault's `everExported` flag already set, so a
 * retry is still honest about the exposure.
 */
async function writeExportFile(destination: string, body: string): Promise<void> {
  try {
    // `wx` is O_CREAT|O_EXCL: refuses an existing path instead of truncating it. The parent was
    // required to already exist; this CLI never creates it.
    await writeFile(destination, body, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await chmod(destination, 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      throw new VaultError(
        "EXPORT_TARGET_EXISTS",
        `${destination} already exists; this CLI does not overwrite an export.`,
        { suggestion: "Nothing was written. Choose a path that does not exist yet." },
      )
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new VaultError("VAULT_WRITE_FAILED", `Could not write ${destination}: permission denied.`, {
        suggestion:
          "The vault already records that this key was exported. Fix the destination permissions and run the ceremony again.",
      })
    }
    throw new VaultError(
      "VAULT_WRITE_FAILED",
      `Could not write ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      {
        suggestion:
          "The vault already records that this key was exported. Fix the destination and run the ceremony again.",
      },
    )
  }
}
