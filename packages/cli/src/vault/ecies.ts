/**
 * Ember Phase 2 (BE-141, ED-12, CC-01): Apple's ECIES, as the CLI performs it.
 *
 * The Secure Enclave factor wraps a random 32-byte intermediate KEK to the Enclave key's public
 * key, and only the Enclave can unwrap it (`SecKeyCreateDecryptedData` with
 * `eciesEncryptionCofactorVariableIVX963SHA256AESGCM`, in the signed helper). The CLI does the
 * wrapping side here, so this module has to produce exactly the packet Apple's Security framework
 * decrypts. The construction, read from Apple's open-source `SecKeyAdaptors.m` and the `SecKey.h`
 * header comment (apple-oss-distributions/Security), is:
 *
 *   1. An ephemeral P-256 key pair per encryption.
 *   2. ECDH between the ephemeral private key and the recipient's public key; the shared secret Z
 *      is the x coordinate of the result (32 bytes). "Cofactor" and "standard" ECDH coincide on
 *      P-256, whose cofactor is 1.
 *   3. ANSI X9.63 KDF with SHA-256 over Z, with the ephemeral public key (X9.63 uncompressed, 65
 *      bytes) as the shared info, producing 32 bytes: "AES key size is 128bit for EC keys <=256bit",
 *      and for the VariableIV variants "AES key is first half of KDF output and 16 byte long IV is
 *      second half of KDF output".
 *   4. AES-128-GCM over the plaintext with that key and that 16-byte IV, no associated data, a
 *      16-byte tag.
 *   5. The packet is the ephemeral public key, then the ciphertext, then the tag.
 *
 * `eciesDecrypt` is the same construction run backwards. Production never calls it (the private
 * key lives in the Enclave and never exists as bytes anywhere), but the scripted helper the tests
 * spawn does, so every test that adds and unlocks with this factor round-trips the real packet
 * format. Whether Apple's decryptor agrees with this encryptor on a real Mac is T48's row, and it
 * is the one fact no test on a Linux host can establish.
 */
import { p256 } from "@noble/curves/p256"
import { sha256 } from "@noble/hashes/sha256"
import { VaultError } from "./errors"
import { ownSecret, wipe } from "./hygiene"

/** CC-01's `kek.alg` for the `secure-enclave` row. */
export const ECIES_KEK_ALG = "ECIES-P256-SHA256-AESGCM" as const
/** X9.63 uncompressed point: 0x04, x, y. */
export const P256_POINT_BYTES = 65
const AES_KEY_BYTES = 16
const IV_BYTES = 16
const TAG_BYTES = 16

/**
 * The DER prefix of a SubjectPublicKeyInfo for an uncompressed P-256 point: SEQUENCE { SEQUENCE {
 * id-ecPublicKey, prime256v1 }, BIT STRING (0 unused bits) <65-byte point> }. The envelope stores
 * the SPKI form (CC-01 says "P-256 SPKI"); the helper speaks the raw point Apple's
 * `SecKeyCopyExternalRepresentation` produces.
 */
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
])

/** Refuses anything that is not a valid uncompressed P-256 point, before it is used for anything. */
export function assertP256Point(point: Uint8Array, field: string): void {
  if (point.length !== P256_POINT_BYTES || point[0] !== 0x04) {
    throw new VaultError(
      "VAULT_UNREADABLE",
      `${field} is not an uncompressed P-256 point (${point.length} bytes, leading 0x${(point[0] ?? 0).toString(16)}).`,
    )
  }
  try {
    p256.ProjectivePoint.fromHex(point).assertValidity()
  } catch {
    throw new VaultError("VAULT_UNREADABLE", `${field} is not a point on P-256.`)
  }
}

export function spkiFromPoint(point: Uint8Array): Uint8Array {
  assertP256Point(point, "publicKey")
  const out = new Uint8Array(P256_SPKI_PREFIX.length + point.length)
  out.set(P256_SPKI_PREFIX, 0)
  out.set(point, P256_SPKI_PREFIX.length)
  return out
}

export function pointFromSpki(spki: Uint8Array, field: string): Uint8Array {
  if (spki.length !== P256_SPKI_PREFIX.length + P256_POINT_BYTES) {
    throw new VaultError("VAULT_UNREADABLE", `${field} is not a P-256 SubjectPublicKeyInfo (${spki.length} bytes).`)
  }
  for (let i = 0; i < P256_SPKI_PREFIX.length; i++) {
    if (spki[i] !== P256_SPKI_PREFIX[i]) {
      throw new VaultError("VAULT_UNREADABLE", `${field} is not a P-256 SubjectPublicKeyInfo.`)
    }
  }
  const point = spki.slice(P256_SPKI_PREFIX.length)
  assertP256Point(point, field)
  return point
}

