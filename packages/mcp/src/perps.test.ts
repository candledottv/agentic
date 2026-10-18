import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  hyperliquidActionHash,
  hyperliquidCanonicalJson,
  hyperliquidL1TypedData,
} from "./hyperliquid"
import type { FetchLike } from "./orchestrate"
import { executePerps } from "./perps"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const OTHER = "0x1111111111111111111111111111111111111111"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
const NONCE = 1_790_000_000_000
const cfg = { apiUrl: "https://api.test", apiKey: "cndl_live_key" }
let dir: string
let pemFile: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-mcp-perps-"))
  pemFile = join(dir, "signer.pem")
  await writeFile(pemFile, pem)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function order(builder = BUILDER) {
  return {
    type: "order",
    orders: [
      { a: 0, b: true, p: "60600", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: `0x${"1".repeat(32)}` },
    ],
    grouping: "na",
    builder: { b: builder, f: 100 },
  }
}

function build(action: Record<string, unknown>) {
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: "open",
    network: "mainnet",
    walletId: "wallet",
    address: ADDRESS,
    nonce: NONCE,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
  }
}

function fake(
  opts: {
    build?: unknown
    scopes?: string[]
    exchange?: unknown
    mid?: string
    mode?: unknown
    history?: (body: Record<string, unknown>) => unknown
    /** BE-1584: the venue's open orders, the account's leverage, a resting order, and positions. */
    orders?: unknown[]
    leverage?: { type: string; value: number }
    resting?: Record<string, unknown>
    positions?: unknown[]
    reduceOnly?: Record<string, unknown>
    builds?: (path: string, body: Record<string, unknown> | undefined) => unknown
  } = {},
) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
    if (url === "https://api.hyperliquid.xyz/info") {
      if (body?.type === "meta") return ok({ universe: [{ name: "BTC" }] })
      if (body?.type === "userAbstraction") return ok(opts.mode ?? "default")
      if (body?.type === "userFillsByTime" || body?.type === "userFunding") return ok(opts.history?.(body) ?? [])
      if (body?.type === "frontendOpenOrders") return ok(opts.orders ?? [])
      if (body?.type === "activeAssetData") return ok({ leverage: opts.leverage ?? { type: "cross", value: 10 } })
      if (body?.type === "orderStatus") return ok({ status: "order", order: { order: opts.resting ?? {} } })
      if (body?.type === "clearinghouseState" && opts.positions) return ok({ assetPositions: opts.positions })
      if (body?.type === "metaAndAssetCtxs")
        return ok([
          {
            universe: [
              { name: "BTC", szDecimals: 5, maxLeverage: 40 },
              { name: "ETH", szDecimals: 4, maxLeverage: 25 },
            ],
          },
          [
            { midPx: opts.mid ?? "60000", markPx: "60000" },
            { midPx: "3000", markPx: "3000" },
          ],
        ])
      return ok({ assetPositions: [{ position: { coin: "BTC", szi: "-0.5" } }] })
    }
    if (url === "https://api.test/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["perps:write"],
        privyAppId: "app",
        page: [{ id: "wallet", address: ADDRESS, chain: "evm", privyWalletId: "privy-evm", label: "perps" }],
        isDone: true,
      })
    if (url.startsWith("https://api.test/api/v1/agent/perps/positions")) return ok({ success: true, positions: [] })
    if (url === "https://api.test/api/v1/agent/keys/self/perps-reduce-only")
      return ok(
        init?.method === "PUT"
          ? { success: true, keyPrefix: "K", perpsReduceOnly: true, perpsPolicyVersion: 1 }
          : (opts.reduceOnly ?? { success: true, keyPrefix: "K", perpsReduceOnly: false, perpsPolicyVersion: 0 }),
      )
    if (url === "https://api.test/api/v1/agent/perps/schedule-cancel/ack")
      return ok({ success: true, acknowledged: true })
    if (opts.builds && url.startsWith("https://api.test/api/v1/agent/perps/")) {
      const answer = opts.builds(url.replace("https://api.test", "").split("?")[0] as string, body)
      if (answer !== undefined) return ok(answer)
    }
    if (url.startsWith("https://api.test/api/v1/agent/perps/")) return ok(opts.build ?? build(order()))
    if (url.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    if (url === "https://api.hyperliquid.xyz/exchange")
      return ok(opts.exchange ?? { status: "ok", response: { type: "default" } })
    throw new Error(`unexpected ${url}`)
  }
  return { calls, fetch }
}

