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
 *
 * `--json` is one object. `unlocked` is present only with `--unlock`: the labels live inside the
 * index, and a locked read must not carry the key (the absence is the contract, not a second
 * shape to collapse). There is no MCP twin.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { fields, heading, notice, symbols, terminalStyle } from "../presentation"
import { formatTime } from "../render"
import { countRecoverableFactors, isSecurityKeyEnvelope } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { currentPlatformFacts } from "../vault/fido2"
import type { Envelope } from "../vault/format"
import { parseVaultFile } from "../vault/format"
import { duplicateLabels } from "../vault/labels"
import { strengthLabel } from "../vault/passphrase"
import { availabilityLabel, envelopeAvailability, type PlatformFacts } from "../vault/platform"
import { readSidecar, sidecarPath, type VaultSidecar } from "../vault/sidecar"
import { fileExists, legacyWalletsPath, readVaultRaw } from "../vault/store"
import {
  assertVaultHelperIdentities,
  describeEntry,
  missingVault,
  refuseEnvPassphrase,
  refusePromptsWithoutTerminal,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/** BE-274 (D9)'s pointer, printed under `--unlock`'s key block. Exported so T13 pins the bytes. */
export const LIST_POINTER = "One line per key, with an optional SOL balance: candle vault list"

/**
 * BE-245's nag. Said on every `status` until a backup has been verified from this
 * machine, because "no copy of this file exists anywhere" is the fact a vault holder most needs
 * and the one this command used to leave to inference. It names both destinations: a path, and
 * the iCloud Drive shorthand for the Macs where the literal path is why nobody bothers.
 */
export const NO_VERIFIED_BACKUP_NOTE =
  "No backup of this vault has ever been verified from this machine. If this file is lost, only the 24-word recovery phrase can rebuild it, and it rebuilds derived keys only. Take one now:\ncandle vault backup --to <path>\non a Mac with iCloud Drive: candle vault backup --to icloud"

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
  // BE-1551 (A11): no up-front TTY refusal. A passphrase, PIN or menu prompt refuses where it is
  // reached when stdin or stderr is not a terminal; Touch ID and a synced passkey ask nothing, so
  // `--unlock --json > file` works with them. Stdout is the result channel and is never checked.
  const unlockCtx = refusePromptsWithoutTerminal(ctx, "vault status --unlock")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await readVaultRaw(path)
    if (raw === null) throw missingVault(ctx, resolvedVault)
    const file = parseVaultFile(raw)
    if (unlock) assertVaultHelperIdentities(deps, file.envelopes)
    const facts = await currentPlatformFacts(deps)
    const sidecar = await readSidecar(sidecarPath(path))
    // CC-05 / AD-3: named if present, never opened, never read. The vault has no code path that
    // touches this file at all.
    const legacy = legacyWalletsPath(deps.env, deps.homedir())
    const legacyPresent = await fileExists(legacy)

    const envelopes = file.envelopes.map((envelope) => describeEnvelope(envelope, facts))
    const recoverable = countRecoverableFactors(file.envelopes)
    const backup = sidecar ? describeLastBackup(sidecar, file.envelopes) : undefined

    let unlocked:
      | {
          entries: ReturnType<typeof describeEntry>[]
          /** BE-259 (D5): every label more than one key carries; `[]` when none, never absent. */
          duplicateLabels: { label: string; entries: { address: string; id: string }[] }[]
          nextIndex: Record<string, number>
          exposedIndexes: Record<string, number[]>
          rootExported: boolean
          restored: boolean
        }
      | undefined
    if (unlock) {
      const vault = hold(
        (
          await unlockInteractively(unlockCtx, path, raw, {
            acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
          })
        ).vault,
      )
      unlocked = {
        entries: vault.index.entries.map(describeEntry),
        duplicateLabels: duplicateLabels(vault.index).map((duplicate) => ({
          label: duplicate.label,
          entries: duplicate.entries.map((entry) => ({ address: entry.address, id: entry.id })),
        })),
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
              // BE-292 (D8, D9): the raw fields as stored, and the one flag a reader must follow
              // before treating the ids as a description of the newest copy.
              lastBackupAt: sidecar.lastBackupAt,
              lastBackupEnvelopeIds: sidecar.lastBackupEnvelopeIds,
              lastBackupEnvelopeIdsAt: sidecar.lastBackupEnvelopeIdsAt,
              lastBackupIdsVerifiedAt: sidecar.lastBackupIdsVerifiedAt,
              lastBackupEnvelopeIdsBound: backup?.bound ?? false,
            }
          : null,
        legacyWalletsEnc: legacyPresent ? legacy : null,
        ...(unlocked ? { unlocked } : {}),
      })
      return 0
    }

    const style = terminalStyle(deps, "stdout")
    const miss = symbols(style).missing
    const write = (line = "") => deps.stdout.write(`${line}\n`)
    write(path)
    write("")
    write(heading("Vault", style))
    write("")
    for (const line of fields(
      [
        ["Version", String(file.version)],
        ["Generation", String(file.generation)],
        ["Updated", formatTime(file.updatedAt)],
      ],
      style,
    ))
      write(line)
    write("")
    write(heading("Factors", style))
    write("")
    write(`${" ".repeat(2)}${envelopes.length} factors, ${recoverable} recoverable (domains counted once)`)
    for (const envelope of envelopes) {
      write("")
      write(`${" ".repeat(2)}${envelope.id}`)
      const rows: [string, string][] = [
        ["Factor", envelope.factor],
        ["Domain", envelope.domain],
        ["Availability", envelope.availability],
        ["Label", envelope.label || miss],
      ]
      if (envelope.transport) rows.splice(1, 0, ["Transport", envelope.transport])
      if (envelope.strengthLabel) rows.push(["Strength", envelope.strengthLabel])
      if (envelope.sharedDomainNote) rows.push(["Note", envelope.sharedDomainNote])
      for (const line of fields(rows, style, 4)) write(line)
    }
    if (recoverable === 1) {
      // CC-07: the one case the blob cannot answer, said in words rather than left to be inferred.
      notice(
        deps,
        "stdout",
        "warning",
        "This vault has exactly one recoverable factor. Lose it and no copy of this file can be opened; the recovery phrase is then the only route, and it restores derived keys only.",
      )
    }

    write("")
    write(heading("This machine", style))
    if (sidecar) {
      write("")
      for (const line of fields(
        [
          ["Record", "vault.state.json, cleartext, best effort"],
          ["Last generation seen", String(sidecar.lastGeneration)],
        ],
        style,
      ))
        write(line)
      if (sidecar.lastVerifiedBackupAt && backup) {
        // "not recorded" rather than "unknown": since the AD-9 amendment (2026-09-19) `unknown` is
        // a destination class this field really carries, so it cannot double as the empty case.
        for (const line of lastBackupLines(sidecar, backup)) write(line)
      }
      if (sidecar.lastBackupSharedDomainAccepted) {
        // AD-9: an unsealed copy went to a cloud destination; with a synced passkey on this vault
        // one account holds both, and this line stays for as long as the record does.
        write(
          "  shared domain          accepted for the last backup destination (an unsealed copy, every envelope included)",
        )
      }
      if (sidecar.removedEnvelopeIds.length > 0) {
        // N1: removing a factor is not revocation, and these are the ids that still open older
        // copies, which is the thing an operator has to know to decide which copies to worry about.
        write(`  removed envelopes      ${sidecar.removedEnvelopeIds.join(", ")}`)
        write("                         any copy of this file made while one existed still opens with that factor.")
      }
    } else {
      notice(
        deps,
        "stdout",
        "note",
        "No vault.state.json beside this vault, so an older copy of it cannot be recognized on this machine.",
      )
    }

    // BE-245: a vault with no verified backup says so EVERY time, rather than staying silent until
    // the day it matters. The sidecar already carried the fact and only ever printed it when there
    // was something to print, so the one state worth shouting about was the one state that said
    // nothing. Both shapes of "never" land here: a sidecar without the field, and no sidecar at all.
    if (sidecar?.lastVerifiedBackupAt === undefined) notice(deps, "stdout", "warning", NO_VERIFIED_BACKUP_NOTE)

    if (legacyPresent) {
      notice(
        deps,
        "stdout",
        "warning",
        `A legacy wallets.enc exists at ${legacy}; this CLI does not read it.\nA key it holds that was imported is already a linked wallet, managed with: candle wallets\nA key it holds that was never imported opens with an earlier release's \`wallets export\`; move those funds on chain to a vault key.`,
      )
    }

    if (!unlocked) {
      notice(
        deps,
        "stdout",
        "note",
        "Run with --unlock to list the keys, the derivation counters and the exposure flags, which are inside the encrypted index.",
      )
      return 0
    }

    write("")
    write(heading(`Keys (${unlocked.entries.length})`, style))
    for (const entry of unlocked.entries) {
      write("")
      write(`${" ".repeat(2)}${entry.address}`)
      const rows: [string, string][] = [
        ["Label", entry.label || miss],
        ["Role", `${entry.role} (${entry.origin})`],
        ["Exposure", entry.exposure],
      ]
      if (entry.derivation) rows.splice(2, 0, ["Derivation", entry.derivation])
      if (entry.teeLifecycle)
        rows.push(["Tee", `${entry.teeLifecycle}${entry.teeRemoteState ? ` (server: ${entry.teeRemoteState})` : ""}`])
      if (entry.destinationExposureAccepted) {
        rows.push(["Accepted", "an operator asserted this pinned destination's history despite exposureUnknown"])
      }
      for (const line of fields(rows, style, 4)) write(line)
    }
    // BE-274 (D9): `list` owns the listing, and this is where an operator reading five lines per
    // key meets the one-line-per-key form. The block above stays in this release: removing it is a
    // breaking human-output change and a `--json` contract change (`unlocked.entries` is frozen),
    // and doing both in the slice that introduces `list` would leave no version in which the two
    // spellings overlap.
    write("")
    write(LIST_POINTER)
    // BE-259 (D5): the finding `rename` is the repair for. Every resolver is first-wins, so the
    // second key under a shared name is unreachable by it, and this block is the only place an
    // operator learns that. Absent when there are none.
    if (unlocked.duplicateLabels.length > 0) {
      write("")
      write(heading(`Duplicate labels (${unlocked.duplicateLabels.length})`, style))
      for (const line of duplicateLabelLines(unlocked.duplicateLabels)) write(line)
    }
    write("")
    write(heading("Derivation counters (next index per branch)", style))
    write("")
    for (const [branch, value] of Object.entries(unlocked.nextIndex)) {
      const exposed = unlocked.exposedIndexes[branch] ?? []
      write(`  ${branch.padEnd(12)} ${value}${exposed.length > 0 ? `   known exposed: ${exposed.join(", ")}` : ""}`)
    }
    write(`  recovery phrase exported: ${unlocked.rootExported ? "yes" : "no"}`)
    if (unlocked.restored) {
      notice(
        deps,
        "stdout",
        "note",
        "This vault was built by `vault restore --phrase`.\nIts keys are recovery artifacts, not fresh cold keys, and it does not allocate new addresses; `vault new-key` and `vault promote --from` refuse here.",
      )
    }
    notice(
      deps,
      "stdout",
      "note",
      "The recovery phrase restores derived keys only. It does not restore any key imported from the Phase 1 TEE wallet store; the vault file plus a factor does that.",
    )
    return 0
  })
}

