/**
 * Bun 1.3.14 (BoringSSL) refuses `crypto.verify` when the digest argument is null/undefined and
 * the key is EC, throwing `error:06000077:public key routines:OPENSSL_internal:NO_DEFAULT_DIGEST`
 * (Node's `ERR_OSSL_NO_DEFAULT_DIGEST`); Node infers SHA-256 there. `@sigstore/core` and
 * `@tufjs/models` call verify that way and swallow the throw as "invalid signature", so without
 * this every Sigstore and TUF check fails closed: `@sigstore/verify` reports "inclusion promise
 * could not be verified" (the Rekor SET is ECDSA-P256) and `@sigstore/tuf` reports "root was
 * signed by 0/3 keys". The shim supplies sha256 for EC keys only when no digest was given and
 * leaves every other call untouched.
 *
 * Three things about it are load-bearing, all measured in Task 1's spike:
 *   - tuf-js's getPublicKey() passes `{ key, padding }` wrappers rather than bare KeyObjects,
 *     which is why the key is unwrapped first. Handling only KeyObject fixed @sigstore/verify and
 *     left @sigstore/tuf still failing.
 *   - sha256 is right for EVERY curve. Node's implied EC digest is SHA-256 whatever the curve, so
 *     this reproduces Node rather than guessing (bun-crypto-shim.test.ts pins it on P-384).
 *   - Ed25519 must not be touched: it requires a null digest and already works under Bun, which
 *     is what the `asymmetricKeyType === "ec"` guard keeps it out of.
 *
 * Remove when the pinned Bun (.bun-version) no longer needs it; the test above is what will say
 * so, by starting to pass without this import.
 */

import crypto, { KeyObject } from "node:crypto"

type VerifyFn = typeof crypto.verify

/** The runtime's own verify, bound before the property is replaced. Typed loosely because the
 * shim forwards whatever it was handed, callback overload included, without inspecting it. */
const original = crypto.verify.bind(crypto) as unknown as (...args: unknown[]) => unknown

/** How many `{ key }` wrappers to unwrap. tuf-js needs exactly one; the bound is what stops a
 * self-referential or maliciously nested object turning a signature check into a stack overflow,
 * which in a shim that everything else calls would take the process down rather than fail a
 * verification. */
const MAX_UNWRAP = 3

/** The KeyObject behind whatever a caller passed: a bare one, a `{ key }` wrapper, or a PEM/DER
 * string or buffer. `null` when it is none of those, which leaves the call untouched. */
function keyOf(key: unknown, depth = 0): KeyObject | null {
  if (key instanceof KeyObject) return key
  if (key !== null && typeof key === "object" && "key" in key) {
    return depth >= MAX_UNWRAP ? null : keyOf((key as { key: unknown }).key, depth + 1)
  }
  if (typeof key === "string" || key instanceof Uint8Array) {
    try {
      return crypto.createPublicKey(key as crypto.KeyLike)
    } catch {
      return null
    }
  }
  return null
}

export function installBunCryptoShim(): void {
  if (!("Bun" in globalThis)) return
  const shimmed = ((
    algorithm: string | null | undefined,
    data: unknown,
    key: unknown,
    signature: unknown,
    ...rest: unknown[]
  ) => {
    if (algorithm === null || algorithm === undefined) {
      const resolved = keyOf(key)
      if (resolved?.asymmetricKeyType === "ec") return original("sha256", data, key, signature, ...rest)
    }
    return original(algorithm, data, key, signature, ...rest)
  }) as unknown as VerifyFn
  Object.defineProperty(crypto, "verify", { value: shimmed, configurable: true, writable: true })
}

installBunCryptoShim()
