import { expect, test } from "bun:test"
import { CandleClient } from "./client"

test("getProfilePnl preserves perps figures, perpsInTotal and the earned-positive funding sign", async () => {
  for (const hyperliquid of [
    undefined,
    { read: false, reason: "Retry" },
    { read: false, code: "ingest_incomplete", reason: "Retry" },
    { read: false, code: "live_budget_exceeded", reason: "A certified snapshot is required." },
    {
      read: true,
      network: "mainnet",
      coverage: "profile",
      realizedGrossUsd: 100,
      feesUsd: 0.5,
      fundingUsd: 2.5,
      realizedNetUsd: 102,
      unrealizedUsd: "-7.250000",
      netUsd: "94.750000",
      markedAt: 1,
      perpsSnapshotId: "ps1_x",
      completeThroughMs: 1,
      positions: [{ kind: "perp", coin: "ETH", fundingNetUsd: "1.25" }],
      fills: 2,
      fundingPayments: 1,
      byWallet: [
        {
          address: "0x1",
          fromMs: 0,
          toMs: null,
          startTime: 0,
          observationCutoffMs: 1,
          completeThroughMs: 1,
          reconciliation: "live",
        },
      ],
      historyPartial: false,
      partialReasons: [],
      truncated: false,
      fillsLimit: 2000,
      fundingLimit: 500,
      walletsLimit: 20,
    },
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
    const read = hyperliquid?.read === true
    const body = {
      success: true,
      keyPrefix: "own",
      pnl: {},
      ...(hyperliquid ? { hyperliquid, ...("code" in hyperliquid || read ? { perpsInTotal: read } : {}) } : {}),
    }
    const client = new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "test-key",
      fetch: (async (url, init) => {
        expect(String(url)).toBe("https://api.test/api/v1/agent/keys/own/pnl")
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key")
        return Response.json(body)
      }) as typeof fetch,
    })
    const result = await client.getProfilePnl("own")
    expect<unknown>(result).toEqual(body)
    if (result.hyperliquid?.read && Array.isArray(result.hyperliquid.positions)) {
      // I8: the SDK passes funding through unchanged; both fields are positive when received.
      expect(result.hyperliquid.fundingUsd).toBe(2.5)
      expect(result.hyperliquid.positions[0]?.fundingNetUsd).toBe("1.25")
      expect(result.perpsInTotal).toBe(true)
    }
  }
})