const env = () => ({ CANDLE_KEY_SIGNER_PEM_FILE: pemFile, CANDLE_HYPERLIQUID_BUILDER: BUILDER })
const OPEN = { coin: "BTC", side: "long", size: "0.01" }

describe("the release builder pin", () => {
  test("ships the confirmed address and uses it without reading config", async () => {
    expect(CANDLE_HYPERLIQUID_BUILDER_ADDRESS).toBe("0xc43ff1f6ad9f93fc94558e07c2071b8458e7470b")
    const f = fake({ build: build(order(CANDLE_HYPERLIQUID_BUILDER_ADDRESS)) })
    const result = await executePerps("candle_perps_open", OPEN, cfg, { CANDLE_KEY_SIGNER_PEM_FILE: pemFile }, f.fetch)
    expect(result.isError).toBeUndefined()
    expect(f.calls.some((c) => c.url.endsWith("/config"))).toBe(false)
  })

  test("an API builder mismatch refuses orders and no-action readiness before any signature", async () => {
    for (const submit of [true, false]) {
      for (const tool of ["candle_perps_open", "candle_perps_setup"] as const) {
        const f = fake({
          build:
            tool === "candle_perps_open"
              ? build(order())
              : {
                  success: true,
                  ready: true,
                  address: ADDRESS,
                  network: "mainnet",
                  mode: "default",
                  standardMode: true,
                  builder: BUILDER,
                  approvedFeeTenthsBps: 100,
                },
        })
        const result = await executePerps(
          tool,
          { ...OPEN, submit },
          cfg,
          { CANDLE_KEY_SIGNER_PEM_FILE: pemFile },
          f.fetch,
        )
        expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
        expect(
          f.calls.some((c) => c.url.endsWith("/sign") || c.url.endsWith("/exchange") || c.url.endsWith("/config")),
        ).toBe(false)
      }
    }
  })

  test("invalid overrides never fall back; an explicit valid override is shown in the preview", async () => {
    for (const invalid of ["", " ", "bad", `0x${"0".repeat(40)}`]) {
      const f = fake()
      const result = await executePerps(
        "candle_perps_open",
        OPEN,
        cfg,
        { ...env(), CANDLE_HYPERLIQUID_BUILDER: invalid },
        f.fetch,
      )
      expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
      expect(f.calls.every((c) => c.url.endsWith("/wallets/trading"))).toBe(true)
    }
    const f = fake()
    const result = await executePerps("candle_perps_open", { ...OPEN, submit: false }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.text).preview.builderTrust).toEqual({ address: BUILDER, source: "override" })
  })
})

