/**
 * Client-side HPKE for Candle's ciphertext-only wallet import (PR3, Task 8).
 *
 * `POST /api/v1/agent/wallets/import/init` proxies Privy's HPKE receiver public key so an agent
 * can encrypt a wallet's private key locally; `POST /api/v1/agent/wallets/import/submit` accepts
 * only the resulting ciphertext. Candle -- and the network in between -- never sees plaintext.
 * `CandleClient.importWallet` (client.ts) drives both requests and is the only place in this SDK
 * that ever holds the plaintext key; this module supplies the pure crypto it calls.
 *
 * HPKE parameters match Privy's import contract exactly (RFC 9180, mode Base):
 *   - KEM: DHKEM(P-256, HKDF-SHA256)  -- `DhkemP256HkdfSha256`
 *   - KDF: HKDF-SHA256                -- `HkdfSha256`
 *   - AEAD: ChaCha20-Poly1305         -- `Chacha20Poly1305`
 * All three wire values -- the receiver's `encryptionPublicKey` (input) and the `ciphertext` /
 * `encapsulatedKey` this module produces (output) -- are base64-encoded raw KEM bytes (an
 * uncompressed SEC1 point for the P-256 public key), never DER. DER only shows up below for the
 * UNRELATED signer keypair, which is a separate WebCrypto ECDSA key, not part of the HPKE
 * exchange.
 *
 * `@hpke/core`, `@hpke/chacha20poly1305`, and `@scure/base` are this SDK's first three runtime
 * dependencies (previously zero -- see client.ts's module doc). All three already resolve in
 * this monorepo as transitive hoists of apps/api's `@privy-io/server-auth`, but a phantom hoist
 * is invisible to a package's own manifest: publishing the SDK without declaring them would
 * break any consumer that doesn't happen to also depend on `@privy-io/server-auth`.
 *
 * CRITICAL: what gets HPKE-sealed is not the `privateKey` string's own UTF-8 bytes -- it is that
 * string DECODED to the wallet's raw private-key bytes first, exactly like Privy's own reference
 * import flow (node_modules/@privy-io/server-auth/dist/cjs/wallet-api/import.js,
 * `handleWalletImport`): "evm" keys are hex (an optional leading "0x" is stripped, then
 * hex-decoded), "solana" keys are base58 (decoded with `@scure/base`'s `base58.decode`, the same
 * codec Privy's own SDK uses). Sealing the string's UTF-8 text instead -- what an earlier version
 * of this module did -- produces a ciphertext that either fails to decrypt correctly on Privy's
 * side or, worse, silently decrypts to the WRONG bytes and provisions a garbage-keyed wallet.
 */

import { Chacha20Poly1305 } from "@hpke/chacha20poly1305"
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core"
import { base58 } from "@scure/base"
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from "./internal/encoding"

function buildCipherSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  })
}

/**
 * Chain for the linked-wallets import flow (PR3). "evm" covers every EVM chain (Privy's own
 * `chain_type: "ethereum"`), not just Ethereum mainnet; "solana" is Solana. Deliberately NOT the
 * launch-surface `Chain` in client.ts ("solana" | "hood"): import targets Privy's wallet chain
 * types, which distinguish "solana" from EVM rather than from Candle's own Hood/base-mainnet
 * split.
 */
export type WalletChain = "solana" | "evm"

/**
 * Decodes a Solana private key given as either a base58 string (`solana-keygen`'s
 * "phantom-paste" form) or the JSON byte-array contents of an `id.json` keyfile (the form
 * `solana-keygen new` actually writes to disk). Branches on whether the trimmed input starts
 * with `[`: no -> base58 decode; yes -> parse as a 64-int 0..255 JSON array. That branch (rather
 * than "try base58, then try JSON") is what lets a malformed array get a keyfile-specific error
 * ("this looks like an id.json but...") instead of the generic base58 one.
 */
export function parseSolanaSecret(input: string): Uint8Array {
  const trimmed = input.trim()
  if (!trimmed.startsWith("[")) {
    try {
      return base58.decode(trimmed)
    } catch {
      throw new Error("Invalid Solana private key: expected a base58 string or an id.json byte array.")
    }
  }
  const parsed: unknown = (() => {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  })()
  const isByteArray =
    Array.isArray(parsed) &&
    parsed.length === 64 &&
    parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  if (!isByteArray) {
    throw new Error(
      "This looks like a Solana keyfile (id.json) but is not a 64-byte array. Pass the file's contents, e.g. [12,34,...].",
    )
  }
  return Uint8Array.from(parsed as number[])
}

