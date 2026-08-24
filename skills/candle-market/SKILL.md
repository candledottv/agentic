---
name: candle-market
description: "[MARKET DATA] Read a Candle token's market state and lifecycle, curated feeds carrying live price and market cap (new, graduated, onfire, bluechip), and public agent profiles, with no API key and no signup. Use when the user asks to check a token's market state, browse trending or graduated tokens by price or market cap, or look up an agent's public profile."
---

## What this does

Reads market data from Candle: a token's current lifecycle and pool state, one of the trade
page's curated feeds, or a Candle user's public agent profile. This skill never trades and never
launches; it only reads.

## Setup

Nothing to set up: the CLI and MCP default to the alpha API host
(`https://api.alpha.candle.tv`), where these routes run today; set `CANDLE_API_URL` only to
point at a different deployment (see each platform's install doc).
From there, all three tools below work immediately, with no API key. If you later want to launch,
trade, or report activity, see the candle-setup skill to get an agent key.

## The workflow

1. `candle_get_market` with `{ chain, mint }` (chain is "solana" or "hood"; mint is the token's
   mint address on Solana or contract address on Hood) returns lifecycle, pool address, whether
   buys and sells are open, and the token's `decimals` and `quoteDecimals`.
2. `candle_get_feed` with `{ bucket, chain? }` where `bucket` is one of `new`, `graduated`,
   `onfire`, or `bluechip`, and `chain` optionally narrows the results to one chain. This is where
   price lives: each returned token carries `priceUsd`, `marketCap`, and short-window change and
   volume fields alongside its name, symbol, and image; `candle_get_market` itself does not return
   a price.
3. `candle_get_agent_profile` with `{ idOrWallet }` (a Candle username or wallet address) returns
   whether agent features are enabled for that account and its launch counts.

## Safety rails

Read-only: none of these three tools move funds, sign a transaction, or need any credential.

## Example

"What's on fire on Candle right now?"
→ call `candle_get_feed` with `{ "bucket": "onfire" }`

"What's the market state for this token on Solana?"
→ call `candle_get_market` with `{ "chain": "solana", "mint": "<mint address>" }`

To go further and actually launch or trade, see the candle-setup skill: run
`npx @candledottv/cli auth login` to get an agent key (the CLI already defaults to the alpha
API), then move on to the candle-launch or candle-trade skills.
