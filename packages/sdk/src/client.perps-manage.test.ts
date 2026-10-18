/**
 * BE-1584 (spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md, sections 3, 5, 7, 8
 * and 9): the SDK's management methods. A routed fake of Candle and Hyperliquid: each test checks
 * the request a method sends, that bad input throws before any request, and what the answer carries
 * (the venue's per-leg outcome, the scheduled cancel's acknowledgement, the requested and confirmed
 * margin mode, the owner credential on the owner's reduce-only route).
 */
import { describe, expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CANDLE_HYPERLIQUID_BUILDER_ADDRESS, hyperliquidActionHash, hyperliquidL1TypedData } from "./hyperliquid"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
const WALLET = "wallet-123"
const PRIVY_WALLET = "privy-wallet-123"
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
const NONCE = 1_790_000_000_000
const REF = { walletId: WALLET, privyWalletId: PRIVY_WALLET }

interface Call {
  url: string
  method: string
  body?: Record<string, unknown>
  headers: Headers
}

function stamp(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    perpOrderId: "perp-1",
    kind: "x",
    network: "mainnet",
    walletId: WALLET,
    address: ADDRESS,
    nonce: NONCE,
    action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NONCE), "mainnet"),
    preview: { coin: "BTC" },
    ...extra,
  }
}

async function client(route: (call: Call) => unknown, opts: { releasePin?: boolean } = {}) {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set(WALLET, privateKeyPem)
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      headers: new Headers(init?.headers),
    }
    calls.push(call)
    const answer = route(call)
    if (answer instanceof Response) return answer
    if (answer === undefined) throw new Error(`unexpected ${call.method} ${call.url}`)
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return {
    calls,
    client: new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "cndl_test_key",
      fetch: impl,
      privyAppId: "app-test",
      secretStore: store,
      ...(opts.releasePin ? {} : { hyperliquidBuilder: BUILDER }),
    }),
  }
}

/** Hyperliquid's public reads, for a wallet holding `positions` and resting `orders`. */
function venue(call: Call, opts: { positions?: unknown[]; orders?: unknown[]; leverage?: unknown } = {}) {
  if (!call.url.endsWith("hyperliquid.xyz/info")) return undefined
  const type = call.body?.type
  const universe = [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }]
  if (type === "metaAndAssetCtxs") return [{ universe }, [{ markPx: "60000", midPx: "60000" }]]
  if (type === "meta") return { universe }
  if (type === "clearinghouseState") return { assetPositions: opts.positions ?? [] }
  if (type === "frontendOpenOrders") return opts.orders ?? []
  if (type === "activeAssetData") return { leverage: opts.leverage ?? { type: "cross", value: 10 } }
  return undefined
}

const relay = (call: Call) => (call.url.endsWith("/sign") ? { success: true, signature: SIGNATURE } : undefined)
const wallets = (call: Call) =>
  call.url.endsWith("/api/v1/agent/wallets/trading")
    ? { page: [{ id: WALLET, address: ADDRESS, chain: "evm" }], isDone: true }
    : undefined

