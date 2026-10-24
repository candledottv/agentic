import { describe, expect, test } from "bun:test"
import {
  executeLaunchAndSeed,
  executeSweep,
  executeTrade,
  executionStatus,
  type FetchLike,
  isPaperFlag,
} from "./orchestrate"
import { __resetUpdateNoticeForTest, noteVersionHeaders } from "./update-notice"

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

describe("executeTrade: paper mode", () => {
  /*
    Paper existed on the API and was reachable from nothing an agent could call, so an agent had
    no way to rehearse a strategy before putting money behind it. The flag is the whole feature;
    everything else about the request is deliberately identical, because a paper trade is only
    worth anything if the SAME admission rules ran.
  */
  test("paper: true reaches the API", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    await executeTrade({ mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "p-1", paper: true }, CFG, fetch)
    expect(JSON.parse(String(calls[1]?.init?.body)).paper).toBe(true)
  })

  test("the rest of the request is byte-identical to a live one, so the same rules run", async () => {
    const bodies: string[] = []
    for (const paper of [undefined, true]) {
      const { calls, fetch } = fakeFetch({
        "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
        "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
      })
      await executeTrade(
        { mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "same", ...(paper ? { paper } : {}) },
        CFG,
        fetch,
      )
      const parsed = JSON.parse(String(calls[1]?.init?.body))
      delete parsed.paper
      bodies.push(JSON.stringify(parsed))
    }
    expect(bodies[0]).toBe(bodies[1])
  })

  /*
    The word "paper" must not appear in the body of a live trade. It is exactly the string someone
    greps for when they need to know whether real money moved, and a `paper: false` riding along
    on every live request would make that search useless.
  */
  test("a live trade carries no paper key at all, not paper: false", async () => {
    for (const args of [{}, { paper: false as const }]) {
      const { calls, fetch } = fakeFetch({
        "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
        "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
      })
      await executeTrade({ mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "live", ...args }, CFG, fetch)
      const raw = String(calls[1]?.init?.body)
      expect(raw).not.toContain("paper")
      expect(JSON.parse(raw)).not.toHaveProperty("paper")
    }
  })

  test("paper works on a sell too, since rehearsing an exit is the half that matters", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
    })
    await executeTrade({ mint: "M1nt", side: "sell", amount: "100", clientTradeId: "p-2", paper: true }, CFG, fetch)
    const body = JSON.parse(String(calls[1]?.init?.body))
    expect(body).toMatchObject({ side: "sell", paper: true })
  })

  test("a paper percent sell forwards percent and never reads the live wallet", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", percent: 100, clientTradeId: "p-pct", paper: true },
      CFG,
      fetch,
    )
    expect(result.isError).not.toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("https://api.test/api/v1/trade/agent/build")
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toMatchObject({ side: "sell", percent: 100, paper: true, mint: "ExtMint" })
    expect(body).not.toHaveProperty("amountRaw")
  })

  test("a paper amount sell of an external mint uses paper inventory decimals, not MARKET_NOT_FOUND", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/ExtMint": {
        status: 404,
        body: {
          success: false,
          error: { code: "MARKET_NOT_FOUND", message: "No solana market found for mint ExtMint" },
        },
      },
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: { success: true, paper: true, positions: [{ mint: "ExtMint", amountRaw: "5000000", tokenDecimals: 6 }] },
      },
      "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", amount: "5", clientTradeId: "p-amt", paper: true },
      CFG,
      fetch,
    )
    expect(result.isError).not.toBe(true)
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/markets/solana/ExtMint",
      "https://api.test/api/v1/trade/agent/paper/inventory",
      "https://api.test/api/v1/trade/agent/build",
    ])
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      side: "sell",
      amountRaw: "5000000",
      paper: true,
    })
  })

  test("a live amount sell of an external mint still relays MARKET_NOT_FOUND", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/ExtMint": {
        status: 404,
        body: {
          success: false,
          error: { code: "MARKET_NOT_FOUND", message: "No solana market found for mint ExtMint" },
        },
      },
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: { success: true, paper: true, positions: [] },
      },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", amount: "5", clientTradeId: "live-404" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text).api.error.code).toBe("MARKET_NOT_FOUND")
    expect(calls.length).toBe(2)
  })

  test('paper: "true" (string) is treated as paper on a percent sell — never reads the wallet', async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", percent: 100, clientTradeId: "p-str", paper: "true" },
      CFG,
      fetch,
    )
    expect(result.isError).not.toBe(true)
    expect(calls.length).toBe(1)
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ percent: 100, paper: true })
  })

  test("a percent sell with no paper flag still closes paper inventory when the wallet is empty", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: { address: "Hba1Empty", delegated: true }, evm: null } },
      },
      "https://api.test/api/v1/tokens/ExtMint/balance/Hba1Empty": { body: { payload: null } },
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: {
          success: true,
          paper: true,
          positions: [{ mint: "ExtMint", amountRaw: "2286574413", tokenDecimals: 6 }],
        },
      },
      "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", percent: 100, clientTradeId: "p-infer-pct" },
      CFG,
      fetch,
    )
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.text).error).toBeUndefined()
    const build = calls.find((c) => c.url.endsWith("/trade/agent/build"))
    expect(JSON.parse(String(build?.init?.body))).toMatchObject({
      side: "sell",
      percent: 100,
      paper: true,
      mint: "ExtMint",
    })
  })

  test("an amount sell of an external mint with no paper flag uses paper inventory instead of MARKET_NOT_FOUND", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/ExtMint": {
        status: 404,
        body: {
          success: false,
          error: { code: "MARKET_NOT_FOUND", message: "No solana market found for mint ExtMint" },
        },
      },
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: {
          success: true,
          paper: true,
          positions: [{ mint: "ExtMint", amountRaw: "2286574413", tokenDecimals: 6 }],
        },
      },
      "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
    })
    const result = await executeTrade(
      { mint: "ExtMint", side: "sell", amount: "2286.574413", clientTradeId: "p-infer-amt" },
      CFG,
      fetch,
    )
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      side: "sell",
      amountRaw: "2286574413",
      paper: true,
    })
  })
})

