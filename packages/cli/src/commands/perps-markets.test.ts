import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { run } from "../index"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "../test-support"

const BUILDER = JSON.parse(
  readFileSync(join(import.meta.dir, "../__fixtures__/hyperliquid-builder-dex.json"), "utf8"),
) as { perpDexs: unknown; metaAndAssetCtxs: Record<string, unknown> }

function fixture(
  key = "key",
  opts: { down?: boolean; configDown?: boolean; optionalDown?: boolean; testnet?: boolean } = {},
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const urls: string[] = []
  const bodies: Record<string, unknown>[] = []
  const deps = createTestDeps({
    stdout,
    stderr,
    store: createFakeStore(),
    now: () => 1_792_267_200_000,
    env: { CANDLE_API_KEY: key, ...(opts.testnet ? { CANDLE_HYPERLIQUID_NETWORK: "testnet" } : {}) },
    fetch: (async (url, init) => {
      const u = String(url)
      urls.push(u)
      if (u.endsWith("/api/v1/agent/perps/config"))
        return new Response(
          JSON.stringify({ network: opts.testnet ? "testnet" : "mainnet", limits: { minOpenInterestUsd: 0 } }),
          { status: opts.configDown ? 503 : 200 },
        )
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false)
      if (opts.down) return new Response("bad", { status: 429 })
      // BE-3755: builder-dex reads answer from the captured mainnet fixture.
      if (body.type === "perpDexs") return new Response(JSON.stringify(BUILDER.perpDexs))
      if (body.type === "metaAndAssetCtxs" && typeof body.dex === "string")
        return new Response(JSON.stringify(BUILDER.metaAndAssetCtxs[body.dex]))
      if (body.type === "metaAndAssetCtxs")
        return new Response(
          JSON.stringify([
            { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
            [
              {
                markPx: "100",
                midPx: "100",
                oraclePx: "100",
                openInterest: "10000",
                funding: "0.0000125",
                prevDayPx: "100",
                dayNtlVlm: "5000",
              },
            ],
          ]),
        )
      if (body.type === "l2Book") return new Response(JSON.stringify({ coin: "BTC", time: 1, levels: [[], []] }))
      if (body.type === "candleSnapshot") return new Response("[]")
      return new Response("[]", { status: opts.optionalDown ? 503 : 200 })
    }) as typeof fetch,
  })
  return { deps, stdout, stderr, urls, bodies }
}
test("AC1 CLI JSON snapshot includes the common envelope and complete market row", async () => {
  const f = fixture()
  expect(await run(["perps", "markets", "--json", "--api-url", "https://api.test"], f.deps)).toBe(0)
  expect(JSON.parse(f.stdout.text)).toEqual({
    success: true,
    network: "mainnet",
    readAt: 1_792_267_200_000,
    gate: { minOpenInterestUsd: 0, source: "server" },
    warnings: [],
    markets: [
      {
        coin: "BTC",
        asset: 0,
        markPx: "100",
        oraclePx: "100",
        midPx: "100",
        fundingRate: "0.0000125",
        fundingAprPct: "10.95",
        predictedFundingRate: null,
        nextFundingTime: null,
        openInterest: "10000",
        openInterestUsd: "1000000.00",
        dayNotionalVolumeUsd: "5000",
        prevDayPx: "100",
        change24hPct: "0.0",
        maxLeverage: 40,
        onlyIsolated: false,
        isDelisted: false,
        atOpenInterestCap: false,
        candle: { tradeable: true, reason: null },
        dex: "",
        terms: {
          dex: "",
          dexName: null,
          deployer: null,
          oracleSource: "validators",
          oracleSetters: [],
          marginMode: "cross",
          collateral: "USDC",
          feeMultiplier: "1",
          takerFeePct: "0.045",
          makerFeePct: "0.015",
          feeWarning: null,
        },
      },
    ],
  })
  expect(f.urls.filter((url) => url.startsWith("https://api.test"))).toEqual([
    "https://api.test/api/v1/agent/perps/config",
  ])
})
test("all four commands route with JSON and without a wallet or signer, including testnet", async () => {
  for (const command of [
    ["markets"],
    ["market", "btc"],
    ["book", "btc", "--depth", "1", "--sig-figs", "3"],
    ["candles", "btc", "--interval", "1h", "--count", "2"],
  ]) {
    const f = fixture("key", { testnet: true })
    expect(await run(["perps", ...command, "--json", "--api-url", "https://api.test"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).network).toBe("testnet")
    expect(
      f.urls
        .filter((u) => !u.startsWith("https://api.test"))
        .every((u) => u === "https://api.hyperliquid-testnet.xyz/info"),
    ).toBe(true)
  }
})
test("AC9 missing key is PERPS_KEY_REQUIRED exit 1 and zero requests", async () => {
  for (const command of [["markets"], ["market", "BTC"], ["book", "BTC"], ["candles", "BTC"]]) {
    const f = fixture("")
    expect(await run(["perps", ...command, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("PERPS_KEY_REQUIRED")
    expect(f.urls).toEqual([])
  }
})
test("usage rejects unknown flags, missing coin, bounds and future/bad end with exit 2 before requests", async () => {
  for (const args of [
    ["markets", "--wallet", "x"],
    ["market"],
    ["book", "BTC", "--depth", "21"],
    ["candles", "BTC", "--end", "garbage"],
    ["candles", "BTC", "--end", "9999999999999"],
    ["markets", "--limit", "0"],
    ["markets", "--sort", "wrong"],
  ]) {
    const f = fixture()
    expect(await run(["perps", ...args, "--json"], f.deps)).toBe(2)
    expect(f.urls).toEqual([])
  }
})
test("AC8 failure/degradation retain JSON shape and exit status", async () => {
  const down = fixture("key", { down: true })
  expect(await run(["perps", "markets", "--json"], down.deps)).toBe(1)
  expect(JSON.parse(down.stdout.text)).toMatchObject({ code: "PERPS_UNAVAILABLE", retryable: true })
  const degraded = fixture("key", { configDown: true, optionalDown: true })
  expect(await run(["perps", "markets", "--json"], degraded.deps)).toBe(0)
  expect(JSON.parse(degraded.stdout.text)).toMatchObject({ gate: { source: "default" }, warnings: expect.any(Array) })
  expect(JSON.parse(degraded.stdout.text).warnings).toHaveLength(3)
  const typo = fixture()
  expect(await run(["perps", "book", "NOPE", "--json"], typo.deps)).toBe(1)
  expect(JSON.parse(typo.stdout.text).code).toBe("PERPS_MARKET_NOT_FOUND")
  expect(typo.bodies.some((b) => b.type === "l2Book")).toBe(false)
})
test("human markets table includes hourly funding, APR, money and build-gate caveat", async () => {
  const f = fixture()
  expect(await run(["perps", "markets"], f.deps)).toBe(0)
  expect(f.stdout.text).toContain("FUNDING/H")
  expect(f.stdout.text).toContain("0.0013%")
  expect(f.stdout.text).toContain("$1.00M")
  expect(f.stdout.text).toContain("$100.00")
  expect(f.stdout.text).toContain("not a promise")
})

test("AC7 stored-profile market reads call only config on Candle, without an account lookup", async () => {
  for (const command of [["markets"], ["market", "BTC"], ["book", "BTC"], ["candles", "BTC"]]) {
    const f = fixture()
    f.deps.env = {}
    f.deps.store = createFakeStore({ "profile:read:api_key": "key" })
    Object.assign(
      f.deps,
      createFakeConfigStore({
        activeProfile: "read",
        profiles: { read: { apiUrl: "https://api.test", account: "CACHED" } },
      }),
    )
    expect(await run(["perps", ...command, "--json"], f.deps)).toBe(0)
    expect(f.urls.filter((url) => url.startsWith("https://api.test"))).toEqual([
      "https://api.test/api/v1/agent/perps/config",
    ])
  }
})

test("BE-3755 market xyz:TSLA prints its dex, oracle, deployer, margin mode, fee and max leverage", async () => {
  const f = fixture()
  expect(await run(["perps", "market", "xyz:TSLA", "--api-url", "https://api.test"], f.deps)).toBe(0)
  expect(f.stdout.text).toContain(
    "xyz:TSLA: builder dex xyz (XYZ), deployer 0x88806a71d74ad0a510b350545c9ae490912f0888, oracle set by 0x1234567890545d1df9ee64b35fdd16966e08acec; cross or isolated margin; max 20x; collateral USDC; fee 0.2x the main exchange's",
  )
  expect(f.bodies).toContainEqual({ type: "metaAndAssetCtxs", dex: "xyz" })
  const json = fixture()
  expect(await run(["perps", "market", "xyz:HOOD", "--json", "--api-url", "https://api.test"], json.deps)).toBe(0)
  expect(JSON.parse(json.stdout.text).market).toMatchObject({
    coin: "xyz:HOOD",
    asset: 110004,
    dex: "xyz",
    onlyIsolated: true,
    terms: { marginMode: "isolated", deployer: "0x88806a71d74ad0a510b350545c9ae490912f0888" },
  })
})
test("BE-3755 markets --dex xyz lists that dex and names it; a malformed dex is a usage error", async () => {
  const f = fixture()
  expect(
    await run(["perps", "markets", "--dex", "xyz", "--all", "--json", "--api-url", "https://api.test"], f.deps),
  ).toBe(0)
  const result = JSON.parse(f.stdout.text)
  expect(result.markets.length).toBe(8)
  expect(result.markets.every((row: { dex: string }) => row.dex === "xyz")).toBe(true)
  expect(result.dexes).toMatchObject([{ name: "xyz", collateral: "USDC", tradeable: true }])
  const text = fixture()
  expect(await run(["perps", "markets", "--dex", "xyz", "--all", "--api-url", "https://api.test"], text.deps)).toBe(0)
  expect(text.stdout.text).toContain("xyz:TSLA")
  expect(text.stdout.text).toContain("Builder dex xyz (XYZ): deployer 0x88806a71d74ad0a510b350545c9ae490912f0888")
  const bad = fixture()
  expect(await run(["perps", "markets", "--dex", "x:y", "--api-url", "https://api.test"], bad.deps)).toBe(2)
})
