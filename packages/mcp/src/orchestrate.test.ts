import { describe, expect, test } from "bun:test"
import { executeLaunchAndSeed, executeTrade, type FetchLike } from "./orchestrate"

const CFG = { apiUrl: "https://api.test", apiKey: "cndl_live_k" }

interface Call {
  url: string
  init?: RequestInit
}

/** URL-prefix-routed fake fetch recording every call. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = []
  const doFetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (!hit) throw new Error(`unrouted url in test: ${url}`)
    const { status = 200, body } = hit[1]
    return { ok: status < 400, status, text: async () => JSON.stringify(body) }
  }
  return { calls, fetch: doFetch }
}

const EXECUTED = {
  success: true,
  status: "executed",
  clientTradeId: "will-be-overwritten-by-echo-check",
  chain: "solana",
  signature: "Sig111",
  fee: { bps: 100, feeRaw: "1000", treasury: "T" },
  amounts: { amountRaw: "500000000", expectedOutRaw: "123", minOutRaw: "120", quoteAsset: "sol" },
}

/** A SOL-quoted Candle market: token decimals 6, quote (SOL) decimals 9. */
const SOL_MARKET = { body: { success: true, market: { decimals: 6, quoteDecimals: 9 } } }

describe("executeTrade: buys", () => {
  test("a buy reads the market and converts against the TOKEN'S quote decimals", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade({ mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "t-1" }, CFG, fetch)
    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toBe("https://api.test/api/v1/markets/solana/M1nt")
    const body = JSON.parse(String(calls[1]?.init?.body))
    expect(body).toMatchObject({
      clientTradeId: "t-1",
      mint: "M1nt",
      side: "buy",
      amountRaw: "500000000",
      payer: { type: "main" },
    })
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-1")
    expect(parsed.resolved).toMatchObject({ amountRaw: "500000000", decimals: 9, amountDecimal: "0.5" })
  })

  test("REGRESSION: a USDC-quoted token converts at 6 decimals, not the sol default's 9", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/UsdcTok": {
        body: { success: true, market: { decimals: 6, quoteDecimals: 6 } },
      },
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade(
      { mint: "UsdcTok", side: "buy", amount: "100", clientTradeId: "t-usdc" },
      CFG,
      fetch,
    )
    const body = JSON.parse(String(calls[1]?.init?.body))
    expect(body.amountRaw).toBe("100000000")
    expect(body.amountRaw).not.toBe("100000000000")
    expect(JSON.parse(result.text).resolved.decimals).toBe(6)
  })

  test("the caller's quoteAsset rides along to the API but never drives a buy's decimals", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    await executeTrade(
      { mint: "M1nt", side: "buy", amount: "1000", quoteAsset: "usdc", clientTradeId: "t-2" },
      CFG,
      fetch,
    )
    const body = JSON.parse(String(calls[1]?.init?.body))
    // The market says SOL (9), so 1000 is 1000 SOL, NOT 1000 USDC at 6 decimals.
    expect(body.amountRaw).toBe("1000000000000")
    expect(body.quoteAsset).toBe("usdc")
  })

  test("a mint with no Candle market falls back to the caller's quoteAsset, the way the API does", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/JupTok": {
        status: 404,
        body: { success: false, error: { code: "MARKET_NOT_FOUND", message: "no market" } },
      },
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade(
      { mint: "JupTok", side: "buy", amount: "250", quoteAsset: "usdc", clientTradeId: "t-jup" },
      CFG,
      fetch,
    )
    expect(calls.length).toBe(2)
    expect(JSON.parse(String(calls[1]?.init?.body)).amountRaw).toBe("250000000")
    expect(result.isError).toBeUndefined()
  })

  test("a market that reports no quoteDecimals is a clear error, no trade attempted", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": { body: { success: true, market: { decimals: 6 } } },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", amount: "1", clientTradeId: "t-no-quote-decimals" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/quote decimals/)
    expect(calls.length).toBe(1)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-no-quote-decimals")
  })

  test("clientTradeId is auto-generated when omitted and echoed back", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade({ mint: "M1nt", side: "buy", amount: "0.5" }, CFG, fetch)
    const sent = JSON.parse(String(calls[1]?.init?.body)).clientTradeId
    expect(typeof sent).toBe("string")
    expect(sent.length).toBeGreaterThan(0)
    expect(JSON.parse(result.text).clientTradeId).toBe(sent)
  })

  test("percent on a buy is rejected before any request", async () => {
    const { calls, fetch } = fakeFetch({})
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", percent: 50, clientTradeId: "t-percent-buy" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/percent/)
    expect(calls.length).toBe(0)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-percent-buy")
  })

  test("an unknown quoteAsset on the arbitrary-mint path is rejected, with the id still echoed", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/JupTok": {
        status: 404,
        body: { success: false, error: { code: "MARKET_NOT_FOUND", message: "no market" } },
      },
    })
    const result = await executeTrade(
      { mint: "JupTok", side: "buy", amount: "1", quoteAsset: "doge", clientTradeId: "t-bad-quote" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/quoteAsset/)
    expect(calls.length).toBe(1)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-bad-quote")
  })

  test("a malformed amount fails conversion and is caught, with the id still echoed", async () => {
    const { calls, fetch } = fakeFetch({ "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET })
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", amount: "not-a-number", clientTradeId: "t-bad-amount" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(calls.length).toBe(1)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-bad-amount")
  })
})

