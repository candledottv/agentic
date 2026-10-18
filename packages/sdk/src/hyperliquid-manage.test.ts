/**
 * BE-1584 (spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md, sections 6, 8 and 11):
 * the TP/SL and flatten plans against a simulated Hyperliquid that applies what is submitted, and a
 * fake Candle that builds honest steps from that venue's state. Failures are injected per step: a
 * build refusal, a venue rejection, a submit that never answers, a rate limit, a failed read.
 */
import { describe, expect, test } from "bun:test"
import { hyperliquidActionHash, hyperliquidL1TypedData } from "./hyperliquid"
import {
  PERPS_FLATTEN_MAX_STEPS,
  PerpsWorkflowError,
  type PerpsWorkflowIo,
  runPerpsFlatten,
  runPerpsTpsl,
} from "./hyperliquid-manage"

const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
const UNIVERSE = [
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
]
const MARKS = ["60000", "3000"]

interface VenueOrder {
  coin: string
  oid: number
  cloid: string | null
  side: "A" | "B"
  sz: string
  limitPx: string
  reduceOnly: boolean
  isTrigger: boolean
  triggerPx?: string
  orderType: string
}

type Fault =
  | { kind: "buildRefused"; code: string }
  | { kind: "venueRejects"; error: string }
  | { kind: "noAnswer" }
  | { kind: "rateLimited" }
  | { kind: "partialFill"; filled: string }
  | { kind: "ackButStays" }

