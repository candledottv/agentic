/**
 * Key generation for `wallets generate`.
 *
 * Deliberately NOT added to wallet-import.ts: that file is a byte-identical vendored copy of the
 * SDK's module of the same name, and wallet-import.drift.test.ts fails the build if it diverges.
 * This module only generates and derives; sealing for transport stays there.
 *
 * The output forms match what the import path already accepts, so a generated wallet needs no
 * conversion before `encryptWalletKeyForImport`: base58 of the 64-byte secret for Solana (what
 * `solana-keygen` writes and `parseSolanaSecret` reads), 0x-prefixed hex for EVM. The Solana
 * layout in particular is load-bearing -- `resolveImportAddress` derives the address from bytes
 * 32..64 and refuses a mismatched pair, so a secret assembled any other way would be rejected at
 * import rather than silently provisioning a wallet whose key cannot sign it.
 */
import { generateKeyPairSync } from "node:crypto"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { base58 } from "@scure/base"
import type { WalletChain } from "./wallet-import"

export interface GeneratedWallet {
  /** Base58 for Solana, 0x-prefixed EIP-55 checksummed hex for EVM. */
  address: string
  /** Base58 of the 64-byte secret for Solana, 0x-prefixed hex for EVM. */
  privateKey: string
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

/**
 * EIP-55 mixed-case checksum. Lowercase hex is a valid address and Privy accepts it, but every
 * explorer and wallet displays the checksummed form, so printing lowercase would look like a
 * different address to anyone comparing the two.
 */
function toChecksumAddress(lowercaseBody: string): string {
  const digest = hex(keccak_256(new TextEncoder().encode(lowercaseBody)))
  let out = "0x"
  for (let i = 0; i < lowercaseBody.length; i++) {
    const c = lowercaseBody[i] as string
    out += Number.parseInt(digest[i] as string, 16) >= 8 ? c.toUpperCase() : c
  }
  return out
}

function generateSolana(): GeneratedWallet {
  // node's ed25519 keys export DER-wrapped. For this curve the raw 32-byte key is the tail of both
  // encodings (SPKI ends with the public key, PKCS8 with the seed), which is what makes the
  // fixed-length suffix slice safe rather than a guess.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pub = new Uint8Array(publicKey.export({ type: "spki", format: "der" })).slice(-32)
  const seed = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })).slice(-32)
  const secret = new Uint8Array(64)
  secret.set(seed, 0)
  secret.set(pub, 32)
  return { address: base58.encode(pub), privateKey: base58.encode(secret) }
}

function generateEvm(): GeneratedWallet {
  const priv = secp256k1.utils.randomPrivateKey()
  // Uncompressed public key is 65 bytes with an 0x04 prefix; the address is the last 20 bytes of
  // the keccak of the 64 bytes after that prefix.
  const pub = secp256k1.getPublicKey(priv, false).slice(1)
  return { address: toChecksumAddress(hex(keccak_256(pub)).slice(-40)), privateKey: `0x${hex(priv)}` }
}

export function generateWallet(chain: WalletChain): GeneratedWallet {
  return chain === "solana" ? generateSolana() : generateEvm()
}