describe("isPaperFlag", () => {
  test("accepts boolean true, the string true, and 1", () => {
    expect(isPaperFlag(true)).toBe(true)
    expect(isPaperFlag("true")).toBe(true)
    expect(isPaperFlag(1)).toBe(true)
    expect(isPaperFlag("1")).toBe(true)
    expect(isPaperFlag(false)).toBe(false)
    expect(isPaperFlag("false")).toBe(false)
    expect(isPaperFlag(undefined)).toBe(false)
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
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: { success: true, paper: true, positions: [] },
      },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-no-wallet" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/embedded/i)
    expect(calls.length).toBe(2)
    expect(JSON.parse(result.text).clientTradeId).toBe("t-no-wallet")
  })

  test("a percent sell with a zero balance is a clear error, no trade attempted", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: { address: "Emb1", delegated: true }, evm: null } },
      },
      "https://api.test/api/v1/tokens/M1nt/balance/Emb1": { body: { payload: null } },
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: { success: true, paper: true, positions: [] },
      },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "sell", percent: 50, clientTradeId: "t-zero-bal" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(calls.length).toBe(3)
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
      "https://api.test/api/v1/trade/agent/paper/inventory": {
        body: { success: true, paper: true, positions: [] },
      },
    })
    const result = await executeTrade(
      { mint: "0xAbC123", side: "sell", percent: 50, clientTradeId: "t-hood-no-evm" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/EVM/)
    expect(calls.length).toBe(2)
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

  // BE-1411 T4 (I2): a limit refusal of a same-id resend adds no REST field. The id is in what the
  // MCP client is told because every build answer is wrapped with it.
  test("a build that answers KEY_LIMIT_REACHED comes back with clientTradeId at the top level", async () => {
    const refusal = {
      success: false,
      error: {
        code: "KEY_LIMIT_REACHED",
        message: "This key's transaction volume cap would be exceeded by this trade",
      },
    }
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/markets/solana/M1nt": SOL_MARKET,
      "https://api.test/api/v1/trade/agent/build": { status: 403, body: refusal },
    })
    const result = await executeTrade(
      { mint: "M1nt", side: "buy", amount: "0.5", clientTradeId: "t-limit" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientTradeId).toBe("t-limit")
    // The REST body is relayed as it is, with no id added to it.
    expect(parsed.api).toEqual(refusal)
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

/** BE-1849: what /launch/atomic/build answers for an embedded creator and first buyer: two legs Candle signs. */
const BUNDLE_BUILT = {
  bundleId: "bundle-1",
  legs: [
    { index: 0, role: "launch", signer: "server" },
    { index: 1, role: "buy", signer: "server", expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: "4000000" } },
  ],
  expiresAt: 1,
}
const BUNDLE_LANDED = {
  status: "landed",
  bundleId: "bundle-1",
  mint: "NewMint111",
  signatures: ["LaunchSig", "BuySig"],
  booking: { state: "booked", missing: [] },
}
const MAIN = { type: "main" }

describe("executeLaunchAndSeed", () => {
  test("BE-1849: a Solana devBuy is one atomic bundle from the embedded wallet: build, submit with no client legs, then the market", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": { body: BUNDLE_BUILT },
      "https://api.test/api/v1/launch/atomic/submit": { body: BUNDLE_LANDED },
      "https://api.test/api/v1/markets/solana/NewMint111": {
        body: { success: true, market: { lifecycle: "curve", decimals: 6 } },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-1", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.25" },
      CFG,
      fetch,
    )
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/launch/atomic/build",
      "https://api.test/api/v1/launch/atomic/submit",
      "https://api.test/api/v1/markets/solana/NewMint111",
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      clientLaunchId: "L-1",
      name: "T",
      symbol: "T",
      imageUrl: "https://x/y.png",
      payer: MAIN,
      firstBuys: [{ payer: MAIN, amountRaw: "250000000" }],
    })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ bundleId: "bundle-1", signedTxsBase64: [] })
    // Never the single-transaction route a Solana dev buy cannot fit on (BE-1847).
    expect(calls.some((call) => call.url.includes("/launch/headless"))).toBe(false)
    const parsed = JSON.parse(result.text)
    expect(result.isError).toBeUndefined()
    expect(parsed.clientLaunchId).toBe("L-1")
    expect(parsed.bundleId).toBe("bundle-1")
    expect(parsed.launch).toMatchObject({ status: "landed", mint: "NewMint111", signatures: ["LaunchSig", "BuySig"] })
    expect(parsed.market).toMatchObject({ lifecycle: "curve" })
  })

  test("BE-1849: a failed bundle says nothing landed and to retry with the same id; nothing else is read", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": { body: BUNDLE_BUILT },
      "https://api.test/api/v1/launch/atomic/submit": {
        status: 502,
        body: { status: "failed", bundleId: "bundle-1", retryable: true },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-f", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed).toMatchObject({ clientLaunchId: "L-f", bundleId: "bundle-1", api: { status: "failed" } })
    expect(parsed.next).toContain("Retry with the same clientLaunchId")
    expect(calls).toHaveLength(2)
  })

  test("BE-1849: an unresolved bundle points at candle_get_operation and never at a new id", async () => {
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": { body: BUNDLE_BUILT },
      "https://api.test/api/v1/launch/atomic/submit": {
        status: 502,
        body: { status: "timeout", bundleId: "bundle-1", retryable: false },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-t", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const next = JSON.parse(result.text).next
    expect(next).toContain("candle_get_operation")
    expect(next).toContain("never relaunch under a new id")
  })

  test("BE-1849: a build that hands the tool a leg to sign is not this launch, and nothing is submitted", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": {
        body: { ...BUNDLE_BUILT, legs: [BUNDLE_BUILT.legs[0], { ...BUNDLE_BUILT.legs[1], signer: "client" }] },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-c", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text).error.code).toBe("MCP_INVALID_RESPONSE")
    expect(calls).toHaveLength(1)
  })

  test("BE-1849: a Solana seed over the dev-buy ceiling is refused in the API's words before any request", async () => {
    const { calls, fetch } = fakeFetch({})
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-cap", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.6" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientLaunchId).toBe("L-cap")
    expect(parsed.error.code).toBe("DEV_BUY_TOO_HIGH")
    expect(parsed.error.message).toBe(
      "buyAmount exceeds the per-launch dev-buy ceiling of 500000000 lamports for sol on solana",
    )
    expect(calls).toHaveLength(0)
  })

  test("BE-1849: an exp-b CNDL seed over 33,000 is refused with the whole rule, before any request", async () => {
    const { calls, fetch } = fakeFetch({})
    const result = await executeLaunchAndSeed(
      {
        clientLaunchId: "L-cap-exp",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        quoteAsset: "cndl",
        mode: "exp-b",
        devBuy: "100000",
      },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.clientLaunchId).toBe("L-cap-exp")
    expect(parsed.error.code).toBe("DEV_BUY_TOO_HIGH")
    expect(parsed.error.message).toBe(
      "buyAmount exceeds this launch's dev-buy ceiling of 33000000000 CNDL raw units: " +
        "at most 2000000000000 CNDL raw units, or 10% of the threshold when that is lower",
    )
    expect(calls).toHaveLength(0)
  })

  test("BE-1849: an exp-b CNDL seed at exactly 33,000 passes the local ceiling and reaches the atomic route", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": { body: BUNDLE_BUILT },
      "https://api.test/api/v1/launch/atomic/submit": { body: BUNDLE_LANDED },
      "https://api.test/api/v1/markets/solana/NewMint111": {
        body: { success: true, market: { lifecycle: "curve", decimals: 6 } },
      },
    })
    const result = await executeLaunchAndSeed(
      {
        clientLaunchId: "L-cap-exp-at",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        quoteAsset: "cndl",
        mode: "exp-b",
        devBuy: "33000",
      },
      CFG,
      fetch,
    )
    expect(result.isError).toBeUndefined()
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/launch/atomic/build",
      "https://api.test/api/v1/launch/atomic/submit",
      "https://api.test/api/v1/markets/solana/NewMint111",
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      quoteAsset: "cndl",
      mode: "exp-b",
      firstBuys: [{ payer: MAIN, amountRaw: "33000000000" }],
    })
  })

  test("BE-1849: a tighter server ceiling than the local one is refused by the dry run or build, relayed verbatim", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": {
        status: 400,
        body: {
          success: false,
          error: {
            code: "DEV_BUY_TOO_HIGH",
            message:
              "firstBuys[0] exceeds the per-launch dev-buy ceiling of 1000000000 CNDL raw units for cndl on solana",
            field: "firstBuys[0]",
            retryable: false,
          },
        },
      },
    })
    const result = await executeLaunchAndSeed(
      {
        clientLaunchId: "L-cap-env",
        name: "T",
        symbol: "T",
        imageUrl: "https://x/y.png",
        quoteAsset: "cndl",
        devBuy: "2000",
      },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.api.error).toMatchObject({ code: "DEV_BUY_TOO_HIGH", field: "firstBuys[0]" })
    // The refusal came from the server: nothing was submitted under any id.
    expect(calls.map((call) => call.url)).toEqual(["https://api.test/api/v1/launch/atomic/build"])
  })

  test("BE-1849: with headlessSeed (the hosted server) a Solana seed stays on the headless route", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": { body: LAUNCHED },
      "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: {} } },
    })
    await executeLaunchAndSeed(
      { clientLaunchId: "L-h", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.25" },
      CFG,
      fetch,
      undefined,
      undefined,
      { headlessSeed: true },
    )
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/headless")
    expect(JSON.parse(String(calls[0]?.init?.body)).buyAmount).toBe("250000000")
    expect(calls.some((call) => call.url.includes("/launch/atomic/"))).toBe(false)
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
      { clientLaunchId: "L-3", name: "T", symbol: "T", imageUrl: "https://x/y.png" },
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
        body: { success: true, valid: true, size: { txBytes: 975, limit: 1232, fits: true } },
      },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-4", name: "T", symbol: "T", imageUrl: "https://x/y.png", dryRun: true },
      CFG,
      fetch,
    )
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/headless/dry-run")
    expect(JSON.parse(result.text).api.size.fits).toBe(true)
  })

  test("BE-1847: with headlessSeed a Solana dev buy uses the headless bundle adapter and reports its separate buy signature", async () => {
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/headless": {
        body: { ...LAUNCHED, bundleId: "creator-bundle", devBuy: { signature: "buy-sig" } },
      },
      "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: {} } },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "creator-id", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.01" },
      CFG,
      fetch,
      undefined,
      undefined,
      { headlessSeed: true },
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.text).launch.devBuy.signature).toBe("buy-sig")
    expect(JSON.parse(String(calls[0]?.init?.body)).buyAmount).toBe("10000000")
    expect(calls).toHaveLength(2)
  })

  test("BE-1849: a Solana seed's dryRun is the atomic dry run, which writes nothing, and nothing else is called", async () => {
    const preview = { success: true, dryRun: true, launchWallet: "W", fills: [{ index: 1, amountRaw: "100000000" }] }
    const { calls, fetch } = fakeFetch({ "https://api.test/api/v1/launch/atomic/dry-run": { body: preview } })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-4a", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1", dryRun: true },
      CFG,
      fetch,
    )
    expect(calls.map((call) => call.url)).toEqual(["https://api.test/api/v1/launch/atomic/dry-run"])
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      payer: MAIN,
      firstBuys: [{ payer: MAIN, amountRaw: "100000000" }],
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty("dryRun")
    expect(JSON.parse(result.text)).toEqual({ clientLaunchId: "L-4a", dryRun: true, api: preview })
  })

  test("a launch error envelope (e.g. TIER_REQUIRED on a Free plan) is relayed verbatim, marked isError, no market read", async () => {
    const envelope = {
      success: false,
      error: { code: "TIER_REQUIRED", message: "Atomic launches require Pro or Max tier" },
    }
    const { calls, fetch } = fakeFetch({
      "https://api.test/api/v1/launch/atomic/build": { status: 403, body: envelope },
    })
    const result = await executeLaunchAndSeed(
      { clientLaunchId: "L-5", name: "T", symbol: "T", imageUrl: "https://x/y.png", devBuy: "0.1" },
      CFG,
      fetch,
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ clientLaunchId: "L-5", api: envelope })
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
      "https://api.test/api/v1/launch/atomic/build": { body: BUNDLE_BUILT },
      "https://api.test/api/v1/launch/atomic/submit": { body: BUNDLE_LANDED },
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
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).not.toHaveProperty("buyAmount")
    expect(body.firstBuys).toEqual([{ payer: MAIN, amountRaw: "250000000" }])
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

