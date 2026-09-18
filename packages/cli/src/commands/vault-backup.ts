/**
 * Ember Phase 2 (BE-136, CC-07, AD-2): `candle vault backup --to` and `candle vault verify-backup`.
 *
 * Both run `verifyVaultIntegrity` and nothing weaker, and that is the whole point of the pair. A
 * backup is NOT verified by opening it: opening authenticates the header and the index and nothing
 * else, so a copy whose root ciphertext is corrupt, or whose one key blob nobody has asked for yet
 * is unrecoverable, would compare addresses equal and report "verified" while being worthless in
 * exactly the moment it was needed. The verifier decrypts the root, decrypts every key blob one at
 * a time, checks each secret against its recorded address, re-derives every derived entry from the
 * root along its recorded path, and only then compares the copy's address set with the live
 * vault's, which is the one check that catches a copy that is internally perfect but is a stale or
 * foreign file.
 *
 * A destination inside `CANDLE_CONFIG_DIR` is refused: a backup that lives beside the thing it
 * backs up is not one.
 */
import { copyFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { assertBackupDomainAllowed } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { nextSidecar, readSidecar, sidecarPath, writeSidecar } from "../vault/sidecar"
import { candleConfigDir, closeVault, readVaultRaw, type UnlockedVault, unlockWithPassphrase } from "../vault/store"
import { type VerifyReport, verifyVaultIntegrity } from "../vault/verify"
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

export async function vaultBackup(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--to"],
    booleanFlags: ["--accept-shared-domain", "--accept-older-copy"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const to = parsed.values["--to"]
  if (to === undefined) return usage(ctx, "--to <path> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault backup")) return 1

  const { deps } = ctx
  const path = vaultPathFor(ctx, parsed)
  const destination = resolve(to)

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)

    // Both destination rules run BEFORE the passphrase prompt: an operator whose destination is
    // refused should learn that without having typed a vault passphrase for a copy that is not
    // going to be made.
    assertOutsideConfigDir(destination, deps.env)
    const file = JSON.parse(raw) as { envelopes: Parameters<typeof assertBackupDomainAllowed>[0] }
    const { destination: domain, sharedDomain } = assertBackupDomainAllowed(file.envelopes, destination, {
      acceptSharedDomain: parsed.booleans.has("--accept-shared-domain"),
    })

    if (await exists(destination)) {
      throw new VaultError(
        "EXPORT_TARGET_EXISTS",
        `${destination} already exists; this CLI does not overwrite a backup.`,
      )
    }

    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const live = hold(opened.vault)

    await copyFile(path, destination)

    // The copy is opened and verified as its OWN file, from its own bytes, so what is verified is
    // what actually landed at the destination rather than what this process believes it wrote.
    const report = await verifyCopy(ctx, destination, opened.reopen, live)

    const sidecar = sidecarPath(path)
    await writeSidecar(sidecar, {
      ...nextSidecar(await readSidecar(sidecar), live.file),
      lastVerifiedBackupAt: new Date(deps.now()).toISOString(),
      lastBackupDomain: domain,
      ...(sharedDomain ? { lastBackupSharedDomainAccepted: true } : {}),
    })

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        destination,
        destinationDomain: domain,
        sharedDomainAccepted: sharedDomain,
        verified: true,
        ...reportJson(report, live),
      })
      return 0
    }
    writeVerifiedReport(ctx, destination, domain, sharedDomain, report, live)
    return 0
  })
}

