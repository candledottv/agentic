/**
 * Ember Phase 2 (BE-137, CC-05): `candle vault import-legacy --tee`.
 *
 * Migrates every entry in a Phase 1 TEE wallet store (`tee-wallets.enc`, or `hot-wallets.enc` under
 * `--from`) into the vault as `origin: "migrated-tee"` entries. The v1 file is never deleted,
 * truncated or rewritten here; `vault retire-legacy` is the separate command that renames it after
 * a verified backup.
 *
 * Ordering that is the security property: seal every secret, verify each address against its
 * sealed bytes IN MEMORY, then commit the vault once. A verify failure writes nothing and leaves
 * the original store untouched. After the write, the vault is re-opened from disk and every
 * migrated address is checked again against what actually landed.
 *
 * Compatibility: after this command, a 0.9.x binary reading `tee-wallets.enc` sees a stale copy
 * (sweep records written into the vault are not mirrored back). The output says so.
 */
import { readFile } from "node:fs/promises"
import { isUsageError, parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { type MigrationGrantContext, mapLegacyTeeEntry } from "../vault/migrate-tee"
import { nextSidecar, readSidecar, sidecarPath, sourceDigest, writeSidecar } from "../vault/sidecar"
import { commitVault, decryptKey, freshKeyId, readVaultRaw, sealKeyBlob } from "../vault/store"
import {
  defaultTeeKeystorePath,
  type KeystoreEntry,
  legacyTeeKeystorePath,
  readKeystore,
  TEE_KEYSTORE_PURPOSE,
} from "../wallet-keystore"
import {
  type OpenedVault,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultImportLegacy(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--from"],
    booleanFlags: ["--tee", "--accept-older-copy"],
    pathFlags: ["--keystore", "--from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!parsed.booleans.has("--tee")) {
    return usage(
      ctx,
      "Which store? Usage: candle vault import-legacy --tee [--from <path>]. There is no --wallets migration (AD-3).",
    )
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault import-legacy")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const vaultPath = resolvedVault.path
  let fromPath = parsed.values["--from"]
  if (fromPath === undefined) {
    try {
      fromPath = await resolveDefaultTeePath(deps.env)
    } catch (error) {
      if (isUsageError(error)) return usage(ctx, error.message)
      throw error
    }
  }

  return runVaultCommand(ctx, async ({ hold }) => {
    const vaultRaw = await requireVaultRaw(ctx, resolvedVault)
    let legacyRaw: string
    try {
      legacyRaw = await readFile(fromPath, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") {
        throw new VaultError("VAULT_MISSING", `No TEE wallet store at ${fromPath}.`, {
          suggestion: "Pass --from <path> if the store lives elsewhere.",
        })
      }
      throw new VaultError("VAULT_UNREADABLE", `Could not read the TEE wallet store at ${fromPath}.`)
    }

    // Prompt order: v1 passphrase first (the file being left behind), then the vault factor.
    const legacyPass = (await deps.promptSecret("TEE wallet store passphrase (input hidden): ")).trim()
    if (legacyPass === "") throw new VaultError("VAULT_UNLOCK_FAILED", "A passphrase is required.")

    let legacyEntries: KeystoreEntry[]
    try {
      const opened = await readKeystore(legacyRaw, legacyPass, { expectPurpose: TEE_KEYSTORE_PURPOSE })
      legacyEntries = opened.entries
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
    assertRecoverableFactorExists(vault.file.envelopes)

    const grant = await migrationGrantContext(ctx)
    const digest = sourceDigest(vault.file.vaultId, new TextEncoder().encode(legacyRaw))

    // Idempotency by address: an address already in the vault is skipped, not duplicated. The
    // sidecar's sourceDigest recognizes a repeated migration of the same file before unlock; the
    // address check is what decides once the vault is open.
    const already = new Set(vault.index.entries.map((entry) => entry.address))
    const toMigrate = legacyEntries.filter((entry) => !already.has(entry.address))
    const skipped = legacyEntries.length - toMigrate.length

    if (toMigrate.length === 0) {
      await recordMigrationSidecar(vaultPath, vault, fromPath, digest, deps.now())
      return reportDone(ctx, {
        path: fromPath,
        vaultPath,
        migrated: 0,
        skipped,
        addresses: [],
        digest,
        idempotent: true,
      })
    }

    const addKeys: Array<{ id: string } & Awaited<ReturnType<typeof sealKeyBlob>>> = []
    const newEntries: KeyEntry[] = []
    const secrets: Uint8Array[] = []

    try {
      for (const legacy of toMigrate) {
        const keyId = freshKeyId()
        const mapped = mapLegacyTeeEntry(legacy, keyId, grant, new Date(deps.now()).toISOString())
        secrets.push(mapped.secret64)
        // Verify against the bytes we are about to seal, before any write.
        if (addressFromSecret64(mapped.secret64) !== mapped.entry.address) {
          throw new VaultError(
            "VAULT_VERIFY_FAILED",
            `Legacy entry ${mapped.entry.address} does not re-derive from its stored secret.`,
          )
        }
        const blob = await sealKeyBlob(vault, keyId, mapped.secret64)
        addKeys.push(blob)
        newEntries.push(mapped.entry)
      }
    } finally {
      for (const secret of secrets) wipe(secret)
    }

    await commitVault(
      vault,
      {
        index: { hd: vault.index.hd, entries: [...vault.index.entries, ...newEntries] },
        addKeys,
        sidecar: {
          migratedFrom: [
            ...((await readSidecar(sidecarPath(vaultPath)))?.migratedFrom ?? []),
            { path: fromPath, at: new Date(deps.now()).toISOString(), sourceDigest: digest },
          ],
        },
      },
      deps,
    )

    // Re-open from disk and verify every migrated address against what actually landed.
    await verifyMigratedOnDisk(vaultPath, opened.reopen, newEntries, ctx)

    return reportDone(ctx, {
      path: fromPath,
      vaultPath,
      migrated: newEntries.length,
      skipped,
      addresses: newEntries.map((entry) => ({
        address: entry.address,
        lifecycle: entry.tee?.lifecycle ?? "local-candidate",
        label: entry.label,
      })),
      digest,
      idempotent: false,
    })
  })
}

async function resolveDefaultTeePath(env: Record<string, string | undefined>): Promise<string> {
  const current = defaultTeeKeystorePath(env)
  try {
    await readFile(current)
    return current
  } catch {
    // Fall through to the pre-rename path only when the current one is absent, matching tee.ts.
  }
  return legacyTeeKeystorePath(env)
}

async function migrationGrantContext(ctx: CommandContext): Promise<MigrationGrantContext | null> {
  const config = await ctx.deps.readConfig()
  const name = ctx.profile ?? config.activeProfile
  const profile = name !== undefined ? config.profiles?.[name] : undefined
  const account = profile?.account?.trim()
  if (account === undefined || account === "") return null
  return { account, apiBaseUrl: ctx.apiUrl }
}

async function recordMigrationSidecar(
  vaultPath: string,
  vault: { file: { vaultId: string; generation: number; envelopes: Array<{ id: string }> } },
  fromPath: string,
  digest: string,
  now: number,
): Promise<void> {
  const path = sidecarPath(vaultPath)
  const previous = await readSidecar(path)
  const existing = previous?.migratedFrom ?? []
  if (existing.some((row) => row.sourceDigest === digest && row.path === fromPath)) {
    await writeSidecar(path, nextSidecar(previous, vault.file)).catch(() => {})
    return
  }
  await writeSidecar(
    path,
    nextSidecar(previous, vault.file, {
      migratedFrom: [...existing, { path: fromPath, at: new Date(now).toISOString(), sourceDigest: digest }],
    }),
  ).catch(() => {})
}

async function verifyMigratedOnDisk(
  path: string,
  reopen: OpenedVault["reopen"],
  entries: KeyEntry[],
  _ctx: CommandContext,
): Promise<void> {
  const raw = await readVaultRaw(path)
  if (raw === null) {
    throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back after the migration.`)
  }
  const reopened = await reopen(path, raw)
  try {
    for (const entry of entries) {
      const secret = await decryptKey(reopened, entry.id)
      try {
        if (addressFromSecret64(secret) !== entry.address) {
          throw new VaultError(
            "VAULT_VERIFY_FAILED",
            `Migrated key ${entry.address} does not re-derive from the secret written to the vault.`,
          )
        }
        const recorded = reopened.index.entries.find((candidate) => candidate.id === entry.id)
        if (recorded === undefined) {
          throw new VaultError(
            "VAULT_VERIFY_FAILED",
            `Migrated key ${entry.address} is missing from the re-opened index.`,
          )
        }
      } finally {
        wipe(secret)
      }
    }
  } finally {
    const { closeVault } = await import("../vault/store")
    closeVault(reopened)
  }
}

function reportDone(
  ctx: CommandContext,
  result: {
    path: string
    vaultPath: string
    migrated: number
    skipped: number
    addresses: Array<{ address: string; lifecycle: string; label: string }>
    digest: string
    idempotent: boolean
  },
): number {
  const { deps } = ctx
  if (ctx.json) {
    writeJson(deps, {
      ok: true,
      from: result.path,
      vault: result.vaultPath,
      migrated: result.migrated,
      skipped: result.skipped,
      entries: result.addresses.map(({ address, lifecycle, label }) => ({ address, lifecycle, label })),
      sourceDigest: result.digest,
      idempotent: result.idempotent,
      staleLegacyWarning: true,
    })
    return 0
  }
  if (result.idempotent && result.migrated === 0) {
    deps.stdout.write(`Every address in ${result.path} is already in the vault; nothing was written.\n`)
  } else {
    deps.stdout.write(`Migrated ${result.migrated} TEE wallet key(s) from ${result.path} into ${result.vaultPath}.\n`)
    for (const row of result.addresses) {
      deps.stdout.write(`  ${row.address}  ${row.lifecycle}  ${row.label || "(none)"}\n`)
    }
    if (result.skipped > 0) {
      deps.stdout.write(`Skipped ${result.skipped} address(es) already present in the vault.\n`)
    }
  }
  deps.stdout.write(
    `\nThe Phase 1 file was left in place. A 0.9.x binary reading it still sees that stale copy; sweep records written into the vault are not mirrored back. Run \`candle vault retire-legacy\` after a verified backup to rename it.\n`,
  )
  deps.stdout.write(`The recovery phrase does not restore these entries; the vault file plus a factor does.\n`)
  return 0
}
