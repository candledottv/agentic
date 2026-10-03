/**
 * The plan-table renderer on served tables. Its run against the API's own table (`planTable` in
 * packages/shared) is `scripts/plan-table.test.ts`: this package is exported to the public agentic
 * repo, which has no packages/shared, so nothing here may reach it.
 */
import { describe, expect, test } from "bun:test"
import { formatPlanBps, planLabel, planPromotionLine, planTableMarkdown, planTableRows } from "./plans"

describe("formatPlanBps", () => {
  test("percent with no trailing zeros, and none at zero", () => {
    expect([100, 50, 25, 10, 0, 22].map(formatPlanBps)).toEqual(["1%", "0.5%", "0.25%", "0.1%", "none", "0.22%"])
  })
})

describe("planLabel", () => {
  test("known names are capitalised; an unknown name is shown as served", () => {
    expect(["free", "pro", "max", "believer", "ultra"].map(planLabel)).toEqual([
      "Free",
      "Pro",
      "Max",
      "Believer",
      "ultra",
    ])
  })
})

describe("planTableRows on a served table", () => {
  const base = {
    plan: "free" as const,
    feeBps: 100,
    perpFeeBps: 10,
    price: null,
    limits: { rateLimitPerMin: 30, dailyLaunchCap: 5, uploadsPerMin: 10, linkedWallets: 0 },
  }

  test("an older server with no capabilities shows the price, fee and limit rows only", () => {
    expect(planTableRows({ plans: [base], promoMaxDays: 0 }).rows.map((r) => r[0])).toEqual([
      "Price",
      "Agent trade fee",
      "Perps builder fee",
      "Requests per minute",
      "Launches per day",
      "Uploads per minute",
      "Linked wallets",
    ])
  })

  test("a capability this release does not name is shown under its own key, not dropped", () => {
    const capabilities = { limitOrders: false, futureThing: true } as never
    const { rows } = planTableRows({ plans: [{ ...base, capabilities }], promoMaxDays: 0 })
    expect(rows.slice(7)).toEqual([
      ["Limit orders", "no"],
      ["futureThing", "yes"],
    ])
  })
})

describe("planPromotionLine", () => {
  test("null without a promotion, a sentence with one", () => {
    expect(planPromotionLine({ plans: [], promoMaxDays: 0 })).toBeNull()
    expect(planPromotionLine({ plans: [], promoMaxDays: 30 })).toBe(
      "A first Pro purchase includes Max for its first 30 days, then continues on Pro.",
    )
  })
})

describe("planTableMarkdown", () => {
  test("a header, a separator and one line per row", () => {
    const md = planTableMarkdown({
      plans: [
        {
          plan: "max",
          feeBps: 25,
          perpFeeBps: 0,
          price: { pricePerMonthUsd: 200, currency: "USDC", approval: "self_serve" },
          limits: { rateLimitPerMin: 600, dailyLaunchCap: 1000, uploadsPerMin: 60, linkedWallets: 1000 },
        },
      ],
      promoMaxDays: 0,
    })
    expect(md.split("\n").slice(0, 4)).toEqual([
      "|  | Max |",
      "| --- | --- |",
      "| Price | $200 a month |",
      "| Agent trade fee | 0.25% |",
    ])
  })
})
