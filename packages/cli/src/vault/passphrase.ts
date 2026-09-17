/**
 * Ember Phase 2 (BE-136, CC-03, AD-6, ED-9): the passphrase factor's policy.
 *
 * AD-6 chose generated-by-default over both alternatives. The reason it matters here rather than
 * in the command is that the two shapes make different CLAIMS: a generated 8-word passphrase has
 * an entropy this code computed and can name (`generated-103`), and a user-chosen one has an
 * entropy nobody knows (`user-chosen`), which is exactly what `vault status` prints. Recording the
 * claim inside the envelope's associated data is what binds it to the KDF parameters it describes,
 * so a file cannot carry a strong label over weak parameters.
 *
 * The denylist is small on purpose. It is not a password-strength oracle; it is a floor that stops
 * the handful of strings someone types when they want the prompt to go away, and the 16-character
 * minimum is what does the rest of the work.
 */

import { EFF_LONG_WORDLIST } from "./eff-wordlist"
import { VaultError } from "./errors"
import type { PassphraseStrength } from "./format"

/** AD-6: eight words from the 7776-word list, about 12.925 bits each. */
export const GENERATED_WORD_COUNT = 8
export const OWN_PASSPHRASE_MIN_LENGTH = 16

/**
 * Generated with rejection sampling rather than a modulo, because 2^32 is not a multiple of 7776
 * and a modulo would make the low words very slightly likelier. The bias is tiny and the fix is
 * four lines, which is the wrong trade to skip in the one place the entropy claim is made.
 */
export function generatePassphrase(words = GENERATED_WORD_COUNT): string {
  const size = EFF_LONG_WORDLIST.length
  const limit = Math.floor(0x1_0000_0000 / size) * size
  const chosen: string[] = []
  const scratch = new Uint32Array(1)
  while (chosen.length < words) {
    crypto.getRandomValues(scratch)
    const draw = scratch[0] ?? 0
    if (draw >= limit) continue
    chosen.push(EFF_LONG_WORDLIST[draw % size] as string)
  }
  scratch.fill(0)
  return chosen.join(" ")
}

/** The bits a generated passphrase of `words` words carries, for the output that states it. */
export function generatedEntropyBits(words = GENERATED_WORD_COUNT): number {
  return Math.round(words * Math.log2(EFF_LONG_WORDLIST.length))
}

/**
 * The embedded denylist. Lowercased, whitespace-collapsed comparison, so "Correct Horse Battery
 * Staple" is refused along with its lowercase twin.
 */
const DENYLIST: readonly string[] = [
  "correct horse battery staple",
  "correcthorsebatterystaple",
  "passwordpassword",
  "password123456789",
  "qwertyuiopasdfgh",
  "1234567890123456",
  "iloveyouiloveyou",
  "letmeinletmeinletmein",
  "administratoradmin",
  "candlecandlecandle",
  "thisisapassphrase",
  "changemechangeme",
  "abcdefghijklmnop",
  "aaaaaaaaaaaaaaaa",
  "keyboardkeyboard",
  "trustnoonetrustnoone",
]

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ")
}

export function isOnDenylist(passphrase: string): boolean {
  const normalized = normalize(passphrase)
  return DENYLIST.includes(normalized) || DENYLIST.includes(normalized.replace(/\s/gu, ""))
}

/**
 * AD-6's `--own-passphrase` rule. Throws the refusal rather than returning a verdict, because
 * every caller does the same thing with a rejection and the message is the whole value.
 */
export function assertOwnPassphraseAcceptable(passphrase: string): void {
  if (passphrase.length < OWN_PASSPHRASE_MIN_LENGTH) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `A passphrase you choose must be at least ${OWN_PASSPHRASE_MIN_LENGTH} characters; that one is ${passphrase.length}.`,
      { suggestion: "Nothing was written. Run without --own-passphrase to have one generated instead." },
    )
  }
  if (isOnDenylist(passphrase)) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "That passphrase is on this CLI's list of common passphrases.", {
      suggestion: "Nothing was written. Choose another, or run without --own-passphrase to have one generated.",
    })
  }
}

export function strengthFor(ownPassphrase: boolean): PassphraseStrength {
  return ownPassphrase ? "user-chosen" : "generated-103"
}

/** What `vault status` and `factor list` print beside an envelope, in one place (CC-03). */
export function strengthLabel(strength: PassphraseStrength): string {
  return strength === "generated-103"
    ? `generated, ${GENERATED_WORD_COUNT} words (about ${generatedEntropyBits()} bits)`
    : "chosen by you (this CLI cannot know its entropy)"
}

/** AD-6's line, printed by `vault init` and by `factor add passphrase`. One copy, one wording. */
export const APPLE_ACCOUNT_NOTICE =
  "Keep this passphrase and your recovery phrase outside the Apple account that holds a synced passkey: an Apple-generated password saved to iCloud Keychain lands in that account."
