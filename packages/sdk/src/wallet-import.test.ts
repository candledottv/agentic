/**
 * wallet-import: chain-aware decode-before-seal correctness (the regression this file exists to
 * pin down -- HPKE must seal the wallet's chain-DECODED raw private-key bytes, never the input
 * string's own UTF-8 text, see wallet-import.ts's module doc), an HPKE round-trip against a
 * test-local receiver keypair (no network, no Privy), a real-keypair check for
 * `generateSignerKeypair`, and `CandleClient.importWallet`'s call sequence against an injected
 * fake fetch (init then submit, correct bodies, plaintext never on the wire). Mirrors
 * client.test.ts's fakeFetch pattern rather than importing it, since that helper is not
 * exported.
 */

import { describe, expect, test } from "bun:test"
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305"
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core"
import { base58 } from "@scure/base"
import { CandleClient } from "./client"
import { encryptWalletKeyForImport, generateSignerKeypair, parseSolanaSecret } from "./wallet-import"

/** Same HPKE parameters as wallet-import.ts, built independently so the test proves interop, not tautology. */
function testSuite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() })
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, "base64")
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Fresh test-local HPKE receiver keypair plus its public key already in the wire format `encryptionPublicKey` uses. */
async function generateReceiver(suite: CipherSuite) {
  const receiver = await suite.kem.generateKeyPair()
  const encryptionPublicKey = Buffer.from(await suite.kem.serializePublicKey(receiver.publicKey)).toString("base64")
  return { receiver, encryptionPublicKey }
}

/** Decrypts a base64 ciphertext/encapsulatedKey pair under a test receiver's private key, returning the raw plaintext bytes. */
async function decryptWith(
  suite: CipherSuite,
  receiverPrivateKey: CryptoKey,
  ciphertext: string,
  encapsulatedKey: string,
): Promise<Uint8Array> {
  const recipient = await suite.createRecipientContext({
    recipientKey: receiverPrivateKey,
    enc: base64ToArrayBuffer(encapsulatedKey),
  })
  return new Uint8Array(await recipient.open(base64ToArrayBuffer(ciphertext)))
}

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/

const EVM_RAW_KEY = new Uint8Array([
  0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
  27, 28,
])
const EVM_HEX_KEY = `0x${Buffer.from(EVM_RAW_KEY).toString("hex")}`

const SOLANA_RAW_KEY = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 255, 254, 253, 252, 251, 250, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
  111, 112, 113, 114, 115,
])
const SOLANA_BASE58_KEY = base58.encode(SOLANA_RAW_KEY)

// A real Solana secret key is 64 bytes (unlike the 32-byte fixture above, which is fine for the
// generic base58-decode tests but not representative of an actual id.json keyfile's length).
const SOLANA_64_BYTE_KEY = new Uint8Array(64).map((_, i) => (i * 7 + 3) % 256)
const SOLANA_64_BYTE_BASE58 = base58.encode(SOLANA_64_BYTE_KEY)
const SOLANA_64_BYTE_ARRAY_JSON = JSON.stringify(Array.from(SOLANA_64_BYTE_KEY))

