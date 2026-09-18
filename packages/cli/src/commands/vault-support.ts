/**
 * Ember Phase 2 (BE-136): the guards, prompts and failure rendering every `candle vault` command
 * shares, in one place so the refusals cannot drift between commands.
 *
 * The spec's Interfaces section states four rules for ALL vault commands, and each is exactly one
 * function here: refuse while `CANDLE_KEYSTORE_PASSPHRASE` is set; hidden prompt only; refuse
 * without a TTY when a secret has to be collected; `--json` output never contains a secret.
 */
import type { ParsedArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { isVaultError, VaultError } from "../vault/errors"
import { assertPrf, currentPlatformFacts, openSecurityKeySession, type SecurityKeySession } from "../vault/fido2"
import {
  type Ctap2Envelope,
  type Envelope,
  isCtap2Envelope,
  isPassphraseEnvelope,
  parseVaultFile,
} from "../vault/format"
import { wipe } from "../vault/hygiene"
import { canDrive, envelopeAvailability, type PlatformFacts, refusalCodeFor } from "../vault/platform"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import {
  closeVault,
  defaultVaultPath,
  readVaultRaw,
  type UnlockedVault,
  unlockVault,
  unlockWithPassphrase,
} from "../vault/store"

/**
 * ED-9 / AD-3: every vault command refuses while `CANDLE_KEYSTORE_PASSPHRASE` is set, exactly as
 * `tee` does, and the variable's VALUE is never read. After PR A it unlocks nothing anywhere; the
 * refusal stays so that a stale script fails loudly instead of believing it unlocked something.
 */
export function refuseEnvPassphrase(ctx: CommandContext): boolean {
  if (ctx.deps.env.CANDLE_KEYSTORE_PASSPHRASE === undefined) return true
  writeVaultFailure(
    ctx,
    new VaultError(
      "ENV_PASSPHRASE_REFUSED",
      "CANDLE_KEYSTORE_PASSPHRASE is set. No Candle command reads its value, and the vault never takes a passphrase from the environment.",
      {
        suggestion: "Unset it and run again; the vault commands prompt for the passphrase with input hidden.",
      },
    ),
  )
  return false
}

/**
 * The TTY rule, applied where a secret must actually be collected. `vault status` without
 * `--unlock` and `vault factor list` collect nothing, so they answer under `--json` for an agent
 * checking whether a vault exists; every command that prompts refuses here rather than hanging on
 * a pipe or falling back to some other input.
 */
export function requireTty(ctx: CommandContext, what: string): boolean {
  if (ctx.deps.isTTY.stdin && ctx.deps.isTTY.stdout) return true
  writeVaultFailure(
    ctx,
    new VaultError(
      "VAULT_UNLOCK_FAILED",
      `${what} needs a terminal: this CLI reads a vault passphrase or a security key PIN from a hidden prompt and from nowhere else.`,
      {
        suggestion: "There is no environment variable and no flag that supplies one.",
      },
    ),
  )
  return false
}

export function vaultPathFor(ctx: CommandContext, parsed: ParsedArgs): string {
  return parsed.values["--keystore"] ?? defaultVaultPath(ctx.deps.env)
}

/** Reads the vault, turning "no file" into the typed refusal that names how to make one. */
export async function requireVaultRaw(path: string): Promise<string> {
  const raw = await readVaultRaw(path)
  if (raw === null) {
    throw new VaultError("VAULT_MISSING", `No vault at ${path}.`, { suggestion: "Create one: candle vault init" })
  }
  return raw
}

export interface UnlockOptions {
  /** ED-6's whole-file rollback flag. */
  acceptOlderCopy?: boolean
  /** What the derivation notice and the prompt call this operation. */
  promptText?: string
  /**
   * Overrides `--factor` for a command that must open with one particular kind: adding a security
   * key unlocks with the passphrase, so the key being added is the only key the ceremony names.
   */
  factor?: string
}

/**
 * An opened vault together with the means to open it AGAIN with the same factor (Ember Phase 2,
 * BE-140). Commands that write and then verify (new-key, backup, promote, import-legacy) re-open
 * the file from disk through `reopen`, and the two that sign value (transfer, fund) ask for the
 * factor a second time through `confirm`, so that neither has to know whether a passphrase or a
 * security key opened the vault. A passphrase is re-derived from the string the operator typed; a
 * security key is asked for a fresh user-verified assertion, which is a second touch.
 */
export interface OpenedVault {
  vault: UnlockedVault
  factor:
    | { kind: "passphrase"; envelopeId: string }
    | { kind: "security-key"; envelopeId: string; session: SecurityKeySession }
  /** Opens `raw` (the bytes of `path`) with the same factor. The caller closes what it gets. */
  reopen: (path: string, raw: string) => Promise<UnlockedVault>
  /**
   * The second presentation of the factor before value moves: the passphrase typed again on a
   * hidden prompt, or the key touched again. `what` names the operation ("sign transfer of ...").
   */
  confirm: (what: string) => Promise<void>
}

type FactorChoice = { kind: "passphrase"; envelopeId?: string } | { kind: "security-key"; envelope: Ctap2Envelope }

/**
 * Prompts for the factor and opens the vault, having first applied ED-6's whole-file rollback
 * check against the sidecar.
 *
 * The check runs BEFORE the prompt so that an operator who has accidentally restored an old backup
 * learns that from the refusal rather than after typing a passphrase into it. It is best effort by
 * construction and says so: a same-user attacker can edit the sidecar, and a missing sidecar is a
 * warning rather than a refusal, because a vault legitimately arrives on a new machine without one.
 *
 * Which factor: `--factor` (or the command's own override) names an envelope id, `passphrase` or
 * `security-key`; an envelope this machine cannot drive is refused with CC-12's typed code. With no
 * flag, the vault's passphrase is used when it is the only kind this machine can drive, and when a
 * security key could also open it the operator is asked, on a visible prompt, which to use. The
 * CLI never picks a different envelope on the operator's behalf.
 */
export async function unlockInteractively(
  ctx: CommandContext,
  path: string,
  raw: string,
  opts: UnlockOptions = {},
): Promise<OpenedVault> {
  await assertNotOlderCopy(ctx, path, raw, opts.acceptOlderCopy ?? false)
  const { deps } = ctx
  const file = parseVaultFile(raw)
  const facts = await currentPlatformFacts(deps)
  const choice = await chooseFactor(ctx, file.envelopes, facts, opts.factor ?? ctx.vaultFactor)
  const notice = (line: string) => deps.stderr.write(line)

  if (choice.kind === "passphrase") {
    const typed = await deps.promptSecret(opts.promptText ?? "Vault passphrase (input hidden): ")
    const passphrase = typed.trim()
    if (passphrase === "") {
      throw new VaultError("VAULT_UNLOCK_FAILED", "A passphrase is required.")
    }
    // The passphrase is kept so a command that must RE-OPEN the file it just wrote (new-key's
    // verification, init's invariant 1 step) can do it without a second prompt. It is a JavaScript
    // string with CC-04's stated lifetime caveat either way; asking for it twice would not shorten
    // that and would train an operator to type a vault passphrase on demand.
    const open = (p: string, r: string) =>
      choice.envelopeId === undefined
        ? unlockWithPassphrase(p, r, passphrase, { notice })
        : unlockVault(p, r, { factor: "passphrase", passphrase, envelopeId: choice.envelopeId }, { notice })
    const vault = await open(path, raw)
    return {
      vault,
      factor: { kind: "passphrase", envelopeId: vault.envelope.id },
      reopen: open,
      confirm: async (what) => {
        const again = await deps.promptSecret(`Vault passphrase to ${what} (input hidden): `)
        if (again.trim() !== passphrase) {
          throw new VaultError("VAULT_UNLOCK_FAILED", "The passphrase did not match; nothing was signed.")
        }
      },
    }
  }

  // A security key. The helper, the device and the PIN are settled before the vault is touched.
  const envelope = choice.envelope
  const session = await openSecurityKeySession(deps, {
    vaultId: file.vaultId,
    envelopeId: envelope.id,
    deviceFlag: ctx.vaultDevice,
    requireFeatures: false,
  })
  const open = async (p: string, r: string): Promise<UnlockedVault> => {
    const current = parseVaultFile(r)
    const target = current.envelopes.find((candidate) => candidate.id === envelope.id)
    if (target === undefined || !isCtap2Envelope(target)) {
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `The file at ${p} has no security key envelope ${envelope.id}.`)
    }
    const prfOutput = await assertPrf(deps, session, target, current.vaultId, "unlock the vault")
    try {
      return await unlockVault(p, r, { factor: "passkey-prf", envelopeId: target.id, prfOutput }, { notice })
    } finally {
      wipe(prfOutput)
    }
  }
  const vault = await open(path, raw)
  return {
    vault,
    factor: { kind: "security-key", envelopeId: envelope.id, session },
    reopen: open,
    confirm: async (what) => {
      // A fresh user-verified assertion that opens the file again: the same proof the first open
      // was, made a second time, for the same reason the passphrase is typed a second time.
      deps.stderr.write(`Present the security key again to ${what}.\n`)
      closeVault(await open(path, raw))
    },
  }
}

