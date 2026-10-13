import { describe, expect, test } from "bun:test"
import {
  CandleApiError,
  CandleOperationError,
  candleApiErrorFromResponse,
  operationIds,
  SelfLaunchOutcomeError,
  withOperationIds,
} from "./errors"

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

test("T21: Hood reason, retryAfter and legs survive the envelope parser", () => {
  const legs = [{ leg: "trade", hash: "0xhash", nonce: 8, outcome: "pending" }]
  const error = candleApiErrorFromResponse(
    409,
    JSON.stringify({
      success: false,
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "pending",
        retryable: true,
        reason: "prior_attempt_in_flight",
        retryAfter: 1000,
        legs,
      },
    }),
  )
  expect(error).toMatchObject({ reason: "prior_attempt_in_flight", retryAfter: 1000, legs })
})

describe("BE-1412 SelfLaunchOutcomeError", () => {
  const base = { clientLaunchId: "launch-1", createCurveTxHash: "0xcreate" }

  test("a fee-transfer failure carries the id, the create-curve hash, the outcome and any known fee hash", () => {
    const cause = new Error("header not found")
    const error = new SelfLaunchOutcomeError({
      ...base,
      step: "feeTransfer",
      feeOutcome: "unknown",
      feeTxHash: "0xfee",
      cause,
    })
    expect(error).toBeInstanceOf(Error)
    // The own, enumerable fields: what a logger or a JSON serializer sees.
    expect({ ...error } as Record<string, unknown>).toEqual({
      name: "SelfLaunchOutcomeError",
      chain: "hood",
      clientLaunchId: "launch-1",
      createCurveTxHash: "0xcreate",
      stage: "executed",
      step: "feeTransfer",
      feeOutcome: "unknown",
      feeTxHash: "0xfee",
      cause,
    })
    expect(error.cause).toBe(cause)
    // Recovery depends on the step and the fee outcome, so there is no blanket retryable flag.
    expect("retryable" in error).toBe(false)
  })

  test("with no known fee hash the property is absent, not undefined", () => {
    const notBroadcast = new SelfLaunchOutcomeError({
      ...base,
      step: "feeTransfer",
      feeOutcome: "not-broadcast",
      cause: new Error("estimate failed"),
    })
    const notRequired = new SelfLaunchOutcomeError({
      ...base,
      step: "confirm",
      feeOutcome: "not-required",
      cause: new Error("lost"),
    })
    for (const error of [notBroadcast, notRequired]) {
      expect("feeTxHash" in error).toBe(false)
      expect(error.feeTxHash).toBeUndefined()
    }
  })

  test("the original rejection is the cause, untouched, whether or not it is an Error", () => {
    const refusal = candleApiErrorFromResponse(
      402,
      JSON.stringify({
        success: false,
        error: { code: "FEE_LEG_MISSING", message: "no fee", retryable: false, reason: "fee_unverified" },
      }),
    )
    const refused = new SelfLaunchOutcomeError({
      ...base,
      step: "confirm",
      feeOutcome: "landed",
      feeTxHash: "0xfee",
      cause: refusal,
    })
    expect(refused.cause).toBe(refusal)
    expect(refused.cause).toBeInstanceOf(CandleApiError)
    expect(refused.cause).toMatchObject({
      code: "FEE_LEG_MISSING",
      status: 402,
      retryable: false,
      reason: "fee_unverified",
    })
    expect(refused.message).toContain("no fee")

    const value = { aborted: true }
    const odd = new SelfLaunchOutcomeError({ ...base, step: "confirm", feeOutcome: "not-required", cause: value })
    expect(odd.cause).toBe(value)
  })

  test("operationIds() reads the launch id, and withOperationIds() returns the same object unwrapped", () => {
    const error = new SelfLaunchOutcomeError({
      ...base,
      step: "confirm",
      feeOutcome: "landed",
      feeTxHash: "0xfee",
      cause: new TypeError("fetch failed"),
    })
    expect(operationIds(error)).toEqual({ clientLaunchId: "launch-1" })
    const passed = withOperationIds(error, { clientLaunchId: "launch-1" }, "caller-broadcast")
    expect(passed).toBe(error)
    expect(passed).not.toBeInstanceOf(CandleOperationError)
    expect({ ...error }).toMatchObject({
      clientLaunchId: "launch-1",
      createCurveTxHash: "0xcreate",
      feeTxHash: "0xfee",
    })
  })

  test("every message says the curve is on chain and never to rebuild, and separates a fee that may have paid from one that did not", () => {
    const make = (
      rest:
        | { step: "feeTransfer"; feeOutcome: "not-broadcast" | "reverted" | "unknown"; feeTxHash?: string }
        | { step: "confirm"; feeOutcome: "landed"; feeTxHash: string }
        | { step: "confirm"; feeOutcome: "not-required" },
    ) => new SelfLaunchOutcomeError({ ...base, ...rest, cause: new Error("the step failed") }).message
    const messages = {
      unknown: make({ step: "feeTransfer", feeOutcome: "unknown", feeTxHash: "0xfee" }),
      unknownNoHash: make({ step: "feeTransfer", feeOutcome: "unknown" }),
      notBroadcast: make({ step: "feeTransfer", feeOutcome: "not-broadcast" }),
      refused: make({ step: "feeTransfer", feeOutcome: "not-broadcast", feeTxHash: "0xfee" }),
      reverted: make({ step: "feeTransfer", feeOutcome: "reverted", feeTxHash: "0xfee" }),
      landed: make({ step: "confirm", feeOutcome: "landed", feeTxHash: "0xfee" }),
      notRequired: make({ step: "confirm", feeOutcome: "not-required" }),
    }
    for (const [label, message] of Object.entries(messages)) {
      expect(message, label).toContain("the Hood curve is on chain")
      expect(message, label).toContain("createCurveTxHash 0xcreate")
      expect(message, label).toContain("clientLaunchId launch-1")
      expect(message, label).toContain("the step failed")
      expect(message, label).toContain("Do NOT call selfLaunch() or buildSelfLaunch() again")
      expect(message, label).toContain("confirmSelfLaunch(")
    }
    for (const label of ["unknown", "unknownNoHash"] as const) {
      expect(messages[label], label).toContain("MAY have paid")
      expect(messages[label], label).toContain("Do NOT pay it again")
      expect(messages[label], label).not.toContain("did NOT pay")
    }
    expect(messages.unknown).toContain("feeTxHash 0xfee")
    expect(messages.unknownNoHash).toContain("Its hash is not known")
    for (const label of ["notBroadcast", "refused", "reverted"] as const) {
      expect(messages[label], label).toContain("did NOT pay")
      expect(messages[label], label).toContain("Pay only the missing fee")
      expect(messages[label], label).not.toContain("MAY have paid")
    }
    expect(messages.refused).toContain("names the refused transaction, not a payment")
    expect(messages.reverted).toContain("its receipt reverted (feeTxHash 0xfee)")
    // A lost confirm answer may sit on a booked launch: point at the job read, claim nothing.
    for (const label of ["landed", "notRequired"] as const) {
      expect(messages[label], label).toContain("may or may not have recorded the launch")
      expect(messages[label], label).toContain("getLaunchJob(clientLaunchId)")
      expect(messages[label], label).not.toContain("is not recorded")
      expect(messages[label], label).not.toContain("Pay only")
    }
    expect(messages.landed).toContain("The fee transfer landed (feeTxHash 0xfee)")
    expect(messages.notRequired).toContain("This build had no fee transfer")
  })
})
