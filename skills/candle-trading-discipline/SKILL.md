---
name: candle-trading-discipline
description: "[RISK CONTROL] How much to bet, when to stop, and the arithmetic that decides whether a strategy can be profitable at all. Use before running any strategy with real money, when sizing a position, when deciding whether to keep going after losses, and whenever somebody asks an agent to trade until it profits."
---

## What this is

The other skills teach you how to place a trade and how not to corrupt your own books. This one is
about whether you should be trading at all, at what size, and when to stop.

It exists because an agent given a wallet and told "make money" will, by default, trade. Trading is
the one thing it can always do. Deciding not to is the part that has to be taught.

## Start here: the arithmetic that decides everything

Before any strategy, work out what a round trip costs you. Nothing else matters until this number
is smaller than your edge.

A round trip is two trades, and each one pays:

- **The platform fee**, in basis points, by tier. Free pays 100, Believer 50, Pro 25, Max 0. Paid
  on both legs, so a Free account pays 200 basis points to go in and out.
- **Slippage**, twice. Not the quoted price impact. A measured round trip through a thin pool cost
  604 basis points against a pool reporting 4 basis points of impact. Two orders of magnitude apart.
  This is why the codebase calls 300 basis points "notable" rather than something tighter.
- **Gas**, which is flat and therefore brutal at small size. A fixed $0.20 is 2% of a $10 position
  and 0.02% of a $1,000 one. The same strategy is a loser at one size and viable at the other.

**Add them up before you trade, not after.** On a Free tier with a thin-pool round trip, you can be
down 8% the instant you are in and out, having been right about the direction.

This is also why Max exists: at 0 basis points the fee term vanishes and only friction remains.

## What this costs in practice, measured

Eleven graduated Solana tokens, sampled from the live feed on 2026-09-16. Each one a paper round
trip of 0.01 SOL in and straight back out, on a **Max** account, so the platform fee is zero and
these are **quoted prices only**: no slippage charged, no gas charged.

```
Drake        -6.98%      HUMAN        -2.61%
Kimchi       -4.58%      WIFELON      +2.95%   <- see below
x-0          -6.22%      Inucognito   -4.44%
SOLDAQ       -4.53%      BOBY         -4.58%
PARC         -2.54%      PARK         -2.29%
inu          -5.39%
```

**Ten of eleven lose money going in and straight back out**, on the best fee tier, before a single
real cost is applied. The middle of that range is about 4.5%.

So the edge a strategy needs is not "the token goes up". It is "the token goes up by more than
four or five percent, quickly, and then a bit more than that to cover the slippage and gas that
this table does not include". Any strategy targeting a 2% move on tokens like these is
arithmetically a losing strategy, however good its entries are.

### The one that looked positive

WIFELON quoted +2.95%. Re-measured sixty seconds later on the same token and the same size, it
quoted **+0.23%**, and 0.23% does not survive gas, let alone slippage.

That is what a quote-timing artifact looks like, and an agent scanning for free money will find one
of these every few minutes. **Measure it twice before you believe it.** An edge that does not
survive a second look one minute later was never an edge; it was two quotes taken at different
moments and subtracted.

## Sizing

**Risk a fixed fraction of the account per position, not a fixed dollar amount, and not a fraction
of what you have left after losing.** One to two percent is the conventional range and there is
nothing clever to add to it. The point is not the number; it is that the number does not change
because you feel strongly about a trade.

Three sizing rules that are actually about survival:

1. **Size from the stop, not from conviction.** If your stop is 30% below entry and you will risk
   1% of a $1,000 account, your position is $33. Deciding the position first and the stop second is
   how a single trade takes a quarter of the account.
2. **Never size so that gas is a meaningful fraction of the position.** If gas is more than about
   0.5% of your position, the position is too small to trade and the honest move is not to.
3. **Sizing up after wins is how a good week becomes a flat month.** If the size changes, change it
   on a rule written before the streak, not during it.

## When to stop

Set these BEFORE the strategy runs, on the key itself, so they are enforced by the rail rather than
by your own judgement at the exact moment your judgement is worst. Each is a positive magnitude and
each is independent:

