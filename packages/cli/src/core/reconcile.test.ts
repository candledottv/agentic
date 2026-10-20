/**
 * BE-1665 (spec R-1 to R-4): reconciliation of interrupted money calls. T-7 (write-ahead and the
 * same id after a restart), T-9 (the user's two choices), and T-19's held-id half (a re-send of a
 * held id is a read, in every state, never a 404).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CardBook, type CardOrigin, type ExecutionOutcome } from "./cards"
import { EventHub } from "./events"
import { Journal, readJournal } from "./journal"
import { nextPollMs } from "./reconcile"
import { Redactor } from "./redact"
import { DEVICE_TOKEN, WRITE_KEY } from "./test-fixtures"
import { FactorRejectedError, TradingState } from "./trading"

const RIGHT = { type: "passphrase" as const, value: "the-right-passphrase-example" }
const VIEW = "c_view"
const HARNESS: CardOrigin = { clientId: "c_harness", role: "harness", clientName: "Claude Code" }
const MINT = "So11111111111111111111111111111111111111112"
const NOT_FOUND: ExecutionOutcome = {
  state: "failed",
  error: { code: "JOB_NOT_FOUND", message: "No trade with that clientTradeId" },
}

type Handler = (params: Record<string, unknown>) => ExecutionOutcome | Promise<ExecutionOutcome>

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(handlers: Record<string, Handler>, existingDir?: string) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), "candle-reconcile-")))
  if (!existingDir) dirs.push(dir)
  let now = Date.parse("2026-10-19T12:00:00Z")
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const journalPath = join(dir, "journal.jsonl")
  const journal = await Journal.open({
    path: journalPath,
    redactor: new Redactor(),
    environment: "staging",
    profile: "staging",
    now: clock.now,
  })
  const trading = await TradingState.open({
    settingsPath: join(dir, "settings.json"),
    now: clock.now,
    slotExists: async () => true,
    unlockVault: async (factor) => {
      if (factor.type !== "passphrase" || factor.value !== RIGHT.value) throw new FactorRejectedError()
      return { dek: new Uint8Array(32), file: { vaultId: "v" }, close() {} }
    },
    openSlot: async () => ({ writeKey: WRITE_KEY, deviceToken: DEVICE_TOKEN }),
    moveToSlot: async () => {},
    mintReadKey: async () => "unused",
    remember: () => {},
  })
  await trading.turnOn(RIGHT)
  const calls: { tool: string; params: Record<string, unknown> }[] = []
  const executor = {
    async execute(tool: string, params: Record<string, unknown>) {
      calls.push({ tool, params })
      const handler = handlers[tool]
      if (!handler) throw new Error(`no fake for ${tool}`)
      return handler(params)
    },
  }
  const timers: { run: () => void; ms: number }[] = []
  const book = new CardBook({
    journal,
    events: new EventHub(),
    trading,
    executor,
    environment: "staging",
    profile: "staging",
    now: clock.now,
    schedule: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return () => {
        const index = timers.indexOf(timer)
        if (index !== -1) timers.splice(index, 1)
      }
    },
  })
  /** Runs every due timer once, then waits for the caller's observable result, including real journal I/O. */
  const flush = async (settled: () => boolean) => {
    const due = timers.splice(0)
    for (const timer of due) {
      clock.advance(timer.ms)
      timer.run()
    }
    await waitUntil(settled)
    expect(settled()).toBe(true)
  }
  const approve = async (cardId: string, cardHash: string) => book.approve({ cardId, cardHash, factor: RIGHT }, VIEW)
  return { dir, journal, journalPath, trading, book, calls, timers, flush, clock, approve }
}

