/**
 * Ember Phase 2 (BE-136, ED-13, AD-5): SLIP-0010 Ed25519 derivation, implemented here rather than
 * taken from a library.
 *
 * It is one HMAC-SHA512 chain with no scalar arithmetic and no retry loop, which is the whole
 * reason ED-13 chose to keep it in the repo: there are about twenty lines to review, they run in
 * all three shipping shapes with no bundler question, and T53 pins them to SLIP-0010's published
 * Ed25519 vectors. The recorded alternative is `micro-key-producer/slip10.js`, the hardened-only
 * subset from the author of the pinned `@noble` libraries; the vectors test is the same either way.
 *
 * The one rule worth stating out loud: **there are no non-hardened Ed25519 children.** SLIP-0010
 * defines none, so `deriveChild` refuses any index below 2^31 rather than inventing a meaning for
 * it. That refusal is also what AD-4's condition rests on: every child is a one-way HMAC-SHA512
 * output of its parent, siblings are separate outputs, and no leaf reaches its parent or its
 * siblings.
 */
import { hmac } from "@noble/hashes/hmac"
import { sha512 } from "@noble/hashes/sha512"
import { VaultError } from "./errors"
import { ownSecret, wipe } from "./hygiene"

export const HARDENED_OFFSET = 0x8000_0000

/** SLIP-0010's Ed25519 curve name, the HMAC key for the master derivation. */
const ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed")

export interface Slip10Node {
  /** 32 bytes. For Ed25519 this is the SEED half of a keypair, not a scalar. */
  key: Uint8Array
  chainCode: Uint8Array
}

/** `I = HMAC-SHA512("ed25519 seed", seed)`; `I_L` is the master key, `I_R` the master chain code. */
export function masterFromSeed(seed: Uint8Array): Slip10Node {
  const i = hmac(sha512, ED25519_SEED_KEY, seed)
  try {
    return { key: ownSecret(i.slice(0, 32)), chainCode: ownSecret(i.slice(32)) }
  } finally {
    wipe(i)
  }
}

/**
 * `I = HMAC-SHA512(chainCode, 0x00 || key || ser32(index))`, hardened only.
 *
 * The leading `0x00` is SLIP-0010's own padding for the Ed25519 case (there is no compressed
 * public key to serialize, so the private key is padded to 33 bytes instead), and it is the byte a
 * reimplementation is most likely to leave out; the vectors catch it.
 */
export function deriveChild(node: Slip10Node, index: number): Slip10Node {
  if (!Number.isInteger(index) || index < HARDENED_OFFSET || index > 0xffff_ffff) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `SLIP-0010 Ed25519 has no non-hardened children; refusing index ${index}.`,
    )
  }
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0
  data.set(node.key, 1)
  new DataView(data.buffer).setUint32(33, index >>> 0, false)
  const i = hmac(sha512, node.chainCode, data)
  try {
    return { key: ownSecret(i.slice(0, 32)), chainCode: ownSecret(i.slice(32)) }
  } finally {
    wipe(data, i)
  }
}

/**
 * Parses a path like `m/44'/501'/0'/0'` into hardened indices. Every element must carry the
 * apostrophe: an unhardened element is not a path this scheme can walk, and silently hardening it
 * would derive a different key than the string says.
 */
export function parsePath(path: string): number[] {
  const parts = path.split("/")
  if (parts[0] !== "m") throw new VaultError("VAULT_INDEX_INVALID", `Not a derivation path: ${path}`)
  return parts.slice(1).map((part) => {
    const hardened = part.endsWith("'") || part.endsWith("h")
    const raw = hardened ? part.slice(0, -1) : part
    if (!/^\d+$/.test(raw)) throw new VaultError("VAULT_INDEX_INVALID", `Not a derivation path element: ${part}`)
    const index = Number(raw)
    if (!hardened) {
      throw new VaultError(
        "VAULT_INDEX_INVALID",
        `SLIP-0010 Ed25519 has no non-hardened children; ${path} asks for one.`,
      )
    }
    if (index >= HARDENED_OFFSET) throw new VaultError("VAULT_INDEX_INVALID", `Derivation index out of range: ${part}`)
    return index + HARDENED_OFFSET
  })
}

/**
 * Walks `path` from `seed` and returns the leaf's 32 key bytes. Every intermediate node is zeroed
 * on the way out, including on the throwing path: a chain code is not a secret the vault exports
 * (AD-5 forbids exporting one in any form), and an intermediate key is a parent of everything
 * below it.
 */
export function derivePath(seed: Uint8Array, path: string): Uint8Array {
  const indices = parsePath(path)
  let node = masterFromSeed(seed)
  const spent: Slip10Node[] = [node]
  try {
    for (const index of indices) {
      node = deriveChild(node, index)
      spent.push(node)
    }
    return ownSecret(node.key.slice())
  } finally {
    for (const used of spent) wipe(used.key, used.chainCode)
  }
}
