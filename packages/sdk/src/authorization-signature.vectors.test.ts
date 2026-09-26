/**
 * Pins the published relay-signature test vectors (docs/agent-trading.md, "Computing the
 * authorization signature in any language") against Privy's own reference and this SDK's signer, so
 * the docs cannot drift from what Privy accepts.
 */
import { describe, expect, test } from "bun:test"
import { createHash, createPublicKey, verify } from "node:crypto"
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/server-auth/wallet-api"
import { buildPrivyAuthorizationSignature } from "./authorization-signature"
import { relayVectorKey, RELAY_SIGNATURE_VECTORS as V } from "./authorization-signature.vectors.fixture"

const key = relayVectorKey()
const publicKey = createPublicKey(key)
const pkcs8 = key.export({ type: "pkcs8", format: "der" }).toString("base64")
const pem = key.export({ type: "pkcs8", format: "pem" }).toString()

function reference(body: unknown) {
  return {
    version: 1 as const,
    method: "POST" as const,
    url: `https://api.privy.io/v1/wallets/${V.privyWalletId}/rpc`,
    body: body as Record<string, unknown>,
    headers: { "privy-app-id": V.appId },
  }
}

function verifies(canonical: string, signatureB64: string): boolean {
  return verify("sha256", Buffer.from(canonical, "utf8"), publicKey, Buffer.from(signatureB64, "base64"))
}

describe("published relay-signature vectors", () => {
  test("the test key's public half is the published one", () => {
    expect(publicKey.export({ type: "spki", format: "der" }).toString("base64")).toBe(V.publicKeySpkiBase64)
  })

  for (const c of V.cases) {
    test(`${c.name}: canonical bytes and SHA-256 match Privy's reference`, () => {
      const input = reference(c.body)
      expect(formatRequestForAuthorizationSignature({ input }).toString("utf8")).toBe(c.canonical)
      expect(createHash("sha256").update(c.canonical, "utf8").digest("hex")).toBe(c.sha256)
    })

    test(`${c.name}: the published signature is Privy's deterministic one, and it verifies`, () => {
      const input = reference(c.body)
      expect(generateAuthorizationSignature({ input, authorizationPrivateKey: `wallet-auth:${pkcs8}` })).toBe(
        c.signature,
      )
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
