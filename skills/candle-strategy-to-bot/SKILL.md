---
name: candle-strategy-to-bot
description: "[OPERATIONS] Build a trading strategy spec into a deterministic bot: policy as data with approval bound to its exact content, variants as settings with parity tests, one code path for replay, paper and live, an explicit position state machine, a ledger of every decision including refusals, fail-closed entries that never block exits, and the test order before money. Use when a strategy spec must become a bot, or when a running bot's rules must change."
---

## What this does

Turns a strategy spec (see `candle-strategy-design`) into a bot whose decisions are deterministic, approved by the
operator and replayable. It ends where the operating skills begin: `candle-trade-execution` for orders, fills and
bookkeeping, `candle-kill-switches` for operator controls, `candle-book-limits` for caps, `candle-agent-operations`
for running the worker, and `candle-first-live-trade` for the first fills. A well-built bot loses less to its own
faults; it does not make a strategy profitable.

## The rule

**Code decides, the policy is data, and only the operator approves a policy, by its exact content.** The bot refuses
to run on a policy whose exact content the operator has not approved, so a changed number cannot reach live money
without a new approval.

## Deterministic code decides

Detection, admission, sizing, orders, position management and the ledger are code. A language model writes, reviews
and explains that code, and never signs, sizes or books. It enters the decision path only as a tested input, such as
a veto over a deterministic entry (`candle-llm-trade-judge`), after an ablation shows it helps
(`onchain-strategy-research`). Its output is then a recorded input like any other: the model and its version pinned in
the policy, every prompt and response saved with its receipt time, replays reading the saved response.

## The policy and its approval

Every rule that moves money lives in one policy file: universe, gates and their thresholds, ticket and its allowed
values, exit ladder, caps, entry window, the wallet, and a version id.

- **Hash at start.** The bot hashes the policy's canonical content (for example sorted keys, fixed number format) and
  refuses to start unless an approval of that exact hash exists. The approval is an act only the operator performs
  (for example typing a phrase that contains the hash); the agent never writes or submits it, and where possible the
  host's permissions enforce that. An approval names one hash; any edit makes a new hash with no approval.
- **No side doors.** No environment variable, command-line flag or code constant changes a money rule; every money
  rule is in the hashed policy. Code may hold fixed safety bounds that only tighten the policy (for example a hard
  ticket ceiling). At start the bot compares each policy value with its code bound: a value beyond a bound refuses the
  start, or is recorded in the ledger as clamped, never silently applied. Changing a bound is a release: the same
  diff, checks and operator approval as a policy change, with the code identity checked at start (see Releases).
- **Controls are bounded by the policy.** Operator controls (pause buys, flatten, a ticket choice) are separate files
  (`candle-kill-switches`). A control picks within limits the policy sets: a ticket control chooses only among the
  policy's allowed values, an invalid control falls back to the policy value and raises an alert, and no control
  raises a cap.

The amend path, the only way a policy changes:

1. The agent prepares the change through one amend tool, never by editing the file on the running host.
2. The tool prints the diff against the running policy and the new hash.
3. The bot's own policy checks and start checks validate the staged policy without placing orders. Where positions
   are open, a dry run on a copy of the ledger shows which decisions change.
4. The caps and window still reach the bar (`candle-strategy-design`, `candle-book-limits`).
5. The operator approves the new hash. The agent never writes an approval.
6. A planned restart between cycles, with no order in flight; the ledger records the new policy hash.

## Variants are settings

A new behaviour enters as a setting, not as a fork of the code. The old behaviour stays reachable by settings: either
as the default, or through a mapping that turns the old policy into the new one.

- **Parity:** on the same recorded or seeded inputs, the new code on the old settings makes the same decisions as the
  old code: the same admissions, the same refusals with the same reasons, the same orders and exits, the same ledger
  events. Run the old code's own tests and seeded soak runs against the new code.
- **Check the parity test is not vacuous.** Change one setting, or break one decision, and watch it fail.
- Keeping the old code untouched while the new code proves parity (a subclass, a wrapper, or a copy the parity test
  covers) means a running bot is not changed by a variant it does not use.
- A second book on the same code is a second policy file and instance name, not a copy of the code.

## One code path