export async function vaultVerifyBackup(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--keystore"], booleanFlags: ["--accept-older-copy"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const copyPath = parsed.positionals[0]
  if (copyPath === undefined) return usage(ctx, "Which file? Usage: candle vault verify-backup <path>")
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault verify-backup")) return 1

  const { deps } = ctx
  const path = vaultPathFor(ctx, parsed)

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const live = hold(opened.vault)
    const report = await verifyCopy(ctx, resolve(copyPath), opened.reopen, live)

    const sidecar = sidecarPath(path)
    await writeSidecar(sidecar, {
      ...nextSidecar(await readSidecar(sidecar), live.file),
      lastVerifiedBackupAt: new Date(deps.now()).toISOString(),
    })

    if (ctx.json) {
      writeJson(deps, { ok: true, verified: resolve(copyPath), ...reportJson(report, live) })
      return 0
    }
    writeVerifiedReport(ctx, resolve(copyPath), undefined, false, report, live)
    return 0
  })
}

/** Opens the copy as its own file and runs all eight steps against it. */
async function verifyCopy(
  _ctx: CommandContext,
  copyPath: string,
  reopen: OpenedVault["reopen"],
  live: UnlockedVault,
): Promise<VerifyReport> {
  const raw = await readVaultRaw(copyPath)
  if (raw === null) throw new VaultError("VAULT_MISSING", `No file at ${copyPath}.`)
  // The copy is opened with the SAME factor that opened the live vault (a passphrase re-derived,
  // or a security key asserted again), so what is verified is that this factor opens this copy.
  const copy = await reopen(copyPath, raw)
  try {
    return await verifyVaultIntegrity(copy, { live })
  } finally {
    closeVault(copy)
  }
}

function assertOutsideConfigDir(destination: string, env: Record<string, string | undefined>): void {
  const config = resolve(candleConfigDir(env))
  if (destination === config || destination.startsWith(`${config}/`)) {
    throw new VaultError(
      "VAULT_BACKUP_INSIDE_CONFIG",
      `${destination} is inside ${config}, where the vault itself lives.`,
      {
        suggestion:
          "A copy beside the original is lost with it. Back up to another disk, another machine, or removable media.",
      },
    )
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function reportJson(report: VerifyReport, live: UnlockedVault) {
  return {
    steps: 8,
    addressChecked: report.addressChecked.length,
    rederived: report.rederived.length,
    notRederived: report.notRederived.length,
    comparedAgainstLive: report.comparedAgainstLive,
    nextIndex: live.index.hd.nextIndex,
    phraseRestoresDerivedKeysOnly: true,
  }
}

function writeVerifiedReport(
  ctx: CommandContext,
  target: string,
  domain: string | undefined,
  sharedDomain: boolean,
  report: VerifyReport,
  live: UnlockedVault,
): void {
  const { deps } = ctx
  deps.stdout.write(`Verified ${target}\n`)
  if (domain) deps.stdout.write(`  destination   ${domain}\n`)
  deps.stdout.write(`  steps         all 8 passed, in order\n`)
  deps.stdout.write(
    `  keys checked  ${report.addressChecked.length} (each secret produces the address the index records)\n`,
  )
  deps.stdout.write(`  re-derived    ${report.rederived.length} from the root along their recorded paths\n`)
  if (report.notRederived.length > 0) {
    deps.stdout.write(
      `  not derived   ${report.notRederived.length}: independent keys, so the address and length checks are the strongest available for them\n`,
    )
  }
  if (report.comparedAgainstLive) deps.stdout.write(`  address set   matches the live vault\n`)
  if (sharedDomain) {
    deps.stdout.write(
      `  shared domain this destination and a synced passkey envelope are one Apple account; you accepted that.\n`,
    )
  }
  // Every backup output prints the counters, because an operator who kept the phrase needs these
  // two numbers beside it to bound a restore (CC-11).
  deps.stdout.write(`\nDerivation counters to keep with your recovery phrase:\n`)
  for (const [branch, value] of Object.entries(live.index.hd.nextIndex)) {
    deps.stdout.write(`  ${branch.padEnd(12)} ${value}\n`)
  }
  deps.stdout.write(
    `\nThe recovery phrase restores derived keys only. It does not restore any key imported from the Phase 1 TEE wallet store; this file plus a factor does that.\n`,
  )
}
