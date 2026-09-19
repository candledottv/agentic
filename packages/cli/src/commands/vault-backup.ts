/**
 * Ember Phase 2 (BE-136, CC-07, AD-2; BE-135, AD-9): `candle vault backup --to` and
 * `candle vault verify-backup`.
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
 *
 * AD-9 (Andrew, 2026-09-17; BE-135): a copy written to a destination classified `icloud-drive` or
 * `other-cloud` is SEALED by default: it carries the passphrase envelope(s) only, and its index is
 * re-encrypted under that smaller header exactly as the format already does when the envelope set
 * changes (ED-1). Same DEK, same keys, same addresses; the synced-passkey, Enclave and security-key
 * envelopes are left out of the copy and never out of the live vault. A synced passkey lives in
 * the user's Apple account and an iCloud Drive copy lives in the same account, so one account
 * would otherwise hold both the blob and a factor that opens it. Invariant 2 still holds through
 * the mandatory passphrase, so this is confidentiality, not recoverability, and sealing removes
 * the conflict instead of blocking the backup. `--accept-shared-domain` writes an unsealed copy
 * (the full envelope set) and the acceptance is recorded in the sidecar. The output says which,
 * and a sealed copy is verified through the same eight-step verifier with the passphrase.
 */
import { copyFile, stat } from "node:fs/promises"
import nodePath, { resolve } from "node:path"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { assertBackupDomainAllowed, type BackupDomainVerdict, sealedEnvelopes } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { type Envelope, isPassphraseEnvelope, parseVaultFile } from "../vault/format"
import { APPLE_ACCOUNT_NOTICE } from "../vault/passphrase"
import { nextSidecar, readSidecar, sidecarPath, writeSidecar } from "../vault/sidecar"
import {
  candleConfigDir,
  closeVault,
  readVaultRaw,
  sealIndex,
  serializeVault,
  type UnlockedVault,
} from "../vault/store"
import { type VerifyReport, verifyVaultIntegrity } from "../vault/verify"
import { writeKeystoreFile } from "../wallet-keystore"
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
    const file = parseVaultFile(raw)
    const verdict = assertBackupDomainAllowed(file.envelopes, destination, {
      acceptSharedDomain: parsed.booleans.has("--accept-shared-domain"),
    })

    if (await exists(destination)) {
      throw new VaultError(
        "EXPORT_TARGET_EXISTS",
        `${destination} already exists; this CLI does not overwrite a backup.`,
      )
    }

    // AD-9: a sealed copy opens only with the passphrase, so the live vault is opened with the
    // passphrase here too: the operator proves they hold the one factor the copy will answer to,
    // and the copy is verified with that same factor. `--factor` naming anything else is not
    // honoured for a sealed backup, and the line below says so before the prompt.
    if (verdict.sealed && ctx.vaultFactor !== undefined && ctx.vaultFactor !== "passphrase") {
      deps.stderr.write(
        `${destination} is a ${verdict.destination} destination, so this backup is a sealed copy that opens only with the passphrase; the passphrase is used here rather than --factor ${ctx.vaultFactor}.\n`,
      )
    }
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      ...(verdict.sealed ? { factor: "passphrase" } : {}),
    })
    const live = hold(opened.vault)

    if (verdict.sealed) {
      await writeSealedCopy(live, destination)
    } else {
      await copyFile(path, destination)
    }

    // The copy is opened and verified as its OWN file, from its own bytes, so what is verified is
    // what actually landed at the destination rather than what this process believes it wrote.
    const report = await verifyCopy(ctx, destination, opened.reopen, live)

    const sidecar = sidecarPath(path)
    await writeSidecar(sidecar, {
      ...nextSidecar(await readSidecar(sidecar), live.file),
      lastVerifiedBackupAt: new Date(deps.now()).toISOString(),
      lastBackupDomain: verdict.destination,
      lastBackupSealed: verdict.sealed,
      ...(verdict.sharedDomainAccepted ? { lastBackupSharedDomainAccepted: true } : {}),
    })

    const copyEnvelopes = verdict.sealed ? sealedEnvelopes(live.file.envelopes) : live.file.envelopes
    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        destination,
        destinationDomain: verdict.destination,
        sealed: verdict.sealed,
        envelopesInCopy: copyEnvelopes.map((envelope) => envelope.id),
        envelopesLeftOut: live.file.envelopes
          .filter((envelope) => !copyEnvelopes.includes(envelope))
          .map((envelope) => envelope.id),
        sharedDomainAccepted: verdict.sharedDomainAccepted,
        sharedDomain: verdict.sharedDomain,
        verified: true,
        ...reportJson(report, live),
      })
      return 0
    }
    writeVerifiedReport(ctx, destination, verdict, report, live)
    return 0
  })
}

/**
 * AD-9's sealed copy: the live vault's header with every non-passphrase envelope left out, its
 * index re-sealed under that header with the live payload key (a fresh IV, ED-1), and the root
 * blob and every key blob copied through untouched. The generation is the live vault's, because
 * this is a copy of the same state and not a new write. Written atomically, mode 0600.
 */
export async function writeSealedCopy(live: UnlockedVault, destination: string): Promise<void> {
  const { index: _index, ...header } = live.file
  const sealed = await sealIndex(
    { ...header, envelopes: sealedEnvelopes(live.file.envelopes) },
    live.index,
    live.payloadKey,
  )
  try {
    await writeKeystoreFile(destination, serializeVault(sealed))
  } catch {
    throw new VaultError("VAULT_WRITE_FAILED", `Could not write the sealed copy at ${destination}.`)
  }
}

