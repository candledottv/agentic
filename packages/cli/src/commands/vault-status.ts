/**
 * Ember Phase 2 (BE-136, CC-01, CC-03, CC-05, CC-11, N1): `candle vault status`.
 *
 * Two answers, one command, split exactly where the encryption is. Without `--unlock` it reports
 * what CC-01 states is readable WITHOUT a factor and nothing else: the vault id, generation and
 * timestamps, each envelope's factor, transport, domain, label, strength and availability, the
 * recoverable-factor count with domains counted once, the sidecar's bookkeeping, and the removed
 * envelope ids N1 asks it to name. With `--unlock` it adds what lives inside the index: the key
 * list with roles, derivation paths and exposure, the counters, `rootExported`, and the line about
 * what the phrase does not restore.
 *
 * That split is not a convenience. The cleartext half is exactly the pre-unlock exposure N4 asks
 * this document to state out loud, and printing it under one command makes it inspectable rather
 * than something a reader has to infer from the file.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { countRecoverableFactors } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { currentPlatformFacts } from "../vault/fido2"
import type { Envelope } from "../vault/format"
import { parseVaultFile } from "../vault/format"
import { strengthLabel } from "../vault/passphrase"
import { availabilityLabel, envelopeAvailability, type PlatformFacts } from "../vault/platform"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { fileExists, legacyWalletsPath, readVaultRaw } from "../vault/store"
import {
  assertVaultHelperIdentities,
  missingVault,
  refuseEnvPassphrase,
  requireTty,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/**
 * BE-245's nag. One sentence, said on every `status` until a backup has been verified from this
 * machine, because "no copy of this file exists anywhere" is the fact a vault holder most needs
 * and the one this command used to leave to inference. It names both destinations: a path, and
 * the iCloud Drive shorthand for the Macs where the literal path is why nobody bothers.
 */
export const NO_VERIFIED_BACKUP_NOTE =
  "No backup of this vault has ever been verified from this machine. If this file is lost, only the 24-word recovery phrase can rebuild it, and it rebuilds derived keys only. Take one now: candle vault backup --to <path>   (on a Mac with iCloud Drive: candle vault backup --to icloud)"

