/**
 * Ember Phase 2 (BE-136, CC-02, ED-2, ED-3, ED-4): the vault's crypto primitives, and only those.
 *
 * Four of them, which is the count the appendix promises: Argon2id, AES-256-GCM, HKDF-SHA-256 and
 * canonical JSON (that one lives in `canonical-json.ts`). There is deliberately no fifth: ED-1
 * chose the canonical header as the index blob's associated data precisely so that the format
 * needs no header MAC and no header key.
 *
 * Argon2id comes from `@noble/hashes/argon2` (ED-2) because a KDF compiled into a signed binary
 * has to be a fixed set of bytes that behaves identically in the npm bundle under Node, in the
 * Bun-compiled binaries, and in the agentic mirror. It is pure JavaScript, so `bun build` inlines
 * it; a native addon cannot be compiled into a single-file binary and a WASM blob is a second
 * artifact to pin. ED-2 records `hash-wasm` as the fallback if T32's measurements are
 * unacceptable. Everything else is WebCrypto, as v1 already is.
 *
 * Base64url, unpadded, is the encoding for EVERY binary field in the file. CC-01 names it for
 * `vaultId` and the id lists and does not name one for `iv`, `ciphertext` or `salt`; one encoding
 * for the whole file is what makes the appendix's "parse the JSON" step a sentence rather than a
 * table, so that is the reading taken here.
 */
import { argon2idAsync } from "@noble/hashes/argon2"
import { base64urlnopad } from "@scure/base"
import { canonicalBytes } from "./canonical-json"
import { VaultError } from "./errors"
import { ownSecret, secretBuffer, wipe } from "./hygiene"

// ── Encoding ──────────────────────────────────────────────────────────────────────────────────

export function b64u(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes)
}

/** Decodes a base64url field, refusing anything that is not one rather than returning garbage. */
export function unb64u(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new VaultError("VAULT_UNREADABLE", `${field} is not a string.`)
  try {
    return base64urlnopad.decode(value)
  } catch {
    throw new VaultError("VAULT_UNREADABLE", `${field} is not base64url.`)
  }
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(secretBuffer(length))
}

/** Constant-time-ish equality. Used on public values (addresses, tags already checked by AEAD). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// ── Argon2id (ED-3) ───────────────────────────────────────────────────────────────────────────

/** The defaults ED-3 fixes. RFC 9106 section 4's second recommended option, with `p = 1`. */
export const ARGON2_DEFAULTS = { version: 19, m: 65_536, t: 3, p: 1 } as const
export const ARGON2_SALT_BYTES = 16
export const KEK_BYTES = 32
export const DEK_BYTES = 32

/**
 * ED-3's accepted bounds ON READ. A file outside them is refused BEFORE any derivation runs, which
 * is the point: the floor is OWASP's minimum so a downgraded file cannot ask this CLI to derive
 * something cheap, and the ceiling stops a hostile file from asking for gigabytes of working
 * memory before anyone has typed a passphrase.
 */
export const ARGON2_BOUNDS = {
  m: { min: 19_456, max: 1_048_576 },
  t: { min: 2, max: 16 },
  p: { min: 1, max: 4 },
  version: 19,
  saltBytes: { min: 16, max: 64 },
  outputBytes: 32,
} as const

export interface Argon2Params {
  name: "argon2id"
  version: number
  m: number
  t: number
  p: number
  /** base64url, 16 to 64 bytes. */
  salt: string
}

/** Refuses a KDF record outside ED-3's bounds. Runs before any derivation, never after. */
export function assertKdfInBounds(kdf: Argon2Params): void {
  const fail = (detail: string): never => {
    throw new VaultError(
      "VAULT_KDF_OUT_OF_BOUNDS",
      `The vault's KDF parameters are outside the accepted range: ${detail}`,
      {
        suggestion: "This file was not written by this CLI. Nothing was derived and nothing was written.",
      },
    )
  }
  if (kdf.name !== "argon2id") fail(`kdf.name is ${JSON.stringify(kdf.name)}, expected "argon2id"`)
  if (kdf.version !== ARGON2_BOUNDS.version) fail(`version ${kdf.version}, expected ${ARGON2_BOUNDS.version}`)
  for (const [key, bounds] of [
    ["m", ARGON2_BOUNDS.m],
    ["t", ARGON2_BOUNDS.t],
    ["p", ARGON2_BOUNDS.p],
  ] as const) {
    const value = kdf[key]
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      fail(`${key} is ${value}, accepted range ${bounds.min} to ${bounds.max}`)
    }
  }
  const salt = unb64u(kdf.salt, "kdf.salt")
  if (salt.length < ARGON2_BOUNDS.saltBytes.min || salt.length > ARGON2_BOUNDS.saltBytes.max) {
    fail(
      `salt is ${salt.length} bytes, accepted range ${ARGON2_BOUNDS.saltBytes.min} to ${ARGON2_BOUNDS.saltBytes.max}`,
    )
  }
}

