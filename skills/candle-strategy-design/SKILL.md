---
name: candle-strategy-design
description: "[STRATEGY] Turn a trading lead into a strategy that can be tested, run and judged: a one-page spec, judging and sizing matched to the payoff shape, exits designed per profit source, costs and break-even, a bar written before live, layers judged against the layer below, paired variants, running without interference, and a close-out verdict. Use when a lead must become a strategy, or when a running strategy needs amending or judging."
---

## What this does

Turns a lead into a strategy someone can build, run and judge. `onchain-strategy-research` supplies the experiment
card and validation, `candle-trading-discipline` the cost arithmetic, loss limits and sizing from a stop,
`candle-risk-gate` the token gate and the exit attached at entry, and `candle-book-limits` the caps. This skill adds
the design choices between them. It improves how a strategy is tested and judged so less is lost to a badly judged
one; it does not supply an edge, and deciding not to run is a valid outcome.

## The rule

**The payoff shape, read from evidence, decides how a strategy is sized and judged. Every choice (the bar, the caps,
the exits, what counts as success) is written down before the result is known.** A rule picked after the result can
always be made to pass.

## The one-page spec

Write it before any code. One page, these fields:

- **Premise and counterparty:** what the strategy expects to happen, and who pays (or "unexplained").
- **Universe and eligibility:** what qualifies, decided with information available at decision time.
- **Signal and availability time:** what triggers a decision and when it is first known.
- **Entry:** timing, delay, any price condition.
- **Exits:** every leg and what it is for (below).
- **Sizing:** the ticket, and the written rule under which it may change; any change outside that rule is an
  amendment (below).
- **Concurrency and capital:** maximum open positions, total capital, whether exit proceeds are recycled into new
  tickets, a reserve for exit fees.
- **Entry window:** start, end, and how open positions finish after it.
- **The bar:** what result means success, fail or continue (below).
- **Approval:** the operator approves the spec, its capital, its sizing rule and its bar before any live spend.
- **What the engine decides repeatedly:** discovery across many assets, entry timing, multi-leg exits, sizing per
  signal. If the answer is nothing, one buy and one sell in one asset, it is a trade, not a strategy: hand it back to
  the operator as a trade instead of building an engine for it.

## Payoff shape decides the judging

Read the shape from the evidence: the distribution of per-ticket results in the replay or forward sample. For every
shape the score is the net result after costs (expectancy and total net, as `onchain-strategy-research` puts it). The
shape decides what is read beside it, and when the net can be trusted.

**Grinding** (many small wins, rare large losses). Read median, hit rate, and the size and frequency of the worst
losses beside the net. Size from the worst loss that is measured or capped: the stop
(`candle-trading-discipline`), the liquidation distance on a leveraged position, or a hedge failure. The danger is the
large loss the sample has not shown yet,
so stress it.

**Skewed** (most tickets lose, a few large wins pay for them). Read the count of large winners and how flat the book
holds between them (the drawdown between winners, the cost of the losers) beside the net: until the sample holds
several large winners, the net is mostly luck in how many landed. The median is expected to be negative and says
little.

- The sample must be long enough to contain several large winners.
- Count the budget in tickets. `large winners wanted / observed large-winner rate` is only the ticket count at which
  that many winners are expected; at that count the chance of getting them is only a little better than even.
  Choose the count at which the binomial chance of at least that many winners, at the observed rate, is high.
  Illustrative arithmetic, fictional numbers: at a rate of 1 in 20, 60 tickets expect 3 large winners but deliver at
  least 3 only about 58 % of the time; about 105 tickets make it about 90 %. The capital covers that count plus fees,
  unless the approved spec recycles exit proceeds. A budget that runs out before the winners can arrive tests the
  bankroll, not the strategy.
- Losing streaks are the normal state. Set any consecutive-loss limit from the observed hit rate, at a streak that is
  unlikely while the hit rate holds, not at a length that suits a grinding book.
- The upstream result without the largest winner is a diagnostic here: it says how many winners the book depends on,
  which sets the sample size. Requiring the book to stay positive without its top winner fails a working skewed book
  by design.

**Unclear.** Report both sets of measures until the shape settles.

## Exits per profit source

Each exit leg names what it earns from. Legs to consider:

- **Take the cost back out:** sell enough at a first target to recover the ticket and costs, so the rest carries no
  principal. On a leveraged position, check the remainder's liquidation distance: it still carries risk.
- **Scale out into strength:** sell in steps as the price rises (for a short, cover in steps into weakness), since the
  top is not knowable and, where a move is attention-driven, attention fades.
