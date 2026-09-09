# Research protocol: observations to deployable strategies

## 1. Record the information set

Give every observation an event timestamp and an availability timestamp. Preserve block/slot, transaction index, log/instruction index, signature/hash, commitment, provider, payload hash, parser version and correction epoch. A backfilled old transaction is new information when received; it must not become a historical real-time signal.

Maintain immutable raw records and versioned economic swap legs. One routed transaction can produce many logs and multiple genuine economic legs; deduplicate by the semantic leg, not just by transaction hash. Verify quote-asset flows, actual beneficiary, token units and fees. Keep transfer-only flow distinct from trade demand.

Version wallet/entity/group membership with `valid_from`, `valid_to`, `known_at`, classification evidence and confidence. Version score model, feature schema and feature snapshot. A common SQL query in training and production prevents code drift but not availability leakage: historical backfills can change the data underneath it.

Define a universe ledger: every eligible token/candidate, why it was observed, when it became eligible, and all exclusions. Store failures and no-trades. Avoid selecting history by today's leaderboard, lifetime ATH, surviving tick streams or manually requested winning tokens.

## 2. Split data quality into measurable dimensions

Measure coverage of requested time, chain transactions, parsed transactions, attributed economic legs, priced volume and matched cost basis separately. A source reporting 100% time coverage does not establish 100% transaction or holder coverage.

Track p50/p95/p99 delay at receipt, parsing, signal, decision, build, send and confirmation; distinguish new flow from backfill. Track provider discrepancies, duplicate rates, missing-unit rates, unknown basis, orphaned/reverted observations and schema drift. Tie each threshold to the strategy's horizon and validate it before promotion.

Allocate vendor spend by marginal improvement: incremental unique eligible events, improved lead time, reconciled fills and ultimately prospective net outcomes. Keep inexpensive broad discovery and spend detailed account/RPC analysis on a bounded sample or funded candidates. Save a random control sample so focused acquisition does not erase the denominator.

## 3. Define outcomes executable by this system

For every candidate, simulate a decision after its real information availability, then the observed execution-delay distribution. Use a quote or venue-state model for exact input/output size and direction. Reconcile route version, fees, slippage limits, failures, retries and migration state.

Separate:

- `mark_return`: a descriptive price movement;
- `simulated_net_return`: an explicit execution model;
- `realized_net_pnl`: settled receipt-based amounts with fees accounted once;
- `liquidation_equity`: cash plus feasible open-inventory liquidation estimates;
- `unreconciled`: unresolved order, balance or valuation state.

Silence does not establish a fill at the last trade. Keep the position unresolved, use a current executable sell quote when available, and report conservative zero-recovery stress alongside alternative recovery assumptions. Distinguish dead market, unavailable provider, frozen token and temporary liquidity gap. A later revival must not silently rewrite a frozen evaluation dataset.

Candles can support slow screening, not exact subminute execution. Preserve candle start/end/availability and granularity. If both stop and target could occur within the same bar, use pessimistic ordering or mark ambiguity; never choose the profitable order from hindsight. Test tick-only and coverage-matched subsets.

Model shared cash, native balances, open orders, correlated positions, global mint exposure and finite concurrency. Several rungs in one token are one risk episode. Idle-capital time and skipped opportunities affect results.

## 4. Register an experiment before tuning it

Use an experiment card:

```
experiment_id / parent / immutable definition hash
mechanism / counterparty paying / why opportunity persists
chain + venue + lifecycle + eligibility + acquisition policy
feature versions + decision clock + entity/cohort snapshot
entry / exit / order size / capital and concurrency
base and stressed latency, fees, impact and no-fill assumptions
training / calibration / untouched evaluation dates
all attempted variants and selection criterion
benchmarks and ablations
sample unit / dependence clusters / uncertainty method
pass, fail, continue and invalidation criteria
owner / next review / artifact locations
```

Evaluate the exact conjunction of filters and complete entry-exit-sizing policy. Positive unconditional pattern/group returns do not validate a filtered portfolio. Match the label horizon to the actual policy; a 24h endpoint is not evidence for a 6h stop-and-target rule.

## 5. Use temporal tests with honest uncertainty

Separate hypothesis exploration, calibration/selection and untouched testing chronologically. Purge overlapping label intervals; use an embargo where dependence or execution horizon warrants it. Distinct-token testing answers generalization to new tokens; time testing answers subsequent deployment. Report both when both are relevant.

Repeated search can manufacture apparent success. Record the full experiment family, including human sweeps and failed runs. Use family-aware statistical controls or a fresh locked prospective test after selection; do not interpret a sample-count floor as significance. [Bailey et al., probability of backtest overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)

Measure net expectancy, total PnL, profit factor, turnover, time in market, concurrent capital, drawdown and tail loss. Report win rate and median without substituting them for expectancy. Bootstrap by day/token/operator or risk episode as appropriate, not independent signal rows from the same pump. Report loss of the largest winner, top-token/operator contribution and size/delay sensitivity. These are robustness diagnostics, not automatic rejection of all skewed strategies.

A positive-median distribution can lose money through rare large losses. A negative-median distribution can earn money through adequately frequent, executable large wins. Remove demonstrably corrupt units/prices using predeclared data rules; do not hide data corruption by abandoning expected-payoff measurement.

Probability models need calibration and payoff magnitude. Track Brier/log loss, reliability by time/regime and decision utility, not AUC alone. Fit calibration separately from final assessment. Isotonic calibration can introduce ties, so ranking/AUC invariance is not exact for all monotone step mappings.

## 6. Run paired prospective shadow portfolios

Freeze the candidate definition. Send the same eligible intent to:

1. an ideal diagnostic mark portfolio;
2. an executable shadow portfolio using real-time exact-size quotes and failures;
3. an authorized, tightly capped live canary only after reconciliation is trustworthy.

Persist the same intent ID across paths, including rejected entries and exits. Attribute divergence to selection, data age, queue delay, route refusal, fee/impact, expiry, inventory mismatch and exit timing. Do not compare different calendar periods as though they were paired fills.

Keep LLM commentary outside the time-critical deterministic path unless its incremental contribution passes an ablation. Each model intervention must name the evidence it changes and the measurable decision it improves.

## 7. Promotion is an evidence gate

A suggested initial gate is: reproducible data with no known material availability leakage; positive net prospective expectancy with a predeclared uncertainty criterion; acceptable concentration and stressed liquidation loss; reconciled live canary amounts; latency inside the measured edge's usable horizon; and a funded operational recovery path. Set the numerical risk and evidence thresholds before evaluation, proportional to available capital and expected opportunity frequency.

An initial paper experiment may use, for planning, at least two weeks and 100 independent token episodes across multiple days; these are coverage targets, not proof or universal constants. A rare runner policy can require much longer. Continue gathering data when uncertainty is wide.

Stop new exposure when the predeclared loss, reconciliation, quote-age or feed-integrity limit is breached. Preserve exits and investigation capability. Retire or quarantine a failed hypothesis with its evidence so the next agent does not rediscover it under a new name.

## 8. The operating cadence

Continuously record the opportunity funnel and reconcile orders. Daily, attribute PnL and data gaps, update exclusions and review open unresolved risk. Weekly, inspect frozen prospective results and allocate research budget to the most informative uncertainty. Change one substantial hypothesis at a time. Reopen old conclusions only with a new regime, corrected data or a predeclared new mechanism.
