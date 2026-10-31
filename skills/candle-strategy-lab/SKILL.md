---
name: candle-strategy-lab
description: "[RESEARCH] Replay a strategy definition against recorded data in the hacc strategy lab and read the lead card honestly: beat the random controls first, then break-even above your real cost, then the regime. Use when a strategy idea or definition needs a measured backtest, or to read the lab's runners and edges tables. The lab never trades."
---

## What this does

The strategy lab replays a strategy definition over a past window and returns a lead card. It also serves two measured
tables: runners and edges. It is a research tool. It never places a paper or live trade, and nothing it returns is
promoted to either. Backtests are a model of the past.

Use it after you have a definition worth testing (see `candle-strategy-hunt` for how to find and triage leads, and
`candle-strategy-design` for writing the definition). Use it before you spend real money on an idea, not instead of the
judgement that the idea has a counterparty.

## Calls

Both surfaces need a production agent key (`cndl_live_`). A device token or a test key cannot use the lab.

| Step | CLI | MCP (local stdio server only) |
| --- | --- | --- |
| Check plan, cap and active job | `candle lab status` | `candle_lab_status` |
| Submit a replay | `candle lab replay --definition <file\|-> --from <iso> --to <iso>` | `candle_lab_replay` (returns a job id at once) |
| Read or wait for a job | `candle lab replay get <job-id>` | `candle_lab_replay_result` (poll no faster than every 5 seconds) |
| Cancel | `candle lab replay cancel <job-id>` | none; use the CLI |
| Measured runners | `candle lab runners [--hours n] [--min-wallets n]` | `candle_lab_runners` |
| Signal edges | `candle lab edges [--days n] [--min-n n]` | `candle_lab_edges` |

Run `status` first. The CLI waits for a replay by default (5 second polls, up to 11 minutes); `--no-wait` prints the
job id instead. `--json` keeps the server's body unchanged. Cost: pass `--fee-bps` and `--slippage-bps` for your own
tier; without them the CLI reads your fee from Candle and falls back to the lab's default if that read fails.

TypeScript callers can use `createLabClient` from `@candledottv/agent-sdk`; the CLI and MCP use the same client.

## Caps and refusals

Access and a daily replay cap come from your plan, and one replay can run at a time. The server decides; do not retry
around a refusal. A refusal's `code` says why:

- `lab_plan`: your plan has no lab access.
- `lab_quota`: the daily cap is used; the reply carries the reset time. Wait for it.
- `lab_active`: a replay of yours is already running. Read or cancel it.
- `lab_busy`: the lab is loaded. Try later.

## Reading the lead card

Read it in this order and stop at the first failure.

1. **Beat the arms.** The card compares your definition with random controls. If it does not clearly beat them, the
   result is not evidence of an edge, whatever the P&L says.
2. **Break-even above your real cost.** The card gives the per-side cost at which the result reaches zero. If that is
   not comfortably above your actual fee, slippage and latency cost, the idea does not survive being traded.
3. **Regime.** The card labels the activity regime of the window (busy, normal, quiet or unknown). A result from one
   regime says little about the others. Fewer than five trades is `insufficient`; do not read it.

Two limits to state in anything you write up:

- The control tests timing and filters **within the definition's own priceable candidates**. It does not test whether
  choosing those assets beat the market, so a win does not show that your asset selection is skilled.
- Prices come from recorded tick marks, not a full order book. Fills, queue position and impact are not modelled. The
  card says so, and so must you.

## Hand-off

A lead that survives the card is still only a lead. To deploy one, go to `candle-strategy-to-bot`, which runs it through
your own agent with the usual risk gates. This skill does not take that step and does not suggest a paper run as part
of the lab. A failed lead is recorded with its cost, window and break-even, not as a verdict on the idea.
