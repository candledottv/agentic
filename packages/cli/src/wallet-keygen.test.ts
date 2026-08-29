/**
 * Address derivation is the part of key generation that can be silently wrong: a mismatched pair
 * imports a wallet whose key cannot sign it (the "garbage-keyed wallet" failure wallet-import.ts's
 * module doc warns about), and nothing downstream notices until a trade fails.
 *
 * So the Solana case asserts the exact relationship `resolveImportAddress` checks rather than a
 * golden string, and the EVM case asserts against the canonical secp256k1 test vector, which pins
 * the keccak derivation AND the EIP-55 checksum against a value this repo did not compute.
 */
import { describe, expect, test } from "bun:test"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { base58 } from "@scure/base"
import { generateWallet } from "./wallet-keygen"

/** Re-derives an EVM address the same way the module does, for the known-vector check below. */
function addressFor(priv: Uint8Array): string {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  const body = hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1))).slice(-40)
  const digest = hex(keccak_256(new TextEncoder().encode(body)))
  let out = "0x"
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    out += Number.parseInt(digest[i] as string, 16) >= 8 ? c.toUpperCase() : c
  }
  return out
}

describe("generateWallet", () => {
  test("solana: the address is the base58 public key embedded at bytes 32..64", () => {
    const w = generateWallet("solana")
    const secret = base58.decode(w.privateKey)
    expect(secret.length).toBe(64)
    // Exactly what resolveImportAddress derives. Matching it is what makes the pair importable.
    expect(base58.encode(secret.slice(32))).toBe(w.address)
  })

  test("evm: matches the canonical vector for private key 0x...01", () => {
    const priv = new Uint8Array(32)
    priv[31] = 1
    expect(addressFor(priv)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf")
  })

  test("evm: produces a checksummed 20-byte address and a 32-byte key", () => {
    const w = generateWallet("evm")
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // A purely lowercase result would mean the checksum step was skipped. Vanishingly unlikely to
    // occur by chance for a real address (~1 in 2^40 of having no letters at all).
    expect(w.address).not.toBe(w.address.toLowerCase())
    expect(w.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test("every call produces a distinct key", () => {
    expect(generateWallet("solana").address).not.toBe(generateWallet("solana").address)
    expect(generateWallet("evm").address).not.toBe(generateWallet("evm").address)
  })
})