describe("scheduled cancel", () => {
  test("set: the request, the venue's per-leg outcome, and the acknowledgement Candle records", async () => {
    const now = Date.now()
    const { client: c, calls } = await client(
      (call) =>
        venue(call) ??
        relay(call) ??
        (call.url.endsWith("/perps/schedule-cancel")
          ? stamp({ type: "scheduleCancel", time: now + 60_000 }, { kind: "scheduleCancel" })
          : call.url.endsWith("/schedule-cancel/ack")
            ? { success: true, acknowledged: true }
            : call.url.endsWith("/exchange")
              ? { status: "ok", response: { type: "default" } }
              : undefined),
    )
    const result = await c.perpsScheduleCancel({ ...REF, seconds: 60 })
    expect(result).toMatchObject({ submitted: true, acknowledged: true, outcome: { status: "confirmed" } })
    expect(calls.find((x) => x.url.endsWith("/perps/schedule-cancel"))?.body).toEqual({ walletId: WALLET, seconds: 60 })
    expect(calls.find((x) => x.url.endsWith("/ack"))?.body).toMatchObject({
      perpOrderId: "perp-1",
      exchange: { status: "ok" },
    })
  })

  test("a venue refusal is PERPS_SCHEDULE_CANCEL_REJECTED and nothing is acknowledged", async () => {
    const { client: c, calls } = await client(
      (call) =>
        venue(call) ??
        relay(call) ??
        (call.url.endsWith("/perps/schedule-cancel")
          ? stamp({ type: "scheduleCancel" })
          : call.url.endsWith("/exchange")
            ? { status: "err", response: "Too many cancels scheduled today" }
            : undefined),
    )
    const result = await c.perpsScheduleCancel({ ...REF, clear: true })
    expect(result.submitError).toContain("PERPS_SCHEDULE_CANCEL_REJECTED")
    expect(result.acknowledged).toBeUndefined()
    expect(calls.some((x) => x.url.endsWith("/ack"))).toBe(false)
  })

  test("neither or both of seconds and clear throws before any request", async () => {
    const { client: c, calls } = await client(() => undefined)
    await expect(c.perpsScheduleCancel({ ...REF } as never)).rejects.toThrow("give seconds")
    await expect(c.perpsScheduleCancel({ ...REF, seconds: 60, clear: true } as never)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe("margin mode, percentage close", () => {
  test("mode without leverage keeps the current one, and both modes are reported", async () => {
    const action = { type: "updateLeverage", asset: 0, isCross: false, leverage: 7 }
    const { client: c, calls } = await client(
      (call) =>
        venue(call, { leverage: { type: "cross", value: 7 } }) ??
        relay(call) ??
        (call.url.endsWith("/perps/leverage")
          ? stamp(action, { kind: "leverage" })
          : call.url.endsWith("/exchange")
            ? { status: "ok", response: { type: "default" } }
            : undefined),
    )
    const result = await c.perpsLeverage({ ...REF, coin: "BTC", mode: "isolated" })
    expect(calls.find((x) => x.url.endsWith("/perps/leverage"))?.body).toEqual({
      walletId: WALLET,
      coin: "BTC",
      mode: "isolated",
    })
    expect(result).toMatchObject({
      requestedMode: "isolated",
      confirmedMode: "cross",
      outcome: { status: "confirmed" },
    })
  })

  test("leverage and mode both missing, or pct with size, throw before any request", async () => {
    const { client: c, calls } = await client(() => undefined)
    await expect(c.perpsLeverage({ ...REF, coin: "BTC" })).rejects.toThrow("leverage is required")
    await expect(c.perpsClose({ ...REF, coin: "BTC", pct: "25", size: "1" })).rejects.toThrow("not both")
    expect(calls).toEqual([])
  })
})

describe("reduce-only", () => {
  test("read and turn on with the key; the owner's route sends the bearer token and no API key", async () => {
    const { client: c, calls } = await client((call) =>
      call.url.endsWith("/keys/self/perps-reduce-only")
        ? {
            success: true,
            keyPrefix: "K",
            perpsReduceOnly: call.method === "PUT",
            perpsPolicyVersion: call.method === "PUT" ? 1 : 0,
          }
        : call.url.endsWith("/keys/AbCd1234/perps-reduce-only")
          ? { success: true, keyPrefix: "AbCd1234", perpsReduceOnly: false, perpsPolicyVersion: 2 }
          : undefined,
    )
    expect(await c.getPerpsReduceOnly()).toMatchObject({ perpsReduceOnly: false })
    expect(await c.setPerpsReduceOnly(true)).toMatchObject({ perpsReduceOnly: true, perpsPolicyVersion: 1 })
    expect(calls[1]).toMatchObject({ method: "PUT", body: { perpsReduceOnly: true } })
    await c.setKeyPerpsReduceOnly("AbCd1234", false, { bearerToken: "cndl_dvc_owner" })
    const owner = calls[2] as Call
    expect(owner.headers.get("authorization")).toBe("Bearer cndl_dvc_owner")
    expect(owner.headers.get("x-api-key")).toBeNull()
    expect(owner.body).toEqual({ perpsReduceOnly: false })
  })
})

describe("plans", () => {
  test("flatten on an empty wallet: complete, nothing built or signed", async () => {
    const { client: c, calls } = await client(
      (call) =>
        venue(call) ??
        wallets(call) ??
        (call.url.endsWith("/keys/self/perps-reduce-only")
          ? { success: true, keyPrefix: "K", perpsReduceOnly: false, perpsPolicyVersion: 0 }
          : undefined),
    )
    const result = await c.perpsFlatten(REF)
    expect(result).toMatchObject({ operation: "flatten", complete: true, steps: [], scope: "main-perps" })
    expect(calls.some((x) => x.url.endsWith("/sign"))).toBe(false)
  })

  test("tpsl attaches a leg, and a failed reduce-only read checks the plan as reduce-only", async () => {
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
    const { client: c, calls } = await client(
      (call) =>
        venue(call, {
          positions: [{ position: { coin: "BTC", szi: "0.5", leverage: { type: "cross", value: 10 } } }],
        }) ??
        wallets(call) ??
        relay(call) ??
        (call.url.endsWith("/keys/self/perps-reduce-only")
          ? new Response("{}", { status: 503 })
          : call.url.includes("/perps/tpsl?")
            ? { coin: "BTC", tracked: [], unowned: [] }
            : call.url.endsWith("/perps/tpsl")
              ? stamp(leg, { kind: "tpsl" })
              : call.url.endsWith("/exchange")
                ? { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } }
                : undefined),
    )
    const result = await c.perpsTpsl({ ...REF, coin: "BTC", takeProfit: "66000" })
    expect(result.complete).toBe(true)
    expect(calls.find((x) => x.method === "POST" && x.url.endsWith("/perps/tpsl"))?.body).toMatchObject({
      walletId: WALLET,
      coin: "BTC",
      operation: "attach",
      leg: "tp",
      triggerPx: "66000",
    })
  })
})

describe("fee-bearing management orders use C's release pin (spec D, section 4)", () => {
  const attach = (builder: string) => ({
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
    builder: { b: builder, f: 100 },
  })
  const route = (builder: string) => (call: Call) =>
    venue(call, { positions: [{ position: { coin: "BTC", szi: "0.5", leverage: { type: "cross", value: 10 } } }] }) ??
    wallets(call) ??
    relay(call) ??
    (call.url.endsWith("/keys/self/perps-reduce-only")
      ? { success: true, keyPrefix: "K", perpsReduceOnly: false, perpsPolicyVersion: 0 }
      : call.url.includes("/perps/tpsl?")
        ? { coin: "BTC", tracked: [], unowned: [] }
        : call.url.endsWith("/perps/tpsl")
          ? stamp(attach(builder), { kind: "tpsl" })
          : call.url.endsWith("/exchange")
            ? { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } }
            : call.url.endsWith("/perps/config")
              ? { success: true, builder }
              : undefined)

  test("with no override, a leg naming any other builder is refused before the relay; the pinned one signs", async () => {
    const other = await client(route(BUILDER), { releasePin: true })
    const refused = await other.client.perpsTpsl({ ...REF, coin: "BTC", takeProfit: "66000" })
    expect(refused.complete).toBe(false)
    expect(refused.steps[0]).toMatchObject({ status: "rejected" })
    expect(refused.steps[0]?.detail).toContain("not Candle's")
    expect(other.calls.some((x) => x.url.endsWith("/sign"))).toBe(false)
    expect(other.calls.some((x) => x.url.endsWith("/perps/config"))).toBe(false)

    const pinned = await client(route(CANDLE_HYPERLIQUID_BUILDER_ADDRESS), { releasePin: true })
    expect((await pinned.client.perpsTpsl({ ...REF, coin: "BTC", takeProfit: "66000" })).complete).toBe(true)
  })
})
