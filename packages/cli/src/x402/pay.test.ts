import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import { VersionedTransaction } from "@solana/web3.js"
import { jsonResponse } from "../test-support"
import { decodeHeader, encodeHeader, type PaymentRequirements } from "./codec"
import { type PaidCallInput, type PayerSource, paidRequest } from "./pay"
import { SOLANA_DEVNET, USDC_MINTS } from "./select"
import { siwsMessage, spendChallengeOf } from "./siwx"
import {
  appendSpendLines,
  foldSpendLog,
  readSpendLog,
  type SpendLine,
  type SpendPaths,
  spendPaths,
  writeLimits,
} from "./spend-log"

const seed = new Uint8Array(32).fill(5)
const PAYER = base58.encode(ed25519.getPublicKey(seed))
const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9"
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"
const API = "https://api.test"
const PATH = "/api/v1/markets/solana/mint1/forensics"
const NOW = Date.parse("2026-11-02T10:00:00.000Z")

const offer = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: SOLANA_DEVNET,
  amount: "10000",
  asset: USDC_MINTS[SOLANA_DEVNET],
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { feePayer: FEE_PAYER, memo: `cndl:${"1".repeat(32)}`, paymentFlow: "upfront" },
  ...over,
})

function payable(requirement = offer(), extensions?: Record<string, unknown>, error?: string): Response {
  const required = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: `${API}${PATH}`, description: "Token forensics past the free rate, 0.01 USDC" },
    accepts: [requirement],
    ...(extensions ? { extensions } : {}),
  }
  return jsonResponse(
    402,
    { success: false, error: { code: "PAYMENT_REQUIRED", message: "This call costs 0.01 USDC.", retryable: true } },
    { "PAYMENT-REQUIRED": encodeHeader(required) },
  )
}
const settled = (success = true) => ({
  "PAYMENT-RESPONSE": encodeHeader({ success, transaction: success ? "txsig" : "", network: SOLANA_DEVNET }),
})

let dir: string
let paths: SpendPaths
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-pay-"))
  paths = spendPaths({ CANDLE_CONFIG_DIR: dir }, "/nonexistent")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Harness {
  input: PaidCallInput
  requests: { headers: Record<string, string> }[]
  opened: () => number
  confirmed: () => number
}

function harness(
  responses: Array<(headers: Record<string, string>) => Response>,
  over: Partial<PaidCallInput> = {},
): Harness {
  const requests: { headers: Record<string, string> }[] = []
  let opened = 0
  let confirmed = 0
  const payer: PayerSource = {
    async confirm() {
      confirmed++
    },
    async open() {
      opened++
      return { address: PAYER, sign: (m) => ed25519.sign(m, seed), close: () => {} }
    },
  }
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    requests.push({ headers })
    const next = responses[requests.length - 1]
    if (!next) throw new Error(`unexpected request ${requests.length}`)
    return next(headers)
  }) as typeof fetch
  let id = 0
  return {
    requests,
    opened: () => opened,
    confirmed: () => confirmed,
    input: {
      path: PATH,
      request: { apiUrl: API, auth: "none", credentials: {}, fetch: fetchFn, env: {} },
      kind: "forensics",
      paths,
      payer,
      blockhash: async () => BLOCKHASH,
      env: { CANDLE_X402_NETWORK: "devnet", CANDLE_X402_PAY_TO: PAY_TO },
      now: () => NOW,
      newId: () => `id-${++id}`,
      ...over,
    },
  }
}

const states = async () => foldSpendLog(await readSpendLog(paths)).map((e) => [e.state, e.amountRaw, e.signature])

