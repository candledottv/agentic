/**
 * Ember Phase 2 (BE-141, ED-12): the ECIES construction the Secure Enclave factor rests on.
 *
 * What these prove: the packet has Apple's layout and sizes, the X9.63 KDF is the standard one,
 * a round trip through the reference decryptor recovers the plaintext, every tampered byte fails
 * the tag, and every secret buffer is zeroed. What they cannot prove: that Apple's decryptor in the
 * Enclave agrees with this encryptor. That is T48's first row, and it is stated there as the one
 * fact only a real Mac can establish.
 */
import { describe, expect, test } from "bun:test"
import { p256 } from "@noble/curves/p256"
import { sha256 } from "@noble/hashes/sha256"
import { hex } from "@scure/base"
import { eciesDecrypt, eciesEncrypt, P256_POINT_BYTES, pointFromSpki, spkiFromPoint, x963Kdf } from "./ecies"
import { trackSecrets } from "./hygiene"

describe("X9.63 KDF", () => {
  test("one block is SHA-256(Z || 00000001 || sharedInfo), truncated; the second block uses counter 2", () => {
    const z = hex.decode("96c05619d56c328ab95fe84b18264b08725b85e33fd34f08cfeb4c8a5ecc3b1a")
    const info = new TextEncoder().encode("candle")
    const block = (counter: number) => sha256(new Uint8Array([...z, 0, 0, 0, counter, ...info]))
    expect(hex.encode(x963Kdf(z, info, 16))).toBe(hex.encode(block(1).subarray(0, 16)))
    expect(hex.encode(x963Kdf(z, info, 48))).toBe(hex.encode(block(1)) + hex.encode(block(2).subarray(0, 16)))
  })

  test("is Hash(Z || counter || sharedInfo) concatenated, so 32 bytes is the first two counters' prefixes", () => {
    const z = new Uint8Array(32).map((_, i) => i)
    const info = new TextEncoder().encode("shared")
    const first = x963Kdf(z, info, 32)
    const longer = x963Kdf(z, info, 40)
    expect(hex.encode(longer.subarray(0, 32))).toBe(hex.encode(first))
    expect(hex.encode(x963Kdf(z, new TextEncoder().encode("other"), 32))).not.toBe(hex.encode(first))
  })
})

describe("Apple ECIES (cofactor, variable IV, X9.63 SHA-256, AES-GCM)", () => {
  const recipient = p256.utils.randomPrivateKey()
  const recipientPoint = p256.getPublicKey(recipient, false)

  test("the packet is the ephemeral public key, then the ciphertext, then a 16-byte tag", async () => {
    const ephemeral = p256.utils.randomPrivateKey()
    const plaintext = new Uint8Array(32).map((_, i) => 255 - i)
    const packet = await eciesEncrypt(recipientPoint, plaintext, ephemeral)
    expect(packet.length).toBe(P256_POINT_BYTES + 32 + 16)
    expect(hex.encode(packet.subarray(0, P256_POINT_BYTES))).toBe(hex.encode(p256.getPublicKey(ephemeral, false)))
    expect(packet[0]).toBe(0x04)
  })

  test("round-trips through the reference decryptor, and a fresh ephemeral key makes every packet distinct", async () => {
    const plaintext = new Uint8Array(32).map((_, i) => (i * 13) & 0xff)
    const a = await eciesEncrypt(recipientPoint, plaintext)
    const b = await eciesEncrypt(recipientPoint, plaintext)
    expect(hex.encode(a)).not.toBe(hex.encode(b))
    expect(hex.encode(await eciesDecrypt(recipient, a))).toBe(hex.encode(plaintext))
    expect(hex.encode(await eciesDecrypt(recipient, b))).toBe(hex.encode(plaintext))
  })

  test("every tampered byte fails the tag, and another key cannot open it", async () => {
    const plaintext = new Uint8Array(32).fill(7)
    const packet = await eciesEncrypt(recipientPoint, plaintext)
    for (const index of [P256_POINT_BYTES, P256_POINT_BYTES + 5, packet.length - 1]) {
      const tampered = packet.slice()
      tampered[index] = (tampered[index] ?? 0) ^ 0x01
      await expect(eciesDecrypt(recipient, tampered)).rejects.toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    }
    // A flipped byte inside the ephemeral point is either an invalid point or a different secret.
    const badPoint = packet.slice()
    badPoint[10] = (badPoint[10] ?? 0) ^ 0x01
    await expect(eciesDecrypt(recipient, badPoint)).rejects.toMatchObject({
      code: expect.stringMatching(/VAULT_UNLOCK_FAILED|VAULT_UNREADABLE/),
    })
    await expect(eciesDecrypt(p256.utils.randomPrivateKey(), packet)).rejects.toMatchObject({
      code: "VAULT_UNLOCK_FAILED",
    })
    await expect(eciesDecrypt(recipient, packet.subarray(0, 70))).rejects.toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
  })

  test("refuses a recipient key that is not an uncompressed P-256 point", async () => {
    await expect(eciesEncrypt(p256.getPublicKey(recipient, true), new Uint8Array(32))).rejects.toMatchObject({
      code: "VAULT_UNREADABLE",
    })
    const offCurve = recipientPoint.slice()
    offCurve[64] = (offCurve[64] ?? 0) ^ 0x01
    await expect(eciesEncrypt(offCurve, new Uint8Array(32))).rejects.toMatchObject({ code: "VAULT_UNREADABLE" })
  })

  test("every secret buffer the encrypt and decrypt allocate is zero afterwards (T36 seam)", async () => {
    const tracking = trackSecrets()
    const packet = await eciesEncrypt(recipientPoint, new Uint8Array(32).fill(9))
    const opened = await eciesDecrypt(recipient, packet)
    const buffers = tracking.stop()
    // The decrypted plaintext is the caller's to zero; everything else is already zero.
    expect(buffers.length).toBeGreaterThanOrEqual(6)
    for (const buffer of buffers) {
      if (buffer === opened) continue
      expect(buffer.every((byte) => byte === 0)).toBe(true)
    }
    expect(opened.every((byte) => byte === 9)).toBe(true)
  })
})

describe("SPKI", () => {
  test("wraps and unwraps an uncompressed P-256 point, and refuses anything else", () => {
    const point = p256.getPublicKey(p256.utils.randomPrivateKey(), false)
    const spki = spkiFromPoint(point)
    expect(spki.length).toBe(91)
    expect(hex.encode(spki.subarray(0, 26))).toBe("3059301306072a8648ce3d020106082a8648ce3d030107034200")
    expect(hex.encode(pointFromSpki(spki, "publicKey"))).toBe(hex.encode(point))
    expect(() => pointFromSpki(spki.subarray(1), "publicKey")).toThrow(/SubjectPublicKeyInfo/)
    const wrongOid = spki.slice()
    wrongOid[20] = 0x08
    expect(() => pointFromSpki(wrongOid, "publicKey")).toThrow(/SubjectPublicKeyInfo/)
  })
})