describe("candle_perps_open", () => {
  test("built, checked, relay-signed over the canonical body, submitted to Hyperliquid", async () => {
    const f = fake()
    const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
      "https://api.test/api/v1/agent/perps/open",
      "https://api.hyperliquid.xyz/info",
      "https://api.test/api/v1/agent/wallets/wallet/sign",
      "https://api.hyperliquid.xyz/exchange",
    ])
    expect(f.calls[1]?.body).toEqual({ walletId: "wallet", ...OPEN, type: "market" })
    expect(f.calls[2]?.body).toEqual({ type: "metaAndAssetCtxs" })
    const relay = f.calls[3]?.body as { authorizationSignature: string; body: unknown }
    const payload = hyperliquidCanonicalJson({
      body: relay.body,
      headers: { "privy-app-id": "app" },
      method: "POST",
      url: "https://api.privy.io/v1/wallets/privy-evm/rpc",
      version: 1,
    })
    expect(
      verify("sha256", Buffer.from(payload), pair.publicKey, Buffer.from(relay.authorizationSignature, "base64")),
    ).toBe(true)
    expect(JSON.parse(result.text)).toMatchObject({ success: true, signature: SIGNATURE, nonce: NONCE })
  })

  test("a dishonest build is refused before the relay", async () => {
    for (const bad of [build(order(OTHER)), build({ type: "withdraw3", destination: OTHER, amount: "1", time: 1 })]) {
      const f = fake({ build: bad })
      const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
      expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
    }
  })

  test("SEC-004: an order on another asset, or a market price far from Hyperliquid's mid, is refused before the relay", async () => {
    const ethIndex = { ...order(), orders: [{ ...order().orders[0], a: 1 }] }
    for (const [bad, mid] of [
      [build(ethIndex), "60000"],
      [build(order()), "30000"],
    ] as const) {
      const f = fake({ build: bad, mid })
      const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
      expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
      expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
    }
  })

  test("no signer file: refused before anything is built", async () => {
    const f = fake()
    const result = await executePerps("candle_perps_open", OPEN, cfg, { CANDLE_HYPERLIQUID_BUILDER: BUILDER }, f.fetch)
    expect(JSON.parse(result.text).error.code).toBe("SIGNER_UNAVAILABLE")
    expect(f.calls).toEqual([])
    const unreadable = await executePerps(
      "candle_perps_open",
      OPEN,
      cfg,
      { CANDLE_KEY_SIGNER_PEM_FILE: join(dir, "missing.pem") },
      f.fetch,
    )
    expect(JSON.parse(unreadable.text).error.code).toBe("SIGNER_UNAVAILABLE")
  })

  test("submit: false checks the build and signs nothing, needing no signer", async () => {
    const f = fake()
    const result = await executePerps(
      "candle_perps_open",
      { ...OPEN, submit: false },
      cfg,
      { CANDLE_HYPERLIQUID_BUILDER: BUILDER },
      f.fetch,
    )
    expect(JSON.parse(result.text)).toMatchObject({ signed: false, submitted: false })
    expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
  })

  test("the key must hold perps:write", async () => {
    const f = fake({ scopes: ["swap:write"] })
    const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
    expect(JSON.parse(result.text).error.code).toBe("SCOPE_MISSING")
  })

  test("Hyperliquid refusing an order is an error result with its answer", async () => {
    const f = fake({ exchange: { status: "ok", response: { data: { statuses: [{ error: "Insufficient margin" }] } } } })
    const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text).exchange.response.data.statuses[0].error).toBe("Insufficient margin")
  })
})

describe("reads", () => {
  test("positions need only the key", async () => {
    const f = fake()
    const result = await executePerps("candle_perps_positions", {}, cfg, {}, f.fetch)
    expect(result.isError).toBeUndefined()
    // BE-1582: the thresholds read joins Candle's calls; the rest is Hyperliquid, read directly.
    expect(f.calls.map((c) => c.url).filter((url) => !url.includes("hyperliquid"))).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
      "https://api.test/api/v1/agent/perps/positions?walletId=wallet",
      "https://api.test/api/v1/agent/keys/self/limits",
    ])
  })

  test("no API key is a validation error", async () => {
    const result = await executePerps("candle_perps_positions", {}, { apiUrl: "https://api.test" }, {}, fake().fetch)
    expect(JSON.parse(result.text).error.code).toBe("MCP_VALIDATION")
  })
})

test("method, side, size and main-universe mismatches refuse without signing", async () => {
  for (const action of [
    { type: "updateLeverage", asset: 0, isCross: true, leverage: 50 },
    ...[{ a: 10000 }, { b: false }, { s: "1" }, { r: true }].map((change) => ({
      ...order(),
      orders: [{ ...order().orders[0], ...change }],
    })),
  ]) {
    const f = fake({ build: build(action) })
    const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
    expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(f.calls.some((c) => c.url.endsWith("/sign") || c.url.endsWith("/exchange"))).toBe(false)
  }
})

test("MCP close binds side and clamped size to the venue position", async () => {
  for (const change of [{ b: false }, { s: "0.4" }]) {
    const action = { ...order(), orders: [{ ...order().orders[0], r: true, s: "0.5", ...change }] }
    const f = fake({ build: build(action) })
    const result = await executePerps("candle_perps_close", { coin: "BTC" }, cfg, env(), f.fetch)
    expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(f.calls.some((c) => c.url.endsWith("/sign") || c.url.endsWith("/exchange"))).toBe(false)
  }
})

// ── BE-1583 (spec 2026-10-17 C) ──────────────────────────────────────────────────────────────