describe("parseSolanaSecret", () => {
  test("accepts a known base58 secret and returns its bytes", () => {
    expect(parseSolanaSecret(SOLANA_64_BYTE_BASE58)).toEqual(SOLANA_64_BYTE_KEY)
  })

  // Keyfile ergonomics: a base58 secret copied from a file (e.g. via `cat`) commonly carries a
  // trailing newline. The decode must trim before base58-decoding, not just before the `[`
  // format check, or this extremely common paste artifact fails to decode.
  test("accepts a base58 secret with a trailing newline and returns the same bytes as without it", () => {
    expect(parseSolanaSecret(`${SOLANA_64_BYTE_BASE58}\n`)).toEqual(SOLANA_64_BYTE_KEY)
  })

  test("accepts the same key expressed as a JSON id.json byte array and returns identical bytes", () => {
    expect(parseSolanaSecret(SOLANA_64_BYTE_ARRAY_JSON)).toEqual(SOLANA_64_BYTE_KEY)
  })

  test("rejects a 63-int array with the keyfile-specific message", () => {
    const shortArray = JSON.stringify(Array.from(SOLANA_64_BYTE_KEY.slice(0, 63)))
    expect(() => parseSolanaSecret(shortArray)).toThrow(
      "This looks like a Solana keyfile (id.json) but is not a 64-byte array. Pass the file's contents, e.g. [12,34,...].",
    )
  })

  test("rejects a non-base58, non-array string with the base58-or-id.json message", () => {
    expect(() => parseSolanaSecret("0OIl-not-base58!!")).toThrow(
      "Invalid Solana private key: expected a base58 string or an id.json byte array.",
    )
  })

  test("rejects an array containing a value greater than 255", () => {
    const outOfRange = Array.from(SOLANA_64_BYTE_KEY)
    outOfRange[0] = 256
    expect(() => parseSolanaSecret(JSON.stringify(outOfRange))).toThrow(
      "This looks like a Solana keyfile (id.json) but is not a 64-byte array. Pass the file's contents, e.g. [12,34,...].",
    )
  })
})

describe("encryptWalletKeyForImport: chain-aware decode before seal (regression)", () => {
  test("evm: seals the hex-decoded raw bytes, not the hex string's own UTF-8 text", async () => {
    const suite = testSuite()
    const { receiver, encryptionPublicKey } = await generateReceiver(suite)

    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: "evm",
      privateKey: EVM_HEX_KEY,
      encryptionPublicKey,
    })

    const decrypted = await decryptWith(suite, receiver.privateKey, ciphertext, encapsulatedKey)
    expect(decrypted).toEqual(EVM_RAW_KEY)
    // The bug this guards against: sealing `new TextEncoder().encode(EVM_HEX_KEY)` would decrypt
    // to the hex STRING's own bytes (66 bytes for this fixture), not these 32 raw key bytes.
    expect(decrypted).not.toEqual(new TextEncoder().encode(EVM_HEX_KEY))
  })

  test("evm: a key without a 0x prefix decodes to the identical raw bytes", async () => {
    const suite = testSuite()
    const { receiver, encryptionPublicKey } = await generateReceiver(suite)
    const unprefixed = EVM_HEX_KEY.slice(2)

    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: "evm",
      privateKey: unprefixed,
      encryptionPublicKey,
    })

    const decrypted = await decryptWith(suite, receiver.privateKey, ciphertext, encapsulatedKey)
    expect(decrypted).toEqual(EVM_RAW_KEY)
  })

  test("evm: rejects a malformed hex string instead of silently sealing wrong bytes", async () => {
    await expect(
      encryptWalletKeyForImport({ chain: "evm", privateKey: "0xnot-hex", encryptionPublicKey: "irrelevant" }),
    ).rejects.toThrow(/hex/i)
  })

  test("solana: seals the base58-decoded raw bytes, not the base58 string's own UTF-8 text", async () => {
    const suite = testSuite()
    const { receiver, encryptionPublicKey } = await generateReceiver(suite)

    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: "solana",
      privateKey: SOLANA_BASE58_KEY,
      encryptionPublicKey,
    })

    const decrypted = await decryptWith(suite, receiver.privateKey, ciphertext, encapsulatedKey)
    expect(decrypted).toEqual(SOLANA_RAW_KEY)
    expect(decrypted).not.toEqual(new TextEncoder().encode(SOLANA_BASE58_KEY))
  })

  test("solana: rejects a malformed base58 string instead of silently sealing wrong bytes", async () => {
    await expect(
      encryptWalletKeyForImport({
        chain: "solana",
        privateKey: "0OIl-not-base58!!",
        encryptionPublicKey: "irrelevant",
      }),
    ).rejects.toThrow(/base58/i)
  })
})