describe("executeSweep", () => {
  const cfg = { apiUrl: "https://api.test", apiKey: "cndl_live_k" }

  function sweepFetch(perAsset: Record<string, { ok: boolean; body: unknown }>) {
    const calls: { asset: string }[] = []
    const doFetch = (async (_url: string, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { asset?: string; mint?: string }
      const key = body.asset ?? body.mint ?? "?"
      calls.push({ asset: key })
      const answer = perAsset[key] ?? { ok: true, body: { success: true, amountRaw: "1", signature: `sig-${key}` } }
      return {
        ok: answer.ok,
        status: answer.ok ? 200 : 400,
        text: async () => JSON.stringify(answer.body),
      }
    }) as never
    return { calls, doFetch }
  }

  test("sweeps tokens before the native asset -- the native asset pays the fees", async () => {
    const { calls, doFetch } = sweepFetch({})
    await executeSweep({ chain: "solana", to: "Dest" }, cfg, doFetch)
    expect(calls.map((c) => c.asset)).toEqual(["USDC", "CNDL", "SOL"])
  })

  test("explicit mints sweep after base tokens, still before the native asset", async () => {
    const { calls, doFetch } = sweepFetch({})
    await executeSweep({ chain: "solana", to: "Dest", mints: ["Mint1"] }, cfg, doFetch)
    expect(calls.map((c) => c.asset)).toEqual(["USDC", "CNDL", "Mint1", "SOL"])
  })

  test("empty assets report empty, failures report error, and neither stops the rest", async () => {
    const { doFetch } = sweepFetch({
      USDC: { ok: false, body: { error: { code: "TRANSFER_AMOUNT_UNAVAILABLE", message: "zero" } } },
      CNDL: { ok: false, body: { error: { code: "TRANSFER_FAILED", message: "boom" } } },
    })
    const result = await executeSweep({ chain: "solana", to: "Dest" }, cfg, doFetch)
    const parsed = JSON.parse(result.text) as {
      transferred: number
      failed: number
      results: { asset: string; status: string }[]
    }
    expect(parsed.results.map((r) => `${r.asset}:${r.status}`)).toEqual(["USDC:empty", "CNDL:error", "SOL:transferred"])
    expect(parsed.transferred).toBe(1)
    expect(parsed.failed).toBe(1)
    expect(result.isError).toBeUndefined()
  })

  test("isError only when nothing transferred and something genuinely failed", async () => {
    const { doFetch } = sweepFetch({
      USDC: { ok: false, body: { error: { code: "TRANSFER_FAILED", message: "boom" } } },
      CNDL: { ok: false, body: { error: { code: "TRANSFER_AMOUNT_UNAVAILABLE", message: "zero" } } },
      SOL: { ok: false, body: { error: { code: "TRANSFER_FAILED", message: "boom" } } },
    })
    const result = await executeSweep({ chain: "solana", to: "Dest" }, cfg, doFetch)
    expect(result.isError).toBe(true)
  })

  test("hood sweeps USDG then ETH", async () => {
    const { calls, doFetch } = sweepFetch({})
    await executeSweep({ chain: "hood", to: "0xdest" }, cfg, doFetch)
    expect(calls.map((c) => c.asset)).toEqual(["USDG", "ETH"])
  })
})