describe("candle_perps_setup and the account mode", () => {
  const ready = (extra: Record<string, unknown> = {}) => ({
    success: true,
    ready: true,
    walletId: "wallet",
    address: ADDRESS,
    network: "mainnet",
    mode: "default",
    standardMode: true,
    accountValue: "1",
    withdrawable: "1",
    builder: BUILDER,
    approvedFeeTenthsBps: 100,
    ...extra,
  })

  test("an unsupported mode is refused before setup is requested, submit or not", async () => {
    for (const mode of ["unifiedAccount", "portfolioMargin", "dexAbstraction", "next"]) {
      for (const submit of [true, false]) {
        const f = fake({ mode, build: ready() })
        const result = await executePerps("candle_perps_setup", { submit }, cfg, env(), f.fetch)
        expect(result.isError).toBe(true)
        expect(JSON.parse(result.text).error.code).toBe("PERPS_ACCOUNT_MODE")
        expect(f.calls.some((c) => c.url.endsWith("/perps/setup"))).toBe(false)
      }
    }
  })

  test("a dishonest ready answer is refused; an honest one is returned", async () => {
    for (const lie of [{ mode: "disabled" }, { builder: OTHER }, { address: OTHER }]) {
      const f = fake({ build: ready(lie) })
      const result = await executePerps("candle_perps_setup", {}, cfg, env(), f.fetch)
      expect(JSON.parse(result.text).error.code).toBe("PERPS_BUILD_REFUSED")
    }
    const f = fake({ build: ready() })
    const result = await executePerps("candle_perps_setup", {}, cfg, env(), f.fetch)
    expect(JSON.parse(result.text)).toMatchObject({ ready: true })
  })
})

describe("clientId on candle_perps_open and candle_perps_close", () => {
  const ID = "0x0123456789abcdef0123456789abcdef"
  const withId = () => {
    const action = { ...order(), orders: [{ ...order().orders[0], c: ID }] }
    return { ...build(action), cloid: ID, clientId: ID }
  }
  const replay = { success: true, replayed: true, walletId: "wallet", clientId: ID, cloid: ID, status: "filled" }

  test("sent lowercased and held to the order's cloid", async () => {
    const f = fake({ build: withId() })
    const result = await executePerps(
      "candle_perps_open",
      { ...OPEN, clientId: ID.toUpperCase().replace("0X", "0x"), submit: false },
      cfg,
      env(),
      f.fetch,
    )
    expect(result.isError).toBeUndefined()
    expect(f.calls[1]?.body).toMatchObject({ clientId: ID })
  })

  test("a replay is returned with nothing signed or sent", async () => {
    for (const tool of ["candle_perps_open", "candle_perps_close"] as const) {
      const f = fake({ build: replay })
      const result = await executePerps(tool, { ...OPEN, clientId: ID }, cfg, env(), f.fetch)
      expect(JSON.parse(result.text)).toMatchObject({ replayed: true, status: "filled" })
      expect(f.calls.some((c) => c.url.endsWith("/sign") || c.url.includes("hyperliquid"))).toBe(false)
    }
    const unasked = fake({ build: replay })
    expect(JSON.parse((await executePerps("candle_perps_open", OPEN, cfg, env(), unasked.fetch)).text).error.code).toBe(
      "PERPS_BUILD_REFUSED",
    )
  })

  test("an API that does not echo the id is refused before signing", async () => {
    const f = fake({ build: build(order()) })
    const result = await executePerps("candle_perps_open", { ...OPEN, clientId: ID }, cfg, env(), f.fetch)
    expect(JSON.parse(result.text).error.code).toBe("PERPS_CLIENT_ID_UNSUPPORTED")
    expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
  })
})

