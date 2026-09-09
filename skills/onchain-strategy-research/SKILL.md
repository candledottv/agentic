---
name: onchain-strategy-research
description: "Research onchain trading mechanics, audit wallet and token evidence, and turn observations into reproducible strategy experiments with executable fills, temporal validation, and capital controls. Use for onchain strategy research and trading-pipeline reviews."
---

# Onchain strategy research

Build a repeatable process for discovering and rejecting trading hypotheses. The output is a decision supported by data available at decision time, a feasible execution path, and net portfolio outcomes. A compelling token story, wallet leaderboard, or positive backtest alone is insufficient.

Read [The Game](references/the-game.md) for market structure and corrected accounting. Read [Research protocol](references/research-protocol.md) when designing experiments or reviewing a pipeline. Read [Claim register](references/claim-register.md) when using numerical claims inherited from the original game document.

## Working rules

- Define the chain, venue, lifecycle stage, observable universe, decision clock, capital budget, and intended holding horizon first. A launch feed is not a complete market census. Pump mechanics are not universal Web3 mechanics.
- Separate verified program behavior, sample-specific observations, inferred mechanisms, and untested hypotheses. Numerical claims need a source, observation window, denominator, and version. Source reputation does not substitute for a reproducible measurement.
- Audit data before interpreting returns: asset identity and decimals, beneficial trader versus router, economic swap versus transfer, quote currency, basis completeness, event time versus availability time, deduplication, coverage, and revisions.
- Historical decisions may use only information available then. Preserve cohort membership, model version, scores, token state, source payloads and corrections as of that decision. If missing, label a replay retrospective and require fresh prospective evidence.
- A trade label must specify quantity, entry delay, route, fees, exit rule, liquidity and failure handling. Last trade, market cap, candle close and executable liquidation value are different measurements. Missing exits remain visible.
- Optimize expected net portfolio dollars/native units subject to survival, liquidity and drawdown. Report median and tail outcomes as diagnostics. Neither positive median nor high win probability proves positive expectancy.
- Register hypotheses and attempted variants before evaluating the holdout. Separate research, calibration and untouched tests. Account for repeated tokens, related wallets, overlapping holdings and repeated strategy searches.
- Give agents bounded analytical tasks: evidence extraction, hypothesis specification, adversarial review and result explanation. Deterministic code owns signal computation, admission rules, accounting and execution state.
- For an audit, inspect production read-only and save bounded queries with timestamps and code revisions. Research does not itself authorize order placement, production configuration changes, messaging or deployment.

## Deliverables

Produce a concise verdict, a claim/evidence ledger, a trace from raw event to realized result, prioritized improvements with acceptance criteria, and an experiment card for each candidate. Distinguish implemented behavior, proposed behavior and unresolved measurements. A valid outcome is to reject all candidates and retain capital.
