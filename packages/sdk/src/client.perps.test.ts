import { describe, expect, test } from "bun:test"
import { CandleClient, type CandleClientOptions, type PerpsBuild } from "./client"
import { hyperliquidActionHash, hyperliquidApproveBuilderFeeTypedData, hyperliquidL1TypedData } from "./hyperliquid"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const OTHER = "0x1111111111111111111111111111111111111111"
const WALLET = "wallet-123"
const PRIVY_WALLET = "privy-wallet-123"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`

interface Recorded {
  url: string
  body?: unknown
}

function fakeFetch(responses: Response[]) {
  const calls: Recorded[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const next = responses.shift()
    if (!next) throw new Error("no response queued")
    return next
  }) as unknown as typeof fetch
  return { calls, impl }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function client(responses: Response[], opts: Partial<CandleClientOptions> = {}) {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set(WALLET, privateKeyPem)
  const { calls, impl } = fakeFetch(responses)
  return {
    calls,
    client: new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "cndl_test_key",
      fetch: impl,
      privyAppId: "app-test",
      secretStore: store,
      hyperliquidBuilder: BUILDER,
      ...opts,
    }),
  }
}

function orderBuild(action?: Record<string, unknown>): PerpsBuild {
  const a = action ?? {
    type: "order",
    orders: [
      { a: 0, b: true, p: "60600", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: `0x${"1".repeat(32)}` },
    ],
    grouping: "na",
    builder: { b: BUILDER, f: 100 },
  }
  const nonce = 1_790_000_000_000
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: "open",
    network: "mainnet",
    walletId: WALLET,
    address: "0x14791697260e4c9a71f18484c9f997b308e59325",
    nonce,
    action: a,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(a, nonce), "mainnet"),
    claimHash: "h",
    cloid: `0x${"1".repeat(32)}`,
    notionalUsdMicros: 606_000_000,
    reservedUsdMicros: 606_000_000,
    windowKey: "daily:1",
    builder: { address: BUILDER, feeTenthsBps: 100 },
    exchangeUrl: "https://evil.example/exchange",
    preview: {},
  }
}

const OPEN = { walletId: WALLET, privyWalletId: PRIVY_WALLET, coin: "BTC", side: "long" as const, size: "0.01" }

describe("perpsOpen: build, check, sign, submit", () => {
  test("an honest build is signed through the relay and posted to Hyperliquid's own endpoint", async () => {
    const build = orderBuild()
    const { client: c, calls } = await client([
      json(200, build),
      json(200, { success: true, signature: SIGNATURE }),
      json(200, { status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 1 } }] } } }),
    ])
    const result = await c.perpsOpen(OPEN)
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/agent/perps/open",
      `https://api.test/api/v1/agent/wallets/${WALLET}/sign`,
      // Never the server's exchangeUrl.
      "https://api.hyperliquid.xyz/exchange",
    ])
    expect(calls[0]?.body).toEqual({ walletId: WALLET, coin: "BTC", side: "long", size: "0.01" })
    const relay = calls[1]?.body as { authorizationSignature: string; body: unknown }
    expect(relay.body).toEqual({ method: "eth_signTypedData_v4", params: { typed_data: build.typedData } })
    expect(relay.authorizationSignature.length).toBeGreaterThan(0)
    expect(calls[2]?.body).toEqual({
      action: build.action,
      nonce: build.nonce,
      signature: { r: `0x${"a".repeat(64)}`, s: `0x${"b".repeat(64)}`, v: 28 },
      vaultAddress: null,
      expiresAfter: null,
    })
    expect(result).toMatchObject({ signature: SIGNATURE, submitted: true, exchange: { status: "ok" } })
  })

  test("a dishonest build is refused with no relay call: another action type, another builder, a swapped action", async () => {
    const vault = orderBuild({ type: "vaultTransfer", vaultAddress: OTHER, isDeposit: true, usd: 1_000_000 })
    const otherBuilder = orderBuild({ type: "order", orders: [], grouping: "na", builder: { b: OTHER, f: 100 } })
    const swapped = { ...orderBuild(), action: { type: "order", orders: [], grouping: "na" } }
    for (const build of [vault, otherBuilder, swapped]) {
      const { client: c, calls } = await client([json(200, build)])
      await expect(c.perpsOpen(OPEN)).rejects.toThrow("refused to sign")
      expect(calls).toHaveLength(1)
    }
  })

  test("submit: false stops after the check, signing nothing", async () => {
    const { client: c, calls } = await client([json(200, orderBuild())])
    const result = await c.perpsOpen({ ...OPEN, submit: false })
    expect(result).toMatchObject({ signature: null, submitted: false })
    expect(calls).toHaveLength(1)
  })

  test("a failed submit keeps the signature for a retry", async () => {
    const { client: c } = await client([
      json(200, orderBuild()),
      json(200, { success: true, signature: SIGNATURE }),
      json(502, { error: "bad gateway" }),
    ])
    const result = await c.perpsOpen(OPEN)
    expect(result).toMatchObject({ signature: SIGNATURE, submitted: false })
    expect(result.submitError).toContain("502")
  })

  test("a relay answer that is not a signature throws", async () => {
    const { client: c } = await client([json(200, orderBuild()), json(200, { success: true })])
    await expect(c.perpsOpen(OPEN)).rejects.toThrow("no signature")
  })

  test("a build for testnet is refused by a mainnet client", async () => {
    const build = { ...orderBuild(), network: "testnet" as const }
    const { client: c, calls } = await client([json(200, build)])
    await expect(c.perpsOpen(OPEN)).rejects.toThrow("refused to sign")
    expect(calls).toHaveLength(1)
  })
})