describe("candle_perps_fills and candle_perps_funding", () => {
  const fill = { coin: "BTC", px: "1", sz: "1", side: "B", time: 5, closedPnl: "0", fee: "0.1", tid: 1, oid: 2 }

  test("read Hyperliquid directly with only the API key: no signer, no perps:write, key never sent there", async () => {
    const f = fake({ scopes: ["account:read"], history: () => [fill] })
    const result = await executePerps("candle_perps_fills", { startTime: 0, endTime: 10 }, cfg, {}, f.fetch)
    const page = JSON.parse(result.text)
    expect(page).toMatchObject({ success: true, walletId: "wallet", address: ADDRESS, source: "hyperliquid" })
    expect(page.fills).toHaveLength(1)
    expect(f.calls.filter((c) => c.url.startsWith("https://api.test")).map((c) => c.url)).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
    ])
    expect(f.calls.find((c) => c.body?.type === "userFillsByTime")?.body).toEqual({
      type: "userFillsByTime",
      user: ADDRESS,
      startTime: 0,
      endTime: 10,
      aggregateByTime: false,
    })
  })

  test("funding pages the same way", async () => {
    const f = fake({
      history: () => [{ time: 5, hash: "0x1", delta: { coin: "BTC", usdc: "-1", szi: "1", fundingRate: "0.1" } }],
    })
    const page = JSON.parse(
      (await executePerps("candle_perps_funding", { startTime: 0, endTime: 10 }, cfg, {}, f.fetch)).text,
    )
    expect(page.funding[0].delta.usdc).toBe("-1")
  })

  test("a bad cursor is a validation error naming the field; an upstream failure is PERPS_UNAVAILABLE", async () => {
    const f = fake()
    const bad = await executePerps("candle_perps_fills", { cursor: "nope" }, cfg, {}, f.fetch)
    expect(JSON.parse(bad.text)).toMatchObject({ error: { code: "VALIDATION_FAILED" }, field: "cursor" })
    const down = fake({ history: () => ({ not: "an array" }) })
    const failed = await executePerps("candle_perps_funding", {}, cfg, {}, down.fetch)
    expect(failed.isError).toBe(true)
    expect(JSON.parse(failed.text).error.code).toBe("PERPS_UNAVAILABLE")
  })
})

// ── Phase 1 D (BE-1584): the management tools ─────────────────────────────────────────────

function stamped(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...build(action), ...extra }
}