- **Keep a core:** a slice held for the rare large move, with its own time or trailing rule.
- **Time stop:** close what has not moved by a deadline, freeing capital and slots.
- **Dead positions:** cut early and cheaply by a rule written in the spec in advance (what "the premise has failed"
  means, measured), or write off a position worth less than its sell cost instead of paying to sell it.

Judge each leg against the base exit on the same signals. **An entry condition that waits for a better price** (a dip,
a pullback, a confirmation) reports the moves it missed: the signals that never came back to the price and what they
did afterwards, not only the price it improved on the ones that filled. In a skewed book, count the large winners among
the missed moves against the improvement on the fills.

## Costs and break-even

Put the costs in the spec: fees, measured slippage on both legs at the real ticket size and gas, as
`candle-trading-discipline` computes them; token tax on both legs (`candle-transfer-fee-tokens`); and funding, borrow
or financing over the expected hold. Funding, fees and rebates count on whichever side they fall: a cost when paid,
part of the return when they are the profit source (carry, market making, liquidity provision). Write the break-even
into the spec too, all net of the round trip:
`break-even hit rate = average loss / (average win + average loss)`, and the average win size needed at the observed
hit rate.

## The bar

Before live, write which result, in which units, over which count or window means success, fail or continue, and the
operator approves it; this extends the pass/fail/continue line of the upstream experiment card. Check that the caps
can reach the bar (`candle-book-limits`), and that the entry window can: entries possible = window length x expected
entry rate, which must be at least the count the bar needs.

## Build in layers

Start with the base rule, then add one gate or exit change at a time.

- Judge each layer against the layer below on the same signals: what it kept, what it refused, and what the refused
  ones did afterwards.
- A small improvement stacks when its sign holds across days, resamples and out of sample. Do not drop it for being
  small, and do not keep a large one that held once.
- In a skewed book every gate and cap reports the large winners it kept and cut next to its mean. A layer that cuts a
  large winner is judged on the net with that winner counted, and on how many winners it would cut per hundred
  tickets at the observed rate; a gain in the median never justifies the cut on its own. A price or size ceiling that
  refuses an entry is a gate and reports its cuts too.

## Compare on the same signals

Run a variant beside the base on the same signals with one change, not across different periods; a paper twin beside
a live book measures execution cost (paired shadow portfolios, `onchain-strategy-research`).

## Running without interference

- Outside rules the operator approved in advance, nobody flattens losers or pauses entries on a feeling, and raising
  a cap is always an amendment the operator approves. Losing positions are data the verdict needs.
- Read results at planned checkpoints, not after every fill.
- Every amendment carries a new version id, the evidence, the expected effect and the operator's approval, and states
  whether it applies to new entries only or to open positions too. One substantial change at a time, so the next read
  can attribute the effect.
- The operator's own controls (pause buys, flatten) are not "on a feeling" in this sense: they stay available, are
  never argued with, and each use is recorded with its effect on the experiment.

## Close-out

At the end of the window, give a verdict against the bar written before: success, fail or extend. Then attribute it:

- which positions made the result; the result without the top winner and without the top few;
- the live-versus-backtest gap, split into missed entries (signals the live book did not take: caps, delays,
  refusals, outages), slippage and fees above the model, exits that differed from the replay, and the outcomes of the
  positions taken against the backtest's distribution on the same kind of signal (sample luck or a changed market);
- the regime during the window against the regime of the backtest.

Then the next version, one change with its evidence and the operator's approval, or retirement with a tested-under
record (cost tier, ticket size, latency, capital, data source, period, regime, break-even) so a reader under other
conditions can see what to retest.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.

## Checklist

- Is there a one-page spec, written before code, with every field filled?
- Does the spec say what the engine decides repeatedly, or was a single trade handed back as a trade?
- Was the payoff shape read from evidence, and do the judging measures match it?
- For a skewed book: is the budget counted in tickets, and is the sample long enough for several large winners?
- Does every exit leg name its profit source, including how dead positions are handled?
- Does any better-price entry condition report the moves it missed?
- Are costs and the break-even hit rate in the spec, at the real ticket size?
- Was the bar written before live, and can the caps and window reach it?
- Was each layer judged against the layer below, with large winners kept and cut reported?
- Is every amendment versioned, with evidence and the operator's approval?
- Does the close-out attribute the result, including the live-versus-backtest gap split?

## Related skills

- `candle-strategy-hunt`: where leads come from
- `onchain-strategy-research`: the experiment card and validation this design feeds
- `candle-trading-discipline`: loss limits and stop-based sizing for grinding strategies
- `candle-book-limits`: caps sized from the bar
- `candle-strategy-to-bot`: building the spec into a bot
