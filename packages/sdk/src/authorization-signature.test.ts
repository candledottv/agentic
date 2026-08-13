/**
 * Pinning test (Agent Pilot Phase 3, Task 2): `buildPrivyAuthorizationSignature` must produce a
 * signature Privy's own SDK reference impl -- `generateAuthorizationSignature` from
 * `@privy-io/server-auth/wallet-api` (a DEV-only dependency here, never shipped by this SDK) --
 * would also accept, for the identical canonical request.
 *
 * ECDSA is non-deterministic (WebCrypto uses a random per-signature nonce; the reference impl's
 * `@noble/curves` uses deterministic RFC 6979 -- see authorization-signature.ts's module doc), so
 * this test never compares the two signature strings. Instead it:
 *   1. Asserts the canonical byte payload our code hashes/signs is byte-identical to the
 *      reference's own `formatRequestForAuthorizationSignature` output for the same input.
 *   2. Verifies both signatures cryptographically against the SAME P-256 public key over those
 *      (now proven-identical) canonical bytes, via Node's `crypto.verify` -- unlike
 *      `crypto.subtle`, Node's verify accepts DER-encoded ECDSA signatures directly, which is the
 *      wire format both our code and the reference produce.
 *
 * Both the PEM this test feeds `buildPrivyAuthorizationSignature` and the
 * `"wallet-auth:" + base64(pkcs8 DER)` form it feeds the reference impl are derived from the SAME
 * generated key (via `pemToPkcs8Bytes`, this module's own PEM->DER helper), so a mismatch could
 * only come from the canonicalization or signing logic, never from the two sides using different
 * keys.
 */

import { describe, expect, test } from "bun:test"
import { createPublicKey, verify as nodeVerify } from "node:crypto"
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/server-auth/wallet-api"
import {
  buildPrivyAuthorizationSignature,
  canonicalAuthorizationPayloadBytes,
  pemToPkcs8Bytes,
} from "./authorization-signature"
import { generateSignerKeypair } from "./wallet-import"

const APP_ID = "test-app-id"
const PRIVY_WALLET_ID = "test-wallet-id"
const RPC_URL = `https://api.privy.io/v1/wallets/${PRIVY_WALLET_ID}/rpc`

// A representative Solana signTransaction RPC body -- shape per @privy-io/server-auth's own
// `rpc()` request formatter (dist/esm/wallet-api/index.mjs): base64-encoded serialized
// transaction, plus the `wallet_id`/`method` envelope every RPC call carries.
const SOLANA_BODY = {
  wallet_id: PRIVY_WALLET_ID,
  method: "signTransaction",
  params: {
    transaction: "AQABA58BvR2ZBEtcHIexqfEIXpc7dSg9Vw+t6H1Bpp6X9w0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    encoding: "base64",
  },
}

// A representative EVM eth_signTransaction RPC body -- same source, the `eth_signTransaction`
// branch. Deliberately includes a `null` field (gas_price) and nested numbers/strings, since
// RFC 8785 JSON canonicalization has its own rules for both that plain `JSON.stringify` key
// ordering alone would not exercise.
const EVM_BODY = {
  wallet_id: PRIVY_WALLET_ID,
  method: "eth_signTransaction",
  params: {
    transaction: {
      from: "0x000000000000000000000000000000000000aa",
      to: "0x000000000000000000000000000000000000bb",
      nonce: 7,
      chain_id: 8453,
      data: "0xabcdef",
      value: "0x0",
      type: 2,
      gas_limit: "0x5208",
      gas_price: null,
      max_fee_per_gas: "0x3b9aca00",
      max_priority_fee_per_gas: "0x3b9aca00",
    },
  },
}

/**
 * Verifies a base64 DER ECDSA/P-256 signature against `publicKeyDerBase64` over `messageBytes`
 * (SHA-256). Uses Node's `crypto.verify` rather than `crypto.subtle.verify`: WebCrypto's ECDSA
 * only accepts the raw IEEE P1363 signature format, but both signatures under test here are DER
 * (the format Privy actually expects on the wire), and Node's verify handles DER natively.
 */
function verifyDerSignature(publicKeyDerBase64: string, messageBytes: Uint8Array, signatureBase64: string): boolean {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" })
  return nodeVerify("sha256", Buffer.from(messageBytes), publicKey, Buffer.from(signatureBase64, "base64"))
}

/**
 * Runs the full pinning check for one RPC `body` fixture: builds our signature and the
 * reference's signature from the SAME generated key, asserts the canonical bytes match, then
 * verifies both signatures against the public key over those bytes (plus a cross-check: our
 * signature over the reference's bytes, and vice versa).
 */
