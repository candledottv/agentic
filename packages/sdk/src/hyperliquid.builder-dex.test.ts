/**
 * BE-3755 (Hyperliquid HM1): the client's pre-sign checks for builder-deployed (HIP-3) markets.
 * Every method runs end to end through `verifyPerpsBuildAgainstVenue` against a fake venue that
 * answers with the captured mainnet `perpDexs` and xyz universe, so the asset id this client
 * resolves for itself (`100000 + perp_dex_index * 10000 + index_in_meta`, `xyz:TSLA` = 110001) is
 * what each honest build must carry, and a build naming another dex's or the main exchange's asset
 * is refused. The same file is the CLI's and the MCP server's (drift tests).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hyperliquidActionHash,
  hyperliquidL1TypedData,
  hyperliquidPerpAsset,
  type PerpsBuildToVerify,
  type PerpsIntentMethod,
  verifyPerpsBuildAgainstVenue,
} from "./hyperliquid"
import { perpsTpslParamsProblem } from "./hyperliquid-manage"

const CAPTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__/hyperliquid-markets/builder-dex.json"), "utf8"),
) as { perpDexs: unknown; metaAndAssetCtxs: Record<string, [Record<string, unknown>, unknown[]]> }

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const NONCE = 1_790_000_000_000
const CLOID = `0x${"1".repeat(32)}`
const NEW_CLOID = `0x${"2".repeat(32)}`
const TSLA = 110001

/** A venue holding a long 0.5 xyz:TSLA (isolated) and one resting xyz:TSLA bid, oid 77. */
function venue(opts: { mainState?: boolean } = {}) {
  const bodies: Record<string, unknown>[] = []
  const position = {
    coin: "xyz:TSLA",
    szi: "0.5",
    leverage: { type: "isolated", value: 5 },
    entryPx: "380",
    positionValue: "191",
    unrealizedPnl: "1",
    liquidationPx: "300",
    marginUsed: "38",
  }
  const resting = {
    coin: "xyz:TSLA",
    side: "B",
    limitPx: "380",
    sz: "0.1",
    origSz: "0.1",
    oid: 77,
    cloid: CLOID,
    reduceOnly: false,
    orderType: "Limit",
    tif: "Gtc",
    isTrigger: false,
    triggerPx: "0.0",
    timestamp: NONCE,
  }
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const xyz = body.dex === "xyz"
    let value: unknown
    switch (body.type) {
      case "perpDexs":
        value = CAPTURE.perpDexs
        break
      case "meta":
        value = xyz
          ? CAPTURE.metaAndAssetCtxs.xyz?.[0]
          : { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }
        break
      case "metaAndAssetCtxs":
        value = xyz
          ? CAPTURE.metaAndAssetCtxs.xyz
          : [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: "60000", midPx: "60000" }]]
        break
      case "clearinghouseState":
        value = {
          marginSummary: { accountValue: "100", totalNtlPos: "0", totalRawUsd: "100", totalMarginUsed: "0" },
          withdrawable: "100",
          assetPositions: xyz || opts.mainState ? [{ type: "oneWay", position }] : [],
          time: NONCE,
        }
        break
      case "frontendOpenOrders":
        value = xyz ? [resting] : []
        break
      case "orderStatus":
        value = { status: "order", order: { order: resting, status: "open", statusTimestamp: NONCE } }
        break
      case "activeAssetData":
        value = { leverage: { type: "isolated", value: 5 }, markPx: "383.35" }
        break
      default:
        return { ok: false, status: 400, text: async () => "unexpected" }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  }
  return { fetcher, bodies }
}

function build(action: Record<string, unknown>): PerpsBuildToVerify {
  return {
    network: "mainnet",
    nonce: NONCE,
    address: ADDRESS,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
  }
}

async function check(
  action: Record<string, unknown>,
  method: PerpsIntentMethod,
  params: Record<string, unknown>,
  v = venue(),
) {
  return verifyPerpsBuildAgainstVenue(build(action), {
    builder: BUILDER,
    address: ADDRESS,
    intent: { method, params },
    fetcher: v.fetcher,
    now: () => NONCE,
  })
}

const order = (over: Record<string, unknown> = {}) => ({
  a: TSLA,
  b: true,
  p: "387",
  s: "0.1",
  r: false,
  t: { limit: { tif: "Ioc" } },
  c: NEW_CLOID,
  ...over,
})
const openAction = (over: Record<string, unknown> = {}) => ({
  type: "order",
  orders: [order(over)],
  grouping: "na",
  builder: { b: BUILDER, f: 100 },
})

describe("BE-3755 builder-dex asset ids", () => {
  test("main and builder perp ids pass; spot, the unused 100000 band and outcome ids are refused", () => {
    for (const ok of [0, 9999, 110000, TSLA, 140002]) expect(hyperliquidPerpAsset(ok)).toBe(true)
    for (const bad of [-1, 10000, 10107, 99999, 100000, 109999, 100_000_000, 100_000_010, 1.5, "110001", null])
      expect(hyperliquidPerpAsset(bad)).toBe(false)
  })
})

