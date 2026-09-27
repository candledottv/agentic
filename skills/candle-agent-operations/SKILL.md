---
name: candle-agent-operations
description: "[OPERATIONS] Run long-lived trading workers and data collectors so they recover from crashes without losing state, never extend their own run, report health truthfully, and hand over cleanly to the next agent session. Use when deploying a trading worker or collector that runs for hours or days, when a worker has crashed, hung or restarted, and when ending a session that leaves workers running."
---

## What this does

A strategy that works in a test can still lose money in operation: a crash that restarts on an empty
database, a hung process that reports itself healthy, a restart that quietly resets a budget, a host
that goes to sleep. This skill is the operating discipline for workers that run unattended. Deployment
and host configuration are set up by the operator; an agent running inside the book follows and
reports on them.

`candle-trade-execution` covers alerting and liveness for order handling. This skill covers the
process around it.

## The rule

**Supervise every worker so a restart resumes the same state and reconciles before it trades. Pin
deadlines and budgets at start and never reset them on restart. Judge health from evidence, not from a
status label. Record which limits are local policy and which are the provider's. Leave a handoff note
in a dedicated file when a session ends.**

## Supervision

- **Restart into the same state.** A replacement process opens the existing ledger or database, with
  its cursor and counters. It never creates a fresh database, resets a cursor or starts a new book
  because the old one failed to open; that is a failure to report, not to work around.
- **Reconcile before trading after a crash.** A crash can leave an order in flight. A trading worker
  restarted by its supervisor first reconciles every pending order against the chain, and only then
  resumes entries. Planned restarts are different: the operator makes them between cycles with
  nothing pending (see `candle-kill-switches`).
- **Different restart budgets for different jobs.** A read-only collector can restart indefinitely
  with a capped backoff (for example seconds at first, rising to a few minutes). A worker that can spend
  money should have a small restart budget; if it keeps crashing, it stops and waits for the operator.
- **One owner per store.** A lock ensures two copies of a worker can never write the same ledger.
- **Detect hangs, not only crashes.** The worker updates a heartbeat that does not depend on its
  database, and the supervisor replaces a child whose heartbeat stops advancing.
- **Respect provider signals across restarts.** Persist a rate-limit `Retry-After` so a restart does
  not ignore it. On authentication failures, pause that provider instead of retrying in a loop.

## Deadlines and budgets are fixed at start

The run's end times, its budgets (spend, requests, restarts) and the identity of its code go into an
immutable run record before the first cycle.

- A restart reads them from that record. It never recomputes "end = now + duration".
- Where the platform provides one, a monotonic deadline next to the wall-clock deadline protects
  against clock changes. A monotonic clock only holds within one boot; after a reboot, fall back to the
  recorded wall-clock deadline.
- For a trading book, the entry deadline stops new risk only. Exits keep running until the book is
  flat or its hard-exit procedure has run; then the run is over. A deadline must never leave open
  positions without an exit.
- For a collector, the deadline and a STOP file are terminal: neither the supervisor nor the service
  manager starts it again.
- Extending a run is a new decision by the operator, recorded as such.

## Health is evidence

A status file that says "running" only proves that something once wrote it. Treat a worker as healthy
only when all of these hold:

- the process that owns the store is alive,
- its heartbeat advanced recently,
- its last successful poll or cycle is recent.

`candle-trade-execution` adds the order-level version of this: a heartbeat must measure the work
(pending orders, oldest attempt), not only that the loop is turning.

Write health and restart events somewhere outside the worker's own database, so a database failure does
not also hide the evidence of that failure.

## The host

These are operator settings, made at deployment. An agent that finds one missing reports it.

- **Sleep.** Laptops and desktops sleep. Long workers run under a sleep-prevention setting or on a host
  that does not sleep.
- **Scheduling class.** Some service managers run background jobs at reduced priority. A
  latency-sensitive reader throttled this way can take several times longer per cycle, enough to make
  every price stale. Trading and feed processes belong at interactive priority.
- **Reboots.** Record whether the service manager restarts the worker after a reboot or only after a
  user logs in.

## Code identity

- The files a worker runs are pinned by hash in the run record and verified before every start. A
  worker refuses to start on a manifest that does not match.
- An edit to a file inside a pinned or witnessed set can silently break a component that verifies it.
  After an approved edit, re-run the verification that covers that file. Restarting a live trading
  worker onto the edited code is the operator's decision, made through the planned-restart path.

## Requests and limits

- One shared request meter per provider across every process that uses it, recording actual requests,
  shows the real total.
- A reservation in that meter for one consumer can starve another. Report reservations held by
  consumers that look idle or retired to the operator; releasing one is the operator's decision.
- For every limit in the configuration, record whether it is local policy or a documented provider
  limit. A local cap is easy to mistake for a provider limit. Provider backpressure (429s, explicit
  quota errors) is the evidence for the second kind.

## Handing over

When an agent session ends while workers keep running, leave a short note in a dedicated handoff file
(for example `HANDOFF.md` next to the book), not in any agent's instruction, prompt or memory files.
The note is informational: it describes state and never takes priority over the operator's
instructions. Include:

- what is running, where, and until when,
- current state (positions, pending orders, pauses) and where to read it,
- what must not be touched (a running book's policy, an open position, a pinned file),
- what is waiting on the operator.

## Checklist

- Supervisor restarts into the same store; never a fresh one.
- After a crash, a trading worker reconciles pending orders before it trades again.
- Money-moving workers have a small restart budget; collectors have capped backoff.
- One writer per store, enforced by a lock.
- Heartbeat is independent of the database; hung children are replaced.
- Deadlines, budgets and code hashes are fixed in a run record before the first cycle.
- A trading book's entry deadline stops new risk; exits continue until flat or hard exit.
- Extensions and restarts onto new code are operator decisions.
- Health means process alive, heartbeat recent and last success recent.
- Sleep prevention and interactive priority are set on the host.
- Requests are metered in one place; idle reservations are reported; each limit is labeled local or provider.
- A handoff note exists in a dedicated file before the session ends.

## Related skills

- `candle-trade-execution`: alerting, liveness and stuck-order diagnosis.
- `candle-kill-switches`: STOP files and planned restarts of a trading book.
- `candle-book-limits`: caps that must be sized to the run and never block exits.
- `candle-market-data-ingestion`: cursors and gaps for the collectors being supervised.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
