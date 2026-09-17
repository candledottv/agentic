/**
 * Ember Phase 2 (BE-136, ED-5): the two Ed25519 facts the vault needs, kept apart from `hd.ts` so
 * the derivation module has no opinion about how a secret is laid out on disk.
 *
 * The layout is Phase 1's, unchanged: a Solana secret is 64 bytes, seed(32) then public key(32),
 * which is what `solana-lite.ts`'s `pubkeyFromSecret` already checks and what
 * `wallet-import.ts` already seals. ED-5 keeps it so that one reader serves both stores and a
 * migrated TEE wallet key and a derived vault key are the same shape of bytes.
 */
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import { VaultError } from "./errors"
import { ownSecret } from "./hygiene"

export const SOLANA_SECRET_BYTES = 64
export const SECP256K1_SCALAR_BYTES = 32

/** Expands a 32-byte Ed25519 seed into the 64-byte secret and its base58 address. */
export function pubkeyFromSecretSeed(seed32: Uint8Array): { secret64: Uint8Array; address: string } {
  if (seed32.length !== 32) {
    throw new VaultError("VAULT_BLOB_TAMPERED", `expected a 32-byte ed25519 seed, got ${seed32.length}`)
  }
  const publicKey = ed25519.getPublicKey(seed32)
  const secret64 = ownSecret(new Uint8Array(SOLANA_SECRET_BYTES))
  secret64.set(seed32, 0)
  secret64.set(publicKey, 32)
  return { secret64, address: base58.encode(publicKey) }
}

/**
 * The address a stored 64-byte secret actually belongs to, re-derived from its seed rather than
 * read out of its second half. The verifier's step 5 rests on this being a derivation and not a
 * lookup: a blob whose embedded public key was edited must fail, not pass.
 */
export function addressFromSecret64(secret64: Uint8Array): string {
  if (secret64.length !== SOLANA_SECRET_BYTES) {
    throw new VaultError(
      "VAULT_BLOB_TAMPERED",
      `expected a ${SOLANA_SECRET_BYTES}-byte Solana secret, got ${secret64.length}`,
    )
  }
  return base58.encode(ed25519.getPublicKey(secret64.subarray(0, 32)))
}
