import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

function fixture(status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new CandleClient({
    apiUrl: "http://localhost",
    apiKey: "key",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json(
        status === 200
          ? { success: true, signature: "same-sig" }
          : { success: false, error: { code: "LAUNCH_DISABLED", message: "Disabled", retryable: false } },
        { status },
      )
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

test("staking namespace maps each call to the merged route and keeps replay ids", async () => {
  const { client, calls } = fixture()
  await client.staking.positions()
  const request = { amountRaw: "123", clientStakeId: "stake-1", dryRun: true }
  await client.staking.stake(request)
  await client.staking.stake(request)
  await client.staking.unstake({ ...request, payer: "linked", linkedWalletId: "wallet-1" })
  await client.staking.finish({ withdrawal: "withdrawal-1", clientStakeId: "finish-1" })
  await client.staking.claimReward("reward/1")
  await client.staking.submit({ clientStakeId: "stake-1", signedTransaction: "signed" })
  await client.staking.confirm({ clientStakeId: "stake-1", signature: "same-sig" })
  expect(calls.map((c) => [new URL(c.url).pathname, c.init?.method])).toEqual([
    ["/api/v1/agent/staking", "GET"],
    ["/api/v1/agent/staking/stake/build", "POST"],
    ["/api/v1/agent/staking/stake/build", "POST"],
    ["/api/v1/agent/staking/unstake/build", "POST"],
    ["/api/v1/agent/staking/finish/build", "POST"],
    ["/api/v1/agent/staking/rewards/reward%2F1/claim", "POST"],
    ["/api/v1/agent/staking/submit", "POST"],
    ["/api/v1/agent/staking/confirm", "POST"],
  ])
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ payer: "main", ...request })
  expect(calls[1]?.init?.body).toBe(calls[2]?.init?.body)
  expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ ...request, payer: "linked", linkedWalletId: "wallet-1" })
  expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({
    payer: "main",
    withdrawal: "withdrawal-1",
    clientStakeId: "finish-1",
  })
  expect(calls.every((c) => new Headers(c.init?.headers).get("x-api-key") === "key")).toBe(true)
})

test("staking refuses a missing key before fetching and preserves server errors without resending", async () => {
  const noKey = new CandleClient({
    apiUrl: "http://localhost",
    fetch: (() => {
      throw new Error("must not fetch")
    }) as unknown as typeof fetch,
  })
  await expect(noKey.staking.positions()).rejects.toThrow()
  await expect(noKey.staking.stake({ amountRaw: "1", clientStakeId: "id" })).rejects.toThrow()
  const { client, calls } = fixture(503)
  try {
    await client.staking.stake({ amountRaw: "1", clientStakeId: "id" })
    throw new Error("expected refusal")
  } catch (e) {
    expect(e).toBeInstanceOf(CandleApiError)
    expect((e as CandleApiError).code).toBe("LAUNCH_DISABLED")
  }
  expect(calls).toHaveLength(1)
})