function world() {
  const positions = new Map<string, string>()
  let orders: VenueOrder[] = []
  const candleCloids = new Set<string>()
  const faults = new Map<number, Fault>()
  const builds: { path: string; body: Record<string, unknown> }[] = []
  const submitted: Record<string, unknown>[] = []
  let readFails = 0
  let nonce = 1_790_000_000_000
  let counter = 0
  let nextOid = 1000
  const cloid = () => `0x${(++counter).toString(16).padStart(32, "0")}`

  const json = (value: unknown, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(value) })
  const assetOf = (coin: string) => UNIVERSE.findIndex((m) => m.name === coin)
  let buildCount = 0

  const fetcher = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (url.endsWith("/info")) {
      if (readFails > 0 && body.type !== "meta") {
        readFails--
        return json({}, false, 500)
      }
      if (body.type === "metaAndAssetCtxs") return json([{ universe: UNIVERSE }, MARKS.map((markPx) => ({ markPx }))])
      if (body.type === "meta") return json({ universe: UNIVERSE })
      if (body.type === "clearinghouseState")
        return json({
          assetPositions: [...positions].map(([coin, szi]) => ({
            position: { coin, szi, leverage: { type: "cross", value: 10 } },
          })),
        })
      if (body.type === "frontendOpenOrders") return json(orders)
      throw new Error(`unexpected info ${body.type}`)
    }
    // /exchange: apply the action, or the injected fault.
    const action = body.action as Record<string, unknown>
    submitted.push(action)
    const fault = faults.get(submitted.length)
    if (fault?.kind === "noAnswer") throw new Error("socket hang up")
    if (fault?.kind === "rateLimited") return json({}, false, 429)
    if (fault?.kind === "venueRejects") return json({ status: "err", response: fault.error })
    if (action.type === "cancel") {
      const target = (action.cancels as { o: number }[])[0]?.o
      if (fault?.kind !== "ackButStays") orders = orders.filter((o) => o.oid !== target)
      return json({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } })
    }
    const order = (action.orders as Record<string, unknown>[])[0] as Record<string, unknown>
    const coin = UNIVERSE[Number(order.a)]?.name as string
    if ("trigger" in (order.t as object)) {
      const trigger = (order.t as { trigger: { triggerPx: string; tpsl: string } }).trigger
      orders.push({
        coin,
        oid: nextOid++,
        cloid: String(order.c),
        side: order.b ? "B" : "A",
        sz: String(order.s),
        limitPx: String(order.p),
        reduceOnly: true,
        isTrigger: true,
        triggerPx: trigger.triggerPx,
        orderType: trigger.tpsl === "tp" ? "Take Profit Market" : "Stop Market",
      })
      return json({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } })
    }
    const held = positions.get(coin) ?? "0"
    const filled = fault?.kind === "partialFill" ? fault.filled : String(order.s)
    const left = Math.abs(Number(held)) - Number(filled)
    if (left <= 0) positions.delete(coin)
    else positions.set(coin, `${held.startsWith("-") ? "-" : ""}${left}`)
    return json({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: filled, avgPx: "1", oid: 1 } }] } },
    })
  }

  function stamp(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    nonce++
    return {
      success: true,
      perpOrderId: `perp-${nonce}`,
      walletId: "wallet",
      address: ADDRESS,
      network: "mainnet",
      nonce,
      action,
      typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, nonce), "mainnet"),
      ...extra,
    }
  }

  const io: PerpsWorkflowIo = {
    network: "mainnet",
    walletId: "wallet",
    address: ADDRESS,
    builder: BUILDER,
    keyReduceOnly: false,
    fetcher: fetcher as never,
    now: () => 1_790_000_000_000,
    mode: "submit",
    cloid,
    sign: async () => SIGNATURE,
    read: async (path) => {
      const coin = new URL(`https://x${path}`).searchParams.get("coin") as string
      const legs = orders
        .filter((o) => o.coin === coin && o.isTrigger)
        .map((o) => ({
          leg: o.orderType.startsWith("Take") ? "tp" : "sl",
          oid: o.oid,
          cloid: o.cloid,
          triggerPx: o.triggerPx,
        }))
      return {
        coin,
        tracked: legs.filter((l) => l.cloid && candleCloids.has(l.cloid)),
        unowned: legs.filter((l) => !l.cloid || !candleCloids.has(l.cloid)),
      }
    },
    build: async (path, body) => {
      builds.push({ path, body })
      buildCount++
      const fault = faults.get(-buildCount)
      if (fault?.kind === "buildRefused") throw Object.assign(new Error("refused"), { code: fault.code })
      const coin = String(body.coin)
      const a = assetOf(coin)
      if (path.endsWith("/flatten/cancel") || (path.endsWith("/tpsl") && body.operation === "cancel")) {
        const target =
          body.oid !== undefined
            ? orders.find((o) => o.oid === body.oid)
            : orders.find((o) => o.cloid === body.targetCloid)
        if (!target) throw Object.assign(new Error("not open"), { code: "PERPS_ORDER_NOT_OPEN" })
        return stamp({ type: "cancel", cancels: [{ a, o: target.oid }] })
      }
      const szi = positions.get(coin) ?? "0"
      const short = szi.startsWith("-")
      const held = szi.replace(/^-/, "")
      if (path.endsWith("/tpsl")) {
        const id = cloid()
        candleCloids.add(id)
        const tp = body.leg === "tp"
        const triggerPx = String(body.triggerPx)
        const px = String(Math.round(Number(triggerPx) * (short ? 1.05 : 0.95)))
        return stamp(
          {
            type: "order",
            orders: [
              {
                a,
                b: short,
                p: px,
                s: held,
                r: true,
                t: { trigger: { isMarket: true, triggerPx, tpsl: tp ? "tp" : "sl" } },
                c: id,
              },
            ],
            grouping: "positionTpsl",
            builder: { b: BUILDER, f: 100 },
          },
          { cloid: id },
        )
      }
      // A full close.
      const id = String(body.clientId)
      return stamp(
        {
          type: "order",
          orders: [
            { a, b: short, p: short ? "63000" : "57000", s: held, r: true, t: { limit: { tif: "Ioc" } }, c: id },
          ],
          grouping: "na",
          builder: { b: BUILDER, f: 100 },
        },
        { cloid: id, clientId: id },
      )
    },
  }

  return {
    io,
    positions,
    get orders() {
      return orders
    },
    set orders(value: VenueOrder[]) {
      orders = value
    },
    candleCloids,
    /** Fault on the n-th submit (1-based), or on the n-th build when n is negative. */
    fault: (n: number, f: Fault) => faults.set(n, f),
    failReads: (n: number) => {
      readFails = n
    },
    builds,
    submitted,
  }
}

function leg(
  w: ReturnType<typeof world>,
  coin: string,
  tpsl: "tp" | "sl",
  triggerPx: string,
  candle = true,
): VenueOrder {
  const cloid = candle ? `0x${"c".repeat(31)}${w.orders.length}` : null
  if (cloid) w.candleCloids.add(cloid)
  const order: VenueOrder = {
    coin,
    oid: 500 + w.orders.length,
    cloid,
    side: "A",
    sz: w.positions.get(coin)?.replace(/^-/, "") ?? "0.1",
    limitPx: triggerPx,
    reduceOnly: true,
    isTrigger: true,
    triggerPx,
    orderType: tpsl === "tp" ? "Take Profit Market" : "Stop Market",
  }
  w.orders = [...w.orders, order]
  return order
}

