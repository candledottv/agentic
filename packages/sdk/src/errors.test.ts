import { describe, expect, test } from "bun:test"
import { candleApiErrorFromResponse } from "./errors"

describe("Release A structured failures", () => {
  test.each([
    ["MARKET_NOT_FOUND", 404, "not_candle_market", false],
    ["MARKET_NOT_FOUND", 404, "hood_market_unavailable", false],
    ["QUOTE_UNAVAILABLE", 503, "future_dependency_reason", true],
    ["QUOTE_UNAVAILABLE", 503, "hood_market_unavailable", false],
  ] as const)("%s %i %s preserves explicit retryability", (code, status, reason, retryable) => {
    const error = {
      code,
      message: "request POST /api/v1/trade/agent/quote",
      retryable,
      routing: { reason },
      discovery: { indexed: true, chain: "solana" },
      uiHint: "POST /api/v1/trade/agent/quote",
      docsPath: "developers/agent-trading",
      coverage: { covered: false },
    }
    expect(candleApiErrorFromResponse(status, JSON.stringify({ success: false, error }))).toMatchObject({
      ...error,
      status,
    })
  })
  test("old deployments with no routing remain readable", () => {
    expect(
      candleApiErrorFromResponse(
        404,
        JSON.stringify({ success: false, error: { code: "MARKET_NOT_FOUND", message: "old" } }),
      ),
    ).toMatchObject({ code: "MARKET_NOT_FOUND", retryable: false, routing: undefined })
  })
})

describe("BE-902 stage, signature and fee details survive the parser", () => {
  test("a Hood FEE_LEG_MISSING keeps stage, signature, recorded and the fee payment details", () => {
    const error = {
      code: "FEE_LEG_MISSING",
      message: "Warning: trade executed; fee/booking incomplete.",
      retryable: true,
      stage: "executed",
      signature: "0xabc",
      recorded: true,
      feeRaw: "5000",
      quoteAsset: "eth",
      treasury: "0xTreasury",
    }
    const parsed = candleApiErrorFromResponse(402, JSON.stringify({ success: false, error }))
    expect(parsed).toMatchObject({ ...error, status: 402 })
  })
  test("an error without them leaves them undefined", () => {
    const parsed = candleApiErrorFromResponse(
      402,
      JSON.stringify({ success: false, error: { code: "FEE_LEG_MISSING", message: "x" } }),
    )
    expect(parsed.stage).toBeUndefined()
    expect(parsed.signature).toBeUndefined()
  })
})
