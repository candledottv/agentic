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
 *
 * AD-9 amendment (Andrew, 2026-09-19; BE-205): a destination classified `unknown` is sealed the
 * same way, because the CLI cannot tell whether that path syncs to an account. The output says
 * that in those words rather than naming the class, since "unknown destination" reads as a
 * failure of the tool instead of as the reason the copy is smaller.
 *
 * AD-9 second amendment (Andrew, 2026-09-23; BE-292): a sealed copy keeps every security-key
 * envelope beside every passphrase envelope (`keptInSealedCopy`). A key's domain is
 * `hardware-token`, not an account, so carrying it into a cloud copy does not recreate the
 * conflict AD-9 closed. The live vault for a sealed backup therefore opens with the operator's
 * choice among the factors the copy will carry (`UnlockOptions.among`), the copy is verified by
 * re-opening it with that same factor, and the passphrase floor is checked byte for byte after
 * the verifier passes (`assertFloorCarried`). `verify-backup` opens with any factor the copy
 * carries byte-equal to a live envelope, and says when that is only the passphrase. Before any
 * prompt only the passphrase can answer, one `Passphrase only:` line says why (D7).
 *
 * BE-245: two things, both about a backup an operator can actually take.
 *
 * `--to icloud` is a shorthand for iCloud Drive (`resolveBackupDestination`). It resolves to a
 * path and changes no rule: the resolved path is classified and sealed exactly as if it had been
 * typed in full. The shorthand's `Candle/` folder is created before that classify, because the
 * classifier realpaths the parent and a missing parent is `unknown` (BE-236); inventing the
 * folder and then classifying it as unplaceable is how a first `--to icloud` invited an
 * unsealed write into the same Apple account.
 *
 * And every write failure now NAMES its errno. `writeSealedCopy` was a bare `catch {}` reporting
 * only the destination, which is how a backup to a real iCloud Drive folder came to be impossible
 * without anyone being able to see why: `writeKeystoreFile` chmodded the destination DIRECTORY
 * 0700 and macOS refuses any chmod on a file-provider root, so the write died EPERM asking for a
 * permission `com~apple~CloudDocs` already had (it is `drwx------`). Every other step succeeded,
 * rename included, and the keystore file is written 0600 regardless. That chmod is best effort now
 * (see `writeKeystoreFile`), and the reason any remaining failure gives is in the sentence and in
 * `details` for `--json`, because an error that names the path but not the reason is a dead end
 * for whoever hits it at 2am.
 *
 * Phase 4b (BE-391, D1 fix (a)): a version 4 vault's sealed EVM record travels with the copy, to
 * `<copy path minus .enc>.evm-record.sealed`. The backup refuses before writing anything when that
 * path exists, takes the live record's lock while reading it (and fails, recording no verified
 * backup, when it cannot), and copies byte for byte and in order only the complete lines that
 * decrypt under this vault's record key, reporting how many it copied and dropped. It never rewrites
 * the live record. `verify-backup` (and the backup's own verify) runs a ninth check: every complete
 * line of the copy's record decrypts under the copy's own record key; a version 4 copy with no record
 * passes and says the record was absent.
 */
import { chmod, copyFile, mkdir, stat } from "node:fs/promises"
import nodePath, { dirname, resolve } from "node:path"
import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { formatBytes } from "../progress"
import { canonicalBytes } from "../vault/crypto"
import {
  assertBackupDomainAllowed,
  type BackupDomainVerdict,
  type DestinationDomain,
  homeDirOf,
  ICLOUD_SHORTHAND,
  icloudBackupPath,
  icloudDriveDir,
  isSecurityKeyEnvelope,
  keptInSealedCopy,
} from "../vault/domains"
import { VaultError } from "../vault/errors"
import {
  copyEvmRecordForBackup,
  evmRecordPath,
  type RecordCopyOutcome,
  type RecordVerifyOutcome,
  verifyEvmRecordCopy,
} from "../vault/evm-record"
import { currentPlatformFacts } from "../vault/fido2"
import { type Envelope, EVM_TEE_VAULT_VERSION, isPassphraseEnvelope, parseVaultFile } from "../vault/format"
import { APPLE_ACCOUNT_NOTICE } from "../vault/passphrase"
import { canDrive } from "../vault/platform"
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
  type UnusableEnvelope,
  unlockInteractively,
  usage,
  vaultPathFor,
  wordFor,
  writeJson,
} from "./vault-support"

