/**
 * Ember Phase 2 (BE-135): the one piece of CBOR the CLI reads, an attestation object's
 * authenticator data, and the flags byte the domain rule depends on.
 */
import { describe, expect, test } from "bun:test"
import { attestationObjectAround, scriptedAuthData } from "../enclave-helper/test-backend"
import { authDataFlags, authDataFromAttestationObject } from "./webauthn-cbor"

describe("attestation objects", () => {
  test("the authenticator data comes back byte-equal from a fmt none object", () => {
    const authData = scriptedAuthData("cli.candle.tv", 0x5d, { credentialId: new Uint8Array(16).fill(7) })
    const object = attestationObjectAround(authData)
    expect(authDataFromAttestationObject(object)).toEqual(authData)
    // The object walks: text keys, an empty nested map, a byte string longer than 24 bytes.
    expect(object[0]).toBe(0xa3)
  })

  test("a truncated object, a non-map, a missing authData and an indefinite length are each refused", () => {
    const authData = scriptedAuthData("cli.candle.tv", 0x5d)
    const object = attestationObjectAround(authData)
    expect(() => authDataFromAttestationObject(object.slice(0, object.length - 5))).toThrow(/truncated/)
    expect(() => authDataFromAttestationObject(Uint8Array.from([0x80]))).toThrow(/not a CBOR map/)
    expect(() => authDataFromAttestationObject(Uint8Array.from([0xa1, 0x63, 0x66, 0x6d, 0x74, 0x60]))).toThrow(
      /no authenticator data/,
    )
    expect(() => authDataFromAttestationObject(Uint8Array.from([0xbf, 0xff]))).toThrow(/indefinite-length/)
    expect(() => authDataFromAttestationObject(Uint8Array.from([0xc0, 0x00]))).toThrow(/CBOR tag/)
  })

  test("integers, arrays and simple values inside attStmt are walked, not refused", () => {
    // fmt "packed" style attStmt: {alg: -7, x5c: [bytes], ok: true, n: null}, then authData.
    const authData = scriptedAuthData("cli.candle.tv", 0x1d)
    const bytes = [
      0xa3,
      0x63,
      0x66,
      0x6d,
      0x74,
      0x66,
      0x70,
      0x61,
      0x63,
      0x6b,
      0x65,
      0x64,
      0x67,
      0x61,
      0x74,
      0x74,
      0x53,
      0x74,
      0x6d,
      0x74,
      0xa4,
      0x63,
      0x61,
      0x6c,
      0x67,
      0x26,
      0x63,
      0x78,
      0x35,
      0x63,
      0x81,
      0x42,
      0x01,
      0x02,
      0x62,
      0x6f,
      0x6b,
      0xf5,
      0x61,
      0x6e,
      0xf6,
      0x68,
      0x61,
      0x75,
      0x74,
      0x68,
      0x44,
      0x61,
      0x74,
      0x61,
      0x58,
      authData.length,
      ...authData,
    ]
    expect(authDataFromAttestationObject(Uint8Array.from(bytes))).toEqual(authData)
  })
})

describe("the flags byte", () => {
  test("UP, UV, BE and BS are read from byte 32; a short buffer is refused", () => {
    expect(authDataFlags(scriptedAuthData("cli.candle.tv", 0x1d))).toEqual({
      userPresent: true,
      userVerified: true,
      backupEligible: true,
      backupState: true,
    })
    expect(authDataFlags(scriptedAuthData("cli.candle.tv", 0x01))).toEqual({
      userPresent: true,
      userVerified: false,
      backupEligible: false,
      backupState: false,
    })
    expect(() => authDataFlags(new Uint8Array(36))).toThrow(/truncated/)
  })
})
