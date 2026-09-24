/**
 * Ember Phase 2 (BE-136): the guards, prompts and failure rendering every `candle vault` command
 * shares, in one place so the refusals cannot drift between commands.
 *
 * The spec's Interfaces section states four rules for ALL vault commands, and each is exactly one
 * function here: refuse while `CANDLE_KEYSTORE_PASSPHRASE` is set; hidden prompt only; refuse
 * without a TTY when a secret has to be collected; `--json` output never contains a secret.
 */
import { dirname } from "node:path"
import { isUsageError, type ParsedArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { safeText } from "../trading"
import { type EnclaveSession, openEnclaveSession, pinnedHelperIdentity, unwrapKekWithEnclave } from "../vault/enclave"
import { isVaultError, VaultError } from "../vault/errors"
import {
  type AttachedKeys,
  assertPrf,
  currentPlatformFacts,
  openSecurityKeySession,
  probeAttachedKeys,
  type SecurityKeySession,
} from "../vault/fido2"
import {
  type Ctap2Envelope,
  type Envelope,
  type IndexPlaintext,
  isCtap2Envelope,
  isPassphraseEnvelope,
  isPlatformPasskeyEnvelope,
  isSecureEnclaveEnvelope,
  type KeyEntry,
  type PlatformPasskeyEnvelope,
  parseVaultFile,
  type SecureEnclaveEnvelope,
} from "../vault/format"
import { wipe } from "../vault/hygiene"
import { assertPlatformPrf, openPasskeySession, type PasskeySession } from "../vault/passkey"
import { passphraseAttempts } from "../vault/passphrase"
import {
  availabilityLabel,
  canDrive,
  envelopeAvailability,
  type PlatformFacts,
  refusalCodeFor,
} from "../vault/platform"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import {
  CONFIG_DIR_ENV,
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
 * D8's passphrase choice: Enter for the generated passphrase, `own` to choose one. Anything else
 * is asked once more and then treated as Enter, because the generated branch is AD-6's default and
 * a third reading of the same question teaches nothing. `--own-passphrase` never reaches here.
 *
 * One implementation, two callers (BE-245). `restore` shipped this prompt in 0.11.1 and `init`
 * shipped without it, which is how the same decision came to have one discoverable interface and
 * one undiscoverable one. The two prompts still read differently -- a restored vault's passphrase
 * is NEW and says so -- so the wording is the caller's and only the behaviour is shared. Neither
 * command has a machine form: both are refused under `--json` unless `--own-passphrase` is passed.
 */
export async function askForOwnPassphrase(ctx: CommandContext, promptText: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await ctx.deps.promptLine(promptText)).trim().toLowerCase()
    if (answer === "own") return true
    if (answer === "") return false
  }
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

/**
 * The streams the PROMPT uses, which is not the same set `requireTty` demands (BE-274, D7).
 *
 * `requireTty` asks for stdin AND stdout, and the stdout half is over-broad: the shipped prompts
 * read stdin and write STDERR (`prompt-streams.ts`'s `realPromptStreams` names `output:
 * process.stderr`, asserted at the source in `prompt-streams.test.ts`), which is exactly why a
 * `--json` command that unlocks on a terminal still leaves one JSON value on stdout. So the stdout
 * clause refuses the one shape every tool of this kind supports -- `candle vault list --json >
 * file` -- and pushes operators to `script -q`, which the wallet migration got wrong twice in one
 * sitting.
 *
 * `vault list` is the one command whose whole output is a document an operator redirects, so
 * stdout is the payload channel and carries no part of the ceremony. Every other command keeps
 * `requireTty` unchanged: relaxing `status --unlock --json`, `vault factor list` and `export-key`
 * is a behaviour change on shipped commands and is its own card (the spec's §7).
 */
export function requirePromptStreams(ctx: CommandContext, what: string): boolean {
  if (ctx.deps.isTTY.stdin && ctx.deps.isTTY.stderr) return true
  writeVaultFailure(
    ctx,
    new VaultError(
      "VAULT_UNLOCK_FAILED",
      `${what} needs a terminal for the passphrase prompt: standard input and standard error must both be a terminal. Standard output may be redirected; that is where the listing goes.`,
    ),
  )
  return false
}

/** Where the vault path this invocation uses came from (D3). */
export type VaultPathSource = "flag" | "env" | "default"

/** A vault path together with WHY it is that path. The `source` is the whole point: the operator
 * in BE-235 item 4 passed `--keystore` to `init` and not to `factor add`, and got "no vault" from
 * one command and "already exists" from the next, both true, neither saying where it looked. */
export interface ResolvedVaultPath {
  path: string
  source: VaultPathSource
}

/**
 * The vault file for this invocation: `--keystore` (or `-k`), else `CANDLE_CONFIG_DIR`, else the
 * default. Returns `{ error }` rather than throwing for the one refusal that can happen here, a
 * `CANDLE_CONFIG_DIR` beginning with a literal `~` (D4): every caller already returns `usage(ctx,
 * ...)` on a parse error, so that is exit 2 and the `USAGE` envelope, decided before any file is
 * opened.
 */
export function vaultPathFor(ctx: CommandContext, parsed: ParsedArgs): ResolvedVaultPath | { error: string } {
  const flag = parsed.values["--keystore"]
  // Already checked for a literal `~` at parse time, by the `pathFlags` entry on every spec that
  // takes `--keystore`.
  if (flag !== undefined) return { path: flag, source: "flag" }
  try {
    const path = defaultVaultPath(ctx.deps.env, ctx.deps.homedir())
    return { path, source: ctx.deps.env[CONFIG_DIR_ENV]?.trim() ? "env" : "default" }
  } catch (error) {
    if (isUsageError(error)) return { error: error.message }
    throw error
  }
}

/**
 * D3's parenthetical: why THIS path. One clause, appended to the message of the two refusals an
 * operator meets while setting a vault up, and the thing that makes them self-correcting -- someone
 * who passed `--keystore` last time and not this time reads "the default" and understands before
 * reading any suggestion.
 */
function pathSourceNote(ctx: CommandContext, resolved: ResolvedVaultPath): string {
  switch (resolved.source) {
    case "flag":
      return "(from --keystore)"
    case "env":
      return `(from ${CONFIG_DIR_ENV}=${ctx.deps.env[CONFIG_DIR_ENV]?.trim()})`
    default:
      return `(the default: no --keystore given and ${CONFIG_DIR_ENV} is unset)`
  }
}

/** The machine-readable half of the same two facts, for an agent that would otherwise have to
 * parse the parenthetical out of `message`. */
function pathDetails(resolved: ResolvedVaultPath): Record<string, string> {
  return { path: resolved.path, pathSource: resolved.source }
}

/**
 * `VAULT_MISSING`, from one place (D3). The three throw sites this replaces all carried the single
 * branch `Create one: candle vault init`, which is the wrong branch on a machine whose vault is
 * somewhere else -- and on a machine with real funds it is how someone ends up with two vaults and
 * trusts the empty one.
 *
 * So the suggestion names EVERY branch the operator might be on, cheapest-if-wrong first: checking
 * a path costs nothing, while creating a vault first is the branch that costs a second vault. The
 * human form is an aligned two-line block; under `--json` the same two branches are one sentence,
 * because an envelope's `suggestion` is read, not laid out.
 */
export function missingVault(ctx: CommandContext, resolved: ResolvedVaultPath): VaultError {
  const { path } = resolved
  const suggestion =
    resolved.source === "default"
      ? ctx.json
        ? `If your vault is somewhere else, point at it: candle vault status -k <path>, or export ${CONFIG_DIR_ENV}=<its directory>. If you have never made one: candle vault init`
        : `  If your vault is somewhere else, point at it:   candle vault status -k <path>   or   export ${CONFIG_DIR_ENV}=<its directory>\n  If you have never made one:                     candle vault init`
      : ctx.json
        ? `If the path is wrong, check it: ls -l ${path}. If you have never made one: candle vault init -k ${path}`
        : `  If the path is wrong, check it:   ls -l ${path}\n  If you have never made one:       candle vault init -k ${path}`
  return new VaultError("VAULT_MISSING", `No vault at ${path} ${pathSourceNote(ctx, resolved)}.`, {
    suggestion,
    details: pathDetails(resolved),
  })
}

/**
 * `VAULT_EXISTS`, the other half of the contradiction the operator saw. It keeps each caller's own
 * suggestion and gains the same parenthetical and the same `details`, so the two messages read
 * together as "the first command looked at the default and found nothing; the second looked at the
 * default and found the vault made minutes earlier".
 */
export function vaultAlreadyExists(ctx: CommandContext, resolved: ResolvedVaultPath, suggestion: string): VaultError {
  return new VaultError(
    "VAULT_EXISTS",
    `A vault already exists at ${resolved.path} ${pathSourceNote(ctx, resolved)}.`,
    {
      suggestion,
      details: pathDetails(resolved),
    },
  )
}

/**
 * D8/D10's footer, printed by `init` and `restore` when `-k`/`--keystore` put the vault somewhere
 * other than the default: the moment the non-default vault is BORN is the moment to say that every
 * later command needs the flag, or the variable that moves every file together. Human mode only;
 * the `--json` payloads of both commands already carry `path`.
 */
export function nonDefaultVaultFooter(resolved: ResolvedVaultPath): string | undefined {
  if (resolved.source !== "flag") return undefined
  return `\nThis vault is at ${resolved.path}, not the default location. Every vault command needs -k ${resolved.path}, or set it once: export ${CONFIG_DIR_ENV}=${dirname(resolved.path)}\n`
}

/** Reads the vault, turning "no file" into the typed refusal that names where it looked and why. */
export async function requireVaultRaw(ctx: CommandContext, resolved: ResolvedVaultPath): Promise<string> {
  const raw = await readVaultRaw(resolved.path)
  if (raw === null) throw missingVault(ctx, resolved)
  return raw
}

export interface UnlockOptions {
  /** ED-6's whole-file rollback flag. */
  acceptOlderCopy?: boolean
  /** What the derivation notice and the prompt call this operation. */
  promptText?: string
  /**
   * Overrides `--factor` for a command that must open with one particular kind (`verify-backup`'s
   * prompt for the copy's own passphrase). The three `factor add` sites no longer force the
   * passphrase (BE-337 D1): they restrict with `among` instead.
   */
  factor?: string
  /**
   * BE-292 (D3, D5): restricts the factors this open will accept to the envelopes whose ids are
   * listed, so a sealed backup opens the live vault with a factor the copy will carry, and
   * `verify-backup` with one the copy carries byte for byte. The chooser, `--factor <kind>` and
   * `--factor <id>` all read the restricted list and keep their own refusal wording. `--factor`
   * naming an envelope the vault has but the list leaves out prints one line
   * (`--factor <value> is not used here: <excludedBecause>`) and falls through to the restricted
   * chooser rather than refusing, because the operator's intent is still achievable. When the
   * restricted list allows only the passphrase and the vault has another envelope, `because`
   * is the `Passphrase only:` reason (D7, case a); it is handed the restricted envelopes this
   * machine cannot drive, so a call site can name them and their availability.
   */
  among?: {
    envelopeIds: string[]
    because: (unusable: UnusableEnvelope[]) => string
    excludedBecause: string
  }
  /**
   * BE-292 (D7, case a): the `Passphrase only:` reason for a command whose `factor` override is
   * the passphrase (the three `factor add` sites). Printed before the passphrase prompt when the
   * vault has an envelope other than the passphrase; on a vault whose only envelope is the
   * passphrase there is nothing to explain and no line is printed.
   */
  passphraseOnlyBecause?: string
  /**
   * With `passphraseOnlyBecause`: print the line even when the file being opened holds only a
   * passphrase envelope. `verify-backup`'s prompt for the COPY's own passphrase is the one
   * case (row V2): the file is the copy, the vault the operator holds has other factors, and the
   * line explains a second passphrase prompt that would otherwise be a mystery.
   */
  passphraseOnlyEvenIfSole?: boolean
  /**
   * What the Touch ID prompt says this unlock is for (ED-12: the reason string names the
   * operation). Commands that move value name the amount, the asset and the destination through
   * `confirm` instead; this is the first open's line, and it defaults to unlocking the vault.
   */
  reason?: string
  /**
   * BE-259 (D2): what the Argon2id derivation line says this open is FOR. `derivePassphraseKek`
   * writes `Deriving the vault key (Argon2id, <m> MiB)` plus a trailing newline inside one string;
   * with a purpose the wrapper here inserts ` -- <purpose>` before that newline, so the suffix
   * stays on the same line and `crypto.ts` is not edited. With no purpose the string is written
   * unchanged, newline included. Not the passkey PRF reason named `purpose` further down: that is
   * what the platform's sheet asserts for, this is the derivation-line suffix.
   */
  purpose?: string
  /**
   * BE-337 (D1): a probe the command already ran, used by the chooser in place of its own, so a
   * command that needs the probe's device answer (`factor add security-key`, over EVERY attached
   * device rather than the one `--device` names) runs exactly one probe per command. The KEY's
   * presence is what counts: a command whose probe failed passes `attached: undefined` and the
   * menu is drawn without markers rather than from a second probe.
   */
  attached?: AttachedKeys | undefined
  /**
   * BE-337 (D2, D4): the spec's `keyDevice`. Called once, after the factor is chosen and before any
   * prompt or helper session for it, with what was chosen. `factor add security-key` decides its
   * opening and enrolling devices here (D2), makes refusals 1 and 2 (D3), and with the passphrase
   * chosen opens the enrolling key's session first, as before. For a security-key choice the
   * returned `preferDevice` replaces `--device` for this one unlock: `deviceFlag` is undefined and
   * the opener's session selects that device, so `--device` (the key being ADDED, in that command)
   * never reaches the opener. Every other command leaves this unset and `--device` names the opener.
   */
  onFactorChosen?: (chosen: ChosenFactor) => Promise<{ preferDevice: string } | undefined>
}

/** BE-337: what `onFactorChosen` is told. The envelope is the header's, not yet authenticated. */
export type ChosenFactor =
  | { kind: "passphrase"; envelopeId?: string }
  | { kind: "security-key"; envelope: Ctap2Envelope }
  | { kind: "touch-id"; envelope: SecureEnclaveEnvelope }
  | { kind: "passkey"; envelope: PlatformPasskeyEnvelope }

/**
 * BE-337 (D1): the `among` the three `factor add` commands open with: every passphrase envelope and
 * every CTAP2 security key envelope, never Touch ID or a synced passkey. Why: a synced passkey is
 * an `apple-account` factor, and letting it authorise enrollment would let whoever holds the Apple
 * account add a hardware key that outlives the passkey's removal (the AD-9 problem again). The
 * `Passphrase only:` reason is the spec's row F3, produced exactly as `vault backup`'s B2 is.
 */
export function factorAddAmong(envelopes: Envelope[]): NonNullable<UnlockOptions["among"]> {
  return {
    envelopeIds: envelopes
      .filter((envelope) => isPassphraseEnvelope(envelope) || isCtap2Envelope(envelope))
      .map((envelope) => envelope.id),
    because: factorAddPassphraseOnlyReason,
    excludedBecause: "adding a factor opens the vault with the passphrase or a security key.",
  }
}

/** Row F3 (BE-337 D1): why only the passphrase can open the vault for a `factor add`. */
export function factorAddPassphraseOnlyReason(unusable: UnusableEnvelope[]): string {
  if (unusable.length === 0) {
    return "adding a factor opens the vault with the passphrase or a security key, and this vault has no security key."
  }
  const keys = unusable.map(
    (entry) => `${entry.word} ${entry.id} cannot be used on this machine: ${entry.availability}`,
  )
  return `adding a factor opens the vault with the passphrase or a security key, and ${keys.join("; ")}.`
}

/**
 * The derivation notice with its purpose, inserted before the newline `derivePassphraseKek`
 * already includes (D2, §4.2). Exported so T4 can pin the bytes without a vault.
 */
export function derivationNotice(line: string, purpose: string | undefined): string {
  if (purpose === undefined) return line
  return line.endsWith("\n") ? `${line.slice(0, -1)} -- ${purpose}\n` : `${line} -- ${purpose}`
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
    | { kind: "touch-id"; envelopeId: string; session: EnclaveSession }
    | { kind: "passkey"; envelopeId: string; session: PasskeySession }
  /** Opens `raw` (the bytes of `path`) with the same factor. The caller closes what it gets.
   * `purpose` is this open's derivation-line suffix (D2), independent of the first open's. */
  reopen: (path: string, raw: string, purpose?: string) => Promise<UnlockedVault>
  /**
   * The second presentation of the factor before value moves: the passphrase typed again on a
   * hidden prompt, or the key touched again. `what` names the operation ("sign transfer of ...").
   */
  confirm: (what: string) => Promise<void>
}

/** A restricted envelope this machine cannot drive, as `among.because` receives it (D7, row B2). */
export interface UnusableEnvelope {
  id: string
  /** `security key`, `Touch ID` or `synced passkey`, as the chooser prints it. */
  word: string
  /** The availability text `vault status` and `factor list` print: the label, then the reason. */
  availability: string
}

type FactorChoice =
  | { kind: "passphrase"; envelopeId?: string; onlyBecause?: string }
  /** `preferDevice` (BE-294 D5): the one device the menu's probe found this credential on. */
  | { kind: "security-key"; envelope: Ctap2Envelope; preferDevice?: string }
  | { kind: "touch-id"; envelope: SecureEnclaveEnvelope }
  | { kind: "passkey"; envelope: PlatformPasskeyEnvelope }

type DrivableEnvelope = Ctap2Envelope | SecureEnclaveEnvelope | PlatformPasskeyEnvelope

export function assertVaultHelperIdentities(deps: Pick<Deps, "releasePolicy">, envelopes: Envelope[]): void {
  // The header is not authenticated yet. Refuse a foreign identity before even the info probe.
  // Omitted builds can still open native-factor vaults with their passphrase on other platforms.
  if (deps.releasePolicy.macosHelper.release === "signed") {
    for (const envelope of envelopes) {
      if (isSecureEnclaveEnvelope(envelope) || isPlatformPasskeyEnvelope(envelope)) {
        pinnedHelperIdentity(deps, envelope.helper)
      }
    }
  }
}

/**
 * Prompts for the factor and opens the vault, having first applied ED-6's whole-file rollback
 * check against the sidecar.
 *
 * The check runs BEFORE the prompt so that an operator who has accidentally restored an old backup
 * learns that from the refusal rather than after typing a passphrase into it. It is best effort by
 * construction and says so: a same-user attacker can edit the sidecar, and a missing sidecar is a
 * warning rather than a refusal, because a vault legitimately arrives on a new machine without one.
 *
 * Which factor: `--factor` (or the command's own override) names an envelope id, `passphrase`,
 * `security-key`, `touch-id` or `passkey`; an envelope this machine cannot drive is refused with
 * CC-12's typed code. With no flag, the vault's passphrase is used when it is the only kind this
 * machine can drive, and when a security key, Touch ID or a synced passkey could also open it the
 * operator is asked, on a visible prompt, which to use. The CLI never picks a different envelope
 * on the operator's behalf. With no `--factor`, an attached key is marked and listed first, and the
 * operator still chooses (BE-294 D4).
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
  assertVaultHelperIdentities(deps, file.envelopes)
  const facts = await currentPlatformFacts(deps)
  const choice = await chooseFactor(ctx, file.vaultId, file.envelopes, facts, opts.factor ?? ctx.vaultFactor, opts)
  const noticeFor = (purpose: string | undefined) => (line: string) =>
    deps.stderr.write(derivationNotice(line, purpose))
  const notice = noticeFor(opts.purpose)

  if (choice.kind === "passphrase") {
    // BE-337 (D4): the command's own device work first (`factor add security-key` opens the key
    // being added here, before the passphrase, as it always has), then D7's line, then the prompt.
    if (opts.onFactorChosen) {
      await opts.onFactorChosen(
        choice.envelopeId !== undefined
          ? { kind: "passphrase", envelopeId: choice.envelopeId }
          : { kind: "passphrase" },
      )
    }
    // BE-292 (D7): one line, immediately before the prompt, whenever the passphrase is the only
    // answer and there was another factor the operator might have expected to use.
    if (choice.onlyBecause !== undefined) deps.stderr.write(`${PASSPHRASE_ONLY_PREFIX}${choice.onlyBecause}\n`)
    const typed = await deps.promptSecret(opts.promptText ?? "Vault passphrase (input hidden): ")
    const openWith = (p: string, r: string, candidate: string, purpose: string | undefined) =>
      choice.envelopeId === undefined
        ? unlockWithPassphrase(p, r, candidate, { notice: noticeFor(purpose) })
        : unlockVault(
            p,
            r,
            { factor: "passphrase", passphrase: candidate, envelopeId: choice.envelopeId },
            { notice: noticeFor(purpose) },
          )
    const { vault, passphrase } = await openWithTypedPassphrase(typed, (candidate) =>
      openWith(path, raw, candidate, opts.purpose),
    )
    // The passphrase that OPENED the file is kept, so a command that must re-open what it just
    // wrote (new-key's verification, init's invariant 1 step) can do it without a second prompt.
    // It is a JavaScript string with CC-04's stated lifetime caveat either way; asking for it
    // twice would not shorten that and would train an operator to type a vault passphrase on
    // demand.
    const open = (p: string, r: string, purpose?: string) => openWith(p, r, passphrase, purpose)
    return {
      vault,
      factor: { kind: "passphrase", envelopeId: vault.envelope.id },
      reopen: open,
      confirm: async (what) => {
        const again = await deps.promptSecret(`Vault passphrase to ${what} (input hidden): `)
        // The same rule as the first prompt: the string that opened the vault, typed again, with a
        // stray edge space tolerated. A rescued 0.10.0 vault's passphrase includes its spaces.
        if (!passphraseAttempts(again).includes(passphrase)) {
          throw new VaultError("VAULT_UNLOCK_FAILED", "The passphrase did not match; nothing was signed.")
        }
      },
    }
  }
  // The three native factors below derive no Argon2 key, so `notice` never fires for them and
  // the derivation-line purpose has nothing to attach to; `reopen` still accepts it so a caller
  // does not have to know which factor opened the vault.

  if (choice.kind === "touch-id") {
    // The Secure Enclave. The policy, the helper and its signature (against this build's release policy) are settled before the vault is touched; the Touch ID prompt is the unwrap itself.
    const envelope = choice.envelope
    if (opts.onFactorChosen) await opts.onFactorChosen({ kind: "touch-id", envelope })
    const session = await openEnclaveSession(deps, envelope.helper)
    const open = async (p: string, r: string, reason: string): Promise<UnlockedVault> => {
      const current = parseVaultFile(r)
      const target = current.envelopes.find((candidate) => candidate.id === envelope.id)
      if (target === undefined || !isSecureEnclaveEnvelope(target)) {
        throw new VaultError(
          "VAULT_FACTOR_UNAVAILABLE",
          `The file at ${p} has no Secure Enclave envelope ${envelope.id}.`,
          { suggestion: "Run: candle vault status (which lists each factor and why it is not available here)" },
        )
      }
      pinnedHelperIdentity(deps, target.helper)
      const kek = await unwrapKekWithEnclave(deps, session, target, current.vaultId, reason)
      try {
        return await unlockVault(p, r, { factor: "secure-enclave", envelopeId: target.id, kek }, { notice })
      } finally {
        wipe(kek)
      }
    }
    const reason = opts.reason ?? "unlock the Candle vault"
    const vault = await open(path, raw, reason)
    return {
      vault,
      factor: { kind: "touch-id", envelopeId: envelope.id, session },
      reopen: (p, r) => open(p, r, reason),
      // ED-12: the second presentation puts the operation itself in the Touch ID prompt.
      confirm: async (what) => {
        closeVault(await open(path, raw, what))
      },
    }
  }

  if (choice.kind === "passkey") {
    // The synced passkey (BE-135). The policy, the helper, its signature (against this build's release policy) and the AD-2 gates are settled before the vault is touched; the passkey
    // sheet is the assertion itself. No network: the system's own association check answers.
    const envelope = choice.envelope
    if (opts.onFactorChosen) await opts.onFactorChosen({ kind: "passkey", envelope })
    const session = await openPasskeySession(deps, envelope.helper)
    const open = async (p: string, r: string, purpose: string): Promise<UnlockedVault> => {
      const current = parseVaultFile(r)
      const target = current.envelopes.find((candidate) => candidate.id === envelope.id)
      if (target === undefined || !isPlatformPasskeyEnvelope(target)) {
        throw new VaultError(
          "VAULT_FACTOR_UNAVAILABLE",
          `The file at ${p} has no synced passkey envelope ${envelope.id}.`,
          { suggestion: "Run: candle vault status (which lists each factor and why it is not available here)" },
        )
      }
      pinnedHelperIdentity(deps, target.helper)
      const prfOutput = await assertPlatformPrf(deps, session, target, current.vaultId, purpose)
      try {
        return await unlockVault(p, r, { factor: "passkey-prf", envelopeId: target.id, prfOutput }, { notice })
      } finally {
        wipe(prfOutput)
      }
    }
    const reason = opts.reason ?? "unlock the Candle vault"
    const vault = await open(path, raw, reason)
    return {
      vault,
      factor: { kind: "passkey", envelopeId: envelope.id, session },
      reopen: (p, r) => open(p, r, reason),
      // The second presentation: the passkey asserted again, with the operation named on stderr
      // (the system's sheet carries no custom text).
      confirm: async (what) => {
        closeVault(await open(path, raw, what))
      },
    }
  }

  // A security key. The helper, the device and the PIN are settled before the vault is touched.
  const envelope = choice.envelope
  // BE-337 (D2): when the command decides the opening device itself, `--device` does not reach
  // this session at all: it names the key being ADDED there, never the opener.
  const keyDevice = opts.onFactorChosen ? await opts.onFactorChosen({ kind: "security-key", envelope }) : undefined
  const session = await openSecurityKeySession(deps, {
    vaultId: file.vaultId,
    envelopeId: envelope.id,
    ...(keyDevice !== undefined
      ? { preferDevice: keyDevice.preferDevice }
      : {
          deviceFlag: ctx.vaultDevice,
          ...(choice.preferDevice !== undefined ? { preferDevice: choice.preferDevice } : {}),
        }),
    requireFeatures: false,
  })
  const open = async (p: string, r: string): Promise<UnlockedVault> => {
    const current = parseVaultFile(r)
    const target = current.envelopes.find((candidate) => candidate.id === envelope.id)
    if (target === undefined || !isCtap2Envelope(target)) {
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `The file at ${p} has no security key envelope ${envelope.id}.`,
        { suggestion: "Run: candle vault status (which lists each factor and why it is not available here)" },
      )
    }
    // BE-292 (D6): the key's line names the operation, as the Touch ID and passkey lines do.
    const prfOutput = await assertPrf(deps, session, target, current.vaultId, opts.reason ?? "unlock the vault")
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

/**
 * Opens with a passphrase as typed at a hidden prompt, under the one whitespace rule in
 * `passphrase.ts`: the exact input first, then its trimmed form when that differs. Returns the
 * string that actually opened the vault, which is the one a re-open or a confirmation must use.
 * A refusal that is not "wrong passphrase" (a tampered index, a missing envelope) is a property of
 * the file and stops the attempts rather than being repeated under the next candidate.
 */
export async function openWithTypedPassphrase(
  typed: string,
  open: (candidate: string) => Promise<UnlockedVault>,
): Promise<{ vault: UnlockedVault; passphrase: string }> {
  const attempts = passphraseAttempts(typed)
  if (attempts.length === 0) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "A passphrase is required.")
  }
  let last: unknown
  for (const candidate of attempts) {
    try {
      return { vault: await open(candidate), passphrase: candidate }
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== "VAULT_UNLOCK_FAILED") throw error
      last = error
    }
  }
  throw last
}