/**
 * The rows of the duplicate block (§4.5): each label with the address and id of every entry that
 * carries it, and the line that says what `--from <label>` does about it. Pure, so the wording is
 * asserted directly rather than through a captured stream.
 */
export function duplicateLabelLines(
  duplicates: { label: string; entries: { address: string; id: string }[] }[],
): string[] {
  const lines: string[] = []
  for (const duplicate of duplicates) {
    const holders = duplicate.entries.map((entry) => `${entry.address} (${entry.id})`).join(", ")
    lines.push(`  ${duplicate.label.padEnd(14)}${duplicate.entries.length} keys: ${holders}`)
    lines.push(
      `                --from ${duplicate.label} always picks the first; rename one: candle vault rename <address> <new-label>`,
    )
  }
  return lines
}

/**
 * BE-292 (D8): what the sidecar says about the last backup's factors. The ids are BOUND to the
 * receipt only when both clauses hold: they were written with the backup (`lastBackupEnvelopeIdsAt
 * === lastBackupAt`) and the verification time still belongs to that receipt
 * (`lastBackupIdsVerifiedAt === lastVerifiedBackupAt`). Each side of each comparison must be a
 * string; a missing field is not bound. A 0.11.5 backup carries the first pair forward and
 * moves `lastVerifiedBackupAt` without the second stamp, which is what unbinds ids that describe
 * an older copy. Unbound ids are never named and never decide the advice.
 */