export async function vaultBackup(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--to"],
    booleanFlags: ["--accept-shared-domain", "--accept-older-copy"],
    pathFlags: ["--keystore", "--to"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const to = parsed.values["--to"]
  if (to === undefined) return usage(ctx, "--to <path> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault backup")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const target = resolveBackupDestination(to, deps)
  // The shorthand's folder must be real before a passphrase is asked for, and this is the one
  // destination the CLI names rather than the operator, so it is on the CLI to say when it is not
  // there rather than to fail five syscalls later.
  if (target.requires !== undefined && !(await exists(target.requires))) {
    return usage(
      ctx,
      `There is no iCloud Drive folder at ${target.requires} on this machine. Sign in to iCloud and turn on iCloud Drive, or pass --to <path> with somewhere else to write.`,
    )
  }
  const destination = target.path
  // Said before the unlock: an operator who typed four characters should see the path those four
  // characters became before they type a passphrase for a copy that lands there.
  if (target.requires !== undefined) deps.stderr.write(`--to ${ICLOUD_SHORTHAND} is ${destination}\n`)

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)

    // Both destination rules run BEFORE the passphrase prompt: an operator whose destination is
    // refused should learn that without having typed a vault passphrase for a copy that is not
    // going to be made.
    assertOutsideConfigDir(destination, deps.env, deps.homedir())
    const file = parseVaultFile(raw)
    // `--to icloud` writes `CloudDocs/Candle/vault-<stamp>.enc`. Candle/ is created at write
    // time. classifyDestination realpaths that parent first; if iCloud Drive exists and Candle
    // never has, the resolve is ENOENT and the destination is `unknown`. A successful first
    // backup then prints UNPLACEABLE_DESTINATION_NOTE, which tells the operator to pass
    // `--accept-shared-domain` and write a full copy into the same Apple account. The folder
    // is ours; creating it first means the resolve is of a directory that exists. No lexical
    // fallback: that is the hole BE-236 closed.
    if (target.requires !== undefined) {
      const folder = dirname(destination)
      try {
        const created = await mkdir(folder, { recursive: true })
        if (created !== undefined) await chmod(folder, 0o700).catch(() => {})
      } catch (error) {
        throw copyWriteFailed(destination, error, "copy")
      }
    }
    const verdict = await assertBackupDomainAllowed(file.envelopes, destination, {
      acceptSharedDomain: parsed.booleans.has("--accept-shared-domain"),
      // BE-236: the classifier follows links, so `~/Documents` pointing into iCloud is seen as
      // iCloud rather than as a local disk. `destination` stays the path the operator asked for.
      realpath: deps.realpath,
      // The same home the `--to icloud` shorthand resolves against, so the two never disagree.
      home: homeDirOf(deps.env),
    })

    if (await exists(destination)) {
      throw new VaultError(
        "EXPORT_TARGET_EXISTS",
        `${destination} already exists; this CLI does not overwrite a backup.`,
        { suggestion: "Nothing was written. Choose a path that does not exist yet." },
      )
    }
    // Phase 4b (D1): the copy's sealed EVM record path is refused the same way, before anything.
    const copyRecordPath = evmRecordPath(destination)
    if (file.version === EVM_TEE_VAULT_VERSION && (await exists(copyRecordPath))) {
      throw new VaultError(
        "EXPORT_TARGET_EXISTS",
        `${copyRecordPath} already exists; this backup would write its sealed EVM record there, and this CLI does not overwrite one.`,
        { suggestion: "Nothing was written. Choose a backup path whose record path does not exist yet." },
      )
    }

    // AD-9 as amended (BE-292, D3): a sealed copy carries the passphrase and any security key,
    // so the live vault is opened with the operator's choice among exactly those envelopes: the
    // operator proves they hold a factor the copy will answer to, and the copy is verified by
    // re-opening it with that same factor. The kept ids are read from the cleartext header,
    // which is unauthenticated at this point; they only choose which factor to prompt for, the
    // unlock then authenticates the header, and the copy is written from the opened file. The
    // destination line (row B1) always prints for a sealed backup, before any prompt.
    if (verdict.sealed) {
      deps.stderr.write(`${sealedBackupLine(verdict.destination, destination)}\n`)
    }
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      ...(verdict.sealed
        ? {
            among: {
              envelopeIds: verdict.copyEnvelopeIds,
              because: sealedPassphraseOnlyReason,
              excludedBecause: SEALED_FACTOR_NOT_USED,
            },
          }
        : {}),
      // BE-259 (D2): the two Argon2id lines a backup prints are the live open and the copy's
      // reopen, and neither used to say which.
      purpose: "opening the vault",
    })
    const live = hold(opened.vault)

    if (verdict.sealed) {
      await writeSealedCopy(live, destination)
    } else {
      // BE-245: the unsealed branch names its reason too. An `fs` rejection escaping here used to
      // reach `writeVaultFailure`'s fallback and render as VAULT_UNREADABLE, which is the wrong
      // code for a write and reads as a problem with the vault rather than with the destination.
      try {
        await copyFile(path, destination)
      } catch (error) {
        throw copyWriteFailed(destination, error, "copy")
      }
    }

    // Phase 4b (D1): the sealed EVM record, lines that decrypt only, under the live record's lock.
    const recordCopy =
      live.file.version === EVM_TEE_VAULT_VERSION ? await copyEvmRecordForBackup(live, copyRecordPath, deps) : undefined

    // BE-259 (D1): the size and the mode come from the FILE, after the write and before the
    // verify, for the same reason `verifyWrittenFromDisk` re-reads the vault it just wrote: the
    // guarantee is about the bytes on disk, not about what this process believes it wrote.
    const written = await stat(destination)

    // The copy is opened and verified as its OWN file, from its own bytes, so what is verified is
    // what actually landed at the destination rather than what this process believes it wrote.
    const { report, copyHeader, record } = await verifyCopy(
      ctx,
      destination,
      opened.reopen,
      live,
      "re-opening the copy to verify it",
    )
    // BE-292 (D4): a security key opening the copy does not exercise its passphrase envelope, so
    // the floor is proven by construction and checked: every live passphrase envelope must be in
    // the copy's authenticated header byte for byte. A backup-level assertion, not a ninth step.
    assertFloorCarried(copyHeader, live.file)

    // BE-292 (D8): the ids of the copy just written, bound to this receipt by one timestamp
    // string. `lastBackupAt` is written only here; `verify-backup` moves `lastVerifiedBackupAt`
    // and carries `lastBackupIdsVerifiedAt` with it only when the receipt was already bound.
    const verifiedAt = new Date(deps.now()).toISOString()
    const copyEnvelopeIds = copyHeader.envelopes.map((envelope) => envelope.id)
    const sidecar = sidecarPath(path)
    await writeSidecar(sidecar, {
      ...nextSidecar(await readSidecar(sidecar), live.file),
      lastVerifiedBackupAt: verifiedAt,
      lastBackupDomain: verdict.destination,
      lastBackupSealed: verdict.sealed,
      ...(verdict.sharedDomainAccepted ? { lastBackupSharedDomainAccepted: true } : {}),
      lastBackupAt: verifiedAt,
      lastBackupEnvelopeIds: copyEnvelopeIds,
      lastBackupEnvelopeIdsAt: verifiedAt,
      lastBackupIdsVerifiedAt: verifiedAt,
    })

    const copyEnvelopes = live.file.envelopes.filter((envelope) => copyEnvelopeIds.includes(envelope.id))
    const leftOut = live.file.envelopes.filter((envelope) => !copyEnvelopeIds.includes(envelope.id))
    const mode = fileModeOctal(written.mode)
    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        destination,
        destinationDomain: verdict.destination,
        sealed: verdict.sealed,
        envelopesInCopy: copyEnvelopeIds,
        envelopesLeftOut: leftOut.map((envelope) => envelope.id),
        sharedDomainAccepted: verdict.sharedDomainAccepted,
        sharedDomain: verdict.sharedDomain,
        verified: true,
        ...reportJson(report, live, record),
        ...(recordCopy !== undefined
          ? {
              evmRecordCopy: {
                path: recordCopy.copyPath,
                present: recordCopy.present,
                copied: recordCopy.copied,
                dropped: recordCopy.dropped,
              },
            }
          : {}),
        // BE-259 (D1): two additive keys, on this document only.
        bytesWritten: written.size,
        mode,
        // BE-292 (D9): two more, additive.
        openedWith: { factor: opened.factor.kind, envelopeId: opened.factor.envelopeId },
        recoverableFactorsInCopy: verdict.recoverableFactorsInCopy,
      })
      return 0
    }
    // D1: the write, said first and on success only. `Wrote <path>` and `Verified <path>` are two
    // different claims about the same file, and that they were indistinguishable was the defect:
    // the operator read `Verified` as "I checked something that was already there". A verify
    // failure raises above this line, because a `Wrote` above a failure envelope reads as success.
    for (const line of wroteLines(destination, written.size, mode)) deps.stdout.write(`${line}\n`)
    if (recordCopy !== undefined) deps.stdout.write(`${recordCopyLine(recordCopy)}\n`)
    writeVerifiedReport(ctx, destination, verdict, report, live, {
      record,
      copyEnvelopes,
      leftOut,
      verifiedWith: verifiedWithLine(
        wordFor(live.envelope),
        live.envelope.id,
        "the copy was re-opened with it",
        carriedClause(live.file.envelopes.filter(isPassphraseEnvelope).map((envelope) => envelope.id)),
      ),
    })
    return 0
  })
}