/** Which envelope kinds are on the file, which of them this machine can drive, and the choice. */
async function chooseFactor(
  ctx: CommandContext,
  envelopes: Envelope[],
  facts: PlatformFacts,
  flag: string | undefined,
): Promise<FactorChoice> {
  const passphrases = envelopes.filter(isPassphraseEnvelope)
  const keys = envelopes.filter(isCtap2Envelope)
  const drivableKeys = keys.filter((envelope) => canDrive(envelope, facts))
  const listKeys = (candidates: Ctap2Envelope[]) =>
    candidates.map((envelope) => `  ${envelope.id}  security key  ${envelope.label || "(no label)"}`).join("\n")

  if (flag === undefined) {
    if (drivableKeys.length === 0) {
      if (passphrases.length === 0) {
        throw new VaultError(
          "VAULT_FACTOR_UNAVAILABLE",
          "This vault has no passphrase envelope, and no other envelope on it can be driven on this machine.",
          { suggestion: "Run `candle vault status` to see each factor and why it is not available here." },
        )
      }
      return { kind: "passphrase" }
    }
    if (passphrases.length === 0 && drivableKeys.length === 1)
      return { kind: "security-key", envelope: drivableKeys[0] as Ctap2Envelope }
    // More than one kind can open it here: the operator says which. Visible prompt, nothing secret.
    const answer = (
      await ctx.deps.promptLine(
        `This vault opens with${passphrases.length > 0 ? " a passphrase or" : ""} a security key. Type passphrase, or the id of a security key envelope:\n${listKeys(drivableKeys)}\n> `,
      )
    ).trim()
    if (answer === "passphrase" && passphrases.length > 0) return { kind: "passphrase" }
    const chosen = drivableKeys.find((envelope) => envelope.id === answer)
    if (chosen) return { kind: "security-key", envelope: chosen }
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `No factor named ${JSON.stringify(answer)}; nothing was tried.`, {
      suggestion: "Answer passphrase, or one of the envelope ids listed, or pass --factor.",
    })
  }

  if (flag === "passphrase") {
    if (passphrases.length === 0)
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "This vault has no passphrase envelope.")
    return { kind: "passphrase" }
  }
  if (flag === "security-key") {
    if (keys.length === 0) {
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "This vault has no security key envelope.", {
        suggestion: "Add one: candle vault factor add security-key",
      })
    }
    if (keys.length > 1) {
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `This vault has ${keys.length} security key envelopes; name one with --factor <id>:\n${listKeys(keys)}`,
      )
    }
    return { kind: "security-key", envelope: assertDrivable(keys[0] as Ctap2Envelope, facts) }
  }
  const named = envelopes.find((envelope) => envelope.id === flag)
  if (named === undefined) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `This vault has no envelope with id ${flag}.`, {
      suggestion: "Run `candle vault factor list` for the ids.",
    })
  }
  if (isPassphraseEnvelope(named)) return { kind: "passphrase", envelopeId: named.id }
  if (isCtap2Envelope(named)) return { kind: "security-key", envelope: assertDrivable(named, facts) }
  // CC-12: an envelope this platform cannot drive, asked for by name, is the typed refusal and
  // never a substitution.
  const availability = envelopeAvailability(named, facts)
  if (availability.state === "available") {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `Envelope ${named.id} is a ${named.factor} envelope this release cannot open.`,
    )
  }
  throw new VaultError(
    refusalCodeFor(availability),
    `Envelope ${named.id} (${named.factor}${typeof named.transport === "string" ? `/${named.transport}` : ""}) cannot open the vault here: ${availability.reason}.`,
    { suggestion: "No other envelope was tried. Run `candle vault status` to see which factors can open it here." },
  )
}

