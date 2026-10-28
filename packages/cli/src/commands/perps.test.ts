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
import { humanText } from "../human-output.test-support"
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  hyperliquidActionHash,
  hyperliquidCanonicalJson,
  hyperliquidL1TypedData,
} from "../hyperliquid"
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
  /** What the setup answer says, over an honest ready answer. */
  setupAnswer?: Record<string, unknown>
  /** Hyperliquid's BTC mid, as `/info` metaAndAssetCtxs reports it. */
  mid?: string
  /** Hyperliquid's `userAbstraction` for the account. */
  mode?: unknown
  /** `/info` history answers: userFillsByTime and userFunding. */
  history?: (body: Record<string, unknown>) => unknown
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
      if (body.type === "userAbstraction") return ok(opts.mode ?? "default")
      if (body.type === "userFillsByTime" || body.type === "userFunding") return ok(opts.history?.(body) ?? [])
      // BE-1584: the pre-sign reads every method now makes against Hyperliquid itself.
      if (body.type === "orderStatus")
        return ok({
          status: "order",
          order: { order: { coin: "BTC", oid: 1, side: "B", limitPx: "60000", sz: "0.01" } },
        })
      if (body.type === "frontendOpenOrders") return ok([])
      if (body.type === "activeAssetData") return ok({ leverage: { type: "cross", value: 10 } })
      if (body.type === "metaAndAssetCtxs")
        return ok([
          {
            universe: [
              { name: "BTC", szDecimals: 5, maxLeverage: 40 },
              { name: "ETH", szDecimals: 4, maxLeverage: 25 },
            ],
          },
          [{ midPx: opts.mid ?? "60000" }, { midPx: "3000" }],
        ])
      return ok({
        assetPositions: [{ position: { coin: "BTC", szi: "-0.5", leverage: { type: "cross", value: 10 } } }],
      })
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
        return ok({
          success: true,
          ready: true,
          walletId: "wallet",
          address: ADDRESS,
          network: "mainnet",
          mode: "default",
          standardMode: true,
          accountValue: "0",
          withdrawable: "0",
          builder: BUILDER,
          approvedFeeTenthsBps: 100,
          ...opts.setupAnswer,
        })
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
      "hl:/info",
      "/api/v1/agent/wallets/wallet/sign",
      "hl:/exchange",
    ])
    expect(f.calls[1]?.body).toEqual({ walletId: "wallet", coin: "BTC", side: "long", size: "0.01", type: "market" })
    expect(f.calls[2]?.body).toEqual({ type: "metaAndAssetCtxs" })
    const relay = f.calls[3]?.body as { authorizationSignature: string; body: Record<string, unknown> }
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
    expect(f.calls[4]?.body).toEqual({
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

  test("the shipped builder is used by default without reading config", async () => {
    expect(CANDLE_HYPERLIQUID_BUILDER_ADDRESS).toBe("0xc43ff1f6ad9f93fc94558e07c2071b8458e7470b")
    const f = await fixture({ pinBuilder: false, build: buildFor(orderAction(CANDLE_HYPERLIQUID_BUILDER_ADDRESS)) })
    expect(await run(OPEN, f.deps)).toBe(0)
    expect(f.calls.map((c) => c.path)).not.toContain("/api/v1/agent/perps/config")
  })

  test("a different API builder refuses before the relay, including no-submit and ready", async () => {
    for (const argv of [OPEN, [...OPEN, "--no-submit"], ["perps", "setup", "--yes", "--json"]]) {
      const f = await fixture({ pinBuilder: false, setupReady: true })
      expect(await run(argv, f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "PERPS_BUILD_REFUSED" })
      expect(
        f.calls.some((c) => c.path.endsWith("/sign") || c.path.endsWith("/exchange") || c.path.endsWith("/config")),
      ).toBe(false)
    }
    const f = await fixture({
      pinBuilder: false,
      setupReady: true,
      setupAnswer: { builder: CANDLE_HYPERLIQUID_BUILDER_ADDRESS },
    })
    expect(await run(["perps", "setup", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({
      ready: true,
      preview: { builderTrust: { source: "release" } },
    })
  })

  test("invalid explicit overrides fail closed before building; valid overrides are disclosed", async () => {
    for (const invalid of ["", " ", "bad", `0x${"0".repeat(40)}`]) {
      const f = await fixture()
      f.deps.env.CANDLE_HYPERLIQUID_BUILDER = invalid
      expect(await run(OPEN, f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim()).code).toBe("PERPS_BUILD_REFUSED")
      expect(f.calls.every((c) => c.path === "/api/v1/agent/wallets/trading")).toBe(true)
    }
    const f = await fixture()
    expect(await run([...OPEN, "--no-submit"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim()).preview.builderTrust).toEqual({ address: BUILDER, source: "override" })
    const signed = await fixture()
    expect(await run(OPEN, signed.deps)).toBe(0)
    expect(humanText(signed.stderr.text)).toContain(humanText("Builder trust override:"))
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
    // BE-1582: the thresholds read joins Candle's calls; the rest is Hyperliquid, read directly.
    expect(f.calls.filter((c) => c.host !== "api.hyperliquid.xyz").map((c) => `${c.path}${c.query}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/perps/positions?walletId=wallet",
      "/api/v1/agent/keys/self/limits",
    ])
  })
})

describe("the order is held to Hyperliquid's own market (SEC-004)", () => {
  test("another coin's asset index is refused before the relay", async () => {
    const action = orderAction()
    const f = await fixture({ build: buildFor({ ...action, orders: [{ ...action.orders[0], a: 1 }] }) })
    expect(await run(OPEN, f.deps)).not.toBe(0)
    expect(f.stdout.text + f.stderr.text).toContain("PERPS_BUILD_REFUSED")
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("a market open priced far from Hyperliquid's mid is refused before the relay", async () => {
    const f = await fixture({ mid: "30300" })
    expect(await run(OPEN, f.deps)).not.toBe(0)
    expect(f.stdout.text + f.stderr.text).toContain("slippage")
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("a take-profit leg is signed at the API's slippage from its trigger, and refused far below it", async () => {
    const withTakeProfit = (limitPx: string) => {
      const action = orderAction()
      const tp = {
        a: 0,
        b: false,
        p: limitPx,
        s: "0.01",
        r: true,
        t: { trigger: { isMarket: true, triggerPx: "66000", tpsl: "tp" } },
        c: CLOID,
      }
      return buildFor({ ...action, orders: [...action.orders, tp], grouping: "normalTpsl" })
    }
    const honest = await fixture({ build: withTakeProfit("62700") })
    expect(await run([...OPEN, "--tp", "66000"], honest.deps)).toBe(0)
    expect(honest.calls.some((c) => c.path.endsWith("/sign"))).toBe(true)

    const dishonest = await fixture({ build: withTakeProfit("1") })
    expect(await run([...OPEN, "--tp", "66000"], dishonest.deps)).not.toBe(0)
    expect(humanText(dishonest.stdout.text + dishonest.stderr.text)).toContain(
      humanText("slippage of the trigger price"),
    )
    expect(dishonest.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })
})

describe("--sign-only (V4)", () => {
  test("the relay signs; nothing is posted to Hyperliquid; the exchange body is printed", async () => {
    const f = await fixture()
    expect(await run([...OPEN, "--sign-only"], f.deps)).toBe(0)
    // Hyperliquid is only read (the market check), never posted to.
    expect(f.calls.some((c) => c.host === "api.hyperliquid.xyz" && c.path !== "/info")).toBe(false)
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
  expect(humanText(f.stdout.text)).toContain(humanText("Open buy 0.01 asset 0 at 60600 (Ioc)"))
  expect(humanText(f.stdout.text)).toContain(humanText("fee: 10 bps"))
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

// ── BE-1583 (spec 2026-10-17 C): setup mode, client order ids, fills and funding ─────────────

describe("setup refuses an unsupported account mode", () => {
  test("read from Hyperliquid before Candle is asked; nothing requested or signed", async () => {
    for (const mode of ["unifiedAccount", "portfolioMargin", "dexAbstraction", "brandNew"]) {
      for (const extra of [[], ["--yes"], ["--no-submit"]]) {
        const f = await fixture({ mode, setupReady: true })
        expect(await run(["perps", "setup", ...extra, "--json"], f.deps)).toBe(1)
        const out = JSON.parse(f.stdout.text.trim())
        expect(out.code).toBe("PERPS_ACCOUNT_MODE")
        expect(out.message).toContain(`${mode} mode`)
        expect(out.message).toContain("not a missing fee approval")
        expect(f.calls.some((c) => c.path === "/api/v1/agent/perps/setup")).toBe(false)
        expect(f.calls.find((c) => c.host === "api.hyperliquid.xyz")?.body).toEqual({
          type: "userAbstraction",
          user: ADDRESS,
        })
      }
    }
  })

  test("an unreadable mode is PERPS_UNAVAILABLE, not a pass", async () => {
    const f = await fixture({ mode: { nope: true }, setupReady: true })
    expect(await run(["perps", "setup", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim()).code).toBe("PERPS_UNAVAILABLE")
    expect(f.calls.some((c) => c.path === "/api/v1/agent/perps/setup")).toBe(false)
  })

  test("a dishonest ready answer is refused: another mode, builder or wallet", async () => {
    for (const setupAnswer of [{ mode: "disabled" }, { builder: OTHER }, { address: OTHER }, { standardMode: false }]) {
      const f = await fixture({ setupReady: true, setupAnswer })
      expect(await run(["perps", "setup", "--json"], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim()).code).toBe("PERPS_BUILD_REFUSED")
    }
    const ok = await fixture({ setupReady: true, mode: "disabled", setupAnswer: { mode: "disabled" } })
    expect(await run(["perps", "setup", "--json"], ok.deps)).toBe(0)
  })
})

describe("--client-id", () => {
  const ID = "0x0123456789abcdef0123456789abcdef"
  const withId = (extra: Record<string, unknown> = {}) => {
    const action = { ...orderAction(), orders: [{ ...orderAction().orders[0], c: ID }] }
    return buildFor(action, { cloid: ID, clientId: ID, ...extra })
  }

  test("sent lowercased, held to the primary order's cloid, then signed as usual", async () => {
    const f = await fixture({ build: withId() })
    expect(await run([...OPEN, "--client-id", ID.toUpperCase().replace("0X", "0x")], f.deps)).toBe(0)
    expect(f.calls[1]?.body).toMatchObject({ clientId: ID })
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ success: true, cloid: ID })
  })

  test("a replay is reported, and nothing is checked, signed or sent", async () => {
    const replay = {
      success: true,
      replayed: true,
      perpOrderId: "perp-1",
      kind: "open",
      network: "mainnet",
      walletId: "wallet",
      address: ADDRESS,
      clientId: ID,
      cloid: ID,
      childCloids: [],
      nonce: NONCE,
      status: "filled",
      venueStatus: "filled",
      filledSz: "0.01",
      preview: {},
    }
    const f = await fixture({ build: replay })
    expect(await run([...OPEN, "--client-id", ID], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ replayed: true, status: "filled" })
    expect(humanText(f.stderr.text)).toContain(humanText("Nothing was signed or sent"))
    expect(f.calls.some((c) => c.path.endsWith("/sign") || c.host === "api.hyperliquid.xyz")).toBe(false)
    const close = await fixture({ build: { ...replay, kind: "close" } })
    expect(await run(["perps", "close", "BTC", "--client-id", ID, "--yes", "--json"], close.deps)).toBe(0)
    expect(close.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
    // A replay nobody asked for, or for another id, is refused.
    const unasked = await fixture({ build: replay })
    expect(await run(OPEN, unasked.deps)).toBe(1)
    const other = await fixture({ build: { ...replay, clientId: "0xfedcba9876543210fedcba9876543210" } })
    expect(await run([...OPEN, "--client-id", ID], other.deps)).toBe(1)
  })

  test("an API that does not echo the id is refused before signing", async () => {
    for (const build of [buildFor(orderAction()), withId({ clientId: undefined })]) {
      const f = await fixture({ build })
      expect(await run([...OPEN, "--client-id", ID], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim()).code).toBe("PERPS_CLIENT_ID_UNSUPPORTED")
      expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
    }
  })

  test("a malformed id is a usage error before any request", async () => {
    for (const argv of [
      [...OPEN, "--client-id", "0x12"],
      ["perps", "close", "BTC", "--client-id", "nope", "--json"],
    ]) {
      const f = await fixture()
      expect(await run(argv, f.deps)).toBe(2)
      expect(f.calls).toEqual([])
    }
  })
})

describe("fills and funding", () => {
  const fill = (time: number, tid: number, coin = "BTC") => ({
    coin,
    px: "60000.5",
    sz: "0.01",
    side: "B",
    dir: "Open Long",
    time,
    closedPnl: "-1.5",
    fee: "0.3",
    builderFee: "0.06",
    feeToken: "USDC",
    tid,
    oid: tid + 100,
    hash: "0x1",
  })

  test("read directly from Hyperliquid with a read-only key and no signer; Candle only lists the wallets", async () => {
    const f = await fixture({ scopes: ["account:read"], history: () => [fill(5, 1), fill(6, 2, "@107")] })
    f.deps.store = createFakeStore({})
    expect(await run(["perps", "fills", "--start-time", "0", "--end-time", "10", "--json"], f.deps)).toBe(0)
    const page = JSON.parse(f.stdout.text.trim())
    expect(page).toMatchObject({
      success: true,
      walletId: "wallet",
      address: ADDRESS,
      network: "mainnet",
      source: "hyperliquid",
      startTime: 0,
      endTime: 10,
      nextCursor: null,
      hasMore: false,
      truncated: false,
    })
    expect(page.fills.map((r: { tid: number }) => r.tid)).toEqual([1])
    expect(page.fills[0].closedPnl).toBe("-1.5")
    expect(page.warnings[0].code).toBe("PERPS_HISTORY_RETENTION_LIMIT")
    expect(f.calls.filter((c) => c.host !== "api.hyperliquid.xyz").map((c) => c.path)).toEqual([
      "/api/v1/agent/wallets/trading",
    ])
  })

  test("human output: UTC window, two-decimal money, the next-page command", async () => {
    const rows = [fill(1_790_000_000_000, 1), fill(1_790_000_000_001, 2)]
    const f = await fixture({ history: () => rows })
    expect(
      await run(
        ["perps", "fills", "--limit", "1", "--start-time", "1789999999000", "--end-time", "1790000001000"],
        f.deps,
      ),
    ).toBe(0)
    const out = f.stdout.text
    expect(out).toContain("2026-09-21T") // the UTC window
    expect(humanText(out)).toContain(humanText("closed P&L -1.50 (gross), fee 0.30 USDC, builder fee 0.06 (in fee)"))
    expect(humanText(out)).toContain(humanText("Next page: candle perps fills --cursor ph1."))
    expect(humanText(out)).toContain(humanText("10,000 most recent fills"))
  })

  test("funding is signed and labelled", async () => {
    const f = await fixture({
      history: () => [
        {
          time: 5,
          hash: "0xa",
          delta: { type: "funding", coin: "BTC", usdc: "-0.25", szi: "1", fundingRate: "0.0001" },
        },
      ],
    })
    expect(await run(["perps", "funding", "--start-time", "0", "--end-time", "10"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("BTC paid 0.25 USDC, rate 0.0001, position 1"))
    expect(f.calls.find((c) => c.body?.type === "userFunding")?.body).toEqual({
      type: "userFunding",
      user: ADDRESS,
      startTime: 0,
      endTime: 10,
    })
  })

  test("bad bounds, limits and cursors are usage errors before any read", async () => {
    for (const argv of [
      ["perps", "fills", "--start-time", "-5"],
      ["perps", "fills", "--start-time", "10", "--end-time", "5"],
      ["perps", "fills", "--limit", "2001"],
      ["perps", "funding", "--limit", "501"],
      ["perps", "fills", "--limit", "0"],
      ["perps", "fills", "extra"],
    ]) {
      const f = await fixture()
      expect([argv.join(" "), await run([...argv, "--json"], f.deps)]).toEqual([argv.join(" "), 2])
      expect(f.calls).toEqual([])
    }
    const f = await fixture()
    expect(await run(["perps", "fills", "--cursor", "garbage", "--json"], f.deps)).toBe(2)
    expect(f.calls.some((c) => c.host === "api.hyperliquid.xyz")).toBe(false)
  })

  test("a rate limit is PERPS_UNAVAILABLE with retry guidance, never an empty success", async () => {
    const f = await fixture({ history: () => [] })
    const inner = f.deps.fetch
    f.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (body.type === "userFillsByTime") return new Response("", { status: 429, headers: { "retry-after": "3" } })
      return inner(input, init)
    }) as typeof fetch
    expect(await run(["perps", "fills", "--json"], f.deps)).toBe(1)
    const out = JSON.parse(f.stdout.text.trim())
    expect(out.code).toBe("PERPS_UNAVAILABLE")
    expect(out.suggestion).toContain("Retry after 3s")
  })
})
