---
name: candle-strategy-hunt
description: "[RESEARCH] Find trading leads worth testing and triage them cheaply before full validation: start from what the market just did, define a census universe with a random control, name who pays, know the regime, and run the cheapest decisive test first under your own costs and latency. Use when asked to find something to trade, when there is no lead yet, or when a raw idea needs a decision on whether it deserves a test."
---

## What this does

Finds trading leads and decides cheaply which ones deserve a full test. It sits before
`onchain-strategy-research`, which validates a lead that survives triage, and before `candle-strategy-design`, which
turns a survivor into a strategy. It improves how an agent looks for and tests ideas, so less is lost on ideas that
were never alive. It does not supply an edge, and a hunt that ends with no lead and the capital intact is a valid
result.

## The rule

**A lead is judged under the tester's own conditions: fee tier, ticket size, latency, capital, data source and
period. A lead that fails is recorded with those conditions and the break-even point it missed, not as a verdict on
the idea.** A reader with lower costs, a faster path, a different size or a different market may find the same lead
alive, and the record has to let them see that.

## Start from the market

What just happened is the cheapest source of leads, because it describes something that did happen and the data can
check it. A lead reasoned from structure (a carry, a forced flow, a rebalance) is equally valid once it names its
counterparty and shows a recent instance in the data. Before choosing a hypothesis:

- **List what moved** over a recent window that suits the operator's horizon (state the window on the lead card): the
  largest gains, the largest losses, the largest volume.
- **Check whether the data saw it,** and when it first became visible at availability time. A move the data never
  saw, or saw only afterwards, cannot be traded from that data; that is a data finding, not a market finding.
- **Find who made money on it and how:** entry relative to the asset's age or the start of the move, hold time, exit
  style (all at once, in steps, into strength). Profit taken by a few early holders is a different lead from profit
  spread across late entrants.
- **Try the reversed role.** If buying into attention loses, test selling into it. If following a move loses, test
  fading it. A trade that loses gross may be a lead when reversed; one that loses only through costs loses on the
  reverse too. Test the reverse net of its own costs (borrow, funding, whether the rail allows it at all).
- **Stay inside the operator's market, rail and holding horizon.** A lead outside them is noted and handed back, not
  chased.

## The universe is a census

Keep the universe ledger and random control sample from `onchain-strategy-research`, and use that control as a
benchmark too, beside no trade (its benchmarks and simple matched policies). For a single-asset or timing strategy,
the control is random entry times in the same asset with the same hold. Split every result by structural features
(venue, pool or market type, tax or fee tier, age at entry), since one segment can carry all the edge or all the decay
and the pooled number hides both.

## Name who pays

Every profitable trade has a counterparty. Name who loses the money the lead makes and why they keep doing it: late
buyers paying for attention, a liquidity provider paid less than its adverse selection, a forced seller, a slower
follower. A named counterparty also says when the lead should stop working: when that group stops arriving.

When no counterparty can be named, mark the lead **unexplained**. It can still be tested and run. Nothing says what
would end it, and its end looks like an ordinary bad week until the losses add up, so the missing end condition is
replaced by two measurements written in advance: the length of the forward sample before money (in signals, or in
large winners for a skewed payoff), and a decay monitor (a rolling net result against the band the forward sample
set) that stops entries when it is breached.

## Know the regime

A result belongs to the market state it was measured in. Label every window by regime, using a measure fixed before
the test (for example market-wide volume or new-listing count against a trailing baseline), and report the lead per
regime.

- A lead that lives in one regime is a lead for that regime. It is legitimate if the strategy can detect that regime
  in real time and stand down outside it, or if its net over the expected mix of regimes is positive. Measure the
  detection: label regimes with the real-time measure as of each
  decision, and report how often it agrees with the after-the-fact label and the lead's net when they disagree.
- The trap is fitting on a busy window and running in a quiet one without knowing. Count how many signals fall in the
  busiest sub-window; if most do, the result describes that window.
- State which regime the live period is in next to every result.

## Triage, cheapest test first

Each step costs more than the one before. Write the kill condition for a step before running it, so the result
cannot move the line. Run every step on the tester's own conditions: their fee tier, their ticket size, their measured
slippage and latency, never someone else's. The kill conditions below are examples; the tester writes their own.

Gross is measured from the lead's own profit source: the price move for a directional lead, the spread captured for a
market-making lead, the funding or fees received for a carry or liquidity-providing lead. Funding, fees and rebates are
booked on whichever side they fall: a cost when paid, part of gross when received.

1. **Quick look.** Gross returns over the full cohort, against no trade and the random control, with the exit the
   lead proposes (or a stated base exit), in the lead's direction, per regime and per structural split. Example kill:
   the cohort is not positive gross; or, for a lead that claims to select within its universe, it does not beat the
   control. (A lead that takes the whole universe matches a random sample of it by construction.) A lead whose edge is
   in a different exit is re-run with that exit, not killed.
2. **Cost check.** Fees and measured slippage on both legs at the real ticket size, gas, any token transfer tax on
   both legs, and funding, borrow or financing paid over the holding period (see `candle-trading-discipline` and
   `candle-transfer-fee-tokens`). Example kill: the gross return (or, for a selecting lead, the margin over the
   control) does not clear the round trip.
3. **Tape replay.** Entries only after the signal was available, plus the measured delay; exits from the next bar or
   tick after the entry; a pessimistic-entry variant (the worst price in an entry window as long as the measured
   delay's bad tail, not longer, for an order that takes liquidity, or the bad tail of the tester's own measured
   fills; a resting limit order counts as filled only when the price trades through it), reported beside the base.
   Example kill: the pessimistic variant is negative net.