/** A passphrase-only copy has sealed-copy semantics, regardless of the live vault's history. */
export function isSealedCopy(copyRaw: string): boolean {
  const envelopes = parseVaultFile(copyRaw).envelopes
  return envelopes.length > 0 && envelopes.every(isPassphraseEnvelope)
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
    // AD-9: a sealed copy has only the passphrase envelope(s), so it is verified with the
    // passphrase whatever else opens the live vault. Decided from the copy's cleartext header
    // before any prompt, independent of rotations or restores of the live vault.
    const copyRaw = await readVaultRaw(resolve(copyPath))
    if (copyRaw === null) throw new VaultError("VAULT_MISSING", `No file at ${resolve(copyPath)}.`)
    const sealed = isSealedCopy(copyRaw)
    if (sealed) {
      deps.stderr.write(
        `${resolve(copyPath)} is a sealed copy that opens only with the passphrase it was sealed under, which may predate a passphrase rotation.${ctx.vaultFactor !== undefined && ctx.vaultFactor !== "passphrase" ? ` The passphrase is used here rather than --factor ${ctx.vaultFactor}.` : ""}\n`,
      )
    }
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      ...(sealed ? { factor: "passphrase" } : {}),
    })
    const live = hold(opened.vault)
    // Reuse the live passphrase only when the exact envelope it opened also exists in the copy.
    // A rotation or restore needs the old copy's passphrase, not another factor or a retry.
    const sameEnvelope = parseVaultFile(copyRaw).envelopes.some(
      (envelope) => JSON.stringify(envelope) === JSON.stringify(live.envelope),
    )
    let report: VerifyReport
    if (sealed && !sameEnvelope) {
      const copy = hold(
        (
          await unlockInteractively(ctx, resolve(copyPath), copyRaw, {
            factor: "passphrase",
            acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
            promptText: "Passphrase this backup was sealed under (input hidden): ",
          })
        ).vault,
      )
      report = await verifyVaultIntegrity(copy, { live })
    } else {
      report = await verifyCopy(ctx, resolve(copyPath), opened.reopen, live)
    }

    const sidecar = sidecarPath(path)
    await writeSidecar(sidecar, {
      ...nextSidecar(await readSidecar(sidecar), live.file),
      lastVerifiedBackupAt: new Date(deps.now()).toISOString(),
    })

    if (ctx.json) {
      writeJson(deps, { ok: true, verified: resolve(copyPath), sealed, ...reportJson(report, live) })
      return 0
    }
    writeVerifiedReport(
      ctx,
      resolve(copyPath),
      sealed ? { sealed: true } : undefined,
      report,
      live,
      parseVaultFile(copyRaw).envelopes,
    )
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

/** The subset of `node:path` the guard needs, so a test can hand it `path.win32` on a Linux runner. */
export type PathApi = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">

/**
 * Whether `target` is `dir` itself or anything beneath it, on the platform `api` describes.
 * `path.relative` rather than a string prefix, because a prefix test written with `/` never
 * matches a Windows path, and the npm package runs on Windows (BE-178, finding 5).
 */
export function isInsideDir(dir: string, target: string, api: PathApi = nodePath): boolean {
  const between = api.relative(api.resolve(dir), api.resolve(target))
  if (between === "") return true
  if (api.isAbsolute(between)) return false
  return between !== ".." && !between.startsWith(`..${api.sep}`)
}

export function assertOutsideConfigDir(
  destination: string,
  env: Record<string, string | undefined>,
  api: PathApi = nodePath,
): void {
  const config = api.resolve(candleConfigDir(env))
  if (isInsideDir(config, destination, api)) {
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

/** AD-9's consequence, printed on every sealed copy so the operator knows what the copy answers to. */
export const SEALED_COPY_NOTE =
  "This copy opens only with the passphrase it was sealed under, which may predate a passphrase rotation. It contains no synced passkey, Touch ID or security key envelope. Keep the passphrase somewhere outside the Apple account that holds a synced passkey. The live vault plus the recovery phrase remain the everyday path; this copy is for the day both are gone."

function writeVerifiedReport(
  ctx: CommandContext,
  target: string,
  verdict: Partial<BackupDomainVerdict> | undefined,
  report: VerifyReport,
  live: UnlockedVault,
  copyEnvelopes?: Envelope[],
): void {
  const { deps } = ctx
  deps.stdout.write(`Verified ${target}\n`)
  if (verdict?.destination) deps.stdout.write(`  destination   ${verdict.destination}\n`)
  if (verdict?.sealed) {
    const kept = (copyEnvelopes ?? live.file.envelopes).filter(isPassphraseEnvelope).map((envelope) => envelope.id)
    const leftOut = (copyEnvelopes === undefined ? live.file.envelopes : [])
      .filter((envelope) => !isPassphraseEnvelope(envelope))
      .map((envelope) => envelope.id)
    deps.stdout.write(
      `  sealed        yes: passphrase envelope(s) ${kept.join(", ")} only${leftOut.length > 0 ? `; left out ${leftOut.join(", ")}` : ""}\n`,
    )
  } else if (verdict?.sharedDomainAccepted) {
    deps.stdout.write(`  sealed        no: every envelope is in this copy (--accept-shared-domain)\n`)
  }
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
  if (verdict?.sharedDomainAccepted) {
    deps.stdout.write(
      verdict.sharedDomain
        ? `  shared domain this destination and a synced passkey envelope are one Apple account, and this unsealed copy carries that passkey's envelope; you accepted that.\n`
        : `  shared domain this unsealed copy carries every envelope into a cloud account; you accepted that.\n`,
    )
  }
  if (verdict?.sealed) deps.stdout.write(`\n${SEALED_COPY_NOTE}\n${APPLE_ACCOUNT_NOTICE}\n`)
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
