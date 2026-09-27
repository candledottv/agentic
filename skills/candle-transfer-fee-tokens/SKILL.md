---
name: candle-transfer-fee-tokens
description: "[RISK CONTROL] Judge the real round-trip cost of a Token-2022 mint with a transfer fee without double-counting or rejecting it by mistake, size and sell from what was actually received, and reconcile paper against live correctly for taxed tokens. Use before buying a token whose mint carries a transfer-fee extension, when every taxed token fails an impact check, when a new position marks well below entry immediately, and when paper and live results disagree on taxed tokens."
---

## What this does

A Token-2022 mint can carry a transfer-fee extension: every transfer of the token withholds a
percentage of the amount moved. `candle-risk-gate` flags the extension through `tokenExtensions`.
This skill covers how the fee shows up in quotes, how to put it into an entry decision correctly, and
how to keep accounting honest about it.

## The rule

**A transfer fee is paid on the way in and again on the way out. Judge the round trip from the
reverse quote, judge each leg's impact net of the fee, never add the fee a second time, size and sell
from the balance actually received, and compare live results against a paper column that charges the
fee.**

## How the fee appears in quotes

- The fee applies to the token amount of each transfer. Buying moves tokens from the pool to you;
  selling moves them from you to the pool. A round trip pays it twice. At a fee rate f, the round trip
  keeps `(1 - f)^2` of the token value before any other cost: about 2% lost at 1% per leg, about 5.9%
  at 3% per leg.
- Aggregator quotes for taxed mints can already include the fee in the reported price impact. When
  they do, a leg with little market impact still reports an impact at least as large as the fee.
- Two mistakes follow from this, in opposite directions:
  - **Rejecting everything.** A fixed impact cap below the fee rate refuses every taxed token, however
    deep its pool, before any cost logic runs.
  - **Double-counting.** Adding the fee on top of an impact figure that already contains it charges the
    fee twice and overstates the cost.
- Routing adds to it. A 3% fee on each leg is about 5.9% of round-trip cost before any market impact;
  with extra hops through thin pools, the total can pass 10%. A position like that marks that far
  below entry the moment it fills, before the price has moved at all.

## How to check

1. Read the mint's program and extensions before the buy. If it has a transfer-fee config, read the fee
   in effect at the current epoch (the config can hold an older and a newer fee with the epoch the
   newer one starts), its maximum fee per transfer, and whether a fee authority exists. An authority
   can change the fee while you hold.
2. Once per quote source, check on a known taxed mint whether its quotes include the transfer fee on
   each leg (the buy's output net of the inbound fee, the sell's output net of the outbound fee, and the
   reported impact). Where a quote leaves the fee out, or you cannot tell, apply the fee yourself,
   exactly once for that leg.
3. Get a buy quote for your size, then a reverse (sell) quote for the tokens you will actually receive:
   the buy's guaranteed minimum output, reduced by the inbound fee only if step 2 showed the buy quote
   does not already net it. The reverse quote's guaranteed minimum output, compared with what you spend,
   is the round-trip cost: both impacts, slippage, and the fee on both legs once step 2 is satisfied.
4. If the quote source includes the fee in its reported impact, judge each leg's impact net of the fee
   (reported impact minus the fee rate) against your per-leg limit, so that deep taxed pools are not
   rejected for the fee alone. If it does not, judge the reported impact as it is.
5. Refuse the entry if the round trip is larger than the edge your strategy has measured. See
   `candle-trading-discipline` for the cost arithmetic.
6. After the fill, read the received token balance from the chain and use it as the position quantity.
   The received amount is net of the fee.
7. Refuse mints with a transfer-hook extension by default. A hook runs another program on every
   transfer, including your sell. Only the operator can allowlist a specific hook program after
   reviewing it.

## Policy choices for the operator

- **A fee cap instead of a ban.** Transfer-fee mints can be a substantial share of what active wallets
  buy. A rule that refuses every Token-2022 fee mint silently removes that part of the market from a
  strategy. An operator may choose an explicit cap on the fee rate (for example 300 basis points)
  combined with the round-trip gate above. Changing an existing ban into a cap is the operator's
  decision, not the agent's.
- **Keep the fee visible in reports.** Record the fee rate on every position so results can be split
  into taxed and untaxed groups.

## Reconciling paper and live

Price feeds and tape marks report the market price and do not charge the fee. A live book that
records fills from balance changes is already net of the fee. Comparing the two directly makes live
execution look worse than it is on every taxed token.

Keep two columns in any paper or shadow ledger: the untaxed mark, and the same mark with the fee
charged on both legs (gross multiplied by `(1 - f)^2`, then other costs). Compare live results to the
taxed column. When a mint's fee is not yet known, report that position as unknown instead of guessing.

## Checklist

- Mint extensions, the current-epoch fee, the maximum fee and the fee authority are read before the buy.
- Each quote source has been checked once for whether it includes the fee on each leg.
- The round trip is judged from the reverse quote of the tokens actually received (the buy's minimum output, net of the inbound fee exactly once).
- The fee is counted exactly once per leg: never added on top of a figure that already includes it, never left out.
- Where reported impact includes the fee, per-leg impact is judged net of it, and no fixed impact cap sits below the fee rate.
- Position quantity and sell size come from the received balance, not the quote.
- Transfer-hook mints are refused unless the operator has allowlisted that hook.
- Paper ledgers carry a taxed column; live is compared against it.

## Related skills

- `candle-risk-gate`: the `tokenExtensions` flag and the other pre-buy checks.
- `candle-trading-discipline`: round-trip cost arithmetic and when a strategy cannot pay for itself.
- `candle-trade-execution`: book fills from on-chain balance changes, never from the quote.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
