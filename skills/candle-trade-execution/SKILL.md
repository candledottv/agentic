---
name: candle-trade-execution
description: "Use when building or debugging automated trading on the Candle agent SDK (@candledottv/agent-sdk), especially position accounting, sells that fail, retry loops, and error handling. Encodes failures that cost real money in production."
---

# Trading through Candle without losing money to your own bookkeeping

This is a field guide for agents wiring Candle's SDK into an automated strategy. Every rule below is
here because it failed in production on a live wallet, not because it seemed prudent. Where a number
appears, it is measured.

The failures cluster into three families, in order of how much they cost:

1. **You booked a quote as if it were a fill.** This is the expensive one and it is almost invisible.
2. **You retried something that could never succeed.** This is the loud one.
3. **You read an error's prose instead of its structure.** This is the one that hides the other two.

---

## 1. A quote is not a fill

`ExecutedTradeResult.amounts` looks like this:

    amounts: {
      amountRaw: string       // what you asked to spend or sell
      minOutRaw: string       // the enforced floor, guaranteed by the swap
      expectedOutRaw: string  // THE QUOTE. Not what you received.
    }

`expectedOutRaw` is the pre-trade expectation. **It is not the delivered amount, and the SDK does not
return the delivered amount anywhere.** Every executed-trade path resolves to the same
`ExecutedTradeResult`, so there is no field to reach for.

If you book a position's quantity from `expectedOutRaw`, your ledger drifts from the wallet by exactly
the buy's realised slippage, in whichever direction the fill went:

- **Fill worse than quote** and your recorded quantity exceeds the wallet balance. Every later sell
  asks for tokens that do not exist and fails **permanently**. Not intermittently: forever, at any
  retry count, until someone corrects the number by hand.
- **Fill better than quote** and your recorded quantity is short. The close under-sells and silently
  strands the surplus in a wallet your ledger calls flat. Nothing errors. Nothing alerts.

Both happened in one production run, from one line of code. The failing direction jammed three
positions for nine hours. The winning direction quietly stranded tokens across four trades starting
with the very first live order, every one marked `executed / success: true`.

### What to do instead

**Book from physical reality.** After a buy confirms, fetch the transaction and diff the owner's pre
and post token balances for that mint:

    const tx = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
    const pre  = tx.meta.preTokenBalances.find(b => b.owner === owner && b.mint === mint)
    const post = tx.meta.postTokenBalances.find(b => b.owner === owner && b.mint === mint)
    const delivered = BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0')

That is one extra RPC call per buy. It is the cheapest insurance in the system.

**Record which source you used.** Store a `qty_source: 'onchain' | 'quote'` beside the quantity, and
alert when it falls back. A fallback that nothing reports is the original bug wearing a hat.

**If you will not do the on-chain read, book `minOutRaw`, not `expectedOutRaw`.** It is the floor the
swap guarantees, so the ledger can only ever under-state what you hold. Under-stating strands dust;
over-stating jams the exit. Prefer the failure that does not block your exits.

### Always clamp a sell to the on-chain balance

Even with correct booking, clamp at the moment of the sell:

    amountRaw = min(bookedQtyRaw, onChainBalanceRaw)

Three properties this must have, all learned the hard way:

- **It may only ever reduce.** If it can increase, one bad read sells more than the position.
- **Never clamp to zero.** A zero or unreadable balance means either the tokens are gone or you are
  reading the wrong account. Neither justifies broadcasting a sell for nothing. Refuse and alert.
- **Never "just sell the whole balance."** If the wallet is shared across strategies or positions, the
  whole balance includes somebody else's tokens.

### Check the exit leg too

The same bug has a twin on the way out. If you book `exit_usd` and realised PnL from the sell's
`expectedOutRaw`, every closed trade's PnL carries the same quote-versus-fill gap, and those numbers
feed drawdown limits and promotion gates. Read the quote-asset delta from the transaction. On a native
SOL leg, separate swap proceeds from the network fee and any rent, or the numbers move by the wrong
amount.

---

## 2. Retry loops on a live wallet

**Every retry loop needs an attempt cap, a backoff, and a terminal state before it is allowed near real
money.** In production a `while pending: try again` loop with none of the three ran **8,755 attempts
over 9 hours 45 minutes** against orders that were arithmetically incapable of succeeding, at roughly
8 seconds per attempt, each attempt spending a quote, a build, a signing call and a broadcast.

### The clock must not be the caller's cycle clock

If the retry gate is `created_at < now() - someInterval`, the timestamp never advances and the gate
only ever delays the *first* retry. Every subsequent cycle re-fires immediately. Give each attempt its
own scheduled time:

    next_attempt_at = now() + backoff(attempts)   -- exponential, jittered, capped

and select on `next_attempt_at <= now()`.

### The terminal state has to be sticky one layer up

