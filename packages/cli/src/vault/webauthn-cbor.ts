/**
 * Ember Phase 2 (BE-135, CC-03's platform passkey bullet): the one piece of CBOR the CLI reads.
 *
 * A WebAuthn registration answers an attestation object, a CBOR map `{fmt, attStmt, authData}`;
 * the platform passkey helper hands that object back verbatim and the CLI takes the authenticator
 * data out of it itself, because the flags in there (user verified, backup eligible, backup state)
 * are what decide the envelope's domain and whether the credential is one this factor records at
 * all, and the side that decides must be the side that reads the bytes. Nothing else in the vault
 * speaks CBOR, so this is a decoder for exactly the subset an attestation object can hold
 * (definite-length maps, arrays, byte and text strings, integers, and the three simple values),
 * refusing anything else rather than guessing.
 */
import { VaultError } from "./errors"

type CborValue = number | bigint | Uint8Array | string | CborValue[] | Map<CborValue, CborValue> | boolean | null

class Reader {
  private offset = 0
  constructor(private readonly bytes: Uint8Array) {}

  private need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new VaultError(
        "VAULT_UNLOCK_FAILED",
        "The registration's attestation object is truncated; nothing was written.",
      )
    }
  }

  private byte(): number {
    this.need(1)
    return this.bytes[this.offset++] as number
  }

  private uint(size: number): number {
    this.need(size)
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + (this.bytes[this.offset++] as number)
    return value
  }

  private argument(additional: number): number {
    if (additional < 24) return additional
    if (additional === 24) return this.uint(1)
    if (additional === 25) return this.uint(2)
    if (additional === 26) return this.uint(4)
    if (additional === 27) return this.uint(8)
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      "The registration's attestation object uses an indefinite-length or reserved CBOR item; nothing was written.",
    )
  }

  private slice(length: number): Uint8Array {
    this.need(length)
    const out = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  value(depth = 0): CborValue {
    if (depth > 16) {
      throw new VaultError(
        "VAULT_UNLOCK_FAILED",
        "The registration's attestation object nests too deeply; nothing was written.",
      )
    }
    const initial = this.byte()
    const major = initial >> 5
    const additional = initial & 0x1f
    switch (major) {
      case 0:
        return this.argument(additional)
      case 1:
        return -1 - this.argument(additional)
      case 2:
        return this.slice(this.argument(additional))
      case 3:
        return new TextDecoder("utf-8", { fatal: true }).decode(this.slice(this.argument(additional)))
      case 4: {
        const length = this.argument(additional)
        const items: CborValue[] = []
        for (let i = 0; i < length; i++) items.push(this.value(depth + 1))
        return items
      }
      case 5: {
        const length = this.argument(additional)
        const map = new Map<CborValue, CborValue>()
        for (let i = 0; i < length; i++) {
          const key = this.value(depth + 1)
          map.set(key, this.value(depth + 1))
        }
        return map
      }
      case 7:
        if (additional === 20) return false
        if (additional === 21) return true
        if (additional === 22) return null
        throw new VaultError(
          "VAULT_UNLOCK_FAILED",
          "The registration's attestation object holds a CBOR simple value this CLI does not read; nothing was written.",
        )
      default:
        throw new VaultError(
          "VAULT_UNLOCK_FAILED",
          "The registration's attestation object holds a CBOR tag this CLI does not read; nothing was written.",
        )
    }
  }

  get done(): boolean {
    return this.offset === this.bytes.length
  }
}

/** The authenticator data inside a WebAuthn attestation object. */
export function authDataFromAttestationObject(attestationObject: Uint8Array): Uint8Array {
  const reader = new Reader(attestationObject)
  const value = reader.value()
  if (!(value instanceof Map)) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      "The registration's attestation object is not a CBOR map; nothing was written.",
    )
  }
  const authData = value.get("authData")
  if (!(authData instanceof Uint8Array)) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      "The registration's attestation object carries no authenticator data; nothing was written.",
    )
  }
  return authData
}

// ── The flags byte (WebAuthn Level 3, authenticator data) ─────────────────────────────────────

export const AUTHDATA_FLAG_UP = 0x01
export const AUTHDATA_FLAG_UV_BIT = 0x04
export const AUTHDATA_FLAG_BE = 0x08
export const AUTHDATA_FLAG_BS = 0x10
export const AUTHDATA_FLAG_AT = 0x40

export interface AuthDataFlags {
  userPresent: boolean
  userVerified: boolean
  backupEligible: boolean
  backupState: boolean
}

/** The four flags the vault reads, from byte 32 of the authenticator data. */
export function authDataFlags(authData: Uint8Array): AuthDataFlags {
  if (authData.length < 37) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "The authenticator data is truncated; nothing was derived.")
  }
  const flags = authData[32] as number
  return {
    userPresent: (flags & AUTHDATA_FLAG_UP) !== 0,
    userVerified: (flags & AUTHDATA_FLAG_UV_BIT) !== 0,
    backupEligible: (flags & AUTHDATA_FLAG_BE) !== 0,
    backupState: (flags & AUTHDATA_FLAG_BS) !== 0,
  }
}