describe("the builder pin", () => {
  test("without a pinned builder the client trusts the server's first answer and holds builds to it", async () => {
    const { client: c, calls } = await client(
      [
        json(200, orderBuild()),
        json(200, { success: true, builder: BUILDER }),
        json(200, { success: true, signature: SIGNATURE }),
        json(200, { status: "ok" }),
      ],
      { hyperliquidBuilder: undefined },
    )
    await c.perpsOpen(OPEN)
    expect(calls[1]?.url).toBe("https://api.test/api/v1/agent/perps/config")
  })
})

describe("perpsSetup", () => {
  test("ready: no build, nothing signed", async () => {
    const status = {
      success: true,
      ready: true,
      walletId: WALLET,
      address: "0xabc",
      network: "mainnet",
      mode: "default",
      standardMode: true,
      accountValue: "10",
      withdrawable: "10",
      builder: BUILDER,
      approvedFeeTenthsBps: 100,
    }
    const { client: c, calls } = await client([json(200, status)])
    const result = await c.perpsSetup({ walletId: WALLET, privyWalletId: PRIVY_WALLET })
    expect(result.ready).toBe(true)
    expect(result.action).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test("not ready: the approval is checked against the pinned builder, then signed and submitted", async () => {
    const nonce = 1_790_000_000_001
    const setup = {
      ...orderBuild(),
      kind: "setup",
      nonce,
      typedData: hyperliquidApproveBuilderFeeTypedData(BUILDER, nonce),
      action: {
        type: "approveBuilderFee",
        hyperliquidChain: "Mainnet",
        signatureChainId: "0xa4b1",
        maxFeeRate: "0.1%",
        builder: BUILDER,
        nonce,
      },
      ready: false,
      mode: "default",
      standardMode: true,
      accountValue: "0",
      withdrawable: "0",
      approvedFeeTenthsBps: 0,
    }
    const { client: c, calls } = await client([
      json(200, { ...setup, builder: BUILDER }),
      json(200, { success: true, signature: SIGNATURE }),
      json(200, { status: "ok", response: { type: "default" } }),
    ])
    const result = await c.perpsSetup({ walletId: WALLET, privyWalletId: PRIVY_WALLET })
    expect(result.ready).toBe(false)
    expect(result.action?.submitted).toBe(true)
    expect((calls[2]?.body as { action: unknown }).action).toEqual(setup.action)
  })

  test("an approval for another builder is refused", async () => {
    const nonce = 7
    const setup = {
      ...orderBuild(),
      nonce,
      typedData: hyperliquidApproveBuilderFeeTypedData(OTHER, nonce),
      action: {
        type: "approveBuilderFee",
        hyperliquidChain: "Mainnet",
        signatureChainId: "0xa4b1",
        maxFeeRate: "0.1%",
        builder: OTHER,
        nonce,
      },
      ready: false,
      builder: OTHER,
    }
    const { client: c, calls } = await client([json(200, setup)])
    await expect(c.perpsSetup({ walletId: WALLET, privyWalletId: PRIVY_WALLET })).rejects.toThrow("refused to sign")
    expect(calls).toHaveLength(1)
  })
})

describe("reads", () => {
  test("positions, orders, fills and funding pass the wallet id", async () => {
    const { client: c, calls } = await client([
      json(200, { success: true }),
      json(200, { success: true }),
      json(200, { success: true }),
      json(200, { success: true }),
    ])
    await c.perpsPositions(WALLET)
    await c.perpsOrders(WALLET, { limit: 5 })
    await c.perpsFills(WALLET)
    await c.perpsFunding(WALLET, 123)
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.test/api/v1/agent/perps/positions?walletId=${WALLET}`,
      `https://api.test/api/v1/agent/perps/orders?walletId=${WALLET}&limit=5`,
      `https://api.test/api/v1/agent/perps/fills?walletId=${WALLET}`,
      `https://api.test/api/v1/agent/perps/funding?walletId=${WALLET}&startTime=123`,
    ])
  })
})

