/**
 * Per-order `hide` (agent-stream card S, design 5.6): sent only when true, forwarded by trade()
 * and swapFromLinked() (which copy fields by name), and refused when the API does not echo it.
 */
import { describe, expect, test } from "bun:test"
import type { BuildAtomicLaunchRequest } from "./client"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"
import { hideField, hideRequested } from "./hide-echo"

const API = "https://api.test"

interface Call {
  url: string
  body: Record<string, unknown> | undefined
}

function client(respond: (call: Call) => unknown) {
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    return new Response(JSON.stringify(respond(call)), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { calls, client: new CandleClient({ apiUrl: API, apiKey: "k", fetch: impl }) }
}

const EXECUTED = { success: true, status: "executed", chain: "solana", signature: "S", clientTradeId: "t-1" }
const TRADE = { mint: "M", side: "buy", amountRaw: "1", from: "main" } as const

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  throw new Error("expected a throw")
}

describe("hide helpers", () => {
  test("the paper truthy set hides; absent and false do not; junk throws", () => {
    for (const v of [true, "true", 1, "1"]) expect(hideRequested(v)).toBe(true)
    for (const v of [undefined, false, null, "false", 0]) expect(hideField(v)).toEqual({})
    expect(() => hideRequested("yes")).toThrow(CandleApiError)
  })
})

describe("trade() and buildTrade()", () => {
  test("trade() forwards hide: true and accepts an echoed response", async () => {
    const { calls, client: c } = client(() => ({ ...EXECUTED, hide: true }))
    await c.trade({ ...TRADE, clientTradeId: "t-1", hide: true })
    expect(calls[0]?.body?.hide).toBe(true)
  })

  test("no body carries the word hide when it is not asked", async () => {
    const { calls, client: c } = client(() => EXECUTED)
    await c.trade({ ...TRADE, clientTradeId: "t-1" })
    await c.trade({ ...TRADE, clientTradeId: "t-1", hide: false })
    for (const call of calls) expect(JSON.stringify(call.body)).not.toContain("hide")
  })

  test("a response without the echo is HIDE_NOT_CONFIRMED", async () => {
    const { client: c } = client(() => EXECUTED)
    const error = await caught(c.trade({ ...TRADE, clientTradeId: "t-1", hide: true }))
    expect(error).toBeInstanceOf(CandleApiError)
    expect((error as CandleApiError).code).toBe("HIDE_NOT_CONFIRMED")
  })

  test("buildTrade() forwards and checks too", async () => {
    const { calls, client: c } = client(() => EXECUTED)
    const error = await caught(
      c.buildTrade({
        clientTradeId: "t-1",
        mint: "M",
        side: "buy",
        amountRaw: "1",
        payer: { type: "main" },
        hide: true,
      }),
    )
    expect((error as CandleApiError).code).toBe("HIDE_NOT_CONFIRMED")
    expect(calls[0]?.body?.hide).toBe(true)
  })
})

