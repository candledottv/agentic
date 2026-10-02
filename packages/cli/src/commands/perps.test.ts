/**
 * Hyperliquid perps B (BE-646): `candle perps` against a routed fake of the perps server half and
 * of Hyperliquid's /exchange. Every write proves the same things: the bound key authenticates with
 * `perps:write`, the build is checked here (hash recomputed, action type, Candle's builder) before
 * anything is signed, a refused build reaches neither the relay nor Hyperliquid, the relay is
 * authorized over the canonical typed-data body, and the signed action is posted to Hyperliquid by
 * this machine. Nothing in this file opens a vault or a TEE key.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hyperliquidActionHash, hyperliquidCanonicalJson, hyperliquidL1TypedData } from "../hyperliquid"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const OTHER = "0x1111111111111111111111111111111111111111"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1b`
const CLOID = `0x${"1".repeat(32)}`
const NONCE = 1_790_000_000_000
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function orderAction(builder = BUILDER) {
  return {
    type: "order",
    orders: [{ a: 0, b: true, p: "60600", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }],
    grouping: "na",
    builder: { b: builder, f: 100 },
  }
}

function buildFor(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
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
    claimHash: "h",
    cloid: CLOID,
    notionalUsdMicros: 606_000_000,
    reservedUsdMicros: 606_000_000,
    windowKey: "daily:1",
    builder: { address: BUILDER, feeTenthsBps: 100 },
    exchangeUrl: "https://evil.example/exchange",
    preview: {
      coin: "BTC",
      side: "long",
      size: "0.01",
      limitPx: "60600",
      tif: "Ioc",
      reduceOnly: false,
      midPx: "60000",
    },
    ...extra,
  }
}

interface Options {
  scopes?: string[]
  build?: Record<string, unknown>
  perpsDisabled?: boolean
  exchange?: Response | Error
  pinBuilder?: boolean
  setupReady?: boolean
}

async function fixture(opts: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-perps-"))
  folders.push(dir)
  const calls: { host: string; path: string; query: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ host: url.host, path: url.pathname, query: url.search, body })
    const ok = (value: unknown) => Response.json(value)
    if (url.host === "api.hyperliquid.xyz" && url.pathname === "/info") {
      if (body.type === "meta") return ok({ universe: [{ name: "BTC" }] })
      return ok({ assetPositions: [{ position: { coin: "BTC", szi: "-0.5" } }] })
    }
    if (url.host === "api.hyperliquid.xyz") {
      if (opts.exchange instanceof Error) throw opts.exchange
      return (
        opts.exchange ?? ok({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 1 } }] } } })
      )
    }
    if (url.pathname === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["perps:write"],
        privyAppId: "app",
        page: [
          {
            id: "sol-wallet",
            address: "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB",
            chain: "solana",
            active: true,
            allowLaunch: false,
            privyWalletId: "privy-sol",
          },
          {
            id: "wallet",
            address: ADDRESS,
            label: "perps",
            chain: "evm",
            active: true,
            allowLaunch: false,
            privyWalletId: "privy-evm",
          },
        ],
        isDone: true,
      })
    if (url.pathname.startsWith("/api/v1/agent/perps/")) {
      if (opts.perpsDisabled) return new Response("404 Not Found", { status: 404 })
      if (url.pathname === "/api/v1/agent/perps/config") return ok({ success: true, builder: BUILDER })
      if (url.pathname === "/api/v1/agent/perps/setup" && opts.setupReady)
        return ok({ success: true, ready: true, mode: "default", accountValue: "0", builder: BUILDER })
      if (url.pathname === "/api/v1/agent/perps/positions")
        return ok({
          success: true,
          address: ADDRESS,
          network: "mainnet",
          mode: "default",
          account: { accountValue: "12" },
          withdrawable: "12",
          positions: [],
        })
      return ok(opts.build ?? buildFor(orderAction()))
    }
    if (url.pathname.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      ...(opts.pinBuilder === false ? {} : { CANDLE_HYPERLIQUID_BUILDER: BUILDER }),
    },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    promptLine: async () => "y",
  })
  return { deps, calls, stdout, stderr }
}

const OPEN = ["perps", "open", "BTC", "long", "0.01", "--yes", "--json"]

describe("candle perps open", () => {
  test("bound key, built, checked, relay-signed over the canonical body, posted to Hyperliquid itself", async () => {
    const f = await fixture()
    expect(await run(OPEN, f.deps)).toBe(0)
    expect(f.calls.map((c) => `${c.host === "api.hyperliquid.xyz" ? "hl:" : ""}${c.path}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/perps/open",
      "/api/v1/agent/wallets/wallet/sign",
      "hl:/exchange",
    ])
    expect(f.calls[1]?.body).toEqual({ walletId: "wallet", coin: "BTC", side: "long", size: "0.01", type: "market" })
    const relay = f.calls[2]?.body as { authorizationSignature: string; body: Record<string, unknown> }
    const build = buildFor(orderAction())
    expect(relay.body).toEqual({ method: "eth_signTypedData_v4", params: { typed_data: build.typedData } })
    // The authorization covers Privy's canonical payload, whatever order the server sent.
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
    expect(f.calls[3]?.body).toEqual({
      action: build.action,
      nonce: NONCE,
      signature: { r: `0x${"a".repeat(64)}`, s: `0x${"b".repeat(64)}`, v: 27 },
      vaultAddress: null,
      expiresAfter: null,
    })
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({
      success: true,
      perpOrderId: "perp-1",
      signature: SIGNATURE,
    })
  })

  test("a dishonest build reaches neither the relay nor Hyperliquid", async () => {
    for (const build of [
      buildFor(orderAction(OTHER)),
      buildFor({ type: "vaultTransfer", vaultAddress: OTHER, isDeposit: true, usd: 1 }),
      { ...buildFor(orderAction()), action: { ...orderAction(), grouping: "normalTpsl" } },
    ]) {
      const f = await fixture({ build })
      expect(await run(OPEN, f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "PERPS_BUILD_REFUSED" })
      expect(f.calls.some((c) => c.path.endsWith("/sign") || c.host === "api.hyperliquid.xyz")).toBe(false)
    }
  })

  test("without a pinned builder the server's configured one is read and held to", async () => {
    const f = await fixture({ pinBuilder: false })
    expect(await run(OPEN, f.deps)).toBe(0)
    expect(f.calls.map((c) => c.path)).toContain("/api/v1/agent/perps/config")
  })

  test("--no-submit stops after the check: nothing signed, nothing posted", async () => {
    const f = await fixture()
    expect(await run([...OPEN, "--no-submit"], f.deps)).toBe(0)
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ signed: false, submitted: false })
  })

  test("a deployment with perps off is named", async () => {
    const f = await fixture({ perpsDisabled: true })
    expect(await run(OPEN, f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ code: "PERPS_NOT_ENABLED" })
  })

  test("the bound key must hold perps:write", async () => {
    const f = await fixture({ scopes: ["swap:write"] })
    expect(await run(OPEN, f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ code: "SCOPE_MISSING" })
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agent/wallets/trading"])
  })

  test("Hyperliquid refusing the order is a failure that names it", async () => {
    const f = await fixture({
      exchange: Response.json({
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } },
      }),
    })
    expect(await run(OPEN, f.deps)).toBe(1)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("PERPS_VENUE_REFUSED")
    expect(out.message).toContain("Insufficient margin")
  })

  test("a failed submit keeps the signed action and exits 3", async () => {
    const f = await fixture({ exchange: new Error("socket hang up") })
    expect(await run(OPEN, f.deps)).toBe(3)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("PERPS_SUBMIT_FAILED")
    expect(out.details.exchangeBody.nonce).toBe(NONCE)
  })

  test("usage errors answer before any request", async () => {
    for (const argv of [
      ["perps", "open", "BTC", "up", "0.01", "--json"],
      ["perps", "open", "BTC", "long", "1e3", "--json"],
      ["perps", "open", "BTC", "long", "1", "--tif", "Gtc", "--json"],
      ["perps", "cancel", "not-a-cloid", "--json"],
      ["perps", "leverage", "BTC", "0", "--json"],
    ]) {
      const f = await fixture()
      expect([argv.join(" "), await run(argv, f.deps)]).toEqual([argv.join(" "), 2])
      expect(f.calls).toEqual([])
    }
  })
})

describe("the other commands", () => {
  test("setup already approved: reported, nothing signed", async () => {
    const f = await fixture({ setupReady: true })
    expect(await run(["perps", "setup", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ready: true })
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("close, cancel and leverage send their bodies", async () => {
    const cases: [string[], Record<string, unknown>][] = [
      [["perps", "close", "BTC", "--size", "0.5"], { walletId: "wallet", coin: "BTC", size: "0.5" }],
      [["perps", "cancel", CLOID.toUpperCase().replace("0X", "0x")], { walletId: "wallet", cloid: CLOID }],
      [
        ["perps", "leverage", "ETH", "3", "--isolated"],
        { walletId: "wallet", coin: "ETH", leverage: 3, mode: "isolated" },
      ],
    ]
    for (const [argv, body] of cases) {
      const action =
        argv[1] === "close"
          ? { ...orderAction(), orders: [{ ...orderAction().orders[0], r: true, s: "0.5" }] }
          : argv[1] === "cancel"
            ? { type: "cancel", cancels: [{ a: 0, o: 1 }] }
            : { type: "updateLeverage", asset: 1, isCross: false, leverage: 3 }
      const f = await fixture({ build: buildFor(action) })
      expect(await run([...argv, "--yes", "--json"], f.deps)).toBe(0)
      expect(f.calls[1]?.body).toEqual(body)
    }
  })

  test("positions reads without perps:write", async () => {
    const f = await fixture({ scopes: ["account:read"] })
    expect(await run(["perps", "positions", "--json"], f.deps)).toBe(0)
    expect(f.calls.map((c) => `${c.path}${c.query}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/perps/positions?walletId=wallet",
    ])
  })
})

describe("--sign-only (V4)", () => {
  test("the relay signs; nothing is posted to Hyperliquid; the exchange body is printed", async () => {
    const f = await fixture()
    expect(await run([...OPEN, "--sign-only"], f.deps)).toBe(0)
    expect(f.calls.some((c) => c.host === "api.hyperliquid.xyz")).toBe(false)
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(true)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out).toMatchObject({ signature: SIGNATURE, submitted: false, exchangeBody: { nonce: NONCE } })
  })
})

test("confirmation displays the verified action despite a lying preview and fee metadata", async () => {
  const f = await fixture({
    build: buildFor(orderAction(), {
      kind: "cancel",
      preview: { coin: "FAKE", side: "short", size: "0.0001", limitPx: "1" },
      builder: null,
      notionalUsdMicros: 1,
      reservedUsdMicros: 1,
    }),
  })
  expect(await run(["perps", "open", "BTC", "long", "0.01", "--yes"], f.deps)).toBe(0)
  expect(f.stdout.text).toContain("Open buy 0.01 asset 0 at 60600 (Ioc)")
  expect(f.stdout.text).toContain("fee: 10 bps")
  expect(f.stdout.text).not.toContain("FAKE")
  expect(f.stdout.text).not.toContain("Cancel")
})

test("an allowed action for the wrong method reaches neither relay nor exchange", async () => {
  const f = await fixture({ build: buildFor({ type: "updateLeverage", asset: 0, isCross: true, leverage: 40 }) })
  expect(await run(OPEN, f.deps)).toBe(1)
  expect(f.calls.some((c) => c.path.endsWith("/sign") || c.host === "api.hyperliquid.xyz")).toBe(false)
})

test("close checks side and exact clamped size against the venue position", async () => {
  for (const change of [{ b: false }, { s: "0.4" }]) {
    const action = { ...orderAction(), orders: [{ ...orderAction().orders[0], r: true, s: "0.5", ...change }] }
    const f = await fixture({ build: buildFor(action) })
    expect(await run(["perps", "close", "BTC", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("PERPS_BUILD_REFUSED")
    expect(f.calls.some((c) => c.path.endsWith("/sign") || c.path === "/exchange")).toBe(false)
  }
})