describe("TP/SL plans", () => {
  test("attach a new take-profit: one positionTpsl leg, sized to the position", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "66000" })
    expect(result.complete).toBe(true)
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([["attach", "confirmed"]])
    expect(w.orders).toHaveLength(1)
    expect(w.orders[0]).toMatchObject({ coin: "BTC", sz: "0.5", triggerPx: "66000", orderType: "Take Profit Market" })
  })

  test("a change cancels the old leg, sees it gone, then attaches; the gap is warned", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    const old = leg(w, "BTC", "sl", "55000")
    const result = await runPerpsTpsl(w.io, { coin: "BTC", stopLoss: "56000" })
    expect(result.complete).toBe(true)
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["cancel", "confirmed"],
      ["attach", "confirmed"],
    ])
    expect(w.orders.map((o) => o.oid)).not.toContain(old.oid)
    expect(w.orders.map((o) => o.triggerPx)).toEqual(["56000"])
    expect(result.warnings.join(" ")).toContain("unprotected")
  })

  test("a cancel the venue rejects places no replacement", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    w.fault(1, { kind: "venueRejects", error: "Order was never placed" })
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "67000" })
    expect(result.complete).toBe(false)
    expect(result.steps.map((s) => s.status)).toEqual(["rejected", "planned"])
    expect(w.submitted).toHaveLength(1)
  })

  test("an accepted cancel the venue still shows open is unknown, and nothing replaces it", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    w.fault(1, { kind: "ackButStays" })
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "67000" })
    expect(result.steps.map((s) => s.status)).toEqual(["unknown", "planned"])
    expect(w.submitted).toHaveLength(1)
  })

  test("a replacement that fails leaves the old leg canceled and the result incomplete, never claiming protection", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    w.fault(2, { kind: "venueRejects", error: "Insufficient margin" })
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "67000" })
    expect(result.complete).toBe(false)
    expect(result.steps.map((s) => s.status)).toEqual(["confirmed", "rejected"])
    expect(result.remaining).toContainEqual({ leg: "tp", coin: "BTC", state: "old leg canceled, no new leg in place" })
    expect(w.orders).toHaveLength(0)
  })

  test("TP succeeds and SL fails: a partial result, not success", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.fault(2, { kind: "venueRejects", error: "Trigger crossed" })
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "66000", stopLoss: "55000" })
    expect(result.complete).toBe(false)
    expect(result.steps.map((s) => [s.leg, s.status])).toEqual([
      ["tp", "confirmed"],
      ["sl", "rejected"],
    ])
  })

  test("several matching tracked legs refuse before anything is signed; an explicit target resolves it", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "sl", "55000")
    const second = leg(w, "BTC", "sl", "54000")
    await expect(runPerpsTpsl(w.io, { coin: "BTC", removeSl: true })).rejects.toMatchObject({
      code: "PERPS_TPSL_CONFLICT",
    })
    expect(w.builds).toHaveLength(0)
    const result = await runPerpsTpsl(w.io, { coin: "BTC", removeSl: true, targetSl: second.cloid as string })
    expect(result.complete).toBe(true)
    expect(w.orders.map((o) => o.oid)).not.toContain(second.oid)
    expect(w.orders).toHaveLength(1)
  })

  test("protection Candle did not build is listed as unowned and never touched", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    const foreign = leg(w, "BTC", "tp", "70000", false)
    const result = await runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "66000" })
    expect(result.unowned).toEqual([{ leg: "tp", oid: foreign.oid, cloid: null, triggerPx: "70000" }])
    expect(w.orders.map((o) => o.oid)).toContain(foreign.oid)
    expect(w.submitted.some((a) => a.type === "cancel")).toBe(false)
  })

  test("removing a leg leaves the other; an omitted flag never clears; a leg already in place is skipped", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    leg(w, "BTC", "sl", "55000")
    const removed = await runPerpsTpsl(w.io, { coin: "BTC", removeTp: true })
    expect(removed.complete).toBe(true)
    expect(w.orders.map((o) => o.orderType)).toEqual(["Stop Market"])
    const same = await runPerpsTpsl(w.io, { coin: "BTC", stopLoss: "55000.0" })
    expect(same.steps).toEqual([
      expect.objectContaining({ status: "skipped", detail: "Already in place at this trigger" }),
    ])
  })

  test("no position: a set is refused before anything is built", async () => {
    const w = world()
    await expect(runPerpsTpsl(w.io, { coin: "BTC", takeProfit: "66000" })).rejects.toBeInstanceOf(PerpsWorkflowError)
    expect(w.builds).toHaveLength(0)
  })

  test("--no-submit builds and checks the first step only; nothing is signed or sent", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    const result = await runPerpsTpsl({ ...w.io, mode: "no-submit" }, { coin: "BTC", takeProfit: "67000" })
    expect(result.steps.map((s) => s.status)).toEqual(["built", "planned"])
    expect(result.complete).toBe(false)
    expect(w.submitted).toHaveLength(0)
  })

  test("--sign-only signs the first step and returns its body; the rest stays planned", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    const result = await runPerpsTpsl({ ...w.io, mode: "sign-only" }, { coin: "BTC", takeProfit: "67000" })
    expect(result.steps[0]).toMatchObject({ status: "built", signature: SIGNATURE })
    expect(result.steps[0]?.exchangeBody).toBeDefined()
    expect(result.steps[1]?.status).toBe("planned")
    expect(w.submitted).toHaveLength(0)
  })

  test("a declined confirmation signs nothing", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    await expect(
      runPerpsTpsl({ ...w.io, confirm: async () => false }, { coin: "BTC", takeProfit: "66000" }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    })
    expect(w.builds).toHaveLength(0)
  })

  test("a hostile build (a leg on the wrong side) is refused before the relay", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    const honest = w.io.build
    let signed = 0
    const io: PerpsWorkflowIo = {
      ...w.io,
      sign: async () => {
        signed++
        return SIGNATURE
      },
      build: async (path, body) => {
        const b = (await honest(path, body)) as Record<string, unknown>
        const action = b.action as { orders: Record<string, unknown>[] }
        const mutated = { ...action, orders: [{ ...action.orders[0], b: true }] }
        return {
          ...b,
          action: mutated,
          typedData: hyperliquidL1TypedData(hyperliquidActionHash(mutated, b.nonce as number), "mainnet"),
        }
      },
    }
    const result = await runPerpsTpsl(io, { coin: "BTC", takeProfit: "66000" })
    expect(result.steps[0]?.status).toBe("rejected")
    expect(result.steps[0]?.detail).toContain("Refused to sign")
    expect(signed).toBe(0)
  })
})