describe("request intent is checked before the relay", () => {
  test("allowed but wrong method, main-universe asset boundary, side, size and reduce-only tampering", async () => {
    const honest = orderBuild().action as { orders: Record<string, unknown>[] }
    for (const action of [
      { type: "updateLeverage", asset: 0, isCross: true, leverage: 40 },
      ...[{ a: 10000 }, { a: -1 }, { b: false }, { s: "0.02" }, { r: true }].map((change) => ({
        ...orderBuild().action,
        orders: [{ ...honest.orders[0], ...change }],
      })),
      { ...orderBuild().action, orders: [...honest.orders, { ...honest.orders[0], a: 10000, r: true }] },
    ]) {
      const { client: c, calls } = await client([json(200, orderBuild(action))])
      await expect(c.perpsOpen(OPEN)).rejects.toThrow("refused to sign")
      expect(calls).toHaveLength(1)
    }
  })

  test("leverage and margin amounts must equal the request", async () => {
    for (const action of [
      { type: "updateLeverage", asset: 0, isCross: true, leverage: 4 },
      { type: "updateLeverage", asset: 0, isCross: false, leverage: 3 },
      { type: "updateLeverage", asset: 10000, isCross: true, leverage: 3 },
    ]) {
      const { client: c, calls } = await client([json(200, orderBuild(action))])
      await expect(c.perpsLeverage({ ...OPEN, leverage: 3 })).rejects.toThrow("refused to sign")
      expect(calls).toHaveLength(1)
    }
    for (const action of [
      { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: 30_000_000 },
      { type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: -25_500_000 },
      { type: "updateIsolatedMargin", asset: 0, isBuy: false, ntli: 25_500_000 },
    ]) {
      const { client: c, calls } = await client([json(200, orderBuild(action))])
      await expect(c.perpsMargin({ ...OPEN, amount: "25.5" })).rejects.toThrow("refused to sign")
      expect(calls).toHaveLength(1)
    }
  })

  test("close must reduce-only and modify must preserve the requested size and price", async () => {
    const { client: c, calls } = await client([json(200, orderBuild())])
    await expect(c.perpsClose({ ...OPEN })).rejects.toThrow("refused to sign")
    expect(calls).toHaveLength(1)
    for (const change of [{ s: "1" }, { p: "60601" }]) {
      const action = {
        type: "modify",
        oid: 7,
        order: { ...(orderBuild().action.orders as Record<string, unknown>[])[0], ...change },
      }
      const { client: m, calls: mc } = await client([json(200, orderBuild(action))])
      await expect(m.perpsModify({ ...OPEN, cloid: `0x${"1".repeat(32)}`, price: "60600" })).rejects.toThrow(
        "refused to sign",
      )
      expect(mc).toHaveLength(1)
    }
  })
})

test("SDK closes verify the side and exact clamped size from venue state", async () => {
  for (const change of [{ b: false }, { s: "0.4" }, {}]) {
    const action = {
      ...orderBuild().action,
      orders: [{ ...(orderBuild().action.orders as Record<string, unknown>[])[0], r: true, s: "0.5", ...change }],
    }
    const { client: c, calls } = await client([
      json(200, orderBuild(action)),
      json(200, { universe: [{ name: "BTC" }] }),
      json(200, { assetPositions: [{ position: { coin: "BTC", szi: "-0.5" } }] }),
    ])
    const request = { ...OPEN, size: "2", submit: false }
    if (Object.keys(change).length) await expect(c.perpsClose(request)).rejects.toThrow("refused to sign")
    else expect((await c.perpsClose(request)).signature).toBeNull()
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/agent/perps/close",
      "https://api.hyperliquid.xyz/info",
      "https://api.hyperliquid.xyz/info",
    ])
  }
})