describe("the management tools (BE-1584)", () => {
  test("bad input is refused before the signer or any request", async () => {
    for (const [tool, args] of [
      ["candle_perps_modify", { cloid: `0x${"1".repeat(32)}` }],
      ["candle_perps_margin", { coin: "BTC" }],
      ["candle_perps_margin", { coin: "BTC", amount: "5", mode: "cross" }],
      ["candle_perps_margin", { coin: "BTC", amount: "0" }],
      ["candle_perps_schedule_cancel", {}],
      ["candle_perps_schedule_cancel", { seconds: 60, clear: true }],
      ["candle_perps_close", { coin: "BTC", pct: "25", size: "1" }],
      ["candle_perps_tpsl", { coin: "BTC" }],
      ["candle_perps_tpsl", { coin: "BTC", takeProfit: "1", removeTp: true }],
    ] as const) {
      const f = fake()
      const result = await executePerps(tool, args as Record<string, unknown>, cfg, {}, f.fetch)
      expect([tool, result.isError]).toEqual([tool, true])
      expect(JSON.parse(result.text).error.code).toBe("MCP_VALIDATION")
      expect(f.calls).toEqual([])
    }
  })

  test("margin: amount builds a top-up; mode routes to leverage, keeps it, and reports both modes", async () => {
    const topUp = { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: 5_000_000 }
    const iso = [{ position: { coin: "BTC", szi: "0.1", leverage: { type: "isolated", value: 5 } } }]
    const f = fake({ builds: () => stamped(topUp), positions: iso })
    const result = await executePerps("candle_perps_margin", { coin: "BTC", amount: "5" }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(f.calls.find((c) => c.url.endsWith("/perps/margin"))?.body).toEqual({
      walletId: "wallet",
      coin: "BTC",
      amount: "5",
    })

    const mode = { type: "updateLeverage", asset: 0, isCross: false, leverage: 7 }
    const g = fake({ builds: () => stamped(mode), leverage: { type: "cross", value: 7 } })
    const switched = await executePerps("candle_perps_margin", { coin: "BTC", mode: "isolated" }, cfg, env(), g.fetch)
    expect(switched.isError).toBeUndefined()
    expect(g.calls.find((c) => c.url.endsWith("/perps/leverage"))?.body).toEqual({
      walletId: "wallet",
      coin: "BTC",
      mode: "isolated",
    })
    expect(JSON.parse(switched.text)).toMatchObject({ requestedMode: "isolated", confirmedMode: "cross" })
  })

  test("modify is checked against the resting order Hyperliquid shows", async () => {
    const cloid = `0x${"1".repeat(32)}`
    const resting = { coin: "BTC", side: "A", limitPx: "61000", sz: "0.2", oid: 77, reduceOnly: true, tif: "Gtc" }
    const order = {
      a: 0,
      b: false,
      p: "61500",
      s: "0.2",
      r: true,
      t: { limit: { tif: "Gtc" } },
      c: `0x${"2".repeat(32)}`,
    }
    const ok = fake({ builds: () => stamped({ type: "modify", oid: 77, order }), resting })
    expect(
      (await executePerps("candle_perps_modify", { cloid, price: "61500" }, cfg, env(), ok.fetch)).isError,
    ).toBeUndefined()
    const hostile = fake({ builds: () => stamped({ type: "modify", oid: 78, order }), resting })
    const refused = await executePerps("candle_perps_modify", { cloid, price: "61500" }, cfg, env(), hostile.fetch)
    expect(JSON.parse(refused.text).error.code).toBe("PERPS_BUILD_REFUSED")
    expect(hostile.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
  })

  test("schedule_cancel sets, records the acknowledgement, and never claims the timer is verified", async () => {
    const now = Date.now()
    const f = fake({ builds: () => stamped({ type: "scheduleCancel", time: now + 60_000 }, { time: now + 60_000 }) })
    const result = await executePerps("candle_perps_schedule_cancel", { seconds: 60 }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.text)).toMatchObject({ success: true, acknowledged: true, verified: false })
    expect(f.calls.find((c) => c.url.endsWith("/schedule-cancel"))?.body).toEqual({ walletId: "wallet", seconds: 60 })
    const g = fake({
      builds: () => stamped({ type: "scheduleCancel" }),
      exchange: { status: "err", response: "Too many cancels scheduled today" },
    })
    const rejected = await executePerps("candle_perps_schedule_cancel", { clear: true }, cfg, env(), g.fetch)
    expect(JSON.parse(rejected.text).error.code).toBe("PERPS_SCHEDULE_CANCEL_REJECTED")
  })

  test("reduce_only reads, turns on, and refuses off locally with no request", async () => {
    const f = fake({ reduceOnly: { success: true, keyPrefix: "K", perpsReduceOnly: true, perpsPolicyVersion: 2 } })
    expect(JSON.parse((await executePerps("candle_perps_reduce_only", {}, cfg, {}, f.fetch)).text)).toMatchObject({
      perpsReduceOnly: true,
    })
    const on = await executePerps("candle_perps_reduce_only", { on: true }, cfg, {}, f.fetch)
    expect(JSON.parse(on.text)).toMatchObject({ perpsReduceOnly: true, perpsPolicyVersion: 1 })
    const g = fake()
    const off = await executePerps("candle_perps_reduce_only", { on: false }, cfg, {}, g.fetch)
    expect(JSON.parse(off.text).error.code).toBe("LOOSEN_REQUIRES_SESSION")
    expect(g.calls).toEqual([])
  })

  test("flatten on an empty wallet is complete and signs nothing; tpsl needs the signer like any write", async () => {
    const f = fake({ positions: [] })
    const result = await executePerps("candle_perps_flatten", {}, cfg, env(), f.fetch)
    expect(JSON.parse(result.text)).toMatchObject({
      operation: "flatten",
      complete: true,
      scope: "main-perps",
      steps: [],
    })
    expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
    const g = fake()
    const noSigner = await executePerps("candle_perps_tpsl", { coin: "BTC", takeProfit: "66000" }, cfg, {}, g.fetch)
    expect(JSON.parse(noSigner.text).error.code).toBe("SIGNER_UNAVAILABLE")
  })

  test("tpsl attaches through the plan and reports it complete", async () => {
    const leg = {
      type: "order",
      orders: [
        {
          a: 0,
          b: false,
          p: "62700",
          s: "0.5",
          r: true,
          t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "tp" } },
          c: `0x${"3".repeat(32)}`,
        },
      ],
      grouping: "positionTpsl",
      builder: { b: BUILDER, f: 100 },
    }
    const f = fake({
      positions: [{ position: { coin: "BTC", szi: "0.5", leverage: { type: "cross", value: 10 } } }],
      builds: (path, body) =>
        body === undefined
          ? { coin: "BTC", tracked: [], unowned: [] }
          : path.endsWith("/tpsl")
            ? stamped(leg)
            : undefined,
    })
    const result = await executePerps("candle_perps_tpsl", { coin: "BTC", takeProfit: "66000" }, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.text)).toMatchObject({ operation: "tpsl", complete: true })
  })
})