describe("encryptWalletKeyForImport", () => {
  test("round-trips through a test-local HPKE receiver keypair", async () => {
    const suite = testSuite()
    const { receiver, encryptionPublicKey } = await generateReceiver(suite)

    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: "evm",
      privateKey: EVM_HEX_KEY,
      encryptionPublicKey,
    })

    expect(ciphertext).toMatch(BASE64_RE)
    expect(encapsulatedKey).toMatch(BASE64_RE)

    const decrypted = await decryptWith(suite, receiver.privateKey, ciphertext, encapsulatedKey)
    expect(decrypted).toEqual(EVM_RAW_KEY)
  })

  test("a decrypt attempt under the WRONG receiver key fails", async () => {
    const suite = testSuite()
    const { encryptionPublicKey } = await generateReceiver(suite)
    const { receiver: wrongReceiver } = await generateReceiver(suite)

    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: "solana",
      privateKey: SOLANA_BASE58_KEY,
      encryptionPublicKey,
    })

    await expect(decryptWith(suite, wrongReceiver.privateKey, ciphertext, encapsulatedKey)).rejects.toThrow()
  })

  test("produces a fresh ciphertext and encapsulated key on every call (ephemeral sender)", async () => {
    const suite = testSuite()
    const { encryptionPublicKey } = await generateReceiver(suite)
    const first = await encryptWalletKeyForImport({
      chain: "solana",
      privateKey: SOLANA_BASE58_KEY,
      encryptionPublicKey,
    })
    const second = await encryptWalletKeyForImport({
      chain: "solana",
      privateKey: SOLANA_BASE58_KEY,
      encryptionPublicKey,
    })
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.encapsulatedKey).not.toBe(second.encapsulatedKey)
  })
})

describe("generateSignerKeypair", () => {
  test("returns a PEM private key and DER-base64 public key that are a real, matching P-256 pair", async () => {
    const { privateKeyPem, publicKeyDerBase64 } = await generateSignerKeypair()

    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/)
    expect(publicKeyDerBase64).toMatch(BASE64_RE)

    const publicKey = await crypto.subtle.importKey(
      "spki",
      base64ToArrayBuffer(publicKeyDerBase64),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    )
    const pemBody = privateKeyPem
      .replace("-----BEGIN PRIVATE KEY-----\n", "")
      .replace("-----END PRIVATE KEY-----\n", "")
      .replace(/\n/g, "")
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      base64ToArrayBuffer(pemBody),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    )

    const message = new TextEncoder().encode("candle wallet import signer keypair")
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message)
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, message)
    expect(valid).toBe(true)
  })

  test("generates a distinct keypair on every call", async () => {
    const a = await generateSignerKeypair()
    const b = await generateSignerKeypair()
    expect(a.publicKeyDerBase64).not.toBe(b.publicKeyDerBase64)
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem)
  })
})

