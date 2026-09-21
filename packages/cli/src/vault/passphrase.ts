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
 * AD-6's `--own-passphrase` rule, plus the whitespace rule above. Throws the refusal rather than
 * returning a verdict, because every caller does the same thing with a rejection and the message
 * is the whole value. `vault init`, `factor add passphrase` and `restore` all call this before
 * anything is written.
 */
export function assertOwnPassphraseAcceptable(passphrase: string): void {
  assertNoSurroundingWhitespace(passphrase)
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

/**
 * The ONE whitespace rule (BE-178, finding 1). A vault passphrase is its trimmed form: a chosen
 * one may not begin or end with whitespace, and every generated one is words joined by single
 * spaces, so the string wrapped around the key always equals its own `trim()`.
 *
 * The rule is applied in two places and nowhere else. `assertOwnPassphraseAcceptable` refuses a
 * chosen passphrase that breaks it BEFORE anything is written, with a message that says so, rather
 * than silently changing what the operator typed. `passphraseAttempts` applies it when a passphrase
 * is typed to unlock: the input exactly as typed is tried first, and when that fails and the
 * trimmed form differs, the trimmed form is tried too. Exact-first is what rescues a vault CLI
 * 0.10.0 created with surrounding spaces kept (creation stored the string as typed while every
 * unlock trimmed it, so such a vault could never be opened); trimmed-second is what lets a normal
 * vault open when a stray trailing space is typed at the prompt.
 */
export function assertNoSurroundingWhitespace(passphrase: string): void {
  if (passphrase !== passphrase.trim()) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      "A passphrase you choose must not begin or end with a space or other whitespace; the vault would keep it exactly as typed, and it could not be reproduced at the unlock prompt.",
      { suggestion: "Nothing was written. Choose it again without the leading or trailing whitespace." },
    )
  }
}

/** The strings to try, in order, when `typed` is entered at an unlock prompt. Empty means nothing typed. */
export function passphraseAttempts(typed: string): string[] {
  const trimmed = typed.trim()
  if (trimmed === "") return []
  return trimmed === typed ? [typed] : [typed, trimmed]
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

/**
 * Where a generated passphrase should GO, printed immediately under the words (BE-245).
 *
 * `init` used to end that screen with a type-it-back prompt whose stated reason was proving the
 * operator had captured the passphrase. It proved no such thing: the words are on screen while you
 * type them, so what it established is that they are on your display, which you already knew.
 * Worse, eight random words is exactly enough friction that people select-and-paste, which puts a
 * ~103-bit root passphrase through the clipboard and into any clipboard manager's history. What
 * was missing was never a check; it was this sentence -- WHERE to put it, that this CLI cannot get
 * it back, and what the fallback is. The acknowledgement that follows is honestly a nudge, not a
 * test, and the prompt says "when you have saved it" rather than claiming to verify anything.
 */
export const SAVE_THE_PASSPHRASE =
  "Save it now, in your password manager or on paper. This CLI keeps no copy and cannot recover it. If you lose it, your 24-word recovery phrase is the way back in."

/** The acknowledgement under `SAVE_THE_PASSPHRASE`. A nudge, deliberately: it checks nothing. */
export const SAVED_IT_PROMPT = "Press Enter when you have saved it: "
