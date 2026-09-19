/**
 * Ember Phase 2 (BE-136, CC-11, ED-13, AD-5): the HD root, the fixed derivation paths, and the
 * one place a phrase is rendered from entropy.
 *
 * AD-5 chose an HD root over independent keys for backup and restore, with the cost stated: one
 * secret now covers every derived key on every chain. Two things bound that cost, and both live
 * here. The root blob holds the 32 bytes of ENTROPY, not the seed and not the words, so the phrase
 * is re-rendered on demand and the seed is recomputed per derivation event and zeroed; and every
 * path is fully hardened per key, so no leaf reaches its parent or its siblings.
 *
 * The BIP-39 optional passphrase (the "25th word") is fixed to the empty string, deliberately. A
 * restore then has ONE input, and an operator who kept the words cannot find themselves holding
 * the right phrase and the wrong vault.
 */
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed, validateMnemonic } from "@scure/bip39"
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english"
import { pubkeyFromSecretSeed } from "./ed25519"
import { VaultError } from "./errors"
import type { Branch } from "./format"
import { ownSecret, wipe } from "./hygiene"
import { derivePath } from "./slip10"

export const ROOT_ENTROPY_BYTES = 32
export const PHRASE_WORDS = 24

/** CC-11's table, as the only place a path string is built. */
export const DERIVATION_SCHEME = "slip10-ed25519" as const

export function solanaVaultPath(index: number): string {
  return `m/44'/501'/${assertIndex(index)}'/0'`
}

/**
 * The fresh-key-promote branch. Change index `1'` is on no published scan list of Phantom,
 * Solflare or Ledger Live, so restoring the phrase into a wallet app does not present a remotely
 * exposed key as an ordinary account.
 */
export function solanaTeePath(index: number): string {
  return `m/44'/501'/${assertIndex(index)}'/1'`
}

/**
 * The external-wallet branch (Ember Phase 3 PR F, R6, P3-AD-13; CC-11's third Solana row). Change
 * index `2'` is a third change index that neither the vault branch (`0'`) nor the TEE branch
 * (`1'`) can reach, and, like `1'`, it is on no published scan list of Phantom, Solflare or
 * Ledger Live. A key here signs only through `candle sign` and `candle external sweep`.
 */
export function solanaExternalPath(index: number): string {
  return `m/44'/501'/${assertIndex(index)}'/2'`
}

/** Phase 4's path, fixed now so the format and the reader agree before any code derives one. */
export function evmPath(index: number): string {
  return `m/44'/60'/${assertIndex(index)}'/0/0`
}

export function pathForBranch(branch: Branch, index: number): string {
  if (branch === "solanaVault") return solanaVaultPath(index)
  if (branch === "solanaTee") return solanaTeePath(index)
  if (branch === "solanaExternal") return solanaExternalPath(index)
  return evmPath(index)
}

function assertIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= 0x8000_0000) {
    throw new VaultError("VAULT_INDEX_INVALID", `Derivation index out of range: ${index}`)
  }
  return index
}

// ── Phrase ────────────────────────────────────────────────────────────────────────────────────

export const bip39Wordlist = englishWordlist

/** Renders the 24 words from the stored entropy. The ONLY place words are produced. */
export function phraseFromEntropy(entropy: Uint8Array): string {
  if (entropy.length !== ROOT_ENTROPY_BYTES) {
    throw new VaultError(
      "VAULT_BLOB_TAMPERED",
      `The root blob holds ${entropy.length} bytes, expected ${ROOT_ENTROPY_BYTES}.`,
    )
  }
  return entropyToMnemonic(entropy, englishWordlist)
}

/**
 * Validates a typed phrase and returns its entropy. A checksum failure is `PHRASE_INVALID` and the
 * caller writes nothing; the message never echoes a word back.
 */
export function entropyFromPhrase(phrase: string): Uint8Array {
  const normalized = normalizePhrase(phrase)
  if (normalized.split(" ").length !== PHRASE_WORDS) {
    throw new VaultError("PHRASE_INVALID", `A recovery phrase is ${PHRASE_WORDS} words; that is not.`)
  }
  if (!validateMnemonic(normalized, englishWordlist)) {
    throw new VaultError("PHRASE_INVALID", "That is not a valid recovery phrase: the checksum does not match.", {
      suggestion: "Nothing was written. Check the word order and try again.",
    })
  }
  return ownSecret(mnemonicToEntropy(normalized, englishWordlist))
}

/** Lowercased, single-spaced. Typing is how a phrase arrives, so spacing must not decide a restore. */
export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/u).filter(Boolean).join(" ")
}

/** True when the checksum is valid, without throwing. Used by the verifier's step 4. */
export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), englishWordlist)
}

// ── Derivation events (ED-13) ─────────────────────────────────────────────────────────────────

/**
 * The BIP-39 seed for this root, recomputed per derivation event and zeroed by the caller.
 * PBKDF2-HMAC-SHA512, 2048 rounds, empty optional passphrase (ED-13); milliseconds, so there is
 * nothing to be gained by caching it and one more long-lived secret to lose if it were.
 */
export async function seedFromEntropy(entropy: Uint8Array): Promise<Uint8Array> {
  const phrase = phraseFromEntropy(entropy)
  return ownSecret(await mnemonicToSeed(phrase, ""))
}

/** A derived Solana keypair: the 64-byte secret (seed then public key) the whole CLI already speaks. */
export interface DerivedKey {
  /** 64 bytes: seed(32) || pubkey(32). The caller owns it and zeroes it. */
  secret64: Uint8Array
  address: string
  path: string
}

/**
 * Derives one Solana key from the root entropy along `path`. Everything intermediate (the seed,
 * the SLIP-0010 leaf) is zeroed here; only the 64-byte secret leaves, and its caller zeroes that.
 */
export async function deriveSolanaKey(entropy: Uint8Array, path: string): Promise<DerivedKey> {
  const seed = await seedFromEntropy(entropy)
  try {
    const leaf = derivePath(seed, path)
    try {
      const { secret64, address } = pubkeyFromSecretSeed(leaf)
      return { secret64, address, path }
    } finally {
      wipe(leaf)
    }
  } finally {
    wipe(seed)
  }
}