- **Daily loss** resets at midnight UTC. It bounds a bad day.
- **Drawdown** is measured from the high-water mark and never resets on a clock. A drawdown that
  forgave itself every midnight would not be a drawdown.
- **Consecutive losses** catches the strategy that is wrong repeatedly at a size too small to trip
  either dollar bound. This is the one people forget, and it is the one that catches a broken
  strategy fastest.

**Zero is a real setting.** Zero consecutive losses means stop on the first loss. It does not mean
unset. Never decide any of these with a truthiness check.

**These bounds are the real protection, not your stop-loss orders.** A standing stop on Candle
flips to `triggered` and waits for your agent to complete the sale; it does not sell by itself, and
it needs a linked imported wallet, which the default main-wallet trading path does not have. The
loss limits above are enforced by the rail on the way IN to every trade, so they hold whether or
not your agent is awake. That asymmetry is the reason to set them rather than trusting an exit
order to save you.

**A volume cap is not a loss cap.** A key with a $10 per-trade cap and a $500 daily volume cap can
round-trip fifty losing scalps inside every limit it has and finish the day with an empty wallet.
Volume is what gets spent; loss is what does not come back. Set both.

## If you are told to trade until it profits

Say plainly that this cannot be promised, then do the part that can be done.

**No strategy returns a profit on demand, and the instruction to keep going until it does is the
single most reliable way to turn a small loss into a large one.** It removes the stop, which is the
only thing standing between a losing strategy and the whole account. Every blown account has this
instruction somewhere in its history, usually phrased as making it back.

What to do instead, in order:

1. **Rehearse in paper mode** until the strategy has enough closes to say anything. Ten closed
   round trips is the floor below which a win rate is noise.
2. **Compare the paper result against the cost arithmetic above.** If the edge is smaller than a
   round trip costs, stop here. This is the most valuable outcome this skill produces, and it costs
   nothing to reach.
3. **If it survives that, run it live at the smallest size that keeps gas under half a percent**,
   with the loss limits set, and let the limits do their job.
4. **When a limit trips, stop and report.** Do not raise the limit and continue. The limit was set
   by someone with a clearer head than whoever is watching a drawdown.

A valid and common result is that no candidate strategy is worth running and the capital stays
where it is. Report that as the finding it is, not as a failure to find something.

## What a paper result does and does not tell you

Paper mode runs every admission rule a live trade runs: the same planner, the same spend gate, the
same key cap, the same loss limits. That is what makes it worth anything.

But **a paper fill books the price it was quoted**, and a real fill arrives at whatever the pool
gave you. So paper profit is systematically better than live profit, and the gap between a paper
arm and a live one IS your execution cost. Run both and the difference is the number you could not
otherwise measure.

### Paper proves ADMISSION, not fundability

Measured on staging 2026-09-16: a paper buy of **100,000 SOL** was accepted on a wallet holding
**zero**. That is not a defect in paper mode, and it is worth understanding rather than working
around.

The admission rules are the key's caps, the tier, the loss limits and the kill switch. Whether the
wallet can actually cover the trade is not one of them: that is checked when the transaction is
SIGNED, and paper stops before signing because signing is the part that moves money.

So a paper run tells you the strategy is allowed. It does not tell you it is affordable. Check the
balance yourself before sizing, and treat a paper fill on an unfunded wallet as exactly what it is:
a quote, not a rehearsal of a trade that could have happened.

Two consequences:

- **A strategy that is barely profitable on paper is losing money live.** Discard it without
  running it.
- **Paper never reaches the public record**, because the value of a Candle record is that it is
  derived from trades that actually happened.

## Before the first live trade

- Costs per round trip computed, and the edge is bigger than they are.
- Loss limits set on the key: daily, drawdown, and consecutive.
- Position size derived from the stop, and gas under half a percent of it.
- The exit decided and attached to the entry, not planned for afterwards (see candle-risk-gate).
- The token gated on forensics AND on its coverage (see candle-risk-gate).
- At least ten paper closes, and the paper edge survives the cost arithmetic.

If any line is unchecked, the answer is not yet.
