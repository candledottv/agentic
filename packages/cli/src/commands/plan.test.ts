import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { VersionedTransaction } from "@solana/web3.js"
import { run } from "../index"
import { keySignerRef, localKeySigners, signerSlotProblem } from "../key-signers"
import { profileSecretRef } from "../profiles"
import {
  type CapturedRequest,
  createCapture,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { decodeHeader, encodeHeader } from "../x402/codec"
import { readPlanState, signupSignerRef, updatePlanState } from "../x402/plan-state"
import { SOLANA_DEVNET, USDC_MINTS } from "../x402/select"
import { appendSpendLines, foldSpendLog, readSpendLog, spendPaths, spentOn, utcDay } from "../x402/spend-log"
import { PLAN_TERMS_VERSION } from "./plan"

useCheapKdf()
setDefaultTimeout(60_000)

const PRO = "/api/v1/agent/x402/plans/pro"
const RENEW = "/api/v1/agent/x402/plans/pro/renew"
const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9"
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"
const MINT = "So11111111111111111111111111111111111111112"
const NOW = Date.parse("2026-11-02T10:00:00Z")
const PERIOD_END = "2026-12-02T10:00:00.000Z"

function required(path: string, amount = "50000000", payTo = PAY_TO) {
  return {
    x402Version: 2,
    resource: { url: `https://api.test${path}`, description: "Candle Pro for 30 days, 50 USDC" },
    accepts: [
      {
        scheme: "exact",
        network: SOLANA_DEVNET,
        amount,
        asset: USDC_MINTS[SOLANA_DEVNET],
        payTo,
        maxTimeoutSeconds: 120,
        extra: { feePayer: FEE_PAYER, memo: `cndl:${"7".repeat(32)}` },
      },
    ],
  }
}

function quote(
  path: string,
  opts: { signup?: boolean; amount?: string; list?: string; payTo?: string } = {},
): RouteHandler {
  const amount = opts.amount ?? "50000000"
  const req = required(path, amount, opts.payTo)
  return () =>
    jsonResponse(
      402,
      {
        success: false,
        error: { code: "PAYMENT_REQUIRED", message: "This call costs 50 USDC.", retryable: true },
        plan: {
          plan: "pro",
          periodDays: 30,
          listPriceUsdMicros: opts.list ?? amount,
          creditUsdMicros: "0",
          amountDueUsdMicros: amount,
          signup: opts.signup === true,
        },
        terms: { url: "https://docs.candle.tv/terms" },
        x402: req,
      },
      { "PAYMENT-REQUIRED": encodeHeader(req) },
    )
}

const settled = {
  "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: "devnetsig", network: SOLANA_DEVNET }),
}

function receipt(payer: string, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    status: "fulfilled",
    paymentId: "pay-1",
    account: payer,
    plan: "pro",
    periodStart: "2026-11-02T10:00:00.000Z",
    periodEnd: PERIOD_END,
    amountPaidUsdMicros: "50000000",
    ...extra,
  }
}

function signupReceipt(payer: string) {
  return receipt(payer, {
    signup: {
      created: true,
      keyPrefix: "abcd1234",
      signer: { fingerprint: "CNDL-AAAA-BBBB-CCCC", signerQuorumId: "quorum-1" },
      wallets: {
        solana: "8ZbVfKCdj3ZbYJ1G1QwVxWzk8wT2qmd1bZ2sZBoFuXj2",
        evm: "0x00000000000000000000000000000000000000aa",
      },
    },
    apiKey: "cndl_live_signup_key_value",
  })
}

const rpc: RouteHandler = (req) => {
  const { method, id } = JSON.parse(String(req.init.body))
  if (method !== "getLatestBlockhash") throw new Error(`unexpected RPC ${method}`)
  return jsonResponse(200, { id, jsonrpc: "2.0", result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH } } })
}

const headerOf = (call: CapturedRequest | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name]
const bodyOf = (call: CapturedRequest | undefined) =>
  JSON.parse(String(call?.init.body ?? "{}")) as Record<string, unknown>

