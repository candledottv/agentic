/**
 * BE-1584 (spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md, sections 4 and 11):
 * the client's pre-sign checks for every management variant, against hostile builds. Each test
 * starts from an honest build the check passes, then mutates one thing the spec names (target oid,
 * asset, wallet, side, TIF, reduce flag, omitted modify fields, amount, mode, pct size, trigger, tag,
 * grouping, timer, builder, an extra leg or key) and expects a refusal. The same file is the CLI's
 * and the MCP server's (drift tests), so these results hold on all three surfaces.
 */
import { describe, expect, test } from "bun:test"
import {
  HYPERLIQUID_SCHEDULE_CANCEL_MIN_LEAD_MS,
  hyperliquidActionHash,
  hyperliquidCloseOrder,
  hyperliquidClosePct,
  hyperliquidExchangeOutcome,
  hyperliquidFloorSize,
  hyperliquidL1TypedData,
  hyperliquidPctSize,
  hyperliquidWalletSnapshot,
  type PerpsBuildToVerify,
  type VerifyPerpsBuildOptions,
  verifyPerpsBuild,
  verifyPerpsBuildAgainstVenue,
} from "./hyperliquid"

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const OTHER = "0x1111111111111111111111111111111111111111"
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const NONCE = 1_790_000_000_000
const CLOID = `0x${"1".repeat(32)}`
const NEW_CLOID = `0x${"2".repeat(32)}`

function build(action: Record<string, unknown>, over: Partial<PerpsBuildToVerify> = {}): PerpsBuildToVerify {
  return {
    network: "mainnet",
    nonce: NONCE,
    address: ADDRESS,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
    ...over,
  }
}

const check = (action: Record<string, unknown>, opts: Partial<VerifyPerpsBuildOptions>) =>
  verifyPerpsBuild(build(action), { builder: BUILDER, address: ADDRESS, ...opts })

function refused(action: Record<string, unknown>, opts: Partial<VerifyPerpsBuildOptions>, reason?: string) {
  const result = check(action, opts)
  expect(result.ok).toBe(false)
  if (reason !== undefined) expect(result.ok ? "" : result.reason).toContain(reason)
}

const passes = (action: Record<string, unknown>, opts: Partial<VerifyPerpsBuildOptions>) =>
  expect(check(action, opts)).toEqual({ ok: true, kind: "l1" })

