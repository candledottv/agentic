/**
 * Ember Phase 2 (BE-136, CC-11): `candle vault phrase show`, the recovery phrase export ceremony.
 *
 * AD-5 bought easier backup and restore at a stated price: one secret now covers every derived key
 * on every chain. The phrase is therefore handled as an EXPORT CEREMONY rather than as output, and
 * the ordering is the substance of it:
 *
 *   TTY on both ends, or nothing is rendered at all (`PHRASE_REQUIRES_TTY`).
 *   A fresh factor prompt, so possession of an already-running shell is not possession of the phrase.
 *   A typed acknowledgement, so the operator has said what they are about to do.
 *   `rootExported: true` written to the vault FIRST, so the record precedes the exposure and a
 *     crash between the write and the render leaves the vault saying the phrase may be out.
 *   Only then the 24 words, and a read-back of three of them at random positions.
 *
 * What this stops, precisely: an agent driving the CLI through pipes, a subprocess, or `--json`
 * cannot obtain the phrase, because the CLI refuses before rendering it. What it does not stop,
 * stated rather than implied: a same-user process that allocates a pseudo-terminal can read the
 * screen. That is the boundary CC-04 already concedes; the typed confirmation and the
 * `rootExported` flag are what make the attempt visible afterwards.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { VaultError } from "../vault/errors"
import { PHRASE_WORDS, phraseFromEntropy } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import { commitVault, decryptRoot, type UnlockedVault } from "../vault/store"
import {
  refuseEnvPassphrase,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
} from "./vault-support"

const ACKNOWLEDGEMENT = "understood"

export async function vaultPhraseShow(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--keystore"], booleanFlags: ["--accept-older-copy"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  // Exit 2, a usage error: asking for the phrase as machine output is a malformed request, not a
  // refused one, and answering it with a failure envelope would still be answering it.
  if (ctx.json) {
    return usage(
      ctx,
      "The recovery phrase ceremony is interactive only and has no --json form. Run it without --json, on a terminal.",
    )
  }
  if (!assertPhraseTty(ctx)) return 1

  const path = vaultPathFor(ctx, parsed)
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const vault = hold(
      (
        await unlockInteractively(ctx, path, raw, {
          acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
          promptText: "Vault passphrase (input hidden): ",
        })
      ).vault,
    )
    return runPhraseCeremony(ctx, vault, { alreadyUnlockedWithFreshFactor: true })
  })
}

/**
 * The TTY gate, checked before anything else and, crucially, before any render. Both ends: stdout
 * alone would let a piped stdin drive it, and stdin alone would let the words land in a file.
 */
export function assertPhraseTty(ctx: CommandContext): boolean {
  if (ctx.deps.isTTY.stdin && ctx.deps.isTTY.stdout) return true
  ctx.deps.stderr.write(
    "The recovery phrase is shown only on a terminal, on both ends. Nothing was rendered, and the vault was not read.\n",
  )
  // Written directly rather than through the shared writer: there is no `--json` branch to take
  // here (that case exited 2 above), and the code still has to reach the caller.
  ctx.deps.stderr.write("PHRASE_REQUIRES_TTY\n")
  return false
}

/**
 * The ceremony itself, shared by `vault init`'s one-time offer and `vault phrase show`.
 *
 * `alreadyUnlockedWithFreshFactor` is passed by `phrase show`, which just prompted; `init` passes
 * nothing and gets the fresh prompt CC-11 requires, because the passphrase it collected was part
 * of creating the vault rather than of asking for the phrase.
 */