/** The fixed prefix of D7's line, so tests and operators can find it. */
export const PASSPHRASE_ONLY_PREFIX = "Passphrase only: "

/** The availability text `factor list` prints for an envelope: the label, then the reason. */
function availabilityText(envelope: Envelope, facts: PlatformFacts): string {
  const availability = envelopeAvailability(envelope, facts)
  return availability.state === "available"
    ? availabilityLabel(availability)
    : `${availabilityLabel(availability)}: ${availability.reason}`
}

/**
 * Which envelope kinds are on the file, which of them this machine can drive, and the choice.
 *
 * BE-292: with `opts.among` the choice is made among the listed envelopes only (D3, D5). The
 * passphrase variant carries `onlyBecause` when D7 wants a line before the prompt: case (a), the
 * command limited the factors and only the passphrase is left; case (b), no flag, the vault has
 * other envelopes and none of them can be driven here. Neither fires on a vault whose only
 * envelope is the passphrase, and neither fires when the operator chose the passphrase.
 */
async function chooseFactor(
  ctx: CommandContext,
  vaultId: string,
  allEnvelopes: Envelope[],
  facts: PlatformFacts,
  requested: string | undefined,
  opts: Pick<UnlockOptions, "among" | "passphraseOnlyBecause" | "passphraseOnlyEvenIfSole" | "attached"> = {},
): Promise<FactorChoice> {
  const among = opts.among
  const envelopes =
    among === undefined ? allEnvelopes : allEnvelopes.filter((envelope) => among.envelopeIds.includes(envelope.id))
  // D7's narrowing: a vault whose only envelope is the passphrase has nothing to explain.
  const hasOtherFactor = allEnvelopes.some((envelope) => !isPassphraseEnvelope(envelope))
  let flag = requested
  if (among !== undefined && flag !== undefined && flag !== "passphrase") {
    // `--factor` names a kind or an id the vault has but the restriction leaves out: say so once,
    // then choose among what is allowed. The operator's intent is still achievable.
    const namesExcluded =
      envelopes.every((envelope) => !matchesFlag(envelope, flag as string)) &&
      allEnvelopes.some((envelope) => matchesFlag(envelope, flag as string))
    if (namesExcluded) {
      ctx.deps.stderr.write(`--factor ${flag} is not used here: ${among.excludedBecause}\n`)
      flag = undefined
    }
  }
  const passphrases = envelopes.filter(isPassphraseEnvelope)
  const keys = envelopes.filter(isCtap2Envelope)
  const enclaves = envelopes.filter(isSecureEnclaveEnvelope)
  const passkeys = envelopes.filter(isPlatformPasskeyEnvelope)
  const drivableKeys = keys.filter((envelope) => canDrive(envelope, facts))
  const drivableEnclaves = enclaves.filter((envelope) => canDrive(envelope, facts))
  const drivablePasskeys = passkeys.filter((envelope) => canDrive(envelope, facts))
  const list = (candidates: Envelope[]) =>
    candidates.map((envelope) => `  ${envelope.id}  ${wordFor(envelope)}  ${envelope.label || "(no label)"}`).join("\n")
  const unusable = (): UnusableEnvelope[] =>
    envelopes
      .filter((envelope) => !isPassphraseEnvelope(envelope) && !canDrive(envelope, facts))
      .map((envelope) => ({
        id: envelope.id,
        word: wordFor(envelope),
        availability: availabilityText(envelope, facts),
      }))

  if (flag === undefined) {
    const drivable: DrivableEnvelope[] = [...drivableKeys, ...drivableEnclaves, ...drivablePasskeys]
    if (drivable.length === 0) {
      if (passphrases.length === 0) {
        throw new VaultError(
          "VAULT_FACTOR_UNAVAILABLE",
          "This vault has no passphrase envelope, and no other envelope on it can be driven on this machine.",
          { suggestion: "Run `candle vault status` to see each factor and why it is not available here." },
        )
      }
      if (!hasOtherFactor) return { kind: "passphrase" }
      if (among !== undefined) return { kind: "passphrase", onlyBecause: among.because(unusable()) }
      // Case (b), row C1: other envelopes exist and none can be driven here.
      const detail = unusable()
        .map((entry) => `${entry.id} ${entry.word}: ${entry.availability}`)
        .join("; ")
      return {
        kind: "passphrase",
        onlyBecause: `no other factor on this vault can be used on this machine (${detail}). Details: candle vault status`,
      }
    }
    if (passphrases.length === 0 && drivable.length === 1) return choiceFor(drivable[0] as DrivableEnvelope)
    // More than one factor can open it here: the operator picks from the menu (BE-294). Visible
    // prompt, nothing secret. Without a TTY there is no probe, and the one `promptLine` refuses
    // before it writes anything, exactly as before the menu existed (D5).
    // BE-337 (D1): a command that already probed hands its answer in, even when that probe failed
    // (`undefined`), so there is one probe per command and the menu is never drawn from a second.
    const attached =
      "attached" in opts
        ? opts.attached
        : ctx.deps.isTTY.stdin
          ? await probeAttachedKeys(ctx.deps, { vaultId, envelopes: drivableKeys, deviceFlag: ctx.vaultDevice })
          : undefined
    const notUsableHere = envelopes.filter(
      (envelope) => !isPassphraseEnvelope(envelope) && !(drivable as unknown as Envelope[]).includes(envelope),
    )
    const menu = factorMenu({
      keys: drivableKeys,
      enclaves: drivableEnclaves,
      passkeys: drivablePasskeys,
      passphrase: passphrases.length > 0,
      unusable: notUsableHere,
      attached,
    })
    const answer = (await ctx.deps.promptLine(menu.text)).trim()
    const chosen = pickMenuRow(menu.rows, answer)
    if (chosen) return chosen.choice
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `No factor numbered or named ${JSON.stringify(answer)}; nothing was tried.`,
      { suggestion: `Answer a number from 1 to ${menu.rows.length}, or pass --factor.` },
    )
  }

  if (flag === "passphrase") {
    if (passphrases.length === 0)
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "This vault has no passphrase envelope.", {
        suggestion: "Run: candle vault status (which lists each factor and why it is not available here)",
      })
    // Case (a) for a command that forced the passphrase (the `factor add` sites, and the copy's
    // own prompt in `verify-backup`). An operator who passed `--factor passphrase` chose it, and
    // sees no line.
    if (opts.passphraseOnlyBecause !== undefined && (hasOtherFactor || opts.passphraseOnlyEvenIfSole)) {
      return { kind: "passphrase", onlyBecause: opts.passphraseOnlyBecause }
    }
    return { kind: "passphrase" }
  }
  const byKind: Record<string, { candidates: DrivableEnvelope[]; word: string; add: string }> = {
    "security-key": { candidates: keys, word: "security key", add: "candle vault factor add security-key" },
    "touch-id": { candidates: enclaves, word: "Touch ID (Secure Enclave)", add: "candle vault factor add touch-id" },
    passkey: { candidates: passkeys, word: "synced passkey", add: "candle vault factor add passkey" },
  }
  const kind = byKind[flag]
  if (kind !== undefined) {
    if (kind.candidates.length === 0) {
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `This vault has no ${kind.word} envelope.`, {
        suggestion: `Add one: ${kind.add}`,
      })
    }
    if (kind.candidates.length > 1) {
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `This vault has ${kind.candidates.length} ${kind.word} envelopes; name one with --factor <id>:\n${list(kind.candidates as unknown as Envelope[])}`,
        { suggestion: "Run `candle vault factor list` for the ids." },
      )
    }
    return choiceFor(assertDrivable(kind.candidates[0] as DrivableEnvelope, facts))
  }
  const named = envelopes.find((envelope) => envelope.id === flag)
  if (named === undefined) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `This vault has no envelope with id ${flag}.`, {
      suggestion: "Run `candle vault factor list` for the ids.",
    })
  }
  if (isPassphraseEnvelope(named)) return { kind: "passphrase", envelopeId: named.id }
  if (isCtap2Envelope(named) || isSecureEnclaveEnvelope(named) || isPlatformPasskeyEnvelope(named)) {
    return choiceFor(assertDrivable(named as unknown as DrivableEnvelope, facts))
  }
  // CC-12: an envelope this platform cannot drive, asked for by name, is the typed refusal and
  // never a substitution.
  const availability = envelopeAvailability(named, facts)
  if (availability.state === "available") {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `Envelope ${named.id} is a ${named.factor} envelope this release cannot open.`,
      { suggestion: "Run: candle vault status (which lists each factor and why it is not available here)" },
    )
  }
  throw new VaultError(
    refusalCodeFor(availability),
    `Envelope ${named.id} (${named.factor}${typeof named.transport === "string" ? `/${named.transport}` : ""}) cannot open the vault here: ${availability.reason}.`,
    { suggestion: "No other envelope was tried. Run `candle vault status` to see which factors can open it here." },
  )
}

