import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"

const TABLE = {
  success: true,
  plans: [
    {
      plan: "free",
      capabilities: { buyExternalTokens: false, sellExternalTokens: true, limitOrders: false },
      feeBps: 100,
      perpFeeBps: 10,
      price: null,
      limits: { rateLimitPerMin: 30, dailyLaunchCap: 5, uploadsPerMin: 10, linkedWallets: 0 },
    },
    {
      plan: "pro",
      capabilities: { buyExternalTokens: true, sellExternalTokens: true, limitOrders: false },
      feeBps: 50,
      perpFeeBps: 10,
      price: { pricePerMonthUsd: 50, currency: "USDC", approval: "self_serve" },
      limits: { rateLimitPerMin: 300, dailyLaunchCap: 50, uploadsPerMin: 30, linkedWallets: 10 },
    },
    {
      plan: "max",
      capabilities: { buyExternalTokens: true, sellExternalTokens: true, limitOrders: true },
      feeBps: 25,
      perpFeeBps: 0,
      price: { pricePerMonthUsd: 200, currency: "USDC", approval: "self_serve" },
      limits: { rateLimitPerMin: 600, dailyLaunchCap: 1000, uploadsPerMin: 60, linkedWallets: 1000 },
    },
  ],
  promoMaxDays: 30,
}

function setup(response: Response) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return response
  }) as unknown as typeof globalThis.fetch
  const stdout = createCapture()
  const stderr = createCapture()
  // A stored key must not be sent: the route is public.
  const deps = createTestDeps({ fetch, stdout, stderr, env: { CANDLE_API_KEY: "cndl_test_secret" } })
  return { deps, calls, stdout, stderr }
}

describe("candle plans", () => {
  test("prints the served table, the promotion and no credential header", async () => {
    const { deps, calls, stdout } = setup(jsonResponse(200, TABLE))
    expect(await run(["plans", "--api-url", "https://api.test"], deps)).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.test/api/v1/agent/plans")
    expect(JSON.stringify(calls[0]?.headers)).not.toContain("cndl_test_secret")
    const out = stdout.text
    expect(out).toContain("Plans served by https://api.test")
    expect(out).toMatch(/Price\s+free\s+\$50 a month\s+\$200 a month/)
    expect(out).toMatch(/Agent trade fee\s+1%\s+0\.5%\s+0\.25%/)
    expect(out).toMatch(/Perps builder fee\s+0\.1%\s+0\.1%\s+none/)
    expect(out).toMatch(/Linked wallets\s+0\s+10\s+1,000/)
    expect(out).toMatch(/Sell tokens not launched on Candle\s+yes\s+yes\s+yes/)
    expect(out).toMatch(/Buy tokens not launched on Candle\s+no\s+yes\s+yes/)
    expect(out).toMatch(/Limit orders\s+no\s+no\s+yes/)
    expect(out).toContain("A first Pro purchase includes Max for its first 30 days, then continues on Pro.")
  })

  test("--json is the server's body, one line", async () => {
    const { deps, stdout } = setup(jsonResponse(200, TABLE))
    expect(await run(["plans", "--api-url", "https://api.test", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual(TABLE)
    expect(stdout.text.trimEnd().split("\n")).toHaveLength(1)
  })

  test("no promotion line when promoMaxDays is 0", async () => {
    const { deps, stdout } = setup(jsonResponse(200, { ...TABLE, promoMaxDays: 0 }))
    expect(await run(["plans", "--api-url", "https://api.test"], deps)).toBe(0)
    expect(stdout.text).not.toContain("first Pro purchase")
  })

  test("a server without the table says so and exits 1", async () => {
    const { deps, stdout, stderr } = setup(jsonResponse(404, { success: false, error: { code: "NOT_FOUND" } }))
    expect(await run(["plans", "--api-url", "https://api.test"], deps)).toBe(1)
    expect(stdout.text).toBe("")
    expect(stderr.text).toContain("does not serve the plan table yet")
  })

  test("a stray argument is a usage error, exit 2, with no request", async () => {
    const { deps, calls, stderr } = setup(jsonResponse(200, TABLE))
    expect(await run(["plans", "pro"], deps)).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("Usage: candle plans")
  })
})
