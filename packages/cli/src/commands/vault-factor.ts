/**
 * Ember Phase 2 (BE-136, CC-03, ED-1, ED-7, N1, CC-12): `candle vault factor list|add|remove`.
 *
 * `add` and `remove` are the commands ED-1's construction exists FOR. Both re-encrypt the index
 * under the new header, with a fresh IV, and touch nothing else: no key blob is re-encrypted and
 * the root blob is not rewritten. A factor change therefore costs one AES-GCM call over a small
 * plaintext with no secrets in it, whatever the vault holds.
 *
 * N1 is the sentence `remove` has to say out loud, because the command's name promises more than
 * it does. **Removing a factor is not revocation.** The DEK never rotates, so a factor removed
 * today still unwraps the DEK from any copy of the file made while its envelope existed, and that
 * DEK opens every key blob in the current file INCLUDING keys created after the removal, because
 * key blobs are never re-encrypted. The only revocation of a compromised factor is a new vault and
 * moving the funds to its keys. The command prints exactly that, and `status` lists the removed
 * envelope ids from the sidecar afterwards so an operator knows which copies to worry about.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { freshArgon2Params } from "../vault/crypto"
import { countRecoverableFactors } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { currentPlatformFacts } from "../vault/fido2"
import type { Envelope, PassphraseEnvelope } from "../vault/format"
import { parseVaultFile, VAULT_CIPHER } from "../vault/format"
import {
  APPLE_ACCOUNT_NOTICE,
  assertOwnPassphraseAcceptable,
  GENERATED_WORD_COUNT,
  generatedEntropyBits,
  generatePassphrase,
  strengthFor,
  strengthLabel,
} from "../vault/passphrase"
import { availabilityLabel, envelopeAvailability } from "../vault/platform"
import {
  closeVault,
  commitVault,
  freshEnvelopeId,
  readVaultRaw,
  unlockWithPassphrase,
  wrapDekForPassphrase,
} from "../vault/store"
import { addPasskeyFactor } from "./vault-factor-passkey"
import { addSecurityKeyFactor } from "./vault-factor-security-key"
import { addTouchIdFactor } from "./vault-factor-touch-id"
import { GENERATED_PASSPHRASE_NEEDS_TERMINAL } from "./vault-init"
import {
  missingVault,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultFactorList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--keystore"], booleanFlags: [], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  return runVaultCommand(ctx, async () => {
    const raw = await readVaultRaw(path)
    if (raw === null) throw missingVault(ctx, resolvedVault)
    const file = parseVaultFile(raw)
    const facts = await currentPlatformFacts(deps)
    const rows = file.envelopes.map((envelope) => {
      const availability = envelopeAvailability(envelope, facts)
      return {
        id: envelope.id,
        factor: envelope.factor,
        transport: typeof envelope.transport === "string" ? envelope.transport : undefined,
        domain: envelope.domain,
        label: envelope.label,
        availability: availabilityLabel(availability),
        reason: availability.state === "available" ? undefined : availability.reason,
      }
    })
    if (ctx.json) {
      writeJson(deps, { ok: true, envelopes: rows, recoverableFactors: countRecoverableFactors(file.envelopes) })
      return 0
    }
    for (const row of rows) {
      deps.stdout.write(
        `${row.id}  ${row.factor}${row.transport ? `/${row.transport}` : ""}  ${row.domain}  ${row.label || "(no label)"}\n`,
      )
      deps.stdout.write(`    ${row.availability}${row.reason ? `: ${row.reason}` : ""}\n`)
    }
    deps.stdout.write(`\n${countRecoverableFactors(file.envelopes)} recoverable factor(s), domains counted once.\n`)
    return 0
  })
}

export async function vaultFactorAdd(args: string[], ctx: CommandContext): Promise<number> {
  // `--install-helper` (BE-275 D8): security-key only, read in addSecurityKeyFactor. Parsed here
  // because `vault enroll <kind>` is this same handler, so the flag is one flag on both spellings.
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--label"],
    booleanFlags: ["--own-passphrase", "--accept-older-copy", "--install-helper"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const kind = parsed.positionals[0]
  if (kind === undefined) {
    return usage(
      ctx,
      "Which factor? This release adds: candle vault factor add passphrase | security-key | touch-id | passkey",
    )
  }
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  // Same rule as `init`: the generated passphrase renders only on a terminal, never inside the one
  // JSON value `--json` promises, so the generated form is refused before anything is prompted.
  if (ctx.json && kind === "passphrase" && !parsed.booleans.has("--own-passphrase")) {
    return usage(ctx, GENERATED_PASSPHRASE_NEEDS_TERMINAL)
  }
  if (!requireTty(ctx, "vault factor add")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  if (parsed.booleans.has("--install-helper") && kind !== "security-key") {
    return usage(ctx, "--install-helper applies to the security-key factor only")
  }

  return runVaultCommand(ctx, async ({ hold }) => {
    if (kind === "security-key") return addSecurityKeyFactor(ctx, parsed, resolvedVault, hold)
    if (kind === "touch-id") return addTouchIdFactor(ctx, parsed, resolvedVault, hold)
    if (kind === "passkey") return addPasskeyFactor(ctx, parsed, resolvedVault, hold)
    if (kind !== "passphrase") {
      return usage(ctx, `Unknown factor: ${kind}. This release adds: passphrase, security-key, touch-id, passkey`)
    }

    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      promptText: "Current vault passphrase, to unlock (input hidden): ",
    })
    const vault = hold(opened.vault)

    const ownPassphrase = parsed.booleans.has("--own-passphrase")
    const passphrase = ownPassphrase ? await collectOwn(ctx) : await collectGenerated(ctx)

    const envelope: PassphraseEnvelope = {
      id: freshEnvelopeId(),
      factor: "passphrase",
      domain: "human-memory",
      label: parsed.values["--label"] ?? "passphrase",
      createdAt: new Date(deps.now()).toISOString(),
      kdf: freshArgon2Params(),
      strength: strengthFor(ownPassphrase),
      wrap: { alg: VAULT_CIPHER, iv: "", ciphertext: "" },
    }
    const wrap = await wrapDekForPassphrase(
      vault.dek,
      passphrase,
      envelope as unknown as Envelope,
      vault.file,
      (line) => deps.stderr.write(line),
    )
    const sealed: Envelope = { ...(envelope as unknown as Envelope), wrap }

    // The index is re-encrypted under the NEW header, which is what makes the added envelope part
    // of what the index authenticates; generation increments; no key blob is touched.
    await commitVault(vault, { index: vault.index, envelopes: [...vault.file.envelopes, sealed] }, deps)

    // Re-open with the NEW factor before reporting, for the same reason `init` does: a factor that
    // has not been proven to open the file is not a factor.
    const written = await readVaultRaw(path)
    if (written === null) throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back.`)
    closeVault(await unlockWithPassphrase(path, written, passphrase, { notice: (line) => deps.stderr.write(line) }))

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        envelopeId: sealed.id,
        factor: "passphrase",
        domain: "human-memory",
        strength: envelope.strength,
      })
      return 0
    }
    deps.stdout.write(`Added passphrase factor ${sealed.id}.\n`)
    deps.stdout.write(`  strength   ${strengthLabel(envelope.strength)}\n`)
    deps.stdout.write(`  verified   the vault was re-read and opened with the new passphrase\n`)
    deps.stdout.write(`\n${APPLE_ACCOUNT_NOTICE}\n`)
    return 0
  })
}

export async function vaultFactorRemove(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const id = parsed.positionals[0]
  if (id === undefined) return usage(ctx, "Which envelope? Run `candle vault factor list` for the ids.")
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault factor remove")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const vault = hold(
      (await unlockInteractively(ctx, path, raw, { acceptOlderCopy: parsed.booleans.has("--accept-older-copy") }))
        .vault,
    )

    const target = vault.file.envelopes.find((envelope) => envelope.id === id)
    if (!target)
      throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `This vault has no envelope with id ${id}.`, {
        suggestion: "Run: candle vault factor list (which prints every envelope id this vault has)",
      })

    const remaining = vault.file.envelopes.filter((envelope) => envelope.id !== id)
    // CC-03: the passphrase envelope is the recovery FLOOR. Removing the last one would leave a
    // vault whose only factors are device-bound, which invariant 1 says cannot exist.
    if (target.factor === "passphrase" && !remaining.some((envelope) => envelope.factor === "passphrase")) {
      throw new VaultError(
        "VAULT_LAST_PASSPHRASE",
        "That is this vault's only passphrase factor, and every vault keeps one as its recovery floor.",
        {
          suggestion: "Add another passphrase factor first: candle vault factor add passphrase",
        },
      )
    }
    if (countRecoverableFactors(remaining) === 0) {
      throw new VaultError(
        "VAULT_NO_RECOVERABLE_FACTOR",
        "Removing that envelope would leave this vault with no recoverable factor.",
        {
          suggestion: "Add a recoverable factor first: candle vault factor add passphrase",
        },
      )
    }

    await commitVault(vault, { index: vault.index, envelopes: remaining }, deps)

    const notice = [
      "Removing a factor is not revocation.",
      `Envelope ${id} is gone from this file, and nothing else changed.`,
      "The data key never rotates, so any copy of this vault made while that envelope existed still opens with that factor, and the key it yields opens every key blob in the current file, including keys created after this removal.",
      "The only revocation of a compromised factor is a new vault (candle vault init) and moving the funds to its keys.",
    ]
    if (ctx.json) {
      writeJson(deps, { ok: true, removedEnvelopeId: id, notRevocation: notice.join(" ") })
      return 0
    }
    deps.stdout.write(`Removed envelope ${id}.\n\n`)
    for (const line of notice) deps.stdout.write(`${line}\n`)
    deps.stdout.write(
      `\n\`candle vault status\` lists this id from now on, so you can tell which copies it still opens.\n`,
    )
    return 0
  })
}

async function collectGenerated(ctx: CommandContext): Promise<string> {
  const passphrase = generatePassphrase()
  ctx.deps.stdout.write(
    `\nThe new passphrase, ${GENERATED_WORD_COUNT} words, about ${generatedEntropyBits()} bits. Written down now; it is shown once.\n\n    ${passphrase}\n\n`,
  )
  const typed = await ctx.deps.promptSecret("Type it back in full to confirm (input hidden): ")
  if (typed.trim() !== passphrase) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "That did not match the passphrase shown above. Nothing was written.")
  }
  return passphrase
}

async function collectOwn(ctx: CommandContext): Promise<string> {
  const first = await ctx.deps.promptSecret("Choose a new vault passphrase, 16 characters or more (input hidden): ")
  assertOwnPassphraseAcceptable(first)
  const again = await ctx.deps.promptSecret("Type it again to confirm: ")
  if (again !== first)
    throw new VaultError("VAULT_UNLOCK_FAILED", "The passphrases did not match. Nothing was written.")
  return first
}