async function withVault(routes: Record<string, RouteHandler | RouteHandler[]>, env: Record<string, string> = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch({ "/": rpc, ...routes })
  const prompts: string[] = []
  let unlocks = 0
  let now = NOW
  const deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    now: () => now,
    env: {
      CANDLE_CONFIG_DIR: made.dir,
      CANDLE_API_URL: "https://api.test",
      CANDLE_X402_NETWORK: "devnet",
      CANDLE_X402_PAY_TO: PAY_TO,
      ...env,
    },
    promptSecret: async () => {
      unlocks++
      return made.passphrase
    },
    promptLine: async (text) => {
      prompts.push(text)
      return "confirm"
    },
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "payer", "--json"], deps)).toBe(0)
  const payer = String(JSON.parse(stdout.text.trim().split("\n").at(-1) ?? "{}").address)
  stdout.text = ""
  stderr.text = ""
  unlocks = 0
  const paths = (profile?: string) => spendPaths({ CANDLE_CONFIG_DIR: made.dir }, "/x", profile)
  return {
    made,
    deps,
    stdout,
    stderr,
    routed,
    prompts,
    payer,
    paths,
    unlocks: () => unlocks,
    setNow: (ms: number) => {
      now = ms
    },
  }
}

const planCalls = (routed: { calls: CapturedRequest[] }, path: string) =>
  routed.calls.filter((c) => new URL(c.url).pathname === path)

