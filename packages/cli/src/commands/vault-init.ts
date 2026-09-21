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
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { createVault } from "../vault/create"
import { randomBytes } from "../vault/crypto"
import { VaultError } from "../vault/errors"
import { ROOT_ENTROPY_BYTES } from "../vault/hd"
import { withSecret } from "../vault/hygiene"
import {
  APPLE_ACCOUNT_NOTICE,
  assertOwnPassphraseAcceptable,
  GENERATED_WORD_COUNT,
  generatedEntropyBits,
  generatePassphrase,
  strengthFor,
} from "../vault/passphrase"
import { nextSidecar, readSidecar, sidecarPath, writeSidecar } from "../vault/sidecar"
import { closeVault, defaultVaultPath, fileExists } from "../vault/store"
import { runPhraseCeremony } from "./vault-phrase"
import {
  nonDefaultVaultFooter,
  refuseEnvPassphrase,
  requireTty,
  runVaultCommand,
  usage,
  vaultAlreadyExists,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/**
 * D8's init line (BE-241). Printed before the ceremony, only where a passphrase is about to be
 * GENERATED: with `--own-passphrase` nothing is shown and there is nothing to warn about.
 */
export const INIT_GENERATED_PASSPHRASE_NOTICE =
  "Your vault passphrase is about to be generated and shown once. This CLI keeps no copy and cannot recover it. To choose your own instead: candle vault init --own-passphrase"

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
    booleanFlags: ["--own-passphrase", "--high-value"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  const ownPassphrase = parsed.booleans.has("--own-passphrase")
  if (ctx.json && !ownPassphrase) return usage(ctx, GENERATED_PASSPHRASE_NEEDS_TERMINAL)
  if (!requireTty(ctx, "vault init")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const highValue = parsed.booleans.has("--high-value")

  return runVaultCommand(ctx, async () => {
    if (await fileExists(path)) {
      throw vaultAlreadyExists(
        ctx,
        resolvedVault,
        "This CLI never overwrites one, including after an interrupted init. Move it aside if you really mean to start over.",
      )
    }

    // D8 (BE-241): said before the ceremony rather than beside the words. BE-235 item 5 asked
    // whether a first-ever init should say so LOUDER, before the words; this is that answer. No new
    // prompt: the copy-back is itself the proof of capture, and a mismatch costs nothing because no
    // file exists yet.
    if (!ownPassphrase) deps.stdout.write(`${INIT_GENERATED_PASSPHRASE_NOTICE}\n`)
    const passphrase = ownPassphrase ? await collectOwnPassphrase(ctx) : await collectGeneratedPassphrase(ctx)

    // 256 bits from WebCrypto. Held as ENTROPY and never as words until a ceremony renders them.
    const entropy = randomBytes(ROOT_ENTROPY_BYTES)
    const vault = await withSecret(entropy, async (rootEntropy) =>
      createVault(
        {
          path,
          passphrase,
          strength: strengthFor(ownPassphrase),
          rootEntropy,
          label: parsed.values["--label"],
          notice: (line) => deps.stderr.write(line),
        },
        deps,
      ),
    )

    try {
      // `--high-value` has no authenticated home in CC-01's schema (see the PR notes), so it is
      // recorded in the sidecar and `new-key` reads it from there. Stated rather than hidden: a
      // lost sidecar loses the constraint, which is why the write is checked rather than best
      // effort here, unlike the bookkeeping fields beside it.
      if (highValue) {
        const sidecar = sidecarPath(path)
        await writeSidecar(sidecar, {
          ...nextSidecar(await readSidecar(sidecar), vault.file),
          highValue: true,
        } as never)
      }

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
          highValue,
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
      if (highValue)
        deps.stdout.write(
          `  high value   yes: new-key needs a generated passphrase, or two recoverable factors in different domains\n`,
        )
      deps.stdout.write(
        `\nVerified: the file was re-read and opened with the passphrase you set, and its root blob decrypted.\n`,
      )
      deps.stdout.write(`\n${APPLE_ACCOUNT_NOTICE}\n`)

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
 * AD-6's default. Generated, shown once, and typed back IN FULL before anything is written: a
 * passphrase the operator has not proven they captured is a vault they cannot open, and the file
 * does not exist yet when this runs, so a mismatch costs nothing.
 */
async function collectGeneratedPassphrase(ctx: CommandContext): Promise<string> {
  const passphrase = generatePassphrase()
  ctx.deps.stdout.write(
    `\nYour vault passphrase, ${GENERATED_WORD_COUNT} words, about ${generatedEntropyBits()} bits. Write it down now; it is shown once and this CLI keeps no copy.\n\n`,
  )
  ctx.deps.stdout.write(`    ${passphrase}\n\n`)
  const typed = await ctx.deps.promptSecret("Type it back in full to confirm (input hidden): ")
  if (typed.trim() !== passphrase) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "That did not match the passphrase shown above. Nothing was written.", {
      suggestion: "Run `candle vault init` again for a new one.",
    })
  }
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

export { defaultVaultPath }