/** Row B1: the destination line every sealed backup prints before its first prompt. */
export function sealedBackupLine(destination: DestinationDomain, target: string): string {
  return `${sealReason(destination, target)}, so this backup is a sealed copy: it carries the passphrase and any security key, and leaves out synced passkey and Touch ID envelopes.`
}

/** Row B3's reason: what `--factor touch-id`, `--factor passkey` or such an id is told on a sealed backup. */
export const SEALED_FACTOR_NOT_USED = "a sealed copy carries no Touch ID or synced passkey envelope."

/**
 * Row B2: why a sealed backup can only take the passphrase. Either the vault has no security key
 * for the copy to carry, or it has one that this machine cannot drive.
 */
export function sealedPassphraseOnlyReason(unusable: UnusableEnvelope[]): string {
  if (unusable.length === 0) {
    return "a sealed copy opens with the passphrase or a security key, and this vault has no security key. Add one with: candle vault enroll security-key"
  }
  const keys = unusable.map(
    (entry) => `${entry.word} ${entry.id} cannot be used on this machine: ${entry.availability}`,
  )
  return `a sealed copy opens with the passphrase or a security key, and ${keys.join("; ")}.`
}

/** Two envelopes are the same when their canonical bytes are, which is what the header signs. */
export function sameEnvelopeBytes(a: Envelope, b: Envelope): boolean {
  const x = canonicalBytes(a)
  const y = canonicalBytes(b)
  return x.length === y.length && x.every((byte, i) => byte === y[i])
}