describe("complete action key sets", () => {
  test("a vault, an expiry, an unknown order key, a fast flag or a hidden transfer field is refused", () => {
    const order = { a: 0, b: true, p: "60000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } }, c: CLOID }
    const base = { type: "order", orders: [order], grouping: "na", builder: { b: BUILDER, f: 100 } }
    passes(base, {})
    refused({ ...base, expiresAfter: 1 }, {}, "unexpected or missing fields")
    refused({ ...base, orders: [{ ...order, fast: true }] }, {}, "an order carries unexpected")
    refused({ ...base, orders: [{ ...order, t: { limit: { tif: "Gtc", alwaysPlace: true } } }] }, {})
    refused({ type: "cancel", cancels: [{ a: 0, o: 1, destination: OTHER }] }, {}, "a cancel carries")
    refused({ type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: 1, toPerp: false }, {})
    refused({ type: "scheduleCancel", time: NONCE, user: OTHER }, {})
    refused({ ...base, orders: [{ ...order, c: "0x123" }] }, {}, "malformed client order id")
    refused({ ...base, grouping: "twap" }, {}, "grouping")
  })
})

describe("scheduled cancel (spec D, section 7)", () => {
  const set = { type: "scheduleCancel", time: NONCE + 60_000 }
  const clock = { now: NONCE }
  const intent = (params: Record<string, unknown>) => ({ method: "scheduleCancel" as const, params })

  test("an honest set and an omitted-time clear pass", () => {
    passes(set, { intent: intent({ seconds: 60 }), clock })
    passes({ type: "scheduleCancel" }, { intent: intent({ clear: true }), clock })
  })

  test("a clear carrying any time, null included, is refused", () => {
    for (const time of [NONCE, 0, null]) refused({ type: "scheduleCancel", time }, { intent: intent({ clear: true }) })
  })

  test("less than five seconds of lead at sign time is refused: rebuild, never re-time locally", () => {
    const late = { now: NONCE + 60_000 - HYPERLIQUID_SCHEDULE_CANCEL_MIN_LEAD_MS + 1 }
    refused(set, { intent: intent({ seconds: 60 }), clock: late }, "less than 5 seconds")
    passes({ type: "scheduleCancel", time: NONCE + 5_000 }, { intent: intent({ seconds: 5 }), clock })
  })

  test("a time that is not the requested delay, a missing time or a sub-5 request is refused", () => {
    refused(
      { type: "scheduleCancel", time: NONCE + 3_600_000 },
      { intent: intent({ seconds: 60 }), clock },
      "requested delay",
    )
    refused({ type: "scheduleCancel" }, { intent: intent({ seconds: 60 }), clock }, "without a time")
    refused({ type: "scheduleCancel", time: NONCE + 4_000 }, { intent: intent({ seconds: 4 }), clock }, "at least 5")
  })

  test("a scheduled cancel carries no builder, and another type under its intent is refused", () => {
    refused({ ...set, builder: { b: BUILDER, f: 1 } }, { intent: intent({ seconds: 60 }), clock })
    refused({ type: "cancel", cancels: [{ a: 0, o: 1 }] }, { intent: intent({ seconds: 60 }), clock }, "does not match")
  })
})

describe("post-open TP/SL attach (spec D, section 6)", () => {
  const leg = (over: Record<string, unknown> = {}) => ({
    a: 0,
    b: false,
    p: "62700",
    s: "0.5",
    r: true,
    t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "tp" } },
    c: NEW_CLOID,
    ...over,
  })
  const attach = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
    type: "order",
    orders: [leg(over)],
    grouping: "positionTpsl",
    builder: { b: BUILDER, f: 100 },
    ...action,
  })
  const intent = { method: "tpsl" as const, params: { coin: "BTC", leg: "tp", triggerPx: "66000" } }
  const tpslTarget = { asset: 0, isBuy: false, size: "0.5", markPx: "60000" }

  test("an honest take-profit on a long passes; a Max build with no builder too", () => {
    passes(attach(), { intent, tpslTarget })
    const { builder: _b, ...max } = attach()
    passes(max, { intent, tpslTarget })
  })

  test("each mutated field is refused", () => {
    refused(attach({}, { grouping: "normalTpsl" }), { intent, tpslTarget }, "positionTpsl")
    refused(attach({}, { grouping: "na" }), { intent, tpslTarget })
    refused(attach({ r: false }), { intent, tpslTarget })
    refused(attach({ t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "sl" } } }), { intent, tpslTarget })
    refused(attach({ t: { trigger: { isMarket: false, triggerPx: "66000", tpsl: "tp" } } }), { intent, tpslTarget })
    refused(attach({ t: { trigger: { isMarket: true, triggerPx: "67000", tpsl: "tp" } } }), { intent, tpslTarget })
    refused(attach({ s: "0.6" }), { intent, tpslTarget }, "size does not match the position")
    refused(attach({ b: true }), { intent, tpslTarget })
    refused(attach({ a: 1 }), { intent, tpslTarget })
    refused(attach({ p: "1" }), { intent, tpslTarget }, "slippage of the trigger price")
    refused(attach({ c: undefined }), { intent, tpslTarget }, "no client order id")
    refused(attach({}, { builder: { b: OTHER, f: 100 } }), { intent, tpslTarget }, "not Candle's")
    refused(attach({}, { builder: { b: BUILDER, f: 101 } }), { intent, tpslTarget })
    refused(attach({}, { orders: [leg(), leg({ c: CLOID })] }), { intent, tpslTarget }, "one positionTpsl order")
  })

  test("mark-relative: a crossed trigger, for a long and a short, is refused", () => {
    refused(attach(), { intent, tpslTarget: { ...tpslTarget, markPx: "66500" } }, "crossed")
    const shortSl = attach({ b: true, p: "69300", t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "sl" } } })
    const slIntent = { method: "tpsl" as const, params: { coin: "BTC", leg: "sl", triggerPx: "66000" } }
    passes(shortSl, { intent: slIntent, tpslTarget: { ...tpslTarget, isBuy: true } })
    refused(shortSl, { intent: slIntent, tpslTarget: { ...tpslTarget, isBuy: true, markPx: "67000" } }, "crossed")
  })
})