describe("CandleClient.importWallet", () => {
  interface RecordedRequest {
    url: string
    method: string
    headers: Record<string, string>
    body?: unknown
  }

  function fakeFetch(responses: Response[]) {
    const calls: RecordedRequest[] = []
    const queue = [...responses]
    const impl = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        ...(init?.body !== undefined && init?.body !== null ? { body: init.body } : {}),
      })
      const next = queue.shift()
      if (!next) throw new Error("fake fetch: no response queued")
      return next
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  const JSON_HEADERS = { "content-type": "application/json", "x-api-key": "cndl_test_key" }

  test("calls init then submit, encrypting locally in between, with correct request bodies", async () => {
    const suite = testSuite()
    const { receiver, encryptionPublicKey } = await generateReceiver(suite)

    const { calls, impl } = fakeFetch([
      json(200, { success: true, encryptionPublicKey }),
      json(200, { success: true, id: "link_1", address: "0xAbC123", chain: "evm", privyWalletId: "wallet_1" }),
    ])
    const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "cndl_test_key", fetch: impl })
    const signer = await generateSignerKeypair()

    const result = await client.importWallet({
      chain: "evm",
      address: "0xAbC123",
      privateKey: EVM_HEX_KEY,
      signerPublicKey: signer.publicKeyDerBase64,
      label: "trading wallet",
    })

    expect(calls.length).toBe(2)
    expect(calls[0]).toEqual({
      url: "https://api.test/api/v1/agent/wallets/import/init",
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ chain: "evm", address: "0xAbC123" }),
    })

    expect(calls[1]?.url).toBe("https://api.test/api/v1/agent/wallets/import/submit")
    expect(calls[1]?.method).toBe("POST")
    expect(calls[1]?.headers).toEqual(JSON_HEADERS)
    const submitBody = JSON.parse(String(calls[1]?.body)) as Record<string, unknown>
    expect(submitBody.chain).toBe("evm")
    expect(submitBody.address).toBe("0xAbC123")
    expect(submitBody.label).toBe("trading wallet")
    expect(submitBody.signerPublicKey).toBe(signer.publicKeyDerBase64)
    expect(typeof submitBody.ciphertext).toBe("string")
    expect(typeof submitBody.encapsulatedKey).toBe("string")
    // Neither the plaintext key nor the signer's private half ever appear in the request body.
    const serialized = String(calls[1]?.body)
    expect(serialized).not.toContain(EVM_HEX_KEY)
    expect(serialized).not.toContain(signer.privateKeyPem)

    // The submitted ciphertext decrypts to the chain-DECODED raw bytes -- not the hex string, and
    // not that string's UTF-8 encoding -- the exact distinction the Critical fix restores.
    const decrypted = await decryptWith(
      suite,
      receiver.privateKey,
      submitBody.ciphertext as string,
      submitBody.encapsulatedKey as string,
    )
    expect(decrypted).toEqual(EVM_RAW_KEY)

    expect(result).toEqual({
      success: true,
      id: "link_1",
      address: "0xAbC123",
      chain: "evm",
      privyWalletId: "wallet_1",
    })
  })

  test("omits label from the submit body when not provided", async () => {
    const suite = testSuite()
    const { encryptionPublicKey } = await generateReceiver(suite)
    const { calls, impl } = fakeFetch([
      json(200, { success: true, encryptionPublicKey }),
      json(200, { success: true, id: "link_2", address: "SolAddr111", chain: "solana", privyWalletId: "wallet_2" }),
    ])
    const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "cndl_test_key", fetch: impl })

    await client.importWallet({
      chain: "solana",
      address: "SolAddr111",
      privateKey: SOLANA_BASE58_KEY,
      signerPublicKey: "irrelevant-for-this-test",
    })

    const submitBody = JSON.parse(String(calls[1]?.body)) as Record<string, unknown>
    expect("label" in submitBody).toBe(false)
  })

  // ── Per-key only (2026-08-23): the account scopes and their import-time seeding are retired ──

  test("never sends an initialLinkedLimits field (the seeding mechanism is retired)", async () => {
    const suite = testSuite()
    const { encryptionPublicKey } = await generateReceiver(suite)
    const { calls, impl } = fakeFetch([
      json(200, { success: true, encryptionPublicKey }),
      json(200, { success: true, id: "link_4", address: "SolAddr333", chain: "solana", privyWalletId: "wallet_4" }),
    ])
    const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "cndl_test_key", fetch: impl })

    await client.importWallet({
      chain: "solana",
      address: "SolAddr333",
      privateKey: SOLANA_BASE58_KEY,
      signerPublicKey: "irrelevant-for-this-test",
    })

    const submitBody = JSON.parse(String(calls[1]?.body)) as Record<string, unknown>
    expect("initialLinkedLimits" in submitBody).toBe(false)
  })

  test("requires an apiKey before any fetch", async () => {
    const { calls, impl } = fakeFetch([])
    const client = new CandleClient({ apiUrl: "https://api.test", fetch: impl })
    await expect(
      client.importWallet({
        chain: "solana",
        address: "SolAddr111",
        privateKey: SOLANA_BASE58_KEY,
        signerPublicKey: "y",
      }),
    ).rejects.toThrow(/apiKey/)
    expect(calls.length).toBe(0)
  })
})
