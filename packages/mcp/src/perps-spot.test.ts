/**
 * BE-4217 (BE-4165 slice 03, BE-3771 HM2): the four `candle_perps_spot_*` tools. Every order and
 * cancel is checked against this server's own `spotMetaAndAssetCtxs` read
 * (`verifySpotBuildAgainstVenue`) before the relay is asked to sign; a refused build makes no relay
 * call and no submit. Spot never uses the embedded wallet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { hyperliquidActionHash, hyperliquidL1TypedData } from "./hyperliquid"
import type { FetchLike } from "./orchestrate"
import { executePerps, PERPS_SPOT_TOOL_NAMES, perpsShapes } from "./perps"
import { TOOL_NAMES } from "./tools"

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
const NONCE = 1_790_000_000_000
const CLOID = `0x${"1".repeat(32)}`
const INFO = "https://api.hyperliquid.xyz/info"
const EXCHANGE = "https://api.hyperliquid.xyz/exchange"
const ORDER_PATH = "/api/v1/agent/perps/spot/order"
const CANCEL_PATH = "/api/v1/agent/perps/spot/cancel"
const cfg = { apiUrl: "https://api.test", apiKey: "cndl_live_key" }
let dir: string
let pemFile: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-mcp-spot-"))
  pemFile = join(dir, "signer.pem")
  await writeFile(pemFile, pem)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const env = () => ({ CANDLE_KEY_SIGNER_PEM_FILE: pemFile, CANDLE_HYPERLIQUID_BUILDER: BUILDER })

// A trimmed `spotMetaAndAssetCtxs`: HYPE/USDC is `@107` (asset 10107), PURR/USDC is index 0 (asset
// 10000), and `@207` is HYPE quoted in another token. The ctxs are out of order on purpose.
const SPOT = [
  {
    universe: [
      { tokens: [1, 0], name: "PURR/USDC", index: 0, isCanonical: true },
      { tokens: [150, 0], name: "@107", index: 107, isCanonical: false },
      { tokens: [150, 268], name: "@207", index: 207, isCanonical: false },
    ],
    tokens: [
      { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0 },
      { name: "PURR", szDecimals: 0, weiDecimals: 5, index: 1 },
      { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150 },
      { name: "USDH", szDecimals: 2, weiDecimals: 8, index: 268 },
    ],
  },
  [
    { coin: "@207", midPx: "69.1" },
    { coin: "@107", midPx: "69.4" },
    { coin: "PURR/USDC", midPx: "0.2" },
  ],
]

function spotBuild(action: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    success: true,
    perpOrderId: "perp-spot-1",
    kind: action.type === "cancel" ? "spotCancel" : "spotOrder",
    network: "mainnet",
    walletId: "wallet",
    address: ADDRESS,
    nonce: NONCE,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
    claimHash: "h",
    cloid: CLOID,
    builder: null,
    preview: {
      venue: "hyperliquid-spot",
      terms: { venue: "hyperliquid-spot", takerFeePct: "0.07", makerFeePct: "0.04", builderFeeSide: "sell" },
      builderFee: { address: null, feeTenthsBps: 0, feePct: "0", reason: "not charged on spot buys" },
    },
    ...over,
  }
}

const buyOrder = { a: 10_107, b: true, p: "70", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }
const buyAction = { type: "order", orders: [buyOrder], grouping: "na" }
const sellOrder = { ...buyOrder, b: false, p: "69", t: { limit: { tif: "Gtc" } } }
const sellAction = { type: "order", orders: [sellOrder], grouping: "na", builder: { b: BUILDER, f: 100 } }
const cancelAction = { type: "cancel", cancels: [{ a: 10_107, o: 77 }] }
const BUY = { pair: "HYPE/USDC", side: "buy", size: "1" }
const SELL = { pair: "@107", side: "sell", size: "1", price: "69" }

function fake(
  opts: { build?: unknown; tee?: boolean; resting?: Record<string, unknown>; reads?: Record<string, unknown> } = {},
) {
  const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method, body })
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
    if (url === INFO) {
      if (body?.type === "spotMetaAndAssetCtxs") return ok(SPOT)
      if (body?.type === "orderStatus")
        return ok(
          opts.resting ? { status: "order", order: { order: opts.resting } } : { status: "unknownOid", order: null },
        )
      throw new Error(`unexpected info read ${body?.type}`)
    }
    if (url === EXCHANGE)
      return ok({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 77 } }] } } })
    if (url === "https://api.test/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["perps:write"],
        privyAppId: "app",
        page:
          opts.tee === false
            ? []
            : [{ id: "wallet", address: ADDRESS, chain: "evm", privyWalletId: "privy-evm", label: "perps" }],
        isDone: true,
      })
    if (url === "https://api.test/api/v1/agent/wallets/embedded")
      return ok({ wallets: { evm: { address: ADDRESS } }, embeddedWalletPermission: "allowed" })
    if (url.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    const path = url.replace("https://api.test", "").split("?")[0] as string
    if (opts.reads && path in opts.reads) return ok(opts.reads[path])
    if (path === ORDER_PATH || path === CANCEL_PATH) return ok(opts.build ?? spotBuild(buyAction))
    throw new Error(`unexpected ${url}`)
  }
  return {
    calls,
    fetch,
    signed: () => calls.some((c) => c.url.endsWith("/sign")),
    submitted: () => calls.some((c) => c.url === EXCHANGE),
    built: () => calls.find((c) => c.url.endsWith(ORDER_PATH) || c.url.endsWith(CANCEL_PATH)),
  }
}

const parsed = (result: { text: string }) => JSON.parse(result.text)

describe("BE-4217 spot tools: registration", () => {
  test("the four spot tools are in TOOL_NAMES and in the perps executor's list", () => {
    for (const name of PERPS_SPOT_TOOL_NAMES) expect(TOOL_NAMES as readonly string[]).toContain(name)
    expect([...PERPS_SPOT_TOOL_NAMES]).toEqual([
      "candle_perps_spot_markets",
      "candle_perps_spot_balances",
      "candle_perps_spot_order",
      "candle_perps_spot_cancel",
    ])
  })
})

describe("BE-4217 spot tools: schema refusals", () => {
  const order = z.object(perpsShapes.candle_perps_spot_order)
  test("a good buy and a good sell parse", () => {
    expect(order.safeParse(BUY).success).toBe(true)
    expect(order.safeParse({ ...SELL, tif: "Alo", slippageBps: 50, clientId: CLOID, hide: true }).success).toBe(true)
  })
  test("a bad pair is refused", () => {
    for (const pair of ["HYPE-USDC", "HYPE", "@01", "@1234567", "HYPE/USDC/X", "", "BTC/"])
      expect(order.safeParse({ ...BUY, pair }).success).toBe(false)
  })
  test("a bad size is refused", () => {
    for (const size of ["-1", "1e3", "01", "1.", "", "abc", "0x10"])
      expect(order.safeParse({ ...BUY, size }).success).toBe(false)
  })
  test("a bad side, tif or clientId is refused", () => {
    expect(order.safeParse({ ...BUY, side: "long" }).success).toBe(false)
    expect(order.safeParse({ ...BUY, tif: "Fok" }).success).toBe(false)
    expect(order.safeParse({ ...BUY, clientId: "0x123" }).success).toBe(false)
  })
  test("the embedded wallet is refused by every spot schema that takes a wallet", () => {
    expect(order.safeParse({ ...BUY, wallet: "embedded" }).success).toBe(false)
    expect(z.object(perpsShapes.candle_perps_spot_balances).safeParse({ wallet: "embedded" }).success).toBe(false)
    expect(z.object(perpsShapes.candle_perps_spot_cancel).safeParse({ cloid: CLOID, wallet: "embedded" }).success).toBe(
      false,
    )
    expect(order.safeParse({ ...BUY, wallet: "perps" }).success).toBe(true)
  })
  test("a cancel needs a 0x + 32 hex cloid", () => {
    const cancel = z.object(perpsShapes.candle_perps_spot_cancel)
    expect(cancel.safeParse({ cloid: CLOID }).success).toBe(true)
    expect(cancel.safeParse({ cloid: "0x1" }).success).toBe(false)
  })
})

describe("BE-4217 spot tools: the embedded wallet and missing pieces refuse before any request", () => {
  for (const tool of ["candle_perps_spot_balances", "candle_perps_spot_order", "candle_perps_spot_cancel"] as const) {
    test(`${tool} with wallet=embedded`, async () => {
      const f = fake()
      const args =
        tool === "candle_perps_spot_order" ? BUY : tool === "candle_perps_spot_cancel" ? { cloid: CLOID } : {}
      const result = await executePerps(tool, { ...args, wallet: "embedded" }, cfg, env(), f.fetch)
      expect(result.isError).toBe(true)
      expect(parsed(result).error.code).toBe("TEE_WALLET_REQUIRED")
      expect(f.calls).toEqual([])
    })
  }

  test("a key with no EVM TEE wallet never falls back to the embedded wallet for spot", async () => {
    const f = fake({ tee: false })
    const result = await executePerps("candle_perps_spot_order", BUY, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("TEE_WALLET_REQUIRED")
    expect(f.built()).toBeUndefined()
    expect(f.signed()).toBe(false)
  })

  test("no signer PEM: refused before the build", async () => {
    const f = fake()
    const result = await executePerps(
      "candle_perps_spot_order",
      BUY,
      cfg,
      { CANDLE_HYPERLIQUID_BUILDER: BUILDER },
      f.fetch,
    )
    expect(parsed(result).error.code).toBe("SIGNER_UNAVAILABLE")
    expect(f.built()).toBeUndefined()
  })

  test("tif Gtc without a price: refused before the build", async () => {
    const f = fake()
    const result = await executePerps("candle_perps_spot_order", { ...BUY, tif: "Gtc" }, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("MCP_VALIDATION")
    expect(f.calls).toEqual([])
  })
})

describe("BE-4217 spot tools: reads", () => {
  test("markets reads the spot markets route with limit and all", async () => {
    const f = fake({ reads: { "/api/v1/agent/perps/spot/markets": { success: true, markets: [] } } })
    const result = await executePerps("candle_perps_spot_markets", { limit: 5, all: true }, cfg, env(), f.fetch)
    expect(parsed(result)).toEqual({ success: true, markets: [] })
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.test/api/v1/agent/perps/spot/markets?limit=5&all=true"])
  })

  test("balances reads the TEE wallet's spot balances", async () => {
    const answer = { success: true, walletId: "wallet", balances: [{ coin: "USDC", token: 0, total: "10", hold: "0" }] }
    const f = fake({ reads: { "/api/v1/agent/perps/spot/balances": answer } })
    const result = await executePerps("candle_perps_spot_balances", {}, cfg, env(), f.fetch)
    expect(parsed(result)).toEqual(answer)
    expect(f.calls.at(-1)?.url).toBe("https://api.test/api/v1/agent/perps/spot/balances?walletId=wallet")
  })
})

describe("BE-4217 spot tools: a passing buy and sell are checked, signed and submitted", () => {
  test("a market buy by pair name", async () => {
    const f = fake({ build: spotBuild(buyAction) })
    const result = await executePerps("candle_perps_spot_order", BUY, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(parsed(result)).toMatchObject({
      success: true,
      kind: "spotOrder",
      cloid: CLOID,
      outcome: { status: "confirmed" },
    })
    expect(f.built()?.body).toEqual({ walletId: "wallet", market: "HYPE/USDC", side: "buy", size: "1", type: "market" })
    // This server's own read of the pair runs before the relay is asked to sign.
    const read = f.calls.findIndex((c) => c.url === INFO && c.body?.type === "spotMetaAndAssetCtxs")
    const sign = f.calls.findIndex((c) => c.url.endsWith("/sign"))
    expect(read).toBeGreaterThan(-1)
    expect(sign).toBeGreaterThan(read)
    expect(f.submitted()).toBe(true)
  })

  test("a limit sell by index, carrying Candle's builder fee", async () => {
    const f = fake({
      build: spotBuild(sellAction, { clientId: CLOID, builder: { address: BUILDER, feeTenthsBps: 100 } }),
    })
    const result = await executePerps("candle_perps_spot_order", { ...SELL, clientId: CLOID }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(parsed(result).success).toBe(true)
    expect(f.built()?.body).toEqual({
      walletId: "wallet",
      market: "@107",
      side: "sell",
      size: "1",
      price: "69",
      clientId: CLOID,
      type: "limit",
    })
    expect(f.signed()).toBe(true)
    expect(f.submitted()).toBe(true)
  })

  test("submit: false checks the build and stops before signing", async () => {
    const f = fake({ build: spotBuild(buyAction) })
    const result = await executePerps("candle_perps_spot_order", { ...BUY, submit: false }, cfg, env(), f.fetch)
    expect(parsed(result)).toMatchObject({ submitted: false, signed: false })
    expect(parsed(result).preview.builderFee.reason).toBe("not charged on spot buys")
    expect(f.signed()).toBe(false)
  })

  test("a cancel naming the order Hyperliquid shows for the cloid", async () => {
    const f = fake({ build: spotBuild(cancelAction), resting: { coin: "@107", oid: 77 } })
    const result = await executePerps(
      "candle_perps_spot_cancel",
      { cloid: CLOID.toUpperCase().replace("0X", "0x") },
      cfg,
      env(),
      f.fetch,
    )
    expect(result.isError).toBeUndefined()
    expect(f.built()?.body).toEqual({ walletId: "wallet", cloid: CLOID })
    expect(f.submitted()).toBe(true)
  })
})

describe("BE-4217 spot tools: a hostile build is refused before signing", () => {
  const hostile: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["another pair's asset", { ...buyAction, orders: [{ ...buyOrder, a: 10_000 }] }, BUY],
    ["a buy carrying a builder field", { ...buyAction, builder: { b: BUILDER, f: 100 } }, BUY],
    ["grouping", { ...buyAction, grouping: "normalTpsl" }, BUY],
    ["two orders", { ...buyAction, orders: [buyOrder, buyOrder] }, BUY],
    ["the wrong side", { ...buyAction, orders: [{ ...buyOrder, b: false }] }, BUY],
    ["a bigger size", { ...buyAction, orders: [{ ...buyOrder, s: "10" }] }, BUY],
    ["a perp asset", { ...buyAction, orders: [{ ...buyOrder, a: 0 }] }, BUY],
    ["a price far from the mid", { ...buyAction, orders: [{ ...buyOrder, p: "90" }] }, BUY],
    [
      "a pair quoted in another token",
      { ...buyAction, orders: [{ ...buyOrder, a: 10_207 }] },
      { ...BUY, pair: "@207" },
    ],
    ["a sell builder above 0.1%", { ...sellAction, builder: { b: BUILDER, f: 200 } }, SELL],
    ["a vault", { ...buyAction, vaultAddress: ADDRESS }, BUY],
  ]
  for (const [label, action, args] of hostile) {
    test(label, async () => {
      const f = fake({ build: spotBuild(action) })
      const result = await executePerps("candle_perps_spot_order", args, cfg, env(), f.fetch)
      expect(result.isError).toBe(true)
      expect(parsed(result).error.code).toBe("PERPS_BUILD_REFUSED")
      expect(parsed(result).error.message).toContain("Nothing was signed")
      expect(f.signed()).toBe(false)
      expect(f.submitted()).toBe(false)
    })
  }

  test("typed data that does not commit to the action", async () => {
    const build = spotBuild(buyAction, {
      typedData: hyperliquidL1TypedData(hyperliquidActionHash(sellAction, NONCE), "mainnet"),
    })
    const f = fake({ build })
    const result = await executePerps("candle_perps_spot_order", BUY, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(f.signed()).toBe(false)
  })

  test("a cancel naming another oid", async () => {
    const f = fake({
      build: spotBuild({ type: "cancel", cancels: [{ a: 10_107, o: 78 }] }),
      resting: { coin: "@107", oid: 77 },
    })
    const result = await executePerps("candle_perps_spot_cancel", { cloid: CLOID }, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(f.signed()).toBe(false)
  })

  test("a cancel for a cloid Hyperliquid does not show on this wallet", async () => {
    const f = fake({ build: spotBuild(cancelAction) })
    const result = await executePerps("candle_perps_spot_cancel", { cloid: CLOID }, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(f.signed()).toBe(false)
  })
})

describe("BE-4217 spot tools: the hide echo rule", () => {
  test("hide: true is sent, and a build without the echo is refused before signing", async () => {
    const f = fake({ build: spotBuild(buyAction) })
    const result = await executePerps("candle_perps_spot_order", { ...BUY, hide: true }, cfg, env(), f.fetch)
    expect(f.built()?.body?.hide).toBe(true)
    expect(parsed(result).error.code).toBe("HIDE_NOT_CONFIRMED")
    expect(f.signed()).toBe(false)
    expect(f.submitted()).toBe(false)
  })

  test("a build that echoes hide: true signs and submits", async () => {
    const f = fake({ build: spotBuild(buyAction, { hide: true }) })
    const result = await executePerps("candle_perps_spot_order", { ...BUY, hide: true }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(f.submitted()).toBe(true)
  })

  test("without hide, the body carries no hide field", async () => {
    const f = fake({ build: spotBuild(buyAction) })
    await executePerps("candle_perps_spot_order", { ...BUY, hide: false }, cfg, env(), f.fetch)
    expect(f.built()?.body).not.toHaveProperty("hide")
  })

  test("a cancel never sends hide", async () => {
    const f = fake({ build: spotBuild(cancelAction), resting: { coin: "@107", oid: 77 } })
    await executePerps("candle_perps_spot_cancel", { cloid: CLOID, hide: true } as never, cfg, env(), f.fetch)
    expect(f.built()?.body).not.toHaveProperty("hide")
  })
})

describe("BE-4217 spot tools: client ids", () => {
  test("a build that does not echo the client id is refused before signing", async () => {
    const f = fake({ build: spotBuild(sellAction) })
    const result = await executePerps("candle_perps_spot_order", { ...SELL, clientId: CLOID }, cfg, env(), f.fetch)
    expect(parsed(result).error.code).toBe("PERPS_CLIENT_ID_UNSUPPORTED")
    expect(f.signed()).toBe(false)
  })

  test("a replay of the same client id returns the original operation with nothing signed", async () => {
    const replay = {
      success: true,
      replayed: true,
      kind: "spotOrder",
      walletId: "wallet",
      clientId: CLOID,
      cloid: CLOID,
    }
    const f = fake({ build: replay })
    const result = await executePerps("candle_perps_spot_order", { ...SELL, clientId: CLOID }, cfg, env(), f.fetch)
    expect(parsed(result)).toMatchObject({ replayed: true, clientId: CLOID })
    expect(f.signed()).toBe(false)
  })
})
