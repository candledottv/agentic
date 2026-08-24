# @candledottv/agent-sdk

A typed TypeScript SDK for the Candle agent rail. It wraps the REST surface documented in
`docs/headless-launch.md` (headless launches, jobs, dry runs, market state, quotes, feeds,
verification, presets, agent profiles, image uploads), ships the webhook signature verifier,
and drives the client-side HPKE seal behind linked-wallet import, so an agent integrates
against typed methods instead of hand-rolled HTTP.

Built on the global `fetch`; runs on Bun and Node 18+. Three runtime dependencies --
`@hpke/core`, `@hpke/chacha20poly1305`, and `@scure/base` -- exist solely to power
`importWallet()`'s client-side HPKE seal and base58 decode (see "Importing a wallet" below);
nothing else in the SDK needs them. The one `node:` builtin used is `node:crypto` (webhook
verification only), which Bun also provides. Edge runtimes without `node:crypto` would need a
Web Crypto port of the verifier; that is a deliberate later concern.

> **Not yet published to npm.** Publishing `@candledottv/agent-sdk` (and `@candledottv/mcp`)
> is the post-Phase-2 follow-up. Until then, consume it as a workspace package:
> `import { CandleClient } from "@candledottv/agent-sdk"`.

## Quick start

```ts
import { CandleClient } from "@candledottv/agent-sdk"

const candle = new CandleClient({
  apiUrl: "https://api.alpha.candle.tv",
  apiKey: process.env.CANDLE_AGENT_API_KEY, // cndl_live_... / cndl_test_...
})

// Public reads need no key.
const market = await candle.getMarket("solana", "So11...mint")
const quote = await candle.getQuote("solana", "So11...mint", { side: "buy", amountIn: "1000000000" })
const feed = await candle.getFeed("new", "solana")
const verdict = await candle.verify("hood", "0xToken")

// Presets: fetch once, expand locally into a launch body.
const presets = await candle.getPresets()
const request = candle.expandPreset(presets, "solana-open-sol", {
  name: "Trend Coin",
  symbol: "TREND",
  imageUrl: "https://example.com/logo.png",
})
```

The API key is attached as `x-api-key` on every request when configured. The keyed methods
(`launch`, `launchAsync`, `dryRunLaunch`, `getLaunchJob`, `reportActivity`, `uploadImage`)
refuse to fetch without one and throw a plain `Error` locally instead of a server 401.

## Launching with built-in idempotent retries

`launch()` fills in a `clientLaunchId` (`"sdk-" + crypto.randomUUID()`) when you omit one, and
retries transient failures by re-sending the SAME id, which the server's idempotency ledger
resolves safely (no double mint, ever). Retries cover network errors, non-envelope 5xx
responses, retryable 5xx envelopes, and the retryable in-flight 409; a non-retryable envelope
(validation errors, an id reused with a different body, `LAUNCH_DISABLED`) is thrown
immediately. Backoff is 250ms doubling per attempt, jittered, capped at 8s, bounded by
`maxRetries` (default 3).

```ts
import { CandleApiError } from "@candledottv/agent-sdk"

try {
  const result = await candle.launch({
    name: "Trend Coin",
    symbol: "TREND",
    imageUrl: "https://example.com/logo.png",
    chain: "solana",
    buyAmount: 100_000_000, // lamports
  })
  console.log("minted", result.mint, "explorer:", result.links.explorer)
} catch (error) {
  if (error instanceof CandleApiError) {
    // Branch on code, never on message. error.status, error.retryable, error.field ride along.
    console.error("launch failed:", error.code)
  } else {
    throw error
  }
}
```

Prefer not to block? `launchAsync()` sends `async: true`, returns the 202 body, and
`waitForLaunch()` polls the jobs endpoint until the attempt is terminal:

```ts
const accepted = await candle.launchAsync({ name: "Trend Coin", symbol: "TREND", imageUrl: "https://..." })
const job = await candle.waitForLaunch(accepted.clientLaunchId, { timeoutMs: 180_000, pollMs: 2_000 })
if (job.status === "confirmed") console.log("minted", job.mint)
else console.error("failed:", job.errorCode)
```

Need a hosted image first? `uploadImage(bytes, contentType)` posts raw bytes to
`/api/v1/uploads/agent-image` and returns `{ imageUrl }`, ready for the launch body.

## Importing a wallet

`importWallet()` drives Candle's ciphertext-only wallet import end to end: it fetches Privy's
HPKE receiver public key (`/wallets/import/init`), seals the private key locally with
`encryptWalletKeyForImport()` (RFC 9180 Base mode, `DHKEM(P-256, HKDF-SHA256)` /
`HKDF-SHA256` / `ChaCha20-Poly1305`), and submits only the resulting ciphertext and
encapsulated key (`/wallets/import/submit`). **The plaintext private key never leaves the
calling process, and Candle never receives, stores, or logs it at any point** -- the server is
a ciphertext-only proxy to Privy's HPKE endpoint.

```ts
import { CandleClient, generateSignerKeypair } from "@candledottv/agent-sdk"

const candle = new CandleClient({
  apiUrl: "https://api.alpha.candle.tv",
  apiKey: process.env.CANDLE_AGENT_API_KEY,
})

// A fresh P-256 (ECDSA) signer keypair. Only the public half ever leaves this process.
const { privateKeyPem, publicKeyDerBase64 } = await generateSignerKeypair()
// privateKeyPem is yours to store and sign with later; the SDK never transmits it anywhere.

const result = await candle.importWallet({
  chain: "solana", // or "evm"
  address: "9xQe...wallet",
  privateKey: existingWalletPrivateKey, // base58 for "solana", hex ("0x"-optional) for "evm"
  signerPublicKey: publicKeyDerBase64,
  label: "trading wallet",
})
console.log("linked", result.id, result.privyWalletId)
```

`generateSignerKeypair()` generates the signer Privy registers as the imported wallet's 1-of-1
key quorum; `importWallet()` is the only place in this SDK that ever holds the wallet's
plaintext private key, and only for the duration of the local HPKE seal.

## Verifying webhooks

Candle signs every webhook delivery with
`x-candle-signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`. Verify the
RAW request body string (do not re-serialize parsed JSON; key order changes break the digest):

```ts
import { verifyWebhookSignature } from "@candledottv/agent-sdk"

// Example with a Bun/Node fetch-style handler:
async function handleWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text()
  const ok = verifyWebhookSignature(
    process.env.CANDLE_WEBHOOK_SECRET ?? "",
    req.headers.get("x-candle-signature"),
    rawBody,
    Math.floor(Date.now() / 1000),
    300, // tolerance in seconds (default)
  )
  if (!ok) return new Response("invalid signature", { status: 401 })

  const event = JSON.parse(rawBody)
  // handle launch.confirmed, launch.failed, curve.graduated, migration.completed, migration.delayed
  return new Response("ok")
}
```

The verifier never throws: malformed headers, stale timestamps, wrong secrets, and tampered
bodies all return `false`. Comparison is constant-time (`timingSafeEqual`).

## Errors

Every non-2xx response throws `CandleApiError` with `code`, `status`, `retryable`, and
(for field-level validation) `field`. Structured envelopes map straight through; the few
legacy endpoints without envelopes (activity, users) surface as `code: "HTTP_<status>"`.
The full code table lives in `docs/headless-launch.md`.

## Development

```bash
bun test          # pure tests against an injected fake fetch; no server, no network
bun run typecheck # tsc --noEmit
```