describe("candle plan buy: signup through the first plan purchase (spec 5.3 to 5.6)", () => {
  test("an unknown vault key signs up: S made first, terms confirmed, paid once, key and signer stored", async () => {
    let paidHeader = ""
    const f = await withVault({
      [PRO]: [
        quote(PRO, { signup: true }),
        (req) => {
          paidHeader = headerOf(req, "PAYMENT-SIGNATURE") ?? ""
          return jsonResponse(200, signupReceipt(bodyOf(req).payer as string), settled)
        },
      ],
    })
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(0)
    const out = JSON.parse(f.stdout.text)
    expect(out).toMatchObject({
      ok: true,
      status: "fulfilled",
      plan: "pro",
      account: f.payer,
      periodEnd: PERIOD_END,
      amountPaidUsdc: "50",
      payer: f.payer,
      signature: "devnetsig",
      signup: { profile: "api-test", keyPrefix: "abcd1234", keyStored: true },
    })
    expect(f.stdout.text).not.toContain("cndl_live_signup_key_value")
    expect(f.stderr.text).not.toContain("cndl_live_signup_key_value")

    const [first, second] = planCalls(f.routed, PRO)
    const sent = bodyOf(first)
    expect(sent).toEqual({
      payer: f.payer,
      signerPublicKey: expect.any(String),
      termsVersion: PLAN_TERMS_VERSION,
      autoRenew: false,
    })
    expect(headerOf(first, "x-api-key")).toBeUndefined()
    expect(bodyOf(second)).toEqual(sent)
    // The custody warning (5.5) and the terms (5.6) come before the one confirm, which names both.
    const said = f.stderr.text.replace(/\s+/g, " ")
    expect(said).toContain("becomes this account's identity and root")
    expect(said).toContain("Losing S loses the wallets")
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]).toContain(`pay 50 USDC for Candle Pro and accept Candle's terms ${PLAN_TERMS_VERSION}`)
    expect(f.unlocks()).toBe(1)

    const payload = decodeHeader(paidHeader) as { payload: { transaction: string }; accepted: { memo?: string } }
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, "base64"))
    expect(tx.message.staticAccountKeys.map((k) => k.toBase58())).toContain(f.payer)

    // The key is in the new profile, which is now active; S is in its key's slot with the quorum.
    expect(await f.deps.store.get(profileSecretRef("api-test", "apiKey"))).toBe("cndl_live_signup_key_value")
    const config = await f.deps.readConfig()
    expect(config.activeProfile).toBe("api-test")
    expect(config.profiles?.["api-test"]).toMatchObject({ keyPrefix: "abcd1234", account: f.payer })
    const signers = await localKeySigners(f.deps, "abcd1234")
    expect(signers).toHaveLength(1)
    expect(signers[0]).toMatchObject({ signerQuorumId: "quorum-1", publicKeyDer: sent.signerPublicKey })
    const spki = signers[0]?.spkiSha256 as string
    // The private half in the key's slot is the one whose public half the quote carried.
    expect(signerSlotProblem((await f.deps.store.get(keySignerRef("abcd1234", spki))) ?? "", spki)).toBeNull()
    expect(await f.deps.store.get(signupSignerRef(spki))).toBeNull()

    const state = await readPlanState(f.paths("api-test"))
    expect(state).toMatchObject({ plan: "pro", payer: f.payer, periodEnd: PERIOD_END, renewCeilingRaw: "50000000" })
    expect(state.pending).toBeUndefined()
    expect(state.signupSigners ?? []).toEqual([])
    // Logged as a plan payment, and outside the per-use daily total (10.3).
    const entries = foldSpendLog(await readSpendLog(f.paths("api-test")))
    expect(entries.map((e) => [e.kind, e.state, e.amountRaw, e.signature])).toEqual([
      ["plan", "settled", 50_000_000n, "devnetsig"],
    ])
    expect(spentOn(entries, utcDay(NOW))).toBe(0n)
  })

  test("a 202 leaves the payment recorded; the next buy resends the same payment, unlocks nothing and pays once", async () => {
    const sent: string[] = []
    const f = await withVault({
      [PRO]: [
        quote(PRO, { signup: true }),
        (req) => {
          sent.push(headerOf(req, "PAYMENT-SIGNATURE") ?? "")
          return jsonResponse(202, { success: true, status: "fulfilment_pending", paymentId: "pay-1" }, settled)
        },
        (req) => {
          sent.push(headerOf(req, "PAYMENT-SIGNATURE") ?? "")
          return jsonResponse(200, signupReceipt(bodyOf(req).payer as string), settled)
        },
      ],
    })
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(3)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "PLAN_PAYMENT_PENDING" })
    const pending = (await readPlanState(f.paths("api-test"))).pending
    expect(pending).toMatchObject({ plan: "pro", payer: f.payer, keyed: false, amountRaw: "50000000" })
    // The signer is kept for the resume: the quote and the payment are bound to it.
    expect(await f.deps.store.get(signupSignerRef(pending?.signupSpkiSha256 as string))).not.toBeNull()

    f.stdout.text = ""
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: true, status: "fulfilled", resumed: true })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0] as string)
    expect(planCalls(f.routed, PRO)).toHaveLength(3)
    expect(bodyOf(planCalls(f.routed, PRO)[2])).toEqual(bodyOf(planCalls(f.routed, PRO)[1]))
    expect(f.unlocks()).toBe(1)
    expect(f.prompts).toHaveLength(1)
    expect(await f.deps.store.get(profileSecretRef("api-test", "apiKey"))).toBe("cndl_live_signup_key_value")
    expect((await readPlanState(f.paths("api-test"))).pending).toBeUndefined()
  })

  test("a 402 after paying is a refusal before anything moved: the payment is cleared, S is kept", async () => {
    const f = await withVault({
      [PRO]: [
        quote(PRO, { signup: true }),
        () =>
          jsonResponse(
            402,
            { success: false, error: { code: "PAYMENT_REQUIRED", message: "x" } },
            { "PAYMENT-REQUIRED": encodeHeader({ ...required(PRO), error: "quote_expired" }) },
          ),
      ],
    })
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: false,
      code: "PLAN_PAYMENT_FAILED",
      details: { reason: "quote_expired" },
    })
    const state = await readPlanState(f.paths("api-test"))
    expect(state.pending).toBeUndefined()
    expect(state.signupSigners).toHaveLength(1)
    const entries = foldSpendLog(await readSpendLog(f.paths("api-test")))
    expect(entries.map((e) => e.state)).toEqual(["failed"])
  })

  test("a key that cannot be stored keeps the payment; the same command resends it and stores the key", async () => {
    const sent: string[] = []
    const f = await withVault({
      [PRO]: [
        quote(PRO, { signup: true }),
        (req) => {
          sent.push(headerOf(req, "PAYMENT-SIGNATURE") ?? "")
          return jsonResponse(200, signupReceipt(bodyOf(req).payer as string), settled)
        },
        (req) => {
          sent.push(headerOf(req, "PAYMENT-SIGNATURE") ?? "")
          return jsonResponse(200, signupReceipt(bodyOf(req).payer as string), settled)
        },
      ],
    })
    const realSet = f.deps.store.set.bind(f.deps.store)
    let failing = true
    f.deps.store.set = async (ref: string, value: string) => {
      if (failing && ref === profileSecretRef("api-test", "apiKey")) throw new Error("keychain locked")
      return realSet(ref, value)
    }
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(3)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "PLAN_PAYMENT_PENDING" })
    expect((await readPlanState(f.paths("api-test"))).pending).toBeDefined()

    failing = false
    f.stdout.text = ""
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(0)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0] as string)
    expect(await f.deps.store.get(profileSecretRef("api-test", "apiKey"))).toBe("cndl_live_signup_key_value")
    expect((await readPlanState(f.paths("api-test"))).pending).toBeUndefined()
  })

  test("--signer-out writes S for a signup only, not for a wallet Candle already knows", async () => {
    const written: string[] = []
    const known = await withVault({
      [PRO]: [quote(PRO, { signup: false }), (req) => jsonResponse(200, receipt(bodyOf(req).payer as string), settled)],
    })
    known.deps.writeFile = async (path: string) => {
      written.push(path)
    }
    expect(await run(["plan", "buy", "pro", "--signer-out", "/x/s.pem"], known.deps)).toBe(0)
    expect(written).toEqual([])

    const fresh = await withVault({
      [PRO]: [
        quote(PRO, { signup: true }),
        (req) => jsonResponse(200, signupReceipt(bodyOf(req).payer as string), settled),
      ],
    })
    fresh.deps.writeFile = async (path: string) => {
      written.push(path)
    }
    expect(await run(["plan", "buy", "pro", "--signer-out", "/x/s.pem"], fresh.deps)).toBe(0)
    expect(written).toEqual(["/x/s.pem"])
  })

  test("a known wallet with no key buys for its account; the signer is not used and no key is stored", async () => {
    const f = await withVault({
      [PRO]: [quote(PRO, { signup: false }), (req) => jsonResponse(200, receipt(bodyOf(req).payer as string), settled)],
    })
    expect(await run(["plan", "buy", "pro"], f.deps)).toBe(0)
    expect(f.stderr.text.replace(/\s+/g, " ")).toContain("already a Candle account")
    expect(f.stdout.text.replace(/\s+/g, " ")).not.toContain("identity and root")
    expect(await f.deps.store.get(profileSecretRef("api-test", "apiKey"))).toBeNull()
    expect((await readPlanState(f.paths("api-test"))).plan).toBe("pro")
  })
})

