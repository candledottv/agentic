/**
 * Ember Phase 4b (D1, Andrew 2026-09-25): the sealed EVM record's key pair and the one construction
 * that seals and opens a record line.
 *
 * The record key is an X25519 pair created by the write that creates the vault's first EVM TEE
 * wallet. The public half is the header's `evmRecordPublicKey`, so an append needs nothing but the
 * header and a trade leg can append while the vault is locked. The private half is the index's
 * `evmRecordKey` blob, sealed under the payload key, so only an unlocked vault can read a line.
 *
 * Kept apart from `evm-record.ts` because `store.ts` needs the key check at unlock, and the record
 * file machinery needs `store.ts`; this file needs neither.
 *
 * A line (D1, "Sealing"): a fresh ephemeral X25519 key per line; the shared secret is X25519(the
 * ephemeral secret, the record public key); HKDF-SHA256 with that secret as input keying material,
 * the salt `ephemeral public key ‖ record public key` (64 bytes) and the info label
 * `candle-vault/v4/evm-record`, 32 bytes out; AES-256-GCM under that key with a fixed 12-byte zero
 * nonce (each ephemeral key is single-use, so the AES key is single-use) and the header `vaultId`
 * string as associated data. The plaintext is the JSON entry padded with spaces to exactly 160
 * UTF-8 bytes, so every line on disk is the same length.
 */
import { x25519 } from "@noble/curves/ed25519"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha256"
import { type Blob, b64u, bytesEqual, open as openBlob, seal, unb64u } from "./crypto"
import { VaultError } from "./errors"
import { evmRecordKeyAad } from "./format"
import { wipe } from "./hygiene"

export const EVM_RECORD_KEY_BYTES = 32
/** Every entry is padded to exactly this many UTF-8 bytes before sealing (D1). */
export const EVM_RECORD_PLAINTEXT_BYTES = 160
export const EVM_RECORD_HKDF_INFO = "candle-vault/v4/evm-record"
/** The on-disk line format's own version, `{"v":1,...}`. */
export const EVM_RECORD_LINE_VERSION = 1

/** The two plaintext entries a record carries. */
export type EvmRecordEntry =
  | { kind: "token"; wallet: string; token: string }
  | { kind: "scanStart"; wallet: string; block: number }

export interface CreatedRecordKey {
  /** base64url, the header's `evmRecordPublicKey`. */
  publicKey: string
  /** The index's `evmRecordKey` blob. */
  blob: Blob
}

/** Generates the record key pair and seals the private half for the index. */
export async function createEvmRecordKey(payloadKey: CryptoKey, vaultId: string): Promise<CreatedRecordKey> {
  const secret = x25519.utils.randomPrivateKey()
  try {
    const publicKey = x25519.getPublicKey(secret)
    const blob = await seal(payloadKey, secret, evmRecordKeyAad(vaultId))
    return { publicKey: b64u(publicKey), blob }
  } finally {
    wipe(secret)
  }
}

/**
 * Opens the index's record key and checks it derives the header's public key (D1, "Record key
 * placement"). The caller owns the returned 32 bytes and zeroes them. A tag failure is
 * `VAULT_BLOB_TAMPERED`; a pair that does not match is `VAULT_INDEX_INVALID`, since the index
 * authenticated and yet disagrees with its own header.
 */
export async function openEvmRecordKey(
  payloadKey: CryptoKey,
  vaultId: string,
  blob: Blob,
  headerPublicKey: string,
): Promise<Uint8Array> {
  const secret = await openBlob(payloadKey, blob, evmRecordKeyAad(vaultId), {
    code: "VAULT_BLOB_TAMPERED",
    message: "The sealed EVM record's key failed its authentication tag.",
    suggestion: "Nothing was written. Restore the file from a verified backup.",
  })
  if (secret.length !== EVM_RECORD_KEY_BYTES) {
    wipe(secret)
    throw new VaultError("VAULT_INDEX_INVALID", "The sealed EVM record's key is the wrong length.")
  }
  const derived = x25519.getPublicKey(secret)
  if (!bytesEqual(derived, unb64u(headerPublicKey, "evmRecordPublicKey"))) {
    wipe(secret)
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      "The sealed EVM record's key does not derive the header's evmRecordPublicKey; the pair was altered.",
      { suggestion: "Nothing was written. Restore the file from a verified backup." },
    )
  }
  return secret
}

/** The canonical plaintext JSON of an entry: fixed key order, no whitespace. */
export function entryJson(entry: EvmRecordEntry): string {
  return entry.kind === "token"
    ? JSON.stringify({ kind: "token", wallet: entry.wallet, token: entry.token })
    : JSON.stringify({ kind: "scanStart", wallet: entry.wallet, block: entry.block })
}