Capping attempts on the *order* is not enough. When the order stops being pending, the layer above sees
a position with no pending exit and mints a fresh order, and the loop resumes under a new id. This is
not hypothetical: it produced order 19 (1,437 attempts), then order 21 (2,765 attempts) for the same
position. Give abandonment a state the position-level logic also respects.

### Count a throwing attempt

The subtlest version of this bug hid *inside the fix for it*. A per-order `try/catch` was added so one
failing order could not abort the whole cycle. It swallowed the throw without incrementing `attempts`,
so an order that threw before its status was written was re-claimed and re-executed forever, exempt
from the cap. **A throw must cost an attempt exactly like a failure does.**

### Claim orders atomically if more than one process can sweep

A bare `select ... for update skip locked` on a connection pool releases its lock at statement end and
does not protect anything. Claim with a single statement:

    update orders set next_attempt_at = now() + lease, last_attempt_at = now()
     where id in (select id from orders where status='pending' and next_attempt_at <= now()
                  order by next_attempt_at limit $n for update skip locked)
    returning *

Make the lease longer than one attempt's worst case, which is the sum of every HTTP timeout in the
attempt, not one of them.

---

## 3. Read the error's structure, never its prose

Candle's errors carry `.code` and `.data`. The SDK's own docs say to branch on `code` and never on
`message`. Do that. Three specific consequences:

### `-32002` is a preflight rejection, and it is definite

The node simulated your exact signed transaction, refused it, and never forwarded it to a leader. If
no earlier attempt's transaction could still be in flight, treat it as a **definite rejection**, not as
"uncertain, retry". Classifying it as uncertain is what turned one deterministic failure into 2,026
identical attempts.

**But `AlreadyProcessed` is a `-32002` too, and it means the transaction landed.** Marking it failed
books a loss on a swap that actually executed, leaving your ledger and the chain disagreeing about real
money. Blockhash expiry likewise stays uncertain, because a rebuild fixes it.

The rule that survived review: *definite* requires that you can already rule out an earlier attempt's
transaction being alive.

### `err.data.logs` has the full program logs; the message does not

The SDK's error formatter truncates the log array to three lines. On a Solana failure the first three
frames are ComputeBudget instructions, so the truncated message shows you **nothing but compute budget
setup** and hides the program that actually failed.

That single truncation is why a production incident took six hours to diagnose instead of ten minutes.
Store `err.data.logs` in full. When you need to know which program rejected a transaction, the logs are
the only thing that tells you, and a decoded error number without the program is meaningless (see
below).

### Error messages are untrusted carriers, and they leak credentials

The SDK interpolates the caller-supplied RPC URL verbatim into thrown error messages, at four sites,
for both Solana and EVM. Most providers authenticate by API key **in the query string**. So the thrown
message contains a live credential.

In production this reached a Discord channel in four alerts and forced a key rotation. Nothing in the
integrator's own code ever wrote the key into a string; it was interpolated by a library and forwarded
by an alerting path that had no idea what it was carrying.

**Redact at every outbound boundary**, not at the call site. Two passes:

- **By value**: replace the literal value of every environment variable whose *name* looks like a
  secret (`KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|WEBHOOK|CREDENTIAL|AUTH`). This is the pass that does
  not rot as new variables appear, and it catches the secret in any shape.
- **By pattern**: bearer tokens, keyed query strings, webhook URLs, vendor-prefixed keys.

Redact **before** truncating, or a cut leaves the head of a key behind as ordinary text. Guard the
value pass with a minimum length and skip URL-valued variables, or you will scrub ordinary words.

---

## 4. Decoding a Solana custom program error

`custom program error: 0x1788` is decimal **6024**. Anchor numbers custom errors from 6000, so this is
the 25th error in *some* program's enum, and **which program** is the entire question.

Do not trust a blog post. The same number means different things in each program:

| program | 6024 |
|---|---|
| Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) | `InsufficientFunds` |
| PumpSwap AMM (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) | `Truncation` |
| pump.fun bonding curve (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) | `Overflow` |

To settle it properly:

1. **Read the logs** to see which program's frame failed. A short compute-unit count with no inner
   `invoke [2]` means the aggregator rejected it before entering any AMM.
2. **Fetch the program's on-chain Anchor IDL**: derive `base = findProgramAddress([], programId)`, then
   `createWithSeed(base, "anchor:idl", programId)`, fetch that account, and zlib-decode it. This is
   authoritative in a way that documentation is not.
3. **Reproduce read-only** with `simulateTransaction` before concluding anything. A bisect on the input
   amount that shows `balance` clean and `balance + 1` failing tells you more than any error table.

Two you will meet often on this path:

- **6024 `InsufficientFunds`**: your input amount exceeds the wallet's balance. Raised by Jupiter's own
  Route frame before any AMM is touched. This is the quote-versus-fill bug.
