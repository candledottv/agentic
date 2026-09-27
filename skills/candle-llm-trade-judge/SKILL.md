---
name: candle-llm-trade-judge
description: "[RESEARCH] Test whether a language model adds anything to trading decisions before trusting it, and give it the role where that can be measured: a judge or veto over a deterministic entry rule. Use when putting a language model in a trading loop, when evaluating an agent that decides entries or exits, and when a model-driven strategy keeps converging on the same trades whatever the prompt says."
---

## What this does

It is tempting to hand a language model the market state and ask it whether to buy. The answer comes
back fluent and confident, and it is hard to tell whether the model is adding judgment or restating
one number from its input. This skill describes how to tell, and how to structure the model's role so
its contribution can be measured.

`onchain-strategy-research` already says to keep model commentary out of the deterministic path
unless an ablation shows it helps. This skill is the practical version of that ablation. Its
observations come from tests of one model on a small set of liquid tokens; treat them as hypotheses
to check on your own model and data, not as laws.

## The rule

**Assume a model given price features may be a momentum rule until an ablation shows otherwise. Keep
deterministic code in charge of admission, sizing, accounting and execution. Test the model as a
veto on a deterministic entry, against that same entry with no model, on data it has not seen.**

## Why it matters

- When a question asks whether something is a good upward trade and the input includes recent price
  changes, the price fields can end up answering it. A model's enter or wait decision can then be
  reproduced to high accuracy by a single threshold on recent return and distance from the recent high.
  Changing the wording, framing, memory or sizing options can change how often it enters while every
  variant still keys on the same price fields.
- A momentum rule selects a similar population whoever runs it. If that population has no edge net of
  costs, no prompt creates one: gross returns sit near zero across variants and costs become the whole
  loss.
- A feature block that is silently empty or mostly null gives the model nothing to use, so it decides
  on the fields that are populated. It then looks as if the model ignores flow, when the flow data
  never arrived.

## How to check

Steps 2 and 4 send extra requests to a model provider. Run them only within a budget and a data-egress
scope the operator has approved for the test.

1. **Replicate with one rule.** Fit a single threshold on the model's own inputs to predict its
   decisions. If it reproduces nearly all of them, the model is behaving as that rule, and the operator
   can decide whether to replace it with the rule, which is free, deterministic and fast.
2. **Price-blind ablation.** Send the same decision points with price and return fields removed. If the
   model almost stops entering, or its confidence collapses, price was its main source of conviction.
3. **Audit the inputs before the run.** For each feature block, count how often it is null or empty
   across the decision points. Fix the data before testing the model on it.
4. **Separate facts from opinions.** If the model sees its own earlier assessments of a position, those
   opinions can steer later decisions (suppressing or anchoring them). Test facts-only memory against
   memory that includes prior opinions.
5. **Truncate at decision time.** Build each packet from data available at the decision moment and test
   that appending future data does not change the packet.

## The role to give it

- Let deterministic code produce the candidate entry, the size and the exit plan.
- Ask the model a narrow question it can add information to: should this specific candidate be
  skipped? Give it evidence the rule does not already use, such as aggregated buying and selling flow
  (counts and volumes), never wallet identities.
- Compare three arms on data the design was not tuned on: rule alone, rule plus model veto, and a
  random or always-enter control. Pre-register the bar, including whether results must hold per
  token episode, not only per decision point.
- Expect a small effect at best. A veto of this kind can pass a pre-registered holdout at the
  decision-point level and still show no effect at the episode level on fresh data, which is why the
  bar above includes episodes.
- Judge the result net of costs. A veto that improves the kept trades by less than one round-trip cost
  changes nothing you can bank.

## Operating the model safely

- Send the minimum data needed: normalized features, no wallet identities, account details or
  anything the model does not need to decide.
- Keep a receipt for every call (input hash, output, model version, latency, cost) and meter spend
  against a budget the operator set before the run.
- Pin the model version for the length of a test; an alias that moves mid-test mixes two models.
- Model confidence is not a win probability. Calibrate it against outcomes before using it for sizing,
  if at all.
- The model advises; it never holds signing authority, and its answer never bypasses the book's
  limits or kill switches.

## Checklist

- A one-rule replication of the model's decisions has been tried.
- A price-blind ablation has been run, within an approved budget and egress scope.
- Every feature block was checked for nulls before the model saw it.
- Facts and prior opinions are separated in any memory given to the model.
- Packets are truncated at decision time and tested for leakage.
- The model's role is a veto or judge over a deterministic entry, compared against the rule alone and a control.
- Results are judged net of costs, per episode as well as per decision, on data the design was not tuned on.
- Calls have receipts, a budget and a pinned model version; no wallet identities are sent.

## Related skills

- `onchain-strategy-research`: holdouts, repeated-search control, and why commentary stays out of the deterministic path.
- `candle-trading-discipline`: cost arithmetic that any model-driven edge still has to clear.
- `candle-kill-switches` and `candle-book-limits`: controls the model's answer can never bypass.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