describe("swap()", () => {
  const SWAP = { from: "SOL", to: "USDC", amountRaw: "1" } as const
  test("sends hide only when true and needs the echo", async () => {
    const ok = client(() => ({ success: true, hide: true, payload: { hashes: [] } }))
    await ok.client.swap({ ...SWAP, hide: true })
    expect(ok.calls[0]?.body?.hide).toBe(true)

    const plain = client(() => ({ success: true, payload: { hashes: [] } }))
    await plain.client.swap({ ...SWAP, hide: false })
    expect(JSON.stringify(plain.calls[0]?.body)).not.toContain("hide")

    const stale = client(() => ({ success: true, payload: { hashes: [] } }))
    expect(((await caught(stale.client.swap({ ...SWAP, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
  })

  test("swapFromLinked() forwards hide and refuses before signing", async () => {
    const { calls, client: c } = client(() => ({ success: true, payload: { swapId: "s", transactionsBase64: ["tx"] } }))
    const error = await caught(
      c.swapFromLinked({
        from: "SOL",
        to: "ETH",
        amountRaw: "1",
        payer: { linkedWalletId: "w", privyWalletId: "p" },
        hide: true,
      }),
    )
    expect((error as CandleApiError).code).toBe("HIDE_NOT_CONFIRMED")
    expect(calls.length).toBe(1)
    expect(calls[0]?.body?.hide).toBe(true)
  })
})

describe("launch()", () => {
  const LAUNCH = { name: "N", symbol: "S", imageUrl: "https://x.test/i.png" } as const
  test("hide rides the headless body, needs the echo, and is absent otherwise", async () => {
    const hidden = client(() => ({ success: true, hide: true, mint: "M" }))
    await hidden.client.launch({ ...LAUNCH, hide: true })
    expect(hidden.calls[0]?.body?.hide).toBe(true)

    const plain = client(() => ({ success: true, mint: "M" }))
    await plain.client.launch({ ...LAUNCH, hide: false })
    expect(JSON.stringify(plain.calls[0]?.body)).not.toContain("hide")

    const stale = client(() => ({ success: true, mint: "M" }))
    const error = await caught(stale.client.launch({ ...LAUNCH, hide: true }))
    expect(JSON.stringify((error as Error).message)).toContain("did not confirm")
  })

  test("dryRunLaunch() checks the echo", async () => {
    const stale = client(() => ({ success: true, dryRun: true }))
    expect(((await caught(stale.client.dryRunLaunch({ ...LAUNCH, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
  })

  test("a stale API refuses at the dry run: no live launch request is ever sent (design 5.6)", async () => {
    const { calls, client: c } = client(() => ({ success: true, mint: "M" }))
    const error = await caught(c.launch({ ...LAUNCH, hide: true }))
    expect((error as CandleApiError).code).toBe("HIDE_NOT_CONFIRMED")
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(`${API}/api/v1/launch/headless/dry-run`)
  })

  test("a hidden launch the dry run confirms goes dry-run first, then live", async () => {
    const { calls, client: c } = client(() => ({ success: true, hide: true, mint: "M" }))
    await c.launch({ ...LAUNCH, hide: true })
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/api/v1/launch/headless/dry-run`,
      `${API}/api/v1/launch/headless`,
    ])
    expect(calls[1]?.body?.hide).toBe(true)
  })

  test("a public launch still posts once, live, with no gate", async () => {
    const { calls, client: c } = client(() => ({ success: true, mint: "M" }))
    await c.launch({ ...LAUNCH })
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(`${API}/api/v1/launch/headless`)
  })

  test("launchAsync() is gated the same way: stale refuses with no live request", async () => {
    const stale = client(() => ({ success: true, jobId: "j" }))
    const error = await caught(stale.client.launchAsync({ ...LAUNCH, hide: true }))
    expect((error as CandleApiError).code).toBe("HIDE_NOT_CONFIRMED")
    expect(stale.calls.length).toBe(1)
    expect(stale.calls[0]?.url).toBe(`${API}/api/v1/launch/headless/dry-run`)

    const ok = client(() => ({ success: true, hide: true, jobId: "j" }))
    await ok.client.launchAsync({ ...LAUNCH, hide: true })
    expect(ok.calls.map((call) => call.url)).toEqual([
      `${API}/api/v1/launch/headless/dry-run`,
      `${API}/api/v1/launch/headless`,
    ])
  })
})

describe("self and atomic launch entry points: the true-only wire contract", () => {
  const SELF = {
    clientLaunchId: "s-1",
    name: "N",
    symbol: "S",
    imageUrl: "https://x.test/i.png",
    linkedWalletId: "w",
  } as const
  const SELF_DRY_OK = { success: true, dryRun: true, hide: true, launchWallet: "W" }
  const SELF_BUILT_OK = { success: true, transaction: "tx", mint: "M", clientLaunchId: "s-1", expiresAt: 1, hide: true }
  const SELF_DRY_PLAIN = { success: true, dryRun: true, launchWallet: "W" }
  const SELF_BUILT_PLAIN = { success: true, transaction: "tx", mint: "M", clientLaunchId: "s-1", expiresAt: 1 }
  const ATOMIC_BASE = {
    clientLaunchId: "a-1",
    name: "N",
    symbol: "S",
    imageUrl: "https://x.test/i.png",
    payer: { type: "main" },
  } as const
  const ATOMIC = { ...ATOMIC_BASE, firstBuys: [] } as BuildAtomicLaunchRequest
  const ATOMIC_DRY_OK = { success: true, dryRun: true, hide: true, fills: [] }
  const ATOMIC_DRY_PLAIN = { success: true, dryRun: true, fills: [] }

  test("dryRunSelfLaunch sends hide only when true; false and absent carry no key", async () => {
    for (const hide of [undefined, false]) {
      const { calls, client: c } = client(() => SELF_DRY_OK)
      await c.dryRunSelfLaunch({ ...SELF, ...(hide === undefined ? {} : { hide }) })
      expect(JSON.stringify(calls[0]?.body)).not.toContain("hide")
    }
    const hidden = client(() => SELF_DRY_OK)
    await hidden.client.dryRunSelfLaunch({ ...SELF, hide: true })
    expect(hidden.calls[0]?.body?.hide).toBe(true)
    const stale = client(() => SELF_DRY_PLAIN)
    expect(((await caught(stale.client.dryRunSelfLaunch({ ...SELF, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
  })

  test("a truthy string hide on dryRunSelfLaunch normalizes to true on the wire", async () => {
    const { calls, client: c } = client(() => SELF_DRY_OK)
    await c.dryRunSelfLaunch({ ...SELF, hide: "true" as unknown as boolean })
    expect(calls[0]?.body?.hide).toBe(true)
  })

  test("malformed hide on dryRunSelfLaunch is refused before any request", async () => {
    const { calls, client: c } = client(() => SELF_DRY_OK)
    const error = await caught(c.dryRunSelfLaunch({ ...SELF, hide: "yes" as unknown as boolean }))
    expect((error as CandleApiError).code).toBe("VALIDATION_FAILED")
    expect(calls.length).toBe(0)
  })

  test("buildSelfLaunch sends hide only when true and needs the echo", async () => {
    const plain = client(() => SELF_BUILT_OK)
    await plain.client.buildSelfLaunch({ ...SELF, hide: false })
    expect(JSON.stringify(plain.calls[0]?.body)).not.toContain("hide")
    const hidden = client(() => SELF_BUILT_OK)
    await hidden.client.buildSelfLaunch({ ...SELF, hide: true })
    expect(hidden.calls[0]?.body?.hide).toBe(true)
    const stale = client(() => SELF_BUILT_PLAIN)
    expect(((await caught(stale.client.buildSelfLaunch({ ...SELF, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
  })

  test("dryRunAtomicLaunch sends hide only when true; malformed is refused before the request", async () => {
    const plain = client(() => ATOMIC_DRY_OK)
    await plain.client.dryRunAtomicLaunch({ ...ATOMIC, hide: false })
    expect(JSON.stringify(plain.calls[0]?.body)).not.toContain("hide")
    const hidden = client(() => ATOMIC_DRY_OK)
    await hidden.client.dryRunAtomicLaunch({ ...ATOMIC, hide: true })
    expect(hidden.calls[0]?.body?.hide).toBe(true)
    const stale = client(() => ATOMIC_DRY_PLAIN)
    expect(((await caught(stale.client.dryRunAtomicLaunch({ ...ATOMIC, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
    const malformed = client(() => ATOMIC_DRY_OK)
    const error = await caught(malformed.client.dryRunAtomicLaunch({ ...ATOMIC, hide: 2 as unknown as boolean }))
    expect((error as CandleApiError).code).toBe("VALIDATION_FAILED")
    expect(malformed.calls.length).toBe(0)
  })

  test("buildAtomicLaunch sends hide only when true and needs the echo", async () => {
    const plain = client(() => ({ success: true, bundleId: "b", legs: [], expiresAt: 1, hide: true }))
    await plain.client.buildAtomicLaunch({ ...ATOMIC, hide: false })
    expect(JSON.stringify(plain.calls[0]?.body)).not.toContain("hide")
    const stale = client(() => ({ success: true, bundleId: "b", legs: [], expiresAt: 1 }))
    expect(((await caught(stale.client.buildAtomicLaunch({ ...ATOMIC, hide: true }))) as CandleApiError).code).toBe(
      "HIDE_NOT_CONFIRMED",
    )
  })
})