export function freshArgon2Params(): Argon2Params {
  const salt = crypto.getRandomValues(new Uint8Array(ARGON2_SALT_BYTES))
  return { name: "argon2id", ...(testCostOverride ?? ARGON2_DEFAULTS), salt: b64u(salt) }
}

/**
 * A TEST-ONLY cost override for newly created vaults, and nothing else.
 *
 * ED-3's default costs about 1.6 seconds per derivation on a small VPS, which is the point of it.
 * A suite that creates and re-opens vaults dozens of times would spend minutes inside Argon2
 * proving something the vectors already prove, so the tests write vaults at the BOUNDS FLOOR
 * (`m = 19456`, `t = 2`, the OWASP minimum ED-3 accepts on read) and keep their assertions about
 * behaviour rather than about cost.
 *
 * Why a module-level seam rather than an environment variable or a flag: a variable or a flag is
 * reachable from a real invocation, and "weaken this vault's KDF" is the last thing that should be
 * reachable from one. The only writers of this are `*.test.ts` files and the test-support helper,
 * which `crypto.test.ts` asserts by grep, exactly as T39 asserts that nothing reads
 * `CANDLE_KEYSTORE_PASSPHRASE`'s value. It affects only what a NEW envelope records; reading an
 * existing vault always uses that vault's own recorded parameters.
 */
let testCostOverride: { version: number; m: number; t: number; p: number } | null = null

export function setTestKdfCost(cost: { version: number; m: number; t: number; p: number } | null): void {
  testCostOverride = cost
}

/**
 * The passphrase KEK. `notice` is written before the derivation starts because a silent second of
 * nothing reads as a hang (CC-02); it names the cost and never the passphrase or a derived byte.
 *
 * The returned buffer is the caller's to zero, and every caller does it through `withSecret`.
 */
export async function derivePassphraseKek(
  passphrase: string,
  kdf: Argon2Params,
  notice?: (line: string) => void,
): Promise<Uint8Array> {
  assertKdfInBounds(kdf)
  notice?.(`Deriving the vault key (Argon2id, ${Math.round(kdf.m / 1024)} MiB)\n`)
  const salt = unb64u(kdf.salt, "kdf.salt")
  // `argon2idAsync` yields to the event loop between passes, so the notice above actually reaches
  // the terminal before the CPU disappears for a second.
  const kek = await argon2idAsync(passphrase, salt, {
    t: kdf.t,
    m: kdf.m,
    p: kdf.p,
    version: kdf.version,
    dkLen: ARGON2_BOUNDS.outputBytes,
  })
  return ownSecret(kek)
}

// ── AES-256-GCM and HKDF (ED-4) ───────────────────────────────────────────────────────────────

export interface Blob {
  iv: string
  ciphertext: string
}

/** Imports 32 raw bytes as a non-extractable AES-GCM key. The bytes stay the caller's to zero. */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new VaultError("VAULT_UNREADABLE", `expected a 32-byte key, got ${raw.length}`)
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])
}

/**
 * ED-4's payload key: one HKDF-SHA-256 expansion of the DEK, salted with the vault id and labelled
 * for this format version, that encrypts the index, the root blob and every key blob. Returned as
 * a non-extractable `CryptoKey`, so the derived bytes never exist as a buffer this code could
 * leak; the raw DEK the caller passed in is still the caller's to zero.
 */
export async function derivePayloadKey(dek: Uint8Array, vaultId: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", dek as BufferSource, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: vaultId as BufferSource,
      info: new TextEncoder().encode("candle-vault/v2/payload"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Seals `plaintext` under `key` with `aad` as the associated data, always under a FRESH random IV.
 * Every write generates its own, so an IV is never reused under one key, which for GCM is not a
 * weakening but a break.
 */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    plaintext as BufferSource,
  )
  return { iv: b64u(iv), ciphertext: b64u(new Uint8Array(sealed)) }
}

/**
 * Opens a blob, mapping the tag failure to `code`. The caller chooses the code because the same
 * primitive failure means different things in different places: a wrong passphrase and a tampered
 * envelope are indistinguishable by design (`VAULT_UNLOCK_FAILED`), while an index, root or key
 * blob that fails its tag is `VAULT_BLOB_TAMPERED`.
 */
export async function open(
  key: CryptoKey,
  blob: Blob,
  aad: Uint8Array,
  failure: { code: "VAULT_UNLOCK_FAILED" | "VAULT_BLOB_TAMPERED"; message: string; suggestion?: string },
): Promise<Uint8Array> {
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64u(blob.iv, "iv") as BufferSource,
        additionalData: aad as BufferSource,
      },
      key,
      unb64u(blob.ciphertext, "ciphertext") as BufferSource,
    )
  } catch {
    throw new VaultError(failure.code, failure.message, { suggestion: failure.suggestion })
  }
  return ownSecret(new Uint8Array(plain))
}

/** Seals a JSON document canonically. Used for the index plaintext, which has no secrets in it. */
export async function sealJson(key: CryptoKey, value: unknown, aad: Uint8Array): Promise<Blob> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  try {
    return await seal(key, bytes, aad)
  } finally {
    wipe(bytes)
  }
}

export { canonicalBytes }