/**
 * BE-292 (D4): the passphrase floor, checked after the verifier passes. Every passphrase envelope
 * in the authenticated live header must be canonical-byte-equal to an envelope in the copy's
 * authenticated header; it wraps the same DEK under the same vault id, so it opens the copy if
 * and only if the live passphrase opens the live vault. The only failure this can catch is a
 * writer bug that drops the floor, which is exactly the regression carrying keys makes possible.
 */
export function assertFloorCarried(copy: { envelopes: Envelope[] }, live: { envelopes: Envelope[] }): void {
  const missing = live.envelopes
    .filter(isPassphraseEnvelope)
    .filter((envelope) => !copy.envelopes.some((candidate) => sameEnvelopeBytes(candidate, envelope)))
  if (missing.length === 0) return
  const ids = missing.map((envelope) => envelope.id).join(", ")
  throw new VaultError(
    "VAULT_VERIFY_FAILED",
    `The copy does not carry passphrase envelope ${ids} byte for byte, so the recovery floor is not in it; nothing was recorded.`,
    {
      suggestion:
        "This is a defect in the writer, not in your vault. The copy is left in place for inspection; do not rely on it.",
      details: { step: "floor", missing: ids },
    },
  )
}

/** The `verified with` report line (§6.2). */
export function verifiedWithLine(word: string, envelopeId: string, how: string, floorClause: string): string {
  return `  verified with ${word} ${envelopeId} (${how}); ${floorClause}`
}

/** The floor clause when the copy's passphrase envelope(s) are the live one's bytes. */
export function carriedClause(passphraseIds: string[]): string {
  return `passphrase ${passphraseIds.join(", ")} carried byte for byte`
}

/** The floor clause when a key opened the copy and its passphrase envelope is not the live one's. */
export const PASSPHRASE_NOT_EXERCISED = "passphrase not exercised (run with --factor passphrase to prove it)"

/** The file's permission bits as four octal digits, `0600` for the keystore write. */
export function fileModeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0")
}

/**
 * The three-line block above the verified report (D1, §4.1): the human number for reading and
 * the exact byte count for a record, in the report's own two-space indent and 14-character label
 * field so `size` and `mode` line up with `destination` and `steps`. Pure, so the wording an
 * operator acts on is asserted directly rather than through a captured stream.
 */
export function wroteLines(destination: string, size: number, mode: string): string[] {
  return [`Wrote ${destination}`, `  size          ${formatBytes(size)} (${size} bytes)`, `  mode          ${mode}`]
}

/**
 * `--to`, resolved (BE-245). Anything but the shorthand is the path the operator typed, resolved
 * exactly as before.
 *
 * `--to icloud` is the one destination the CLI names for itself, and it exists because the literal
 * path -- `~/Library/Mobile Documents/com~apple~CloudDocs`, tildes inside the folder name included
 * -- is hostile to type and is most of why nobody backs up. It resolves into a folder of Candle's
 * own, with one timestamped file per backup: `vault backup` refuses to overwrite an existing copy,
 * and a vault is meant to be backed up again after keys are created, so a fixed name would turn
 * the second and more useful backup into a refusal. `requires` is the folder that must already
 * exist for the shorthand to mean anything, and is undefined for a path the operator chose: the
 * CLI creates directories under a path you named, and does not pretend iCloud Drive is set up.
 *
 * Nothing here decides sealing. The resolved path goes through `classifyDestination` like any
 * other, lands in `icloud-drive`, and is sealed by AD-9's rule rather than by its spelling.
 */
export function resolveBackupDestination(
  to: string,
  deps: Pick<Deps, "env" | "now">,
): { path: string; requires?: string } {
  if (to.trim().toLowerCase() !== ICLOUD_SHORTHAND) return { path: resolve(to) }
  const home = homeDirOf(deps.env)
  return { path: icloudBackupPath(home, deps.now()), requires: icloudDriveDir(home) }
}

/**
 * AD-9's sealed copy: the live vault's header with every envelope `keptInSealedCopy` leaves out
 * left out (as amended 2026-09-23 that keeps the passphrase and security-key envelopes), its
 * index re-sealed under that header with the live payload key (a fresh IV, ED-1), and the root
 * blob and every key blob copied through untouched. The generation is the live vault's, because
 * this is a copy of the same state and not a new write. Written atomically, mode 0600.
 */