interface MenuRow {
  choice: FactorChoice
  /** The envelope id a row answers to, and prints; the Passphrase row has none. */
  id?: string
  line: (number: string) => string
}

/**
 * BE-294 (D1): a label as the menu prints it. The header is not authenticated when the menu is
 * drawn and `factor add --label` refuses nothing, so C0 and C1 controls (`safeText`) and every
 * `Bidi_Control` character become spaces BEFORE the row is composed: a label can neither drive the
 * terminal nor reorder the trusted text beside it.
 */
export function menuSafeText(value: string): string {
  return safeText(value).replace(/\p{Bidi_Control}/gu, " ")
}

function menuName(envelope: Envelope): string {
  const name = menuSafeText(envelope.label).trim()
  if (name !== "") return name
  if (isCtap2Envelope(envelope)) return menuSafeText(envelope.product).trim() || "security key"
  return wordFor(envelope)
}

/**
 * BE-294 (D1, D2): the numbered menu, one `promptLine` worth of text. Security keys first, the
 * ones the probe marked `attached` ahead of the rest (each group in file order), then Touch ID,
 * then synced passkeys, then one Passphrase row. Every envelope row keeps its id, which is what
 * tells two same-model keys apart and what `--factor` takes next time.
 */
export function factorMenu(input: {
  keys: Ctap2Envelope[]
  enclaves: SecureEnclaveEnvelope[]
  passkeys: PlatformPasskeyEnvelope[]
  passphrase: boolean
  unusable: Envelope[]
  attached: AttachedKeys | undefined
}): { rows: MenuRow[]; text: string } {
  const presence = (envelope: Ctap2Envelope) => input.attached?.state.get(envelope.id)
  const keys = [
    ...input.keys.filter((envelope) => presence(envelope) === "attached"),
    ...input.keys.filter((envelope) => presence(envelope) !== "attached"),
  ]
  const entries: Array<{ envelope: Envelope; state?: string; choice: FactorChoice }> = [
    ...keys.map((envelope) => {
      const state = presence(envelope)
      const preferDevice = input.attached?.holder.get(envelope.id)
      return {
        envelope: envelope as unknown as Envelope,
        ...(state !== undefined ? { state } : {}),
        choice: {
          kind: "security-key",
          envelope,
          ...(preferDevice !== undefined ? { preferDevice } : {}),
        } as FactorChoice,
      }
    }),
    ...input.enclaves.map((envelope) => ({
      envelope: envelope as unknown as Envelope,
      state: "this Mac",
      choice: { kind: "touch-id", envelope } as FactorChoice,
    })),
    ...input.passkeys.map((envelope) => ({
      envelope: envelope as unknown as Envelope,
      choice: { kind: "passkey", envelope } as FactorChoice,
    })),
  ]
  const described = entries.map(({ envelope, state, choice }) => {
    const name = menuName(envelope)
    const kind = wordFor(envelope)
    const descriptor =
      name.toLowerCase() === kind.toLowerCase() ? state : state !== undefined ? `${kind}, ${state}` : kind
    return { id: envelope.id, name, column: descriptor === undefined ? "" : `(${descriptor})`, choice }
  })
  const nameWidth = Math.max(0, ...described.map((row) => row.name.length))
  const columnWidth = Math.max(0, ...described.map((row) => row.column.length))
  const rows: MenuRow[] = described.map((row) => ({
    choice: row.choice,
    id: row.id,
    line: (n) =>
      `  ${n}  ${row.name.padEnd(nameWidth)}  ${columnWidth > 0 ? `${row.column.padEnd(columnWidth)}  ` : ""}id ${row.id}`,
  }))
  if (input.passphrase) rows.push({ choice: { kind: "passphrase" }, line: (n) => `  ${n}  Passphrase` })
  const numberWidth = String(rows.length).length
  const lines = ["Unlock with:", ...rows.map((row, index) => row.line(String(index + 1).padStart(numberWidth)))]
  if (input.unusable.length > 0) {
    const names = input.unusable.map((envelope) => `${menuName(envelope)} (${wordFor(envelope)})`).join(", ")
    lines.push(`Not usable on this machine: ${names}. Details: candle vault status`)
  }
  return { rows, text: `${lines.join("\n")}\n> ` }
}

