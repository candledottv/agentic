---
name: candle-launch
description: "[TOKEN LAUNCH] Launch a new token on Candle, on Solana or Hood, optionally seeded with a dev buy bundled into the same transaction. Use when the user asks to launch, create, deploy, or seed a token."
---

## What this does

Launches a new token through Candle's headless launch API, on Solana or Hood, optionally seeding
the curve with a dev buy bundled into the launch transaction itself. The account that launches a
token becomes its on-chain creator, and Candle-launched tokens pay creator fees back to whoever
created them, on every trade against that token afterward.

## Setup

Needs an agent API key (see the candle-setup skill); the default key scopes already cover
everything here (`launch:write`, `launch:read`, `activity:write`). There is no keyless path for
launching: this always writes, and always costs a network fee unless `dryRun` is set. Point the
MCP server at staging too: the default API host is production, which doesn't serve the launch
routes yet, so set `CANDLE_API_URL=https://staging.api.candle.tv` when configuring the server
(see each platform's install doc) until the feature reaches production.

## The workflow

1. Call `candle_launch_and_seed` with `dryRun: true` first, before spending anything. It validates
   every field and, on Solana, assembles the real launch transaction (dev buy included) just to
   size-check it, so an oversized `name`/`symbol` combined with a bundled dev buy is caught here
   instead of only surfacing on the real, fee-spending launch:
   ```json
   {
     "clientLaunchId": "launch-1",
     "name": "Test Token",
     "symbol": "TEST",
     "imageUrl": "https://example.com/test.png",
     "chain": "solana",
     "devBuy": "0.25",
     "dryRun": true
   }
   ```
   `imageUrl` must be a roughly square https image. `chain` is `"solana"` or `"hood"` (defaults to
   solana); a Hood launch also needs `dexVersion` (`"v3"` or `"v4"`). `devBuy` is a DECIMAL amount
   of the launch's own quote asset (SOL on Solana, ETH on Hood, unless `quoteAsset` says
   otherwise), never a raw base-unit amount, and it is capped by a platform dev-buy ceiling: asking
   for more comes back `DEV_BUY_TOO_HIGH` before anything is spent.
2. Inspect the dry-run response's `checks`, `size`, and `resolved` fields for anything unexpected.
   The MCP relays the API's own body verbatim under `api`, so those three live at `api.checks`,
   `api.size`, and `api.resolved`, alongside the echoed `clientLaunchId` at the top level.
3. Drop `dryRun` (or set it `false`) and call `candle_launch_and_seed` again with the same body to
   actually launch. A successful call returns the launch result plus a best-effort follow-up read
   of the fresh market state, both under the echoed `clientLaunchId`. If that follow-up read fails,
   the launch itself still succeeds; call `candle_get_market` with the new `chain`/`mint` separately.
4. To launch WITHOUT a bundled seed buy, use `candle_launch_token` instead, with the same fields
   minus `devBuy` (it also accepts `dryRun: true`).
5. Need a bigger seed than the dev-buy ceiling allows? Launch first, then top up with the
   candle-trade skill's `candle_trade` buy.
6. If your agent holds its own linked wallet's signing key rather than trading through Candle's
   server-side embedded wallet, the SDK's `selfLaunch` function launches the same way but has the
   agent sign locally. There is no MCP tool for this path (the MCP server never handles private key
   material by design), so it is an SDK-only route for agents that already manage their own keys.
7. Attribute it: once the launch confirms, call `candle_report_activity` with `{ "chain": "solana",
   "signature": "<the launch's signature>" }` (or `chain: "hood"` for a Hood launch) so Candle
   records and verifies it under your account's activity. `activity:write` is already in the
   default key scope set, so this needs no extra setup.

## Safety rails

`dryRun: true` costs nothing and catches sizing errors before a real launch runs. Every call is
idempotent on `clientLaunchId`: retry a timed-out or uncertain call with the SAME id and the same
body, and it replays the original result instead of launching a second token. `devBuy` is capped
per launch by a platform ceiling enforced before any funds move.

## Example

A launch that is too big for its own dev buy, and the fix.

Dry-run a longer name bundled with a seed buy:
```json
{ "clientLaunchId": "launch-42", "name": "Galactic Moonshot Protocol Token", "symbol": "GMPT",
  "imageUrl": "https://example.com/gmpt.png", "devBuy": "0.4", "dryRun": true }
```
The dry run FAILS before anything is spent, and the error itself carries the name budget:
```json
{
  "clientLaunchId": "launch-42",
  "api": {
    "success": false,
    "error": {
      "code": "TRANSACTION_TOO_LARGE",
      "message": "Launch transaction is 1241 bytes, 9 over Solana's 1232-byte limit. Shorten the token name or ticker (at most 23 name bytes fit this exact request), or launch without the dev buy.",
      "retryable": false,
      "txBytes": 1241,
      "overBy": 9,
      "maxNameBytes": 23
    }
  }
}
```
React by shortening `name` to fit inside `error.maxNameBytes`, and dry-run again to confirm:
```json
{ "clientLaunchId": "launch-42", "name": "Galactic Moonshot", "symbol": "GMPT",
  "imageUrl": "https://example.com/gmpt.png", "devBuy": "0.4", "dryRun": true }
```
A dry run has exactly two outcomes on this question: it succeeds, and a success that carries
`api.size` is itself the confirmation that the transaction fits, or it fails with
`TRANSACTION_TOO_LARGE` as above. There is no "succeeded, but does not fit" answer to read.
Once it succeeds, drop `dryRun` and call it again for real. Then confirm the fresh market and
attribute the launch:
```json
{ "chain": "solana", "mint": "<launch.mint from the response>" }
```
via `candle_get_market`, followed by `candle_report_activity` with `{ "chain": "solana",
"signature": "<launch.signature from the response>" }`.
