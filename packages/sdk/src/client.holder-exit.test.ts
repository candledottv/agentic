/** BE-3794 (BE-3630 spec 6.1 and 10): the SDK's holder-exit methods against a mocked API. */
import { describe, expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"
import { type HolderExit, HolderExitError, type HolderExitState, holderExitErrorFromResponse } from "./holder-exit"

const CURVE = "0x1111111111111111111111111111111111111111"
const TOKEN = "0x2222222222222222222222222222222222222222"
const ACCOUNT = "0x3333333333333333333333333333333333333333"
const TX = `0x${"ab".repeat(32)}`

function exit(state: HolderExitState, extra: Partial<HolderExit> = {}): HolderExit {
  return {
    generation: 2,
    state,
    lifecycle: state === "recovery" || state === "rescued" ? "recovery" : state === "none" ? "trading" : "graduated",
    recoveryWindow: null,
    recovery: null,
    rescue: null,
    team: null,
    actions: [],
    disclosure: `disclosure for ${state}`,
    ...extra,
  }
}

function fixture(answer: (path: string, init?: RequestInit) => Response, apiKey: string | null = "key") {
  const calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = []
  const client = new CandleClient({
    apiUrl: "http://localhost",
    ...(apiKey ? { apiKey } : {}),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const path = `${parsed.pathname}${parsed.search}`
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return answer(path, init)
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

describe("holder-exit reads", () => {
  for (const state of [
    "none",
    "awaiting_migration",
    "recovery_open",
    "recovery",
    "rescue_pending",
    "rescued",
  ] as const) {
    test(`getHolderExit returns the API's ${state} view unchanged`, async () => {
      const view = exit(state)
      const { client, calls } = fixture(() =>
        Response.json({ payload: { curve: CURVE, token: TOKEN, holderExit: view } }),
      )
      const read = await client.getHolderExit(CURVE, ACCOUNT)
      expect(read).toEqual({ curve: CURVE, token: TOKEN, holderExit: view })
      expect(calls[0]).toMatchObject({
        path: `/api/v1/hood/curves/${CURVE}/holder-exit?account=${ACCOUNT}`,
        method: "GET",
      })
    })
  }

  test("getHolderExit without an account sends no query, and needs no key", async () => {
    const { client, calls } = fixture(
      () => Response.json({ payload: { curve: CURVE, token: TOKEN, holderExit: exit("none") } }),
      null,
    )
    await client.getHolderExit(CURVE)
    expect(calls[0]?.path).toBe(`/api/v1/hood/curves/${CURVE}/holder-exit`)
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined()
  })

  test("getHolderExits returns the account's list with its unavailable count", async () => {
    const payload = { account: ACCOUNT, exits: [{ curve: CURVE, holderExit: exit("recovery") }], unavailableCount: 1 }
    const { client, calls } = fixture(() => Response.json({ payload }))
    expect(await client.getHolderExits(ACCOUNT)).toEqual(payload)
    expect(calls[0]?.path).toBe(`/api/v1/hood/holder-exits?account=${ACCOUNT}`)
  })

  test("a read's 404 and 503 are HolderExitErrors with the route's code and text", async () => {
    const notFound = fixture(() =>
      Response.json({ error: true, payload: "No Candle curve at this address" }, { status: 404 }),
    )
    const err404 = await notFound.client.getHolderExit(CURVE).catch((e) => e)
    expect(err404).toBeInstanceOf(HolderExitError)
    expect(err404).toBeInstanceOf(CandleApiError)
    expect(err404).toMatchObject({
      code: "HTTP_404",
      status: 404,
      message: "No Candle curve at this address",
      retryable: false,
    })

    const down = fixture(() =>
      Response.json(
        { error: true, code: "FEED_UNAVAILABLE", payload: "Holder-exit read unavailable" },
        { status: 503 },
      ),
    )
    const err503 = await down.client.getHolderExits(ACCOUNT).catch((e) => e)
    expect(err503).toMatchObject({ code: "FEED_UNAVAILABLE", status: 503, retryable: true })
  })
})

describe("holder-signed build and record", () => {
  test("buildHolderExit posts exactly account, action and amountRaw, and returns the payload", async () => {
    const build = {
      curve: CURVE,
      account: ACCOUNT,
      action: "claim_recovery",
      generation: 2,
      blockNumber: "10",
      calls: [
        { kind: "approve", to: TOKEN, data: "0x095ea7b3", value: "0", gas: "60000", gasEstimated: true },
        { kind: "claim_recovery", to: CURVE, data: "0xabcdef01", value: "0", gas: "90000", gasEstimated: true },
      ],
      amountRaw: "5",
      expectedQuoteOutRaw: "2",
      gasCost: { maxFeePerGas: "1", maxPriorityFeePerGas: "1", requiredWei: "150000", balanceWei: "10" },
      holderExit: exit("recovery"),
    }
    const { client, calls } = fixture(() => Response.json({ payload: build }))
    expect(
      await client.buildHolderExit({ curve: CURVE, account: ACCOUNT, action: "claim_recovery", amountRaw: "5" }),
    ).toEqual(build as never)
    expect(calls[0]).toMatchObject({ path: `/api/v1/hood/curves/${CURVE}/holder-exit/build`, method: "POST" })
    expect(calls[0]?.body).toEqual({ account: ACCOUNT, action: "claim_recovery", amountRaw: "5" })
  })

  test("buildHolderExit leaves amountRaw out when not given", async () => {
    const { client, calls } = fixture(() => Response.json({ payload: {} }))
    await client.buildHolderExit({ curve: CURVE, account: ACCOUNT, action: "enter_recovery" })
    expect(calls[0]?.body).toEqual({ account: ACCOUNT, action: "enter_recovery" })
  })

  test("a build refusal carries the code, the fixed message and its details", async () => {
    const { client } = fixture(() =>
      Response.json(
        {
          success: false,
          error: "Recovery isn't open for this wallet yet. Check when it opens on the token page.",
          code: "HOOD_RECOVERY_NOT_READY",
          retryable: false,
          details: { creatorMayEnterAt: "100", anyoneMayEnterAt: "200" },
        },
        { status: 409 },
      ),
    )
    const error = await client
      .buildHolderExit({ curve: CURVE, account: ACCOUNT, action: "enter_recovery" })
      .catch((e) => e)
    expect(error).toBeInstanceOf(HolderExitError)
    expect(error).toMatchObject({
      code: "HOOD_RECOVERY_NOT_READY",
      status: 409,
      retryable: false,
      details: { creatorMayEnterAt: "100", anyoneMayEnterAt: "200" },
    })
  })

  for (const code of [
    "HOOD_RECOVERY_RESCUED",
    "HOOD_RECOVERY_NOTHING_TO_CLAIM",
    "HOOD_RECOVERY_AMOUNT_EXCEEDS_BALANCE",
    "HOOD_RECOVERY_INVALID_LIFECYCLE",
    "HOOD_VESTING_NOT_MIGRATED",
    "HOOD_VESTING_NOTHING_TO_CLAIM",
    "HOOD_VESTING_NO_ESCROW",
    "HOOD_VESTING_STRANDED",
    "MARKET_NOT_FOUND",
  ]) {
    test(`refusal ${code} keeps its code`, async () => {
      const { client } = fixture(() =>
        Response.json({ success: false, error: "refused", code, retryable: false }, { status: 409 }),
      )
      const error = await client
        .buildHolderExit({ curve: CURVE, account: ACCOUNT, action: "claim_team" })
        .catch((e) => e)
      expect(error).toMatchObject({ code, message: "refused" })
    })
  }

  test("recordHolderExit posts account and txHash and returns the recorded exit", async () => {
    const record = {
      recorded: "booked",
      curve: CURVE,
      account: ACCOUNT,
      generation: 2,
      exit: {
        kind: "recovery_claim",
        txHash: TX,
        logIndex: 3,
        blockNumber: "12",
        curve: CURVE,
        generation: 2,
        emitter: CURVE,
        account: ACCOUNT,
        baseToken: TOKEN,
        quoteToken: TOKEN,
        baseBurnedRaw: "5",
        quotePaidRaw: "2",
      },
    }
    const { client, calls } = fixture(() => Response.json({ payload: record }))
    expect(await client.recordHolderExit({ curve: CURVE, account: ACCOUNT, txHash: TX })).toEqual(record as never)
    expect(calls[0]).toMatchObject({ path: `/api/v1/hood/curves/${CURVE}/holder-exit/record`, method: "POST" })
    expect(calls[0]?.body).toEqual({ account: ACCOUNT, txHash: TX })
  })
})

describe("agent holder exit", () => {
  test("holderExit needs a key", async () => {
    const { client } = fixture(() => Response.json({}), null)
    await expect(client.holderExit({ curve: CURVE, action: "enter_recovery" })).rejects.toThrow()
  })

  test("holderExit sends dryRun false by default and only the fields given", async () => {
    const answer = {
      success: true,
      curve: CURVE,
      action: "claim_recovery",
      wallet: ACCOUNT,
      signer: "embedded",
      dryRun: false,
      outcome: "complete",
      calls: [{ kind: "claim_recovery", to: CURVE, status: "confirmed", txHash: TX, recorded: "booked" }],
      warnings: [],
    }
    const { client, calls } = fixture(() => Response.json(answer))
    expect(await client.holderExit({ curve: CURVE, action: "claim_recovery" })).toEqual(answer as never)
    expect(calls[0]).toMatchObject({ path: `/api/v1/agent/hood/holder-exit/${CURVE}`, method: "POST" })
    expect(calls[0]?.body).toEqual({ action: "claim_recovery", dryRun: false })
    expect(calls[0]?.headers["x-api-key"]).toBe("key")
  })

  test("holderExit forwards amountRaw, dryRun, wallet and linkedSigning", async () => {
    const { client, calls } = fixture(() => Response.json({ success: true }))
    await client.holderExit({
      curve: CURVE,
      action: "claim_recovery",
      amountRaw: "7",
      dryRun: true,
      wallet: ACCOUNT,
      linkedSigning: true,
    })
    expect(calls[0]?.body).toEqual({
      action: "claim_recovery",
      amountRaw: "7",
      dryRun: true,
      wallet: ACCOUNT,
      linkedSigning: true,
    })
  })

  test("a partial sequence throws with its outcome, calls and warnings", async () => {
    const body = {
      success: false,
      error: { code: "HOOD_EXIT_FAILED", message: "The exit did not complete", retryable: true, stage: "reverted" },
      outcome: "partial",
      calls: [
        { kind: "approve", to: TOKEN, status: "confirmed", txHash: TX },
        { kind: "claim_recovery", to: CURVE, status: "reverted", txHash: TX },
      ],
      warnings: [`Transaction ${TX} reverted.`],
    }
    const { client } = fixture(() => Response.json(body, { status: 409 }))
    const error = await client.holderExit({ curve: CURVE, action: "claim_recovery" }).catch((e) => e)
    expect(error).toBeInstanceOf(HolderExitError)
    expect(error).toMatchObject({
      code: "HOOD_EXIT_FAILED",
      status: 409,
      retryable: true,
      stage: "reverted",
      outcome: "partial",
      warnings: [`Transaction ${TX} reverted.`],
    })
    expect(error.calls).toHaveLength(2)
  })

  test("an agent-route refusal carries its details", async () => {
    const body = {
      success: false,
      error: {
        code: "HOOD_RECOVERY_NOT_READY",
        message: "Recovery isn't open",
        retryable: false,
        stage: "not_broadcast",
        details: { creatorMayEnterAt: "100", anyoneMayEnterAt: "200" },
      },
    }
    const { client } = fixture(() => Response.json(body, { status: 409 }))
    const error = await client.holderExit({ curve: CURVE, action: "enter_recovery", dryRun: true }).catch((e) => e)
    expect(error).toMatchObject({ code: "HOOD_RECOVERY_NOT_READY", details: { anyoneMayEnterAt: "200" } })
  })

  test("submitHolderExit posts the signed bytes without the curve in the body", async () => {
    const { client, calls } = fixture(() => Response.json({ success: true }))
    await client.submitHolderExit({
      curve: CURVE,
      action: "claim_team",
      wallet: ACCOUNT,
      walletId: "w1",
      claimToken: "t",
      signedTransactions: ["0x02"],
    })
    expect(calls[0]?.path).toBe(`/api/v1/agent/hood/holder-exit/${CURVE}/submit`)
    expect(calls[0]?.body).toEqual({
      action: "claim_team",
      wallet: ACCOUNT,
      walletId: "w1",
      claimToken: "t",
      signedTransactions: ["0x02"],
    })
  })
})

test("getMarket carries holderExit and holderExitUnavailable through", async () => {
  const market = { chain: "hood", mint: TOKEN, holderExit: exit("rescue_pending") }
  const { client } = fixture(() => Response.json({ success: true, market }))
  expect((await client.getMarket("hood", TOKEN)).holderExit?.state).toBe("rescue_pending")
  const down = fixture(() => Response.json({ success: true, market: { chain: "hood", holderExitUnavailable: true } }))
  expect((await down.client.getMarket("hood", TOKEN)).holderExitUnavailable).toBe(true)
})

test("an unparseable error body is HTTP_<status>", () => {
  expect(holderExitErrorFromResponse(502, "bad gateway")).toMatchObject({
    code: "HTTP_502",
    message: "bad gateway",
    retryable: false,
  })
})

test("BE-4297: a holder-exit error keeps the request id and names it once", () => {
  const err = holderExitErrorFromResponse(502, "bad gateway", "req-12345678")
  expect(err.requestId).toBe("req-12345678")
  expect(err.message).toBe("bad gateway (request id req-12345678)")
  const env = holderExitErrorFromResponse(
    409,
    JSON.stringify({ success: false, error: { code: "HOOD_EXIT_FAILED", message: "Nope", retryable: false } }),
    "req-12345678",
  )
  expect(env.requestId).toBe("req-12345678")
  expect(env.message).toBe("Nope (request id req-12345678)")
  expect(holderExitErrorFromResponse(502, "bad gateway").requestId).toBeUndefined()
})