export function describeLastBackup(
  sidecar: VaultSidecar,
  live: Envelope[],
): { bound: boolean; keyIds: string[]; removedIds: string[]; freshBackupAdvised: string[] } {
  const bound =
    typeof sidecar.lastBackupEnvelopeIdsAt === "string" &&
    sidecar.lastBackupEnvelopeIdsAt === sidecar.lastBackupAt &&
    typeof sidecar.lastBackupIdsVerifiedAt === "string" &&
    sidecar.lastBackupIdsVerifiedAt === sidecar.lastVerifiedBackupAt
  const ids = bound ? (sidecar.lastBackupEnvelopeIds ?? []) : []
  const liveKeys = live.filter(isSecurityKeyEnvelope).map((envelope) => envelope.id)
  const keyIds = ids.filter((id) => liveKeys.includes(id))
  const removedIds = ids.filter((id) => !live.some((envelope) => envelope.id === id))
  // Sealed and unbound: an older writer kept passphrase envelopes only, so every live key is
  // missing from that copy. Bound: exactly the live keys the ids lack. Unsealed and unbound: the
  // ids say nothing about that copy, so nothing is advised (as on 0.11.5).
  const freshBackupAdvised = sidecar.lastBackupSealed
    ? liveKeys.filter((id) => !ids.includes(id))
    : bound
      ? liveKeys.filter((id) => !ids.includes(id))
      : []
  return { bound, keyIds, removedIds, freshBackupAdvised }
}

/** The `last verified backup` line, and the advice line when the live vault has a key the copy lacks (§6.4). */
export function lastBackupLines(sidecar: VaultSidecar, backup: ReturnType<typeof describeLastBackup>): string[] {
  const opensWith = () => {
    if (!sidecar.lastBackupSealed) return ""
    const factors = [
      ...backup.keyIds.map((id) => `security key ${id}`),
      ...backup.removedIds.map((id) => `removed envelope ${id}`),
    ]
    return factors.length > 0
      ? `, sealed: opens with the passphrase or ${factors.join(", ")}`
      : ", sealed: opens with the passphrase only"
  }
  const lines = [
    `  last verified backup   ${formatTime(sidecar.lastVerifiedBackupAt)} (${sidecar.lastBackupDomain ?? "not recorded"}${opensWith()})`,
  ]
  if (backup.freshBackupAdvised.length > 0) {
    lines.push(
      `  fresh backup advised   the last ${sidecar.lastBackupSealed ? "sealed " : ""}copy does not carry security key ${backup.freshBackupAdvised.join(", ")}; a new \`candle vault backup\` to the same destination would open with it too.`,
    )
  }
  return lines
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
