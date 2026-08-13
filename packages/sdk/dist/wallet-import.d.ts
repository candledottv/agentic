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
/**
 * Chain for the linked-wallets import flow (PR3). "evm" covers every EVM chain (Privy's own
 * `chain_type: "ethereum"`), not just Ethereum mainnet; "solana" is Solana. Deliberately NOT the
 * launch-surface `Chain` in client.ts ("solana" | "hood"): import targets Privy's wallet chain
 * types, which distinguish "solana" from EVM rather than from Candle's own Hood/base-mainnet
 * split.
 */
export type WalletChain = "solana" | "evm";
/**
 * Decodes a Solana private key given as either a base58 string (`solana-keygen`'s
 * "phantom-paste" form) or the JSON byte-array contents of an `id.json` keyfile (the form
 * `solana-keygen new` actually writes to disk). Branches on whether the trimmed input starts
 * with `[`: no -> base58 decode; yes -> parse as a 64-int 0..255 JSON array. That branch (rather
 * than "try base58, then try JSON") is what lets a malformed array get a keyfile-specific error
 * ("this looks like an id.json but...") instead of the generic base58 one.
 */
export declare function parseSolanaSecret(input: string): Uint8Array;
export interface EncryptWalletKeyParams {
    /** Which chain `privateKey` belongs to; selects how it is decoded to raw bytes before sealing. */
    chain: WalletChain;
    /**
     * The wallet's private key exactly as the caller holds it: a hex string for "evm" (an optional
     * leading "0x" is accepted and stripped), or a base58 string for "solana". This is decoded to
     * raw bytes locally -- matching Privy's own wallet-import reference decode -- and THOSE bytes
     * are what gets HPKE-sealed, never the input string's own UTF-8 text.
     */
    privateKey: string;
    /** Privy's HPKE receiver public key from `/wallets/import/init`'s `encryptionPublicKey`, base64-encoded. */
    encryptionPublicKey: string;
}
export interface EncryptWalletKeyResult {
    /** Base64-encoded HPKE seal output; posted as `/wallets/import/submit`'s `ciphertext`. */
    ciphertext: string;
    /** Base64-encoded HPKE encapsulated key; posted as `/wallets/import/submit`'s `encapsulatedKey`. */
    encapsulatedKey: string;
}
/**
 * Encrypts `privateKey` (decoded to raw bytes per `chain`, see `decodeWalletPrivateKey`) to
 * `encryptionPublicKey` under the HPKE suite above (RFC 9180 single-shot Base-mode seal with a
 * fresh ephemeral sender keypair per call). Neither the input string nor its decoded bytes leave
 * this function call; only the returned ciphertext and encapsulated key are meant to travel
 * further.
 */
export declare function encryptWalletKeyForImport(params: EncryptWalletKeyParams): Promise<EncryptWalletKeyResult>;
export interface SignerKeypair {
    /** PEM-encoded PKCS8 private key. The caller keeps this; the SDK never transmits it anywhere. */
    privateKeyPem: string;
    /** Base64-encoded SPKI (DER) public key -- the value `CandleClient.importWallet`'s `signerPublicKey` expects. */
    publicKeyDerBase64: string;
}
/**
 * Generates a fresh P-256 (ECDSA) keypair via WebCrypto for use as an agent's wallet signer.
 * Only `publicKeyDerBase64` is meant to leave the process (it becomes `signerPublicKey` in
 * `/wallets/import/submit`, which Privy registers as a 1-of-1 key quorum authorized to sign for
 * the imported wallet); `privateKeyPem` is the caller's to store and use for that later signing,
 * never sent to Candle or Privy by this SDK.
 */
export declare function generateSignerKeypair(): Promise<SignerKeypair>;
//# sourceMappingURL=wallet-import.d.ts.map