export async function writeSealedCopy(live: UnlockedVault, destination: string): Promise<void> {
  const { index: _index, ...header } = live.file
  const sealed = await sealIndex(
    { ...header, envelopes: live.file.envelopes.filter(keptInSealedCopy) },
    live.index,
    live.payloadKey,
  )
  try {
    await writeKeystoreFile(destination, serializeVault(sealed))
  } catch (error) {
    throw copyWriteFailed(destination, error, "sealed copy")
  }
}

/** The `code` an `fs` rejection carries (`EPERM`, `ENOSPC`, ...), or undefined for anything else. */
export function errnoCodeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && code.length > 0 ? code : undefined
}

/**
 * What to do about each errno this write realistically hits. Deliberately keyed on the CODE rather
 * than on the message: the codes are stable across platforms and the messages are not.
 */
function suggestionForErrno(code: string | undefined): string {
  if (code === "ENOSPC") return "The volume is full. Free space there, or back up somewhere else. Nothing was written."
  if (code === "EROFS") return "That volume is mounted read-only. Nothing was written."
  if (code === "ENOENT")
    return "A directory on that path does not exist and could not be created. Check the path, and that the volume is mounted. Nothing was written."
  if (code === "EACCES" || code === "EPERM")
    return "Check that you can write there, and that the volume or sync folder is mounted and not locked. Nothing was written."
  return "Nothing was written. Try another destination, or run the same write by hand to see what the filesystem says."
}

/**
 * A write failure that NAMES the reason (BE-245). This was a bare `catch {}` reporting only the
 * path, so an operator was told a write failed and given no way to learn why; diagnosing the
 * iCloud Drive EPERM above took a hand-run probe of the five syscalls the write makes. The errno
 * goes in the sentence for a human and in `details` for `--json`, which is the additive optional
 * key D3 already defined for exactly this.
 */
export function copyWriteFailed(destination: string, error: unknown, what: string): VaultError {
  const code = errnoCodeOf(error)
  const reason = error instanceof Error ? error.message : String(error)
  return new VaultError(
    "VAULT_WRITE_FAILED",
    `Could not write the ${what} at ${destination}: ${code ?? "no error code"} -- ${reason}`,
    {
      suggestion: suggestionForErrno(code),
      details: { path: destination, reason, ...(code === undefined ? {} : { code }) },
    },
  )
}

/**
 * BE-292 (D5): a copy is sealed when it has at least one passphrase envelope and every envelope
 * in it is one a sealed copy keeps (the passphrase or the exact security-key shape). That is a
 * statement about the copy's envelopes, not about which writer produced it: a passphrase-only
 * copy from an earlier CLI is sealed, a full `local-disk` copy of a vault holding only a
 * passphrase and security keys is sealed too (0.11.5 said `false` for that file), and a copy that
 * carries a synced passkey or Touch ID envelope is not.
 */
export function isSealedCopy(copyRaw: string): boolean {
  const envelopes = parseVaultFile(copyRaw).envelopes
  return envelopes.some(isPassphraseEnvelope) && envelopes.every(keptInSealedCopy)
}

/** Row V1: a copy that carries no security key, against a vault that has one. */
export function verifyPassphraseOnlyReason(
  copyPath: string,
  copyHasKey: boolean,
  unusable: UnusableEnvelope[],
): string {
  if (!copyHasKey) {
    return `${copyPath} carries no security key envelope (a copy sealed by an earlier CLI, or from a vault that had none then), so only the passphrase opens it.`
  }
  if (unusable.length > 0) {
    const keys = unusable.map(
      (entry) => `${entry.word} ${entry.id} in ${copyPath} cannot be used on this machine: ${entry.availability}`,
    )
    return `${keys.join("; ")}.`
  }
  return `no security key in ${copyPath} is still on this vault as it is now, so the passphrase is the carried factor that opens it here.`
}

/**
 * Row V2: why `verify-backup` asks for the copy's own passphrase. When a carried key could have
 * been used and the operator asked for the passphrase instead, the clause about the key is not
 * true and is left out.
 */
export function copyPassphraseReason(copyPath: string, keyUsable = false): string {
  const noKey = keyUsable ? "" : ", and no security key in it can be used here"
  return `the factor that opened this vault is not in ${copyPath} as it is now${noKey}, so the copy opens with the passphrase it was sealed under, which may predate a rotation.`
}

