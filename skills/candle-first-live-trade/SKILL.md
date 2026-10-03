---
name: candle-first-live-trade
description: "[OPERATIONS] The plumbing test a trading bot needs before and during its first live trades: a supervised minimum-size round trip through the real code, a sell proven before buys scale, a control exercised on a live position, and the ledger reconciled against the wallet. Use when a bot is about to trade real money for the first time, after any change of key, signer, wallet, venue or quote asset, when an operator says to kill a newly live bot, when the first live fills look different from paper, and when a newly live book goes quiet."
---

## What this does

`candle-trading-discipline` decides whether a strategy deserves real money, and paper mode proves
that its trades would be admitted. Neither proves that the bot's own code, key, signer, wallet and
ledger work together when real money moves. Paper never signs, never sells real tokens and never
lands on chain, so the faults it cannot see show up in the first live trades. This skill is the
test that finds them under supervision instead of overnight.

## The rule

**Before a bot runs unattended, it completes one supervised round trip at minimum size through its
own live code path: buy, a forced exit through a control, and a reconciliation of ledger against
wallet to the smallest unit. Until the first live exit has landed and reconciled, the bot holds at
most one open position. Any change of key, signer, wallet, venue or quote asset makes the next fill
a first trade again.**

## Before the first trade

A book here is one strategy's bot, wallet and ledger.

- **Use a separate live ledger.** Paper closes and live fills never share a ledger file or a P&L
  line.
- **Record the wallet's starting state.** SOL balance and every token account, read from the chain.
  The reconciliation below compares against this; a wallet that already holds tokens the ledger does
  not know about is noted, not adopted.
- **Read the key's limits through the key the bot will use.** After a rebind or a key change, the
  limits are the new key's, not the old one's. A TEE trade can also be refused until the key carries
  every cap the rail requires. At the time of writing a refusal could name only one missing item at
  a time, so the first trade is often where this shows.
- **If the bot is meant to trade a TEE wallet, confirm it names that wallet as payer** and refuses a
  request that would pay from any other.
- **Write down the stop rules before starting:** which observations pause buys (a reconciliation
  mismatch, a stuck order, a refusal the bot does not understand, the wallet below a floor) and who
  is told.

## The supervised round trip

Run it with the operator present, at the smallest size the venue accepts. At that size, rent for new
token accounts and fixed fees can be several percent of the position, so expect the round trip to
lose money. It is a plumbing test, not a strategy result.

1. **Buy through the bot's own entry path,** not a hand-typed CLI trade. A hand trade proves the
   rail; only the bot's path proves the bot.
2. **Check the fill against the chain.** Token quantity from the wallet's balance change, SOL spent
   including network fee and any new token account's rent, and the input that actually landed equal
   to the input intended (some pools take a fee on top). If the venue routed through a program the
   bot's fill parser does not know, the bot cannot book the fill; that position must be found here,
   not after it is stranded.
3. **Exit through the bot's own flatten control, not by waiting** for an exit rule to fire. This
   proves the sell path and the control at once. A bot should have a way for an operator to close a
   position (see `candle-kill-switches`); without one, force the exit with a rule set to fire at once.
4. **Reconcile to the smallest unit.** Ledger cash change equals wallet SOL change, every fee and
   any landed revert included. No token balance left that the ledger shows as closed. A gap of even
   a few thousand lamports has a cause; find it by signature before going on.

A landed revert is a normal first-trade result. It costs a fee and moves no tokens. It must be
booked as reverted with its fee, not as uncertain and not as a fill. Decide on purpose whether a
booked revert counts toward a pause guard; it must never freeze the book as an uncertain order. A landed revert can come back as a generic swap failure with no signature;
look for the wallet's transaction on chain before calling it unsent. An error that says the
simulation failed was never broadcast.

## Prove the emergency path before it is needed

The emergency path (disable, then sweep home) empties a wallet, so it is never tested on a book's
wallet. On a new key or signer setup, the owner tests it once on a throwaway wallet funded with a few
hundredths of a SOL: `candle tee disable`, a trade that must be refused, `candle tee sweep`, and a
check on chain that the funds reached the expected sweep home.

## The kill switch is not the wallet switch

`candle tee disable` stops the agent's access to the wallet. It stops sells too, so every open
position is left without an exit. The "stop an agent" row in `candle-setup` is the compromise path:
use it when the key or wallet may be compromised, or after positions are closed or deliberately
abandoned. When an operator says "kill it" about a running book, ask which they mean: pause buys,
flatten, or disable. If they cannot be reached, pause buys, which stops new risk and leaves exits
running, and report.

## The first live hours

- **One position at a time until the first live exit has landed and reconciled.** A sell path that
  fails on the first exit should cost one position, not a full book of them.
- **Reconcile after every fill** for the first few trades, and at every restart from then on. A gap
  that does not change between restarts points to an out-of-band move (a manual transfer, dust, a
  rent refund); identify each one by signature.
- **Read every refusal and error by code.** A response that says retryable is not proof that
  nothing was sent, and a job status that says submitted is not proof that it landed. Check the chain
  for a signature before any retry.
- **A quiet new book is counted, not assumed quiet.** See `candle-book-limits` for refusals and
  caps that look like a quiet market, `candle-trading-discipline` for fills against their quotes,
  and `candle-trade-execution` for stuck-order health.

## A path change is a first trade

A move to a new key, a rebind, a new signer, a new wallet, a new venue or chain, or a new quote asset
can each break the signing or payment path without breaking anything paper can see. After any of
them:

- Pause buys during the change.
- Read the limits and wallet binding again through the bot's key.
- Treat the next fill as a first trade: one position, checked against the chain, reconciled.
- The change is done when one buy and one exit have filled on the new setup, not when the command
  that made the change succeeded.

A change that only adjusts a limit does not touch that path: read the limits again through the bot's
key and carry on.

## Checklist

- Separate live ledger; wallet starting state recorded from the chain.
- Key limits read through the bot's own key; the bot pays only from its own TEE wallet.
- Stop rules written down before starting.
- One supervised minimum-size round trip through the bot's own code, exited through a control.
- Fill checked against the chain; ledger reconciled to the smallest unit; reverts booked with fees.
- Emergency path tested by the owner on a throwaway wallet for a new setup, never on a book's wallet.
- "Kill it" is clarified; if the operator is unreachable, pause buys; wallet disable is for compromise.
- One open position until the first live exit reconciles; reconcile at every restart.
- Refusals read by code; no retry before checking the chain.
- After any key, signer, wallet, venue or quote-asset change, the next fill is a first trade.

## Related skills

- `candle-trade` and `candle-trading-discipline`: paper rehearsal, cost arithmetic and loss limits.
- `candle-trade-execution`: booking from chain, sell clamps, retries and error structure.
- `candle-kill-switches`: the controls the round trip exercises.
- `candle-wallet-layout`: keys, signers, rebinds and the sweep home.
- `candle-book-limits`: caps that silently stop a book.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