/**
 * The entry padded to exactly `EVM_RECORD_PLAINTEXT_BYTES`, or `undefined` when its JSON is longer:
 * an entry is never truncated and never written unpadded (D1).
 */
export function paddedEntry(entry: EvmRecordEntry): Uint8Array | undefined {
  const json = new TextEncoder().encode(entryJson(entry))
  if (json.length > EVM_RECORD_PLAINTEXT_BYTES) return undefined
  const out = new Uint8Array(EVM_RECORD_PLAINTEXT_BYTES).fill(0x20)
  out.set(json, 0)
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

async function lineKey(shared: Uint8Array, epk: Uint8Array, rpk: Uint8Array): Promise<CryptoKey> {
  const okm = hkdf(sha256, shared, concat(epk, rpk), new TextEncoder().encode(EVM_RECORD_HKDF_INFO), 32)
  try {
    return await crypto.subtle.importKey("raw", okm as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
  } finally {
    wipe(okm)
  }
}

const ZERO_NONCE = new Uint8Array(12)

/**
 * Seals one entry into one on-disk line, newline included. Throws `EVM_RECORD_ENTRY_TOO_LONG` for
 * an entry over 160 bytes; the append path turns that into a skipped append with a notice.
 */
export async function sealEvmRecordLine(
  entry: EvmRecordEntry,
  recordPublicKey: string,
  vaultId: string,
): Promise<string> {
  const plaintext = paddedEntry(entry)
  if (plaintext === undefined) {
    throw new VaultError(
      "EVM_RECORD_ENTRY_TOO_LONG",
      `A sealed EVM record entry is at most ${EVM_RECORD_PLAINTEXT_BYTES} bytes; this one is longer and was not written.`,
    )
  }
  const rpk = unb64u(recordPublicKey, "evmRecordPublicKey")
  const esk = x25519.utils.randomPrivateKey()
  try {
    const epk = x25519.getPublicKey(esk)
    const shared = x25519.getSharedSecret(esk, rpk)
    try {
      const key = await lineKey(shared, epk, rpk)
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: ZERO_NONCE, additionalData: new TextEncoder().encode(vaultId) },
          key,
          plaintext as BufferSource,
        ),
      )
      return `${JSON.stringify({ v: EVM_RECORD_LINE_VERSION, epk: b64u(epk), ct: b64u(ct) })}\n`
    } finally {
      wipe(shared)
    }
  } finally {
    wipe(esk)
  }
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
}

/**
 * Opens one complete line (no newline). Returns `undefined` for anything that does not decrypt
 * under this record key and this `vaultId`, or that decrypts to something that is not an entry: a
 * torn line, a line from an earlier vault, a damaged line. Never throws.
 */
export async function openEvmRecordLine(
  line: string,
  recordSecret: Uint8Array,
  recordPublicKey: string,
  vaultId: string,
): Promise<EvmRecordEntry | undefined> {
  try {
    const parsed = JSON.parse(line) as { v?: unknown; epk?: unknown; ct?: unknown }
    if (parsed.v !== EVM_RECORD_LINE_VERSION || typeof parsed.epk !== "string" || typeof parsed.ct !== "string") {
      return undefined
    }
    const epk = unb64u(parsed.epk, "epk")
    const rpk = unb64u(recordPublicKey, "evmRecordPublicKey")
    const shared = x25519.getSharedSecret(recordSecret, epk)
    let plaintext: Uint8Array
    try {
      const key = await lineKey(shared, epk, rpk)
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: ZERO_NONCE, additionalData: new TextEncoder().encode(vaultId) },
          key,
          unb64u(parsed.ct, "ct") as BufferSource,
        ),
      )
    } finally {
      wipe(shared)
    }
    if (plaintext.length !== EVM_RECORD_PLAINTEXT_BYTES) return undefined
    const value = JSON.parse(new TextDecoder().decode(plaintext).trimEnd()) as Record<string, unknown>
    if (value.kind === "token" && isAddress(value.wallet) && isAddress(value.token)) {
      return { kind: "token", wallet: value.wallet, token: value.token }
    }
    if (
      value.kind === "scanStart" &&
      isAddress(value.wallet) &&
      Number.isSafeInteger(value.block) &&
      (value.block as number) >= 0
    ) {
      return { kind: "scanStart", wallet: value.wallet, block: value.block as number }
    }
    return undefined
  } catch {
    return undefined
  }
}
