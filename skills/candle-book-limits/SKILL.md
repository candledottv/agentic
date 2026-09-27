---
name: candle-book-limits
description: "[RISK CONTROL] Size and audit the lifetime caps, slot counts and wallet reserves of an autonomous trading book so they bound risk without silently stopping the book or blocking its exits. Use when designing a book's limits, when a running book has gone quiet, when an order is stuck unresolved, and when two books share one wallet."
---

## What this does

A trading book carries several limits besides its loss limits: a cap on total purchases, a cap on
requests, a cap on concurrent positions, a wallet reserve. Each one is meant to bound risk. Each one
can also quietly stop the book, or stop its exits, in ways that look like a quiet market.

`candle-trading-discipline` covers the loss, drawdown and consecutive-loss limits that the rail
enforces on the key, and the difference between a volume cap and a loss cap. This skill covers the
limits a book enforces on itself, and how they fail. Loss limits are out of scope here: when one
trips, follow `candle-trading-discipline`: stop new entries and report. Exits continue unless the rail
or the operator says otherwise.

## The rule

**Size every lifetime cap from the experiment it has to complete. Never let a cap refuse an exit.
Count only open positions against a slot limit. When a book goes quiet, check its caps before you
blame the market.**

## Lifetime caps are sized from the bar, not guessed

This is design work for the operator, done before the book starts. A lifetime cap (total purchase
principal, total requests, total episodes) does not reset. Size it from the question the book exists
to answer:

- If the evaluation bar is N closed positions at a maximum of S per position, the purchase cap needs
  to be at least N x S. A cap sized for "a few days of trading" can stop the book at a fraction of
  its bar. The result is a sample too small to judge, with no error.
- Check the loss limit against the same bar. At the expected average loss per position, can the book
  reach N positions before the drawdown stop trips? If not, the experiment is designed to stop early.
  The operator either accepts that or changes the sizing before the start.
- Project request usage from the measured burn rate with the expected number of open positions, not
  from an idle book. Marks and quotes scale with open positions.

## A cap must never refuse an exit

If one request counter covers every call a book makes, then when it reaches its cap the book cannot
fetch the quote it needs to sell. A book at that point holds positions it can no longer manage.

- Reserve a fixed part of the request cap for exits only, and refuse new entries well before the
  reserve is touched. If exits are instead exempted from the cap, they stay bounded by the retry
  limits for each order (see `candle-trade-execution` and `candle-drained-pool-writeoff`), so a failing
  route cannot spend requests without limit.
- The same applies to purchase and budget checks: they belong on the buy path only.

## Slots count open positions only

If closed positions stay in the map a book checks against its position limit, a book with its limit
reached in closed positions refuses every new entry. Worse, it may drop candidates before logging
anything, so there is no refusal event to find.

- Count only open positions against the concurrent limit. Keep a separate record of closed mints if
  the book must never re-buy one.
- Every refusal, including "no slot", should write an event. A candidate that disappears with no
  event is the signature of this failure.

## A quiet book is a cap check first

When a book that used to trade stops trading, check in this order before calling it a signal
drought:

1. The entry window: has the book's entry deadline passed?
2. Slots used against the slot limit, counting how closed positions are treated.
3. Lifetime purchase principal used against its cap.
4. Requests used against the request cap and the exit reserve.
5. Pause flags, kill-switch files and any unresolved order.
6. Only then: the signal source and the market.

These checks are read-only. Changing any of them is covered below.

## One uncertain order must not freeze every exit

When an order's outcome is uncertain (timeout, error with no signature, reconcile pending):

- **Uncertain buy:** refuse new entries until it is resolved. Keep marking and exiting every other
  position.
- **Uncertain sell:** refuse new entries and any further order in that mint until it is resolved.
  Keep marking and exiting positions in other mints, re-reading their on-chain balances first.

A book that freezes all management on one uncertain order leaves every open position without an exit
for as long as reconciliation takes, which can be hours.

To resolve the outcome, use the rail's own lookup (`candle_get_operation` by `clientTradeId`) and the
`stage` and `retryable` fields on the failed trade, documented in Candle's error catalog. Then confirm
on chain: an error with no signature and `retryable: true` can accompany a transaction that did land
and revert, so the error body alone is not proof that nothing reached the chain. See
`candle-trade-execution` for reconciliation.

## Two books on one wallet

Two books that draw from one wallet each believe the whole balance is theirs. Whichever buys first
takes the funds, and the other refuses for lack of funds or, without a check, buys into the other
book's exit reserve.

- The operator provisions and funds wallets. Separate wallets per book are the cleaner design when the
  operator chooses to set them up.
- On a shared wallet, each book checks the actual balance before each buy and keeps a reserve for
  exit fees that neither book may spend.
- Treat a funding refusal as expected behavior, not a bug. Report it; it is the operator's cue to fund
  or to pause one book.

## Changing a limit

Changing a cap mid-run changes the experiment, and it is the operator's decision. The agent may report
that a cap is binding and propose a change with the numbers. The operator decides, records the old and
new value, the reason and the time, keeps the old policy, and re-authorizes the book where its
authorization is bound to its policy. Loss and drawdown limits are not changed this way; see
`candle-trading-discipline`.

## Checklist

- Purchase cap is at least the bar's position count times the maximum position size.
- Loss limit allows the bar to be reached at a realistic average loss.
- Request usage is projected from a busy book; exits have a reserve or stay bounded by retry limits.
- Only open positions count against the slot limit; every refusal writes an event.
- A quiet book gets the window and cap check before the market gets the blame.
- An uncertain buy blocks entries only; an uncertain sell blocks entries and that mint only.
- Uncertain outcomes are resolved through the rail's lookup and then confirmed on chain.
- Books sharing a wallet check the actual balance and hold an exit reserve.
- Limit changes are the operator's, recorded, with the old policy kept.

## Related skills

- `candle-trading-discipline`: loss, drawdown and consecutive-loss limits on the key; volume caps are not loss caps.
- `candle-trade`: `candle_get_operation` for trades that timed out.
- `candle-trade-execution`: reconciliation, retry caps and sticky terminal states.
- `candle-kill-switches`: operator controls that pause entries without touching exits.
- `candle-agent-operations`: request meters shared across processes.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
