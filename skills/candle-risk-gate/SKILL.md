---
name: candle-risk-gate
description: "[RISK CONTROL] Decide whether a token is safe enough to buy, make sure the position carries its own exit before you own it, and judge whether a wallet is worth following. Use before any buy, before copying any trader, and whenever a check comes back unavailable rather than clean."
---

## What this does

Three refusals, in the order a real buy meets them.

1. **Is this token safe enough to buy?** Read the forensics, and read its coverage.
2. **How do I get out?** Decide the exit before the entry, and attach it to the entry.
3. **Is this trader worth following?** Profit is not the answer to that question.

Nothing here executes. It is the set of reasons to not execute.

## The rule underneath all three

**Unmeasured is not clean.** Every check in this system can come back "we could not see", and
that answer is deliberately shaped so it cannot be mistaken for "we looked and it was fine".
Reading the first as the second is the cheapest way to lose money on this platform, and it is
cheap precisely because nothing errors: the response is a normal 200 with a field set to null.

So: a `null` is never a zero. An `unavailable` coverage is never a pass. A missing concentration
figure does not mean supply is well distributed, it means nobody counted.

## 1. Gate the buy

`candle_token_forensics` with `{ chain, mint }` returns the deployer's other launches and how they
ended, who bought in the deploy window, holder concentration, and `risk.tier`, which is one of
LOW, MODERATE, HIGH or CRITICAL with a reason per factor.

**Refuse an unprompted buy at HIGH or CRITICAL, and say which factor drove it.** The tier is
additive and every factor reports its own points and reason, so you can always name the reason
rather than citing a number nobody can argue with.

### Read the coverage before you read the findings

`coverage.checked` lists what actually ran. `coverage.unavailable` lists what did not. A finding is
only evidence if its check is in the first list.

Tokens Candle did not launch now get a real report rather than a refusal, because holder
concentration needs only the mint. What cannot be recovered for them is anchored to a launch
record Candle never saw, so `deployer_history` and `deploy_window` come back unavailable. The
coverage reason is `external_launchpad`, which means the token is fine and nothing is broken.

That is a genuinely weaker report: one measured factor instead of four. Size accordingly. A LOW
tier computed from one factor is not the same claim as a LOW tier computed from four, and the
coverage object is how you tell them apart.

### What concentration means here

Program-controlled accounts are excluded, so a pool vault is not reported as a whale. What is left
is wallets. A top-10 share above roughly half the supply is a position that can be exited into you.

## 2. Never hold a position with no way out

**Decide the exit before the entry.** Not as discipline, as sequencing: between a buy confirming
and a stop being placed by hand there is a window where the position is naked, and on this class
of token that window is long enough to lose most of it.

Place the exits as part of the entry rather than as a follow-up. A bracket is validated before the
buy is spent, so an exit that cannot be honoured costs you nothing; a bracket placed afterwards
can fail with the position already open.

Rules a bracket must satisfy, all of which are refused rather than repaired:

- A take-profit sits **above** the entry, a stop **below** it. On the wrong side, or exactly at the
  entry, it is already triggered and sells at market on the next sweep. That is nearly always a
  typo for a number on the other side.
- Exits may sell **less** than the whole position, which leaves a runner on. They may not sum to
  more than it. Over-committing does not fail at placement; it fails at the last trigger, when an
  order that looks healthy finds nothing left to sell.
- A trailing stop takes a trail and no fixed target. Below half a percent a trail is noise rather
  than protection.

Every leg either lands or none does. If a bracket is refused, you are holding no exits, not some
of them, and you should know which.

### What a standing order on Candle does NOT do

Read this before you rely on one. Two limits, both verified against the running product:

**A triggered order does not sell.** The keeper makes exactly one decision, whether the price
condition holds, and exactly one write, flipping the order's status to `triggered`. It never builds
a transaction and never signs. YOUR AGENT then has to notice and complete the trade through
`/orders/:clientOrderId/fill`. Past the expiry, a triggered order is abandoned rather than
executed.

So a stop here is an alarm, not an automatic exit. If your agent is offline when the price breaks,
nothing sells. Plan for that: it changes what a stop is worth, and it means "I attached a stop" is
not the same sentence as "my downside is capped".

**A standing order needs a linked wallet.** Limit, stop and trailing orders all require a
spend-capable imported wallet. The main embedded wallet that `candle_trade` spends from by default
cannot back one. So on the default trading path there is currently no standing stop available at
all, and the only exit is your agent selling.

Neither of these is a reason to skip the exit. They are reasons to know what the exit is: a
scheduled prompt to act, delivered to something that has to be alive to receive it.

## 3. Judge a trader on whether you can follow them

A published record answers whether an account made money. That is not the question you are asking
when you consider copying it.

A wallet that enters at a forty-thousand-dollar market cap and is out in nine seconds can be
genuinely excellent and still hand you a loss every time, because your fill lands on the far side
of its exit. Its profit was real and it was never available twice.

So read two scores, and a backtest:

- **Track record** asks whether the trader is good. It weights loss discipline hardest: a wallet
  that wins three times in ten can score well if it cuts the other seven early.
- **Copyability** asks whether you can capture it. Entry size, hold time against your latency,
  flip rate, position size against your gas, and trade frequency. A bot-tier wallet is not
  copyable by a person however good it is.
- **The backtest** is the number you actually want: the wallet's return minus your latency drift,
  minus a round trip of slippage, minus gas as a share of your typical position. It can be
  negative while the wallet is up, and when it is, that is the answer.

Two more things the score tells you:

- A wallet that mostly trades tokens **it launched itself** set the price and knew the supply. Its
  entry timing and win rate are not evidence of skill, and both scores are shown at a steep
  discount with the reason attached.
- An `insufficient` verdict is not a low score. It means too few closed round trips to say
  anything, and it must not be rendered as a weak result.

### Where to start when you have no list

Curated cohorts answer "who should I watch", which the watchlist assumes you already answered.
Only accounts that published their record are eligible, and they are ranked by how followable they
are rather than by how much they made, because the most profitable name on such a list is
frequently the one you can least afford to copy.

## Reading these over HTTP

The forensics gate is a tool call. The wallet judgements are public, keyless reads on the API host
(`https://api.alpha.candle.tv` by default, or `CANDLE_API_URL`):

```
GET /api/v1/markets/wallets/<address>/copy-score
GET /api/v1/markets/cohorts/<steady|high_conviction|early_finder>?limit=10
```

A wallet with no published record answers 404, which is consent rather than an error: that account
chose not to have its trading read. Do not treat it as a data gap to route around.

## Worked refusal

"Buy me some of this token."

1. `candle_token_forensics` → `risk.tier` is HIGH, driven by `undisclosed_deploy_buyers`.
2. Say so, name the factor, and do not buy.

"It's fine, buy it."

3. That is their call. Buy it, and attach the exits in the same instruction rather than after.

"Copy this wallet, it's up 300%."

4. Read the copy score. If the backtest says you keep a negative number after latency, slippage
   and gas, tell them that before they follow it. The 300% is not in dispute; their share of it is.