/**
 * ANSI X9.63 KDF: `Hash(Z || counter || sharedInfo)` for counter = 1, 2, ... (4-byte big-endian),
 * concatenated and truncated to `length`. This is what `ccansikdf_x963` computes.
 */
export function x963Kdf(secret: Uint8Array, sharedInfo: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let written = 0
  let counter = 1
  const block = new Uint8Array(secret.length + 4 + sharedInfo.length)
  block.set(secret, 0)
  block.set(sharedInfo, secret.length + 4)
  while (written < length) {
    block[secret.length] = (counter >>> 24) & 0xff
    block[secret.length + 1] = (counter >>> 16) & 0xff
    block[secret.length + 2] = (counter >>> 8) & 0xff
    block[secret.length + 3] = counter & 0xff
    const digest = sha256(block)
    const take = Math.min(digest.length, length - written)
    out.set(digest.subarray(0, take), written)
    written += take
    counter += 1
    wipe(digest)
  }
  wipe(block)
  return out
}

async function aesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 128 }, false, [
    "encrypt",
    "decrypt",
  ])
}

/**
 * The key and IV for one ECIES packet, from the shared secret and the ephemeral public key. The
 * returned buffers are secrets; the caller zeroes them.
 */
function deriveKeyAndIv(z: Uint8Array, ephemeralPoint: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
  const material = x963Kdf(z, ephemeralPoint, AES_KEY_BYTES + IV_BYTES)
  const key = ownSecret(material.slice(0, AES_KEY_BYTES))
  const iv = material.slice(AES_KEY_BYTES)
  wipe(material)
  return { key, iv }
}

/**
 * Encrypts `plaintext` to the P-256 public key `recipientPoint` (X9.63 uncompressed) as Apple's
 * `SecKeyCreateEncryptedData` would. `ephemeralPrivateKey` is a test seam for a deterministic
 * packet; production leaves it undefined and a fresh one is drawn per call.
 */
export async function eciesEncrypt(
  recipientPoint: Uint8Array,
  plaintext: Uint8Array,
  ephemeralPrivateKey?: Uint8Array,
): Promise<Uint8Array> {
  assertP256Point(recipientPoint, "publicKey")
  // A copy of the caller's seam key, so zeroing here never reaches into a test's buffer.
  const ephemeral = ownSecret(ephemeralPrivateKey ? ephemeralPrivateKey.slice() : p256.utils.randomPrivateKey())
  let z: Uint8Array | undefined
  let key: Uint8Array | undefined
  let iv: Uint8Array | undefined
  try {
    const ephemeralPoint = p256.getPublicKey(ephemeral, false)
    z = ownSecret(p256.getSharedSecret(ephemeral, recipientPoint, false).slice(1, 33))
    ;({ key, iv } = deriveKeyAndIv(z, ephemeralPoint))
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, tagLength: TAG_BYTES * 8 },
        await aesGcmKey(key),
        plaintext as BufferSource,
      ),
    )
    const packet = new Uint8Array(ephemeralPoint.length + sealed.length)
    packet.set(ephemeralPoint, 0)
    packet.set(sealed, ephemeralPoint.length)
    return packet
  } finally {
    wipe(ephemeral, z, key, iv)
  }
}

/**
 * The inverse, for the scripted helper and for the appendix's "opening a vault without this CLI"
 * reader. Returns the plaintext as a tracked secret the caller zeroes.
 */
export async function eciesDecrypt(privateKey: Uint8Array, packet: Uint8Array): Promise<Uint8Array> {
  if (packet.length < P256_POINT_BYTES + TAG_BYTES) {
    throw new VaultError("VAULT_UNLOCK_FAILED", `The ECIES packet is too short (${packet.length} bytes).`)
  }
  const ephemeralPoint = packet.slice(0, P256_POINT_BYTES)
  assertP256Point(ephemeralPoint, "ephemeral public key")
  let z: Uint8Array | undefined
  let key: Uint8Array | undefined
  let iv: Uint8Array | undefined
  try {
    z = ownSecret(p256.getSharedSecret(privateKey, ephemeralPoint, false).slice(1, 33))
    ;({ key, iv } = deriveKeyAndIv(z, ephemeralPoint))
    const opened = await crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, tagLength: TAG_BYTES * 8 },
        await aesGcmKey(key),
        packet.subarray(P256_POINT_BYTES) as BufferSource,
      )
      .catch(() => {
        throw new VaultError("VAULT_UNLOCK_FAILED", "The ECIES packet failed its tag: wrong key, or a corrupt packet.")
      })
    return ownSecret(new Uint8Array(opened))
  } finally {
    wipe(z, key, iv)
  }
}