- **6001 `SlippageToleranceExceeded`**: the transaction landed, reverted, and **paid fees**. Your
  ledger should record it as a real cost, and a confirm step that refuses to book it (correctly) still
  leaves you having spent money.

---

## 5. Idempotency: what it does and does not cover

A stable `clientTradeId` makes the **vendor's ledger** at-most-once. Through 8,755 attempts it held
perfectly, with no double-spend.

It does **not** limit how many signed transactions your process puts on the wire. On a linked-payer
path you sign and broadcast yourself, so the idempotency key is a property of their records, not a lock
on the network. If you rebuild and re-sign on each retry, you are generating a fresh signature every
time. Guard against two live transactions yourself:

- Persist the signature **before** broadcasting, so a crash between the two cannot orphan it.
- Record **when it was signed**, and gate any rebroadcast on the age of the *signature*, not the age of
  the order. Those coincide on the second attempt and diverge on every one after, which is how a guard
  can look correct and be permanently open.

---

## 6. Alerting and liveness

**An alert dedupe key must carry the dimension that is getting worse.** A key like
`order:<id>:stuck` announces a condition once and then guarantees silence while it deteriorates. In
production, four alerts covered 8,755 attempts: 99.95% of the deterioration was absorbed silently, and
the one alert an operator saw said "3 attempts".

Put the attempt bucket in the key, give the terminal state its own alert, and re-announce anything
unreconciled once a day until a human clears it.

**A liveness check must measure the work, not the loop.** A heartbeat stayed green through all 8,755
failed attempts, because the process was looping perfectly. Publish the queue's own health (pending
count, oldest attempt count, oldest age) onto the heartbeat that is already monitored, rather than only
behind a new endpoint nobody polls.

---

## 7. Config traps

**Slippage tolerance is phantom quantity if you book from quotes.** Widening buy slippage from 100 bps
to 300 bps widened the gap between quote and fill, and therefore the size of the unsellable phantom
position. The three jammed positions were short 2.165%, 1.256% and 0.103%, all inside the 300 bps
tolerance. Fix the booking; do not paper over it by tightening slippage, especially since the same knob
usually governs exits and tightening it makes real exits fail.

**Check whether a "disable" value actually disables.** A guard reading
`Number.isFinite(raw) && raw > 0 ? raw : fallback` silently falls back to its default when you set the
variable to `0`. Setting a spend cap to `0` to stop trading can leave the default cap in force. Use a
value the guard accepts, and verify inside the running process, not in the config file.

**In Docker Compose, `VAR: ${VAR:-}` sets an empty string rather than leaving the variable unset**, so
`??` defaults never fire. Use `||` or an explicit trim-or-default.

**Verify env changes reached the process.** A stopped container restarted rather than recreated keeps
its original environment. `docker exec <container> printenv VAR` is the check; the config file is not.

---

## Pre-flight checklist before a strategy touches real money

- [ ] Position quantity is booked from the delivered fill, or from `minOutRaw`, never `expectedOutRaw`
- [ ] Every sell is clamped to the on-chain balance, and the clamp can only reduce
- [ ] Exit proceeds and PnL are booked from the delivered amount, not the sell's quote
- [ ] The retry loop has an attempt cap, a jittered backoff on its own clock, and a terminal state
- [ ] The terminal state is respected by the layer that mints orders, not just the order itself
- [ ] A throwing attempt increments the attempt counter
- [ ] Errors are classified on `.code` and `.data`, never on `.message`
- [ ] `-32002` is definite only when an earlier send can be ruled out; `AlreadyProcessed` is not a rejection
- [ ] Full `err.data.logs` is stored, not the truncated message
- [ ] Credentials are redacted at every outbound boundary, before truncation
- [ ] Alert keys carry the worsening dimension; terminal states alert separately and nag until cleared
- [ ] Queue health is on the monitored heartbeat, not only behind an endpoint
- [ ] Every config guard has been checked for its disable value, and verified inside the running process

## When something is stuck

1. **Is it on chain?** `getSignatureStatuses` with `searchTransactionHistory: true`. If null, nothing
   landed and no amount of retrying will change that.
2. **Does the wallet hold what you are selling?** Compare the order's amount against
   `getTokenAccountsByOwner`, summing every account for that mint. A shortfall of a few tenths of a
   percent is the quote-versus-fill bug.
3. **Is there a route at all?** Quote it independently. A clean route plus a failing swap points at
   your inputs, not at the market.
4. **Which program rejected it?** Read the full logs, then decode against that program's IDL.
5. **Reproduce read-only** with `simulateTransaction` before changing production state. Bisect the
   amount: the threshold is usually the answer.

Stop the loop before you investigate. A stuck order is spending provider quota and, if it is an exit,
leaving a position exposed with no working stop.
