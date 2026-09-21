/**
 * Ember Phase 2 (BE-136, CC-03, CC-11, AD-6): `candle vault init`.
 *
 * The order is invariant 1's, and it is the reason this command re-reads its own output: write the
 * passphrase envelope and the root blob, re-open the FILE with that passphrase, decrypt the index
 * (which authenticates the header) and the root, and only then report success. A vault whose only
 * factor has never been proven to open it is a vault with no recoverable factor, and it would not
 * find that out until the day it mattered.
 *
 * No key is created here, deliberately: invariant 1 comes first, so `init` establishes the factor
 * and the root and leaves `new-key` to allocate.
 *
 * BE-245 rewrote the first ninety seconds of owning a vault, and the three changes are one idea:
 * say the true thing rather than perform a check that only looks like one.
 *
 * 1. The type-it-back confirmation is GONE. Its stated reason was proving the operator had
 *    captured the passphrase; the words are on screen while you type them, so it proved they were
 *    on your display. What it did do was make eight random words enough friction that people
 *    select-and-paste, putting a ~103-bit root passphrase through the clipboard. In its place: the
 *    sentence that was actually missing (WHERE to save it, that this CLI cannot recover it, and
 *    that the 24 words are the fallback), and an acknowledgement that is honestly a nudge. The one
 *    thing the retype caught -- a terminal that mangled the display -- is not worth a clipboard
 *    round trip, and the passphrase is the one secret that already has a way back: `restore
 *    --phrase` rebuilds the vault from the recovery phrase, which has none and gets its own
 *    ceremony.
 * 2. `restore`'s passphrase prompt is offered here too, minus the "typed back" clause. `restore`
 *    solved the discoverability of `--own-passphrase` in 0.11.1 and `init` never got the same
 *    prompt: one decision, two interfaces, one of them undiscoverable.
 * 3. A backup is OFFERED, once, after the phrase ceremony, and only where iCloud Drive exists on
 *    this machine. Nothing in `init` mentioned backup at all, and the moment after `init` is when
 *    it matters most. The copy is sealed by `vault backup`'s own AD-9 rule, so this adds a prompt
 *    and a path, not new crypto.
 *
 * `--high-value` was removed here in the same change. It wrote `highValue: true` to the
 * unauthenticated sidecar and `new-key` refused unless the vault carried a generated passphrase or
 * two recoverable domains: a control `rm` defeats, inert on the default path (generated satisfies
 * it, and generated is the default), firing at `new-key` rather than at `init`. What replaces it
 * is an advisory rather than a gate, because a vault that refuses to allocate is a vault someone
 * works around, and the workaround is a second vault with worse hygiene.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { createVault } from "../vault/create"
import { randomBytes } from "../vault/crypto"
import { countRecoverableFactors, homeDirOf, ICLOUD_SHORTHAND, icloudDriveDir } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { ROOT_ENTROPY_BYTES } from "../vault/hd"
import { withSecret } from "../vault/hygiene"
import {
  APPLE_ACCOUNT_NOTICE,
  assertOwnPassphraseAcceptable,
  GENERATED_WORD_COUNT,
  generatedEntropyBits,
  generatePassphrase,
  SAVE_THE_PASSPHRASE,
  SAVED_IT_PROMPT,
  strengthFor,
} from "../vault/passphrase"
import { closeVault, defaultVaultPath, fileExists } from "../vault/store"
import { vaultBackup } from "./vault-backup"
import { runPhraseCeremony } from "./vault-phrase"
import {
  askForOwnPassphrase,
  nonDefaultVaultFooter,
  type ResolvedVaultPath,
  refuseEnvPassphrase,
  requireTty,
  runVaultCommand,
  usage,
  vaultAlreadyExists,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/**
 * D8's init line (BE-241). Printed before the choice, only where a passphrase may be about to be
 * GENERATED: with `--own-passphrase` nothing is shown and there is nothing to warn about.
 *
 * Its last clause used to name the flag. The prompt below now offers the same choice inline
 * (BE-245), so it points at that rather than sending the reader back to the shell to start over.
 */
export const INIT_GENERATED_PASSPHRASE_NOTICE =
  "Your vault passphrase is about to be generated and shown once. This CLI keeps no copy and cannot recover it. To choose your own instead, type own at the prompt below."

/**
 * `restore`'s 0.11.1 prompt, with "typed back" dropped because BE-245 dropped the retype. Same
 * shape, same two answers, so an operator who has met one meets the other already knowing it.
 */
export const INIT_PASSPHRASE_PROMPT =
  "Passphrase for this vault. Press Enter to have one generated (8 words, shown once), or type own to choose your own (16+ characters, typed twice, never shown): "