/**
 * BE-294 (D3): an offered row's exact id first (so an id is never read as a number), then
 * `passphrase` in any case when there is a Passphrase row, then a row number from 1 to the row
 * count with no sign, no leading zero and at most two digits. Labels are not answers.
 */
function pickMenuRow(rows: MenuRow[], answer: string): MenuRow | undefined {
  const byId = rows.find((row) => row.id !== undefined && row.id === answer)
  if (byId) return byId
  if (answer.toLowerCase() === "passphrase") return rows.find((row) => row.choice.kind === "passphrase")
  if (!/^[1-9][0-9]?$/.test(answer)) return undefined
  return rows[Number(answer) - 1]
}

/** The kind word the chooser and the backup report print for an envelope. Exported for the report. */
export function wordFor(envelope: Envelope): string {
  if (isPassphraseEnvelope(envelope)) return "passphrase"
  if (isSecureEnclaveEnvelope(envelope)) return "Touch ID"
  if (isPlatformPasskeyEnvelope(envelope)) return "synced passkey"
  if (isCtap2Envelope(envelope)) return "security key"
  return `${envelope.factor}${typeof envelope.transport === "string" ? `/${envelope.transport}` : ""} envelope`
}

/** Whether `--factor <flag>` names this envelope, by kind word or by id. */
function matchesFlag(envelope: Envelope, flag: string): boolean {
  if (envelope.id === flag) return true
  if (flag === "security-key") return isCtap2Envelope(envelope)
  if (flag === "touch-id") return isSecureEnclaveEnvelope(envelope)
  if (flag === "passkey") return isPlatformPasskeyEnvelope(envelope)
  return false
}