function assertDrivable(envelope: Ctap2Envelope, facts: PlatformFacts): Ctap2Envelope {
  const availability = envelopeAvailability(envelope as unknown as Envelope, facts)
  if (availability.state === "available") return envelope
  throw new VaultError(
    refusalCodeFor(availability),
    `The security key envelope ${envelope.id} cannot open the vault here: ${availability.reason}.`,
    { suggestion: "No other envelope was tried. Run `candle vault status` to see which factors can open it here." },
  )
}

/**
 * ED-6: a copy whose generation is BELOW what this machine last saw is an older whole-file copy.
 * That shape is internally consistent and cannot be detected from the file alone, so this is the
 * only place it can be caught, and the refusal names which envelopes the current copy has that the
 * sidecar remembers.
 */
export async function assertNotOlderCopy(
  ctx: CommandContext,
  path: string,
  raw: string,
  accept: boolean,
): Promise<void> {
  const sidecar = await readSidecar(sidecarPath(path))
  if (sidecar === null) {
    ctx.deps.stderr.write(`No vault.state.json beside this vault, so an older copy of it cannot be recognized here.\n`)
    return
  }
  let generation: unknown
  let vaultId: unknown
  let envelopeIds: string[] = []
  try {
    const parsed = JSON.parse(raw) as { generation?: unknown; vaultId?: unknown; envelopes?: Array<{ id?: unknown }> }
    generation = parsed.generation
    vaultId = parsed.vaultId
    envelopeIds = (parsed.envelopes ?? []).map((envelope) => String(envelope.id))
  } catch {
    return
  }
  if (vaultId !== sidecar.vaultId) return
  if (!Number.isInteger(generation) || (generation as number) >= sidecar.lastGeneration) return

  const known = new Set(sidecar.envelopeIds)
  const onlyHere = envelopeIds.filter((id) => !known.has(id))
  const detail =
    onlyHere.length > 0 ? ` This copy carries envelope(s) the last one here did not: ${onlyHere.join(", ")}.` : ""
  if (!accept) {
    throw new VaultError(
      "VAULT_OLDER_COPY",
      `This vault is generation ${String(generation)}, but this machine last saw generation ${sidecar.lastGeneration}, so it is an older copy.${detail}`,
      {
        suggestion:
          "If you meant to restore an older backup, pass --accept-older-copy. Editing vault.state.json defeats this check and it is not a defense against anyone with access to this account.",
      },
    )
  }
  ctx.deps.stderr.write(
    `Opening an older copy: generation ${String(generation)} against the ${sidecar.lastGeneration} this machine last saw.${detail}\n`,
  )
}