/**
 * The generated passphrase is a secret that exists nowhere but the operator's screen, so the only
 * place it may ever be rendered is the terminal's own text output. Under `--json` stdout is the
 * machine channel and must carry exactly one JSON value with no secret in it (CC-04, T36, T39),
 * and stderr is not an output path for a secret either, so the generated form has nowhere to
 * render and is refused up front. `--own-passphrase` collects from a hidden prompt and renders
 * nothing, which is why it is the form that works under `--json`.
 */
export const GENERATED_PASSPHRASE_NEEDS_TERMINAL =
  "A generated passphrase is shown once on the terminal, and --json reserves stdout for one JSON value that never carries a secret. Under --json pass --own-passphrase (typed at a hidden prompt, nothing shown), or run without --json."

export async function vaultInit(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--label"],
    booleanFlags: ["--own-passphrase"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  // The FLAG, not the answer: under `--json` there is no prompt to answer, so the generated form
  // has to be ruled out before anything is asked.
  const ownFlag = parsed.booleans.has("--own-passphrase")
  if (ctx.json && !ownFlag) return usage(ctx, GENERATED_PASSPHRASE_NEEDS_TERMINAL)
  if (!requireTty(ctx, "vault init")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async () => {
    if (await fileExists(path)) {
      throw vaultAlreadyExists(
        ctx,
        resolvedVault,
        "This CLI never overwrites one, including after an interrupted init. Move it aside if you really mean to start over.",
      )
    }

    // D8 (BE-241): said before the ceremony rather than beside the words. BE-235 item 5 asked
    // whether a first-ever init should say so LOUDER, before the words; this is that answer.
    if (!ownFlag) deps.stdout.write(`${INIT_GENERATED_PASSPHRASE_NOTICE}\n`)
    const own = ownFlag || (await askForOwnPassphrase(ctx, INIT_PASSPHRASE_PROMPT))
    const passphrase = own ? await collectOwnPassphrase(ctx) : await collectGeneratedPassphrase(ctx)

    // 256 bits from WebCrypto. Held as ENTROPY and never as words until a ceremony renders them.
    const entropy = randomBytes(ROOT_ENTROPY_BYTES)
    const vault = await withSecret(entropy, async (rootEntropy) =>
      createVault(
        {
          path,
          passphrase,
          strength: strengthFor(own),
          rootEntropy,
          label: parsed.values["--label"],
          notice: (line) => deps.stderr.write(line),
        },
        deps,
      ),
    )

    try {
      if (ctx.json) {
        writeJson(deps, {
          ok: true,
          path,
          vaultId: vault.file.vaultId,
          generation: vault.file.generation,
          envelopes: vault.file.envelopes.map((envelope) => ({
            id: envelope.id,
            factor: envelope.factor,
            domain: envelope.domain,
          })),
          phraseCeremonyOffered: false,
        })
        deps.stderr.write(
          "The recovery phrase ceremony is interactive only and was not offered under --json. Run: candle vault phrase show\n",
        )
        return 0
      }

      deps.stdout.write(`Vault created at ${path}\n`)
      deps.stdout.write(`  vault id     ${vault.file.vaultId}\n`)
      deps.stdout.write(`  factors      1 (passphrase, human-memory)\n`)
      deps.stdout.write(`  keys         0 -- create one with: candle vault new-key --chain solana\n`)
      deps.stdout.write(
        `\nVerified: the file was re-read and opened with the passphrase you set, and its root blob decrypted.\n`,
      )
      deps.stdout.write(`\n${APPLE_ACCOUNT_NOTICE}\n`)
      // BE-245: what `--high-value` was reaching for, said as advice instead of enforced as a gate
      // nothing authenticates. It needs no flag and no stored state, and it is true of every vault
      // this command creates, which is more than the flag ever managed.
      if (countRecoverableFactors(vault.file.envelopes) === 1) {
        deps.stdout.write(
          `\nThis vault has exactly one recoverable factor: the passphrase. Lose it and no copy of this file can be opened, and the recovery phrase becomes the only route back. Add a second when you can: candle vault enroll security-key\n`,
        )
      }

      // CC-11: offered exactly ONCE here, and by `vault phrase show` afterwards.
      deps.stdout.write(
        `\nThis vault has a 24-word recovery phrase. It re-derives every key this vault derives, on any BIP-39 wallet, and it is the only way back if you lose both the file and your backups.\n`,
      )
      const answer = (
        await deps.promptLine("Show the recovery phrase now? Type yes to see it, anything else to skip: ")
      )
        .trim()
        .toLowerCase()
      if (answer === "yes") {
        await runPhraseCeremony(ctx, vault)
      } else {
        deps.stdout.write("Skipped. You can run the ceremony later with: candle vault phrase show\n")
      }

      // BE-245: after the phrase ceremony, which is where it belongs -- the phrase is the thing a
      // backup does NOT replace, so it is settled first.
      await offerIcloudBackup(ctx, resolvedVault)

      // D8/D10's footer, last: this vault is not at the default path, so every later vault command
      // needs -k or the variable. Human mode only; the --json payload above already carries `path`.
      const footer = nonDefaultVaultFooter(resolvedVault)
      if (footer !== undefined) deps.stdout.write(footer)
      return 0
    } finally {
      closeVault(vault)
    }
  })
}

/**
 * AD-6's default. Generated, shown once, and NOT typed back (BE-245): see this file's header for
 * why the retype tested nothing it claimed to. What replaces it is the instruction that was
 * missing -- where the passphrase goes, that this CLI cannot recover it, and what the fallback is
 * -- and an acknowledgement whose prompt says what it is.
 */
async function collectGeneratedPassphrase(ctx: CommandContext): Promise<string> {
  const { deps } = ctx
  const passphrase = generatePassphrase()
  deps.stdout.write(`\nYour vault passphrase, ${GENERATED_WORD_COUNT} words, about ${generatedEntropyBits()} bits.\n\n`)
  deps.stdout.write(`    ${passphrase}\n\n`)
  deps.stdout.write(`${SAVE_THE_PASSPHRASE}\n\n`)
  // The answer is deliberately unread. Pressing a key is a nudge, and the prompt says so rather
  // than dressing it as a check.
  await deps.promptLine(SAVED_IT_PROMPT)
  return passphrase
}

/** AD-6's `--own-passphrase`: 16 or more characters, not on the embedded denylist, typed twice. */
async function collectOwnPassphrase(ctx: CommandContext): Promise<string> {
  const first = await ctx.deps.promptSecret("Choose a vault passphrase, 16 characters or more (input hidden): ")
  assertOwnPassphraseAcceptable(first)
  const again = await ctx.deps.promptSecret("Type it again to confirm: ")
  if (again !== first) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "The passphrases did not match. Nothing was written.")
  }
  // Under --json stdout carries exactly one JSON value, and `status` reports the strength anyway.
  if (!ctx.json) {
    ctx.deps.stdout.write("Recorded as chosen by you: this CLI cannot know its entropy and `vault status` says so.\n")
  }
  return first
}

