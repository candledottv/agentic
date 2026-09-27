---
name: candle-kill-switches
description: "[RISK CONTROL] The operator controls an autonomous trading book needs so a human can stop new risk, cut one position or cut everything without editing code or killing a process mid-order, and how those controls differ from the rail's own profile stops. Use when building a trading worker, before running one with real money, and when an operator asks to pause, cut, stop or restart a running book."
---

## What this does

An autonomous book runs on a loop. The operator needs a way to change what that loop does between
cycles, and each control needs to do exactly one thing. This skill describes the minimum set of
controls, what each one must and must not touch, and how a worker is stopped or restarted without
orphaning an order.

It sits next to `candle-trading-discipline`, which covers loss limits enforced by the rail on the key.
Those limits bound losses. The controls here are how a person steers a book that is still inside
its limits.

## The rule

**Give the book four file controls that it checks every cycle: pause new buys, flatten everything,
flatten one mint, and stop the process. The first three never stop exits. Stopping and restarting are
the operator's actions, taken between cycles with nothing pending.**

## The controls

A control is a file in the book's own directory. A file works where a flag in a database or config
does not: an operator can create or remove it from any shell, the worker reads it without a lock,
and it survives a crash. The names below are examples.

| Control | Effect | Must not |
|---|---|---|
| `PAUSE_BUYS` | Refuse every new entry and every add, with a recorded reason. | Stop marks, exits, take-profits or stop-outs. |
| `FLATTEN` | Sell every open position through the normal exit path, and refuse new buys. | Skip the normal sell checks (balance clamp, reconciliation). |
| `FLATTEN-<mint>` | Sell that one position through the normal exit path with its own reason code, and refuse new buys in that mint. | Touch any other position. |
| `STOP_PROCESS` | End the loop after the current cycle finishes. | Interrupt a submit or a reconcile in progress. |

`STOP_PROCESS` is the one control that also ends exits, because it ends the process. That is why only
the operator uses it, and only as described under stopping and restarting below.

Check the controls at every decision point that could spend: the entry path, the preflight right
before a buy is submitted (a file can appear between the two), and the exit pass.

## Why each detail matters

- **Pause-buys must leave exits alone.** The usual reason to pause is that the book is doing badly.
  That is exactly when open positions most need their exits. A pause that also freezes exits turns
  a cautious step into a stranded book.
- **Cuts go through the normal exit lane.** A separate "emergency sell" path skips the sell-side
  protections (clamp to the on-chain balance, reconcile before retry) that `candle-trade-execution`
  describes. The cut should differ only in its reason code.
- **A per-mint flatten file is cleared after its position closes.** The worker removes it once the
  position is closed and reconciled (or the operator does). Otherwise it sits waiting and sells the
  next position the book opens in the same mint, possibly days later.
- **Flatten-all implies pause-buys.** A book that sells everything and then buys again on the next
  cycle has not been flattened.

## The rail's own stops are different

Candle can also stop a trading profile on the rail side. The error catalog lists `PROFILE_PAUSED`
(an account owner paused the profile) and `RISK_LIMIT_REACHED` (the profile reached a loss limit its
owner set, or tripped its circuit breaker). Both are non-retryable and apply to the whole profile. Do
not treat them as a local pause-buys: stop new entries on that profile, report the reason to the
operator at once, and leave resuming to the account owner. Finish confirming and reconciling orders
already in flight. Do not expect a new sell to be accepted. Tell the owner which positions are open
with no working exit, because only the owner can resume the profile.

## Stopping and restarting

These are operator actions. An agent proposes them; it does not take them on its own.

- A planned stop uses `STOP_PROCESS`, not a kill signal. The loop checks it between cycles, so the
  worker never dies between signing and recording an order.
- Before a planned stop or restart, confirm nothing is pending: no order in a submitted, uncertain or
  reconcile-required state. If something is pending, wait for the worker's own reconciliation to
  finish it, or escalate to the operator. Never hand-edit order state, attach signatures by guesswork,
  or resubmit an order manually to clear it.
- A restart leaves every open position unmanaged until the new process has loaded the ledger and
  marked its positions. That window is usually a few minutes. Keep it short and avoid it during fast
  markets.
- A restart after a crash is different from a planned one: the supervisor restarts the worker into the
  same ledger, and the worker reconciles every pending order against the chain before it trades
  again. See `candle-agent-operations`.
- Any restart reloads the same ledger, the same policy and the same deadlines. A restart that starts
  a fresh book loses track of what the wallet already holds.
- A stop-when-flat mode is the cleanest way to end an experiment: once every position is closed and
  nothing is pending, the book stops spending and pauses itself.

## Reading status without interfering

Have the worker write a status file every cycle (positions, marks, pending orders, pause state,
last error, heartbeat time). Operators, dashboards and other agents read that file.

Do not read status through a command that opens the book the way the worker does. If the worker
holds a lock on its ledger, that command either fails on a live book or contends with the worker for
the lock.

## Checklist

- Pause-buys, flatten-all, flatten-one-mint and stop-process controls exist and are tested.
- Pause-buys is checked in the entry path and again right before submit.
- Only stop-process can end exits, and only the operator uses it.
- A per-mint flatten also refuses buys in that mint, and its file is cleared after the close.
- Rail-side profile stops halt entries and are reported at once; exits the rail still accepts continue.
- Planned stops happen between cycles with nothing pending; pending orders are reconciled or escalated, never hand-edited.
- A restart reloads the same ledger, policy and deadlines; after a crash it reconciles first.
- Status is read from a file the worker writes, not by opening the ledger.

## Related skills

- `candle-trading-discipline`: loss limits on the key, enforced by the rail.
- `candle-risk-gate`: a standing stop on Candle is an alarm that your agent must complete, not an exit.
- `candle-trade-execution`: sell clamps and reconciliation that every cut must still go through.
- `candle-book-limits`: caps that can silently stop a book, and why one uncertain order must not freeze every exit.
- `candle-agent-operations`: supervisors, crash recovery and heartbeats for long-running workers.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
