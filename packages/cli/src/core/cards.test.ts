/**
 * BE-1665 (spec K-2 to K-9): the card book. T-4 (approval binds the hash), T-5 (no approval without
 * a factor), T-6's card half (a harness cannot start a transfer), T-10 (duplicate proposals
 * collapse), and K-7's write-ahead order.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CardBook, type CardOrigin, type ExecutionOutcome, hashCard } from "./cards"
import { EventHub } from "./events"
import { Journal, readJournal } from "./journal"
import { Redactor } from "./redact"
import { DEVICE_TOKEN, WRITE_KEY } from "./test-fixtures"
import { FactorRejectedError, TradingState } from "./trading"

const RIGHT = { type: "passphrase" as const, value: "the-right-passphrase-example" }
const WRONG = { type: "passphrase" as const, value: "the-wrong-passphrase-example" }
const VIEW: CardOrigin = { clientId: "c_view", role: "view", clientName: "tui" }
const VIEW_B: CardOrigin = { clientId: "c_view_b", role: "view", clientName: "tui-2" }
const HARNESS: CardOrigin = {
  clientId: "c_harness",
  role: "harness",
  clientName: "Claude Code",
  harnessKind: "claude-code",
}
const OTHER: CardOrigin = { clientId: "c_other", role: "harness", clientName: "Codex" }
const MINT = "So11111111111111111111111111111111111111112"
const DRY_RUN_PASS = {
  success: true,
  dryRun: true,
  launchWallet: "Launch1111111111111111111111111111111111111",
  resolved: { chain: "solana", quoteAsset: "sol", mode: "open", stakerAllocationBps: 50 },
  checks: { image: "ok" },
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(
  opts: {
    tradingOn?: boolean
    outcome?: (calls: number) => ExecutionOutcome | Promise<ExecutionOutcome>
    keyLimit?: { usdMicros: number; usedUsdMicros: number }
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-cards-"))
  dirs.push(dir)
  let now = Date.parse("2026-10-19T12:00:00Z")
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const redactor = new Redactor()
  const journalPath = join(dir, "journal.jsonl")
  const journal = await Journal.open({
    path: journalPath,
    redactor,
    environment: "staging",
    profile: "staging",
    now: clock.now,
  })
  const unlocks: string[] = []
  const trading = await TradingState.open({
    settingsPath: join(dir, "settings.json"),
    now: clock.now,
    slotExists: async () => true,
    unlockVault: async (factor) => {
      if (factor.type !== "passphrase" || factor.value !== RIGHT.value) throw new FactorRejectedError()
      unlocks.push(factor.type)
      return { dek: new Uint8Array(32), file: { vaultId: "v" }, close() {} }
    },
    openSlot: async () => ({ writeKey: WRITE_KEY, deviceToken: DEVICE_TOKEN }),
    moveToSlot: async () => {},
    mintReadKey: async () => "unused",
    remember: () => {},
    ...(opts.keyLimit
      ? {
          readKeyLimit: async () => ({
            ...(opts.keyLimit as { usdMicros: number; usedUsdMicros: number }),
            reset: "daily" as const,
            readAt: 0,
          }),
        }
      : {}),
  })
  if (opts.tradingOn !== false) await trading.turnOn(RIGHT)
  unlocks.length = 0
  const calls: { tool: string; params: Record<string, unknown>; writeKey: string; journalAtCall: string }[] = []
  const executor = {
    async execute(tool: string, params: Record<string, unknown>, writeKey: string) {
      calls.push({ tool, params, writeKey, journalAtCall: await readFile(journalPath, "utf8") })
      // S4 L-4: a launch's dry run passes unless the test says otherwise.
      if (params.dryRun === true && !opts.outcome) return { state: "succeeded", result: DRY_RUN_PASS } as const
      return opts.outcome ? opts.outcome(calls.length) : ({ state: "succeeded", result: { success: true } } as const)
    },
  }
  const events = new EventHub()
  const book = new CardBook({
    journal,
    events,
    trading,
    executor,
    environment: "staging",
    profile: "staging",
    now: clock.now,
  })
  const trade = (
    params: Record<string, unknown> = {},
    origin: CardOrigin = HARNESS,
    extra: Record<string, unknown> = {},
  ) =>
    book.propose(
      { tool: "candle_trade", params: { mint: MINT, side: "buy", amount: "0.1", ...params }, ...extra },
      origin,
    )
  return { dir, journal, journalPath, trading, book, calls, unlocks, clock, events, trade }
}

describe("proposing (K-1, K-2, K-3)", () => {
  test("a live trade becomes a card bound by hash, with the operation id in clientTradeId", async () => {
    const s = await setup()
    const card = await s.trade({}, HARNESS, { reason: "momentum\u001b[2J" })
    expect(card).toMatchObject({
      kind: "trade",
      tool: "candle_trade",
      idKey: "clientTradeId",
      state: "awaiting_approval",
      policy: "ask",
    })
    expect(card.params.clientTradeId).toBe(card.opId)
    expect(card.cardHash).toBe(
      hashCard({
        kind: "trade",
        tool: "candle_trade",
        params: card.params,
        opId: card.opId,
        environment: "staging",
        profile: "staging",
      }),
    )
    expect(card.display).toMatchObject({
      title: "BUY candle_trade",
      contract: MINT,
      chain: "solana",
      amount: "0.1",
      environment: "staging",
    })
    expect(card.reason).toBe("momentum[2J")
    expect(Date.parse(card.expiresAt) - Date.parse(card.createdAt)).toBe(60_000)
  })

  test("an id the proposer gives is kept as the operation id", async () => {
    const s = await setup()
    const card = await s.trade({ clientTradeId: "my-id-1" })
    expect(card.opId).toBe("my-id-1")
  })

  test("the hash does not depend on key order", () => {
    const base = {
      kind: "trade" as const,
      tool: "candle_trade",
      opId: "x",
      environment: "staging" as const,
      profile: "p",
    }
    expect(hashCard({ ...base, params: { a: 1, b: 2 } })).toBe(hashCard({ ...base, params: { b: 2, a: 1 } }))
  })

  test("T-6: a harness cannot propose a transfer; a view's transfer comes only from the transfer form (S4 T-1)", async () => {
    const s = await setup()
    await expect(
      s.book.propose({ tool: "candle_transfer", kind: "transfer", params: { to: "x" } }, HARNESS),
    ).rejects.toMatchObject({
      code: "TRANSFER_USER_ONLY",
    })
    await expect(s.book.propose({ tool: "candle_sweep", params: {} }, VIEW)).rejects.toMatchObject({
      code: "TRANSFER_FORM_ONLY",
    })
  })

  test("reads, paper trades and dry runs are not cards; an unknown tool is refused", async () => {
    const s = await setup()
    await expect(s.book.propose({ tool: "candle_get_market", params: {} }, HARNESS)).rejects.toMatchObject({
      code: "NOT_A_CARD",
    })
    await expect(s.trade({ paper: true })).rejects.toMatchObject({ code: "NOT_A_CARD" })
    await expect(
      s.book.propose({ tool: "candle_launch_token", params: { dryRun: true } }, HARNESS),
    ).rejects.toMatchObject({ code: "NOT_A_CARD" })
    await expect(s.book.propose({ tool: "candle_new_thing", params: {} }, HARNESS)).rejects.toMatchObject({
      code: "TOOL_NOT_CLASSIFIED",
    })
    await expect(s.book.propose({ tool: "candle_trade", kind: "swap", params: {} }, HARNESS)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    })
  })

  test("trading off refuses live proposals; perps kinds are reserved for S6", async () => {
    const off = await setup({ tradingOn: false })
    await expect(off.trade()).rejects.toMatchObject({ code: "TRADING_OFF" })
    const on = await setup()
    await expect(on.book.propose({ tool: "candle_perps_open", params: {} }, HARNESS)).rejects.toMatchObject({
      code: "KIND_RESERVED",
    })
  })

  test("T-10: the same client and the same params while a card is open return the same card", async () => {
    const s = await setup()
    const first = await s.trade()
    expect((await s.trade()).cardId).toBe(first.cardId)
    expect((await s.trade({}, OTHER)).cardId).not.toBe(first.cardId)
    expect((await s.trade({ amount: "0.2" })).cardId).not.toBe(first.cardId)
    const keyed = await s.trade({}, HARNESS, { proposalKey: "k1" })
    expect(keyed.cardId).not.toBe(first.cardId)
    expect((await s.trade({}, HARNESS, { proposalKey: "k1" })).cardId).toBe(keyed.cardId)
    await s.book.reject(first.cardId, VIEW.clientId)
    expect((await s.trade()).cardId).not.toBe(first.cardId)
  })

  test("a held id with the same params is the same card; with other params it is OP_ID_CONFLICT", async () => {
    const s = await setup()
    const card = await s.trade({ clientTradeId: "held-1" })
    expect((await s.trade({ clientTradeId: "held-1" }, OTHER)).cardId).toBe(card.cardId)
    await expect(s.trade({ clientTradeId: "held-1", amount: "9" })).rejects.toMatchObject({ code: "OP_ID_CONFLICT" })
  })

  test("a held id is answered before the trading-off gate (A-5, R-4)", async () => {
    const s = await setup()
    const card = await s.trade({ clientTradeId: "held-off" })
    await s.trading.turnOff()
    expect((await s.trade({ clientTradeId: "held-off" })).cardId).toBe(card.cardId)
    expect(s.book.holdsRequest({ tool: "candle_trade", params: { clientTradeId: "held-off" } })).toBe(true)
    expect(s.book.holdsRequest({ tool: "candle_trade", params: { clientTradeId: "other" } })).toBe(false)
    await expect(s.trade({ clientTradeId: "new-one" })).rejects.toMatchObject({ code: "TRADING_OFF" })
  })

  test("a client may hold five open cards", async () => {
    const s = await setup()
    for (let i = 0; i < 5; i++) await s.trade({ amount: String(i + 1) })
    await expect(s.trade({ amount: "6" })).rejects.toMatchObject({ code: "TOO_MANY_OPEN_CARDS" })
  })
})

describe("approving (K-5, K-7)", () => {
  test("T-4: a stale or foreign hash is refused and nothing runs; the drawn hash with the factor executes", async () => {
    const s = await setup()
    const card = await s.trade()
    const other = await s.trade({ amount: "0.2" })
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: other.cardHash, factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "CARD_HASH_MISMATCH",
    })
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: "0".repeat(64), factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "CARD_HASH_MISMATCH",
    })
    expect(s.calls).toEqual([])
    const { operation } = await s.book.approve(
      { cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT },
      VIEW.clientId,
    )
    expect(operation).toMatchObject({ opId: card.opId, state: "succeeded" })
    expect(s.calls.length).toBe(1)
    // Invariant 4: what executed is the card's params, under its opId, with the Write key.
    expect(s.calls[0]).toMatchObject({ tool: "candle_trade", params: card.params, writeKey: WRITE_KEY })
  })

  test("K-7: the submitting row is on disk before the request is sent", async () => {
    const s = await setup()
    const card = await s.trade()
    await s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId)
    const before = s.calls[0]?.journalAtCall ?? ""
    expect(before).toContain('"type":"card.approved"')
    expect(before).toContain('"type":"operation.submitting"')
    expect(before).not.toContain('"type":"operation.succeeded"')
    const types = (await readJournal(s.journalPath)).rows.map((row) => row.type)
    expect(types.slice(-3)).toEqual(["card.approved", "operation.submitting", "operation.succeeded"])
  })

  test("T-5: no factor outside a window is refused; a window opened by this view approves a trade", async () => {
    const s = await setup()
    const card = await s.trade()
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: undefined }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    await s.trading.openWindow(VIEW.clientId, 5, RIGHT)
    // Another view gets nothing from this view's window.
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: undefined }, VIEW_B.clientId),
    ).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    s.unlocks.length = 0
    const { operation } = await s.book.approve(
      { cardId: card.cardId, cardHash: card.cardHash, factor: undefined },
      VIEW.clientId,
    )
    expect(operation.state).toBe("succeeded")
    expect(s.unlocks).toEqual([])
  })

  test("T-5: inside a window, launch, keyaccess and transfer still need a fresh factor", async () => {
    const s = await setup()
    await s.trading.openWindow(VIEW.clientId, 5, RIGHT)
    const launch = await s.book.propose(
      { tool: "candle_launch_token", params: { name: "X", clientLaunchId: "l1" } },
      HARNESS,
    )
    const wallets = await s.book.propose({ tool: "candle_set_profile_wallets", params: { wallets: ["w"] } }, HARNESS)
    for (const card of [launch, wallets]) {
      await expect(
        s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: undefined }, VIEW.clientId),
      ).rejects.toMatchObject({
        code: "FACTOR_REQUIRED",
      })
    }
    await expect(
      s.trading.withCredentials({ kind: "transfer", viewClientId: VIEW.clientId, factor: undefined }, async () => 1),
    ).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    // Only the launch's dry run ran (inside the window, S4 L-4); nothing live was sent.
    expect(s.calls.map((call) => call.params.dryRun)).toEqual([true])
    // With the factor, the launch runs.
    expect(
      (await s.book.approve({ cardId: launch.cardId, cardHash: launch.cardHash, factor: RIGHT }, VIEW.clientId))
        .operation.state,
    ).toBe("succeeded")
  })

  test("a wrong factor is FACTOR_REJECTED and the card stays open; five in ten minutes lock approvals", async () => {
    const s = await setup()
    const card = await s.trade()
    for (let i = 0; i < 4; i++) {
      await expect(
        s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: WRONG }, VIEW.clientId),
      ).rejects.toMatchObject({
        code: "FACTOR_REJECTED",
      })
      expect(s.book.get(card.cardId, VIEW.clientId, false).state).toBe("awaiting_approval")
    }
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: WRONG }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "FACTOR_REJECTED",
    })
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "APPROVALS_LOCKED",
    })
    s.clock.advance(5 * 60_000 + 1)
    const fresh = await s.trade({ amount: "0.3" })
    expect(
      (await s.book.approve({ cardId: fresh.cardId, cardHash: fresh.cardHash, factor: RIGHT }, VIEW.clientId)).operation
        .state,
    ).toBe("succeeded")
  })

  test("the passphrase never reaches the journal", async () => {
    const s = await setup()
    const card = await s.trade()
    await s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId)
    await s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: WRONG }, VIEW.clientId).catch(() => {})
    const text = await readFile(s.journalPath, "utf8")
    expect(text).not.toContain(RIGHT.value)
    expect(text).not.toContain(WRONG.value)
    expect(text).toContain('"factorType":"passphrase"')
  })

  test("two approvals of one card: the first wins, the second is CARD_NOT_AWAITING, and it runs once", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const s = await setup({
      outcome: async () => {
        await gate
        return { state: "succeeded", result: {} }
      },
    })
    const card = await s.trade()
    const first = s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW_B.clientId),
    ).rejects.toMatchObject({
      code: "CARD_NOT_AWAITING",
    })
    release()
    await first
    expect(s.calls.length).toBe(1)
  })

  test("an executor that throws leaves the operation unknown, never failed", async () => {
    const s = await setup({
      outcome: () => {
        throw new Error("socket hang up")
      },
    })
    const card = await s.trade()
    const { operation } = await s.book.approve(
      { cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT },
      VIEW.clientId,
    )
    expect(operation.state).toBe("unknown")
    expect(s.book.inFlight()).toBe(false)
  })

  test("trading turned off between proposal and approval refuses the approval", async () => {
    const s = await setup()
    const card = await s.trade()
    await s.trading.turnOff()
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "TRADING_OFF",
    })
  })
})

describe("K-5: the key limit, read fresh at approval", () => {
  test("over what is left is OVER_KEY_LIMIT, nothing is sent and the card stays open; within it runs", async () => {
    const s = await setup({ keyLimit: { usdMicros: 50_000_000, usedUsdMicros: 20_000_000 } })
    const big = await s.trade({ quoteAsset: "USDC", amount: "40" })
    expect(big.display.keyLimitUsd).toBe("$50.00 daily, $30.00 left")
    await expect(
      s.book.approve({ cardId: big.cardId, cardHash: big.cardHash, factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "OVER_KEY_LIMIT",
    })
    expect(s.calls).toEqual([])
    expect(s.book.get(big.cardId, VIEW.clientId, false).state).toBe("awaiting_approval")
    const small = await s.trade({ quoteAsset: "USDC", amount: "10" })
    expect(
      (await s.book.approve({ cardId: small.cardId, cardHash: small.cardHash, factor: RIGHT }, VIEW.clientId)).operation
        .state,
    ).toBe("succeeded")
  })

  test("a card whose USD amount the core cannot tell is left to the server's limit", async () => {
    const s = await setup({ keyLimit: { usdMicros: 1, usedUsdMicros: 0 } })
    const sol = await s.trade({ amount: "100" })
    expect(
      (await s.book.approve({ cardId: sol.cardId, cardHash: sol.cardHash, factor: RIGHT }, VIEW.clientId)).operation
        .state,
    ).toBe("succeeded")
  })
})

describe("card states (K-8)", () => {
  test("a trade card expires after 60 seconds and cannot then be approved", async () => {
    const s = await setup()
    const card = await s.trade()
    s.clock.advance(60_001)
    await s.book.expireDue()
    expect(s.book.get(card.cardId, VIEW.clientId, false).state).toBe("expired")
    await expect(
      s.book.approve({ cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }, VIEW.clientId),
    ).rejects.toMatchObject({
      code: "CARD_NOT_AWAITING",
    })
  })

  test("only the proposer withdraws; a harness sees and reads only its own cards", async () => {
    const s = await setup()
    const mine = await s.trade()
    const theirs = await s.trade({}, OTHER)
    await expect(s.book.withdraw(theirs.cardId, HARNESS.clientId)).rejects.toMatchObject({ code: "CARD_NOT_FOUND" })
    expect(() => s.book.get(theirs.cardId, HARNESS.clientId, true)).toThrow()
    expect(s.book.list(HARNESS.clientId, true).map((c) => c.cardId)).toEqual([mine.cardId])
    expect(s.book.list(VIEW.clientId, false).length).toBe(2)
    expect((await s.book.withdraw(mine.cardId, HARNESS.clientId)).state).toBe("withdrawn")
  })

  test("a killed client's open cards are withdrawn; with the last view gone, every open card expires", async () => {
    const s = await setup()
    const a = await s.trade()
    const b = await s.trade({}, OTHER)
    await s.book.withdrawAllFor(HARNESS.clientId)
    expect(s.book.get(a.cardId, VIEW.clientId, false).state).toBe("withdrawn")
    await s.book.expireAllOpen("last_view_detached")
    expect(s.book.get(b.cardId, VIEW.clientId, false).state).toBe("expired")
  })

  test("card events go to the proposer's harness only", async () => {
    const s = await setup()
    const seen: Record<string, unknown[]> = { harness: [], other: [] }
    s.events.subscribe({ clientId: HARNESS.clientId, role: "harness", send: (n) => seen.harness?.push(n) }, ["cards"])
    s.events.subscribe({ clientId: OTHER.clientId, role: "harness", send: (n) => seen.other?.push(n) }, ["cards"])
    await s.trade()
    expect(seen.harness?.length).toBe(2) // snapshot, then the card
    expect(seen.other?.length).toBe(1) // snapshot only
  })
})

describe("S5 K-2 (BE-1737): a card reached from a Quant answer", () => {
  test("T-10: suggestedBy is shown and never hashed; the hash equals the same card made without Quant", async () => {
    const s = await setup()
    const params = { clientTradeId: "trade-from-quant", amount: "0.25" }
    const suggested = await s.trade(params, VIEW, { suggestedBy: { agent: "quant", turnId: "turn_1" } })
    expect(suggested.display.suggestedBy).toEqual({ agent: "quant", turnId: "turn_1" })
    expect(suggested.params).not.toHaveProperty("suggestedBy")
    const plain = hashCard({
      kind: "trade",
      tool: "candle_trade",
      params: suggested.params,
      opId: suggested.opId,
      environment: "staging",
      profile: "staging",
    })
    expect(suggested.cardHash).toBe(plain)
    // The same request from a second view, without Quant, binds the same hash.
    const t = await setup()
    const without = await t.trade(params, VIEW)
    expect(without.cardHash).toBe(suggested.cardHash)
    expect(without.display.suggestedBy).toBeUndefined()
  })

  test("a harness cannot set suggestedBy, and a view can name only Quant and a turn id", async () => {
    const s = await setup()
    await expect(s.trade({}, HARNESS, { suggestedBy: { agent: "quant", turnId: "t" } })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    })
    for (const bad of [{ agent: "pi", turnId: "t" }, { agent: "quant" }, { agent: "quant", turnId: "t", amount: "2" }])
      await expect(s.trade({}, VIEW, { suggestedBy: bad })).rejects.toMatchObject({ code: "INVALID_PARAMS" })
  })
})
