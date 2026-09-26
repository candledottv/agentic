/**
 * Test vectors for the relay's P-256 authorization signature, published in docs/agent-trading.md
 * ("Computing the authorization signature in any language") for bots that are not TypeScript.
 *
 * The test key is not stored anywhere: its private scalar is SHA-256 of `keySeed` (ASCII), so any
 * language can rebuild it and the repo carries no key material. It signs nothing real.
 * `authorization-signature.vectors.test.ts` pins every value below against Privy's own
 * reference. Not imported by `index.ts`, and `*.fixture.ts` is excluded from the type build, so
 * the published SDK does not ship it.
 */
import { createECDH, createHash, createPrivateKey, type KeyObject } from "node:crypto"

export const RELAY_SIGNATURE_VECTORS = {
  keySeed: "candle relay-signature test vector v1",
  appId: "cm0000000000000000000test",
  privyWalletId: "test-wallet-0000000000000",
  cases: [
    {
      name: "Solana signTransaction",
      body: { method: "signTransaction", params: { encoding: "base64", transaction: "AQIDBA==" } },
      canonical:
        '{"body":{"method":"signTransaction","params":{"encoding":"base64","transaction":"AQIDBA=="}},"headers":{"privy-app-id":"cm0000000000000000000test"},"method":"POST","url":"https://api.privy.io/v1/wallets/test-wallet-0000000000000/rpc","version":1}',
      sha256: "7d51a9a9b6ab199bfccac7bd3ff2a3613eecf1c96cfe5620dafd35d858d94a7f",
      signature: "MEUCIQDTkf/P50c/PlnHUDd3OOIaJidIlamzEOanIrtAqkw+NAIgD1mm19iQkPXOqR3BanhA+jQJkJICAVTi59dq+mF5DZQ=",
    },
    {
      name: "Hood eth_signTransaction",
      body: {
        method: "eth_signTransaction",
        params: {
          transaction: {
            chain_id: 4663,
            data: "0x",
            from: "0x0000000000000000000000000000000000000001",
            gas_limit: "0x5208",
            max_fee_per_gas: "0x3b9aca00",
            max_priority_fee_per_gas: "0x5f5e100",
            nonce: 0,
            to: "0x0000000000000000000000000000000000000002",
            type: 2,
            value: "0x1",
          },
        },
      },
      canonical:
        '{"body":{"method":"eth_signTransaction","params":{"transaction":{"chain_id":4663,"data":"0x","from":"0x0000000000000000000000000000000000000001","gas_limit":"0x5208","max_fee_per_gas":"0x3b9aca00","max_priority_fee_per_gas":"0x5f5e100","nonce":0,"to":"0x0000000000000000000000000000000000000002","type":2,"value":"0x1"}}},"headers":{"privy-app-id":"cm0000000000000000000test"},"method":"POST","url":"https://api.privy.io/v1/wallets/test-wallet-0000000000000/rpc","version":1}',
      sha256: "fe1e51d6020079440dbbd5ba50b0e3c3d569ab6d077ae36228347f457f3f8aca",
      signature: "MEUCIBsUEBSQll9FP8W0xmMbiNGEhgDK4tu9yyiRHSdqG62rAiEAmM8ruXe6Y+RpPD9PDGF5SBhBX6UuR12m8+J7H4Q0TAg=",
    },
  ],
  publicKeySpkiBase64:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEppf0fcDJ1lavcopP7GGeGcGeTUOX8onzhseGpVy8cI46UNMpn2nHd4t68vPFjggZB2gFymLnZDg6bmirKjhSog==",
} as const

/** The `{version, method, url, body, headers}` object Privy canonicalizes for one published vector. */
export function relayVectorInput(body: (typeof RELAY_SIGNATURE_VECTORS.cases)[number]["body"]) {
  return {
    version: 1 as const,
    method: "POST" as const,
    url: `https://api.privy.io/v1/wallets/${RELAY_SIGNATURE_VECTORS.privyWalletId}/rpc`,
    body: body as Record<string, unknown>,
    headers: { "privy-app-id": RELAY_SIGNATURE_VECTORS.appId },
  }
}

/** The test key, rebuilt from `keySeed`: scalar = SHA-256(seed), public point from the scalar. */
export function relayVectorKey(): KeyObject {
  const d = createHash("sha256").update(RELAY_SIGNATURE_VECTORS.keySeed, "ascii").digest()
  const ecdh = createECDH("prime256v1")
  ecdh.setPrivateKey(d)
  const point = ecdh.getPublicKey() // uncompressed: 0x04 || x || y
  const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url")
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(point.slice(1, 33)), y: b64u(point.slice(33, 65)) },
    format: "jwk",
  })
}
