import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const PROFILE = "prof_0123456789abcdef"
const ROUND = {
  id: "rnd_0123456789abcdef",
  coin: "xyz:SP500",
  side: "long",
  outcome: "open",
  leverage: { value: 20, type: "isolated" },
  openedMs: 1_000,
  closedMs: null,
  durationMs: 7_200_000,
  size: { peak: "6", current: "6" },
  entryAvgPx: "7687.5",
  exitAvgPx: null,
  markPx: "7970",
  liquidationPx: "7400",
  initialMarginUsd: 2306.25,
  returnOnMargin: 0.735,
  realizedUsd: 0,
  unrealizedUsd: 1694.7,
  fundingUsd: -1.5,
  hyperliquidFeesUsd: 3,
  builderFeesUsd: 1,
  pnlUsd: 1694.7,
  fills: [
    {
      time: 1_000,
      side: "buy",
      role: "open",
      px: "7687.5",
      sz: "6",
      feeUsd: 4,
      closedPnlUsd: 0,
      liquidated: false,
      hash: "0xabc",
    },
  ],
  funding: [],
  complete: true,
  asOfMs: 2_000,
}
const ORDERS = {
  success: true,
  orders: [
    {
      coin: "xyz:SP500",
      kind: "take_profit",
      side: "sell",
      limitPx: null,
      triggerPx: "8200",
      size: "6",
      reduceOnly: true,
    },
    { coin: "BTC", kind: "limit", side: "buy", limitPx: "60000", triggerPx: null, size: "1", reduceOnly: false },
  ],
  readAt: 1_000,
  stale: false,
}

function fixture() {
  const calls: { path: string; key: string | null }[] = []
  const stdout = createCapture()
  const deps = createTestDeps({
    stdout,
    stderr: createCapture(),
    env: { CANDLE_API_KEY: "fixture-key" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, key: new Headers(init?.headers).get("x-api-key") })
      return url.pathname.endsWith("/open-orders")
        ? Response.json(ORDERS)
        : Response.json({ success: true, round: ROUND, seq: 1 })
    }) as typeof fetch,
  })
  return { deps, calls, stdout }
}

test("agent round prints the label, ROE, split fees, fills and the coin's open orders; no key is sent", async () => {
  const f = fixture()
  expect(await run(["agent", "round", PROFILE, "open:xyz:SP500"], f.deps)).toBe(0)
  expect(f.calls.map((c) => c.path)).toEqual([
    `/api/v1/agent/records/${PROFILE}/perps/rounds/open%3Axyz%3ASP500`,
    `/api/v1/agent/records/${PROFILE}/open-orders`,
  ])
  expect(f.calls.every((c) => c.key === null)).toBe(true)
  expect(f.stdout.text).toContain("Long xyz:SP500 20x: open")
  expect(f.stdout.text).toContain("+73.5%")
  expect(f.stdout.text).toContain("Candle builder fee")
  expect(f.stdout.text).toContain("take profit")
  expect(f.stdout.text).not.toContain("60,000") // another coin's order is not shown on this round
})

test("--json is the route's body, with this coin's open orders for an open round", async () => {
  const f = fixture()
  expect(await run(["agent", "round", PROFILE, "rnd_0123456789abcdef", "--json"], f.deps)).toBe(0)
  const body = JSON.parse(f.stdout.text)
  expect(body.round.id).toBe(ROUND.id)
  expect(body.openOrders).toHaveLength(1)
})

test("usage errors fail before any request", async () => {
  for (const args of [
    ["agent", "round"],
    ["agent", "round", PROFILE],
    ["agent", "round", PROFILE, "not-a-round"],
    ["agent", "round", "bad slug!", "rnd_0123456789abcdef"],
  ]) {
    const f = fixture()
    expect(await run(args, f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  }
})
