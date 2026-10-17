/**
 * The MCP half of Hyperliquid risk and visibility (BE-1582, spec A-12, AC17, AC21): the four tools,
 * the `candle_perps_positions` additions, and the local `candle_get_portfolio` section, which the
 * hosted registration never adds. Results are the engine's own documents, the ones
 * `candle perps ... --json` prints.
 */
import { expect, test } from "bun:test"
import { HYPERLIQUID_RISK_DEFAULTS, readPerpsRisk } from "./hyperliquid-risk"
import { executePerps } from "./perps"
import { registerToolSubset, registerTools, TOOL_NAMES } from "./tools"

const ADDRESS = "0x00000000000000000000000000000000000000aa"
const cfg = { apiUrl: "https://api.test", apiKey: "cndl_test_key" }

const state = (liquidationPx: string) => ({
  marginSummary: { accountValue: "1000.0", totalMarginUsed: "100.0" },
  crossMarginSummary: { accountValue: "1000.0", totalMarginUsed: "100.0" },
  crossMaintenanceMarginUsed: "50.0",
  withdrawable: "900.0",
  assetPositions: [
    {
      position: {
        coin: "BTC",
        szi: "1.0",
        leverage: { type: "cross", value: 10 },
        entryPx: "100.0",
        positionValue: "100.0",
        unrealizedPnl: "1.0",
        returnOnEquity: "0.1",
        liquidationPx,
        marginUsed: "10.0",
        cumFunding: { allTime: "0.0", sinceOpen: "0.1", sinceChange: "0.0" },
      },
    },
  ],
})

interface Call {
  url: string
  method: string
  body?: Record<string, unknown>
}

function fake(over: { mode?: string; liq?: string; hyperliquidDown?: boolean; put?: Response } = {}) {
  const calls: Call[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? "GET", body })
    if (url.startsWith("https://api.hyperliquid.xyz/info")) {
      if (over.hyperliquidDown) return new Response("down", { status: 502 })
      if (body.type === "metaAndAssetCtxs")
        return Response.json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: "100.0" }]])
      if (body.type === "userAbstraction") return Response.json(over.mode ?? "default")
      if (body.type === "userFillsByTime") return Response.json([])
      if (body.type === "userFunding") return Response.json([])
      if (body.type === "clearinghouseState") return Response.json(state(over.liq ?? "90.0"))
    }
    if (url.endsWith("/api/v1/agent/wallets/trading"))
      return Response.json({ page: [{ id: "wallet", chain: "evm", address: ADDRESS, label: "perps" }], scopes: [] })
    if (url.endsWith("/api/v1/agent/keys/self/limits"))
      return Response.json({ success: true, perpsRisk: null, perpsRiskEffective: HYPERLIQUID_RISK_DEFAULTS })
    if (url.includes("/api/v1/agent/perps/positions"))
      return Response.json({ success: true, address: ADDRESS, account: { accountValue: "1000.0" }, positions: [] })
    if (url.endsWith("/perps-risk")) return over.put ?? Response.json({ success: true, keyPrefix: "abcd1234" })
    if (url.endsWith("/api/v1/agent/portfolio"))
      return Response.json({ success: true, tee: [], hood: { tee: [{ id: "hw1", address: ADDRESS, label: "perps" }] } })
    throw new Error(`Unexpected ${url}`)
  }
  return { calls, fetch: fetch as never }
}

const json = (result: { text: string }) => JSON.parse(result.text)

test("the four tools are listed and run through the perps dispatcher", () => {
  for (const name of [
    "candle_perps_account",
    "candle_perps_risk",
    "candle_perps_thresholds",
    "candle_perps_set_thresholds",
  ])
    expect((TOOL_NAMES as readonly string[]).includes(name)).toBe(true)
})

test("candle_perps_risk: warn is a result, not an error, and is the engine's own report", async () => {
  const f = fake()
  const result = await executePerps("candle_perps_risk", {}, cfg, {}, f.fetch)
  expect(result.isError).toBeUndefined()
  const report = json(result)
  // 10% from liquidation: warn under the default 15%.
  expect(report).toMatchObject({ schema: "candle.perps.risk/1", walletId: "wallet", level: "warn" })
  const direct = await readPerpsRisk({
    fetcher: fake().fetch,
    network: "mainnet",
    walletId: "wallet",
    address: ADDRESS,
    thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults" },
    now: Date.now,
  })
  expect({ ...report, readAt: "" }).toEqual({ ...direct, readAt: "" })
  expect(f.calls.some((c) => /exchange|\/sign|perps\/(open|close|cancel|setup|leverage)/.test(c.url))).toBe(false)
})

test("candle_perps_risk: an unreadable account mode and a failed read are errors with PERPS_* codes", async () => {
  const mode = json(await executePerps("candle_perps_risk", {}, cfg, {}, fake({ mode: "unifiedAccount" }).fetch))
  expect(mode.error.code).toBe("PERPS_ACCOUNT_MODE")
  expect(mode.report).toMatchObject({ level: "unknown", reason: "PERPS_ACCOUNT_MODE" })
  const down = await executePerps("candle_perps_risk", {}, cfg, {}, fake({ hyperliquidDown: true }).fetch)
  expect(down.isError).toBe(true)
  expect(json(down).error.code).toBe("PERPS_READ_FAILED")
})