/** Polls a real-I/O condition up to a deadline (the vault KDF can be slow on a loaded runner); the assertion follows it. */
const waitUntil = async (done: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

const tradeCard = (book: CardBook, extra: Record<string, unknown> = {}) =>
  book.propose({ tool: "candle_trade", params: { mint: MINT, side: "buy", amount: "0.1", ...extra } }, HARNESS)

describe("T-7: write-ahead and the same id across a restart", () => {
  test("a core that dies after submitting reads the operation back by the same id, and on a 404 it is unknown with nothing sent", async () => {
    // The first core: the trade request never answers, as if the process died mid-call.
    const first = await setup({ candle_trade: () => new Promise<ExecutionOutcome>(() => {}) })
    const card = await tradeCard(first.book)
    void first.approve(card.cardId, card.cardHash)
    await waitUntil(() => first.calls.length > 0)
    expect(first.calls.map((c) => c.tool)).toEqual(["candle_trade"])
    const onDisk = (await readJournal(first.journalPath)).rows.map((row) => row.type)
    expect(onDisk).toContain("operation.submitting")

    // The restart.
    const second = await setup({ candle_get_operation: () => NOT_FOUND }, first.dir)
    const rebuilt = await second.book.rebuild([...second.journal.rows()])
    expect(rebuilt).toEqual({ expired: 0, unknown: 1 })
    const op = second.book.operation(card.opId, VIEW, false)
    expect(op).toMatchObject({
      state: "unknown",
      readNeedsFactor: true,
      reconcile: { actions: ["check", "resend", "abandon"] },
    })
    expect(second.calls).toEqual([])

    // The user checks it with the factor: one read under the same id, no write.
    const checked = await second.book.resolve({ opId: card.opId, action: "check", factor: RIGHT }, VIEW)
    expect(checked.state).toBe("unknown")
    expect(second.calls).toEqual([{ tool: "candle_get_operation", params: { clientId: card.opId, kind: "trade" } }])
  }, 10_000)

  test("after a restart, a check that finds the record settles it", async () => {
    const first = await setup({ candle_trade: () => new Promise<ExecutionOutcome>(() => {}) })
    const card = await tradeCard(first.book)
    void first.approve(card.cardId, card.cardHash)
    await waitUntil(() => first.calls.length > 0)
    expect(first.calls.map((c) => c.tool)).toEqual(["candle_trade"])
    const second = await setup(
      {
        candle_get_operation: () => ({
          state: "succeeded",
          result: { success: true, job: { clientTradeId: card.opId, status: "confirmed" } },
        }),
      },
      first.dir,
    )
    await second.book.rebuild([...second.journal.rows()])
    expect((await second.book.resolve({ opId: card.opId, action: "check", factor: RIGHT }, VIEW)).state).toBe(
      "succeeded",
    )
  }, 10_000)

  test("an open card from the last run expires on restart; settled operations are left alone", async () => {
    const first = await setup({
      candle_trade: () => ({ state: "succeeded", result: { job: { status: "confirmed" } } }),
    })
    const done = await tradeCard(first.book)
    await first.approve(done.cardId, done.cardHash)
    const open = await tradeCard(first.book, { amount: "0.5" })
    const second = await setup({}, first.dir)
    expect(await second.book.rebuild([...second.journal.rows()])).toEqual({ expired: 1, unknown: 0 })
    expect(second.book.get(open.cardId, VIEW, false).state).toBe("expired")
    expect(second.book.operation(done.opId, VIEW, false).state).toBe("succeeded")
  })
})

describe("R-2 on a lost answer", () => {
  test("a lost trade answer is read back at once, then polled until the record is terminal", async () => {
    let reads = 0
    const s = await setup({
      candle_trade: () => ({ state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "socket hang up" } }),
      candle_get_operation: () => {
        reads++
        if (reads === 1) return NOT_FOUND
        if (reads === 2) return { state: "succeeded", result: { job: { status: "built" } } }
        return { state: "succeeded", result: { job: { status: "confirmed" } } }
      },
    })
    const card = await tradeCard(s.book)
    expect((await s.approve(card.cardId, card.cardHash)).operation.state).toBe("unknown")
    expect(s.timers.map((t) => t.ms)).toEqual([0])
    await s.flush(() => s.timers.length > 0)
    expect(s.book.operation(card.opId, VIEW, false).state).toBe("unknown")
    expect(s.timers.map((t) => t.ms)).toEqual([5_000])
    await s.flush(() => s.timers.length > 0)
    expect(s.book.operation(card.opId, VIEW, false).state).toBe("pending")
    // State changes before append resolves; the journal row proves the terminal write has settled.
    await s.flush(() => s.journal.rows().some((row) => row.opId === card.opId && row.type === "operation.succeeded"))
    expect(s.book.operation(card.opId, VIEW, false).state).toBe("succeeded")
    expect(s.timers).toEqual([])
    // Every read used the same id; the trade itself was sent once.
    expect(s.calls.filter((c) => c.tool === "candle_trade").length).toBe(1)
    expect(new Set(s.calls.filter((c) => c.tool === "candle_get_operation").map((c) => c.params.clientId))).toEqual(
      new Set([card.opId]),
    )
  }, 10_000)

  test("polling stops after ten minutes and hands the operation to the user", async () => {
    const s = await setup({
      candle_trade: () => ({ state: "pending", result: { job: { status: "built" } } }),
      candle_get_operation: () => ({ state: "succeeded", result: { job: { status: "built" } } }),
    })
    const card = await tradeCard(s.book)
    await s.approve(card.cardId, card.cardHash)
    for (let i = 0; i < 60 && s.timers.length > 0; i++) {
      await s.flush(() => s.timers.length > 0 || s.book.operation(card.opId, VIEW, false).readNeedsFactor === true)
    }
    expect(s.timers).toEqual([])
    expect(s.book.operation(card.opId, VIEW, false)).toMatchObject({ state: "unknown", readNeedsFactor: true })
  }, 10_000)

  test("a kind with no read by id is unknown at once and not polled; check is not offered", async () => {
    const s = await setup({
      candle_swap: () => ({ state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "lost" } }),
    })
    const card = await s.book.propose(
      { tool: "candle_swap", params: { inputMint: MINT, outputMint: "x", amount: "1" } },
      HARNESS,
    )
    const { operation } = await s.approve(card.cardId, card.cardHash)
    expect(operation).toMatchObject({ state: "unknown", reconcile: { actions: ["resend", "abandon"] } })
    expect(s.timers).toEqual([])
    await expect(s.book.resolve({ opId: card.opId, action: "check", factor: RIGHT }, VIEW)).rejects.toMatchObject({
      code: "CHECK_NOT_AVAILABLE",
    })
  })

  test("the polling cadence is 5 s, then 30 s after two minutes, for ten minutes", () => {
    expect(nextPollMs(0, 1_000)).toBe(5_000)
    expect(nextPollMs(0, 2 * 60_000)).toBe(30_000)
    expect(nextPollMs(0, 10 * 60_000)).toBeUndefined()
  })
})