describe("executeTrade: sells", () => {
  test("a sell with amount reads market decimals then trades", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": { body: { success: true, market: { decimals: 6 } } },
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    await executeTrade({ mint: "M1nt", side: "sell", amount: "1000", clientTradeId: "t-3" }, CFG, fetch)
    expect(calls.length).toBe(2)
    const body = JSON.parse(String(calls[1]?.init?.body))
    expect(body.amountRaw).toBe("1000000000")
    expect(body.side).toBe("sell")
  })

  test("unresolvable market decimals is a clear error, with the id still echoed", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": { body: { success: true, market: {} } },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "sell", amount: "1000", clientTradeId: "t-no-decimals" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/decimals/)
    expect(calls.length).toBe(1)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-no-decimals")
  })

  test("a percent sell resolves wallet then balance then trades the floored share", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: { address: "Emb1", delegated: true }, evm: null } },
      },
      "https://api.test/api/v1/tokens/M1nt/balance/Emb1": {
        body: { payload: { balance: "1000001", uiAmount: 1.000001, decimals: 6 } },
      },
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade({ mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-4" }, CFG, fetch)
    expect(calls.length).toBe(3)
    const body = JSON.parse(String(calls[2]?.init?.body))
    expect(body.amountRaw).toBe("500000")
    expect(JSON.parse(result.text).resolved.percent).toBe(50)
  })

  test("a percent sell with no embedded solana wallet is a clear error, no trade attempted", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: null, evm: null } },
      },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-no-wallet" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/embedded/i)
    expect(calls.length).toBe(1)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-no-wallet")
  })

  test("a percent sell with a zero balance is a clear error, no trade attempted", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: { address: "Emb1", delegated: true }, evm: null } },
      },
      "https://api.test/api/v1/tokens/M1nt/balance/Emb1": { body: { payload: null } },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-zero-bal" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(calls.length).toBe(2)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-zero-bal")
  })

  test("a percent sell on a 0x (hood) mint reads the EVM wallet, not the Solana one", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: {
          success: true,
          wallets: { solana: { address: "Emb1", delegated: true }, evm: { address: "0xEmb2", delegated: true } },
        },
      },
      "https://api.test/api/v1/tokens/0xAbC123/balance/0xEmb2": {
        body: { payload: { balance: "2000000000000000000", uiAmount: 2, decimals: 18 } },
      },
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    const result = await executeTrade(
      { mint: "0xAbC123", side: "sell", percent: 50, clientTradeId: "t-hood-percent" },
      CFG,
      fetch,
    )
    expect(calls.length).toBe(3)
    // Sized off the raw string, so an 18-decimal balance past 2^53 stays exact.
    expect(JSON.parse(String(calls[2]?.init?.body)).amountRaw).toBe("1000000000000000000")
    expect(JSON.parse(result.text).resolved.percent).toBe(50)
  })

  test("a percent sell on a hood mint with no embedded EVM wallet names the EVM wallet", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: { address: "Emb1", delegated: true }, evm: null } },
      },
    })
    const result = await executeTrade(
      { mint: "0xAbC123", side: "sell", percent: 50, clientTradeId: "t-hood-no-evm" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/EVM/)
    expect(calls.length).toBe(1)
  })

  test("a non-ok wallet read is relayed verbatim, not reported as a missing wallet", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        status: 401,
        body: { success: false, error: { code: "UNAUTHORIZED", message: "invalid api key" } },
      },
    })
    const result = await executeTrade({ mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-401" }, CFG, fetch)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-401")
    expect(parsed.api.error.code).toBe("UNAUTHORIZED")
    expect(result.text).not.toMatch(/embedded Solana wallet/)
    expect(calls.length).toBe(1)
  })

  test("a non-ok market read is relayed verbatim, not reported as unresolvable decimals", async () => {
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": {
        status: 500,
        body: { success: false, error: { code: "INTERNAL", message: "convex down" } },
      },
    })
    const result = await executeTrade({ mint: "M1nt", side: "sell", amount: "10", clientTradeId: "t-500" }, CFG, fetch)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-500")
    expect(parsed.api.error.code).toBe("INTERNAL")
    expect(result.text).not.toMatch(/could not resolve/)
  })

  test("amount and percent together, or neither, are rejected before any request", async () => {
    const { calls, fetch } = fakeFetch({})
    const both = await executeTrade(
      { mint: "M1nt", side: "sell", amount: "1", percent: 50, clientTradeId: "t-both" },
      CFG,
      fetch,
    )
    expect(both.isError).toBe(true)
    expect(JSON.parse(both.text).clientTradeId).toBe("t-both")
    const neither = await executeTrade({ mint: "M1nt", side: "sell", clientTradeId: "t-neither" }, CFG, fetch)
    expect(neither.isError).toBe(true)
    expect(JSON.parse(neither.text).clientTradeId).toBe("t-neither")
    expect(calls.length).toBe(0)
  })
})

