/**
 * The SDK half of Hyperliquid risk and visibility (BE-1582, spec A-3, A-4, A-8, A-10, A-12): the
 * extended `perpsPositions()`, `perpsRisk()`, `perpsAccount()`, and the threshold read and writes.
 * The fake routes by URL and, for Hyperliquid, by the `/info` request type, because the venue reads
 * run in parallel.
 */
import { describe, expect, test } from "bun:test"
import { CandleClient } from "./client"

const WALLET = "wallet-evm-1"
const ADDRESS = "0x00000000000000000000000000000000000000aa"
const SERVER_POSITIONS = {
  success: true,
  walletId: WALLET,
  address: ADDRESS,
  network: "mainnet",
  mode: "default",
  standardMode: true,
  account: { accountValue: "1000.0", totalMarginUsed: "100.0" },
  withdrawable: "900.0",
  positions: [{ coin: "BTC", szi: "0.01" }],
  openWithdrawals: [],
}
const STATE = {
  marginSummary: { accountValue: "1000.0", totalMarginUsed: "100.0" },
  crossMarginSummary: { accountValue: "1000.0", totalMarginUsed: "100.0" },
  crossMaintenanceMarginUsed: "50.0",
  withdrawable: "900.0",
  assetPositions: [
    {
      position: {
        coin: "BTC",
        szi: "0.01",
        leverage: { type: "cross", value: 10 },
        entryPx: "60000.0",
        positionValue: "610.0",
        unrealizedPnl: "10.0",
        returnOnEquity: "0.1",
        liquidationPx: "54000.0",
        marginUsed: "61.0",
        cumFunding: { allTime: "0.0", sinceOpen: "0.25", sinceChange: "0.0" },
      },
    },
  ],
}
const MARKET = [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: "61000.0" }]]

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

function harness(over: { limits?: unknown; limitsStatus?: number; hyperliquidDown?: boolean; put?: unknown } = {}) {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string>, body })
    if (url === "https://api.hyperliquid.xyz/info") {
      if (over.hyperliquidDown) return json({ error: "down" }, 502)
      if (body.type === "clearinghouseState") return json(STATE)
      if (body.type === "metaAndAssetCtxs") return json(MARKET)
      if (body.type === "userAbstraction") return json("default")
      if (body.type === "userFillsByTime") return json([{ coin: "BTC", closedPnl: "5.0", fee: "0.5" }])
      if (body.type === "userFunding")
        return json([{ time: 1, hash: "0x0", delta: { type: "funding", coin: "BTC", usdc: "-0.25" } }])
    }
    if (url.endsWith("/api/v1/agent/perps/positions?walletId=wallet-evm-1")) return json(SERVER_POSITIONS)
    if (url.endsWith("/api/v1/agent/keys/self/limits") && over.limitsStatus)
      return json({ error: { code: "INTERNAL" } }, over.limitsStatus)
    if (url.endsWith("/api/v1/agent/keys/self/limits"))
      return json(
        over.limits ?? {
          success: true,
          perpsRisk: { warnDistanceBps: 2000 },
          perpsRiskEffective: {
            warnDistanceBps: 2000,
            criticalDistanceBps: 700,
            warnMarginRatioBps: 6000,
            criticalMarginRatioBps: 8000,
            clearBandBps: 200,
          },
        },
      )
    if (url.endsWith("/api/v1/agent/wallets/trading"))
      return json({ page: [{ id: WALLET, chain: "evm", address: ADDRESS }], scopes: [] })
    if (url.includes("/perps-risk")) return json(over.put ?? { success: true, keyPrefix: "k", perpsRisk: null })
    return json({ error: { code: "NOT_FOUND" } }, 404)
  }) as unknown as typeof fetch
  return { calls, client: new CandleClient({ apiUrl: "https://api.test", apiKey: "cndl_test_key", fetch: impl }) }
}

describe("perpsPositions() (A-3)", () => {
  test("keeps every server field and adds rows, accountLine and risk from the direct read", async () => {
    const { client, calls } = harness()
    const result = await client.perpsPositions(WALLET)
    expect(calls[0]?.url).toBe(`https://api.test/api/v1/agent/perps/positions?walletId=${WALLET}`)
    for (const [key, value] of Object.entries(SERVER_POSITIONS))
      expect([key, (result as unknown as Record<string, unknown>)[key]]).toEqual([key, value])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ coin: "BTC", markPx: "61000.0", fundingSinceOpenUsd: "0.25" })
    expect(result.accountLine).toMatchObject({ accountValueUsd: "1000.0", marginRatio: 0.05 })
    // 11.48% from liquidation, under the key's 20% warn threshold.
    expect(result.risk).toMatchObject({ level: "warn", thresholds: { warnDistanceBps: 2000, source: "key" } })
    expect("positions" in result.risk).toBe(false)
  })

  test("a failed venue read keeps the server's answer and says the risk is unknown", async () => {
    const { client } = harness({ hyperliquidDown: true })
    const result = await client.perpsPositions(WALLET)
    expect(result.positions).toEqual(SERVER_POSITIONS.positions)
    expect(result.rows).toEqual([])
    expect(result.accountLine).toBeNull()
    expect(result.risk).toMatchObject({ level: "unknown", reason: "PERPS_READ_FAILED" })
  })
})