describe("executionStatus max-expiry notice", () => {
  const ROUTES = {
    "https://api.test/api/v1/agent/wallets/embedded": {
      body: { success: true, wallets: { solana: { address: "abc", delegated: true }, evm: null } },
    },
    "https://api.test/api/v1/agent/keys/self/limits": { body: { success: true, limits: [] } },
  }

  test("a lapsed Max surfaces as a top-level notice, in the server's own words", async () => {
    const notice =
      "Your Max plan expired on 2026-08-30. Renew to restore 0% trade fees and up to 1,000 linked wallets: https://alpha.candle.tv/agents/pricing"
    const { fetch } = fakeFetch({
      ...ROUTES,
      "https://api.test/api/v1/agent/tier": {
        body: { success: true, tier: "free", feeBps: 100, maxExpired: true, maxExpiredNotice: notice },
      },
    })
    const out = await executionStatus(CFG, fetch)
    const body = JSON.parse(out.text) as { ready?: boolean; notice?: string }
    // The agent reads this JSON: the notice sits at the top, not buried in tier.body, because it
    // changes what to do next -- trades on this account are no longer fee-free.
    expect(body.notice).toBe(notice)
    expect(body.ready).toBe(true)
  })

  test("an active plan carries no notice at all", async () => {
    const { fetch } = fakeFetch({
      ...ROUTES,
      "https://api.test/api/v1/agent/tier": {
        body: { success: true, tier: "max", feeBps: 0, maxExpired: false },
      },
    })
    const body = JSON.parse((await executionStatus(CFG, fetch)).text) as { notice?: string }
    expect(body.notice).toBeUndefined()
  })
})