/** CC-08's confirmation. The last six characters, typed, visible, before anything is signed or pinned. */
export async function confirmLastSix(ctx: CommandContext, address: string, what: string): Promise<void> {
  const expected = address.slice(-6)
  const typed = (await ctx.deps.promptLine(`Type the last six characters of ${what} (${address}) to confirm: `)).trim()
  if (typed !== expected) {
    throw new VaultError(
      "DESTINATION_NOT_CONFIRMED",
      "That is not the last six characters of that address; nothing was done.",
    )
  }
}

/** Writes a vault failure in whichever mode this invocation is in, and answers its exit code. */
export function writeVaultFailure(ctx: CommandContext, error: unknown): number {
  if (isVaultError(error)) {
    writeLocalFailure(
      ctx.deps,
      { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
      ctx.json,
    )
    return error.exitCode
  }
  writeLocalFailure(
    ctx.deps,
    { code: "VAULT_UNREADABLE", message: error instanceof Error ? error.message : String(error) },
    ctx.json,
  )
  return 1
}

export function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

/**
 * Runs `body` with the vault failure mapping applied, closing the vault it opened whatever happens.
 * Every vault command is one call to this, so "did this path release the DEK?" has one answer.
 */
export async function runVaultCommand(
  ctx: CommandContext,
  body: (track: { hold: (vault: UnlockedVault) => UnlockedVault }) => Promise<number>,
): Promise<number> {
  const held: UnlockedVault[] = []
  try {
    return await body({
      hold: (vault) => {
        held.push(vault)
        return vault
      },
    })
  } catch (error) {
    return writeVaultFailure(ctx, error)
  } finally {
    for (const vault of held) closeVault(vault)
  }
}

/** One JSON value on stdout, as the CLI's agent contract requires. Never carries a secret. */
export function writeJson(deps: Deps, value: unknown): void {
  deps.stdout.write(`${JSON.stringify(value)}\n`)
}