/**
 * BE-245 section 2: the backup offer.
 *
 * Shown only when iCloud Drive actually exists on this machine, so a Linux VPS and a Mac that has
 * never signed into iCloud never read a word about it. Answering yes runs `vault backup --to
 * icloud`, the same command with the same AD-9 sealing and the same eight-step verification, which
 * is why this is a prompt and a path rather than new crypto. It asks for the passphrase once,
 * because that is how `vault backup` unlocks a vault and not because the retype came back: the
 * vault is already created and verified by this point, and skipping costs nothing.
 *
 * A backup taken here records NO KEY, because `init` allocates none, so `verify-backup` will call
 * this copy stale the moment the first `new-key` lands. That is said out loud rather than papered
 * over. It is still the right offer: what the copy protects is the ROOT, and every derived key
 * comes back from the root through `restore --phrase --count`.
 *
 * A backup failure never fails `init`. The vault exists and has been re-opened and verified; a
 * full disk or an unmounted folder is a reason to retry the backup, not to lose the vault.
 */
async function offerIcloudBackup(ctx: CommandContext, resolved: ResolvedVaultPath): Promise<void> {
  const { deps } = ctx
  if (!(await fileExists(icloudDriveDir(homeDirOf(deps.env))))) return
  deps.stdout.write(
    `\nNothing has a copy of this vault yet. A copy in iCloud Drive is a copy of the ciphertext, and Candle seals it: it opens with the passphrase only, and carries no Touch ID, security key or synced passkey envelope, so one Apple account never holds both the blob and a factor that opens it.\n`,
  )
  deps.stdout.write(
    `This vault holds no keys yet, so what a copy taken now protects is the root every key comes back from. Back it up again after your first \`vault new-key\`: until then \`verify-backup\` will report this copy as stale, correctly.\n`,
  )
  const answer = (
    await deps.promptLine(
      "Back up your encrypted vault to iCloud Drive now? Type yes to back it up, anything else to skip: ",
    )
  )
    .trim()
    .toLowerCase()
  if (answer !== "yes") {
    deps.stdout.write(`Skipped. Back it up whenever you like with: candle vault backup --to ${ICLOUD_SHORTHAND}\n`)
    return
  }
  const code = await vaultBackup(["--to", ICLOUD_SHORTHAND, "--keystore", resolved.path], ctx)
  if (code !== 0) {
    deps.stdout.write(
      `\nThe vault itself is created and verified; only the copy failed. Run it again when you have dealt with the reason above: candle vault backup --to ${ICLOUD_SHORTHAND}\n`,
    )
  }
}

export { defaultVaultPath }