describe("executionStatus update notice", () => {
  test("a newer server version rides the header into a structured updateAvailable", async () => {
    __resetUpdateNoticeForTest()
    const { fetch } = fakeFetch({
      "https://api.test/api/v1/agent/wallets/embedded": {
        body: { success: true, wallets: { solana: null, evm: null } },
      },
      "https://api.test/api/v1/agent/keys/self/limits": { body: { success: true, limits: [] } },
      "https://api.test/api/v1/agent/tier": { body: { success: true, tier: "max", feeBps: 0, maxExpired: false } },
    })
    // fakeFetch's responses have no headers, so simulate the capture the real fetch site does.
    noteVersionHeaders(new Response("{}", { headers: { "x-candle-mcp-latest": "99.0.0" } }))
    const body = JSON.parse((await executionStatus(CFG, fetch)).text) as {
      updateAvailable?: { current: string; latest: string; command: string }
    }
    expect(body.updateAvailable?.latest).toBe("99.0.0")
    expect(body.updateAvailable?.command).toBe("npm install -g @candledottv/mcp@latest")
    __resetUpdateNoticeForTest()
  })
})

describe("paper mint matching", () => {
  for (const [mint, heldMint] of [
    ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"],
    ["  ExtMint  ", "ExtMint"],
  ] as const) {
    test(`matches canonical inventory for ${mint}`, async () => {
      const { calls, fetch } = fakeFetch({
        "https://api.test/api/v1/markets/": {
          status: 404,
          body: { success: false, error: { code: "MARKET_NOT_FOUND" } },
        },
        "https://api.test/api/v1/trade/agent/paper/inventory": {
          body: { success: true, paper: true, positions: [{ mint: heldMint, amountRaw: "5000000", tokenDecimals: 6 }] },
        },
        "https://api.test/api/v1/trade/agent/build": { body: { success: true, paper: true } },
      })
      const result = await executeTrade(
        { mint, side: "sell", amount: "5", clientTradeId: "canonical-paper", paper: true },
        CFG,
        fetch,
      )
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({ amountRaw: "5000000", paper: true })
    })
  }
})

