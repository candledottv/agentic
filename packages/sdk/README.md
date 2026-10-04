# @candledottv/agent-sdk

A typed TypeScript SDK for the Candle agent rail. It wraps the REST surface documented in
[Headless launch](https://docs.candle.tv/developers/headless-launch) and
[Agent trading](https://docs.candle.tv/developers/agent-trading) (launches, jobs, dry runs, trades,
swaps, market state, quotes, feeds, verification, presets, plans, P&L, agent profiles, image
uploads), ships the webhook signature verifier, and drives the client-side HPKE seal behind
linked-wallet import, so an agent integrates against typed methods instead of hand-rolled HTTP.
The full guide is [TypeScript SDK](https://docs.candle.tv/developers/sdk).

Built on the global `fetch`; runs on Bun and Node 18+. Five runtime dependencies:
`@hpke/core`, `@hpke/chacha20poly1305` and `@scure/base` power `importWallet()`'s client-side
HPKE seal and base58 decode (see "Importing a wallet" below), and `canonicalize` and
`@noble/hashes` build the payloads a key signer signs (Privy authorization signatures and
Hyperliquid actions). The one `node:` builtin used is `node:crypto` (webhook
verification only), which Bun also provides. Edge runtimes without `node:crypto` would need a
Web Crypto port of the verifier; that is a deliberate later concern.

```bash
npm i @candledottv/agent-sdk
```

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

`launch()` works on every plan, Free included: it launches from the account's embedded wallet,
and `buyAmount` adds an optional dev buy: in the launch transaction on Solana (up to 0.5 SOL by default), a best-effort follow-up transaction on Hood.

Two more paths need the Pro or Max plan. `selfLaunch()` launches from a linked or TEE wallet the
agent signs for locally. `launchAtomic()` lands the launch and 1 to 4 first buys in one Jito bundle: several
transactions in the same block, all or none. Each buy is paid by the embedded wallet or a linked
wallet (never a TEE wallet); the same payer may fund more than one leg.

## Trading, swaps and account reads

```ts
const fill = await candle.trade({ mint: "9dXSV8...CNDL", side: "buy", amountRaw: "200000000", from: "main" })
// fill.amounts.expectedOutRaw is the quote; fill.amounts.actualOutRaw is what arrived (Solana only)
```

- `trade()` buys or sells a token in one call, from the account's embedded wallet (executed inline)
  or from a linked wallet the caller signs for. Amounts are raw units. On Solana,
  `amounts.actualOutRaw` is the delivered amount, decoded from the payer's balance change; book
  positions from it rather than from `expectedOutRaw`. It is absent on Hood.
- `swap()` converts base assets (`SOL`, `USDC`, `CNDL`, `ETH`, `USDG`); a pair that spans Solana
  and Hood is a bridge.
- `getPlans()` (no key) returns every plan's price, fees, limits and capabilities as the server
  serves them.
- `getPortfolio()`, `getProfilePnl(keyPrefix)`, `getProfileTrades(keyPrefix)` and
  `getSpendLimits()` read the account's holdings, a profile's P&L and fills, and this key's caps.
- `closeEmptyAccounts()` closes the embedded wallet's empty token accounts and returns the rent.
- The `perps*` methods (`perpsSetup`, `perpsOpen`, `perpsClose`, `perpsOrders`,
  `perpsPositions`, ...) drive Hyperliquid perps.

Limit orders are a REST surface only (`/api/v1/trade/agent/orders`); the SDK has no method for
them.

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
  // event is one of the sixteen the endpoint subscribed to: launch.confirmed, trade.executed,
  // order.triggered, transfer.executed, key.access_widened, ... (see the Webhooks docs page)
  return new Response("ok")
}
```

The verifier never throws: malformed headers, stale timestamps, wrong secrets, and tampered
bodies all return `false`. Comparison is constant-time (`timingSafeEqual`).

## Errors

Every non-2xx response throws `CandleApiError` with `code`, `status`, `retryable`, and
(for field-level validation) `field`, plus `routing`, `discovery`, `coverage`, `uiHint` and
`docsPath` when the envelope carries them. Structured envelopes map straight through; the few
legacy endpoints without envelopes (activity, users) surface as `code: "HTTP_<status>"`. A
Solana or EVM JSON-RPC failure throws `JsonRpcError`, with the RPC's numeric `code` and its
`data` (for a failed simulation, `{ err, logs }`). The full code table is on
[Headless launch](https://docs.candle.tv/developers/headless-launch).

## Development

```bash
bun test          # pure tests against an injected fake fetch; no server, no network
bun run typecheck # tsc --noEmit
```

### Hyperliquid per-key PnL

`candle pnl --profile <name>` / SDK `getProfilePnl(keyPrefix)` / MCP `candle_get_profile_pnl`
read the existing `GET /api/v1/agent/keys/{prefix}/pnl`. The answer adds an optional
`hyperliquid` section, and the CLI prints it under **Hyperliquid**. The existing read
authentication applies; on an older API the section is simply absent. No additional signing, deposit or setup is needed for this read.

The section reports main-exchange perp `realizedGrossUsd` (venue `closedPnl`), signed
`fundingUsd` (received positive, paid negative), `feesUsd` (venue fees including builder fees;
rebates are negative), and `realizedNetUsd = realizedGrossUsd + fundingUsd - feesUsd`.
Builder fees are already included in the venue fee and are not subtracted again. These figures
stay separate from spot and LP totals and exclude unrealized perps, deposits and withdrawals.

Coverage is **currently bound EVM TEE wallets since the current TEE binding**,
shown in `byWallet` with `startTime` in epoch milliseconds. That start is the latest rebind
onto this key, or the wallet's creation time when it was bound then and never rebound. A
rebound wallet does not bring its previous key's history. A wallet-set row is not required,
and an older one cannot move the start earlier than the binding. Revoked and previous
bindings, spot and HIP-3 fills are excluded. This is a binding-period read, not lifetime or
order-level attribution.

Reads use the venue client's two-second cache. `userFills` is capped at 2,000 recent rows;
`userFunding` at 500 rows from `startTime`, and this response covers at most 20 bound
wallets. `truncated` flags any reached history cap or remaining wallet page; `byWallet` names
`fillsTruncated` and `fundingTruncated`. Funding and fills can cover different time spans when
capped: a partial net must not be quoted as a lifetime figure. On upstream, wallet-discovery or
malformed-data failure the section is `{ read: false, reason }`, without amounts; spot PnL still
answers. An empty successful read is `{ read: true, ... }` with zero amounts. `--json` preserves
the section and its coverage fields. Agent boards are outside this slice.