4. **Time split, then a fresh forward sample.** Fit on the earlier part, test once on the later part, then record a
   new forward sample nobody has looked at. Size each slice to the payoff shape before looking: for a skewed payoff,
   long enough that the chance of several large winners at the observed rate is high, not merely expected (see
   `candle-strategy-design`, payoff shape). Example kill: the sign does not hold on a slice
   that long; a shorter slice is "inconclusive, extend".
5. **Hand-off.** A survivor goes to the full protocol and a shadow portfolio in `onchain-strategy-research`, then to
   `candle-strategy-design`.

A lead killed at any step is recorded with the step, the number, and its break-even: the round-trip cost and the
latency at which it would have passed. An illustrative record, fictional figures: "net negative at a 4 % round trip
and 60 s delay; break-even near 1.5 % and 10 s". That tells the next reader whether to retest. "Dead" does not.

## No history yet

With no recorded data, start recording the cohort now, every member with its receipt time (see
`candle-market-data-ingestion`). The quick look and replay wait for that data, so the first decisive test is forward.

## Measurement errors that make a dead idea look alive

`onchain-strategy-research` covers availability time, as-of labels, survivorship in the universe, fees counted twice,
pessimistic ordering inside a bar and the result without the largest winner. Costs counted zero times fool a replay
as surely as costs counted twice: a quote-based fill with no slippage, a missing gas or tax leg. Three more fool a
replay, each with its check:

- **The exit loop includes the entry bar.** A buy at a bar's close whose exit loop starts on that same bar can sell at
  that bar's high, a price from before the buy. Check: exits start on the next bar; a win booked inside the entry bar
  is a bug until proven otherwise.
- **An in-sample segment treated as confirmed.** A split found while exploring (a tier, a venue, an hour of day) is a
  hypothesis, even when it explains the whole result. Check: confirm it on data not used to find it, usually forward.
- **A skewed payoff judged by its mean or median alone.** A few large winners carry the result, and a filter that
  lifts the median can remove them. Check: next to each filter's mean and median, report the large winners it
  removes. Marked returns also need a column with assets that stopped trading (dead tokens, delisted or halted
  markets) at their last print or at zero, since marks taken only where a price exists drop them.

## Conditions decide, not families

Whether a kind of strategy works depends on conditions the reader can measure. State which conditions a result
depends on (cost tier, ticket size, latency, capital, data source, period, regime) and how the reader measures their
own. Two dependencies that can decide a result:

- **Copy-style strategies depend on follow lag and cost.** The leader's return is not the follower's. Measure the
  follower's lag from the leader's fill to its own fill, then test it against a random entry in the same assets at
  the same lag and cost. Beating that random entry means the selection carries over at that lag. Matching it means the
  follower's entries carry no selection at that lag: the leader's return came from something the follower does not
  copy (speed, exits, or which positions it kept). A faster or cheaper follower, or one that also copies exits, can
  measure its own conditions and retest.
- **Many variants sharing one gross means the tweaks are not changing the signal.** When thresholds, delays and
  horizons all land near the same gross return, they re-cut one input. Change the input or the mechanism, not the
  parameter.

## The lead card

One page per lead, killed or alive:

- **Observation:** what was seen, in which data, and when it was first visible.
- **Counterparty:** who pays, or "unexplained".
- **Universe and control:** the census definition, its size, the random control.
- **Regime:** the regime of each window and the result per regime.
- **Gross, cost, net:** gross over the control, the round trip measured at the tested size, net.
- **Triage:** the step it died at or passed, with its number and the kill condition written beforehand.
- **Next decisive test:** one test, the result that decides it, and a time estimate.
- **Tested under:** fee tier, ticket size, latency, capital, data source and period.

Killed leads go into a **tested-under register**: the lead, the step where it died, its break-even cost and latency,
and the conditions above. A reader whose conditions differ can see which leads are worth a retest without repeating
the hunt.

## Posture

- One decisive test per lead, chosen because its result changes a decision, with a time estimate.
- Report results with conviction: "alive under these conditions, next test X" or "killed under these conditions,
  break-even Y". Both are results.
- Evidence standards stay fixed. The posture is to hunt for what works under the reader's conditions, not to collect
  reasons why nothing can.
- Every spend, including a test with real money, is the operator's decision.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.

## Checklist

- Did the hunt start from what moved recently, whether the data saw it, and who made money and how?
- Is the universe a census with a random control, and is every result split by structural features?
- Does each lead name its counterparty, or carry the "unexplained" mark with a forward sample length and a decay
  monitor written in advance?
- Is every window labelled by regime, with results reported per regime?
- Was each triage step's kill condition written before the step ran?
- Was the cost check run at the tester's own fee tier, ticket size and measured slippage, both legs?
- Does every killed lead record its break-even cost and latency, not just "dead"?
- Were the entry-bar exit, in-sample segments and large winners per filter checked?
- With no history, is the cohort recording now, and is the first decisive test forward?
- Is every negative result stated as a dependency on measurable conditions, never as a verdict on a kind of strategy?
- Does every lead have a card with its tested-under conditions?

## Related skills

- `onchain-strategy-research`: the full validation protocol after triage
- `candle-strategy-design`: turning a surviving lead into a strategy
- `candle-trading-discipline`: the cost arithmetic this triage uses
- `candle-market-data-ingestion`: recording a cohort with receipt times