describe("modify keeps what the venue shows (spec D, section 5)", () => {
  const replacement = (over: Record<string, unknown> = {}) => ({
    a: 0,
    b: false,
    p: "61500",
    s: "0.2",
    r: true,
    t: { limit: { tif: "Gtc" } },
    c: NEW_CLOID,
    ...over,
  })
  const modify = (over: Record<string, unknown> = {}, oid: unknown = 77) => ({
    type: "modify",
    oid,
    order: replacement(over),
  })
  const market = {
    asset: 0,
    midPx: "60000",
    order: { isBuy: false, limitPx: "61000", size: "0.2", reduceOnly: true, tif: "Gtc", oid: 77 },
  }
  const intent = { method: "modify" as const, params: { cloid: CLOID, price: "61500" } }

  test("an honest reducing modify passes, by oid or by the requested cloid", () => {
    passes(modify(), { intent, market })
    passes(modify({}, CLOID), { intent, market })
  })

  test("a different target, side, reduce flag, TIF, omitted size or asset is refused", () => {
    refused(modify({}, 78), { intent, market }, "does not name the resting order")
    refused(modify({}, NEW_CLOID), { intent, market })
    refused(modify({ b: true }), { intent, market }, "side")
    refused(modify({ r: false }), { intent, market }, "reduce-only flag")
    refused(modify({ t: { limit: { tif: "Alo" } } }), { intent, market }, "time in force")
    refused(modify({ s: "0.3" }), { intent, market }, "size")
    refused(modify({ a: 1 }), { intent, market }, "asset")
    refused(modify({ p: "62000" }), { intent, market }, "price does not match")
  })

  test("a reduce-only key refuses a non-reducing replacement, whatever the server built", () => {
    const open = { ...market, order: { ...market.order, reduceOnly: false } }
    passes(modify({ r: false }), { intent, market: open })
    refused(modify({ r: false }), { intent, market: open, keyReduceOnly: true }, "reduce-only")
  })
})

describe("margin top-up and mode (spec D, section 5)", () => {
  test("a top-up must name the isolated position's asset, exactly; a reduce-only key never removes", () => {
    const action = { type: "updateIsolatedMargin", asset: 3, isBuy: true, ntli: 12_345_678 }
    const intent = { method: "margin" as const, params: { coin: "SOL", amount: "12.345678" } }
    passes(action, { intent, marginTarget: { asset: 3 } })
    refused(action, { intent, marginTarget: { asset: 4 } }, "asset")
    refused({ ...action, ntli: 12_345_679 }, { intent, marginTarget: { asset: 3 } }, "amount")
    refused({ ...action, isBuy: false }, { intent, marginTarget: { asset: 3 } })
    const removal = { ...action, ntli: -1_000_000 }
    const removeIntent = { method: "margin" as const, params: { coin: "SOL", amount: "-1" } }
    passes(removal, { intent: removeIntent })
    refused(removal, { intent: removeIntent, keyReduceOnly: true }, "only be added")
  })

  test("an omitted leverage must be the account's current one; a mode change needs a flat coin", () => {
    const iso = { type: "updateLeverage", asset: 1, isCross: false, leverage: 7 }
    const intent = { method: "leverage" as const, params: { coin: "ETH", mode: "isolated" } }
    const target = { asset: 1, leverage: 7, mode: "cross" as const, flat: true }
    passes(iso, { intent, leverageTarget: target })
    refused({ ...iso, leverage: 1 }, { intent, leverageTarget: target }, "leverage or mode")
    refused(iso, { intent }, "leverage or mode") // no venue read, no way to know the current value
    refused(iso, { intent, leverageTarget: { ...target, flat: false } }, "needs no position")
    refused({ ...iso, asset: 2 }, { intent, leverageTarget: target }, "asset")
    refused({ ...iso, isCross: true }, { intent, leverageTarget: target })
  })

  test("a reduce-only key: no increase, no mode change; a same-mode decrease passes", () => {
    const intent = (leverage: number) => ({ method: "leverage" as const, params: { coin: "ETH", leverage } })
    const target = { asset: 1, leverage: 10, mode: "cross" as const, flat: false }
    const cross = (leverage: number) => ({ type: "updateLeverage", asset: 1, isCross: true, leverage })
    passes(cross(5), { intent: intent(5), leverageTarget: target, keyReduceOnly: true })
    refused(cross(12), { intent: intent(12), leverageTarget: target, keyReduceOnly: true }, "reduce-only")
  })
})

