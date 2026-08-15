---
name: candle-trade
description: "[FINANCIAL EXECUTION] Buy or sell a Candle-launched token, or place a Max-tier limit order that triggers server-side and fills once your agent comes online to complete it. Use when the user asks to buy, sell, swap, trade, or set a limit order."
---

## What this does

Executes a buy or sell through Candle's trade rail. The payer is the account's own embedded (main)
wallet, executed server-side via delegation. Amounts are always decimal, the tool converts to raw
base units itself.

## Setup

Needs an agent API key carrying the `swap:write` scope. If you followed the candle-setup skill's
device flow (`candle auth login` with `--scopes` omitted), you already have it: that flow's default
grants all four scopes, `swap:write` included, and the browser approval screen names each one
explicitly before you approve. `swap:write` is never granted silently, only ever named on that
screen or asked for by hand. A narrower key, one minted with an explicit `--scopes` list on
`candle auth login`, or created with `candle keys create`, does not include `swap:write` by default;
request it there instead. There is no keyless path for trading: this always moves funds. Point the
MCP server at staging too: the default API host is production, which doesn't serve the trade routes
yet, so set `CANDLE_API_URL=https://staging.api.candle.tv` when configuring the server (see each
platform's install doc) until the feature reaches production.

## The workflow

1. Call `candle_trade` with `mint`, `side` (`"buy"` or `"sell"`), and exactly one of `amount` or
   `percent`.
   - A buy's `amount` is denominated in the token's OWN quote asset, whatever it was launched
     against (SOL for a SOL-launched token, USDC or CNDL for those quote pairs). The tool reads the
     market first and converts against its `quoteDecimals`, so you never compute raw base units.
   - A sell's `amount` is denominated in the token itself, and converts against the market's own
     `decimals`. Or pass `percent` (an integer 1-100, Solana only) to sell a slice of the wallet's
     current holding; the MCP resolves the balance for you.
   - `quoteAsset` only matters for an arbitrary Solana mint Candle never launched, the Pro/Max-only
     path traded through Jupiter. It changes nothing for a Candle-launched token.
   - Swapping the base assets themselves (SOL, USDC, and CNDL on Solana) against one another is
     open to EVERY tier, a separate rule from the Candle-launched-token one: the Pro/Max gate
     applies only to arbitrary mints Candle never launched, never to a base pair.
   - `maxSlippageBps` overrides the API's default slippage tolerance.
2. Every call carries a `clientTradeId`, auto-generated and echoed back when omitted.
   **Retry a timed-out or uncertain call with the SAME id and the same body**: it replays the
   original result instead of trading twice. A new id (including the auto-generated default, if
   you did not capture and reuse the one you got back) is a second, independent trade.
3. Attribute it: once the trade confirms, call `candle_report_activity` with `{ "chain": "solana",
   "signature": "<the trade's signature>" }` (or `chain: "hood"` for a Hood trade) so Candle records
   and verifies it under your account's activity, the same signal that feeds attribution elsewhere
   on Candle. This is a separate call from the trade itself; it needs `activity:write`, which is in
   the default key scope set either way you got your key.

### Limit orders (Max tier, linked wallet only)

Candle can watch a price and flip an order to triggered server-side, but it does not fill
unattended: **an order only fills while your agent is online to react to the trigger and complete
the trade.** This is honest by design, not a limitation to work around. The trigger itself is
pushed as an `order.triggered` webhook (see the candle-webhooks skill), with polling as the
fallback. It requires Max tier and a linked wallet (the account's main embedded wallet cannot
place one), and it is not exposed as an MCP tool today: it is a REST-only surface your agent's
own online loop has to drive directly.

## Safety rails

When your agent signs from a linked wallet, which a limit order's completing trade always does,
the relay signs only transactions Candle itself built: at build time Candle hashes the unsigned
artifact and stamps it onto a single-use claim, and the relay only signs a request whose hash
matches an unconsumed claim scoped to that same account and wallet. A stolen key cannot get an
arbitrary, hand-rolled transaction signed through it this way.

Spend limits are the account owner's own opt-in ceiling, unlimited by default. Once set, every
buy's total outflow (amount plus fee) is checked against it before the trade begins, and exceeding
it rejects the trade, naming the cap. A key can also carry its own per-asset spend cap, which
replaces the account's cap for that asset rather than adding to it.

`swap:write` is never granted silently: the device-flow approval screen (see candle-setup) names it
as its own fund-moving grant before any key exists, and a key minted with a narrower scope list,
whether through an explicit `--scopes` on `candle auth login` or via `candle keys create`, leaves it
out unless you ask for it by name.

## Example

"Buy 0.5 SOL of this token."
```json
{ "mint": "<mint>", "side": "buy", "amount": "0.5" }
```

"Sell 25% of my position."
```json
{ "mint": "<mint>", "side": "sell", "percent": 25 }
```

If a call times out or the connection drops, retry with the exact `clientTradeId` the first
attempt echoed back, never a fresh one.