describe("flatten", () => {
  test("cancels every order (triggers and external ones included) before closing, then reads flat", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.positions.set("ETH", "-2")
    leg(w, "BTC", "sl", "55000")
    w.orders = [
      ...w.orders,
      {
        coin: "ETH",
        oid: 7,
        cloid: null,
        side: "B",
        sz: "1",
        limitPx: "2900",
        reduceOnly: false,
        isTrigger: false,
        orderType: "Limit",
      },
    ]
    const result = await runPerpsFlatten(w.io)
    expect(result.complete).toBe(true)
    expect(result.scope).toBe("main-perps")
    expect(result.steps.map((s) => [s.kind, s.coin, s.status])).toEqual([
      ["cancel", "BTC", "confirmed"],
      ["cancel", "ETH", "confirmed"],
      ["close", "BTC", "confirmed"],
      ["close", "ETH", "confirmed"],
    ])
    expect(w.submitted.map((a) => a.type)).toEqual(["cancel", "cancel", "order", "order"])
    expect(w.positions.size).toBe(0)
    expect(w.orders).toHaveLength(0)
    // Each close carries its own client id, generated once for this run.
    const ids = w.builds.filter((b) => b.path.endsWith("/close")).map((b) => b.body.clientId)
    expect(new Set(ids).size).toBe(2)
  })

  test("an empty wallet is complete with no step", async () => {
    const result = await runPerpsFlatten(world().io)
    expect(result).toMatchObject({ complete: true, steps: [] })
  })

  test("a failed cancel stops before any close (it could still add exposure)", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    w.fault(1, { kind: "venueRejects", error: "x" })
    const result = await runPerpsFlatten(w.io)
    expect(result.complete).toBe(false)
    expect(result.steps.map((s) => s.status)).toEqual(["rejected", "planned"])
    expect(w.submitted).toHaveLength(1)
  })

  test("a cancel whose target already went is skipped, not a failure", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    w.fault(-1, { kind: "buildRefused", code: "PERPS_ORDER_NOT_OPEN" })
    const result = await runPerpsFlatten(w.io)
    expect(result.steps.map((s) => s.status)).toEqual(["skipped", "confirmed"])
  })

  test("a known close rejection continues with the other closes, then reports incomplete", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.positions.set("ETH", "1")
    w.fault(1, { kind: "venueRejects", error: "Order could not immediately match" })
    const result = await runPerpsFlatten(w.io)
    expect(result.steps.map((s) => s.status)).toEqual(["rejected", "confirmed"])
    expect(result.complete).toBe(false)
    expect(result.remaining).toContainEqual({ kind: "position", coin: "BTC", szi: "0.5" })
  })

  test("an unknown submit stops, keeping the signed body; nothing is broadcast again", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.positions.set("ETH", "1")
    w.fault(1, { kind: "noAnswer" })
    const result = await runPerpsFlatten(w.io)
    expect(result.steps[0]).toMatchObject({ status: "unknown" })
    expect(result.steps[0]?.exchangeBody).toBeDefined()
    expect(result.steps[1]?.status).toBe("planned")
    expect(w.submitted).toHaveLength(1)
  })

  test("a rate limit stops", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.positions.set("ETH", "1")
    w.fault(1, { kind: "rateLimited" })
    const result = await runPerpsFlatten(w.io)
    expect(result.steps.map((s) => s.status)).toEqual(["unknown", "planned"])
    expect(result.steps[0]?.detail).toContain("rate limited")
  })

  test("a partial fill reports filled and remaining, and never becomes success", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.fault(1, { kind: "partialFill", filled: "0.2" })
    const result = await runPerpsFlatten(w.io)
    expect(result.steps[0]).toMatchObject({
      status: "confirmed",
      filledSz: "0.2",
      remainingSz: "0.5 planned, 0.2 filled",
    })
    expect(result.complete).toBe(false)
  })

  test("a failed final read is never success", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    const io: PerpsWorkflowIo = {
      ...w.io,
      sign: async () => {
        // After the close is signed: the before-close read is done; fail the final one.
        w.failReads(10)
        return SIGNATURE
      },
    }
    const result = await runPerpsFlatten(io)
    expect(result.steps[0]?.status).toBe("confirmed")
    expect(result.complete).toBe(false)
    expect(result.warnings.join(" ")).toContain("final read failed")
  })

  test("rows off the main perp exchange refuse the whole plan before anything is built", async () => {
    const w = world()
    w.orders = [
      {
        coin: "@107",
        oid: 1,
        cloid: null,
        side: "B",
        sz: "1",
        limitPx: "1",
        reduceOnly: false,
        isTrigger: false,
        orderType: "Limit",
      },
    ]
    await expect(runPerpsFlatten(w.io)).rejects.toMatchObject({ code: "PERPS_MARKET_REFUSED" })
    expect(w.builds).toHaveLength(0)
  })

  test(`at most ${PERPS_FLATTEN_MAX_STEPS} signed steps a run; the rest is remaining`, async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    w.orders = Array.from({ length: PERPS_FLATTEN_MAX_STEPS + 5 }, (_, i) => ({
      coin: "BTC",
      oid: 10_000 + i,
      cloid: null,
      side: "B" as const,
      sz: "0.001",
      limitPx: "50000",
      reduceOnly: false,
      isTrigger: false,
      orderType: "Limit",
    }))
    const result = await runPerpsFlatten(w.io)
    expect(w.submitted).toHaveLength(PERPS_FLATTEN_MAX_STEPS)
    expect(result.complete).toBe(false)
    expect(result.remaining.filter((r) => r.kind === "cancel")).toHaveLength(5)
    expect(result.remaining).toContainEqual(expect.objectContaining({ kind: "close", coin: "BTC" }))
    expect(result.warnings.join(" ")).toContain("at most 100")
  })

  test("--no-submit builds and checks the first step only", async () => {
    const w = world()
    w.positions.set("BTC", "0.5")
    leg(w, "BTC", "tp", "66000")
    const result = await runPerpsFlatten({ ...w.io, mode: "no-submit" })
    expect(result.steps.map((s) => s.status)).toEqual(["built", "planned"])
    expect(w.builds).toHaveLength(1)
    expect(w.submitted).toHaveLength(0)
  })
})