export async function vaultVerifyBackup(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
    pathPositionals: ["<path>"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const copyPath = parsed.positionals[0]
  if (copyPath === undefined) return usage(ctx, "Which file? Usage: candle vault verify-backup <path>")
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault verify-backup")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const target = resolve(copyPath)
    const copyRaw = await readVaultRaw(target)
    if (copyRaw === null)
      throw new VaultError("VAULT_MISSING", `No file at ${target}.`, {
        suggestion: `Check the path: ls -l ${target}. This is the COPY to verify, not the live vault.`,
      })
    // BE-292 (D5): the copy's sealing is read off its own cleartext header, and the live vault is
    // opened with any factor the copy carries byte for byte: the chosen envelope is then present
    // in the copy with identical bytes, so the copy is re-opened with it. When nothing carried
    // can be used here (a rotated passphrase and no usable key), the live vault opens with
    // whatever the operator holds and the copy is opened with its own passphrase (row V2).
    const copyHeader = parseVaultFile(copyRaw)
    const sealed = isSealedCopy(copyRaw)
    const liveFile = parseVaultFile(raw)
    const carried = liveFile.envelopes.filter((envelope) =>
      copyHeader.envelopes.some((candidate) => sameEnvelopeBytes(candidate, envelope)),
    )
    const facts = await currentPlatformFacts(deps)
    const usable = carried.filter((envelope) => isPassphraseEnvelope(envelope) || canDrive(envelope, facts))
    const copyHasKey = copyHeader.envelopes.some(isSecurityKeyEnvelope)
    // `--factor passphrase` when the live passphrase is not carried (a rotation since the copy) is
    // the proof the `passphrase not exercised` line names: the live vault opens with the current
    // passphrase, unrestricted, and the copy is then opened with its own (row V2).
    const requested = ctx.vaultFactor
    const requestsPassphrase =
      requested === "passphrase" ||
      liveFile.envelopes.some((envelope) => envelope.id === requested && isPassphraseEnvelope(envelope))
    const restrict = usable.length > 0 && !(requestsPassphrase && !carried.some(isPassphraseEnvelope))
    const keyUsable = usable.some(isSecurityKeyEnvelope)
    const securityKeysNotInCopy = liveFile.envelopes
      .filter(isSecurityKeyEnvelope)
      .filter((key) => !copyHeader.envelopes.some((candidate) => candidate.id === key.id))
      .map((key) => key.id)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      ...(restrict
        ? {
            among: {
              envelopeIds: carried.map((envelope) => envelope.id),
              because: (unusable: UnusableEnvelope[]) => verifyPassphraseOnlyReason(target, copyHasKey, unusable),
              excludedBecause: `${target} does not carry it as it is now.`,
            },
          }
        : {}),
      // BE-259 (D2): the only bytes of this command that move are its two stderr Argon2id lines;
      // the stdout report and the `--json` document stay byte for byte (T3).
      purpose: "opening the live vault",
    })
    const live = hold(opened.vault)
    // Reuse the live factor only when the exact envelope it opened also exists in the copy. A
    // rotation or restore needs the old copy's passphrase, not another factor or a retry.
    const openedInCopy = carried.some((envelope) => envelope.id === opened.factor.envelopeId)
    let report: VerifyReport
    let record: RecordVerifyOutcome
    let copyOpened: { word: string; envelopeId: string; factor: OpenedVault["factor"]["kind"]; how: string }
    if (openedInCopy) {
      const verified = await verifyCopy(ctx, target, opened.reopen, live, "opening the copy")
      report = verified.report
      record = verified.record
      copyOpened = {
        word: wordFor(live.envelope),
        envelopeId: opened.factor.envelopeId,
        factor: opened.factor.kind,
        how: "the copy was re-opened with it",
      }
    } else {
      const copy = hold(
        (
          await unlockInteractively(ctx, target, copyRaw, {
            factor: "passphrase",
            acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
            promptText: "Passphrase this backup was sealed under (input hidden): ",
            purpose: "opening the copy",
            passphraseOnlyBecause: copyPassphraseReason(target, keyUsable),
            passphraseOnlyEvenIfSole: true,
          })
        ).vault,
      )
      report = await verifyVaultIntegrity(copy, { live })
      record = await verifyEvmRecordCopy(copy, evmRecordPath(target))
      copyOpened = {
        word: "passphrase",
        envelopeId: copy.envelope.id,
        factor: "passphrase",
        how: "the copy's own passphrase, typed",
      }
    }
    const passphraseExercised = copyOpened.factor === "passphrase"
    const carriedPassphrases = carried.filter(isPassphraseEnvelope).map((envelope) => envelope.id)
    const floorClause = passphraseExercised
      ? `passphrase ${copyOpened.envelopeId} exercised`
      : carriedPassphrases.length > 0
        ? carriedClause(carriedPassphrases)
        : PASSPHRASE_NOT_EXERCISED

    // BE-292 (D8): the verification time moves; the binding stamp moves with it only when the
    // receipt this sidecar holds was already bound (both clauses on the stored values). A verify
    // after a 0.11.5 backup leaves the stamp where it was, so those ids stay unbound.
    const verifiedAt = new Date(deps.now()).toISOString()
    const sidecar = sidecarPath(path)
    const stored = await readSidecar(sidecar)
    const boundBefore =
      typeof stored?.lastBackupEnvelopeIdsAt === "string" &&
      stored.lastBackupEnvelopeIdsAt === stored.lastBackupAt &&
      typeof stored.lastBackupIdsVerifiedAt === "string" &&
      stored.lastBackupIdsVerifiedAt === stored.lastVerifiedBackupAt
    await writeSidecar(sidecar, {
      ...nextSidecar(stored, live.file),
      lastVerifiedBackupAt: verifiedAt,
      ...(boundBefore ? { lastBackupIdsVerifiedAt: verifiedAt } : {}),
    })

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        verified: target,
        sealed,
        ...reportJson(report, live, record),
        // BE-292 (D9): additive keys.
        openedWith: { factor: copyOpened.factor, envelopeId: copyOpened.envelopeId },
        envelopesInCopy: copyHeader.envelopes.map((envelope) => envelope.id),
        passphraseExercised,
        ...(securityKeysNotInCopy.length > 0 ? { securityKeysNotInCopy } : {}),
      })
      return 0
    }
    writeVerifiedReport(ctx, target, sealed ? { sealed: true } : undefined, report, live, {
      record,
      copyEnvelopes: copyHeader.envelopes,
      leftOut: [],
      verifiedWith: verifiedWithLine(copyOpened.word, copyOpened.envelopeId, copyOpened.how, floorClause),
    })
    if (securityKeysNotInCopy.length > 0) {
      deps.stdout.write(`\n${freshBackupAdvice(target, securityKeysNotInCopy)}\n`)
    }
    return 0
  })
}