async function pinAgainstReference(body: unknown): Promise<void> {
  const { privateKeyPem, publicKeyDerBase64 } = await generateSignerKeypair()
  const pkcs8Der = pemToPkcs8Bytes(privateKeyPem)
  const referenceAuthorizationPrivateKey = `wallet-auth:${Buffer.from(pkcs8Der).toString("base64")}`

  const ourSignature = await buildPrivyAuthorizationSignature({
    privateKeyPem,
    privyWalletId: PRIVY_WALLET_ID,
    appId: APP_ID,
    body,
  })

  const referenceInput = {
    version: 1 as const,
    method: "POST" as const,
    url: RPC_URL,
    body,
    headers: { "privy-app-id": APP_ID },
  }
  const referenceSignature = generateAuthorizationSignature({
    input: referenceInput,
    authorizationPrivateKey: referenceAuthorizationPrivateKey,
  })
  expect(typeof referenceSignature).toBe("string")

  const ourBytes = canonicalAuthorizationPayloadBytes({ privyWalletId: PRIVY_WALLET_ID, appId: APP_ID, body })
  const referenceBytes = new Uint8Array(formatRequestForAuthorizationSignature({ input: referenceInput }))
  expect(Buffer.from(ourBytes).equals(Buffer.from(referenceBytes))).toBe(true)

  expect(verifyDerSignature(publicKeyDerBase64, ourBytes, ourSignature)).toBe(true)
  expect(verifyDerSignature(publicKeyDerBase64, referenceBytes, referenceSignature as string)).toBe(true)

  // Cross-check: since the byte payloads are already proven identical above, each signature must
  // also verify against the OTHER side's canonical bytes -- this rules out a bug where both sides
  // independently hash/sign consistently but over payloads that only look equal.
  expect(verifyDerSignature(publicKeyDerBase64, referenceBytes, ourSignature)).toBe(true)
  expect(verifyDerSignature(publicKeyDerBase64, ourBytes, referenceSignature as string)).toBe(true)
}

describe("buildPrivyAuthorizationSignature", () => {
  test("solana signTransaction body: signature verifies identically to the reference impl's", async () => {
    await pinAgainstReference(SOLANA_BODY)
  })

  test("evm eth_signTransaction body: signature verifies identically to the reference impl's", async () => {
    await pinAgainstReference(EVM_BODY)
  })

  test("a signature computed over one body does not verify against a different body's canonical bytes", async () => {
    const { privateKeyPem, publicKeyDerBase64 } = await generateSignerKeypair()
    const signature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: PRIVY_WALLET_ID,
      appId: APP_ID,
      body: SOLANA_BODY,
    })
    const otherBytes = canonicalAuthorizationPayloadBytes({
      privyWalletId: PRIVY_WALLET_ID,
      appId: APP_ID,
      body: EVM_BODY,
    })
    expect(verifyDerSignature(publicKeyDerBase64, otherBytes, signature)).toBe(false)
  })

  test("returns a base64 string", async () => {
    const { privateKeyPem } = await generateSignerKeypair()
    const signature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: PRIVY_WALLET_ID,
      appId: APP_ID,
      body: SOLANA_BODY,
    })
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  // A malformed privateKeyPem must fail loudly (WebCrypto rejects the bad key material) rather
  // than silently signing with garbage bytes -- see pemToPkcs8Bytes below: it does not itself
  // validate PEM structure, so this is what actually catches the bad input.
  test("rejects an empty string privateKeyPem", async () => {
    await expect(
      buildPrivyAuthorizationSignature({
        privateKeyPem: "",
        privyWalletId: PRIVY_WALLET_ID,
        appId: APP_ID,
        body: SOLANA_BODY,
      }),
    ).rejects.toThrow()
  })

  test("rejects a non-PEM garbage string privateKeyPem", async () => {
    await expect(
      buildPrivyAuthorizationSignature({
        privateKeyPem: "this is not a pem at all, just some garbage text",
        privyWalletId: PRIVY_WALLET_ID,
        appId: APP_ID,
        body: SOLANA_BODY,
      }),
    ).rejects.toThrow()
  })
})

describe("pemToPkcs8Bytes", () => {
  test("strips PEM armor to PKCS8 DER bytes that WebCrypto can import as a P-256 private key", async () => {
    const { privateKeyPem } = await generateSignerKeypair()
    const der = pemToPkcs8Bytes(privateKeyPem)
    const arrayBuffer = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer
    const key = await crypto.subtle.importKey("pkcs8", arrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ])
    expect(key.type).toBe("private")
    expect(key.algorithm.name).toBe("ECDSA")
  })
})

describe("canonicalAuthorizationPayloadBytes", () => {
  test("different bodies canonicalize to different bytes", () => {
    const solanaBytes = canonicalAuthorizationPayloadBytes({
      privyWalletId: PRIVY_WALLET_ID,
      appId: APP_ID,
      body: SOLANA_BODY,
    })
    const evmBytes = canonicalAuthorizationPayloadBytes({
      privyWalletId: PRIVY_WALLET_ID,
      appId: APP_ID,
      body: EVM_BODY,
    })
    expect(Buffer.from(solanaBytes).equals(Buffer.from(evmBytes))).toBe(false)
  })

  test("different wallet ids canonicalize to different bytes (the url differs)", () => {
    const a = canonicalAuthorizationPayloadBytes({ privyWalletId: "wallet-a", appId: APP_ID, body: SOLANA_BODY })
    const b = canonicalAuthorizationPayloadBytes({ privyWalletId: "wallet-b", appId: APP_ID, body: SOLANA_BODY })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})