function choiceFor(envelope: DrivableEnvelope): FactorChoice {
  const any = envelope as unknown as Envelope
  if (isSecureEnclaveEnvelope(any)) return { kind: "touch-id", envelope: envelope as SecureEnclaveEnvelope }
  if (isPlatformPasskeyEnvelope(any)) return { kind: "passkey", envelope: envelope as PlatformPasskeyEnvelope }
  return { kind: "security-key", envelope: envelope as Ctap2Envelope }
}

function assertDrivable<T extends DrivableEnvelope>(envelope: T, facts: PlatformFacts): T {
  const availability = envelopeAvailability(envelope as unknown as Envelope, facts)
  if (availability.state === "available") return envelope
  throw new VaultError(
    refusalCodeFor(availability),
    `The ${wordFor(envelope as unknown as Envelope)} envelope ${envelope.id} cannot open the vault here: ${availability.reason}.`,
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
      { suggestion: "Nothing was signed. Run it again and type the last six characters exactly as shown." },
    )
  }
}

/** Writes a vault failure in whichever mode this invocation is in, and answers its exit code. */
export function writeVaultFailure(ctx: CommandContext, error: unknown): number {
  // A `CANDLE_CONFIG_DIR` refusal raised from inside `candleConfigDir` (D4) is a usage error, not a
  // vault one: same exit 2 and same `USAGE` envelope a mistyped flag gets.
  if (isUsageError(error)) return usage(ctx, error.message)
  if (isVaultError(error)) {
    writeLocalFailure(
      ctx.deps,
      {
        code: error.code,
        message: error.message,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        // D3's additive optional key: present only where a refusal carries facts worth acting on.
        ...(error.details ? { details: error.details } : {}),
      },
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

/** The user's own Solana RPC: `--rpc-url`, else `CANDLE_SOLANA_RPC_URL` (the rule `candle tee` uses). */
export const RPC_URL_ENV = "CANDLE_SOLANA_RPC_URL"

export function rpcUrlFrom(ctx: CommandContext, parsed: ParsedArgs): string | { error: string } {
  const url = parsed.values["--rpc-url"] ?? ctx.deps.env[RPC_URL_ENV]?.trim()
  if (!url) return { error: `--rpc-url <url> is required (or set ${RPC_URL_ENV}).` }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { error: `--rpc-url is not a valid URL: ${url}` }
  }
  const local = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost"
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && local)) {
    return { error: "--rpc-url must be https:// (plain http is allowed only for 127.0.0.1 / localhost)." }
  }
  return url
}