test("live sell forwards wrong-chain discovery and explicit retryability without inventory fallback", async () => {
  const error = {
    code: "MARKET_NOT_FOUND",
    message: "try hood",
    retryable: false,
    routing: { reason: "chain_mismatch" },
    discovery: { indexed: true, chain: "hood" },
  }
  const { calls, fetch } = fakeFetch({
    "https://api.test/api/v1/markets/solana/ExtMint": { status: 404, body: { success: false, error } },
  })
  const result = await executeTrade(
    { mint: "ExtMint", side: "sell", amount: "5", clientTradeId: "wrong-chain" },
    CFG,
    fetch,
  )
  expect(JSON.parse(result.text).api.error).toEqual(error)
  expect(calls.length).toBe(1)
})

test("external market 200 uses the selected quote asset scale for a buy", async () => {
  const { calls, fetch } = fakeFetch({
    "https://api.test/api/v1/markets/solana/ExtMint": {
      body: { success: true, market: { candleLaunched: false, external: true, quoteDecimals: 9, decimals: 6 } },
    },
    "https://api.test/api/v1/trade/agent/build": { body: EXECUTED },
  })
  const result = await executeTrade(
    { mint: "ExtMint", side: "buy", amount: "1", quoteAsset: "usdc", clientTradeId: "external-usdc" },
    CFG,
    fetch,
  )
  expect(result.isError).toBeUndefined()
  expect(JSON.parse(String(calls[1]?.init?.body)).amountRaw).toBe("1000000")
})
