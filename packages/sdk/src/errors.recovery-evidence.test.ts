import { describe, expect, test } from "bun:test"
import { candleApiErrorFromResponse } from "./errors"

const evidence = {
  operationId: "op-1",
  legIndex: 1,
  legKind: "trade",
  legEvidence: [
    {
      legIndex: 1,
      kind: "trade",
      outcome: "uncertain",
      hash: `0x${"ab".repeat(32)}`,
      chainId: 4663,
      sender: "0xaa",
      reason: "already_known",
    },
  ],
  reconciliation: "pending",
  recoveryRequired: true,
  safeAction: "read_status",
  pollAfterMs: 5000,
  statusKind: "trade",
}

describe("BE-3072: CandleApiError keeps the recovery evidence", () => {
  test("beside the envelope's error (the trade rail)", () => {
    const body = {
      success: false,
      error: { code: "SWAP_FAILED", message: "m", retryable: false, stage: "unconfirmed" },
      landedLegs: [{ kind: "approval", hash: "0x1" }],
      ...evidence,
      futureField: 1,
    }
    const error = candleApiErrorFromResponse(500, JSON.stringify(body))
    expect(error).toMatchObject({ ...evidence, landedLegs: [{ kind: "approval", hash: "0x1" }], stage: "unconfirmed" })
    expect(error.retryable).toBe(false)
  })
  test("inside the error (swap, launch and transfer rails), with unknown fields ignored", () => {
    const body = {
      success: false,
      error: {
        code: "SWAP_FAILED",
        message: "m",
        retryable: false,
        ...evidence,
        landedLegs: [],
        futureField: { x: 1 },
      },
    }
    const error = candleApiErrorFromResponse(500, JSON.stringify(body))
    expect(error.safeAction).toBe("read_status")
    expect(error.pollAfterMs).toBe(5000)
    expect(error.landedLegs).toEqual([])
    expect((error as unknown as Record<string, unknown>).futureField).toBeUndefined()
  })
  test("fields of the wrong type are dropped, and an old server's envelope has none", () => {
    const bad = candleApiErrorFromResponse(
      500,
      JSON.stringify({
        success: false,
        error: {
          code: "X",
          message: "m",
          safeAction: "retry_now",
          pollAfterMs: "5",
          recoveryRequired: "yes",
          reconciliation: "later",
        },
      }),
    )
    expect(bad.safeAction).toBeUndefined()
    expect(bad.pollAfterMs).toBeUndefined()
    expect(bad.recoveryRequired).toBeUndefined()
    expect(bad.reconciliation).toBeUndefined()
    const old = candleApiErrorFromResponse(
      500,
      JSON.stringify({ success: false, error: { code: "SWAP_FAILED", message: "m", stage: "not_broadcast" } }),
    )
    expect(old.legEvidence).toBeUndefined()
  })
})