/**
 * The `--json` document for one key entry, shared by `vault status --unlock` and `vault list`
 * (BE-274, D6).
 *
 * One shape, from one function, so an agent that parses one parses the other, and so `status`'s
 * `unlocked.entries` is byte-identical to what it was before `list` existed -- which §1.1 of the
 * 0.11.1 surface spec freezes. It moved here from `vault-status.ts` unchanged; when `status`
 * eventually stops carrying entries, nothing about the document changes.
 *
 * `list --balances` adds exactly one optional key to this document, `lamports`, and only on a
 * Solana entry. It is added by the caller, not here: `status` must not grow a key it never reads.
 */
export function describeEntry(entry: KeyEntry) {
  const flags: string[] = []
  if (entry.exposure.everRemoteExposed) flags.push("remotely exposed")
  if (entry.exposure.everExported) flags.push("exported")
  if (entry.exposure.exposureUnknown) flags.push("history unknown (restored)")
  return {
    address: entry.address,
    label: entry.label,
    // BE-259 (D5): the `--json` entry document gains its id, so `rename --json`'s receipt and the
    // `--id` flag refer to something a caller can read. Not in the human listing, where the
    // label and the address are the addressing surface.
    id: entry.id,
    role: entry.role,
    origin: entry.origin,
    derivation: entry.derivation?.path,
    exposure: flags.length > 0 ? flags.join(", ") : "cold in this vault's record",
    teeLifecycle: entry.tee?.lifecycle,
    teeRemoteState: entry.tee?.remoteState,
    destinationExposureAccepted: entry.tee?.destinationExposureAccepted === true,
  }
}

