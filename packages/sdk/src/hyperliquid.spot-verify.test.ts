/**
 * BE-3771 (HM2): the client's pre-sign check for a Hyperliquid spot order or cancel, against hostile
 * builds. Each test starts from an honest build that passes, then changes one thing and expects a
 * refusal. The venue is this machine's own read, faked here from the captured mainnet fixture. The
 * same file is the CLI's (drift test), so these results hold there too.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hyperliquidActionHash,
  hyperliquidL1TypedData,
  hyperliquidSpotAsset,
  hyperliquidSpotPair,
  type PerpsBuildToVerify,
  verifyPerpsBuild,
  verifySpotBuildAgainstVenue,
} from "./hyperliquid"

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const OTHER = "0x1111111111111111111111111111111111111111"
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const NONCE = 1_790_000_000_000
const CLOID = `0x${"1".repeat(32)}`

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "hyperliquid-spot.fixture.json"), "utf8")) as {
  meta: unknown
  ctxs: unknown[]
}
const SPOT = [fixture.meta, fixture.ctxs]

function venue(orderStatus: unknown = { status: "unknownOid" }, opts: { fail?: boolean } = {}) {
  return (async (_url: string, init?: RequestInit) => {
    if (opts.fail) return { ok: false, status: 500, text: async () => "" }
    const body = JSON.parse(String(init?.body))
    const answer = body.type === "spotMetaAndAssetCtxs" ? SPOT : body.type === "orderStatus" ? orderStatus : null
    return { ok: true, text: async () => JSON.stringify(answer) }
  }) as never
}

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

const buyOrder = { a: 10_107, b: true, p: "69.488", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }
const buy = { type: "order", orders: [buyOrder], grouping: "na" }
const buyParams = { market: "HYPE/USDC", side: "buy", size: "1", type: "market" }
const sellOrder = { ...buyOrder, b: false, p: "69", t: { limit: { tif: "Gtc" } } }
const sell = { type: "order", orders: [sellOrder], grouping: "na", builder: { b: BUILDER, f: 100 } }
const sellParams = { market: "@107", side: "sell", size: "1", type: "limit", price: "69" }

async function verify(
  action: Record<string, unknown>,
  params: Record<string, unknown>,
  opts: {
    method?: "spotOrder" | "spotCancel"
    over?: Partial<PerpsBuildToVerify>
    reduceOnly?: boolean
    venue?: never
  } = {},
) {
  return verifySpotBuildAgainstVenue(build(action, opts.over), {
    builder: BUILDER,
    address: ADDRESS,
    intent: { method: opts.method ?? "spotOrder", params },
    keyReduceOnly: opts.reduceOnly,
    fetcher: opts.venue ?? venue(),
  })
}

async function refused(
  action: Record<string, unknown>,
  params: Record<string, unknown>,
  reason: string,
  opts: Parameters<typeof verify>[2] = {},
) {
  const result = await verify(action, params, opts)
  expect(result.ok).toBe(false)
  expect(result.ok ? "" : result.reason).toContain(reason)
}

describe("spot order", () => {
  test("an honest market buy (no builder) and limit sell (Candle's builder) pass", async () => {
    expect(await verify(buy, buyParams)).toEqual({ ok: true, kind: "l1" })
    expect(await verify(sell, sellParams)).toEqual({ ok: true, kind: "l1" })
  })

  test("refuses another pair's asset, and a perps asset", async () => {
    await refused({ ...buy, orders: [{ ...buyOrder, a: 10_142 }] }, buyParams, "not the requested pair's")
    await refused({ ...buy, orders: [{ ...buyOrder, a: 150 }] }, buyParams, "not a Hyperliquid spot market")
    await refused({ ...buy, orders: [{ ...buyOrder, a: 10_150 }] }, buyParams, "not the requested pair's")
  })

  test("refuses a pair quoted in anything but USDC, and an unknown pair", async () => {
    const usdt = { ...buy, orders: [{ ...buyOrder, a: 10_207 }] }
    await refused(usdt, { ...buyParams, market: "HYPE/USDT0" }, "not quoted in USDC")
    await refused(buy, { ...buyParams, market: "NOPE/USDC" }, "no such spot pair")
  })

  test("refuses a side, size, reduce flag, tif, price or client id the request did not ask for", async () => {
    await refused({ ...buy, orders: [{ ...buyOrder, b: false }] }, buyParams, "side, size")
    await refused({ ...buy, orders: [{ ...buyOrder, s: "2" }] }, buyParams, "side, size")
    await refused({ ...buy, orders: [{ ...buyOrder, r: true }] }, buyParams, "side, size")
    await refused({ ...buy, orders: [{ ...buyOrder, t: { limit: { tif: "Gtc" } } }] }, buyParams, "time in force")
    await refused({ ...sell, orders: [{ ...sellOrder, p: "68" }] }, sellParams, "price does not match")
    await refused(buy, { ...buyParams, clientId: `0x${"2".repeat(32)}` }, "client order id")
  })

  test("refuses a market order priced beyond its slippage of the venue's mid", async () => {
    await refused({ ...buy, orders: [{ ...buyOrder, p: "75" }] }, buyParams, "outside its slippage")
  })

  test("refuses a builder field on a buy, and anyone but Candle's builder or above 0.1% on a sell", async () => {
    await refused({ ...buy, builder: { b: BUILDER, f: 100 } }, buyParams, "no builder field")
    await refused({ ...sell, builder: { b: OTHER, f: 100 } }, sellParams, "not Candle's")
    await refused({ ...sell, builder: { b: BUILDER, f: 101 } }, sellParams, "0.1% maximum")
  })

  test("refuses an extra order, a grouping, a vault or a hidden field", async () => {
    await refused({ ...buy, orders: [buyOrder, buyOrder] }, buyParams, "exactly one order")
    await refused({ ...buy, grouping: "normalTpsl" }, buyParams, "exactly one order")
    await refused({ ...buy, vaultAddress: OTHER }, buyParams, "vault")
    await refused({ ...buy, expiresAfter: 1 }, buyParams, "unexpected or missing fields")
  })

  test("a reduce-only key signs a sell, never a buy", async () => {
    await refused(buy, buyParams, "reduce-only", { reduceOnly: true })
    expect((await verify(sell, sellParams, { reduceOnly: true })).ok).toBe(true)
  })

  test("refuses typed data that does not commit to the action, another wallet or network", async () => {
    const other = { ...buy, orders: [{ ...buyOrder, s: "9" }] }
    await refused(buy, buyParams, "does not commit", {
      over: { typedData: hyperliquidL1TypedData(hyperliquidActionHash(other, NONCE), "mainnet") },
    })
    await refused(buy, buyParams, "different wallet", { over: { address: OTHER } })
    await refused(buy, buyParams, "this client trades mainnet", { over: { network: "testnet" } })
  })

  test("a failed venue read is a refusal, never permission", async () => {
    await refused(buy, buyParams, "could not check it against Hyperliquid", { venue: venue(undefined, { fail: true }) })
  })

  test("a cancel action under the order method is refused", async () => {
    await refused({ type: "cancel", cancels: [{ a: 10_107, o: 1 }] }, buyParams, "does not match the requested method")
  })
})

describe("spot cancel", () => {
  const cancel = { type: "cancel", cancels: [{ a: 10_107, o: 77 }] }
  const resting = { status: "order", order: { order: { coin: "@107", oid: 77 }, status: "open" } }

  test("an honest cancel of the order Hyperliquid shows for the cloid passes", async () => {
    expect(await verify(cancel, { cloid: CLOID }, { method: "spotCancel", venue: venue(resting) })).toEqual({
      ok: true,
      kind: "l1",
    })
  })

  test("refuses another oid or another pair's asset", async () => {
    const opts = { method: "spotCancel" as const, venue: venue(resting) }
    await refused(
      { type: "cancel", cancels: [{ a: 10_107, o: 78 }] },
      { cloid: CLOID },
      "does not name the order",
      opts,
    )
    await refused(
      { type: "cancel", cancels: [{ a: 10_142, o: 77 }] },
      { cloid: CLOID },
      "does not name the order",
      opts,
    )
  })

  test("refuses a cloid Hyperliquid does not show, and a perps order", async () => {
    await refused(cancel, { cloid: CLOID }, "no order with this cloid", { method: "spotCancel" })
    const perp = { status: "order", order: { order: { coin: "BTC", oid: 77 } } }
    await refused(cancel, { cloid: CLOID }, "not on a Hyperliquid spot pair", {
      method: "spotCancel",
      venue: venue(perp),
    })
  })

  test("refuses a perps-asset cancel and a builder field", async () => {
    const opts = { method: "spotCancel" as const, venue: venue(resting) }
    await refused({ type: "cancel", cancels: [{ a: 0, o: 77 }] }, { cloid: CLOID }, "invalid spot cancel asset", opts)
    await refused({ ...cancel, builder: { b: BUILDER, f: 1 } }, { cloid: CLOID }, "", opts)
  })
})

describe("perps checks stay closed to spot", () => {
  test("a perps open intent still refuses a spot asset", () => {
    const result = verifyPerpsBuild(build(buy), {
      builder: BUILDER,
      address: ADDRESS,
      intent: { method: "open", params: { coin: "HYPE", side: "long", size: "1" } },
    })
    expect(result.ok ? "" : result.reason).toContain("spot and outcome markets are refused")
  })

  test("spot asset range and pair resolution", () => {
    expect(hyperliquidSpotAsset(10_000)).toBe(true)
    expect(hyperliquidSpotAsset(99_999)).toBe(true)
    expect(hyperliquidSpotAsset(9_999)).toBe(false)
    expect(hyperliquidSpotAsset(110_000)).toBe(false)
    expect(hyperliquidSpotPair(SPOT, "hype/usdc")?.index).toBe(107)
    expect(hyperliquidSpotPair(SPOT, "@107")?.base).toBe("HYPE")
    expect(hyperliquidSpotPair(SPOT, "PURR/USDC")?.index).toBe(0)
    expect(hyperliquidSpotPair({}, "@107")).toBeNull()
  })
})
