/**
 * BE-1584 (spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md, sections 3 and 11):
 * `candle perps modify | margin | tpsl | schedule-cancel | flatten | reduce-only` and `close --pct`,
 * against a routed fake of Candle and a small simulated Hyperliquid. What each proves: the body each
 * command sends, that bad input exits 2 before any request, that the plan is confirmed once (and
 * refused without --yes off a TTY), the exit codes (0 confirmed, 1 refused or incomplete, 3 an
 * unanswered signed submit), and which credential each reduce-only write uses.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { humanText } from "../human-output.test-support"
import { hyperliquidActionHash, hyperliquidL1TypedData } from "../hyperliquid"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1b`
const CLOID = `0x${"1".repeat(32)}`
const NONCE = 1_790_000_000_000
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function stamp(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: "x",
    network: "mainnet",
    walletId: "wallet",
    address: ADDRESS,
    nonce: NONCE,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
    preview: {},
    ...extra,
  }
}

interface Venue {
  positions: { coin: string; szi: string; leverage?: { type: string; value: number } }[]
  orders: Record<string, unknown>[]
  resting?: Record<string, unknown>
  leverage?: { type: string; value: number }
}

interface Options {
  venue?: Partial<Venue>
  build?: (path: string, body: Record<string, unknown>) => unknown
  exchange?: (action: Record<string, unknown>) => Response | Error
  reduceOnly?: Record<string, unknown> | null
  reduceOnlyWrite?: Record<string, unknown> | Response
  deviceToken?: boolean
  tty?: boolean
}

async function fixture(opts: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-perps-manage-"))
  folders.push(dir)
  const venue: Venue = { positions: [], orders: [], ...opts.venue }
  const calls: {
    host: string
    path: string
    method: string
    body: Record<string, unknown> | undefined
    auth?: string
  }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers = new Headers(init?.headers)
    calls.push({
      host: url.host,
      path: url.pathname,
      method: init?.method ?? "GET",
      body,
      auth: headers.get("authorization") ?? undefined,
    })
    const ok = (value: unknown) => Response.json(value)
    if (url.host === "api.hyperliquid.xyz" && url.pathname === "/info") {
      const universe = [
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "SOL", szDecimals: 3, maxLeverage: 20 },
      ]
      if (body.type === "meta") return ok({ universe })
      if (body.type === "metaAndAssetCtxs")
        return ok([
          { universe },
          [
            { midPx: "60000", markPx: "60000" },
            { midPx: "150", markPx: "150" },
          ],
        ])
      if (body.type === "clearinghouseState")
        return ok({
          assetPositions: venue.positions.map((p) => ({ position: { leverage: { type: "cross", value: 10 }, ...p } })),
        })
      if (body.type === "frontendOpenOrders") return ok(venue.orders)
      if (body.type === "orderStatus") return ok({ status: "order", order: { order: venue.resting } })
      if (body.type === "activeAssetData") return ok({ leverage: venue.leverage ?? { type: "cross", value: 10 } })
      throw new Error(`unexpected info ${body.type}`)
    }
    if (url.host === "api.hyperliquid.xyz") {
      const answer = opts.exchange?.(body.action) ?? ok({ status: "ok", response: { type: "default" } })
      if (answer instanceof Error) throw answer
      return answer
    }
    if (url.pathname === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["perps:write"],
        privyAppId: "app",
        page: [
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
    if (url.pathname === "/api/v1/agent/keys/self/perps-reduce-only") {
      if (init?.method === "PUT") {
        const w = opts.reduceOnlyWrite ?? {
          success: true,
          keyPrefix: "SelfKey1",
          perpsReduceOnly: true,
          perpsPolicyVersion: 1,
        }
        return w instanceof Response ? w : ok(w)
      }
      if (opts.reduceOnly === null) return new Response("{}", { status: 503 })
      return ok(
        opts.reduceOnly ?? { success: true, keyPrefix: "SelfKey1", perpsReduceOnly: false, perpsPolicyVersion: 0 },
      )
    }
    if (/^\/api\/v1\/agent\/keys\/[A-Za-z0-9]+\/perps-reduce-only$/.test(url.pathname))
      return ok({
        success: true,
        keyPrefix: url.pathname.split("/")[5],
        perpsReduceOnly: body.perpsReduceOnly,
        perpsPolicyVersion: 2,
      })
    if (url.pathname === "/api/v1/agent/perps/config") return ok({ success: true, builder: BUILDER })
    if (url.pathname === "/api/v1/agent/perps/schedule-cancel/ack") return ok({ success: true, acknowledged: true })
    if (url.pathname.startsWith("/api/v1/agent/perps/")) {
      const built = opts.build?.(url.pathname, body)
      if (built instanceof Response) return built
      if (built !== undefined) return ok(built)
    }
    if (url.pathname.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      CANDLE_HYPERLIQUID_BUILDER: BUILDER,
      ...(opts.deviceToken ? { CANDLE_DEVICE_TOKEN: "cndl_dvc_owner" } : {}),
    },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    promptLine: async () => "y",
    ...(opts.tty === false ? { isTTY: { stdin: false, stdout: false, stderr: false } } : {}),
  })
  const candle = () => calls.filter((c) => c.host !== "api.hyperliquid.xyz")
  return { deps, calls, candle, stdout, stderr, venue }
}

const sent = (f: Awaited<ReturnType<typeof fixture>>, suffix: string) =>
  f.calls.find((c) => c.path.endsWith(suffix) && c.method === "POST")?.body

describe("usage is checked before any request (exit 2)", () => {
  for (const argv of [
    ["perps", "modify", "--cloid", CLOID],
    ["perps", "modify", "--cloid", "0x12", "--price", "1"],
    ["perps", "margin", "BTC"],
    ["perps", "margin", "BTC", "--amount", "5", "--mode", "cross"],
    ["perps", "margin", "BTC", "--amount", "-5"],
    ["perps", "margin", "BTC", "--amount", "0"],
    ["perps", "margin", "BTC", "--amount", "1.1234567"],
    ["perps", "margin", "BTC", "--mode", "portfolio"],
    ["perps", "schedule-cancel", "4"],
    ["perps", "schedule-cancel", "60", "--clear"],
    ["perps", "schedule-cancel"],
    ["perps", "close", "BTC", "--pct", "0"],
    ["perps", "close", "BTC", "--pct", "101"],
    ["perps", "close", "BTC", "--pct", "25", "--size", "1"],
    ["perps", "tpsl", "BTC"],
    ["perps", "tpsl", "BTC", "--take-profit", "1", "--remove-tp"],
    ["perps", "tpsl", "BTC", "--target-tp", CLOID],
    ["perps", "reduce-only", "maybe"],
  ])
    test(argv.slice(1).join(" "), async () => {
      const f = await fixture()
      expect(await run([...argv, "--json"], f.deps)).toBe(2)
      expect(f.calls).toEqual([])
    })
})

describe("single management actions", () => {
  test("modify sends the cloid and the new price; the replacement is checked against the resting order", async () => {
    const resting = { coin: "BTC", side: "A", limitPx: "61000", sz: "0.2", oid: 77, reduceOnly: true, tif: "Gtc" }
    const action = {
      type: "modify",
      oid: 77,
      order: { a: 0, b: false, p: "61500", s: "0.2", r: true, t: { limit: { tif: "Gtc" } }, c: `0x${"2".repeat(32)}` },
    }
    const f = await fixture({ venue: { resting }, build: () => stamp(action, { kind: "modify" }) })
    expect(await run(["perps", "modify", "--cloid", CLOID, "--price", "61500", "--yes", "--json"], f.deps)).toBe(0)
    expect(sent(f, "/perps/modify")).toEqual({ walletId: "wallet", cloid: CLOID, price: "61500" })
    // A replacement that flips the side is refused before the relay.
    const flipped = { ...action, order: { ...action.order, b: true } }
    const g = await fixture({ venue: { resting }, build: () => stamp(flipped) })
    expect(await run(["perps", "modify", "--cloid", CLOID, "--price", "61500", "--yes", "--json"], g.deps)).toBe(1)
    expect(g.stderr.text + g.stdout.text).toContain("PERPS_BUILD_REFUSED")
    expect(g.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("margin --amount tops up; margin --mode keeps leverage and reports both modes", async () => {
    const topUp = { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: 5_000_000 }
    const f = await fixture({
      venue: { positions: [{ coin: "BTC", szi: "0.1", leverage: { type: "isolated", value: 5 } }] },
      build: () => stamp(topUp, { kind: "margin" }),
    })
    expect(await run(["perps", "margin", "BTC", "--amount", "5", "--yes", "--json"], f.deps)).toBe(0)
    expect(sent(f, "/perps/margin")).toEqual({ walletId: "wallet", coin: "BTC", amount: "5" })

    const mode = { type: "updateLeverage", asset: 0, isCross: false, leverage: 7 }
    const g = await fixture({
      venue: { leverage: { type: "cross", value: 7 } },
      build: () => stamp(mode, { kind: "leverage", preview: { coin: "BTC" } }),
    })
    expect(await run(["perps", "margin", "BTC", "--mode", "isolated", "--yes", "--json"], g.deps)).toBe(0)
    expect(sent(g, "/perps/leverage")).toEqual({ walletId: "wallet", coin: "BTC", mode: "isolated" })
    expect(JSON.parse(g.stdout.text.trim())).toMatchObject({ requestedMode: "isolated", confirmedMode: "cross" })
  })

  test("schedule-cancel sets, is acknowledged on Candle, and a venue refusal is PERPS_SCHEDULE_CANCEL_REJECTED", async () => {
    const now = 0 // the test deps' fake clock
    const set = { type: "scheduleCancel", time: now + 60_000 }
    const f = await fixture({
      build: () => stamp(set, { kind: "scheduleCancel", time: set.time, preview: { operation: "set" } }),
    })
    expect(await run(["perps", "schedule-cancel", "60", "--yes", "--json"], f.deps)).toBe(0)
    expect(sent(f, "/perps/schedule-cancel")).toEqual({ walletId: "wallet", seconds: 60 })
    expect(sent(f, "/schedule-cancel/ack")).toMatchObject({
      walletId: "wallet",
      perpOrderId: "perp-1",
      exchange: { status: "ok" },
    })
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ acknowledged: true, verified: false, operation: "set" })

    const g = await fixture({
      build: () => stamp({ type: "scheduleCancel" }, { kind: "scheduleCancel" }),
      exchange: () => Response.json({ status: "err", response: "Too many cancels scheduled today" }),
    })
    expect(await run(["perps", "schedule-cancel", "--clear", "--yes", "--json"], g.deps)).toBe(1)
    expect(sent(g, "/perps/schedule-cancel")).toEqual({ walletId: "wallet", clear: true })
    expect(g.stderr.text + g.stdout.text).toContain("PERPS_SCHEDULE_CANCEL_REJECTED")
  })

  test("a stale scheduled time is refused before signing; rebuild, never re-time", async () => {
    const stale = { type: "scheduleCancel", time: 2_000 }
    const f = await fixture({ build: () => stamp(stale) })
    expect(await run(["perps", "schedule-cancel", "5", "--yes", "--json"], f.deps)).toBe(1)
    expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("close --pct sends the percentage; the client sizes it from its own read and refuses a different size", async () => {
    const close = (s: string) => ({
      type: "order",
      orders: [{ a: 1, b: false, p: "148.5", s, r: true, t: { limit: { tif: "Ioc" } }, c: CLOID }],
      grouping: "na",
      builder: { b: BUILDER, f: 100 },
    })
    const f = await fixture({
      venue: { positions: [{ coin: "SOL", szi: "1.234" }] },
      build: () => stamp(close("0.308")),
    })
    expect(await run(["perps", "close", "SOL", "--pct", "25", "--yes", "--json"], f.deps)).toBe(0)
    expect(sent(f, "/perps/close")).toEqual({ walletId: "wallet", coin: "SOL", pct: "25" })
    const g = await fixture({
      venue: { positions: [{ coin: "SOL", szi: "1.234" }] },
      build: () => stamp(close("0.309")),
    })
    expect(await run(["perps", "close", "SOL", "--pct", "25", "--yes", "--json"], g.deps)).toBe(1)
    expect(g.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })

  test("an answer with no readable leg status is exit 3 with the signed body, never success", async () => {
    const f = await fixture({
      build: () => stamp({ type: "scheduleCancel", time: 60_000 }),
      exchange: () => Response.json({ status: "ok", response: { type: "mystery" } }),
    })
    expect(await run(["perps", "schedule-cancel", "60", "--yes", "--json"], f.deps)).toBe(3)
    expect(f.stderr.text + f.stdout.text).toContain("exchangeBody")
  })
})

describe("plans", () => {
  function tpslBuild(path: string, body: Record<string, unknown>) {
    if (path === "/api/v1/agent/perps/tpsl")
      return stamp(
        {
          type: "order",
          orders: [
            {
              a: 0,
              b: false,
              p: "62700",
              s: "0.5",
              r: true,
              t: { trigger: { isMarket: true, triggerPx: String(body.triggerPx), tpsl: "tp" } },
              c: `0x${"3".repeat(32)}`,
            },
          ],
          grouping: "positionTpsl",
          builder: { b: BUILDER, f: 100 },
        },
        { cloid: `0x${"3".repeat(32)}` },
      )
    return undefined
  }

  test("tpsl attaches after one confirmation and exits 0 with the plan as JSON", async () => {
    // GET /perps/tpsl is a read (no body): answered from the same router.
    const g = await fixture({
      venue: { positions: [{ coin: "BTC", szi: "0.5" }] },
      build: (path, body) => (body === undefined ? { coin: "BTC", tracked: [], unowned: [] } : tpslBuild(path, body)),
    })
    expect(await run(["perps", "tpsl", "BTC", "--take-profit", "66000", "--yes", "--json"], g.deps)).toBe(0)
    const result = JSON.parse(g.stdout.text.trim())
    expect(result).toMatchObject({ operation: "tpsl", complete: true })
    expect(result.steps).toEqual([expect.objectContaining({ kind: "attach", status: "confirmed" })])
    expect(sent(g, "/perps/tpsl")).toMatchObject({
      walletId: "wallet",
      coin: "BTC",
      operation: "attach",
      leg: "tp",
      triggerPx: "66000",
    })
  })

  test("off a TTY without --yes the plan is refused before anything is signed", async () => {
    const f = await fixture({
      tty: false,
      venue: { positions: [{ coin: "BTC", szi: "0.5" }] },
      build: (path, body) => (body === undefined ? { coin: "BTC", tracked: [], unowned: [] } : tpslBuild(path, body)),
    })
    expect(await run(["perps", "tpsl", "BTC", "--take-profit", "66000", "--json"], f.deps)).toBe(1)
    expect(f.stderr.text + f.stdout.text).toContain("CONFIRMATION_REQUIRED")
    expect(f.calls.some((c) => c.path === "/api/v1/agent/perps/tpsl" && c.method === "POST")).toBe(false)
  })

  test("flatten: an empty wallet is flat, exit 0; an unanswered close is exit 3 with its signed body", async () => {
    const f = await fixture()
    expect(await run(["perps", "flatten", "--yes", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({
      operation: "flatten",
      complete: true,
      scope: "main-perps",
    })

    const close = {
      type: "order",
      orders: [{ a: 0, b: false, p: "57000", s: "0.5", r: true, t: { limit: { tif: "Ioc" } }, c: CLOID }],
      grouping: "na",
      builder: { b: BUILDER, f: 100 },
    }
    const g = await fixture({
      venue: { positions: [{ coin: "BTC", szi: "0.5" }] },
      build: (path, body) =>
        path.endsWith("/close") ? stamp({ ...close, orders: [{ ...close.orders[0], c: body.clientId }] }) : undefined,
      exchange: () => new Error("socket hang up"),
    })
    expect(await run(["perps", "flatten", "--yes", "--json"], g.deps)).toBe(3)
    const result = JSON.parse(g.stdout.text.trim())
    expect(result.complete).toBe(false)
    expect(result.steps[0]).toMatchObject({ kind: "close", status: "unknown" })
    expect(result.steps[0].exchangeBody).toBeDefined()
  })
})

describe("reduce-only", () => {
  test("no argument reads this key's setting", async () => {
    const f = await fixture({
      reduceOnly: { success: true, keyPrefix: "SelfKey1", perpsReduceOnly: true, perpsPolicyVersion: 3 },
    })
    expect(await run(["perps", "reduce-only"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Perps reduce-only on Policy version 3"))
  })

  test("on, for this key, uses this key's own credential", async () => {
    const f = await fixture()
    expect(await run(["perps", "reduce-only", "on", "--json"], f.deps)).toBe(0)
    const put = f.calls.find((c) => c.method === "PUT")
    expect(put).toMatchObject({ path: "/api/v1/agent/keys/self/perps-reduce-only", body: { perpsReduceOnly: true } })
  })

  test("off needs the owner's device token; --yes never substitutes", async () => {
    const f = await fixture()
    expect(await run(["perps", "reduce-only", "off", "--json"], f.deps)).toBe(1)
    expect(f.stderr.text + f.stdout.text).toContain("NO_DEVICE_TOKEN")
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false)
    const g = await fixture({ deviceToken: true })
    expect(await run(["perps", "reduce-only", "off", "--key", "AbCd1234", "--json"], g.deps)).toBe(0)
    const put = g.calls.find((c) => c.method === "PUT")
    expect(put).toMatchObject({
      path: "/api/v1/agent/keys/AbCd1234/perps-reduce-only",
      body: { perpsReduceOnly: false },
    })
    expect(put?.auth).toBe("Bearer cndl_dvc_owner")
  })
})
