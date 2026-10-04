/**
 * Locally computes Privy's wallet-RPC "authorization signature" (Agent Pilot Phase 3, Task 2):
 * the client half of the linked-wallet signing relay Task 1 built server-side
 * (apps/api/src/routes/agent.ts's `POST /wallets/:id/sign`, and
 * apps/api/src/services/privy-wallets.ts's `relaySignWithLinkedWallet`, which forwards this
 * signature to Privy unchanged and MUST NEVER compute its own). An agent holds its own P-256
 * signer key locally -- the private half of `generateSignerKeypair`'s output (wallet-import.ts)
 * -- and must produce the SAME signature Privy's own SDK would produce for that key, over the
 * SAME canonical request payload, WITHOUT the key ever leaving this process. That is the entire
 * point of the relay.
 *
 * The reference implementation this must match is `generateAuthorizationSignature` from
 * `@privy-io/server-auth/wallet-api` (installed at
 * node_modules/@privy-io/server-auth/dist/esm/wallet-api/{index,utils}.mjs, v1.32.5, each
 * minified to a single line, so described here by the compiled local variable names rather than
 * source line numbers). Reading that source (not guessing) turned up three load-bearing details:
 *
 * 1. Canonicalization is RFC 8785 JSON Canonicalization Scheme (JCS), via the `canonicalize` npm
 *    package -- utils.mjs's `y = e => Buffer.from(o(e))` where `o` is `canonicalize`'s default
 *    export, called on `{version:1, method, url, body, headers}` (utils.mjs's `h`, exported as
 *    `formatAuthorizationSignatureRequest`). JCS is NOT plain `JSON.stringify`: it sorts every
 *    object's keys, recurses through arrays/nested objects, and has its own number-formatting and
 *    undefined-skipping rules. Reimplementing JCS by hand risks a byte-level mismatch on some edge
 *    case that would silently produce a signature Privy rejects. `canonicalize` is already a
 *    transitive dependency of this monorepo's `@privy-io/server-auth` (the same situation
 *    wallet-import.ts's module doc describes for the HPKE packages), so this module takes it as a
 *    small, zero-dependency, real runtime dependency instead of hand-rolling JCS: it is the
 *    literal function Privy's own SDK canonicalizes with, so using it is not a reimplementation
 *    risk at all, unlike a from-scratch JCS implementation would be.
 * 2. The signed message is SHA-256 of those canonical UTF-8 bytes, ECDSA/P-256 over that hash --
 *    utils.mjs's `c = (e,r) => n.sign(a(e), r).toDERRawBytes()` (`n` = `@noble/curves/p256`, `a` =
 *    `@noble/hashes/sha256`), called with `prehash` left at its default `false`, i.e. `a(e)` (the
 *    SHA-256 hash) IS the "message" `n.sign` signs directly -- @noble's own `validateMsgAndHash`
 *    only re-hashes when `prehash: true` is passed. `crypto.subtle.sign({name:"ECDSA",
 *    hash:"SHA-256"}, ...)` computes that identical SHA-256-then-ECDSA-P-256 relationship, so
 *    WebCrypto is a faithful stand-in for signing. It is NOT bit-identical: WebCrypto uses a
 *    random per-signature nonce where @noble/curves' reference impl uses deterministic RFC 6979,
 *    so the two will never produce the same signature bytes for the same input -- but both are
 *    valid ECDSA signatures over the same (hash, key) pair, and verify identically against the
 *    public key. This is exactly why this module's pinning test (authorization-signature.test.ts)
 *    verifies signatures cryptographically rather than comparing signature strings.
 * 3. Privy expects the signature DER-encoded (`.toDERRawBytes()`), base64-encoded, in the
 *    `privy-authorization-signature` header. WebCrypto's ECDSA `sign` only ever produces the raw
 *    IEEE P1363 format (a P-256 signature's 32-byte `r` immediately followed by its 32-byte `s`)
 *    -- never DER -- so this module converts that raw signature to DER itself
 *    (`rawEcdsaSignatureToDer`) before base64-encoding. Skipping this step would produce a
 *    signature Privy's server does not recognize as valid, even though the same bytes verify fine
 *    against the public key when treated as "raw".
 *
 * See authorization-signature.test.ts for the pinning test: it feeds the SAME generated P-256 key
 * to both this module (as the PEM `buildPrivyAuthorizationSignature` takes) and the reference
 * `generateAuthorizationSignature` (as `"wallet-auth:" + base64(pkcs8 DER)`, the form Privy's own
 * key-normalization expects -- see `normalizeP256PrivateKeyToScalar` in utils.mjs, which strips
 * that prefix and base64-decodes back to the same PKCS8 DER bytes `pemToPkcs8Bytes` extracts from
 * the PEM here), then verifies BOTH resulting signatures cryptographically against the same
 * public key (never compares the signature strings -- see point 2 above) and separately asserts
 * the exact canonical byte payload this module hashes is identical to the reference's own
 * `formatRequestForAuthorizationSignature` output for the same input.
 */
export interface BuildPrivyAuthorizationSignatureParams {
    /** PKCS8 PEM private key for the agent's P-256 signer, as produced by `generateSignerKeypair` (wallet-import.ts). */
    privateKeyPem: string;
    /** The Privy wallet this signature authorizes an RPC call against; becomes the URL path segment. */
    privyWalletId: string;
    /** Privy's app id: sent as the `privy-app-id` header and folded into the canonical payload. */
    appId: string;
    /** The exact RPC request body being authorized. Must be byte-identical to what is actually sent -- see module doc, point 1. */
    body: unknown;
}
/**
 * The exact UTF-8 bytes this module hashes and signs: RFC 8785 JCS canonicalization of
 * `{version, method, url, body, headers}`, matching Privy's own
 * `formatRequestForAuthorizationSignature` byte-for-byte (both call the same `canonicalize`
 * function -- see module doc, point 1). Exported so the pinning test can assert this equals the
 * reference's own output, independently of whether the resulting signatures verify.
 */
export declare function canonicalAuthorizationPayloadBytes(params: Omit<BuildPrivyAuthorizationSignatureParams, "privateKeyPem">): Uint8Array;
/** Strips PEM armor (BEGIN/END lines and newlines) and returns the raw PKCS8 DER bytes underneath, for WebCrypto's `importKey("pkcs8", ...)`. */
export declare function pemToPkcs8Bytes(pem: string): Uint8Array;
/**
 * Builds the `privy-authorization-signature` header value for a Privy wallet-RPC request,
 * computed entirely locally from `privateKeyPem` -- the key never leaves this function call, and
 * this module makes no network request of any kind. See this module's doc comment for how each
 * step matches `@privy-io/server-auth/wallet-api`'s `generateAuthorizationSignature`.
 */
export declare function buildPrivyAuthorizationSignature(params: BuildPrivyAuthorizationSignatureParams): Promise<string>;
//# sourceMappingURL=authorization-signature.d.ts.map