describe("T-9: what the user can do with an unknown (R-3, D2 default A)", () => {
  async function unknownTrade(extra: Record<string, Handler> = {}) {
    let first = true
    const s = await setup({
      candle_trade: () => {
        if (first) {
          first = false
          return { state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "lost" } }
        }
        return { state: "succeeded", result: { job: { status: "confirmed" } } }
      },
      candle_get_operation: () => NOT_FOUND,
      ...extra,
    })
    const card = await tradeCard(s.book)
    await s.approve(card.cardId, card.cardHash)
    await s.flush(() => s.timers.length > 0)
    return { s, card }
  }

  test("re-send uses the same opId and params and always needs a fresh factor, even in a window", async () => {
    const { s, card } = await unknownTrade()
    await expect(s.book.resolve({ opId: card.opId, action: "resend", factor: undefined }, VIEW)).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    await s.trading.openWindow(VIEW, 5, RIGHT)
    await expect(s.book.resolve({ opId: card.opId, action: "resend", factor: undefined }, VIEW)).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    const resent = await s.book.resolve({ opId: card.opId, action: "resend", factor: RIGHT }, VIEW)
    expect(resent).toMatchObject({ opId: card.opId, state: "succeeded", resolution: "resent" })
    const trades = s.calls.filter((c) => c.tool === "candle_trade")
    expect(trades.length).toBe(2)
    expect(trades[1]?.params).toEqual(trades[0]?.params as Record<string, unknown>)
    expect(trades[1]?.params.clientTradeId).toBe(card.opId)
    const types = (await readJournal(s.journalPath)).rows.map((row) => row.type)
    expect(types).toContain("operation.resend")
  }, 10_000)

  test("stop tracking keeps reading for ten minutes and records a late row", async () => {
    let reads = 0
    const { s, card } = await unknownTrade({
      candle_get_operation: () =>
        ++reads >= 3 ? { state: "succeeded", result: { job: { status: "confirmed" } } } : NOT_FOUND,
    })
    const abandoned = await s.book.resolve({ opId: card.opId, action: "abandon", factor: RIGHT }, VIEW)
    expect(abandoned).toMatchObject({ state: "resolved_abandoned", resolution: "abandoned" })
    for (let i = 0; i < 10 && s.timers.length > 0; i++) {
      await s.flush(
        () =>
          s.timers.length > 0 ||
          s.journal.rows().some((row) => row.opId === card.opId && row.type === "operation.late_record"),
      )
    }
    const op = s.book.operation(card.opId, VIEW, false)
    expect(op.state).toBe("resolved_abandoned")
    expect(op.lateRecord).toEqual({ status: "confirmed" })
    expect((await readJournal(s.journalPath)).rows.some((row) => row.type === "operation.late_record")).toBe(true)
  }, 10_000)

  test("stop tracking without a factor stops without reading; resolving a settled operation is refused", async () => {
    const { s, card } = await unknownTrade()
    s.timers.splice(0)
    const before = s.calls.length
    expect((await s.book.resolve({ opId: card.opId, action: "abandon", factor: undefined }, VIEW)).state).toBe(
      "resolved_abandoned",
    )
    expect(s.calls.length).toBe(before)
    await expect(s.book.resolve({ opId: card.opId, action: "resend", factor: RIGHT }, VIEW)).rejects.toMatchObject({
      code: "OPERATION_NOT_UNKNOWN",
    })
  }, 10_000)
})