describe("targeted cancels (TP/SL legs and flatten, spec D, sections 6 and 8)", () => {
  test("the cancel must name exactly the venue's order for the request", () => {
    const action = { type: "cancel", cancels: [{ a: 0, o: 4242 }] }
    const intent = { method: "cancel" as const, params: { coin: "BTC", oid: 4242 } }
    passes(action, { intent, cancelTarget: { asset: 0, oid: 4242 } })
    refused(action, { intent, cancelTarget: { asset: 0, oid: 4243 } }, "does not name the order")
    refused(action, { intent, cancelTarget: { asset: 1, oid: 4242 } })
    refused(
      {
        type: "cancel",
        cancels: [
          { a: 0, o: 4242 },
          { a: 0, o: 1 },
        ],
      },
      { intent, cancelTarget: { asset: 0, oid: 4242 } },
    )
  })
})

describe("a reduce-only key never signs an open", () => {
  test("refused before any other check", () => {
    const order = { a: 0, b: true, p: "60600", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }
    const action = { type: "order", orders: [order], grouping: "na", builder: { b: BUILDER, f: 100 } }
    refused(action, {
      intent: { method: "open", params: { coin: "BTC", side: "long", size: "0.01" } },
      keyReduceOnly: true,
    })
  })
})

describe("percentage close sizing (spec D, section 8)", () => {
  test("parses only 0 < pct <= 100 with at most four decimals", () => {
    expect(hyperliquidClosePct("25")).toBe(250_000n)
    expect(hyperliquidClosePct("100")).toBe(1_000_000n)
    expect(hyperliquidClosePct("0.0001")).toBe(1n)
    for (const bad of ["0", "0.0000", "-1", "100.0001", "101", "1e2", "12.12345", "", " 5", "05", "NaN"])
      expect([bad, hyperliquidClosePct(bad)]).toEqual([bad, null])
    expect(hyperliquidClosePct(25)).toBeNull()
  })

  test("floors to the size step; 100% is the held size itself; never rounds up", () => {
    expect(hyperliquidPctSize("1.234", 250_000n, 3)).toBe("0.308")
    expect(hyperliquidPctSize("1.234", 1_000_000n, 3)).toBe("1.234")
    expect(hyperliquidPctSize("2.5", 333_333n, 3)).toBe("0.833")
    expect(hyperliquidPctSize("0.003", 100_000n, 3)).toBe("0")
    expect(hyperliquidPctSize("123456789.12345", 500_000n, 5)).toBe("61728394.56172")
    expect(hyperliquidFloorSize("0.99999", 0)).toBe("0")
  })

  test("the client sizes a pct close from its own position read, and checks the build against it", async () => {
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const value =
        body.type === "meta"
          ? {
              universe: [
                { name: "BTC", szDecimals: 5 },
                { name: "SOL", szDecimals: 3 },
              ],
            }
          : { assetPositions: [{ position: { coin: "SOL", szi: "-1.234" } }] }
      return { ok: true, text: async () => JSON.stringify(value) }
    }
    expect(await hyperliquidCloseOrder(fetcher, "mainnet", ADDRESS, { coin: "SOL", pct: "25" })).toEqual({
      asset: 1,
      isBuy: true,
      size: "0.308",
    })
    await expect(hyperliquidCloseOrder(fetcher, "mainnet", ADDRESS, { coin: "SOL", pct: "0.01" })).rejects.toThrow(
      "rounds to zero",
    )
    await expect(
      hyperliquidCloseOrder(fetcher, "mainnet", ADDRESS, { coin: "SOL", pct: "5", size: "1" }),
    ).rejects.toThrow()
  })
})

describe("the venue's answer, per leg (spec D, section 3)", () => {
  test("confirmed only on ok with no erroring leg; err is rejected; anything else is unknown", () => {
    expect(hyperliquidExchangeOutcome({ status: "ok", response: { type: "default" } }).status).toBe("confirmed")
    expect(
      hyperliquidExchangeOutcome({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } },
      }).status,
    ).toBe("confirmed")
    const partial = hyperliquidExchangeOutcome({
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { oid: 1 } }, { error: "Reduce only order would increase position" }] },
      },
    })
    expect(partial).toMatchObject({ status: "rejected", error: "Reduce only order would increase position" })
    expect(hyperliquidExchangeOutcome({ status: "err", response: "Too many cancels scheduled today" })).toMatchObject({
      status: "rejected",
      error: "Too many cancels scheduled today",
    })
    for (const odd of [
      null,
      "ok",
      {},
      { status: "ok" },
      { status: "ok", response: { type: "order" } },
      { status: "ok", response: { data: { statuses: "x" } } },
    ])
      expect(hyperliquidExchangeOutcome(odd).status).toBe("unknown")
  })
})