export async function vaultStatus(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--unlock", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const unlock = parsed.booleans.has("--unlock")
  if (unlock && !requireTty(ctx, "vault status --unlock")) return 1

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await readVaultRaw(path)
    if (raw === null) throw missingVault(ctx, resolvedVault)
    const file = parseVaultFile(raw)
    if (unlock) assertVaultHelperIdentities(deps, file.envelopes)
    const facts = await currentPlatformFacts(deps)
    const sidecar = await readSidecar(sidecarPath(path))
    // CC-05 / AD-3: named if present, never opened, never read. The vault has no code path that
    // touches this file at all.
    const legacy = legacyWalletsPath(deps.env)
    const legacyPresent = await fileExists(legacy)

    const envelopes = file.envelopes.map((envelope) => describeEnvelope(envelope, facts))
    const recoverable = countRecoverableFactors(file.envelopes)

    let unlocked:
      | {
          entries: ReturnType<typeof describeEntry>[]
          nextIndex: Record<string, number>
          exposedIndexes: Record<string, number[]>
          rootExported: boolean
          restored: boolean
        }
      | undefined
    if (unlock) {
      const vault = hold(
        (await unlockInteractively(ctx, path, raw, { acceptOlderCopy: parsed.booleans.has("--accept-older-copy") }))
          .vault,
      )
      unlocked = {
        entries: vault.index.entries.map(describeEntry),
        nextIndex: vault.index.hd.nextIndex,
        exposedIndexes: vault.index.hd.exposedIndexes,
        rootExported: vault.index.hd.rootExported,
        restored: vault.index.hd.discovery !== undefined,
      }
    }

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        path,
        version: file.version,
        generation: file.generation,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        envelopes,
        recoverableFactors: recoverable,
        sidecar: sidecar
          ? {
              lastGeneration: sidecar.lastGeneration,
              removedEnvelopeIds: sidecar.removedEnvelopeIds,
              lastVerifiedBackupAt: sidecar.lastVerifiedBackupAt,
              lastBackupDomain: sidecar.lastBackupDomain,
              lastBackupSharedDomainAccepted: sidecar.lastBackupSharedDomainAccepted,
              lastBackupSealed: sidecar.lastBackupSealed,
            }
          : null,
        legacyWalletsEnc: legacyPresent ? legacy : null,
        ...(unlocked ? { unlocked } : {}),
      })
      return 0
    }

    deps.stdout.write(`${path}\n`)
    deps.stdout.write(`  version      ${file.version}\n`)
    deps.stdout.write(`  generation   ${file.generation}\n`)
    deps.stdout.write(`  updated      ${file.updatedAt}\n`)
    deps.stdout.write(`\nFactors (${envelopes.length}), ${recoverable} recoverable (domains counted once):\n`)
    for (const envelope of envelopes) {
      deps.stdout.write(
        `  ${envelope.id}  ${envelope.factor}${envelope.transport ? `/${envelope.transport}` : ""}  ${envelope.domain}  ${envelope.availability}\n`,
      )
      deps.stdout.write(`      label      ${envelope.label || "(none)"}\n`)
      if (envelope.strength) deps.stdout.write(`      strength   ${envelope.strengthLabel}\n`)
      if (envelope.sharedDomainNote) deps.stdout.write(`      note       ${envelope.sharedDomainNote}\n`)
    }
    if (recoverable === 1) {
      // CC-07: the one case the blob cannot answer, said in words rather than left to be inferred.
      deps.stdout.write(
        `\nThis vault has exactly one recoverable factor. Lose it and no copy of this file can be opened; the recovery phrase is then the only route, and it restores derived keys only.\n`,
      )
    }

    if (sidecar) {
      deps.stdout.write(`\nThis machine's record (vault.state.json, cleartext, best effort):\n`)
      deps.stdout.write(`  last generation seen   ${sidecar.lastGeneration}\n`)
      if (sidecar.lastVerifiedBackupAt) {
        // "not recorded" rather than "unknown": since the AD-9 amendment (2026-09-19) `unknown` is
        // a destination class this field really carries, so it cannot double as the empty case.
        deps.stdout.write(
          `  last verified backup   ${sidecar.lastVerifiedBackupAt} (${sidecar.lastBackupDomain ?? "not recorded"}${sidecar.lastBackupSealed ? ", sealed: opens with the passphrase only" : ""})\n`,
        )
      }
      if (sidecar.lastBackupSharedDomainAccepted) {
        // AD-9: an unsealed copy went to a cloud destination; with a synced passkey on this vault
        // one account holds both, and this line stays for as long as the record does.
        deps.stdout.write(
          `  shared domain          accepted for the last backup destination (an unsealed copy, every envelope included)\n`,
        )
      }
      if (sidecar.removedEnvelopeIds.length > 0) {
        // N1: removing a factor is not revocation, and these are the ids that still open older
        // copies, which is the thing an operator has to know to decide which copies to worry about.
        deps.stdout.write(`  removed envelopes      ${sidecar.removedEnvelopeIds.join(", ")}\n`)
        deps.stdout.write(
          `                         any copy of this file made while one existed still opens with that factor.\n`,
        )
      }
    } else {
      deps.stdout.write(
        `\nNo vault.state.json beside this vault, so an older copy of it cannot be recognized on this machine.\n`,
      )
    }

    // BE-245: a vault with no verified backup says so EVERY time, rather than staying silent until
    // the day it matters. The sidecar already carried the fact and only ever printed it when there
    // was something to print, so the one state worth shouting about was the one state that said
    // nothing. Both shapes of "never" land here: a sidecar without the field, and no sidecar at all.
    if (sidecar?.lastVerifiedBackupAt === undefined) {
      deps.stdout.write(`\n${NO_VERIFIED_BACKUP_NOTE}\n`)
    }

    if (legacyPresent) {
      deps.stdout.write(`\nA legacy wallets.enc exists at ${legacy}; this CLI does not read it.\n`)
      deps.stdout.write(`  A key it holds that was imported is already a linked wallet, managed with: candle wallets\n`)
      deps.stdout.write(
        `  A key it holds that was never imported opens with an earlier release's \`wallets export\`; move those funds on chain to a vault key.\n`,
      )
    }

    if (!unlocked) {
      deps.stdout.write(
        `\nRun with --unlock to list the keys, the derivation counters and the exposure flags, which are inside the encrypted index.\n`,
      )
      return 0
    }

    deps.stdout.write(`\nKeys (${unlocked.entries.length}):\n`)
    for (const entry of unlocked.entries) {
      deps.stdout.write(`  ${entry.address}\n`)
      deps.stdout.write(`      label       ${entry.label || "(none)"}\n`)
      deps.stdout.write(`      role        ${entry.role} (${entry.origin})\n`)
      if (entry.derivation) deps.stdout.write(`      derivation  ${entry.derivation}\n`)
      deps.stdout.write(`      exposure    ${entry.exposure}\n`)
      if (entry.teeLifecycle)
        deps.stdout.write(
          `      tee         ${entry.teeLifecycle}${entry.teeRemoteState ? ` (server: ${entry.teeRemoteState})` : ""}\n`,
        )
      if (entry.destinationExposureAccepted) {
        deps.stdout.write(
          `      accepted    an operator asserted this pinned destination's history despite exposureUnknown\n`,
        )
      }
    }
    deps.stdout.write(`\nDerivation counters (next index per branch):\n`)
    for (const [branch, value] of Object.entries(unlocked.nextIndex)) {
      const exposed = unlocked.exposedIndexes[branch] ?? []
      deps.stdout.write(
        `  ${branch.padEnd(12)} ${value}${exposed.length > 0 ? `   known exposed: ${exposed.join(", ")}` : ""}\n`,
      )
    }
    deps.stdout.write(`  recovery phrase exported: ${unlocked.rootExported ? "yes" : "no"}\n`)
    if (unlocked.restored) {
      deps.stdout.write(
        `\nThis vault was built by \`vault restore --phrase\`. Its keys are recovery artifacts, not fresh cold keys, and it does not allocate new addresses; \`vault new-key\` and \`vault promote --from\` refuse here.\n`,
      )
    }
    deps.stdout.write(
      `\nThe recovery phrase restores derived keys only. It does not restore any key imported from the Phase 1 TEE wallet store; the vault file plus a factor does that.\n`,
    )
    return 0
  })
}

