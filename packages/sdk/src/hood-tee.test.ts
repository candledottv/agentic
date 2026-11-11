import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

test("Hood operation status/recover keep redacted guard and never invoke a signer", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const guard = { operationId: "op-1", reason: "legacy_identity_missing", recoveryRequired: true }
  const client = new CandleClient({
    apiKey: "test",
    apiUrl: "https://api.fixture.test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Response.json({ success: true, operation: { operationId: "op-1", guard } })
    }) as unknown as typeof fetch,
  })
  expect((await client.getHoodTeeOperation("op-1")).guard).toMatchObject(guard)
  expect((await client.recoverHoodTeeOperation("op-1", { candidateHash: "0xhash" })).guard).toMatchObject(guard)
  expect(calls.map((c) => c.method)).toEqual(["GET", "POST"])
  expect(calls[1]?.body).toEqual({ candidateHash: "0xhash" })
})
test("WALLET_BUSY preserves actionable details on CandleApiError", async () => {
  const details = {
    operationId: "op",
    operationKind: "transfer",
    refId: "ref",
    legIndex: 0,
    reason: "legacy_identity_missing",
    clearingCondition: "Verified receipt",
    statusPath: "/api/v1/agent/hood-tee/operations/op",
    statusCommand: "candle swap status --operation op",
  }
  const client = new CandleClient({
    apiKey: "test",
    apiUrl: "https://api.fixture.test",
    fetch: (async () =>
      Response.json(
        { success: false, error: { code: "WALLET_BUSY", message: "held", retryable: false, ...details } },
        { status: 409 },
      )) as unknown as typeof fetch,
  })
  const error = await client.getHoodTeeOperation("op").catch((e) => e)
  expect(error).toBeInstanceOf(CandleApiError)
  expect(error).toMatchObject(details)
})
