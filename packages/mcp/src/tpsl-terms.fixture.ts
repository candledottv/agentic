/** Offline builder-dex TP/SL venue and Candle responses for adapter contract tests. */
import { hyperliquidActionHash, hyperliquidL1TypedData } from "./hyperliquid"

export const TPSL_TERMS = {
  dex: "xyz",
  dexName: "XYZ",
  deployer: `0x${"1".repeat(40)}`,
  oracleSource: "deployer" as const,
  oracleSetters: [`0x${"2".repeat(40)}`],
  marginMode: "isolated" as const,
  collateral: "USDC",
  feeMultiplier: "3",
  takerFeePct: "0.135",
  makerFeePct: "0.045",
  feeWarning: "xyz:TSLA charges 3x the main exchange's fee, above Candle's 2x warning line",
}

export function tpslTermsFixture(opts: {
  walletId: string
  address: string
  builder: string
  signature: string
  leg: "tp" | "sl"
  replace?: boolean
  echoHide?: boolean
}) {
  const coin = "xyz:TSLA"
  const oldCloid = `0x${"4".repeat(32)}`
  const triggerPx = opts.leg === "tp" ? "400" : "300"
  const events: string[] = []
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  let canceled = false
  let nonce = 1_790_000_000_000
  const oldOrder = {
    coin,
    oid: 77,
    cloid: oldCloid,
    side: "A",
    sz: "0.5",
    origSz: "0.5",
    limitPx: opts.leg === "tp" ? "418" : "266",
    reduceOnly: true,
    isTrigger: true,
    triggerPx: opts.leg === "tp" ? "440" : "280",
    orderType: opts.leg === "tp" ? "Take Profit Market" : "Stop Market",
  }
  const route = (url: string, body?: Record<string, unknown>) => {
    calls.push({ url, body })
    if (url.endsWith("/wallets/trading"))
      return {
        privyAppId: "app",
        scopes: ["perps:write"],
        page: [{ id: opts.walletId, address: opts.address, chain: "evm", privyWalletId: "privy-evm" }],
        isDone: true,
      }
    if (url.endsWith("/keys/self/perps-reduce-only")) return { perpsReduceOnly: false }
    if (url.includes("/perps/tpsl?"))
      return {
        coin,
        tracked: opts.replace ? [{ leg: opts.leg, oid: 77, cloid: oldCloid, triggerPx: oldOrder.triggerPx }] : [],
      }
    if (url.endsWith("/perps/tpsl")) {
      const cancel = body?.operation === "cancel"
      events.push(cancel ? "build:cancel" : "build:attach")
      const action = cancel
        ? { type: "cancel", cancels: [{ a: 110001, o: 77 }] }
        : {
            type: "order",
            orders: [
              {
                a: 110001,
                b: false,
                p: opts.leg === "tp" ? "380" : "285",
                s: "0.5",
                r: true,
                t: { trigger: { isMarket: true, triggerPx, tpsl: opts.leg } },
                c: `0x${"3".repeat(32)}`,
              },
            ],
            grouping: "positionTpsl",
            builder: { b: opts.builder, f: 100 },
          }
      nonce++
      return {
        success: true,
        perpOrderId: `perp-${nonce}`,
        network: "mainnet",
        walletId: opts.walletId,
        address: opts.address,
        nonce,
        action,
        typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, nonce), "mainnet"),
        ...(!cancel && opts.echoHide ? { hide: true } : {}),
        preview: { coin, terms: TPSL_TERMS, builderFeeTenthsBps: 100 },
      }
    }
    if (url.endsWith("/info")) {
      if (body?.type === "perpDexs")
        return [null, { name: "xyz", deployer: TPSL_TERMS.deployer, oracleUpdater: TPSL_TERMS.oracleSetters[0] }]
      // Every market/account read must address the builder dex, never the main exchange.
      if (body?.dex !== "xyz") throw new Error("missing builder dex on venue read")
      const universe = [
        { name: "xyz:XYZ", szDecimals: 3, maxLeverage: 10 },
        { name: coin, szDecimals: 3, maxLeverage: 10, marginMode: "strictIsolated" },
      ]
      if (body.type === "meta") return { universe }
      if (body.type === "metaAndAssetCtxs")
        return [
          { universe },
          [
            { markPx: "1", midPx: "1" },
            { markPx: "383", midPx: "383" },
          ],
        ]
      if (body.type === "clearinghouseState")
        return { assetPositions: [{ position: { coin, szi: "0.5", leverage: { type: "isolated", value: 5 } } }] }
      if (body.type === "frontendOpenOrders") return opts.replace && !canceled ? [oldOrder] : []
      if (body.type === "orderStatus") return { status: "order", order: { order: oldOrder } }
    }
    if (url.endsWith("/sign")) {
      events.push("sign")
      return { success: true, signature: opts.signature }
    }
    if (url.endsWith("/exchange")) {
      events.push("exchange")
      if ((body?.action as { type?: string })?.type === "cancel") {
        canceled = true
        return { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }
      }
      return { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } }
    }
    throw new Error(`unexpected ${url}`)
  }
  return { route, events, calls, triggerPx }
}