describe("BE-3755 builder-dex execution, checked against the venue", () => {
  test("open xyz:TSLA: the honest build passes, reading xyz's own universe", async () => {
    const v = venue()
    expect(await check(openAction(), "open", { coin: "xyz:TSLA", side: "long", size: "0.1" }, v)).toEqual({
      ok: true,
      kind: "l1",
    })
    expect(v.bodies).toContainEqual({ type: "perpDexs" })
    expect(v.bodies).toContainEqual({ type: "metaAndAssetCtxs", dex: "xyz" })
  })

  test("open: another dex asset, the main exchange's index, spot and outcome ids are all refused", async () => {
    const params = { coin: "xyz:TSLA", side: "long", size: "0.1" }
    for (const a of [110002, 1, 140001])
      expect(await check(openAction({ a }), "open", params)).toMatchObject({
        ok: false,
        reason: "order asset is not the requested coin's on Hyperliquid",
      })
    for (const a of [10001, 100001, 100_000_010])
      expect(await check(openAction({ a }), "open", params)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("spot and outcome markets are refused"),
      })
    // A price far from xyz:TSLA's own mid (383.425) is refused like on the main exchange.
    expect(await check(openAction({ p: "420" }), "open", params)).toMatchObject({ ok: false })
  })

  test("close xyz:TSLA reads that dex's position and sizes the close from it", async () => {
    const v = venue()
    const close = {
      type: "order",
      orders: [order({ b: false, r: true, s: "0.5", p: "370" })],
      grouping: "na",
      builder: { b: BUILDER, f: 100 },
    }
    expect(await check(close, "close", { coin: "xyz:TSLA" }, v)).toEqual({ ok: true, kind: "l1" })
    expect(v.bodies).toContainEqual({ type: "clearinghouseState", user: ADDRESS, dex: "xyz" })
    // The kill switch refuses opens on the server; the client's close check never reads Candle's
    // config, so a close on a paused dex is checked exactly like any other (server side:
    // closingGateConfig in apps/api/src/lib/perps-gate.ts).
    expect(v.bodies.some((b) => String(b.type).includes("config"))).toBe(false)
    const wrong = { ...close, orders: [order({ a: 1, b: false, r: true, s: "0.5", p: "370" })] }
    expect(await check(wrong, "close", { coin: "xyz:TSLA" })).toMatchObject({ ok: false })
    // A main-exchange position of the same name does not satisfy a builder close.
    expect(await check(close, "close", { coin: "xyz:NVDA" })).toMatchObject({ ok: false })
  })

  test("modify a resting xyz:TSLA order: the venue's coin picks the dex", async () => {
    const modify = (a = TSLA) => ({
      type: "modify",
      oid: 77,
      order: { a, b: true, p: "381", s: "0.1", r: false, t: { limit: { tif: "Gtc" } }, c: CLOID },
    })
    expect(await check(modify(), "modify", { cloid: CLOID, price: "381" })).toEqual({ ok: true, kind: "l1" })
    expect(await check(modify(1), "modify", { cloid: CLOID, price: "381" })).toMatchObject({ ok: false })
  })

  test("cancel by cloid and by oid resolve the builder asset", async () => {
    const cancel = (a: number) => ({ type: "cancel", cancels: [{ a, o: 77 }] })
    expect(await check(cancel(TSLA), "cancel", { cloid: CLOID })).toEqual({ ok: true, kind: "l1" })
    expect(await check(cancel(1), "cancel", { cloid: CLOID })).toMatchObject({ ok: false })
    const v = venue()
    expect(await check(cancel(TSLA), "cancel", { coin: "xyz:TSLA", oid: 77 }, v)).toEqual({ ok: true, kind: "l1" })
    expect(v.bodies).toContainEqual({ type: "frontendOpenOrders", user: ADDRESS, dex: "xyz" })
    expect(await check(cancel(110002), "cancel", { coin: "xyz:TSLA", oid: 77 })).toMatchObject({ ok: false })
  })

  test("leverage and isolated margin name the builder asset", async () => {
    const lev = (asset: number) => ({ type: "updateLeverage", asset, isCross: false, leverage: 3 })
    expect(await check(lev(TSLA), "leverage", { coin: "xyz:TSLA", leverage: 3, mode: "isolated" })).toEqual({
      ok: true,
      kind: "l1",
    })
    expect(await check(lev(1), "leverage", { coin: "xyz:TSLA", leverage: 3, mode: "isolated" })).toMatchObject({
      ok: false,
    })
    const margin = (asset: number) => ({ type: "updateIsolatedMargin", asset, isBuy: true, ntli: 5_000_000 })
    expect(await check(margin(TSLA), "margin", { coin: "xyz:TSLA", amount: "5" })).toEqual({ ok: true, kind: "l1" })
    expect(await check(margin(1), "margin", { coin: "xyz:TSLA", amount: "5" })).toMatchObject({ ok: false })
  })

  test("TP/SL on xyz:TSLA: the name is accepted and the leg is sized from that dex's position", async () => {
    expect(perpsTpslParamsProblem({ coin: "xyz:TSLA", takeProfit: "400" })).toBeNull()
    expect(perpsTpslParamsProblem({ coin: "xyz:", takeProfit: "400" })).not.toBeNull()
    expect(perpsTpslParamsProblem({ coin: "@107", takeProfit: "400" })).not.toBeNull()
    const leg = (a: number) => ({
      type: "order",
      orders: [
        {
          a,
          b: false,
          p: "380",
          s: "0.5",
          r: true,
          t: { trigger: { isMarket: true, triggerPx: "400", tpsl: "tp" } },
          c: NEW_CLOID,
        },
      ],
      grouping: "positionTpsl",
      builder: { b: BUILDER, f: 100 },
    })
    const params = { coin: "xyz:TSLA", leg: "tp", triggerPx: "400" }
    expect(await check(leg(TSLA), "tpsl", params)).toEqual({ ok: true, kind: "l1" })
    expect(await check(leg(1), "tpsl", params)).toMatchObject({ ok: false })
  })

  test("an unknown builder dex is a refusal, never a main-exchange fallback", async () => {
    expect(await check(openAction(), "open", { coin: "nope:TSLA", side: "long", size: "0.1" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no builder dex nope"),
    })
  })
})
