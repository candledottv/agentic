---
name: candle-launch
description: "[TOKEN LAUNCH] Launch a new token on Candle, on Solana or Hood, optionally seeded with a dev buy (same transaction on Solana; best-effort follow-up on Hood). Use when the user asks to launch, create, deploy, or seed a token."
---

## What this does

Launches a new token through Candle's headless launch API, on Solana or Hood, optionally seeding
the curve with a dev buy. On Solana the dev buy is in the launch transaction itself; on Hood it is
a follow-up transaction. This works on every plan, Free included: the launch and the dev buy are
paid from the account's embedded wallet. The account that launches a
token becomes its on-chain creator, and Candle-launched tokens pay creator fees back to whoever
created them, on every trade against that token afterward.

## Setup

Needs an agent API key (see the candle-setup skill); the default key scopes already cover
everything here (`launch:write`, `launch:read`, `activity:write`). There is no keyless path for
launching: this always writes, and always costs a network fee unless `dryRun` is set. Point the
MCP server anywhere: the CLI and MCP default to the alpha API host
(`https://api.alpha.candle.tv`), where the launch routes run today. Set `CANDLE_API_URL` only to
point at a different deployment.

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
   `imageUrl` must be a roughly square https image (for a file on this machine, see "If the image
   is a file" below). `chain` is `"solana"` or `"hood"` (defaults to
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
6. Two other launch paths exist, both for the Pro or Max plan and neither an MCP tool. The SDK's
   `selfLaunch` launches from a linked or TEE wallet the agent signs for locally (the CLI's
   `candle launch` is this path, from a TEE wallet; `--buy <amount>` adds a first buy from the
   same wallet where the server has `TEE_LAUNCH_BUYS_ENABLED` on, which is off by default, and
   without it the first buy is a separate swap). The SDK's `launchAtomic`
   lands the launch and 1 to 4 first buys in one bundle (payers are the embedded or linked wallets and may repeat). Neither is needed
   for a launch with a dev buy: steps 1 to 3 above do that on any plan. The MCP server never
   handles private key material by design, so both stay SDK routes.
7. Attribute it: once the launch confirms, call `candle_report_activity` with `{ "chain": "solana",
   "signature": "<the launch's signature>" }` (or `chain: "hood"` for a Hood launch) so Candle
   records and verifies it under your account's activity. `activity:write` is already in the
   default key scope set, so this needs no extra setup.

## Choosing a curve (Solana, SOL or CNDL pairs)

By default a launch takes its tier's own curve (`mode` `open` or `exclusive`). A Solana launch
quoted in `sol` or `cndl` can take an experimental curve instead, set by two numbers in the quote
asset: V, the virtual liquidity it starts with (a larger V starts the price higher and climbs more
slowly), and G, how much it raises before it graduates.

- **Presets:** `mode: "exp-a"`, `"exp-b"` or `"exp-c"`, V of 4, 6 or 8 SOL, each graduating at 5 SOL
  (264,000, 396,000 or 528,000 CNDL, graduating at 330,000 CNDL). The dev buy is at most 0.5 SOL
  or 33,000 CNDL.
- **Custom:** `mode: "exp-custom"` with `curve: { "virtualQuote": "12", "threshold": "40" }`, whole
  units as decimal strings. V from 1 to 100 SOL and G from 1 to 250 SOL (66,000 to 6,600,000 and
  66,000 to 16,500,000 CNDL), under a price ceiling that binds for a small V on SOL and always
  binds first on CNDL. The dev buy is at most 10% of G. A refusal is `CURVE_OUT_OF_RANGE` with a
  `reason`, and at the ceiling `maxThresholdRaw` names the largest G that fits. `GET
  /api/v1/launch/curve-options` (no key) says whether the deployment takes `exp-custom`.
- **Open to everyone:** these curves have no Believer NFT gate.
- **Fees:** 1% on the curve and 0.5% in the pool it graduates into. Over the HTTP API (not these
  MCP tools) a launch may add `creatorFeeBps: 100` or `200`, an extra 1% or 2% on both, paid to the
  creator in full.

Dry-run first: the dry run returns `curveTerms` (market cap at start and at graduation, supply sold
by graduation, what the first 1 SOL buys). Show the user those terms before launching: a small V
against a large G sells most of the supply cheaply, and a curve's terms cannot be changed after
launch. Full rules: https://docs.candle.tv/developers/headless-launch#custom-curves-choose-v-and-g

## If the image is a file

`imageUrl` is always an https URL on the wire. When the image is a file, it is uploaded first and
the launch is made with the URL Candle returns. An upload is public and permanent, with any
metadata the file carries, and a dry run uploads too: upload only an image that is meant to be
public. The file must be a PNG, JPEG, GIF or WebP of at most 10MB.

- **Local MCP server with `CANDLE_IMAGE_DIR` set:** pass `imagePath`, an absolute path to a file
  inside that directory, in place of `imageUrl` on `candle_launch_and_seed` or
  `candle_launch_token`. One or the other, never both. The result carries the `imageUrl` that was
  used: after a dry run, or on a retry, pass that `imageUrl` rather than `imagePath`, so the file
  is not uploaded a second time. A path outside the directory is refused with "Image files must be
  inside the configured CANDLE_IMAGE_DIR." If the tool has no `imagePath` argument, the directory
  is not configured; only the operator can set it, so use one of the ways below instead.
- **CLI:** `candle image upload <path>` prints the hosted URL; pass it as `imageUrl`.
  `candle launch --image <path>` uploads and launches in one command, on the TEE-wallet path of
  step 6. Both need CLI 0.11.24 or later.
- **Hosted MCP server:** it runs on Candle's machines, cannot read a file on your computer and has
  no `imagePath`. Ask the user to install the Candle CLI 0.11.24 or later, configure an agent key
  with `launch:write`, run `candle image upload <path>` in a terminal, and give you the URL it
  prints. Signing in to the hosted server supplies neither the CLI nor that key.
- **REST:** `POST /api/v1/uploads/agent-image` with the file's bytes and its image content type
  (or a multipart `image` field), under a key with `launch:write`, answers
  `{ "success": true, "imageUrl": "https://..." }`.

`bannerUrl` is always a URL: the upload crops to a square, so it cannot host a banner.

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