function describeEnvelope(envelope: Envelope, facts: PlatformFacts) {
  const availability = envelopeAvailability(envelope, facts)
  const strength = typeof envelope.strength === "string" ? envelope.strength : undefined
  return {
    id: envelope.id,
    factor: envelope.factor,
    transport: typeof envelope.transport === "string" ? envelope.transport : undefined,
    domain: envelope.domain,
    label: envelope.label,
    createdAt: envelope.createdAt,
    availability: availabilityLabel(availability),
    availabilityReason: availability.state === "available" ? undefined : availability.reason,
    strength,
    strengthLabel: strength === "generated-103" || strength === "user-chosen" ? strengthLabel(strength) : undefined,
    // AD-2: an `apple-account` envelope and a cloud-synced backup path are ONE domain, not two
    // factors, and `status` says so for as long as both exist.
    sharedDomainNote:
      envelope.domain === "apple-account"
        ? "lives in your Apple account; never counted as independent of any other Apple-account item"
        : undefined,
  }
}

function describeEntry(entry: Parameters<typeof describeEntryInner>[0]) {
  return describeEntryInner(entry)
}

function describeEntryInner(entry: import("../vault/format").KeyEntry) {
  const flags: string[] = []
  if (entry.exposure.everRemoteExposed) flags.push("remotely exposed")
  if (entry.exposure.everExported) flags.push("exported")
  if (entry.exposure.exposureUnknown) flags.push("history unknown (restored)")
  return {
    address: entry.address,
    label: entry.label,
    role: entry.role,
    origin: entry.origin,
    derivation: entry.derivation?.path,
    exposure: flags.length > 0 ? flags.join(", ") : "cold in this vault's record",
    teeLifecycle: entry.tee?.lifecycle,
    teeRemoteState: entry.tee?.remoteState,
    destinationExposureAccepted: entry.tee?.destinationExposureAccepted === true,
  }
}
