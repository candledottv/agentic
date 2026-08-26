/**
 * The shim's own contract, kept separate from the Sigstore tests so a Bun upgrade that fixes this
 * upstream (or breaks it differently) is caught here, in one small test, rather than as an
 * unexplained "signature did not verify" somewhere in an installer.
 *
 * Without the shim the first assertion below throws `ERR_OSSL_NO_DEFAULT_DIGEST` under Bun, and
 * inside `@sigstore/core` and `@tufjs/models` that throw is swallowed as a plain `false`.
 */

import { expect, test } from "bun:test"
import crypto from "node:crypto"
import "./bun-crypto-shim"

test("an EC signature verifies with no digest given, and a tampered payload does not", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const data = Buffer.from("candle")
  const signature = crypto.sign("sha256", data, privateKey)
  expect(crypto.verify(null, data, publicKey, signature)).toBe(true)
  expect(crypto.verify(null, Buffer.from("candle!"), publicKey, signature)).toBe(false)
  // The tuf-js wrapper shape: getPublicKey() returns { key, padding }, not a bare KeyObject.
  expect(crypto.verify(undefined, data, { key: publicKey, padding: undefined } as never, signature)).toBe(true)
})

// Node's implicit EC digest is SHA-256 whatever the curve, so the shim reproduces Node rather
// than guessing: a P-384 key signed with SHA-256 verifies, and the same key signed with SHA-384
// does not.
test("the implied digest is sha256 on every curve, as Node has it", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" })
  const data = Buffer.from("candle")
  expect(crypto.verify(null, data, publicKey, crypto.sign("sha256", data, privateKey))).toBe(true)
  expect(crypto.verify(null, data, publicKey, crypto.sign("sha384", data, privateKey))).toBe(false)
})

// A self-referential wrapper must not recurse forever: the shim sits in front of every
// crypto.verify in the process, so a stack overflow here is a crashed CLI rather than a refused
// signature.
test("a cyclic key wrapper is given up on rather than followed", () => {
  const cyclic: { key?: unknown } = {}
  cyclic.key = cyclic
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const data = Buffer.from("candle")
  const signature = crypto.sign("sha256", data, privateKey)
  // It resolves to no key, so the call is passed through untouched and the runtime rejects it.
  expect(() => crypto.verify(null, data, cyclic as never, signature)).toThrow()
  // And the real key still works, so the bound did not break the path that matters.
  expect(crypto.verify(null, data, publicKey, signature)).toBe(true)
})

test("a non-EC key with no digest is left to the runtime", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const data = Buffer.from("candle")
  const signature = crypto.sign(null, data, privateKey)
  expect(crypto.verify(null, data, publicKey, signature)).toBe(true)
})
