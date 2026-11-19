import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const AGENT = (n: number) => ({
  profileId: `prof_${String(n).repeat(16)}`,
  slug: `agent-${n}`,
  name: `Agent ${n}`,
  avatarUrl: null,
})
const BODY = {
  success: true,
  network: "mainnet",
  market: {
    coin: "BTC",
    dex: null,
    dexName: null,
    deployer: null,
    oracleSource: "validators",
    markPx: "61000",
    change24hPct: "1.2",
    fundingRate: "0.0000125",
    fundingAprPct: "10.9",
    openInterestUsd: "2000000000",
    dayNotionalVolumeUsd: "5000000000",
    maxLeverage: 40,
    onlyIsolated: false,
    isDelisted: false,
  },
  readAt: 1_000,
  stale: false,
  funding: { points: [], readAt: 1_000, stale: false },
  agents: {
    coin: "BTC",
    long: 2,
    short: 1,
    netSize: "0.65",
    netValueUsd: "39650",
    positions: [1, 2, 3].map((n) => ({
      agent: AGENT(n),
      label: n === 3 ? "Short BTC 20x" : "Long BTC 20x",
      coin: "BTC",
      side: n === 3 ? "short" : "long",
      leverage: { value: 20, type: "cross" },
      size: "0.5",
      entryPx: "60000",
      markPx: "61000",
      positionValueUsd: "30500",
      unrealizedPnlUsd: "12.5",
      returnOnEquity: "0.125",
      asOfMs: 1_000,
    })),
    rounds: [
      {
        agent: AGENT(1),
        roundId: "rnd_0123456789abcdef",
        coin: "BTC",
        side: "long",
        leverage: null,
        pnlUsd: 5,
        liquidated: false,
        closedMs: 500,
      },
    ],
    asOfMs: 1_000,
    truncated: false,
  },
  agentsUnavailable: false,
}

function fixture(body: unknown = BODY) {
  const calls: { path: string; key: string | null }[] = []
  const stdout = createCapture()
  const deps = createTestDeps({
    stdout,
    stderr: createCapture(),
    env: { CANDLE_API_KEY: "fixture-key" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, key: new Headers(init?.headers).get("x-api-key") })
      return Response.json(body)
    }) as typeof fetch,
  })
  return { deps, calls, stdout }
}

test("perps market --agents prints the market line, the three agents and the copy line; no key is sent", async () => {
  const f = fixture()
  expect(await run(["perps", "market", "BTC", "--agents"], f.deps)).toBe(0)
  expect(f.calls).toEqual([{ path: "/api/v1/agent/perps-markets/BTC", key: null }])
  expect(f.stdout.text).toContain("2 long, 1 short, net size 0.65")
  expect(f.stdout.text).toContain("Long BTC 20x")
  expect(f.stdout.text).toContain("Short BTC 20x")
  expect(f.stdout.text).toContain("+12.5%")
  expect(f.stdout.text).toContain("rnd_0123456789abcdef")
  expect(f.stdout.text).toContain("Measured record, not a forecast. Past results do not predict future results.")
  expect(f.stdout.text).not.toMatch(/0x[0-9a-f]{8}/i)
})

test("--json is the route's body, and a dex coin is encoded", async () => {
  const f = fixture()
  expect(await run(["perps", "market", "xyz:TSLA", "--agents", "--json"], f.deps)).toBe(0)
  expect(f.calls[0]?.path).toBe("/api/v1/agent/perps-markets/xyz%3ATSLA")
  expect(JSON.parse(f.stdout.text).agents.long).toBe(2)
})

test("a market with no agent activity says so cleanly", async () => {
  const f = fixture({ ...BODY, agents: { ...BODY.agents, long: 0, short: 0, netSize: "0", positions: [], rounds: [] } })
  expect(await run(["perps", "market", "BTC", "--agents"], f.deps)).toBe(0)
  expect(f.stdout.text).toContain("No public Candle agent holds an open position in this market.")
})

test("usage: --agents needs a coin", async () => {
  const f = fixture()
  expect(await run(["perps", "market", "--agents"], f.deps)).toBe(2)
  expect(f.calls).toEqual([])
})
