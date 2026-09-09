# The Game, revised research edition

Version 3, researched September 4, 2026 America/Los_Angeles (September 5 UTC). This replaces the original's categorical conclusions with testable mechanisms. It retains the useful premise: market structure determines which opportunities a participant can actually capture.

## 1. The board is an adaptive market with unequal access

Onchain speculation combines observable transactions with hidden ownership, private information, variable execution priority, fragmented liquidity and reflexive attention. A wallet can reveal an action without revealing its operator, inventory, hedges, referral income or intent. Observability after execution is not advance access.

The useful poker analogy is incomplete. Participants can enter and exit; liquidity and protocol rules change; the same operator can occupy several seats. A market can have negative aggregate speculative trading returns after costs while a particular rule has positive conditional expectancy. Neither structural cynicism nor an attractive chart establishes that rule.

For non-cash-flow tokens, resale demand often dominates value. Do not generalize that premise to stablecoins, redeemable claims, productive protocol tokens or all of Web3. Lending, liquidations, arbitrage and liquidity provision have different cash flows and constraints. A strategy must specify its actual market.

## 2. The score is wealth after costs and external flows

For a defined portfolio and numeraire:

`economic PnL = ending liquidation equity - starting liquidation equity - external deposits + external withdrawals`

Reconcile settled cash and inventory separately. For SOL strategies report SOL and USD; for ETH-settled strategies report ETH and USD. Attribute changes in the native asset's USD price separately from token selection. Quotes used to mark inventory are estimates; unrealizable inventory is not cash.

Every trading receipt should account for actual amounts, venue/creator/terminal fees, network fees, tips, failed landed transactions, transfer taxes and account rent movements. Do not subtract a fee twice when already included in a wallet delta. Refundable rent is a balance-sheet item until refunded or written off. Data, infrastructure and agent costs belong in desk profitability even when excluded from execution PnL.

A closed system with no external cash flows or residual value redistributes wealth before costs and loses costs to parties outside its boundary. Real markets are open systems: new deposits increase available funding, not aggregate profits by accounting identity. Sandwich profit is a transfer if the searcher is inside the chosen boundary. LP fees are income to LPs; counting them as an external loss while also counting LP PnL duplicates them. Specify the boundary before adding revenue estimates.

## 3. Curve mathematics, and what it does not imply

Pump documents describe synthetic constant-product reserves, configurable initialization, permissionless migration after curve completion, and burning of migration LP tokens. These are venue-specific mechanics; example global account values are not a permanent fee or reserve schedule. Read the relevant accounts at the trade's slot. [Pump program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)

For a fee-free model, define token reserve `x`, quote reserve `y`, invariant `k=xy`, quote input `b`, and tokens sold back `q`:

```
spot price p = y/x
buy output q = x - k/(y+b) = xb/(y+b)
buy average price = b/q = (y+b)/x
average buy premium over pretrade spot = b/y
post-buy spot / pre-buy spot = (1+b/y)^2
sell quote output = yq/(x+q)
```

These equations are mathematical derivations, not evidence that a particular program has those exact parameters. Apply integer rounding, fee rules, real-reserve constraints and lifecycle transitions when simulating an actual contract.

A buy immediately reversed by selling its exact token output into the same unchanged fee-free curve returns the original quote amount. That does **not** make impact irrelevant. A finite sale receives less than quantity times pre-sale spot. A backtest that buys and sells at the historical market's unaffected marginal price must model both executions and its own inventory impact; it cannot invoke reversibility to excuse optimistic fills. Avoid double-counting impact already contained in exact-size executable quotes.

Using the original's illustrative `x0=1.073B`, `y0=30 SOL`, sellable quantity `793.1M`, the final virtual token reserve is `279.9M` and the added quote is `30×1.073B/279.9M−30 = 85.00536 SOL` before fees/rounding. “Exactly 85” is rounded. If `206.9M` tokens and `85 SOL` enter a new pool, its opening spot is approximately 0.00000041083 SOL/token, versus approximately 0.00000041088 at curve completion: close, not an exact equality.

The curve is a market with a deterministic pricing function, not a literal FIFO redemption queue. Any eligible holder can submit a sell. Transaction ordering changes state and payouts; there is no guaranteed payout order based on when holders originally bought. Expectations about subsequent flow can be forecast before migration too: profitability is an empirical question.

Market cap is marginal price times the chosen supply measure. It is not the amount holders can collectively withdraw. For a plain pool, a finite sale of `q` returns `yq/(x+q)` before fees, strictly below `y`; “holders can extract exactly the whole reserve” is generally false for finite circulating supply. Added liquidity, fees, virtual reserves and new trading change the calculation.

## 4. Migration changes the execution problem