describe("candle plan buy with an API key, and the refusals", () => {
  test("a first payment refused by a newly dark server explains availability and keeps its failure code", async () => {
    const f = await withVault({ [PRO]: [quote(PRO), () => jsonResponse(404, {})] }, { CANDLE_API_KEY: "cndl_live_x" })
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      code: "PLAN_PAYMENT_FAILED",
      details: { reason: "HTTP_404" },
      message: expect.stringContaining("not available yet"),
    })
    expect((await readPlanState(f.paths())).pending).toBeUndefined()
  })

  test("a resumed payment on a dark server keeps its pending state and explains availability", async () => {
    const sent: string[] = []
    const capture: RouteHandler = (req) => {
      sent.push(headerOf(req, "PAYMENT-SIGNATURE") ?? "")
      return jsonResponse(404, { error: "Not Found" })
    }
    const f = await withVault(
      {
        [PRO]: [quote(PRO), () => jsonResponse(503, {}), capture, capture],
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(3)
    const pending = (await readPlanState(f.paths())).pending
    expect(pending).toBeDefined()
    for (const asJson of [false, true]) {
      f.stdout.text = ""
      f.stderr.text = ""
      expect(await run(["plan", "buy", "pro", ...(asJson ? ["--json"] : [])], f.deps)).toBe(3)
      if (asJson)
        expect(JSON.parse(f.stdout.text)).toMatchObject({
          code: "PLAN_PAYMENT_PENDING",
          details: { reason: "HTTP_404" },
          message: expect.stringContaining("not available yet"),
        })
      else expect(f.stderr.text.replace(/\s+/g, " ")).toContain("not available yet")
      expect((await readPlanState(f.paths())).pending).toEqual(pending)
    }
    expect(sent).toEqual([pending?.paymentHeader as string, pending?.paymentHeader as string])
    expect(f.unlocks()).toBe(1)
  })

  test("the key's account buys: x-api-key sent, no signer, --auto-renew recorded, outside the per-use limits", async () => {
    const f = await withVault(
      {
        [PRO]: [quote(PRO), (req) => jsonResponse(200, receipt(bodyOf(req).payer as string), settled)],
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    // A $0 daily limit and the $1 per-call ceiling do not apply to a plan (10.3).
    expect(await run(["spend", "limit", "0"], f.deps)).toBe(0)
    f.stdout.text = ""
    expect(await run(["plan", "buy", "pro", "--auto-renew", "--yes", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: true, autoRenew: true })
    expect(f.prompts).toHaveLength(0)
    const [first] = planCalls(f.routed, PRO)
    expect(headerOf(first, "x-api-key")).toBe("cndl_live_x")
    expect(bodyOf(first)).toEqual({ payer: f.payer, termsVersion: PLAN_TERMS_VERSION, autoRenew: true })
    expect(await readPlanState(f.paths())).toMatchObject({
      autoRenew: true,
      plan: "pro",
      payer: f.payer,
      periodEnd: PERIOD_END,
      renewCeilingRaw: "50000000",
    })
  })

  test("x402 plans off (404) says so, opens no vault when the payer is named, and signs nothing", async () => {
    const f = await withVault(
      {
        [PRO]: () => jsonResponse(404, { error: "Not Found" }),
        [RENEW]: () => jsonResponse(404, { error: "Not Found" }),
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    await updatePlanState(f.paths(), (s) => ({ state: { ...s, plan: "pro" }, result: null }))
    for (const command of [
      ["plan", "buy", "pro"],
      ["plan", "renew"],
    ]) {
      for (const asJson of [false, true]) {
        f.stdout.text = ""
        f.stderr.text = ""
        expect(await run([...command, "--wallet", f.payer, ...(asJson ? ["--json"] : [])], f.deps)).toBe(1)
        if (asJson)
          expect(JSON.parse(f.stdout.text)).toMatchObject({
            ok: false,
            code: "X402_PLANS_OFF",
            message: expect.stringContaining("not available yet"),
          })
        else expect(f.stderr.text.replace(/\s+/g, " ")).toContain("not available yet")
      }
    }
    expect(f.unlocks()).toBe(0)
    expect(foldSpendLog(await readSpendLog(f.paths()))).toEqual([])
  })

  test("a paused billing store (503 without PAYMENT-REQUIRED) is the error it is, and nothing is paid", async () => {
    const f = await withVault(
      {
        [PRO]: () =>
          jsonResponse(503, {
            success: false,
            error: { code: "VALIDATION_FAILED", message: "Billing is paused.", reason: "paused", retryable: true },
          }),
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, status: 503 })
    expect(planCalls(f.routed, PRO)).toHaveLength(1)
  })

  test("a quote to another pay-to address is refused before anything is signed", async () => {
    const f = await withVault(
      { [PRO]: quote(PRO, { payTo: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS" }) },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "X402_PAY_TO_MISMATCH" })
    expect(planCalls(f.routed, PRO)).toHaveLength(1)
    expect(f.prompts).toHaveLength(0)
  })

  test("without a terminal nothing is requested", async () => {
    const f = await withVault({ [PRO]: quote(PRO) })
    f.deps.isTTY = { stdin: false, stdout: false, stderr: false }
    expect(await run(["plan", "buy", "pro", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(planCalls(f.routed, PRO)).toHaveLength(0)
  })

  test("renew needs a key, and usage errors exit 2", async () => {
    const f = await withVault({})
    expect(await run(["plan", "renew", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "PLAN_NOTHING_TO_RENEW" })
    expect(await run(["plan", "buy"], f.deps)).toBe(2)
    expect(await run(["plan", "buy", "free"], f.deps)).toBe(2)
    expect(await run(["plan", "auto-renew", "maybe"], f.deps)).toBe(2)
    expect(f.routed.calls.filter((c) => new URL(c.url).pathname !== "/")).toHaveLength(0)
  })
})

describe("auto-renew (spec 6.3)", () => {
  const CLUSTERS = `/api/v1/tokens/${MINT}/clusters`
  const clusters: RouteHandler = () => jsonResponse(200, { success: true, available: false, reason: "unavailable" })

  async function armed(
    routes: Record<string, RouteHandler | RouteHandler[]>,
    opts: { periodEnd?: string; ceiling?: string } = {},
  ) {
    const f = await withVault({ ...routes }, { CANDLE_API_KEY: "cndl_live_x" })
    await updatePlanState(f.paths(), (s) => ({
      state: {
        ...s,
        autoRenew: true,
        plan: "pro",
        payer: f.payer,
        periodEnd: opts.periodEnd ?? "2026-11-04T10:00:00.000Z",
        renewCeilingRaw: opts.ceiling ?? "50000000",
      },
      result: null,
    }))
    return f
  }

  test("within 3 days of the period end, another command renews first, with no typed confirm, once", async () => {
    const f = await armed({
      [RENEW]: [quote(RENEW), (req) => jsonResponse(200, receipt(bodyOf(req).payer as string), settled)],
      [CLUSTERS]: clusters,
    })
    expect(await run(["plans", "--help"], f.deps)).toBe(0)
    expect(planCalls(f.routed, RENEW)).toHaveLength(0)
    await run(["token", "clusters", MINT], f.deps)
    const calls = planCalls(f.routed, RENEW)
    expect(calls).toHaveLength(2)
    expect(headerOf(calls[0], "x-api-key")).toBe("cndl_live_x")
    expect(bodyOf(calls[0])).toMatchObject({ payer: f.payer, autoRenew: true })
    expect(f.prompts).toHaveLength(0)
    expect(f.unlocks()).toBe(1)
    expect(f.stderr.text).toContain("Auto-renew")
    expect(await readPlanState(f.paths())).toMatchObject({ periodEnd: PERIOD_END, autoRenew: true })
    expect(planCalls(f.routed, CLUSTERS)).toHaveLength(1)
    // The period moved out of the window: the next command renews nothing.
    await run(["token", "clusters", MINT], f.deps)
    expect(planCalls(f.routed, RENEW)).toHaveLength(2)
  })

  test("a renewal above the price last confirmed is shown and not paid, and not asked again for 12 hours", async () => {
    const f = await armed({ [RENEW]: quote(RENEW, { amount: "60000000" }), [CLUSTERS]: clusters })
    await run(["token", "clusters", MINT], f.deps)
    expect(f.stderr.text.replace(/\s+/g, " ")).toContain("more than the 50 USDC last confirmed here")
    expect(f.unlocks()).toBe(0)
    await run(["token", "clusters", MINT], f.deps)
    expect(planCalls(f.routed, RENEW)).toHaveLength(1)
    f.setNow(NOW + 13 * 60 * 60 * 1000)
    await run(["token", "clusters", MINT], f.deps)
    expect(planCalls(f.routed, RENEW)).toHaveLength(2)
  })

  test("paused payments, a period not yet in the window, --json and a non-terminal never renew", async () => {
    const paused = await armed({ [RENEW]: quote(RENEW), [CLUSTERS]: clusters })
    expect(await run(["spend", "pause"], paused.deps)).toBe(0)
    await run(["token", "clusters", MINT], paused.deps)
    expect(paused.stderr.text.replace(/\s+/g, " ")).toContain("payments are paused")
    expect(paused.unlocks()).toBe(0)

    const early = await armed(
      { [RENEW]: quote(RENEW), [CLUSTERS]: clusters },
      { periodEnd: "2026-11-10T10:00:00.000Z" },
    )
    await run(["token", "clusters", MINT], early.deps)
    await run(["token", "clusters", MINT, "--json"], early.deps)
    expect(planCalls(early.routed, RENEW)).toHaveLength(0)

    const json = await armed({ [RENEW]: quote(RENEW), [CLUSTERS]: clusters })
    await run(["token", "clusters", MINT, "--json"], json.deps)
    json.deps.isTTY = { stdin: false, stdout: false, stderr: false }
    await run(["token", "clusters", MINT], json.deps)
    expect(planCalls(json.routed, RENEW)).toHaveLength(0)
  })

  test("auto-renew on|off sets the local flag", async () => {
    const f = await armed({})
    expect(await run(["plan", "auto-renew", "off", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: true, autoRenew: false })
    expect((await readPlanState(f.paths())).autoRenew).toBe(false)
    f.stdout.text = ""
    expect(await run(["plan", "auto-renew", "on", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: true,
      autoRenew: true,
      plan: "pro",
      renewsFrom: "2026-11-01T10:00:00.000Z",
      maxRenewalUsdc: "50",
    })
  })
})

describe("candle plan status", () => {
  test("a dark payment history is explained while the plan and local records remain usable", async () => {
    const f = await withVault(
      {
        "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "pro" }),
        "/api/v1/agent/x402/payments": () => jsonResponse(404, { error: "Not Found" }),
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    await appendSpendLines(f.paths(), [
      { v: 1, id: "local", at: "2026-11-02T09:00:00Z", state: "pending", kind: "plan", amountRaw: "50000000" },
      { v: 1, id: "local", at: "2026-11-02T09:00:01Z", state: "settled", signature: "local-sig" },
    ])
    expect(await run(["plan", "status", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: true,
      plan: "pro",
      lastPayment: { source: "local", signature: "local-sig" },
      note: expect.stringContaining("not available yet"),
    })
    f.stdout.text = ""
    expect(await run(["plan", "status"], f.deps)).toBe(0)
    expect(f.stdout.text.replace(/\s+/g, " ")).toContain("x402 payment history is not available yet")
    expect(f.unlocks()).toBe(0)
  })

  test("the server's plan and last x402 plan payment, with this machine's period end and auto-renew", async () => {
    const f = await withVault(
      {
        "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "pro", maxTierExpiresAt: null }),
        "/api/v1/agent/x402/payments": () =>
          jsonResponse(200, {
            success: true,
            payments: [
              {
                id: "a",
                kind: "forensics",
                status: "fulfilled",
                amountUsdMicros: "10000",
                createdAt: "2026-11-02T09:00:00Z",
              },
              {
                id: "b",
                kind: "plan",
                status: "fulfilled",
                amountUsdMicros: "50000000",
                createdAt: "2026-11-01T09:00:00Z",
                signature: "s1",
              },
            ],
            credit: { balanceUsdMicros: "0" },
          }),
      },
      { CANDLE_API_KEY: "cndl_live_x" },
    )
    await updatePlanState(f.paths(), (s) => ({
      state: { ...s, autoRenew: true, plan: "pro", payer: f.payer, periodEnd: PERIOD_END, renewCeilingRaw: "50000000" },
      result: null,
    }))
    expect(await run(["plan", "status", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({
      ok: true,
      plan: "pro",
      periodEnd: PERIOD_END,
      autoRenew: true,
      renewsFrom: "2026-11-29T10:00:00.000Z",
      payer: f.payer,
      lastPayment: {
        source: "server",
        status: "fulfilled",
        amountUsdc: "50",
        at: "2026-11-01T09:00:00Z",
        signature: "s1",
      },
      unresolvedPayment: null,
    })
  })
})