/** D8's advice after a `verify-backup` of a copy that carries no key the live vault has. */
export function freshBackupAdvice(copyPath: string, keyIds: string[]): string {
  return `Fresh backup advised: ${copyPath} does not carry security key ${keyIds.join(", ")}; a new \`candle vault backup\` would open with it too.`
}

/** Opens the copy as its own file and runs all eight steps against it. `purpose` is what the
 * copy's derivation line says this open is for (D2). Returns the copy's header as authenticated
 * by that open, for the floor check. */
async function verifyCopy(
  _ctx: CommandContext,
  copyPath: string,
  reopen: OpenedVault["reopen"],
  live: UnlockedVault,
  purpose: string,
): Promise<{ report: VerifyReport; copyHeader: { envelopes: Envelope[] }; record: RecordVerifyOutcome }> {
  const raw = await readVaultRaw(copyPath)
  if (raw === null)
    throw new VaultError("VAULT_MISSING", `No file at ${copyPath}.`, {
      suggestion: `The copy this run just wrote is not there. Check the path and the volume: ls -l ${copyPath}`,
    })
  // The copy is opened with the SAME factor that opened the live vault (a passphrase re-derived,
  // or a security key asserted again), so what is verified is that this factor opens this copy.
  const copy = await reopen(copyPath, raw, purpose)
  try {
    const report = await verifyVaultIntegrity(copy, { live })
    // The ninth check (Phase 4b, D1): the copy's record against the copy's own record key.
    const record = await verifyEvmRecordCopy(copy, evmRecordPath(copyPath))
    return { report, copyHeader: copy.file, record }
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
  home: string,
  api: PathApi = nodePath,
): void {
  const config = api.resolve(candleConfigDir(env, home))
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

function reportJson(report: VerifyReport, live: UnlockedVault, record?: RecordVerifyOutcome) {
  const ninth = record !== undefined && !record.notApplicable
  return {
    steps: ninth ? 9 : 8,
    ...(ninth ? { evmRecord: { path: record.path, absent: record.absent, lines: record.lines } } : {}),
    addressChecked: report.addressChecked.length,
    rederived: report.rederived.length,
    notRederived: report.notRederived.length,
    comparedAgainstLive: report.comparedAgainstLive,
    nextIndex: live.index.hd.nextIndex,
    phraseRestoresDerivedKeysOnly: true,
  }
}

/**
 * Why this copy is sealed, as a clause the caller finishes. A recognised cloud folder names its
 * own class; a destination the CLI cannot place says what it cannot tell instead, which is the
 * fact the operator needs (AD-9 amendment, Andrew, 2026-09-19).
 */
export function sealReason(destination: DestinationDomain, target: string): string {
  return destination === "unknown"
    ? `Candle cannot tell whether ${target} syncs to an account`
    : `${target} is a ${destination} destination`
}

/**
 * AD-9 amendment: printed whenever a copy is sealed because the destination could not be placed,
 * so the operator learns it was the not-knowing that sealed the copy, and what to pass instead.
 */
export const UNPLACEABLE_DESTINATION_NOTE =
  "Candle cannot tell whether this path syncs to an account, so this copy carries only the passphrase and any security key, and no synced passkey or Touch ID envelope. Pass --accept-shared-domain to write a full copy there instead."

/** The part of the sealed-copy note that does not depend on whether a key was carried (§6.1). */
export const SEALED_COPY_REMAINDER =
  "It contains no synced passkey or Touch ID envelope. Keep the passphrase somewhere outside the Apple account that holds a synced passkey. The live vault plus the recovery phrase remain the everyday path; this copy is for the day both are gone."

/**
 * AD-9's consequence, printed on every sealed copy so the operator knows what the copy answers
 * to: one of two leads, chosen by whether the copy carries a security key, then the remainder.
 */
export function sealedCopyNote(securityKeyIds: string[]): string {
  const lead =
    securityKeyIds.length > 0
      ? `This copy opens with the passphrase it was sealed under, which may predate a passphrase rotation, or with security key ${securityKeyIds.join(", ")} (its PIN and a touch). Removing a key from this vault later does not remove it from this copy.`
      : "This copy opens only with the passphrase it was sealed under, which may predate a passphrase rotation. This vault had no security key for it to carry."
  return `${lead} ${SEALED_COPY_REMAINDER}`
}

/** `passphrase p1`, `security key k1`: an envelope as the report names it. */
export function labelEnvelope(envelope: Envelope): string {
  return `${wordFor(envelope)} ${envelope.id}`
}

/**
 * The lines between "Verified <path>" and the step count: the destination class, which kind of
 * copy was written, and (AD-9 amendment) why a copy to a path Candle cannot place is sealed. Pure,
 * so the wording an operator acts on is asserted directly rather than through a captured stream.
 * `kept` and `leftOut` are already labelled (`labelEnvelope`).
 */
export function backupVerdictLines(
  verdict: Partial<BackupDomainVerdict> | undefined,
  kept: string[],
  leftOut: string[],
): string[] {
  const lines: string[] = []
  if (verdict?.destination) lines.push(`  destination   ${verdict.destination}`)
  if (verdict?.sealed) {
    lines.push(
      `  sealed        yes: carries ${kept.join(", ")}${leftOut.length > 0 ? `; left out ${leftOut.join(", ")}` : ""}`,
    )
    if (verdict.destination === "unknown") lines.push(`  why sealed    ${UNPLACEABLE_DESTINATION_NOTE}`)
  } else if (verdict?.sharedDomainAccepted) {
    lines.push(`  sealed        no: every envelope is in this copy (--accept-shared-domain)`)
  }
  return lines
}

/**
 * The line an accepted unsealed copy ends on. Three cases, because the thing the operator accepted
 * differs: one Apple account holding both halves, a cloud account, or (AD-9 amendment) a path the
 * CLI could not place at all.
 */
export function sharedDomainLine(verdict: Partial<BackupDomainVerdict>): string {
  if (verdict.sharedDomain) {
    return `  shared domain this destination and a synced passkey envelope are one Apple account, and this unsealed copy carries that passkey's envelope; you accepted that.`
  }
  if (verdict.destination === "unknown") {
    return `  shared domain this unsealed copy carries every envelope to a path Candle cannot place, which may sync to an account; you accepted that.`
  }
  return `  shared domain this unsealed copy carries every envelope into a cloud account; you accepted that.`
}

function writeVerifiedReport(
  ctx: CommandContext,
  target: string,
  verdict: Partial<BackupDomainVerdict> | undefined,
  report: VerifyReport,
  live: UnlockedVault,
  opts: { copyEnvelopes: Envelope[]; leftOut: Envelope[]; verifiedWith: string; record?: RecordVerifyOutcome },
): void {
  const { deps } = ctx
  const kept = opts.copyEnvelopes.map(labelEnvelope)
  const leftOut = opts.leftOut.map(labelEnvelope)
  deps.stdout.write(`Verified ${target}\n`)
  for (const line of backupVerdictLines(verdict, kept, leftOut)) deps.stdout.write(`${line}\n`)
  deps.stdout.write(`${opts.verifiedWith}\n`)
  const ninth = opts.record !== undefined && !opts.record.notApplicable
  deps.stdout.write(`  steps         all ${ninth ? 9 : 8} passed, in order\n`)
  if (ninth && opts.record !== undefined) {
    deps.stdout.write(
      opts.record.absent
        ? `  EVM record    absent beside the copy (${opts.record.path}); nothing to check\n`
        : `  EVM record    ${opts.record.lines} line(s), each decrypts under this copy's record key\n`,
    )
  }
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
  if (verdict?.sharedDomainAccepted) deps.stdout.write(`${sharedDomainLine(verdict)}\n`)
  if (verdict?.sealed) {
    const keys = opts.copyEnvelopes.filter(isSecurityKeyEnvelope).map((envelope) => envelope.id)
    deps.stdout.write(`\n${sealedCopyNote(keys)}\n${APPLE_ACCOUNT_NOTICE}\n`)
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

/** Phase 4b (D1): what `vault backup` did with the sealed EVM record. */
export function recordCopyLine(outcome: RecordCopyOutcome): string {
  if (!outcome.present) return `  EVM record    none beside the live vault; no record written`
  return `  EVM record    ${outcome.copyPath}: ${outcome.copied} line(s) copied${outcome.dropped > 0 ? `, ${outcome.dropped} dropped (a torn line, or a line that does not decrypt under this vault's key; the sweep could not read them either)` : ""}`
}
