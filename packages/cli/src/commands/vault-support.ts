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
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { closeVault, defaultVaultPath, readVaultRaw, type UnlockedVault, unlockWithPassphrase } from "../vault/store"

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
      `${what} needs a terminal: this CLI reads a vault passphrase from a hidden prompt and from nowhere else.`,
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
}

/**
 * Prompts for the passphrase and opens the vault, having first applied ED-6's whole-file rollback
 * check against the sidecar.
 *
 * The check runs BEFORE the prompt so that an operator who has accidentally restored an old backup
 * learns that from the refusal rather than after typing a passphrase into it. It is best effort by
 * construction and says so: a same-user attacker can edit the sidecar, and a missing sidecar is a
 * warning rather than a refusal, because a vault legitimately arrives on a new machine without one.
 */
export async function unlockInteractively(
  ctx: CommandContext,
  path: string,
  raw: string,
  opts: UnlockOptions = {},
): Promise<{ vault: UnlockedVault; passphrase: string }> {
  await assertNotOlderCopy(ctx, path, raw, opts.acceptOlderCopy ?? false)
  const typed = await ctx.deps.promptSecret(opts.promptText ?? "Vault passphrase (input hidden): ")
  const passphrase = typed.trim()
  if (passphrase === "") {
    throw new VaultError("VAULT_UNLOCK_FAILED", "A passphrase is required.")
  }
  // The passphrase is handed back so a command that must RE-OPEN the file it just wrote (new-key's
  // verification, init's invariant 1 step) can do it without a second prompt. It is a JavaScript
  // string with CC-04's stated lifetime caveat either way; asking for it twice would not shorten
  // that and would train an operator to type a vault passphrase on demand.
  const vault = await unlockWithPassphrase(path, raw, passphrase, { notice: (line) => ctx.deps.stderr.write(line) })
  return { vault, passphrase }
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
