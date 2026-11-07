import { expect, test } from "bun:test"
import { CandleClient, type ProfilePnlWindow } from "./index"

const window: ProfilePnlWindow = {
  sinceTs: 120000,
  realizedEvents: 0,
  realizedGrossUsd: 0,
  feesUsd: 2,
  realizedNetUsd: -2,
  closedRounds: 0,
  closed: {},
  unrealizedUsd: 30,
  openPositions: 1,
  unmarkedPositions: 0,
  boundary: {
    positions: 1,
    missingMints: [],
    marks: [{ mint: "M", priceUsd: 12, updatedAt: 120000, source: "candle-close" }],
  },
  windowedUsd: 28,
  complete: true,
  incompleteReasons: [],
  truncated: false,
}

test("getProfilePnl sends the window query and preserves complete and incomplete contracts", async () => {
  for (const value of [
    window,
    { ...window, complete: false, windowedUsd: null, incompleteReasons: ["missing-boundary-marks"] },
    undefined,
  ]) {
    const body = { success: true, keyPrefix: "own", pnl: {}, ...(value ? { window: value } : {}) }
    const client = new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "test-key",
      fetch: (async (url, init) => {
        expect(String(url)).toBe(`https://api.test/api/v1/agent/keys/own/pnl${value ? "?sinceMs=120000" : ""}`)
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key")
        return Response.json(body)
      }) as typeof fetch,
    })
    expect<unknown>(await client.getProfilePnl("own", value ? { sinceMs: 120000 } : undefined)).toEqual(body)
  }
})
test("getProfilePnl preserves zero as a query value", async () => {
  const client = new CandleClient({
    apiUrl: "https://api.test",
    apiKey: "test-key",
    fetch: (async (url) => {
      expect(String(url)).toEndWith("?sinceMs=0")
      return Response.json({ success: true, pnl: {} })
    }) as typeof fetch,
  })
  await client.getProfilePnl("own", { sinceMs: 0 })
})