test("candle_perps_account: the account line, the window and the risk summary", async () => {
  const account = json(await executePerps("candle_perps_account", { since: "7d" }, cfg, {}, fake().fetch))
  expect(account).toMatchObject({
    schema: "candle.perps.account/1",
    accountValueUsd: "1000.0",
    withdrawableUsd: "900.0",
    recent: { realizedPnlUsd: "0", fills: 0 },
    risk: { level: "warn" },
  })
  expect(account.recent.endTime - account.recent.startTime).toBe(7 * 86_400_000)
  const bad = await executePerps("candle_perps_account", { since: "60d" }, cfg, {}, fake().fetch)
  expect(json(bad).error.code).toBe("MCP_VALIDATION")
})

test("candle_perps_thresholds reads; candle_perps_set_thresholds writes the self route only", async () => {
  const read = json(await executePerps("candle_perps_thresholds", {}, cfg, {}, fake().fetch))
  expect(read).toEqual({ stored: null, effective: HYPERLIQUID_RISK_DEFAULTS, source: "defaults" })

  const f = fake()
  await executePerps("candle_perps_set_thresholds", { warnDistanceBps: 2000, clearBandBps: null }, cfg, {}, f.fetch)
  await executePerps("candle_perps_set_thresholds", { clear: true }, cfg, {}, f.fetch)
  const puts = f.calls.filter((c) => c.method === "PUT")
  expect(puts.map((c) => c.url)).toEqual([
    "https://api.test/api/v1/agent/keys/self/perps-risk",
    "https://api.test/api/v1/agent/keys/self/perps-risk",
  ])
  expect(puts.map((c) => c.body)).toEqual([
    { perpsRisk: { warnDistanceBps: 2000, clearBandBps: null } },
    { perpsRisk: null },
  ])

  const loosen = fake({
    put: Response.json(
      { success: false, error: { code: "LOOSEN_REQUIRES_SESSION", message: "only the owner" } },
      { status: 403 },
    ),
  })
  const refused = await executePerps("candle_perps_set_thresholds", { warnDistanceBps: 100 }, cfg, {}, loosen.fetch)
  expect(refused.isError).toBe(true)
  expect(json(refused).error.code).toBe("LOOSEN_REQUIRES_SESSION")
  const empty = await executePerps("candle_perps_set_thresholds", {}, cfg, {}, fake().fetch)
  expect(json(empty).error.code).toBe("MCP_VALIDATION")
})

test("candle_perps_positions keeps the server's answer and adds rows, accountLine and risk", async () => {
  const result = json(await executePerps("candle_perps_positions", {}, cfg, {}, fake().fetch))
  expect(result).toMatchObject({ success: true, address: ADDRESS, account: { accountValue: "1000.0" }, positions: [] })
  expect(result.rows).toHaveLength(1)
  expect(result.accountLine).toMatchObject({ accountValueUsd: "1000.0", marginRatio: 0.05 })
  expect(result.risk).toMatchObject({ level: "warn" })
  expect(result.risk.positions).toBeUndefined()
})

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>

function capture(name: string) {
  const handlers: Record<string, Handler> = {}
  const server = {
    registerTool(tool: string, _config: unknown, handler: Handler) {
      handlers[tool] = handler
    },
  }
  return { server, call: (args: Record<string, unknown> = {}) => (handlers[name] as Handler)(args) }
}

test("the local candle_get_portfolio adds the hyperliquid section; the hosted registration does not", async () => {
  const original = globalThis.fetch
  try {
    const local = fake()
    globalThis.fetch = local.fetch
    const l = capture("candle_get_portfolio")
    registerTools(l.server as never, { CANDLE_API_URL: "https://api.test", CANDLE_AGENT_API_KEY: "test-key" })
    const doc = JSON.parse((await l.call()).content[0]?.text ?? "{}")
    expect(doc.hood).toEqual({ tee: [{ id: "hw1", address: ADDRESS, label: "perps" }] })
    expect(doc.hyperliquid).toMatchObject({
      read: true,
      accounts: [{ address: ADDRESS, label: "perps", walletId: "hw1", accountValueUsd: "1000.0", level: "warn" }],
      subtotal: { accountValueUsd: "1000", unrealizedPnlUsd: "1" },
    })

    const hostedFetch = fake()
    const h = capture("candle_get_portfolio")
    registerToolSubset(h.server as never, {
      tools: ["candle_get_portfolio"],
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "test-key" }),
      fetch: hostedFetch.fetch,
    })
    const hosted = JSON.parse((await h.call()).content[0]?.text ?? "{}")
    expect("hyperliquid" in hosted).toBe(false)
    expect(hostedFetch.calls.some((c) => c.url.includes("hyperliquid"))).toBe(false)
  } finally {
    globalThis.fetch = original
  }
})
