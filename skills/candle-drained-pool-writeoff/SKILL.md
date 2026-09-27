---
name: candle-drained-pool-writeoff
description: "[RISK CONTROL] Recognize a held position whose pool was emptied after entry, and account for it as a loss instead of marking it at a stale price or retrying sells forever. Use when a held token's price has stopped updating, when sell quotes keep failing, when a mark looks healthy but no trades arrive, and when deciding whether an unsellable position can be closed out."
---

## What this does

A token can pass every pre-buy check and still become unsellable after you own it: the liquidity
provider withdraws, and the pool's quote-asset reserve drops to dust. `candle-risk-gate` covers the
checks before a buy (`lpLock`, `liquidityDrain`, `sellability`). This skill covers what a book does
when the drain happens after entry.

Two things go wrong without it. The position keeps being marked at its last price, so the book's
equity is overstated. And the exit logic keeps retrying sells against an empty pool, burning request
budget and holding a slot that could be used elsewhere.

## The rule

**Detect a drain from the pool's own reserve, not from price. On confirmed depletion, take any
proceeds a fresh quote offers above the cost of the sell transaction; otherwise write the position off at its full remaining cost
basis, keep the quantity and evidence visible, free the slot and stop automatic retries. A failed
quote alone is not a drain.**

## Why price does not show it

- A liquidity withdrawal is not a swap. A feed or parser that records only buys and sells never sees
  it. The last recorded price and reserve stay at their pre-withdrawal values, followed by silence.
  To a mark-to-last-price book, the position looks healthy and quiet.
- After the pool is empty, no further trades print, so a stop that waits for the next trade below its
  level never fires. A stop cannot create exit liquidity that is no longer there.

## How to check

For each held position, periodically read the pool's real quote reserve directly:

1. **AMM pools:** read the pool account and its quote vault. Confirm the pool is owned by the expected
   program and still references the mint you hold, and that the vault's mint, owner and token program
   match the pool. Read pool and vault in the same slot where the RPC allows it.
2. **Bonding curves:** the real SOL reserve is held on the curve account itself, and pricing can use
   virtual reserves as well. Read the real reserve; a curve can price the token while holding almost
   no real SOL.
3. Compare the real reserve now with its level at entry. Treat the pool as depleted only when a
   substantial entry reserve (for example at least 1 SOL) has collapsed to dust (for example a few
   thousand lamports or less).
4. If you cannot decode the pool layout, the state is unknown, not depleted. Do not write off on an
   unknown.

Depletion of the pool you entered through is evidence about that pool, not proof that no route
exists anywhere. Before writing off, request fresh sell quotes for the full remaining quantity through
the normal route finder: a small, fixed number of attempts, spaced apart rather than back to back so
a brief quote-service outage cannot decide the outcome. Persist the attempt count so a restart does
not reset it. If a quote offers proceeds above the cost of the sell transaction, sell for them
rather than writing off.

## What is not a drain

Each of these alone is not enough to write off a position:

- A sell quote that errors or times out (quote services have transient failures).
- A token that has not traded for a while.
- A mark that has not updated (the price source may be stale for its own reasons).
- A pool layout the book does not support.

Keep such positions open and under normal management, with the bounded retries described in
`candle-trade-execution`. `onchain-strategy-research` makes the same distinction for research:
silence is not a fill, and a dead market is different from an unavailable provider.

## The write-off

When depletion is confirmed and the bounded quote attempts found no positive proceeds:

- Value the remaining quantity at zero and charge the full remaining cost basis as a realized loss.
  Never credit cash that was not received.
- Keep the position record: mint, quantity still held, original basis, entry and close times, the
  reserve readings and the failed quotes. The tokens are still in the wallet; the record says so.
- Free the position's slot so the book can use it.
- Quarantine the mint for the rest of the run: no re-entry and no automatic sell retries.
- Include the loss in the book's loss limits like any other realized loss.
- Keep written-off positions on a list the operator can see, with the quantity still held. An
  occasional operator-approved check of that list can find a position whose liquidity has returned.
  Any later sale is recorded as a new, separate recovery; the original write-off is not reversed.

## Checklist

- Held positions have an independent reserve read, not only a last-trade price.
- Reserve reads verify pool ownership, mint binding and vault identity; unknown layouts stay unknown.
- Bonding curves are judged on real reserves, not virtual ones.
- Depletion is measured against the reserve at entry.
- Sell quote attempts on a suspected drain are few, spaced and persisted; proceeds above the sell cost are taken.
- A quote error, a stale mark or an idle token alone never triggers a write-off.
- A write-off charges full basis, credits no cash, keeps quantity and evidence, frees the slot and quarantines the mint.
- Written-off positions stay on an operator-visible list.

## Related skills

- `candle-risk-gate`: `lpLock`, `liquidityDrain` and `sellability` before you buy.
- `candle-trade-execution`: bounded retries, sticky terminal states and sell clamps.
- `onchain-strategy-research`: silence is not a fill; dead markets versus unavailable providers.
- `candle-book-limits`: slots that stay occupied by dead positions block new entries.
- `candle-market-data-ingestion`: why swap-only feeds miss liquidity events.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