/**
 * Decodes a wallet's private-key ENTROPY STRING to the raw bytes Privy's HPKE receiver expects,
 * matching Privy's own reference decode byte-for-byte (see this file's module doc). Throws a
 * plain `Error` on a malformed input rather than silently sealing wrong bytes.
 */
function decodeWalletPrivateKey(chain: WalletChain, privateKey: string): Uint8Array {
  if (chain === "evm") {
    const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('Invalid EVM private key: expected a hex string (optionally "0x"-prefixed)')
    }
    return Uint8Array.from(Buffer.from(hex, "hex"))
  }
  return parseSolanaSecret(privateKey)
}

export interface EncryptWalletKeyParams {
  /** Which chain `privateKey` belongs to; selects how it is decoded to raw bytes before sealing. */
  chain: WalletChain
  /**
   * The wallet's private key exactly as the caller holds it: a hex string for "evm" (an optional
   * leading "0x" is accepted and stripped), or a base58 string for "solana". This is decoded to
   * raw bytes locally -- matching Privy's own wallet-import reference decode -- and THOSE bytes
   * are what gets HPKE-sealed, never the input string's own UTF-8 text.
   */
  privateKey: string
  /** Privy's HPKE receiver public key from `/wallets/import/init`'s `encryptionPublicKey`, base64-encoded. */
  encryptionPublicKey: string
}

export interface EncryptWalletKeyResult {
  /** Base64-encoded HPKE seal output; posted as `/wallets/import/submit`'s `ciphertext`. */
  ciphertext: string
  /** Base64-encoded HPKE encapsulated key; posted as `/wallets/import/submit`'s `encapsulatedKey`. */
  encapsulatedKey: string
}

/**
 * Encrypts `privateKey` (decoded to raw bytes per `chain`, see `decodeWalletPrivateKey`) to
 * `encryptionPublicKey` under the HPKE suite above (RFC 9180 single-shot Base-mode seal with a
 * fresh ephemeral sender keypair per call). Neither the input string nor its decoded bytes leave
 * this function call; only the returned ciphertext and encapsulated key are meant to travel
 * further.
 */
export async function encryptWalletKeyForImport(params: EncryptWalletKeyParams): Promise<EncryptWalletKeyResult> {
  // Decode first: a malformed key fails loud before any HPKE setup runs, instead of getting
  // sealed (wrongly) or masked by a later, unrelated crypto error.
  const plaintext = decodeWalletPrivateKey(params.chain, params.privateKey)
  const suite = buildCipherSuite()
  const recipientPublicKey = await suite.kem.deserializePublicKey(base64ToArrayBuffer(params.encryptionPublicKey))
  const sender = await suite.createSenderContext({ recipientPublicKey })
  const ciphertext = await sender.seal(toArrayBuffer(plaintext))
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    encapsulatedKey: arrayBufferToBase64(sender.enc),
  }
}

export interface SignerKeypair {
  /** PEM-encoded PKCS8 private key. The caller keeps this; the SDK never transmits it anywhere. */
  privateKeyPem: string
  /** Base64-encoded SPKI (DER) public key -- the value `CandleClient.importWallet`'s `signerPublicKey` expects. */
  publicKeyDerBase64: string
}

/**
 * Generates a fresh P-256 (ECDSA) keypair via WebCrypto for use as an agent's wallet signer.
 * Only `publicKeyDerBase64` is meant to leave the process (it becomes `signerPublicKey` in
 * `/wallets/import/submit`, which Privy registers as a 1-of-1 key quorum authorized to sign for
 * the imported wallet); `privateKeyPem` is the caller's to store and use for that later signing,
 * never sent to Candle or Privy by this SDK.
 */
export async function generateSignerKeypair(): Promise<SignerKeypair> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const [publicKeyDer, privateKeyDer] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ])
  return {
    privateKeyPem: derToPem(privateKeyDer, "PRIVATE KEY"),
    publicKeyDerBase64: arrayBufferToBase64(publicKeyDer),
  }
}

/** Wraps DER bytes as a standard 64-column PEM block. */
function derToPem(der: ArrayBuffer, label: string): string {
  const base64 = arrayBufferToBase64(der)
  const lines = base64.match(/.{1,64}/g) ?? [base64]
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}
