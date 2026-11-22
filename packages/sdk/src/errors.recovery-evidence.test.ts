import { describe, expect, test } from "bun:test"
import { CandleApiError, candleApiErrorFromResponse } from "./errors"

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

test("BE-4297: CandleApiError keeps the response's request id and names it in the message", async () => {
  const { CandleClient } = await import("./client")
  const body = { success: false, error: { code: "FEE_LEG_MISSING", message: "No fee leg", retryable: false } }
  const withId = (async () =>
    Response.json(body, {
      status: 409,
      headers: { "X-Candle-Request-Id": "req-abc-12345" },
    })) as unknown as typeof fetch
  const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "k", fetch: withId })
  const err = await client.getOwnProfile().catch((e) => e)
  expect(err).toBeInstanceOf(CandleApiError)
  expect(err.requestId).toBe("req-abc-12345")
  expect(err.code).toBe("FEE_LEG_MISSING")
  expect(err.message).toBe("No fee leg (request id req-abc-12345)")
  const without = (async () => Response.json(body, { status: 409 })) as unknown as typeof fetch
  const err2 = await new CandleClient({ apiUrl: "https://api.test", apiKey: "k", fetch: without })
    .getOwnProfile()
    .catch((e) => e)
  expect(err2.requestId).toBeUndefined()
  expect(err2.message).toBe("No fee leg")
  const proxy = (async () =>
    new Response("bad gateway", {
      status: 502,
      headers: { "x-candle-request-id": "req-proxy-9999" },
    })) as unknown as typeof fetch
  const err3 = await new CandleClient({ apiUrl: "https://api.test", apiKey: "k", fetch: proxy })
    .getOwnProfile()
    .catch((e) => e)
  expect(err3.code).toBe("HTTP_502")
  expect(err3.requestId).toBe("req-proxy-9999")
})

test("BE-4297: requestIdOf ignores an unbounded or unsafe proxy header", async () => {
  const { requestIdOf } = await import("./errors")
  const res = (v: string) => ({ headers: new Headers({ "x-candle-request-id": v }) })
  expect(requestIdOf(res("req-12345678"))).toBe("req-12345678")
  for (const bad of ["short", "a".repeat(65), "has space in it", "\u001b[31mred-escape-1", "<script>alert1</script>"])
    expect(requestIdOf(res(bad))).toBeUndefined()
  expect(requestIdOf({})).toBeUndefined()
})