export async function runPhraseCeremony(
  ctx: CommandContext,
  vault: UnlockedVault,
  opts: { alreadyUnlockedWithFreshFactor?: boolean } = {},
): Promise<number> {
  const { deps } = ctx
  if (!ctx.deps.isTTY.stdin || !ctx.deps.isTTY.stdout) {
    throw new VaultError(
      "PHRASE_REQUIRES_TTY",
      "The recovery phrase is shown only on a terminal, on both ends. Nothing was rendered.",
    )
  }

  if (!opts.alreadyUnlockedWithFreshFactor) {
    const typed = await deps.promptSecret("Vault passphrase, again, to show the recovery phrase (input hidden): ")
    const envelope = vault.file.envelopes.find((candidate) => candidate.factor === "passphrase")
    if (!envelope) throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "This vault has no passphrase envelope.")
    const { unlockWithPassphrase } = await import("../vault/store")
    const { openWithTypedPassphrase } = await import("./vault-support")
    const { vault: reopened } = await openWithTypedPassphrase(typed, (candidate) =>
      unlockWithPassphrase(vault.path, vault.raw, candidate, { notice: (line) => deps.stderr.write(line) }),
    )
    // Only the proof was wanted; the caller's handle stays the one that gets closed.
    const { closeVault } = await import("../vault/store")
    closeVault(reopened)
  }

  deps.stdout.write(
    `\nThe 24 words below re-derive every key this vault derives, on any BIP-39 wallet, with no passphrase and no server.\nThey do NOT restore any key imported from the Phase 1 TEE wallet store; the vault file plus a factor does that.\nAnyone who reads them can move every derived key's funds.\n\n`,
  )
  const acknowledgement = (await deps.promptLine(`Type ${ACKNOWLEDGEMENT} to continue, or anything else to stop: `))
    .trim()
    .toLowerCase()
  if (acknowledgement !== ACKNOWLEDGEMENT) {
    deps.stdout.write("Stopped. Nothing was displayed and nothing was written.\n")
    return 1
  }

  // The record precedes the exposure: a vault write, generation increments, and the flag never
  // resets. A crash between here and the render leaves a vault that says the phrase may be out,
  // which is the safe direction to be wrong in.
  const at = new Date(deps.now()).toISOString()
  const written = await commitVault(
    vault,
    { index: { ...vault.index, hd: { ...vault.index.hd, rootExported: true, rootExportedAt: at } } },
    deps,
  )

  const entropy = await decryptRoot(written)
  let words: string[]
  try {
    words = phraseFromEntropy(entropy).split(" ")
  } finally {
    wipe(entropy)
  }

  deps.stdout.write("\n")
  for (let i = 0; i < words.length; i += 4) {
    const row = words
      .slice(i, i + 4)
      .map((word, offset) => `${String(i + offset + 1).padStart(2, " ")}. ${(word as string).padEnd(9, " ")}`)
      .join("  ")
    deps.stdout.write(`    ${row.trimEnd()}\n`)
  }
  deps.stdout.write("\n")

  const positions = randomPositions(3, words.length)
  let confirmed = true
  for (const position of positions) {
    const typed = (await deps.promptLine(`Type word ${position + 1}: `)).trim().toLowerCase()
    if (typed !== words[position]) confirmed = false
  }

  // Hygiene, not a guarantee (CC-04): the words were on a screen and this only removes them from
  // the visible region. The scrollback is the operator's to clear and the output says so.
  deps.stdout.write("\u001b[2J\u001b[H")
  deps.stdout.write(
    "The phrase is no longer on screen. Clear your terminal's scrollback: the words were rendered there and this CLI cannot remove them.\n",
  )
  deps.stdout.write("This vault now records that the recovery phrase was exported; that record never resets.\n")
  words.fill("")

  if (!confirmed) {
    throw new VaultError(
      "PHRASE_NOT_CONFIRMED",
      "One of the words you typed back did not match, so the copy you wrote down may be wrong.",
      {
        suggestion:
          "The export is already recorded, because the words were on the screen. Run `candle vault phrase show` again and check your copy.",
      },
    )
  }
  deps.stdout.write("Read-back matched.\n")
  return 0
}

/** Three distinct positions, drawn with WebCrypto so the read-back cannot be predicted. */
function randomPositions(count: number, of = PHRASE_WORDS): number[] {
  const chosen = new Set<number>()
  const scratch = new Uint32Array(1)
  const limit = Math.floor(0x1_0000_0000 / of) * of
  while (chosen.size < count) {
    crypto.getRandomValues(scratch)
    const draw = scratch[0] ?? 0
    if (draw >= limit) continue
    chosen.add(draw % of)
  }
  scratch.fill(0)
  return [...chosen].sort((a, b) => a - b)
}