- The same decision functions run in replay, paper and live. Only the quote and order client and the clock differ, and
  both are passed in. Decision code never reads the wall clock directly.
- Record what the live bot saw, with receipt times: every candidate, every quote, every gate input it read (holder
  shares, pool state, balances), and when each arrived. Any live decision can then be replayed from the record, and a
  replay of a live day is a test.

## Positions are a state machine

Each position is in one named state: pending entry, open, each exit stage, buyback if the spec has one, closed, written
off, unresolved. Save each transition before acting on it and keep one order in flight per position. Clamp every exit
to the smaller of the booked quantity and the venue's record of truth (the on-chain balance, or an exchange's
position), never up and never to zero. A zero or unreadable balance refuses that sell attempt and raises an alert; the
exit keeps its place and re-reads the balance on the next cycle, and a balance that stays zero or unreadable moves the
position to unresolved for the operator, never to closed. An order with an unknown outcome goes to unresolved. Order
mechanics and recovery are in `candle-trade-execution`.

## The ledger is the truth

The ledger appends an event for every candidate seen, gate verdict with the measurements behind it, refusal with its
reason, order, and fill booked from the venue's record of truth. Readers use a derived status file or a read-only
connection, never a command that opens the ledger the way the worker does. Refusals make a quiet book diagnosable
(`candle-book-limits`) and let each gate be judged on kept against refused.

## Fail closed on entries, never on exits

A missing, stale or unknown gate input refuses the entry with a reason; unknown is never a pass. Nothing on the entry
side (caps, pauses, unknown inputs, an unresolved buy) blocks an exit (`candle-book-limits`, `candle-kill-switches`).

## Test before money

In this order, each step before the next:

1. **Unit tests per spec rule.** Each rule in the spec has a test, and each refusal reason fires.
2. **Replay on recorded tape** through the same code path; check a sample of decisions against the spec by hand.
3. **Seeded fault-injection soak.** A simulated chain and venue with ground truth, faults drawn at random from a seed:
   a crash and restart at every call and between ledger writes, timeouts after landing, landed reverts, slow and
   wrong responses, lagging balance reads. Check invariants every step: no duplicate orders, ledger positions equal the
   venue's positions, ledger cash (with margin and funding where they exist) equals the account's changes, no fill
   booked twice, no order open forever, no buy while paused or outside the window. A failing seed is a reproducible
   test. Fakes fail the way the real services can.
4. **Parity tests** for every new setting.
5. **Mutation check.** Break one guard at a time; a test must fail each time.
6. **Dry run** of the live code on live inputs with orders disabled, long enough to see real candidates, refusals and
   exits.
7. **First live trade**, supervised, at minimum size (`candle-first-live-trade`), on the operator's go and on a policy
   the operator approved.

## Releases

The ledger records the policy hash (or version) and the code identity at every start, so every event can be
attributed to a version. The deployed code's identity is pinned and checked (`candle-agent-operations`). Each
amendment carries its evidence and expected effect, so the close-out can attribute results by version. A deploy, like
a policy change, is the operator's decision.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.

## Checklist

- Is every money rule in the hashed policy, with nothing changeable by environment, flag or code constant, and code
  holding only safety bounds that tighten it?
- Does the bot refuse to start without the operator's approval of the policy's exact hash?
- Is there one amend path with a diff, the bot's own checks, a dry run where positions are open, and the
  operator's approval of the new hash?
- Are operator controls bounded by the policy?
- Is each new behaviour a setting that can reproduce the old one, with a parity test that fails when broken?
- Do replay, paper and live run the same decision code, and is every live input recorded with its receipt time?
- Is every position in a named state, saved before each action, with unknown outcomes in unresolved?
- Does the ledger record refusals with reasons, with readers on a status file or a read-only connection?
- Do unknown inputs refuse entries while nothing on the entry side blocks an exit?
- Did unit, replay, seeded soak, parity, mutation and dry-run tests pass before the first live trade?
- Does every policy change, limit change, first spend and deploy name the operator as the approver?

## Related skills

- `candle-strategy-design`: the spec this builds
- `candle-trade-execution`: orders, fills and bookkeeping
- `candle-kill-switches`: operator controls
- `candle-book-limits`: caps that never block exits
- `candle-agent-operations`: running the worker
- `candle-first-live-trade`: the first fills