describe("executeTrade: relay discipline", () => {
  test("an API error envelope is relayed verbatim, marked isError", async () => {
    const envelope = { success: false, error: { code: "SPEND_LIMIT_EXCEEDED", message: "over cap" } }
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { status: 400, body: envelope },
    })
    const result = await executeTrade({ mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "t-5" }, CFG, fetch)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("SPEND_LIMIT_EXCEEDED")
    expect(result.text).toContain("t-5")
  })

  test("a rejected trade POST returns MCP_TRANSPORT carrying the id, never a throw", async () => {
    const doFetch: FetchLike = async (url) => {
      if (url.startsWith("https://api.test/api/v1/markets/")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(SOL_MARKET.body) }
      }
      throw new Error("socket hang up")
    }
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "t-boom" },
      CFG,
      doFetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-boom")
    expect(parsed.error.code).toBe("MCP_TRANSPORT")
    expect(parsed.error.message).toMatch(/socket hang up/)
    expect(parsed.error.message).toMatch(/SAME clientTradeId/)
  })

  test("a non-JSON trade response returns MCP_TRANSPORT carrying the id, never a throw", async () => {
    const doFetch: FetchLike = async (url) => {
      if (url.startsWith("https://api.test/api/v1/markets/")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(SOL_MARKET.body) }
      }
      return { ok: false, status: 502, text: async () => "<html>502 Bad Gateway</html>" }
    }
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "t-html" },
      CFG,
      doFetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-html")
    expect(parsed.error.code).toBe("MCP_TRANSPORT")
  })

  test("a missing api key throws the standard message before any request", async () => {
    const { calls, fetch } = fakeFetch({})
    await expect(
      executeTrade({ mint: "M1nt", side: "buy", amount: "1" }, { apiUrl: "https://api.test" }, fetch),
    ).rejects.toThrow(/CANDLE_AGENT_API_KEY/)
    expect(calls.length).toBe(0)
  })
})

const LAUNCHED = {
  success: true,
  chain: "solana",
  mint: "NewMint111",
  pool: "Pool111",
  signature: "LaunchSig",
  quoteAsset: "sol",
  mode: "open",
  links: { candle: "https://candle.tv/token/NewMint111", explorer: "https://solscan.io/tx/LaunchSig" },
  devBuy: { fee: { bps: 100, feeRaw: "1000", treasury: "T" } },
}

