/**
 * BE-3771 (HM2): `candle perps spot` against a routed fake of the perps server half and of
 * Hyperliquid. A spot write is built by Candle, checked here against this machine's own read of
 * `spotMetaAndAssetCtxs`, relay-signed and posted to Hyperliquid by this machine; a dishonest build
 * reaches neither the relay nor Hyperliquid.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hyperliquidActionHash, hyperliquidL1TypedData } from "../hyperliquid"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const SPOT = JSON.parse(readFileSync(join(import.meta.dir, "../__fixtures__/hyperliquid-spot.json"), "utf8")) as {
  meta: unknown
  ctxs: unknown[]
}
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

const buyAction = (asset = 10_107, extra: Record<string, unknown> = {}) => ({
  type: "order",
  orders: [{ a: asset, b: true, p: "69.488", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID }],
  grouping: "na",
  ...extra,
})

function buildFor(action: Record<string, unknown>) {
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: "spotOrder",
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
      market: "HYPE/USDC",
      coin: "@107",
      side: "buy",
      terms: { venue: "hyperliquid-spot", base: "HYPE", quote: "USDC", takerFeePct: "0.07", makerFeePct: "0.04" },
    },
  }
}

async function fixture(build: Record<string, unknown> = buildFor(buyAction())) {
  const dir = await mkdtemp(join(tmpdir(), "candle-spot-"))
  folders.push(dir)
  const calls: { host: string; path: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ host: url.host, path: url.pathname, body })
    const ok = (value: unknown) => Response.json(value)
    if (url.host === "api.hyperliquid.xyz" && url.pathname === "/info") {
      if (body.type === "spotMetaAndAssetCtxs") return ok([SPOT.meta, SPOT.ctxs])
      if (body.type === "orderStatus") return ok({ status: "order", order: { order: { coin: "@107", oid: 77 } } })
      return ok(null)
    }
    if (url.host === "api.hyperliquid.xyz")
      return ok({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 1 } }] } } })
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
    if (url.pathname === "/api/v1/agent/perps/spot/markets")
      return ok({ success: true, markets: [{ market: "HYPE/USDC", coin: "@107", asset: 10_107, midPx: "68.8" }] })
    if (url.pathname.startsWith("/api/v1/agent/perps/")) return ok(build)
    if (url.pathname.endsWith("/sign")) return ok({ success: true, signature: SIGNATURE })
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_HYPERLIQUID_BUILDER: BUILDER },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    promptLine: async () => "y",
  })
  return { deps, calls, stdout, stderr }
}

const BUY = ["perps", "spot", "buy", "HYPE/USDC", "1", "--yes", "--json"]

describe("candle perps spot buy", () => {
  test("built, checked against Hyperliquid's own spot read, relay-signed, posted to Hyperliquid", async () => {
    const f = await fixture()
    expect(await run(BUY, f.deps)).toBe(0)
    expect(f.calls.map((c) => `${c.host === "api.hyperliquid.xyz" ? "hl:" : ""}${c.path}`)).toEqual([
      "/api/v1/agent/wallets/trading",
      "/api/v1/agent/perps/spot/order",
      "hl:/info",
      "/api/v1/agent/wallets/wallet/sign",
      "hl:/exchange",
    ])
    expect(f.calls[1]?.body).toEqual({
      walletId: "wallet",
      market: "HYPE/USDC",
      side: "buy",
      size: "1",
      type: "market",
    })
    expect(f.calls[2]?.body).toEqual({ type: "spotMetaAndAssetCtxs" })
  })

  test("a build on another pair's asset, or with a builder field on a buy, reaches neither the relay nor Hyperliquid", async () => {
    for (const action of [buyAction(10_142), buyAction(10_107, { builder: { b: BUILDER, f: 100 } }), buyAction(0)]) {
      const f = await fixture(buildFor(action))
      expect(await run(BUY, f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "PERPS_BUILD_REFUSED" })
      expect(f.calls.some((c) => c.path.endsWith("/sign") || c.path === "/exchange")).toBe(false)
    }
  })

  test("the embedded wallet, a malformed pair or size, and a bad tif are usage errors with nothing requested", async () => {
    for (const argv of [
      [...BUY, "--wallet", "embedded"],
      ["perps", "spot", "buy", "HYPE", "1", "--json"],
      ["perps", "spot", "buy", "HYPE/USDC", "1e3", "--json"],
      ["perps", "spot", "buy", "HYPE/USDC", "1", "--tif", "Gtc", "--json"],
      ["perps", "spot", "buy", "HYPE/USDC", "1", "--client-id", "0x12", "--json"],
      ["perps", "spot", "trade", "--json"],
    ]) {
      const f = await fixture()
      expect(await run(argv, f.deps)).toBe(2)
      expect(f.calls.some((c) => c.path.startsWith("/api/v1/agent/perps/"))).toBe(false)
    }
  })
})

describe("BE-4215: --hide on spot orders", () => {
  const signedOrPosted = (f: { calls: { host: string; path: string }[] }) =>
    f.calls.some((c) => c.path.endsWith("/sign") || (c.host === "api.hyperliquid.xyz" && c.path === "/exchange"))

  test("buy --hide sends hide: true, and an echoed build is signed and posted", async () => {
    const f = await fixture({ ...buildFor(buyAction()), hide: true })
    expect(await run([...BUY, "--hide"], f.deps)).toBe(0)
    expect(f.calls[1]?.body).toEqual({
      walletId: "wallet",
      market: "HYPE/USDC",
      side: "buy",
      size: "1",
      type: "market",
      hide: true,
    })
    expect(signedOrPosted(f)).toBe(true)
  })

  test("without --hide the body carries no hide key", async () => {
    const f = await fixture()
    expect(await run(BUY, f.deps)).toBe(0)
    expect(f.calls[1]?.body).not.toHaveProperty("hide")
  })

  test("a build without the hide echo is refused before signing, for a buy and a sell", async () => {
    for (const side of ["buy", "sell"]) {
      const f = await fixture()
      expect(await run(["perps", "spot", side, "HYPE/USDC", "1", "--hide", "--yes", "--json"], f.deps)).toBe(1)
      expect(f.calls[1]?.body).toMatchObject({ side, hide: true })
      expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ ok: false, code: "HIDE_NOT_CONFIRMED" })
      expect(signedOrPosted(f)).toBe(false)
    }
  })

  test("the usage line names --hide", async () => {
    const f = await fixture()
    expect(await run(["perps", "spot", "--json"], f.deps)).toBe(2)
    expect(`${f.stdout.text}${f.stderr.text}`).toContain("[--hide]")
  })
})

describe("candle perps spot reads and cancel", () => {
  test("markets reads the server's spot market list", async () => {
    const f = await fixture()
    expect(await run(["perps", "spot", "markets", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim()).markets[0]).toMatchObject({ market: "HYPE/USDC", asset: 10_107 })
  })

  test("cancel checks the target against Hyperliquid's orderStatus before signing", async () => {
    const cancel = { type: "cancel", cancels: [{ a: 10_107, o: 77 }] }
    const honest = await fixture({ ...buildFor(cancel), kind: "spotCancel" })
    expect(await run(["perps", "spot", "cancel", CLOID, "--yes", "--json"], honest.deps)).toBe(0)
    const wrong = await fixture({
      ...buildFor({ type: "cancel", cancels: [{ a: 10_107, o: 78 }] }),
      kind: "spotCancel",
    })
    expect(await run(["perps", "spot", "cancel", CLOID, "--yes", "--json"], wrong.deps)).toBe(1)
    expect(wrong.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
  })
})
