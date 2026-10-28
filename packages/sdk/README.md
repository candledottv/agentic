# @candledottv/agent-sdk

A typed TypeScript SDK for the Candle agent rail. It wraps the REST surface documented in
[Headless launch](https://docs.candle.tv/developers/headless-launch) and
[Agent trading](https://docs.candle.tv/developers/agent-trading) (launches, jobs, dry runs, trades,
swaps, market state, quotes, feeds, verification, presets, plans, P&L, agent profiles, image
uploads), ships the webhook signature verifier, and drives the client-side HPKE seal behind
linked-wallet import, so an agent integrates against typed methods instead of hand-rolled HTTP.
The full guide is [TypeScript SDK](https://docs.candle.tv/developers/sdk).

Built on the global `fetch`; runs on Bun and Node 18+. Six runtime dependencies:
`@hpke/core`, `@hpke/chacha20poly1305` and `@scure/base` power `importWallet()`'s client-side
HPKE seal and base58 decode (see "Importing a wallet" below), `canonicalize` and
`@noble/hashes` build the payloads a key signer signs (Privy authorization signatures and
Hyperliquid actions). The one `node:` builtin used is `node:crypto` (webhook
verification only), which Bun also provides. Edge runtimes without `node:crypto` would need a
Web Crypto port of the verifier; that is a deliberate later concern. `undici` supplies the
header-capable WebSocket `client.perpsStream()` opens through on Node 18 and 20, which ship no
global one (Bun and Node 22+ use their global WebSocket; pass `perpsStreamWebSocket` in
`CandleClientOptions` to inject your own).

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
const events = await candle.getTokenEvents("solana", "So11...mint", { kind: "signal", since: "2026-10-28T00:00:00Z" })
const verdict = await candle.verify("hood", "0xToken")

// Presets: fetch once, expand locally into a launch body.
const presets = await candle.getPresets()
const request = candle.expandPreset(presets, "solana-open-sol", {
  name: "Trend Coin",
  symbol: "TREND",
  imageUrl: "https://example.com/logo.png",
})
```

The API key is attached as `x-api-key` when configured, except on public `tokenPages` reads. The keyed methods
(`launch`, `launchAsync`, `dryRunLaunch`, `getLaunchJob`, `reportActivity`, `uploadImage`)
refuse to fetch without one and throw a plain `Error` locally instead of a server 401.

## Token page About (unreleased source)

`candle.tokenPages` reads About and immutable section history, and submits claims, section edits,
restores and flags. These methods need a human-owned SDK release before they are available in the
published package. Token page switches default off; a server can return `404` or `feature_off`.

| Method | Access | Result |
| --- | --- | --- |
| `about(token)` | Public, no key sent | `TokenAbout`, with public feature switches |
| `burns(token, { cursor, limit })` | Public, CNDL only | `AboutBurnHistory` |
| `history(token, section, { cursor, limit })` | Public, no key sent | `AboutHistory`, including tombstones |
| `capabilities(token)` | `token-pages:read` | Private `AboutCapabilities` |
| `creatorChallenge(token)` | `token-pages:write` | Exact message, challenge ID and expiry |
| `claim(token, body, options)` | `token-pages:write` | Claim result and idempotency key |
| `setSection(token, section, body, options)` | `token-pages:write` | New version ID/revision and idempotency key |
| `restoreSection(token, section, body, options)` | `token-pages:write` | New version ID/revision and idempotency key |
| `flag(token, body, options)` | `token-pages:write` | Flag result and idempotency key |

The token is `{ chain: "solana" | "hood", address: string }`; sections are `thesis`, `tokenomics`
and `lore`. History and burn pagination accepts a returned opaque cursor and a limit from 1 to 50.
Revisions and raw amounts remain strings. Reads bypass caches; capabilities are never folded into
public About. Hidden/removed history bodies stay null. The API validates strict bodies, text limits,
fresh eligibility and restrictions on every write. Existing keys gain no scope automatically.
Claim/edit/restore require 0.5% of current supply; any positive eligible balance can flag.

```ts
const token = { chain: "solana" as const, address: mint }
const about = await candle.tokenPages.about(token)
const capabilities = await candle.tokenPages.capabilities(token)
// Persist this key and the draft before sending; a rerun must reuse both.
const idempotencyKey = crypto.randomUUID()
if (about.features.edit && capabilities.canEdit) {
  const saved = await candle.tokenPages.setSection(token, "thesis", {
    text: "Our thesis",
    baseRevision: about.sections.thesis?.revision ?? "0",
  }, { idempotencyKey })
  console.log(saved.data.revision, saved.idempotencyKey)
}
```

Claim explicitly with `{ kind: "holder" }` or `{ kind: "creator", challengeId?, signature? }`.
A known creator may need no additional signature. Otherwise call `creatorChallenge`, sign the exact
UTF-8 message locally and pass its challenge ID and signature in a separate creator claim. Solana
signatures use base64; Hood uses the 65-byte `0x` message signature. No method signs, creates a
transaction, requests a private key, implicitly claims or automatically restores on conflict.
Challenges are attempted once and expire after five minutes.

Restore takes `{ versionId, baseRevision }` and appends a new version; it never rewrites history.
Flag takes `{ contentId, reason, detail? }` for an exact version, with reason `spam`, `scam`, `abuse`,
`misleading`, `unsafe_link` or `other`. Restoring a removed/unsafe version is refused.

Every content write sends `Idempotency-Key` from `options.idempotencyKey` or a generated UUID and
returns `{ data, idempotencyKey }`. A connection or interrupted-body failure retries once with the
same key and serialized body. HTTP refusals are not retried. `TokenPageError` extends `CandleApiError`:
branch on `code` and `status`, retain `idempotencyKey`, inspect `latest` for `revision_conflict`, and
respect `retryAfterHeader` on rate limits. Two missing answers or an invalid success produce
`OUTCOME_UNKNOWN`; explicitly replay the same request/key to recover its result. A conflict leaves
the caller's draft untouched. Feature-off, missing scope/auth, insufficient holding, expired/replayed
proof, unsafe text, unavailable eligibility and old-server errors remain refusals for the caller to
handle. Do not log content bodies, credentials or creator signatures.

## Embedded launches with built-in idempotent retries

`launch()` fills in a `clientLaunchId` (`"sdk-" + crypto.randomUUID()`) when you omit one, and
retries transient failures by re-sending the SAME id, which the server's idempotency ledger
resolves safely: no double mint inside one `launch()` call. That holds only inside the call. A
second `launch()` call with no id is a new launch under a new id, so to retry after `launch()`
throws, pass the id back: see "Retrying a write that failed or timed out" below. Retries cover
network errors, non-envelope 5xx responses, retryable 5xx envelopes, and the retryable in-flight
409; a non-retryable envelope (validation errors, an id reused with a different body,
`LAUNCH_DISABLED`) is thrown immediately. Backoff is 250ms doubling per attempt, jittered, capped
at 8s, bounded by `maxRetries` (default 3).

```ts
import { CandleApiError } from "@candledottv/agent-sdk"

try {
  const result = await candle.launch({
    name: "Trend Coin",
    symbol: "TREND",
    imageUrl: "https://example.com/logo.png",
    chain: "solana",
    buy: "0.1", // SOL
  })
  console.log("minted", result.mint, "explorer:", result.links.explorer, "id:", result.clientLaunchId)
} catch (error) {
  if (error instanceof CandleApiError) {
    // Branch on code, never on message. error.status, error.retryable, error.field ride along.
    // error.clientLaunchId is the id this call sent: keep it for the retry.
    console.error("launch failed:", error.code, error.clientLaunchId)
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

`launch()` with an embedded wallet works on every plan, Free included. `buy` adds an optional
first buy: atomic on Solana (up to 0.5 SOL by default), a best-effort follow-up on Hood.

A TEE wallet passed to `launch()` needs Pro or Max and the agent signs locally; the deprecated
`selfLaunch()` follows the same path. `launchAtomic()` lands the launch and 1 to 4 first buys in one Jito bundle: several
transactions in the same block, all or none. Each buy is paid by the embedded wallet or a linked
wallet; the same payer may fund more than one leg. A TEE wallet can be the creator or a buyer, and
A TEE `launch()` can carry `buy`, only where the server has
`TEE_LAUNCH_BUYS_ENABLED` on. It is off by default, and a TEE wallet is refused there until it is.

## One launch method

`launch()` and `dryRunLaunch()` take the shared generated launch fields. Omit `wallet` or use
`wallet: "embedded"` to pay from the account's embedded wallet. Name a TEE wallet by label, id or
address, or pass `{ linkedWalletId, privyWalletId }` for an existing SDK integration. A named
wallet's chain is inferred; supply `chain: "hood"` for an explicit Hood wallet object. Conflicting
chains or quote assets are refused before building. The SDK uses your configured `privyAppId`
and `secretStore` for TEE signing, and `solanaRpcUrl` / `evmRpcUrl` for caller broadcasts.

```ts
await candle.launch({
  wallet: "spider-01",
  name: "Trend Coin",
  symbol: "TREND",
  imageUrl: "https://example.com/logo.png",
  buy: "0.1", // optional, whole units of the quote asset (SOL by default)
})
```

`buy` is a decimal string: SOL has 9 decimals, USDC/CNDL/USDG 6, ETH 18. Empty or zero means no
first buy. Excess precision and passing both `buy` and deprecated raw `buyAmount` are refused
locally. `socials` accepts only `website`, `twitter`, `telegram` and `discord`, each an http(s) URL.
The remaining limits, defaults and field help come from the shared launch definition; the server
validates ranges and eligibility.

Embedded launches use `/launch/headless` with or without a buy. TEE launches use `/launch/self/build`
and the existing sign/broadcast/confirm flow; a Solana TEE buy signs the returned bundle and sends
it to `/launch/atomic/submit`. Dry runs use the selected family's `/dry-run`. Existing server
gates still apply: embedded-wallet allowance, launch availability, and TEE tier, `allowLaunch`
and first-buy switches. No server switch is enabled by this SDK release. `launchAsync()` remains
embedded-only.

Migration for this release: replace `selfLaunch({ linkedWalletId, privyWalletId, ...fields })`
with `launch({ wallet: { linkedWalletId, privyWalletId }, ...fields })`. Replace raw `buyAmount`
with whole-unit `buy`. `selfLaunch()`, `buildSelfLaunch()` and `dryRunSelfLaunch()` are deprecated
for one release; existing calls still work. `confirmSelfLaunch()` remains the recovery method.
TEE `launch()` preserves `SelfLaunchOutcomeError` on Hood: after a create-curve broadcast,
recover by confirming its original id and hashes, never by starting another launch. Embedded
launch retries and Solana same-id recovery retain their existing behavior.

## Trading, swaps and account reads

```ts
const fill = await candle.trade({ mint: "9dXSV8...CNDL", side: "buy", amountRaw: "200000000", from: "main" })
// fill.amounts.expectedOutRaw is the quote; fill.amounts.actualOutRaw is what arrived (Solana only)
```

- `trade()` buys or sells a token in one call, from the account's embedded wallet (executed inline)
  or from a linked wallet the caller signs for. Amounts are raw units. On Solana,
  `amounts.actualOutRaw` is the delivered amount, decoded from the payer's balance change; book
  positions from it rather than from `expectedOutRaw`. It is absent on Hood.
- `getTradeJob(clientTradeId)` reads one trade from the idempotency ledger without sending
  anything: the read to make after a `trade()` that threw or timed out. Needs `swap:write`.
- `swap()` converts base assets (`SOL`, `USDC`, `CNDL`, `ETH`, `USDG`); a pair that spans Solana
  and Hood is a bridge.
- `getPlans()` (no key) returns every plan's price, fees, limits and capabilities as the server
  serves them.
- `listAgents({ sort, strategy, query, limit, cursor })` (no key) reads the agent directory: every
  published agent with its strategy, declared models, all-time P&L and trade and launch counts,
  including one that has never traded. `sort` is `newest`, `active` or `pnl`.
- `getPortfolio()`, `getProfilePnl(keyPrefix)`, `getProfileTrades(keyPrefix)` and
  `getSpendLimits()` read the account's holdings, a profile's P&L and fills, and this key's caps.
- `fees.list()` and `fees.claim(mint, { dryRun })` read what the account's launched tokens can pay in creator fees and claim it to the wallet fixed at launch (off until the server enables it).
- `closeEmptyAccounts()` closes the embedded wallet's empty token accounts and returns the rent;
  with `wallet` and `privyWalletId`, a Solana TEE wallet's, signed through `signLinkedTransaction()`.
- The `perps*` methods (`perpsSetup`, `perpsOpen`, `perpsClose`, `perpsOrders`,
  `perpsPositions`, ...) drive Hyperliquid perps.

Perps setup and signing use this release's builder pin,
`0xc43ff1f6ad9f93fc94558e07c2071b8458e7470b`, independently of the API.
`hyperliquidBuilder` deliberately replaces that trust anchor with an explicit nonzero EVM
address; empty or invalid overrides refuse rather than fall back. The local
`preview.builderTrust` records the expected address and whether it came from the release or
an override. Setup answers (including `ready`) and fee-bearing actions naming another builder
are refused before signing. Builder rotation requires a reviewed client release.

Limit orders are a REST surface only (`/api/v1/trade/agent/orders`); the SDK has no method for
them.

## Retrying a write that failed or timed out

Six methods send an idempotency id, and generate one (`"sdk-" + crypto.randomUUID()`) when you
pass none: `trade()`, `launch()`, `launchAsync()`, `selfLaunch()`, `buildAtomicLaunch()` and
`launchAtomic()`. The server treats that id as the whole identity of the operation: the same id
is a replay, and a new id is a second, independent trade or launch. A call that does not come
back with a normal answer (a lost response, a proxy timeout, a 5xx) may still have executed, so
what you do next depends on having the id.

1. **Pass your own id for anything that moves funds, and store it before the call.** An error can
   carry the id only if the process is still running to catch it. A crash or a kill mid-call
   leaves nothing, and only an id you stored first survives that.
2. **If you did not, read the id from the result or the error**, and send it back on the retry
   with the same request body. Every one of the six methods exposes the id it sent on every
   outcome: on the result (`result.clientTradeId`, `result.clientLaunchId`) and on every error
   thrown after its first request was sent (`operationIds(error)`). This is the whole procedure
   for the flows Candle executes. For `selfLaunch()` and a linked `trade()` it is not enough: see
   below.
3. **Never retry without the id.** A call with no id, or a new one, is a second trade or launch.
   The SDK does not remember ids between calls and adds no retry of its own to `trade()`,
   `selfLaunch()` or `launchAtomic()`; only `launch()` retries, inside its one call.

What the error is:

| The method threw | Class | The id |
| --- | --- | --- |
| a Candle error response | `CandleApiError`, unchanged | `error.clientTradeId` or `error.clientLaunchId`, and `error.bundleId` from `launchAtomic()` once its build answered |
| a JSON-RPC failure from a broadcast | `JsonRpcError`, unchanged | the same fields |
| a Hood trade whose fee leg failed after the trade landed | `TradeLandedFeeLegError`, unchanged | `error.clientTradeId` |
| anything else after the first request was sent: a rejected `fetch`, a 2xx body that is not JSON, a plain `Error` from one of the method's own steps | `CandleOperationError`, with the original as `error.cause` | the same fields |
| an error before anything was sent, such as no API key | the plain error | none: nothing reached the server, so there is nothing to replay |

`operationIds(error)` returns `{ clientTradeId?, clientLaunchId?, bundleId? }` from any of these and
`{}` from anything else, so a `catch (error: unknown)` block needs no cast. The ids are not secrets
and may be logged. A `CandleOperationError`'s message starts with the original message, names the
id, and says what to do with it.

**Changed in 0.5.0:** a transport or local failure from these six methods used to surface as the
raw error (a `TypeError` from `fetch`, for example). It is now a `CandleOperationError` with the
original as `error.cause`. Code that matched `error instanceof TypeError` or
`error.name === "AbortError"` on these calls should read `error.cause`. `launch()`, `selfLaunch()`,
`confirmSelfLaunch()` and `buildAtomicLaunch()` results gained `clientLaunchId`, and
`launchAtomic()` returns `LaunchAtomicResult`, its old result plus `clientLaunchId`.

A main-payer trade (`from: "main"`), where the retry is safe once you have the id:

```ts
import { operationIds } from "@candledottv/agent-sdk"

try {
  return await candle.trade(req)
} catch (error) {
  const { clientTradeId } = operationIds(error)
  if (!clientTradeId) throw error // nothing was sent
  return await candle.trade({ ...req, clientTradeId }) // from: "main" only: a replay, not a second trade
}
```

This example is for a main payer. For linked Hood recovery, see the table below. For a linked Solana payer or `selfLaunch()`, a same-id call can
broadcast again.

### `trade()`

With the id: read `getTradeJob(id)`, or call `trade()` again with the same id and body. Both are
safe for a main payer.

| The job read says | Meaning | Do |
| --- | --- | --- |
| 404 `JOB_NOT_FOUND` (thrown as `CandleApiError`) | the write never began | call again with the same id |
| `confirmed` | the trade landed; `signature` is on the job | stop. A same-id `trade()` replays the result |
| `failed`, `errorCode: "TRADE_REVERTED"` | it landed and reverted | a new trade needs a new id |
| `failed`, other | not confirmed. A row with broadcast evidence may still be on chain, and a same-id call answers `stage: "unconfirmed"` for it. The same-id call is the check | call again with the same id |
| `built` | in flight or unresolved | a same-id `trade()` answers `IDEMPOTENCY_CONFLICT`. If it carries `stage: "unconfirmed"` and `retryable: false`, check its `signature` on chain and do not retry |

### Embedded `launch()`, `launchAsync()`

Retry with the same `clientLaunchId` and body, or read `getLaunchJob(id)` (`waitForLaunch(id)`
polls it). The rules are the ones under "Idempotency" in
[Headless launch](https://docs.candle.tv/developers/headless-launch#idempotency); what is new is
that you always have the id.


### Non-TEE Hood linked trade recovery

Once any leg is signed, a same-id build is refused: it does not rebuild or broadcast a second trade.
The sign relay records each signed transaction's hash and nonce. Builds and job reads resolve
receipts when asked; there is no background resolver. Error `legs` and job `signedLegs` list every
consumed claim across builds, in build/leg order, as `{ leg, hash?, nonce?, outcome }`.
An older claim without a leg label is conservatively treated as the trade leg.

| Build answer | Meaning and recovery |
| --- | --- |
| 500 `SWAP_FAILED`, `chain_read_failed`, retryable | The chain read failed; retry with the same id. |
| 409 `IDEMPOTENCY_CONFLICT`, `prior_attempt_on_chain`, not retryable | The trade landed. Read the job: for a still-`built` row, call `confirmTrade` with `signature` as `tradeTxHash` and the fee leg hash from `legs`. Pay a fee that did not land first, following `TradeLandedFeeLegError`. For a `failed` row, this id cannot be recorded with `/confirm`; do not retry or rebuild. Retain all hashes for the restoration follow-up. |
| 409 `TRADE_REVERTED`, `stage: reverted`, not retryable | Every consumed, not refused trade leg has a reverted receipt. This id is settled; a new trade needs a new id. Other builds' open claims are not retired by this answer. |
| 409 `IDEMPOTENCY_CONFLICT`, `sign_claim_in_flight`, retryable | The relay is asking Privy. Retry after `retryAfter`, bounded at two minutes from that claim's consume. |
| 409 `IDEMPOTENCY_CONFLICT`, `prior_attempt_in_flight`, retryable | A signed trade or approval has no final answer. Retry after `retryAfter`, within 180 seconds of the newest consumed, not refused claim across this id's builds and legs. |
| 409 `IDEMPOTENCY_CONFLICT`, `prior_attempt_unprovable`, not retryable | The hash is missing, the signed transaction has no receipt after that window, or retirement cannot be proved. It can still land; inspect the wallet and hashes. Do not retry or rebuild. |
| 409 `IDEMPOTENCY_CONFLICT`, `prior_attempt_lapsed`, not retryable | A signed transaction's nonce was used and no receipt was found. Check every hash. Do not retry or rebuild from this answer; another leg can still land, and open claims were not retired. |
| 409 `IDEMPOTENCY_CONFLICT`, `prior_attempt_approval_only`, `stage: not_broadcast`, not retryable | No swap was signed. The build transactionally retired its open claims, so the old artifact cannot be signed. Use a new id. Later builds repeat this answer unchanged. Job reads never retire claims. |

A revert beside a pending, forwarding, unknown or lapsed trade leg follows that unsettled leg's
answer, with the revert still in `legs`: it is not `TRADE_REVERTED` and does not advise a new id.
Lapsed beside reverted stores no reverted trade-row outcome. A later visible receipt can change the
answer to landed, or to reverted once every eligible trade leg has a reverted receipt.

SDK 0.6.0 exports `TradeLegOutcomeError` for a non-fee Hood leg failure when a hash exists:
`clientTradeId`, `leg`, `outcome`, `txHash?`, `landedLegs`, and the original `cause`.
Inspect the hashes, then call `trade()` with the same id and body, or read `getTradeJob(id)`,
for Candle's view. Never retry an id after a `retryable: false` answer.
A first leg failure before signing retains the original error behavior.
`TradeLandedUnconfirmedError` means all legs landed but confirmation failed; it keeps
`tradeTxHash`, `feeTxHash?`, `clientTradeId`, `stage: executed`, and `cause`.
Read the job before another `confirmTrade`; a failed row cannot be booked with `/confirm`.
`operationIds()` handles both errors. `CandleApiError` exposes `reason`, `retryAfter` and `legs`.

### `selfLaunch()` and a linked Solana `trade()`

You sign and broadcast in these flows, so the id is necessary and **not** sufficient. An error
after the broadcast may sit on a transaction that landed. So a `CandleOperationError` from these
flows does not tell you to retry with the id. Read the job first (`getLaunchJob(id)`,
`getTradeJob(id)`); if it is not `confirmed`, check the wallet's recent transactions before
sending again.

For a linked Solana `trade()`, and for `selfLaunch()` on Hood, calling the method again under the same
id builds and broadcasts a new transaction.

`selfLaunch()` on Solana does not build a second launch. One id has one build at a time:

- While the first transaction can still land, the server returns that same transaction again.
  The sign relay signs a build once, so a second `selfLaunch()` call throws instead of launching
  again. Broadcast what was signed, or wait until it has expired.
- Once it has landed, the build is refused with `IDEMPOTENCY_CONFLICT` and
  `error.reason: "prior_attempt_on_chain"`. Record it with
  `confirmSelfLaunch({ clientLaunchId, signature })`, taking the signature from the wallet's
  recent transactions. This keeps working after the build's `expiresAt`.
- A new transaction is built only after the chain proves the first one can never land.

Inside one `selfLaunch()` call, a blockhash error from your Solana RPC is retried with the bytes
already signed. They are signed again only when the server returns a different transaction.

`selfLaunch()` on Hood throws a `SelfLaunchOutcomeError` when the create-curve transaction was
mined and the fee transfer or the confirm then failed. The curve exists: never call
`selfLaunch()` or `buildSelfLaunch()` again for that attempt, under the same id or a new one.
The error keeps `clientLaunchId`, `createCurveTxHash`, `step` (`feeTransfer` or `confirm`),
`feeOutcome`, every known `feeTxHash`, and the original error as `cause`. `stage: "executed"`
means the curve landed, not that Candle recorded the launch.

| `step`, `feeOutcome` | Recovery |
| --- | --- |
| `confirm`, `landed` or `not-required` | Read `getLaunchJob(id)`; the answer may have been lost after booking. If it is not `confirmed` and `cause` allows it, call `confirmSelfLaunch({ clientLaunchId, signature: createCurveTxHash, feeTxHash? })` with the same hashes. |
| `feeTransfer`, `unknown` | The fee may have paid. Do not pay again. Check `feeTxHash` and the payer's history, then confirm with that hash once the fee is verified. |
| `feeTransfer`, `not-broadcast` or `reverted` | The fee did not pay. Pay only the missing fee of the original build, then confirm with the create-curve hash and the successful fee hash. |

An error from before the create-curve receipt is unchanged and keeps no hash.
`operationIds()` reads the id from a `SelfLaunchOutcomeError`, and it is never wrapped in a
`CandleOperationError`.

### `launchAtomic()`

`launchAtomic()` returns `timeout` and `failed` as values, not errors, and each carries
`clientLaunchId`. `bundleId` is dead once `/submit` has been called and is never resubmitted; it
is on the result and the error for log correlation only. The launch's identity is
`clientLaunchId`. After a `timeout` result, a `failed` result, or an error that carries
`clientLaunchId`:

1. Read `getLaunchJob(clientLaunchId)`. This needs `launch:read` on the key. The Write and
   Withdraw access levels hold it; a key whose scopes were named one by one holds it only if it
   was named, so add `launch:read` to any key that runs atomic launches. A scope refusal
   (`SCOPE_MISSING`) is not "not found".
2. `confirmed`: the bundle landed. The mint is on the job. Stop.
3. 404 `JOB_NOT_FOUND`: the build never began. Call `launchAtomic()` again with the same id.
4. `failed`: the bundle did not land. Call `launchAtomic()` again with the **same** id; the server
   starts a clean attempt under it.
5. Any other status: the bundle may still land. Wait, then either read the job again or call
   `launchAtomic()` again with the **same** id and the same body. The server resolves the first
   attempt before doing anything new. It answers 409 `IDEMPOTENCY_CONFLICT` while the first
   attempt is unresolved or has just been found landed, so on that 409 read the job again. It
   builds a fresh bundle only when the first is proven reverted.
6. **Never send a new id while the job is not `failed`.** That is the one path the server cannot
   refuse, and it is a second token. This includes the 409 whose message says "use a new
   clientLaunchId to launch again": read the job first, because that message is also what you see
   for a launch you do not yet know landed.
7. One state has no terminal answer today. For an attempt whose blockhash expired with no
   signature on record, the same-id `launchAtomic()` keeps answering 409 `IDEMPOTENCY_CONFLICT`,
   "This launch was sent; its original attempt must be resolved", and the job read is still
   neither `confirmed` nor `failed`. Treat it as this state when that remains true well after the
   bundle's blockhash must have expired: a Solana blockhash lives about 90 seconds and a same-id
   rebuild can itself take about 95 seconds, so a few minutes after the submit. Then stop. Do not
   send a new id on a timer; report the `clientLaunchId` and `bundleId` to whoever operates the
   key.
8. Treat every `timeout` as unresolved. `retryable` is `false` on every `timeout` the server
   returns today, and it is never permission to relaunch under a new id.

A same-id rebuild can take up to about 95 seconds to answer, because the server waits on the
chain, and a submit can take up to about 160 seconds. Set no client-side timeout shorter than
that on these calls.

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
`data` (for a failed simulation, `{ err, logs }`). The one-call write methods also put the
idempotency id they sent on these errors, and wrap any other failure in `CandleOperationError`:
see "Retrying a write that failed or timed out" above. The full code table is on
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

The section reports main-exchange perps for **every EVM TEE wallet bound to the key's profile,
per binding period** (`coverage: "profile"`; revoked, swept and rebound wallets included for the
time they were the profile's). `realizedGrossUsd` is the venue `closedPnl`, `fundingUsd` is
signed (received positive, paid negative), `feesUsd` is venue fees including builder fees
(rebates are negative), and `realizedNetUsd = realizedGrossUsd + fundingUsd - feesUsd`. Builder
fees are already included in the venue fee and are not subtracted again. `unrealizedUsd` is the
open positions' unrealized at each wallet's cutoff, `netUsd = realizedNetUsd + unrealizedUsd`
(both USD decimal strings), and `positions` lists the open positions, each with
`fundingNetUsd` positive when earned. Deposits and withdrawals are not P&L.

Facts and unrealized stop at the same cutoff per wallet. For a wallet still bound to the
profile, the cutoff is Hyperliquid's position time at this read: the fills and funding since the
wallet's last stored snapshot are read through that time and must reconcile with the positions
(each fill continues the previous position, the positions match, and every open hour has its
funding row). That wallet's `byWallet` entries say `reconciliation: "live"`, and the CLI prints
"(live, not yet settled)". A wallet whose binding to the profile ended before its last stored
snapshot is `settled`. `markedAt` is the oldest wallet cutoff, `completeThroughMs` the lowest
completeness watermark, and `perpsSnapshotId` identifies the cutoff vector. "Reconciled" is not
"complete": a round opened and closed between two fills Hyperliquid never returned cannot be
seen.

The net is **also counted in the total**: when `read` is true, `pnl.totalUsd` includes `netUsd`
and the answer's `perpsInTotal` is `true`; the CLI's `Total` line says it includes Hyperliquid.
When the section cannot be read or reconciled within the request's Hyperliquid budget, it is
`{ read: false, code, reason }` without amounts, `pnl.totalUsd` is the spot total,
`perpsInTotal` is `false`, and the CLI says the total excludes perps and why. Never a zero.
`historyPartial` (and `partialReasons`) flags history the stored record does not cover;
`truncated` repeats it for older CLIs. At most 20 wallets are read. `--json` preserves the
section and its coverage fields. Agent boards are outside this slice.


## CNDL staking

Solana staking is available through the agent rail while the deployment enables it (off by
default). There is no instant unstake. Read the pool wait and wallet eligibility notes first:
pending withdrawal CNDL counts toward nothing for Pro; sCNDL in any eligible account wallet
counts toward Pro and earns the account's Hood reward, except a wallet another account also
claims, wallets past the 200-wallet cap, and an account with no EVM wallet.

Use `client.staking.positions()`, `.stake({ amountRaw, clientStakeId, dryRun })`,
`.unstake({ amountRaw, clientStakeId, dryRun })`, `.finish({ withdrawal, clientStakeId, dryRun })`
and `.claimReward(rewardId)`. Builds default to the embedded wallet and MOVE REAL FUNDS after
approval. `payer: "linked"` with `linkedWalletId` returns a build for external/TEE signing;
`.submit({ clientStakeId, signedTransaction })` or `.confirm({ clientStakeId, signature })`
records its landing. Preserve the unstake's withdrawal co-signature. Reuse the same operation id
and body on retry; reward retries use the same rewardId. Amounts are raw CNDL on stake and raw
sCNDL on unstake.
