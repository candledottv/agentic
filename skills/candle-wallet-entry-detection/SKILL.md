---
name: candle-wallet-entry-detection
description: "[DATA] Decide whether a watched wallet actually bought a token, whether it still holds it, and which of its moves should count toward a signal or an exit. Use when building a wallet-following or wallet-convergence signal, when counting how many tracked wallets entered a token, and when a follow signal fires on wallets that did not really buy or no longer hold."
---

## What this does

Wallet-following strategies start from a simple-looking question: did this wallet buy this token?
The obvious answer, "its token balance went up", is wrong often enough to change which signals
fire. This skill defines an entry, a current holder and an exit trigger in ways that survive how
large wallets actually trade.

`candle-risk-gate` covers whether a wallet is worth following (copyability, launch-own-token
discount). `onchain-strategy-research` covers router versus beneficial trader, economic swaps versus
transfers, and why many wallets are not many independent buyers. This skill covers the event-level definitions underneath both.

## The rule

**Count an entry only when the wallet signed the transaction and paid something for the tokens: SOL,
a stablecoin or another token. Count a wallet toward a signal only while it still holds a meaningful
share of what it bought. Watch every tracked wallet for sells, not only the ones that formed the
signal.**

## A balance increase is not a purchase

A wallet's token balance goes up when it buys, and also when:

- someone airdrops or transfers tokens to it,
- it claims tokens from a program,
- small unsolicited amounts (dust) are sent to it.

Among large, active wallets, a meaningful share of positive balance changes are not signed by the
wallet at all. In the authors' own watched-wallet sample that share ranged from about a tenth to
more than a quarter. A signal that counts these can fire on a token the wallet never chose.

Check two things on the transaction that raised the balance:

1. **The wallet is a signer.** The fee payer can be someone else (relayers and aggregators often pay
   fees for the user), so check signers, not the fee payer. Smart-contract wallets and program-owned
   accounts cannot sign; for those, check that the controlling authority signed.
2. **Value left the wallet in exchange.** Look at the wallet's pre and post balances in the same
   transaction: native SOL, wrapped SOL, stablecoins, or another token decreased.

## Stablecoins are the usual payment

Many large wallets buy through aggregators with USDC or USDT rather than SOL, often for most of
their entries. A rule of "SOL left the wallet" can therefore miss most real purchases.

For the same reason, do not fix the airdrop problem with a minimum SOL outflow. A wallet that paid
hundreds of USDC for a position shows only a fee-sized SOL change and would be discarded as dust.
Require a paid leg in any accepted asset, with a minimum value per entry. Express the floor in one
unit (for example USD) so that stablecoin, SOL and token payments are filtered evenly.

## Still holding is part of the definition

A signal of the form "several tracked wallets entered this token" assumes the wallets are still in.
Wallets often sell within hours. If the signal counts every wallet that ever bought, it can form out
of wallets that have already left, and you enter as they exit.

- Track each watched wallet's balance per token from every event, not only its first buy.
- Count a wallet toward a signal only while it holds at least a set share of what it bought (half is
  a reasonable starting point).
- A wallet that has sold out is not an entrant, however early it bought.

## Exits: watch everyone, and do not read holding as safety

- If the exit is "the followed wallets started selling", watch sells from every tracked wallet
  that bought the token, not only the first few that formed the signal. A large holder outside the
  founding group can sell everything without triggering an exit that only watches the group.
- The reverse does not hold: tracked wallets still holding is not a reason to keep holding. Large
  holders sitting on a loss often do not sell at all. Their holding carries no exit information, so
  the position still needs a price-based exit of its own.

## Checklist

- An entry requires the wallet (or its controlling authority) as signer, not just fee payer.
- An entry requires a paid leg in SOL, a stablecoin or another token, above a floor set in one unit.
- Airdrops, transfers-in, claims and dust are recorded but never counted as entries.
- No SOL-only outflow rule, and no SOL minimum as the dust filter.
- Each wallet's per-token balance is tracked across all its events.
- Signals count only wallets still holding a set share of what they bought.
- Exit watching covers every tracked wallet in the token.
- Every position has a price-based exit independent of what tracked wallets do.

## Related skills

- `candle-risk-gate`: whether a wallet is worth following at all, and its copy score.
- `onchain-strategy-research`: beneficial trader versus router, and correlated wallets.
- `candle-market-data-ingestion`: getting every relevant wallet transaction in the first place.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