describe("perpsRisk() and perpsAccount() (A-8, A-10)", () => {
  test("perpsRisk resolves the address from the key's wallets and reads Hyperliquid directly", async () => {
    const { client, calls } = harness()
    const report = await client.perpsRisk({ walletId: WALLET })
    expect(report).toMatchObject({ schema: "candle.perps.risk/1", walletId: WALLET, address: ADDRESS, level: "warn" })
    expect(calls.filter((c) => c.url.includes("hyperliquid")).map((c) => c.body?.type)).toEqual(
      expect.arrayContaining(["clearinghouseState", "metaAndAssetCtxs", "userAbstraction"]),
    )
    // Nothing signs, builds or submits (AC21).
    expect(calls.some((c) => /exchange|\/sign|perps\/(open|close|cancel|setup|leverage)/.test(c.url))).toBe(false)
  })

  test("a failed limits read is the defaults, not a crash (E6)", async () => {
    const { client } = harness({ limitsStatus: 500 })
    const report = await client.perpsRisk({ walletId: WALLET, address: ADDRESS })
    expect(report.thresholds).toMatchObject({ criticalDistanceBps: 700, source: "defaults (server did not report)" })
    expect(report.level).toBe("warn")
    const positions = await client.perpsPositions(WALLET)
    expect(positions.risk.thresholds.source).toBe("defaults (server did not report)")
  })

  test("an API that predates perpsRisk: the defaults, and the source says so", async () => {
    const { client } = harness({ limits: { success: true, keyLimits: null } })
    const report = await client.perpsRisk({ walletId: WALLET, address: ADDRESS })
    expect(report.thresholds.source).toBe("defaults (server did not report)")
    expect(report.level).toBe("warn")
  })

  test("perpsAccount adds the recent window: realized, fees and funding received", async () => {
    const { client } = harness()
    const account = await client.perpsAccount({ walletId: WALLET, address: ADDRESS })
    expect(account).toMatchObject({
      schema: "candle.perps.account/1",
      accountValueUsd: "1000.0",
      withdrawableUsd: "900.0",
      recent: { realizedPnlUsd: "5", feesUsd: "0.5", fundingUsd: "-0.25", fills: 1, fundingPayments: 1 },
      risk: { level: "warn" },
    })
    await expect(client.perpsAccount({ walletId: WALLET, address: ADDRESS, since: 0 })).rejects.toThrow(/30 days/)
  })
})

describe("thresholds (A-4)", () => {
  test("getPerpsRisk reads stored and effective", async () => {
    const { client } = harness()
    expect(await client.getPerpsRisk()).toEqual({
      perpsRisk: { warnDistanceBps: 2000 },
      effective: {
        warnDistanceBps: 2000,
        criticalDistanceBps: 700,
        warnMarginRatioBps: 6000,
        criticalMarginRatioBps: 8000,
        clearBandBps: 200,
        source: "key",
      },
    })
  })

  test("setPerpsRisk writes the self route with the API key", async () => {
    const { client, calls } = harness()
    await client.setPerpsRisk({ warnDistanceBps: 2500 })
    const put = calls.find((c) => c.method === "PUT")
    expect(put?.url).toBe("https://api.test/api/v1/agent/keys/self/perps-risk")
    expect(put?.body).toEqual({ perpsRisk: { warnDistanceBps: 2500 } })
    expect(put?.headers["x-api-key"]).toBe("cndl_test_key")
  })

  test("setKeyPerpsRisk writes the owner route with the bearer token and not the API key", async () => {
    const { client, calls } = harness()
    await client.setKeyPerpsRisk("AbCd1234", null, { bearerToken: "cndl_dvc_owner" })
    const put = calls.find((c) => c.method === "PUT")
    expect(put?.url).toBe("https://api.test/api/v1/agent/keys/AbCd1234/perps-risk")
    expect(put?.body).toEqual({ perpsRisk: null })
    expect(put?.headers.authorization).toBe("Bearer cndl_dvc_owner")
    expect(put?.headers["x-api-key"]).toBeUndefined()
  })
})
