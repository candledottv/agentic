/**
 * Pins the published relay-signature test vectors (docs/agent-trading.md, "Computing the
 * authorization signature in any language") against Privy's own reference, this SDK's signer, and
 * the text of that section, so the docs cannot drift from what Privy accepts.
 *
 * A mismatch names the re-derived value to publish. There is no separate regeneration script.
 */
import { describe, expect, test } from "bun:test"
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/server-auth/wallet-api"
import { buildPrivyAuthorizationSignature } from "./authorization-signature"
import {
  relayVectorInput,
  relayVectorKey,
  RELAY_SIGNATURE_VECTORS as V,
} from "./authorization-signature.vectors.fixture"

const key = relayVectorKey()
const publicKey = createPublicKey(key)
const pkcs8 = key.export({ type: "pkcs8", format: "der" }).toString("base64")
const pem = key.export({ type: "pkcs8", format: "pem" }).toString()

/** `derived` is the re-derived value. The message prints it so a failure is the fixture update. */
function expectDerived(published: string, derived: string | undefined, label: string) {
  const text = derived ?? "<undefined>"
  expect(published, `${label} to publish:\n${text}`).toBe(text)
}

function verifies(canonical: string, signatureB64: string): boolean {
  return verify("sha256", Buffer.from(canonical, "utf8"), publicKey, Buffer.from(signatureB64, "base64"))
}

describe("published relay-signature vectors", () => {
  test("the test key's public half is the published one", () => {
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64")
    expectDerived(V.publicKeySpkiBase64, spki, "publicKeySpkiBase64")
  })

  test("docs/agent-trading.md contains each published vector", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../docs/agent-trading.md"), "utf8")
    expect(doc).toContain(V.publicKeySpkiBase64)
    for (const c of V.cases) {
      expect(doc, `${c.name} canonical`).toContain(c.canonical)
      expect(doc, `${c.name} sha256`).toContain(c.sha256)
      expect(doc, `${c.name} signature`).toContain(c.signature)
      expect(doc, `${c.name} body`).toContain(`body \`${JSON.stringify(c.body)}\``)
    }
  })

  for (const c of V.cases) {
    test(`${c.name}: canonical bytes and SHA-256 match Privy's reference`, () => {
      const canonical = formatRequestForAuthorizationSignature({ input: relayVectorInput(c.body) }).toString("utf8")
      const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex")
      expectDerived(c.canonical, canonical, `${c.name} canonical`)
      expectDerived(c.sha256, sha256, `${c.name} sha256`)
    })

    test(`${c.name}: the published signature is Privy's deterministic one, and it verifies`, () => {
      const signature = generateAuthorizationSignature({
        input: relayVectorInput(c.body),
        authorizationPrivateKey: `wallet-auth:${pkcs8}`,
      })
      expectDerived(c.signature, signature, `${c.name} signature`)
      expect(verifies(c.canonical, c.signature)).toBe(true)
    })

    test(`${c.name}: this SDK's signer produces a signature that verifies over the same bytes`, async () => {
      const signature = await buildPrivyAuthorizationSignature({
        privateKeyPem: pem,
        privyWalletId: V.privyWalletId,
        appId: V.appId,
        body: c.body,
      })
      expect(verifies(c.canonical, signature)).toBe(true)
    })
  }

  test("a signature over a one-byte change does not verify", () => {
    const [first] = V.cases
    expect(verifies(first.canonical.replace("AQIDBA==", "AQIDBQ=="), first.signature)).toBe(false)
  })
})
