import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hyperliquidActionHash, hyperliquidCanonicalJson, hyperliquidL1TypedData } from "./hyperliquid"
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

function fake(opts: { build?: unknown; scopes?: string[]; exchange?: unknown } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
    if (url === "https://api.hyperliquid.xyz/info") {
      if (body?.type === "meta") return ok({ universe: [{ name: "BTC" }] })
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
    if (url.startsWith("https://api.test/api/v1/agent/perps/")) return ok(opts.build ?? build(order()))
    if (url.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    if (url === "https://api.hyperliquid.xyz/exchange") return ok(opts.exchange ?? { status: "ok", response: {} })
    throw new Error(`unexpected ${url}`)
  }
  return { calls, fetch }
}

const env = () => ({ CANDLE_KEY_SIGNER_PEM_FILE: pemFile, CANDLE_HYPERLIQUID_BUILDER: BUILDER })
const OPEN = { coin: "BTC", side: "long", size: "0.01" }

describe("candle_perps_open", () => {
  test("built, checked, relay-signed over the canonical body, submitted to Hyperliquid", async () => {
    const f = fake()
    const result = await executePerps("candle_perps_open", OPEN, cfg, env(), f.fetch)
    expect(result.isError).toBeUndefined()
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
      "https://api.test/api/v1/agent/perps/open",
      "https://api.test/api/v1/agent/wallets/wallet/sign",
      "https://api.hyperliquid.xyz/exchange",
    ])
    expect(f.calls[1]?.body).toEqual({ walletId: "wallet", ...OPEN, type: "market" })
    const relay = f.calls[2]?.body as { authorizationSignature: string; body: unknown }
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
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
      "https://api.test/api/v1/agent/perps/positions?walletId=wallet",
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