describe("the wallet snapshot and the one-call venue check", () => {
  const meta = [
    {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      ],
    },
    [{ markPx: "60000" }, { markPx: "3000" }],
  ]
  const venue = (orders: unknown[], positions: unknown[] = []) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const value =
        body.type === "metaAndAssetCtxs"
          ? meta
          : body.type === "clearinghouseState"
            ? { assetPositions: positions }
            : body.type === "frontendOpenOrders"
              ? orders
              : null
      return { ok: true, text: async () => JSON.stringify(value) }
    }) as never

  const o = (over: Record<string, unknown>) => ({
    coin: "BTC",
    oid: 1,
    side: "A",
    sz: "0.1",
    limitPx: "60000",
    reduceOnly: false,
    isTrigger: false,
    orderType: "Limit",
    cloid: null,
    ...over,
  })

  test("orders sorted by asset then oid; triggers classed tp/sl; anything off the main exchange is unsupported", async () => {
    const snapshot = await hyperliquidWalletSnapshot(
      venue([
        o({ coin: "ETH", oid: 5 }),
        o({ oid: 9, isTrigger: true, orderType: "Stop Market", triggerPx: "55000", reduceOnly: true }),
        o({ oid: 3, isTrigger: true, orderType: "Take Profit Limit", triggerPx: "70000" }),
        o({ coin: "@107", oid: 2 }),
        o({ oid: 4, isTrigger: true, orderType: "Something New" }),
      ]),
      "mainnet",
      ADDRESS,
      () => NONCE,
    )
    expect(snapshot.orders.map((x) => [x.asset, x.oid, x.tpsl])).toEqual([
      [0, 3, "tp"],
      [0, 9, "sl"],
      [1, 5, null],
    ])
    expect(snapshot.unsupported).toEqual(["order @107 2", "order BTC 4 (Something New)"])
    expect(snapshot.readAt).toBe(NONCE)
  })

  test("a failed or malformed read is a refusal, never permission to trust the build", async () => {
    const action = { type: "cancel", cancels: [{ a: 0, o: 1 }] }
    const failing = (async () => ({ ok: false, status: 500, text: async () => "" })) as never
    const result = await verifyPerpsBuildAgainstVenue(build(action), {
      builder: BUILDER,
      address: ADDRESS,
      intent: { method: "cancel", params: { coin: "BTC", oid: 1 } },
      fetcher: failing,
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toContain("could not check it against Hyperliquid")
    const gone = await verifyPerpsBuildAgainstVenue(build(action), {
      builder: BUILDER,
      address: ADDRESS,
      intent: { method: "cancel", params: { coin: "BTC", oid: 1 } },
      fetcher: venue([o({ oid: 2 })]),
    })
    expect(gone.ok ? "" : gone.reason).toContain("no such open order")
    const ok = await verifyPerpsBuildAgainstVenue(build(action), {
      builder: BUILDER,
      address: ADDRESS,
      intent: { method: "cancel", params: { coin: "BTC", oid: 1 } },
      fetcher: venue([o({ oid: 1 })]),
    })
    expect(ok).toEqual({ ok: true, kind: "l1" })
  })

  test("a TP/SL attach is checked against the held size at the market's step and the mark", async () => {
    const action = {
      type: "order",
      orders: [
        {
          a: 0,
          b: false,
          p: "62700",
          s: "0.12345",
          r: true,
          t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "tp" } },
          c: NEW_CLOID,
        },
      ],
      grouping: "positionTpsl",
    }
    const position = { position: { coin: "BTC", szi: "0.12345", leverage: { type: "cross", value: 10 } } }
    const opts = {
      builder: BUILDER,
      address: ADDRESS,
      intent: { method: "tpsl" as const, params: { coin: "BTC", leg: "tp", triggerPx: "66000" } },
    }
    expect(await verifyPerpsBuildAgainstVenue(build(action), { ...opts, fetcher: venue([], [position]) })).toEqual({
      ok: true,
      kind: "l1",
    })
    const smaller = { position: { ...position.position, szi: "0.1" } }
    expect((await verifyPerpsBuildAgainstVenue(build(action), { ...opts, fetcher: venue([], [smaller]) })).ok).toBe(
      false,
    )
    expect((await verifyPerpsBuildAgainstVenue(build(action), { ...opts, fetcher: venue([], []) })).ok).toBe(false)
  })
})