describe("T-19: a re-send of a held id is a read (A-5), in every state", () => {
  test("open, settled, unknown and terminal: the same card back with its state, no new card, no execution", async () => {
    let first = true
    const s = await setup({
      candle_trade: () => {
        if (first) {
          first = false
          return { state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "lost" } }
        }
        return { state: "succeeded", result: {} }
      },
      candle_get_operation: () => NOT_FOUND,
    })
    const params = { mint: MINT, side: "buy", amount: "0.1", clientTradeId: "held-7" }
    const resend = () =>
      s.book.propose({ tool: "candle_trade", params }, HARNESS) as Promise<{
        cardId: string
        state: string
        operation?: { state: string }
      }>
    const open = await resend()
    expect((await resend()).cardId).toBe(open.cardId)
    await s.approve(open.cardId, (await s.book.get(open.cardId, VIEW, false)).cardHash)
    const unknown = await resend()
    expect(unknown).toMatchObject({ cardId: open.cardId, state: "approved", operation: { state: "unknown" } })
    await s.book.resolve({ opId: "held-7", action: "resend", factor: RIGHT }, VIEW)
    const settled = await resend()
    expect(settled).toMatchObject({ cardId: open.cardId, operation: { state: "succeeded" } })
    expect(s.calls.filter((c) => c.tool === "candle_trade").length).toBe(2)
    expect(s.book.list(VIEW, false).length).toBe(1)
    // A rejected card under a held id answers too.
    const other = await s.book.propose(
      { tool: "candle_trade", params: { ...params, clientTradeId: "held-8" } },
      HARNESS,
    )
    await s.book.reject(other.cardId, VIEW)
    expect(
      await s.book.propose({ tool: "candle_trade", params: { ...params, clientTradeId: "held-8" } }, HARNESS),
    ).toMatchObject({
      cardId: other.cardId,
      state: "rejected",
    })
    await expect(
      s.book.propose({ tool: "candle_trade", params: { ...params, amount: "2" } }, HARNESS),
    ).rejects.toMatchObject({
      code: "OP_ID_CONFLICT",
    })
  })
})

describe("V-5: a fee claim has no id, so the evidence is the claimable amounts", () => {
  test("the amounts are read before the claim and again on a check", async () => {
    let feeReads = 0
    const s = await setup({
      candle_get_fees: () => ({
        state: "succeeded",
        result: {
          tokens: [{ mint: MINT, claimableAmounts: { sol: ++feeReads === 1 ? "5" : "0" }, claimable: feeReads === 1 }],
        },
      }),
      candle_claim_fees: () => ({ state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "lost" } }),
    })
    const card = await s.book.propose({ tool: "candle_claim_fees", params: { mint: MINT } }, HARNESS)
    const { operation } = await s.approve(card.cardId, card.cardHash)
    expect(operation).toMatchObject({ state: "unknown", evidence: { before: { claimableAmounts: { sol: "5" } } } })
    const checked = await s.book.resolve({ opId: card.opId, action: "check", factor: RIGHT }, VIEW)
    expect(checked.state).toBe("unknown")
    expect(checked.evidence).toEqual({
      before: { claimableAmounts: { sol: "5" }, claimable: true },
      after: { claimableAmounts: { sol: "0" }, claimable: false },
    })
  })
})