describe("executeLaunchAndSeed", () => {
  test("launches with the devBuy converted to raw quote units, then reads the market", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": {
        body: { success: true, market: { lifecycle: "curve", decimals: 6 } },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-1", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.25" },
      CFG,
      fetch,
    )
    expect(calls.length).toBe(2)
    const launchBody = JSON.parse(String(calls[0]?.init?.body))
    expect(launchBody.buyAmount).toBe("250000000")
    expect(launchBody.devBuy).toBeUndefined()
    const parsed = JSON.parse(result.text)
    expect(parsed.clientLaunchId).toBe("L-1")
    expect(parsed.launch.mint).toBe("NewMint111")
    expect(parsed.launch.links.candle).toBe("https://candle.tv/token/NewMint111")
    expect(parsed.market).toMatchObject({ lifecycle: "curve" })
  })

  test("a launch without devBuy sends no buyAmount", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: {} } },
    })
    await executeLaunchAndSeed(
      { clientLaunchId: "L-2", name: "T", symbol: "T", imageUrl: "https://x/y.png" },
      CFG,
      fetch,
    )
    const launchBody = JSON.parse(String(calls[0]?.init?.body))
    expect(launchBody.buyAmount).toBeUndefined()
  })

  test("clientLaunchId auto-generates when omitted and is echoed", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: {} } },
    })
    const result = await executeLaunchAndSeed({ name: "T", symbol: "T", imageUrl: "https://x/y.png" }, CFG, fetch)
    const sent = JSON.parse(String(calls[0]?.init?.body)).clientLaunchId
    expect(typeof sent).toBe("string")
    expect(JSON.parse(result.text).clientLaunchId).toBe(sent)
  })

  test("PARTIAL FAILURE: market read fails after a real launch; mint and links still returned, market null, no throw", async () => {
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": { status: 500, body: { error: "boom" } },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-3", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      fetch,
    )
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.text)
    expect(parsed.launch.mint).toBe("NewMint111")
    expect(parsed.market).toBeNull()
    expect(parsed.note).toMatch(/market/i)
  })

  test("dryRun routes to /dry-run, relays the response, and never reads the market", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless/dry-run": {
        body: { success: true, valid: true, size: { txBytes: 1200, limit: 1232, fits: true } },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-4", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1", dryRun: true },
      CFG,
      fetch,
    )
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/headless/dry-run")
    expect(JSON.parse(result.text).api.size.fits).toBe(true)
  })

  test("a launch error envelope (e.g. DEV_BUY_TOO_HIGH) is relayed verbatim, marked isError, no market read", async () => {
    const envelope = { success: false, error: { code: "DEV_BUY_TOO_HIGH", message: "over ceiling" } }
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { status: 400, body: envelope },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-5", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "999" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain("DEV_BUY_TOO_HIGH")
    expect(calls.length).toBe(1)
  })

  test("a devBuy with an unknown quoteAsset is rejected before any request, with the id still echoed", async () => {
    const { calls, fetch } = fakeFetch({})
    const result = await executeLaunchAndSeed(
      { name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "1", quoteAsset: "doge" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(calls.length).toBe(0)
    const parsed = JSON.parse(result.text)
    expect(typeof parsed.clientLaunchId).toBe("string")
    expect(parsed.clientLaunchId.length).toBeGreaterThan(0)
  })

  test("a malformed devBuy fails conversion and is caught before any request, with the id still echoed", async () => {
    const { calls, fetch } = fakeFetch({})
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-6", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "not-a-number" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(calls.length).toBe(0)
    expect(JSON.parse(result.text).clientLaunchId).toBe("L-6")
  })

  test("REGRESSION: a hood devBuy with no quoteAsset converts at ETH's 18 decimals, not sol's 9", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: { ...LAUNCHED, chain: "hood", mint: "0xNew" } },
      "https://api.test/api/v1/markets/hood/0xNew": { body: { success: true, market: {} } },
    })
    await executeLaunchAndSeed(
      {
        clientLaunchId: "L-hood",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        chain: "hood",
        dexVersion: "v3",
        devBuy: "0.1",
      },
      CFG,
      fetch,
    )
    const launchBody = JSON.parse(String(calls[0]?.init?.body))
    expect(launchBody.buyAmount).toBe("100000000000000000")
    expect(launchBody.buyAmount).not.toBe("100000000")
  })

  test("an explicit hood quoteAsset converts with THAT pair's decimals", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: { ...LAUNCHED, chain: "hood", mint: "0xNew" } },
      "https://api.test/api/v1/markets/hood/0xNew": { body: { success: true, market: {} } },
    })
    await executeLaunchAndSeed(
      {
        clientLaunchId: "L-usdg",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        chain: "hood",
        quoteAsset: "usdg",
        dexVersion: "v3",
        devBuy: "25",
      },
      CFG,
      fetch,
    )
    expect(JSON.parse(String(calls[0]?.init?.body)).buyAmount).toBe("25000000")
  })

  test("a caller-supplied raw buyAmount is stripped; devBuy is the only seed input", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: {} } },
    })
    await executeLaunchAndSeed(
      {
        clientLaunchId: "L-strip",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        buyAmount: "999000000000",
        devBuy: "0.25",
      },
      CFG,
      fetch,
    )
    expect(JSON.parse(String(calls[0]?.init?.body)).buyAmount).toBe("250000000")
  })

  test("a rejected launch POST returns MCP_TRANSPORT carrying the id, never a throw", async () => {
    const doFetch: FetchLike = async () => {
      throw new Error("ETIMEDOUT")
    }
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-boom", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      doFetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientLaunchId).toBe("L-boom")
    expect(parsed.error.code).toBe("MCP_TRANSPORT")
    expect(parsed.error.message).toMatch(/ETIMEDOUT/)
    expect(parsed.error.message).toMatch(/SAME clientLaunchId/)
  })

  test("a non-JSON launch response returns MCP_TRANSPORT carrying the id, never a throw", async () => {
    const doFetch: FetchLike = async () => ({
      ok: false,
      status: 504,
      text: async () => "upstream timeout",
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-html", name: "T", symbol: "T", imageUrl: "https://x/y.png" },
      CFG,
      doFetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientLaunchId).toBe("L-html")
    expect(parsed.error.code).toBe("MCP_TRANSPORT")
  })
})