/**
 * A `role: "external"` entry by label or address (R6). Only external entries answer: a vault key
 * or a TEE wallet named here is `undefined`, so the caller's refusal can say what it was.
 */
export function findExternalEntry(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const byLabel = index.entries.find((entry) => entry.role === "external" && entry.label === labelOrAddress)
  if (byLabel !== undefined) return byLabel
  return index.entries.find((entry) => entry.role === "external" && entry.address === labelOrAddress)
}

/** What a named entry is, for a refusal that has to say why it was not admitted. */
export function describeRole(entry: KeyEntry): string {
  if (entry.role === "vault") return "a vault key"
  if (entry.role === "tee-wallet") return "a TEE wallet"
  return "an external wallet"
}

/**
 * A `--wallet`-style flag that may be given more than once. `parseArgs` keeps the last value of a
 * flag, so the repeats are lifted out first and the remaining tokens go through it unchanged.
 */
export function takeRepeatedFlag(
  args: string[],
  flag: string,
): { values: string[]; rest: string[] } | { error: string } {
  const values: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === flag) {
      const value = args[++i]
      if (!value || value.startsWith("-")) return { error: `${flag} requires a value` }
      values.push(value)
    } else if (arg !== undefined && arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1)
      if (!value) return { error: `${flag} requires a value` }
      values.push(value)
    } else if (arg !== undefined) rest.push(arg)
  }
  return { values, rest }
}
