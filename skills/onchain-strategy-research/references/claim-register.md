# Claim register for The Game v2

Reviewed September 4, 2026 Pacific. This register addresses decision-relevant claims; it does not certify every statistic in the original. Its referenced `research/game-2026-09-02/` source package was not present in the reviewed checkout. User-supplied prose is evidence of the claim, not a reproduction of its measurement.

| Original assertion | Disposition | Replacement / evidence needed |
|---|---|---|
| Onchain speculation has information and execution asymmetries | Retain as mechanism | Quantify the particular system's access and delay |
| “Exactly 85 SOL” completes every curve | Correct | Approximately 85.00536 in the stated simplified parameters, excluding fees; configuration and rounding govern actual trade |
| Impact is only what intervening traders take | Correct | Immediate reversal is reversible under strict assumptions; finite execution against historical spot still needs size-dependent impact |
| Curve is a queue, no forecast is coherent until migration | Reject literal interpretation | Deterministic pricing plus uncertain future flow; no FIFO rights based on purchase order |
| Same-slot buy proves create-bundle membership | Reject | Bundle implies same slot; same slot does not imply bundle; see Jito docs |
| Shallower migration pool causes dumps | Narrow | It amplifies signed flow, not a direction proof |
| Holders can extract exactly 67.4 SOL regardless of regime | Reject | Finite sell output depends on actual reserves, virtual terms, supply and flow |
| BOOST universally carves 17.6 SOL, July 21 2026 | Unverified / conflicting source | Retrieved PumpSwap README states virtual component zero “today.” Require deployed program version, activation evidence and example transactions |
| Two fee accounts mandatory September 1 **2026** | Date unsupported | Fee README says **Monday**, September 1, without year. September 1 2026 was Tuesday; 2025 was Monday. Pin commit history/activation before assigning year |
| Fixed curve/creator fee and USD-denominated tier thresholds | Version-dependent | Read current FeeConfig; thresholds in the retrieved logic use lamports, so USD thresholds move with SOL |
| Every pump coin safe from freeze; rugs never remove liquidity | Overbroad | Verify actual mint and pool provenance; original migration LP burn says nothing about every later LP position or token extension |
| 350ms slots since Aug 21, 95% Jito stake, exact sandwich shares | Not verified here | Require dated network measurements with method and denominator; omit as constants |
| 42/42 runners bundled; four wallets control 62% | Selected forensic sample | Preserve as hypothesis only until sample selection and linked transactions are available; cannot estimate all-launch prevalence |
| Trader profitability, graduation/death rates, printer PnL and protocol revenue totals | Not reproduced | Require exact windows, denominator, realized/basis conventions, fees, and non-overlapping revenue accounting |
| Only creator seat can be structurally long; public data cannot win | Unsupported universal inference | Test attainable conditional expectancy, avoid predicting from anecdotes |
| “Medians, never means” | Replace objective | Audit bad prices, then measure actual net portfolio PnL and expected payoff with uncertainty; retain medians and tail concentration as diagnostics |

Primary references checked:

- [Pump program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)
- [PumpSwap program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- [Fee program](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md)
- [Jito execution](https://docs.jito.wtf/lowlatencytxnsend/)
- [Solana fee structure](https://solana.com/docs/core/fees/fee-structure)

These are mutable documentation URLs, retrieved September 4 Pacific / September 5 UTC. They establish documented behavior, not historical account states. Archive commit-pinned specs and slot-specific account evidence in each future experiment. Candle documentation endpoints could not be retrieved during this review; Hood-specific protocol claims remain grounded in repo adapters and stored results, not independently certified protocol documentation.
