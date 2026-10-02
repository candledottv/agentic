import { expect, test } from "bun:test"
import { CandleClient } from "./client"

test("getProfilePnl preserves perps figures and remains compatible with an older API", async () => {
  for (const hyperliquid of [
    undefined,
    { read: false, reason: "Retry" },
    {
      read: true,
      network: "mainnet",
      realizedGrossUsd: 10,
      feesUsd: 0.5,
      fundingUsd: -1,
      realizedNetUsd: 8.5,
      fills: 1,
      fundingPayments: 1,
      fillsLimit: 2000,
      fundingLimit: 500,
      walletsLimit: 20,
      truncated: false,
      byWallet: [],
    },
  ]) {
    const body = { success: true, keyPrefix: "own", pnl: {}, ...(hyperliquid ? { hyperliquid } : {}) }
    const client = new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "test-key",
      fetch: (async (url, init) => {
        expect(String(url)).toBe("https://api.test/api/v1/agent/keys/own/pnl")
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key")
        return Response.json(body)
      }) as typeof fetch,
    })
    expect<unknown>(await client.getProfilePnl("own")).toEqual(body)
  }
})