describe("paidRequest (spec 10.2, 10.3)", () => {
  test("a call the server does not charge for is untouched", async () => {
    const h = harness([() => jsonResponse(200, { success: true, data: { ok: 1 } })])
    const r = await paidRequest(h.input)
    expect(r.result.ok).toBe(true)
    expect([r.payment, r.refusal, h.opened(), h.requests.length]).toEqual([null, null, 0, 1])
  })

  test("the four existing 402s, and a 402 with a garbage header, are ordinary errors and never paid", async () => {
    for (const code of [
      "VALIDATION_FAILED",
      "STAKING_INSUFFICIENT_SOL",
      "INSUFFICIENT_OWNER_BALANCE",
      "FEE_LEG_MISSING",
    ]) {
      const h = harness([() => jsonResponse(402, { success: false, error: { code, message: "no" } })])
      const r = await paidRequest(h.input)
      expect([r.result.status, r.result.ok ? "" : r.result.code, r.refusal, h.opened()]).toEqual([402, code, null, 0])
    }
    const garbage = harness([
      () =>
        jsonResponse(
          402,
          { success: false, error: { code: "PAYMENT_REQUIRED", message: "x" } },
          { "PAYMENT-REQUIRED": "e30=" },
        ),
    ])
    const r = await paidRequest(garbage.input)
    expect([r.refusal, r.payment, garbage.opened(), garbage.requests.length]).toEqual([null, null, 0, 1])
  })

  test("pays a payable 402 once: the signed exact transfer, then the settled response is logged", async () => {
    let paidHeader = ""
    const h = harness([
      () => payable(),
      (headers) => {
        paidHeader = headers["PAYMENT-SIGNATURE"] ?? ""
        return jsonResponse(200, { success: true, data: { score: 1 } }, settled())
      },
    ])
    const r = await paidRequest(h.input)
    expect(r.result.ok).toBe(true)
    expect(r.payment).toEqual({ id: "id-1", state: "settled", amountUsdc: "0.01", payer: PAYER, signature: "txsig" })
    expect([h.confirmed(), h.opened()]).toEqual([1, 1])
    const payload = decodeHeader(paidHeader) as {
      x402Version: number
      accepted: PaymentRequirements
      payload: { transaction: string }
    }
    expect(payload.x402Version).toBe(2)
    expect(payload.accepted).toEqual(offer())
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, "base64"))
    expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(FEE_PAYER)
    expect(tx.message.recentBlockhash).toBe(BLOCKHASH)
    expect(await states()).toEqual([["settled", 10000n, "txsig"]])
    const pending = (await readSpendLog(paths))[0]
    expect(pending).toMatchObject({
      state: "pending",
      kind: "forensics",
      route: `GET ${PATH}`,
      network: SOLANA_DEVNET,
      amountRaw: "10000",
      payTo: PAY_TO,
      payer: PAYER,
      quoteMemo: `cndl:${"1".repeat(32)}`,
      keyless: true,
    })
  })

  test("pause, the per-call ceiling and the daily limit refuse before the vault is opened", async () => {
    await writeLimits(paths, { dailyLimitUsdMicros: 5_000_000n, maxPerCallUsdMicros: 1_000_000n, paused: true })
    let h = harness([() => payable()])
    expect((await paidRequest(h.input)).refusal?.code).toBe("SPEND_PAUSED")
    expect(h.opened()).toBe(0)

    await writeLimits(paths, { dailyLimitUsdMicros: 5_000_000n, maxPerCallUsdMicros: 9_999n, paused: false })
    h = harness([() => payable()])
    expect((await paidRequest(h.input)).refusal?.code).toBe("SPEND_MAX_PER_CALL")
    expect(h.opened()).toBe(0)

    await writeLimits(paths, { dailyLimitUsdMicros: 25_000n, maxPerCallUsdMicros: 1_000_000n, paused: false })
    const line = (id: string, at: string): SpendLine => ({
      v: 1,
      id,
      at,
      state: "pending",
      kind: "vamp",
      amountRaw: "10000",
    })
    // Yesterday's payment does not count; today's pending one does.
    await appendSpendLines(paths, [line("old", "2026-11-01T23:00:00.000Z"), line("p", "2026-11-02T01:00:00.000Z")])
    h = harness([() => payable(), () => jsonResponse(200, { success: true }, settled())])
    expect((await paidRequest(h.input)).payment?.state).toBe("settled")
    h = harness([() => payable()])
    const refused = await paidRequest(h.input)
    expect(refused.refusal?.code).toBe("SPEND_DAILY_LIMIT")
    expect(refused.result.status).toBe(402)
    expect(h.opened()).toBe(0)
  })

  test("the pinned pay-to: a 402 to another address is refused, and mainnet pays nothing in this build", async () => {
    let h = harness([() => payable(offer({ payTo: FEE_PAYER }))])
    expect((await paidRequest(h.input)).refusal?.code).toBe("X402_PAY_TO_MISMATCH")
    h = harness([() => payable()], { env: { CANDLE_X402_NETWORK: "devnet" } })
    expect((await paidRequest(h.input)).refusal?.code).toBe("X402_PAY_TO_UNPINNED")
    h = harness(
      [
        () =>
          payable(
            offer({
              network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
              asset: USDC_MINTS["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
            }),
          ),
      ],
      {
        env: {},
      },
    )
    expect((await paidRequest(h.input)).refusal?.code).toBe("X402_PAY_TO_UNPINNED")
    h = harness([() => payable(offer({ scheme: "upto" }))])
    expect((await paidRequest(h.input)).refusal?.code).toBe("X402_NOT_PAYABLE")
    expect(await states()).toEqual([])
  })

  test("a second 402 after paying is shown, not paid", async () => {
    const h = harness([() => payable(), () => payable(offer(), undefined, "quote_expired"), () => payable()])
    const r = await paidRequest(h.input)
    expect(h.requests.length).toBe(2)
    expect(r.result.status).toBe(402)
    expect(r.payment).toMatchObject({ state: "failed", reason: "quote_expired" })
    expect(h.opened()).toBe(1)
    // Failed means nothing moved: it does not count toward the day.
    expect(await states()).toEqual([["failed", 10000n, undefined]])
  })

  test("a settled call the handler then failed is logged credited; a pending settlement is unknown", async () => {
    let h = harness([
      () => payable(),
      () =>
        jsonResponse(
          502,
          { success: false, error: { code: "UPSTREAM_FAILED", message: "x", credit: { amountUsdMicros: "10000" } } },
          settled(),
        ),
    ])
    expect((await paidRequest(h.input)).payment).toMatchObject({ state: "credited", signature: "txsig" })
    h = harness([
      () => payable(),
      () => jsonResponse(503, { success: false, error: { code: "PAYMENT_PENDING", message: "x", retryable: true } }),
    ])
    expect((await paidRequest(h.input)).payment).toMatchObject({ state: "unknown", reason: "PAYMENT_PENDING" })
    h = harness([() => payable(), () => jsonResponse(402, { success: false }, settled(false))])
    expect((await paidRequest(h.input)).payment).toMatchObject({ state: "failed" })
  })

  test("a keyless wallet that was credited spends the credit with its SIGN-IN-WITH-X proof first", async () => {
    await appendSpendLines(paths, [
      {
        v: 1,
        id: "earlier",
        at: "2026-11-01T10:00:00.000Z",
        state: "pending",
        kind: "forensics",
        network: SOLANA_DEVNET,
        amountRaw: "10000",
        payer: PAYER,
        keyless: true,
      },
      { v: 1, id: "earlier", at: "2026-11-01T10:00:01.000Z", state: "credited" },
    ])
    const extension = {
      "sign-in-with-x": {
        info: {
          domain: "api.test",
          uri: `${API}${PATH}`,
          version: "1",
          nonce: "ab".repeat(16),
          issuedAt: "2026-11-02T10:00:00.000Z",
          expirationTime: "2026-11-02T10:05:00.000Z",
        },
        supportedChains: [{ chainId: SOLANA_DEVNET, type: "ed25519", signatureScheme: "siws" }],
        statementTemplate: "Candle x402 spend_credit {address}",
      },
    }
    let proof: Record<string, unknown> = {}
    const h = harness([
      () => payable(offer(), extension),
      (headers) => {
        proof = decodeHeader(headers["SIGN-IN-WITH-X"] ?? "")
        expect(headers["PAYMENT-SIGNATURE"]).toBeUndefined()
        return jsonResponse(200, { success: true, data: {} })
      },
    ])
    const r = await paidRequest(h.input)
    expect([r.servedFromCredit, r.payment]).toEqual([true, null])
    expect(proof).toMatchObject({ address: PAYER, statement: `Candle x402 spend_credit ${PAYER}`, type: "ed25519" })
    const challenge = spendChallengeOf(extension, "api.test", SOLANA_DEVNET)
    if (!challenge) throw new Error("no challenge")
    expect(
      ed25519.verify(
        base58.decode(proof.signature as string),
        new TextEncoder().encode(siwsMessage(challenge, PAYER)),
        base58.decode(PAYER),
      ),
    ).toBe(true)
    // A challenge for another host is never signed.
    expect(spendChallengeOf(extension, "evil.test", SOLANA_DEVNET)).toBeNull()
  })

  test("too little wallet credit: the fresh 402 is paid within the same rules", async () => {
    await appendSpendLines(paths, [
      {
        v: 1,
        id: "e",
        at: "2026-11-01T10:00:00.000Z",
        state: "pending",
        network: SOLANA_DEVNET,
        amountRaw: "1",
        payer: PAYER,
        keyless: true,
      },
      { v: 1, id: "e", at: "2026-11-01T10:00:01.000Z", state: "credited" },
    ])
    const extension = {
      "sign-in-with-x": {
        info: {
          domain: "api.test",
          uri: `${API}${PATH}`,
          version: "1",
          nonce: "cd".repeat(16),
          issuedAt: "2026-11-02T10:00:00.000Z",
        },
        supportedChains: [{ chainId: SOLANA_DEVNET, type: "ed25519", signatureScheme: "siws" }],
      },
    }
    const h = harness([
      () => payable(offer(), extension),
      () => payable(offer({ extra: { feePayer: FEE_PAYER, memo: `cndl:${"2".repeat(32)}`, paymentFlow: "upfront" } })),
      () => jsonResponse(200, { success: true }, settled()),
    ])
    const r = await paidRequest(h.input)
    expect(h.requests.length).toBe(3)
    expect(r.payment?.state).toBe("settled")
    const paid = decodeHeader(h.requests[2]?.headers["PAYMENT-SIGNATURE"] ?? "") as { accepted: PaymentRequirements }
    expect(paid.accepted.extra?.memo).toBe(`cndl:${"2".repeat(32)}`)
  })
})