Record curve-complete time, migration transaction, pool discovery time, first executable quote and first landed swap separately. A gap between those events is an untradeable state, not an interpolated price.

PumpSwap exposes deposit/withdraw and pool configuration; canonical migrated liquidity and separately added LP liquidity must be distinguished. Its documentation includes an effective quote reserve equal to vault balance plus a virtual component. The retrieved document says the component is zero on all pools “today”; that conflicts with the original's asserted universal BOOST regime. Neither document prose nor a token suffix proves the live state of a particular pool. [PumpSwap](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)

A shallower pool increases sensitivity to orders of a given size. It does not by itself predict a negative migration candle: direction depends on signed flow. Test migration continuation and reversal on every eligible migration, including failed routes and tokens with no subsequent trade, with real decision delays.

## 5. Turn order is valuable, not guaranteed

Jito documents local auctions at 50ms intervals, ranking by requested tip/CU efficiency, and bundles of up to five sequential atomic transactions within one slot. A successful submission is not confirmation. These rules describe that execution mechanism, not a universal total ordering of Solana. Two transactions in one slot need not belong to one bundle. [Jito execution](https://docs.jito.wtf/lowlatencytxnsend/)

Solana fees include a per-signature base fee and requested-budget priority fee; executed failures can still pay transaction fees. Measure send, acknowledgement, processed, confirmed and finalized timestamps separately. Base fees are not always simply one 5,000-lamport charge per transaction. [Solana fees](https://solana.com/docs/core/fees/fee-structure)

A slippage tolerance is an execution constraint, not a prediction of cost. Tight constraints can cause failures; loose constraints expose more adverse execution. Record quote age, minimum output, actual output, route and landed state. A stop order is an attempt to exit, not a guaranteed loss bound.

## 6. Read the players through falsifiable hypotheses

| Participant | Possible advantage | Evidence required to trade around it |
|---|---|---|
| Deployer/early inventory holder | Low basis and advance coordination | Creation and funding graph, inventory transfers, executable follower returns |
| Fast trader/searcher | Earlier observation and landing | Lead/lag distribution, own versus delayed follower fills, costs |
| Influencer/call channel | Attention and audience distribution | Publication and receipt times, mint disambiguation, disclosed incentives, matched controls |
| Liquidity provider | Fees for supplying inventory | Active depth, adverse selection, inventory risk, gas and rebalancing costs |
| Wallet follower | Predictive value of another actor's action | Prospective cohort membership, independent operators, decay versus delay |
| Research system | Better filtering or capital allocation | Untouched portfolio tests at achievable latency and size |

Many wallets do not imply many independent buyers. Funding links, repeated synchronized orders and shared inventory are clues, not proof of common control. Exchange withdrawals and common routers create false clusters. Preserve confidence and alternative explanations.

LPs do not have a universally positive, negative or “dust” payoff. Concentrated positions become inactive outside their ranges and accumulate one asset as price moves. [Uniswap liquidity](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity) Adverse selection should be evaluated against an explicit benchmark; loss-versus-rebalancing is one formal framework. [Milionis et al.](https://arxiv.org/abs/2208.06046)

Do not treat coordination, hidden promotion or wash volume as recommended tactics. Their analytical importance is that they can make apparent organic demand unreliable.

## 7. The token and the venue are part of the position

Verify chain ID, mint/contract, quote asset, decimals, supply definition, venue version, upgrade controls and current permissions. Token-2022 can include permanent delegation, transfer hooks, transfer fees and transfer restrictions. Absence of a freeze authority alone does not establish sellability. [Solana extensions](https://solana.com/docs/tokens/extensions)

For EVM venues also inspect transfer restrictions, proxy/owner controls and transaction receipts. Trace actual trader balance changes rather than attributing router transfers to investors. Reserve-based quoting is inappropriate for concentrated liquidity without active ranges/ticks and fee logic. A correct route quote still cannot guarantee a later fill.

Keep a capital-limited research universe separate from the full observation universe. Log every rejected candidate and reason. Otherwise an improved safety filter can appear to improve alpha merely by dropping difficult-to-price losers from evaluation.

## 8. The attainable seat

The system earns an edge only when information remains useful after observation, decision, queueing, execution and liquidation costs. Measure net expectancy as a function of delay, order size and available capital. Compare to no trade and simple matched policies.

Candidate seats worth testing are slower independent accumulation after liquidity stabilizes; prospective wallet following after excluding copy-dependent leaders; and capital-efficient exposure to positively skewed runners with feasible exits. None is assumed profitable. Negative median token drift is a reason for stronger evidence, not a theorem that every public-data strategy must lose.

The practical objective is to learn which opportunities survive implementation, stop funding those that do not, and update the process as participants adapt. More alerts, more analyses and more strategy names are not progress unless they improve that decision.
