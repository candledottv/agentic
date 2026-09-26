/**
 * Prints the relay authorization-signature test vectors published in docs/agent-trading.md
 * ("Computing the authorization signature in any language"). The signature comes from Privy's own
 * reference, `generateAuthorizationSignature`, which signs with a deterministic (RFC 6979) nonce,
 * so re-running this prints the same bytes. Paste the printed `sha256`, `signature` and public key
 * into `src/authorization-signature.vectors.fixture.ts`; `src/authorization-signature.vectors.test.ts` pins them.
 *
 * Run: bun packages/sdk/scripts/relay-signature-vectors.ts
 */
import { createHash, createPublicKey } from "node:crypto"
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/server-auth/wallet-api"
import { relayVectorKey, RELAY_SIGNATURE_VECTORS as V } from "../src/authorization-signature.vectors.fixture"

const key = relayVectorKey()
const pkcs8 = key.export({ type: "pkcs8", format: "der" }).toString("base64")
const spki = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64")

for (const c of V.cases) {
  const input = {
    version: 1 as const,
    method: "POST" as const,
    url: `https://api.privy.io/v1/wallets/${V.privyWalletId}/rpc`,
    body: c.body,
    headers: { "privy-app-id": V.appId },
  }
  const canonical = formatRequestForAuthorizationSignature({ input }).toString("utf8")
  console.log(`## ${c.name}`)
  console.log(`canonical matches: ${canonical === c.canonical}`)
  console.log(`sha256:    ${createHash("sha256").update(canonical, "utf8").digest("hex")}`)
  console.log(
    `signature: ${generateAuthorizationSignature({ input, authorizationPrivateKey: `wallet-auth:${pkcs8}` })}`,
  )
  console.log("")
}
console.log(`public key (SPKI DER, base64): ${spki}`)
