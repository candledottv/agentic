---
name: candle-market
description: "[MARKET DATA] Read a Candle token's market state and lifecycle, curated feeds carrying live price and market cap (new, graduated, onfire, bluechip), and public agent profiles, with no API key and no signup. Use when the user asks to check a token's market state, browse trending or graduated tokens by price or market cap, or look up an agent's public profile."
---

## What this does

Reads market data from Candle: a token's current lifecycle and pool state, one of the trade
page's curated feeds, or a Candle user's public agent profile. This skill never trades and never
launches; it only reads.

## Setup

Nothing to set up: the CLI and MCP default to the production API host
(`https://api.alpha.candle.tv`); set `CANDLE_API_URL` only to
point at a different deployment (see each platform's install doc).
From there, all six tools below work immediately, with no API key. If you later want to launch,
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
3. `candle_token_forensics` with `{ chain, mint }` is the pre-buy gate: who launched it (on-chain;
   a launchpad shared authority is never the developer), the deployer's other launches and how
   they ended, who bought in the deploy window (the creator's own wallets are marked
   `disclosed`; strangers in the same slot are the bundle signal), same-funder insiders and
   cluster, plus `safety.summary` and six sourced flags: `mintAuthority`, `freezeAuthority`,
   `tokenExtensions`, `lpLock`, `sellability`, and `liquidityDrain`. Refuse an unprompted buy
   when flagged and name the flag, source and detail. `unknown` or `incomplete` is not clearance;
   inspect all flags and `coverage` before proceeding. `not_applicable` has no flags for base
   assets. `launch.deployerLaunches` counts launches including this mint, is informational only,
   and never drives a warning. Sellability is a verdict, not a holder-side simulation.
4. `candle_get_agent_profile` with `{ idOrWallet }` (a Candle username or wallet address) returns
   whether agent features are enabled for that account and its launch counts.
5. `candle_resolve_token` with `{ mint }` (a bare contract address or mint) returns the token, its
   chain, decimals, quote asset and whether Candle can trade it. The chain is read off the address,
   so start here when a human hands you only an address. A 404 means Candle has no market for it.
6. `candle_get_plans` with `{}` returns every plan's price, agent fee, perps builder fee, limits
   and capabilities as this deployment serves them. Quote prices and fees from here, never from
   memory.

## Safety rails

Read-only: none of these six tools move funds, sign a transaction, or need any credential.

## Example

"What's on fire on Candle right now?"
→ call `candle_get_feed` with `{ "bucket": "onfire" }`

"What's the market state for this token on Solana?"
→ call `candle_get_market` with `{ "chain": "solana", "mint": "<mint address>" }`

To go further and actually launch or trade, see the candle-setup skill: install the Candle CLI
(`curl -fsSL https://candle.tv/install.sh | bash`, or `brew install candledottv/tap/candle`), run
`candle auth login` to get an agent key (the CLI already defaults to the alpha API), then move on
to the candle-launch or candle-trade skills.
