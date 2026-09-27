---
name: candle-market-data-ingestion
description: "[DATA] Consume hacc event feeds and Solana wallet or pool activity without silently losing events: durable cursors, receipt times, websocket plus reconciliation, transaction versions, gaps and pruning. Use when building or debugging a collector, a wallet watcher or a signal feed, when a feed seems to have gone quiet, and when signals appear late or not at all."
---

## What this does

A trading agent is only as good as the events it actually sees. Most ingestion failures are silent:
the collector keeps running, reports healthy, and skips a slice of events that nobody notices until a
signal that should have fired never did. This skill lists the ways that happens and the rule that
prevents each.

`onchain-strategy-research` covers the research side (event time against availability time,
point-in-time data). This skill covers the collector itself.

## The rule

**Page by a monotonic id assigned when the event is stored (the server's id for a remote feed, the
row id for your own store), persist the cursor only after the page is processed, keep receipt time
next to event time, run a reconciliation poll beside every stream, accept every transaction version
the chain produces, and record gaps as gaps.**

## Cursors

For hacc `/v1/events` (and other feeds that expose `since_id`):

1. Bootstrap once with an ordinary request (no `since_id`), and persist the largest `id` returned.
2. From then on, request `since_id=<saved>` and follow `next_since_id` on every page.
3. Never start from `since_id=0`, and never combine `offset` with `since_id` (the API rejects it).
4. Respect the page cap and loop until a page comes back empty.

```python
cursor = load_cursor()                     # persisted, survives restarts; never None after bootstrap
while True:
    page = get_events(since_id=cursor, limit=500)
    if not page.events:
        break
    process(page.events)                   # dedupe by event id; any exception stops here, before saving
    next_cursor = page.next_since_id or max(e.id for e in page.events)
    if next_cursor is None or next_cursor <= cursor:
        raise RuntimeError("cursor did not advance")   # never persist a missing or backward cursor
    cursor = next_cursor
    save_cursor(cursor)                    # only after process() succeeded
```

Why each part matters:

- **Save after processing, per page.** If the cursor advances before the batch is processed, an
  error halfway through loses the rest of the batch. If it is saved only at the end of a long run,
  a failure in any later stage keeps it pinned, and every run re-reads the same old pages without
  catching up.
- **Cursor on an id assigned at insert, not on a timestamp your collector writes.** If one ingest
  pass stamps many rows with the same local time while inserting them over several seconds, a
  reader using "time greater than cursor" skips every row that shares the stamp. If rows become
  usable later (for example a block time filled in afterwards), keep them in a pending list and
  re-check them instead of letting the cursor pass them.
- **Dedupe by event id.** Pages can overlap after a retry.

## Backlogs and gaps

If the collector falls far behind, check whether the backlog is still useful. Events older than the
window your strategy acts on are worth keeping for research, but a live consumer should not block on
them. Re-bootstrap the live cursor at the current end of the feed (or keep a separate backfill cursor
for research), and record the skipped range as a gap with its start, end and reason.

Never fill a gap with invented data. Prices at times nobody sampled cannot be recovered afterwards;
mark those results as missing.

## Time

Store at least two times for every event: when it happened (block time) and when you received it.

- A signal is timed by when you could have acted on it: the receipt of the event that completed the
  pattern, not the earliest event in the pattern.
- Never backdate a late event to its block time in anything used for trading decisions. Measure the
  gap between the two; it is your real latency.
- When catching up after an outage, keep the actual (late) receipt times.

## Watching wallets and pools on Solana

- **Run a stream and a poll.** A websocket subscription gives low latency; a periodic reconciliation
  poll (signatures per watched address since the last seen one) catches what the stream missed.
  Compare the two regularly: any signature the poll finds that the stream never delivered is a
  measured loss rate.
- **Accept every transaction version your RPC supports.** Set `maxSupportedTransactionVersion` to the
  highest version your RPC provider documents, on both full-transaction subscriptions and
  `getTransaction`. The authors observed version 1 transactions from Meteora DLMM and one other
  program: 5 of about 1,800 watched signatures on 2026-09-20, via Helius, where a read capped at
  version 0 returned RPC error -32015. A request capped at version 0 gets an error or an empty frame
  for them. Log an unsupported-version error as an error; a reconcile loop that treats "no
  transaction" as "nothing to do" advances its cursor past the transaction and loses it.
  Keep a backfill path that re-fetches specific signatures.
- **Swap-only parsing misses liquidity events.** A liquidity withdrawal is not a swap; a feed that
  records only buys and sells keeps the last healthy price after a pool is emptied. See
  `candle-drained-pool-writeoff`.

## Keeping the collector itself healthy

- **Atomic status files need a unique temp name per writer.** Two threads that write the same
  `status.tmp` and rename it race each other and produce spurious errors.
- **Prune in bounded batches.** Deleting old rows from a tick table in one statement can hold the
  write lock long enough to stall ingestion. Prune a fixed number of rows per pass, often.
- **Label request limits by origin.** See `candle-agent-operations` for telling local caps from
  provider limits.

## Checklist

- Cursor is an id assigned at insert, monotonic, never null, persisted after processing, per page.
- `since_id` and `offset` are never mixed; no start from zero.
- Events are deduplicated by id.
- Block time and receipt time are both stored; signals are timed by receipt.
- Stale backlog is skipped for live use and recorded as a gap; gaps are never filled with invented data.
- Every stream has a reconciliation poll, and the two are compared.
- `maxSupportedTransactionVersion` set to the highest version the RPC documents; unsupported-version errors logged; a signature backfill path exists.
- Status temp files are unique per writer; pruning is bounded.

## Related skills

- `onchain-strategy-research`: event time against availability time, point-in-time research data.
- `candle-trade-execution`: its fill-booking example reads transactions too; the version rule applies there as well.
- `candle-wallet-entry-detection`: deciding what an ingested wallet event means.
- `candle-drained-pool-writeoff`: liquidity events a swap-only feed cannot see.
- `candle-agent-operations`: supervision and shared request meters for collectors.

This skill is advisory. It does not authorize trades, transfers, or limit changes; those remain your operator's decision.
