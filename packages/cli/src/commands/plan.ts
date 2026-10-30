/**
 * `candle plan` (Candle x402 spec docs/superpowers/specs/2026-10-24-candle-x402-design.md, 5.3 to
 * 5.6, 6.3, 10.1, 10.3, 10.5 and 10.7; card C7): Pro or Max for 30 days, paid by x402 in USDC from a
 * Solana vault key, and the wallet-as-identity signup that comes with a first purchase.
 *
 *   candle plan buy pro|max [--wallet <vault key>] [--yes] [--auto-renew] [--signer-out <pem>] [--json]
 *   candle plan status [--json]
 *   candle plan renew [--wallet <vault key>] [--yes] [--json]
 *   candle plan auto-renew on|off [--json]
 *
 * - **Buy** asks `POST /api/v1/agent/x402/plans/<plan>` for a quote, shows the price, the terms and
 *   (for a signup) the custody warning, takes one typed confirm (or `--yes`), signs the `exact`
 *   transfer with the vault key and sends it once. With the profile's API key the plan is the key's
 *   account's (5.1 rule 1). With none, the vault key `K` is the claimed payer: a wallet Candle
 *   already knows buys for its account; an unknown one signs up (5.3), with a new P-256 key signer
 *   `S` made here first. The returned API key is stored in the profile and `S` in its key's slot.
 * - **Never twice.** The signed payment is written to the plan state before it is sent and cleared
 *   only when its outcome is final. A 202 (`fulfilment_pending`), a 503 or no answer leaves it there,
 *   and the next `plan buy` or `plan renew` resends that same payment, which the server answers from
 *   its payment row: it resumes the fulfilment, or within 10 minutes returns the receipt again (and a
 *   signup's key anew, 5.4). Nothing new is signed while one is unresolved.
 * - **Outside the per-use rules.** Plan payments are logged in the spend log (kind `plan`) but never
 *   count toward the daily per-use limit or the per-call ceiling (10.3). The pinned pay-to holds.
 * - **Auto-renew** (6.3) is a local flag. When it is on, any other command run within 3 days before
 *   the period ends asks `POST .../plans/<plan>/renew` for a quote and pays it with no typed confirm,
 *   at most once every 12 hours, only at a terminal, only while `spend` is not paused, and only up to
 *   the list price last confirmed here. Anything more is printed and left to `plan renew`.
 *
 * Every switch is the server's. When the API does not sell plans by x402 (off, or an alpha a day
 * behind) the route is a 404 and these commands say so and pay nothing (10.5).
 */
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { withFileLock } from "../file-lock"
import { writeFields, writeSuccess } from "../human-output"
import { keySignerFingerprint, keySignerRef, saveKeySignerEntry, spkiSha256Of } from "../key-signers"
import { notice } from "../presentation"
import { defaultProfileNameFor, profileSecretRef } from "../profiles"
import { formatTime, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { pemToStoredSigner, storedSignerToPem } from "../secret-store"
import { decodePubkey } from "../solana-lite"
import { VaultError } from "../vault/errors"
import { encodePaymentPayload, PAYMENT_SIGNATURE_HEADER, paymentRequiredOf, settlementOf } from "../x402/codec"
import type { PaymentSigner } from "../x402/pay"
import {
  type PaidPlanName,
  type PendingPlanPayment,
  type PlanRequestBody,
  type PlanState,
  readPlanState,
  type SignupSigner,
  signupSignerRef,
  updatePlanState,
} from "../x402/plan-state"
import { networkConfig, PAY_TO_ENV, SOLANA_MAINNET, selectRequirement, usdcText } from "../x402/select"
import { buildExactTransfer, serializePartiallySigned } from "../x402/solana-exact"
import {
  appendSpendLines,
  foldSpendLog,
  PLAN_SPEND_KIND,
  readLimits,
  readSpendLog,
  recordSpendState,
  type SpendPaths,
  type SpendState,
  spendPaths,
} from "../x402/spend-log"
import { openVaultSigner } from "../x402/vault-payer"
import { CANDLE_TERMS_URL } from "./accounts"
import { blockhashFor } from "./token-paid"
import { confirmAddress, runVaultCommand } from "./vault-support"

/**
 * The terms version a plan payment accepts (5.6): `CURRENT_TERMS_VERSION` in `@candle/shared`, the
 * version the web app and `accounts create` send. Copied because the CLI has no cross-package
 * import; `plan.drift.test.ts` pins the two together.
 */
export const PLAN_TERMS_VERSION = "2026-10-25"
/** 6.3: auto-renew pays from this long before the period ends. */
export const AUTO_RENEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** One automatic attempt per this long, whatever its outcome, so a declined unlock is not asked again at once. */
export const AUTO_RENEW_RETRY_MS = 12 * 60 * 60 * 1000

/**
 * The commands auto-renew never runs in front of: the plan and spend commands themselves (spend pause
 * must stop it, not trigger it), the repair, help and identity commands, the long-running servers,
 * and the ones that open the vault themselves.
 */
const AUTO_RENEW_SKIPPED = new Set([
  "plan",
  "plans",
  "spend",
  "auth",
  "profile",
  "doctor",
  "verify",
  "update",
  "help",
  "completion",
  "version",
  "accounts",
  "vault",
  "core",
  "tui",
  "mcp",
  "external",
  "sign",
  "secrets",
  "plugins",
])

const USAGE_BUY =
  "Usage: candle plan buy pro|max [--wallet <vault key>] [--yes] [--auto-renew] [--signer-out <pem>] [--json]"
const USAGE_RENEW = "Usage: candle plan renew [--wallet <vault key>] [--yes] [--json]"
const USAGE_AUTO = "Usage: candle plan auto-renew on|off [--json]"

const planPath = (plan: PaidPlanName, renew: boolean) => `/api/v1/agent/x402/plans/${plan}${renew ? "/renew" : ""}`
const planName = (plan: PaidPlanName) => (plan === "pro" ? "Pro" : "Max")

function isSolanaAddress(value: string): boolean {
  try {
    decodePubkey(value)
    return true
  } catch {
    return false
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The plan figures a plan 402 carries beside the x402 object (6.1, A3). */
interface QuotedPlan {
  listRaw: bigint
  creditRaw: bigint
  dueRaw: bigint
  signup: boolean
}

function quotedPlanOf(raw: unknown): QuotedPlan | null {
  const plan = isObject(raw) && isObject(raw.plan) ? raw.plan : null
  if (!plan) return null
  const n = (v: unknown) => (typeof v === "string" && /^[0-9]{1,20}$/.test(v) ? BigInt(v) : null)
  const listRaw = n(plan.listPriceUsdMicros)
  const creditRaw = n(plan.creditUsdMicros)
  const dueRaw = n(plan.amountDueUsdMicros)
  if (listRaw === null || creditRaw === null || dueRaw === null) return null
  return { listRaw, creditRaw, dueRaw, signup: plan.signup === true }
}

/** The receipt a fulfilled plan payment returns (6.1, 5.3). The key is there once, on a signup. */
interface PlanReceipt {
  account: string
  plan: PaidPlanName
  periodEnd: string | null
  amountPaidRaw: bigint
  signup: {
    keyPrefix: string
    fingerprint: string
    signerQuorumId: string
    wallets: { solana: string; evm: string }
  } | null
  apiKey: string | null
}

function receiptOf(body: unknown): PlanReceipt | null {
  if (!isObject(body) || body.status !== "fulfilled" || typeof body.account !== "string") return null
  if (body.plan !== "pro" && body.plan !== "max") return null
  const paid = typeof body.amountPaidUsdMicros === "string" && /^[0-9]{1,20}$/.test(body.amountPaidUsdMicros)
  const s = isObject(body.signup) ? body.signup : null
  const signer = s && isObject(s.signer) ? s.signer : null
  const wallets = s && isObject(s.wallets) ? s.wallets : null
  const signup =
    s &&
    typeof s.keyPrefix === "string" &&
    signer &&
    typeof signer.fingerprint === "string" &&
    typeof signer.signerQuorumId === "string" &&
    wallets &&
    typeof wallets.solana === "string" &&
    typeof wallets.evm === "string"
      ? {
          keyPrefix: s.keyPrefix,
          fingerprint: signer.fingerprint,
          signerQuorumId: signer.signerQuorumId,
          wallets: { solana: wallets.solana, evm: wallets.evm },
        }
      : null
  return {
    account: body.account,
    plan: body.plan,
    periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : null,
    amountPaidRaw: paid ? BigInt(body.amountPaidUsdMicros as string) : 0n,
    signup,
    apiKey: typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : null,
  }
}

/** The final or unfinished state a sent plan payment is in, read from the server's answer. */
type PlanOutcome =
  | { kind: "fulfilled"; receipt: PlanReceipt; signature?: string }
  | { kind: "pending"; reason: string; settled: boolean; signature?: string }
  | { kind: "used"; message: string }
  | { kind: "failed"; reason: string }

/**
 * 3.4 and 3.5, for a plan: 200 with a receipt is fulfilled; 202 is `fulfilment_pending` (paid, the
 * account or period not finished); `PAYMENT_ALREADY_USED` is a payment fulfilled earlier whose replay
 * window has passed; a 402 is a refusal before anything moved. A 5xx, no answer, `PAYMENT_IN_PROGRESS`
 * or (on a resume) any other answer leaves the payment unresolved, never "nothing was paid".
 */
function planOutcome(result: ApiResult, resumed: boolean): PlanOutcome {
  const settlement = settlementOf(result.headers)
  const signature = settlement?.success && settlement.transaction ? settlement.transaction : undefined
  if (result.ok) {
    const receipt = result.status === 200 ? receiptOf(result.body) : null
    if (receipt) return { kind: "fulfilled", receipt, ...(signature ? { signature } : {}) }
    return {
      kind: "pending",
      reason: result.status === 202 ? "fulfilment_pending" : `HTTP_${result.status}`,
      settled: settlement?.success === true,
      ...(signature ? { signature } : {}),
    }
  }
  if (result.code === "PAYMENT_ALREADY_USED") return { kind: "used", message: result.message }
  if (result.status === 402) {
    return {
      kind: "failed",
      reason: settlement?.errorReason ?? paymentRequiredOf(result.headers)?.error ?? result.code ?? "HTTP_402",
    }
  }
  const unresolved = result.status === 0 || result.status >= 500 || result.status === 409 || resumed
  if (unresolved) return { kind: "pending", reason: result.code ?? `HTTP_${result.status}`, settled: false }
  // A first send refused before the gate reserved anything (decode, rate ceiling, auth): nothing moved.
  return { kind: "failed", reason: result.code ?? `HTTP_${result.status}` }
}

// ── Local state helpers ───────────────────────────────────────────────────────────────────────

function pathsFor(ctx: CommandContext, profile: string | undefined): SpendPaths {
  return spendPaths(ctx.deps.env, ctx.deps.homedir(), profile)
}

/**
 * The profile a signup stores its key in: `--profile`, else the one this invocation resolved, else
 * a new one named for the API host, as `auth login` names one. Computed the same way on a resume, so
 * the unfinished payment is found under the same name.
 */
async function signupProfile(ctx: CommandContext): Promise<string> {
  if (ctx.profileFlag) return ctx.profileFlag
  if (ctx.profile) return ctx.profile
  return defaultProfileNameFor(ctx.apiUrl, (await ctx.deps.readConfig()).profiles)
}

function generatePair(): { pem: string; publicKeyDer: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }
}

/**
 * 5.3 and 5.5: the key signer `S` a signup for `payer` binds its wallets to. Made once per payer,
 * private half in the secret store before any request, and reused by every retry: the quote and the
 * payment are bound to its public key.
 */
async function signupSigner(ctx: CommandContext, paths: SpendPaths, payer: string): Promise<SignupSigner> {
  const state = await readPlanState(paths)
  for (const existing of state.signupSigners ?? []) {
    if (existing.payer === payer && (await ctx.deps.store.get(signupSignerRef(existing.spkiSha256))) !== null) {
      return existing
    }
  }
  const pair = generatePair()
  const spkiSha256 = spkiSha256Of(pair.publicKeyDer)
  const ref = signupSignerRef(spkiSha256)
  if ((await ctx.deps.store.get(ref)) !== null)
    throw new Error(`The slot ${ref} is already in use; nothing was written.`)
  await ctx.deps.store.set(ref, pemToStoredSigner(pair.pem))
  const signer: SignupSigner = {
    spkiSha256,
    publicKeyDer: pair.publicKeyDer,
    fingerprint: keySignerFingerprint(spkiSha256),
    payer,
    createdAt: new Date(ctx.deps.now()).toISOString(),
  }
  await updatePlanState(paths, (s) => ({
    state: { ...s, signupSigners: [...(s.signupSigners ?? []).filter((e) => e.payer !== payer), signer] },
    result: null,
  }))
  return signer
}

/** 5.5, said before the first payment of a signup and in its receipt. */
function custodyWarning(payer: string, fingerprint: string): string {
  return [
    `Your vault key ${payer} (K) becomes this account's identity and root: it pays, and anyone holding it controls the account and can get a new API key for it.`,
    `The account's trading wallets are owned only by the key signer ${fingerprint} (S), made on this machine and kept in its secret store. Candle holds no key that can move them.`,
    "Losing S loses the wallets and everything in them; nothing replaces it, not Candle and not K.",
    "Back up S (--signer-out writes a copy) as well as the vault phrase for K, and keep in the wallets only what the agent needs, moving funds out while S still works.",
  ].join(" ")
}

// ── The payment ───────────────────────────────────────────────────────────────────────────────

type Mode = "buy" | "renew" | "auto"

interface PlanRun {
  mode: Mode
  plan: PaidPlanName
  wallet?: string
  yes: boolean
  autoRenewFlag: boolean
  signerOut?: string
}

/** Sends a plan payment already in the state (a first send or a resume) and settles its outcome. */
async function sendPending(
  ctx: CommandContext,
  paths: SpendPaths,
  pending: PendingPlanPayment,
  apiKey: string | undefined,
  opts: { resumed: boolean; autoRenewFlag: boolean; signupProfileName: string | null },
): Promise<number> {
  const keyed = pending.keyed && apiKey !== undefined
  if (pending.keyed && apiKey === undefined) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "NO_API_KEY",
        message: `A plan payment of ${usdcText(BigInt(pending.amountRaw))} USDC sent with this profile's API key is not resolved, and the key is gone from this profile. Nothing new was paid.`,
        suggestion: "Restore the key (candle auth login) and run candle plan buy again to resume it.",
      },
      ctx.json,
    )
    return 1
  }
  const result = await apiRequest(pending.path, {
    method: "POST",
    body: pending.body,
    apiUrl: ctx.apiUrl,
    auth: keyed ? "key" : "none",
    credentials: keyed ? { apiKey } : {},
    env: ctx.deps.env,
    fetch: ctx.deps.fetch,
    headers: { [PAYMENT_SIGNATURE_HEADER]: pending.paymentHeader },
  })
  const outcome = planOutcome(result, opts.resumed)
  const at = new Date(ctx.deps.now()).toISOString()
  const logState: SpendState =
    outcome.kind === "fulfilled" || outcome.kind === "used" || (outcome.kind === "pending" && outcome.settled)
      ? "settled"
      : outcome.kind === "failed"
        ? "failed"
        : "unknown"
  const signature = "signature" in outcome ? outcome.signature : undefined
  await recordSpendState(paths, {
    id: pending.id,
    at,
    state: logState,
    ...(signature ? { signature } : {}),
    ...(outcome.kind === "failed" || outcome.kind === "pending" ? { reason: outcome.reason } : {}),
  })
  const amount = usdcText(BigInt(pending.amountRaw))
  const name = planName(pending.plan)
  const availabilityNote =
    !result.ok && result.status === 404 ? "x402 plan payments are not available yet on this Candle server. " : ""

  if (outcome.kind === "pending") {
    const review = !result.ok && result.code === "PAYMENT_IN_PROGRESS" && result.retryable === false
    writeLocalFailure(
      ctx.deps,
      {
        code: "PLAN_PAYMENT_PENDING",
        message:
          availabilityNote +
          (outcome.settled
            ? `Paid ${amount} USDC for Candle ${name}; Candle is still finishing ${pending.signupSpkiSha256 ? "the new account" : "the period"}.`
            : review
              ? `The payment of ${amount} USDC for Candle ${name} is held for review by Candle. Nothing new was paid.`
              : `Whether the payment of ${amount} USDC for Candle ${name} settled is not known yet (${terminalText(outcome.reason)}). Nothing new was paid.`),
        suggestion: `Run the same command again: it resends this payment and never pays twice (candle plan ${pending.renew ? "renew" : `buy ${pending.plan}`}).`,
        details: { paymentId: pending.id, reason: outcome.reason, ...(signature ? { signature } : {}) },
      },
      ctx.json,
    )
    return 3
  }

  // Final from here on. A fulfilled signup keeps the payment in the state until the key and S are
  // stored: the replay is the only way to get the key again (5.4).
  const receipt = outcome.kind === "fulfilled" ? outcome.receipt : null
  let stored: { profile: string; keyPrefix: string } | null = null
  if (receipt?.signup && pending.signupSpkiSha256 && receipt.apiKey) {
    try {
      stored = await storeSignup(ctx, paths, pending, receipt, opts.signupProfileName)
    } catch (error) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PLAN_PAYMENT_PENDING",
          message: `Paid ${amount} USDC for Candle ${name} and the account was made, but the API key could not be stored here (${error instanceof Error ? error.message : String(error)}).`,
          suggestion: `Fix the secret store and run the same command again within 10 minutes: it resends this payment, never pays twice, and returns the key (candle plan buy ${pending.plan}).`,
          details: { paymentId: pending.id },
        },
        ctx.json,
      )
      return 3
    }
  }
  await updatePlanState(paths, (s) => {
    if (s.pending?.id !== pending.id) return { state: null, result: null }
    const next: PlanState = { ...s }
    delete next.pending
    if (receipt) {
      next.plan = receipt.plan
      next.payer = pending.payer
      if (receipt.periodEnd) next.periodEnd = receipt.periodEnd
      // The most auto-renew may pay unattended: the list price confirmed here, else what was paid.
      const ceiling = pending.ceilingRaw ?? pending.amountRaw
      next.renewCeilingRaw = ceiling
      if (opts.autoRenewFlag) next.autoRenew = true
      delete next.lastRenewAttemptAt
    }
    return { state: next, result: null }
  })

  if (outcome.kind === "failed") {
    writeLocalFailure(
      ctx.deps,
      {
        code: "PLAN_PAYMENT_FAILED",
        message: `${availabilityNote}The payment of ${amount} USDC for Candle ${name} did not go through (${terminalText(outcome.reason)}); nothing moved.`,
        suggestion: `Run candle plan ${pending.renew ? "renew" : `buy ${pending.plan}`} again for a fresh quote.`,
        details: { paymentId: pending.id, reason: outcome.reason },
      },
      ctx.json,
    )
    return 1
  }

  if (outcome.kind === "used") {
    // Fulfilled earlier, and the 10-minute replay window has passed (3.5).
    if (pending.signupSpkiSha256) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PLAN_SIGNUP_KEY_NOT_DELIVERED",
          message: `The payment of ${amount} USDC made the account, and its API key was not delivered here within the 10 minutes a replay returns it. The key signer stays in this machine's secret store.`,
          suggestion:
            "Get a new key with a reissue_key proof from the identity wallet through POST /api/v1/agent/x402/keys (spec 5.4). Do not delete the signer: it owns the account's wallets.",
          details: { paymentId: pending.id, signer: keySignerFingerprint(pending.signupSpkiSha256) },
        },
        ctx.json,
      )
      return 1
    }
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify({ ok: true, status: "already_fulfilled", plan: pending.plan, amountPaidUsdc: amount, message: outcome.message })}\n`,
      )
    } else {
      writeSuccess(ctx.deps, "stdout", `The payment of ${amount} USDC for Candle ${name} was fulfilled earlier.`)
      notice(
        ctx.deps,
        "stdout",
        "note",
        "Its receipt is past the replay window. See the period with: candle plan status",
      )
    }
    return 0
  }

  const r = outcome.receipt
  const keyNotReturned = Boolean(r.signup && pending.signupSpkiSha256 && !r.apiKey)
  const autoRenew = (await readPlanState(paths)).autoRenew
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({
        ok: true,
        status: "fulfilled",
        plan: r.plan,
        account: r.account,
        periodEnd: r.periodEnd,
        amountPaidUsdc: usdcText(r.amountPaidRaw),
        payer: pending.payer,
        ...(outcome.signature ? { signature: outcome.signature } : {}),
        autoRenew,
        ...(r.signup
          ? {
              signup: {
                profile: stored?.profile ?? null,
                keyPrefix: r.signup.keyPrefix,
                keyStored: stored !== null,
                signer: { fingerprint: r.signup.fingerprint },
                wallets: r.signup.wallets,
              },
            }
          : {}),
        ...(opts.resumed ? { resumed: true } : {}),
      })}\n`,
    )
  } else {
    writeSuccess(
      ctx.deps,
      "stdout",
      `Candle ${planName(r.plan)}${r.periodEnd ? ` until ${formatTime(r.periodEnd, { now: ctx.deps.now(), date: true })}` : ""}: paid ${usdcText(r.amountPaidRaw)} USDC.`,
    )
    writeFields(ctx.deps, "stdout", [
      ["Account", r.account],
      ["Paid from", pending.payer],
      ["Signature", outcome.signature],
      ["Auto-renew", autoRenew ? "on" : "off"],
      ...(r.signup
        ? ([
            ["Profile", stored?.profile],
            ["API key", stored ? `${r.signup.keyPrefix} (stored)` : r.signup.keyPrefix],
            ["Key signer", r.signup.fingerprint],
            ["Solana wallet", r.signup.wallets.solana],
            ["Hood wallet", r.signup.wallets.evm],
          ] as const)
        : []),
    ])
    if (r.signup) notice(ctx.deps, "stdout", "warning", custodyWarning(pending.payer, r.signup.fingerprint))
  }
  if (keyNotReturned) {
    notice(
      ctx.deps,
      "stderr",
      "warning",
      "The account exists and the API did not return its key in this answer. The key signer stays in this machine's secret store. Get a key with a reissue_key proof through POST /api/v1/agent/x402/keys (spec 5.4).",
    )
  }
  return 0
}

/**
 * 5.3 after the receipt: the key into the profile, `S` into its key's slot with the quorum, and the
 * signup slot removed only once both are written. Nothing here prints the key.
 */
async function storeSignup(
  ctx: CommandContext,
  paths: SpendPaths,
  pending: PendingPlanPayment,
  receipt: PlanReceipt,
  profileName: string | null,
): Promise<{ profile: string; keyPrefix: string }> {
  const signup = receipt.signup as NonNullable<PlanReceipt["signup"]>
  const spki = pending.signupSpkiSha256 as string
  const deps = ctx.deps
  const profile = profileName ?? (await signupProfile(ctx))
  const config = await deps.readConfig()
  await deps.store.set(profileSecretRef(profile, "apiKey"), receipt.apiKey as string)
  await deps.updateProfile(profile, {
    apiUrl: ctx.apiUrl,
    keyPrefix: signup.keyPrefix,
    account: receipt.account,
    accountCachedAt: deps.now(),
  })
  if (!config.activeProfile) await deps.writeConfig({ activeProfile: profile })
  const slot = await deps.store.get(signupSignerRef(spki))
  const signer = (await readPlanState(paths)).signupSigners?.find((s) => s.spkiSha256 === spki)
  if (slot !== null && signer) {
    await deps.store.set(keySignerRef(signup.keyPrefix, spki), slot)
    await saveKeySignerEntry(deps, {
      keyPrefix: signup.keyPrefix,
      spkiSha256: spki,
      fingerprint: signer.fingerprint,
      publicKeyDer: signer.publicKeyDer,
      signerQuorumId: signup.signerQuorumId,
      createdAt: Date.parse(signer.createdAt) || deps.now(),
    })
    // The key's slot holds S now; only then does the signup slot go.
    if ((await deps.store.get(keySignerRef(signup.keyPrefix, spki))) === slot) {
      await deps.store.delete(signupSignerRef(spki))
      await updatePlanState(paths, (s) => ({
        state: { ...s, signupSigners: (s.signupSigners ?? []).filter((e) => e.spkiSha256 !== spki) },
        result: null,
      }))
    }
  }
  return { profile, keyPrefix: signup.keyPrefix }
}

/** The quote, the confirm, the signature and the first send of one plan payment. */
async function runPlanPayment(ctx: CommandContext, run: PlanRun): Promise<number> {
  const deps = ctx.deps
  const json = ctx.json
  const apiKey = await resolveApiKey(deps, ctx.profile)
  const renew = run.mode !== "buy"
  if (renew && !apiKey) {
    writeLocalFailure(
      deps,
      {
        code: "NO_API_KEY",
        message: "A renewal is for the account of this profile's API key, and this profile has none. Nothing was paid.",
        suggestion: "Run: candle plan buy pro|max",
      },
      json,
    )
    return 1
  }
  // A signup's state lives under the profile its key will be stored in.
  const signupProfileName = apiKey ? null : await signupProfile(ctx)
  const paths = pathsFor(ctx, signupProfileName ?? ctx.profile)

  const state = await readPlanState(paths)
  if (state.pending) {
    if (run.mode === "auto") return 1
    if (!json) {
      notice(
        deps,
        "stderr",
        "note",
        `Resuming the plan payment of ${usdcText(BigInt(state.pending.amountRaw))} USDC sent ${formatTime(state.pending.startedAt, { now: deps.now() })}; nothing new is paid.`,
      )
    }
    return sendPending(ctx, paths, state.pending, apiKey, {
      resumed: true,
      autoRenewFlag: run.autoRenewFlag,
      signupProfileName,
    })
  }

  // The payer: a vault key named by address is quoted before the vault opens; otherwise it is opened first.
  let signer: PaymentSigner | null = null
  try {
    let payer: string
    if (run.wallet !== undefined && isSolanaAddress(run.wallet)) payer = run.wallet
    else {
      signer = await openVaultSigner(ctx, {
        ...(run.wallet !== undefined ? { wallet: run.wallet } : {}),
        reason: `pay for Candle ${planName(run.plan)}`,
      })
      payer = signer.address
    }

    const signup = run.mode === "buy" && !apiKey ? await signupSigner(ctx, paths, payer) : null
    const body: PlanRequestBody = {
      payer,
      ...(signup ? { signerPublicKey: signup.publicKeyDer } : {}),
      termsVersion: PLAN_TERMS_VERSION,
      autoRenew: run.autoRenewFlag || state.autoRenew,
    }
    const path = planPath(run.plan, renew)
    const request = {
      method: "POST",
      body,
      apiUrl: ctx.apiUrl,
      auth: apiKey ? ("key" as const) : ("none" as const),
      credentials: apiKey ? { apiKey } : {},
      env: deps.env,
      fetch: deps.fetch,
    }
    const quote = await apiRequest(path, request)
    if (quote.ok) {
      writeLocalFailure(
        deps,
        {
          code: "PLAN_NOT_QUOTED",
          message: "The API answered without asking for a payment. Nothing was paid.",
          details: { status: quote.status },
        },
        json,
      )
      return 1
    }
    if (quote.status === 404) {
      writeLocalFailure(
        deps,
        {
          code: "X402_PLANS_OFF",
          message: "Buying or renewing plans by x402 is not available yet on this Candle server. Nothing was paid.",
          suggestion: "Plans are sold on the web at candle.tv, or by USDC checkout.",
        },
        json,
      )
      return 1
    }
    const required = quote.status === 402 ? paymentRequiredOf(quote.headers) : null
    if (!required) {
      writeFailure(deps, quote, { apiUrl: ctx.apiUrl, authType: apiKey ? "key" : "none" }, json)
      return 1
    }
    const network = networkConfig(deps.env)
    if (!network.ok) {
      writeLocalFailure(deps, { code: "X402_NOT_PAYABLE", message: network.message }, json)
      return 1
    }
    const config = network.config
    const selection = selectRequirement(required, config)
    if (!selection.ok) {
      writeLocalFailure(deps, { code: "X402_NOT_PAYABLE", message: selection.reason }, json)
      return 1
    }
    const { selected } = selection
    const price = usdcText(selected.amountRaw)
    if (config.payTo === null) {
      writeLocalFailure(
        deps,
        {
          code: "X402_PAY_TO_UNPINNED",
          message:
            config.network === SOLANA_MAINNET
              ? `Candle ${planName(run.plan)} costs ${price} USDC, and this CLI release pins no mainnet pay-to address, so it pays nothing on mainnet.`
              : `Candle ${planName(run.plan)} costs ${price} USDC on devnet, and no pay-to address is set for devnet.`,
          ...(config.network === SOLANA_MAINNET
            ? {}
            : { suggestion: `Set ${PAY_TO_ENV} to the devnet address the API pays to.` }),
          details: { priceUsdc: price },
        },
        json,
      )
      return 1
    }
    if (selected.requirement.payTo !== config.payTo) {
      writeLocalFailure(
        deps,
        {
          code: "X402_PAY_TO_MISMATCH",
          message: `The server asked for payment to ${selected.requirement.payTo}, not the address this CLI pays (${config.payTo}). Nothing was paid.`,
          details: { priceUsdc: price },
        },
        json,
      )
      return 1
    }
    const quoted = quotedPlanOf(quote.raw)
    if (quoted && quoted.dueRaw !== selected.amountRaw) {
      writeLocalFailure(
        deps,
        {
          code: "X402_OFFER_CHANGED",
          message: `The quote's amount due (${usdcText(quoted.dueRaw)} USDC) is not what the payment asks (${price} USDC). Nothing was paid.`,
        },
        json,
      )
      return 1
    }
    if (signup && quoted && !quoted.signup && apiKey === undefined && !json) {
      notice(
        deps,
        "stderr",
        "note",
        "This wallet is already a Candle account: the plan is bought for it, and no new account or key is made.",
      )
    }
    // A wallet Candle already knows buys for its account and the signer is not used (5.1 rule 2).
    const isSignup = signup !== null && (quoted ? quoted.signup : true)
    if (run.mode === "auto") {
      const limits = await readLimits(paths)
      if (limits.paused) {
        notice(deps, "stderr", "note", "Auto-renew did not pay: payments are paused (candle spend resume).")
        return 1
      }
      const ceiling = state.renewCeilingRaw ? BigInt(state.renewCeilingRaw) : 0n
      if (selected.amountRaw > ceiling) {
        notice(
          deps,
          "stderr",
          "warning",
          `Auto-renew did not pay: the renewal costs ${price} USDC, more than the ${usdcText(ceiling)} USDC last confirmed here. Renew at that price with: candle plan renew`,
        )
        return 1
      }
    }

    const termsUrl =
      isObject(quote.raw) && isObject(quote.raw.terms) && typeof quote.raw.terms.url === "string"
        ? quote.raw.terms.url
        : CANDLE_TERMS_URL
    writeFields(
      deps,
      json || run.mode === "auto" ? "stderr" : "stdout",
      [
        ["Plan", `Candle ${planName(run.plan)}, 30 days${renew ? " (renewal)" : ""}${isSignup ? ", new account" : ""}`],
        ...(quoted && quoted.creditRaw > 0n
          ? ([
              ["List price", `${usdcText(quoted.listRaw)} USDC`],
              ["Upgrade credit", `${usdcText(quoted.creditRaw)} USDC`],
            ] as const)
          : []),
        ["Amount due", `${price} USDC`],
        ["Pays from", payer],
        ["Pays to", selected.requirement.payTo],
        ["Network", config.network],
        ["Terms", `${terminalText(termsUrl)} (version ${PLAN_TERMS_VERSION})`],
      ],
      run.mode === "auto" ? "Auto-renew" : "Plan payment",
    )
    // Only a signup has a signer worth writing out; a known wallet never uses it (5.1 rule 2).
    if (isSignup && signup && run.signerOut !== undefined) {
      const stored = await deps.store.get(signupSignerRef(signup.spkiSha256))
      if (stored !== null) {
        await deps.writeFile(run.signerOut, storedSignerToPem(stored))
        notice(
          deps,
          "stderr",
          "warning",
          `Wrote the key signer's private key to ${run.signerOut} (mode 0600). It is plaintext on disk; keep it offline. The secret store still holds it.`,
        )
      }
    }
    if (isSignup && signup) {
      notice(deps, json ? "stderr" : "stdout", "warning", custodyWarning(payer, signup.fingerprint))
    }
    // 5.6: paying accepts the terms, and the confirm says so. Auto-renew was confirmed when it was turned on.
    if (run.mode !== "auto" && !run.yes) {
      await confirmAddress(
        ctx,
        "pay to",
        selected.requirement.payTo,
        `pay ${price} USDC for Candle ${planName(run.plan)} and accept Candle's terms ${PLAN_TERMS_VERSION}`,
      )
    }
    if (signer === null) {
      signer = await openVaultSigner(ctx, {
        wallet: payer,
        reason: `pay ${price} USDC for Candle ${planName(run.plan)}`,
      })
    }
    if (signer.address !== payer) throw new Error("unreachable: the vault key that opened is not the quoted payer")

    const transfer = buildExactTransfer({
      payer,
      payTo: selected.requirement.payTo,
      asset: selected.requirement.asset,
      amountRaw: selected.amountRaw,
      feePayer: selected.feePayer,
      memo: selected.memo,
      recentBlockhash: await blockhashFor(ctx)(config.network),
    })
    const transaction = serializePartiallySigned(transfer, signer.sign(transfer.message))
    const at = new Date(deps.now()).toISOString()
    const pending: PendingPlanPayment = {
      id: randomUUID(),
      plan: run.plan,
      renew,
      path,
      body,
      paymentHeader: encodePaymentPayload({ resource: required.resource, accepted: selected.requirement, transaction }),
      keyed: apiKey !== undefined,
      amountRaw: selected.amountRaw.toString(),
      ...(quoted
        ? { ceilingRaw: (quoted.listRaw > selected.amountRaw ? quoted.listRaw : selected.amountRaw).toString() }
        : {}),
      payer,
      startedAt: at,
      ...(isSignup && signup ? { signupSpkiSha256: signup.spkiSha256 } : {}),
    }
    // Written before it is sent, under the lock: a second process sees it and resumes rather than pays.
    const reserved = await updatePlanState(paths, (s) =>
      s.pending ? { state: null, result: false } : { state: { ...s, pending }, result: true },
    )
    if (!reserved) {
      writeLocalFailure(
        deps,
        {
          code: "PLAN_PAYMENT_IN_FLIGHT",
          message: "Another plan payment from this profile started meanwhile. This one was signed and never sent.",
          suggestion: "Run candle plan status, then candle plan buy again to resume that payment.",
        },
        json,
      )
      return 1
    }
    await withFileLock(paths.log, () =>
      appendSpendLines(paths, [
        {
          v: 1,
          at,
          id: pending.id,
          state: "pending",
          kind: PLAN_SPEND_KIND,
          route: `POST ${path}`,
          network: config.network,
          amountRaw: pending.amountRaw,
          payTo: selected.requirement.payTo,
          payer,
          quoteMemo: selected.memo,
          keyless: apiKey === undefined,
        },
      ]),
    )
    return await sendPending(ctx, paths, pending, apiKey, {
      resumed: false,
      autoRenewFlag: run.autoRenewFlag,
      signupProfileName,
    })
  } finally {
    signer?.close()
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────

function refuseWithoutTerminal(ctx: CommandContext): boolean {
  if (ctx.deps.isTTY.stdin && ctx.deps.isTTY.stdout) return false
  writeLocalFailure(
    ctx.deps,
    {
      code: "VAULT_UNLOCK_FAILED",
      message:
        "Paying for a plan needs a terminal: the vault key that signs it is unlocked at a hidden prompt and from nowhere else. Nothing was paid.",
    },
    ctx.json,
  )
  return true
}

/** `candle plan buy pro|max [--wallet <vault key>] [--yes] [--auto-renew] [--signer-out <pem>] [--json]` */
export async function planBuy(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--signer-out"],
    booleanFlags: ["--yes", "--auto-renew"],
    pathFlags: ["--signer-out"],
  })
  const plan = "error" in parsed ? undefined : parsed.positionals[0]
  if ("error" in parsed || parsed.positionals.length !== 1 || (plan !== "pro" && plan !== "max")) {
    writeUsageFailure(ctx.deps, "error" in parsed ? `${parsed.error}\n${USAGE_BUY}` : USAGE_BUY, ctx.json)
    return 2
  }
  if (refuseWithoutTerminal(ctx)) return 1
  const wallet = parsed.values["--wallet"]
  const signerOut = parsed.values["--signer-out"]
  return runVaultCommand(ctx, () =>
    runPlanPayment(ctx, {
      mode: "buy",
      plan,
      ...(wallet !== undefined ? { wallet } : {}),
      yes: parsed.booleans.has("--yes"),
      autoRenewFlag: parsed.booleans.has("--auto-renew"),
      ...(signerOut !== undefined ? { signerOut } : {}),
    }),
  )
}

/** The plan this account is on, from `GET /api/v1/agent/tier` (`pro` or `max`), or null. */
async function serverPlan(
  ctx: CommandContext,
  apiKey: string,
): Promise<{ tier: string | null; maxUntil: string | null } | null> {
  const result = await apiRequest("/api/v1/agent/tier", {
    apiUrl: ctx.apiUrl,
    auth: "key",
    credentials: { apiKey },
    env: ctx.deps.env,
    fetch: ctx.deps.fetch,
  })
  if (!result.ok || !isObject(result.body)) return null
  const tier = typeof result.body.tier === "string" ? result.body.tier : null
  const expires = result.body.maxTierExpiresAt
  const maxUntil =
    typeof expires === "number" ? new Date(expires).toISOString() : typeof expires === "string" ? expires : null
  return { tier, maxUntil }
}

/** `candle plan renew [--wallet <vault key>] [--yes] [--json]`: the next 30 days now (6.3). */
export async function planRenew(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"], booleanFlags: ["--yes"] })
  if ("error" in parsed || parsed.positionals.length !== 0) {
    writeUsageFailure(ctx.deps, "error" in parsed ? `${parsed.error}\n${USAGE_RENEW}` : USAGE_RENEW, ctx.json)
    return 2
  }
  if (refuseWithoutTerminal(ctx)) return 1
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  const state = await readPlanState(pathsFor(ctx, ctx.profile))
  let plan = state.plan
  if (!plan && apiKey) {
    const live = await serverPlan(ctx, apiKey)
    if (live?.tier === "pro" || live?.tier === "max") plan = live.tier
  }
  if (!plan && !state.pending) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "PLAN_NOTHING_TO_RENEW",
        message: "This profile has no Pro or Max plan to renew. Nothing was paid.",
        suggestion: "Buy one with: candle plan buy pro|max",
      },
      ctx.json,
    )
    return 1
  }
  const wallet = parsed.values["--wallet"] ?? state.payer
  return runVaultCommand(ctx, () =>
    runPlanPayment(ctx, {
      mode: "renew",
      plan: (plan ?? state.pending?.plan) as PaidPlanName,
      ...(wallet !== undefined ? { wallet } : {}),
      yes: parsed.booleans.has("--yes"),
      autoRenewFlag: false,
    }),
  )
}

/** `candle plan auto-renew on|off [--json]`: the local flag (6.3). */
export async function planAutoRenew(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  const word = "error" in parsed ? undefined : parsed.positionals[0]
  if ("error" in parsed || parsed.positionals.length !== 1 || (word !== "on" && word !== "off")) {
    writeUsageFailure(ctx.deps, USAGE_AUTO, ctx.json)
    return 2
  }
  const on = word === "on"
  const paths = pathsFor(ctx, ctx.profile)
  const state = await updatePlanState(paths, (s) => {
    const next: PlanState = { ...s, autoRenew: on }
    delete next.lastRenewAttemptAt
    return { state: next, result: next }
  })
  const renewsFrom = state.periodEnd ? new Date(Date.parse(state.periodEnd) - AUTO_RENEW_WINDOW_MS).toISOString() : null
  const ready = Boolean(state.plan && state.payer && state.periodEnd && state.renewCeilingRaw)
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({
        ok: true,
        autoRenew: on,
        plan: state.plan ?? null,
        periodEnd: state.periodEnd ?? null,
        renewsFrom: on && ready ? renewsFrom : null,
        maxRenewalUsdc: state.renewCeilingRaw ? usdcText(BigInt(state.renewCeilingRaw)) : null,
      })}\n`,
    )
    return 0
  }
  writeSuccess(ctx.deps, "stdout", `Auto-renew ${on ? "on" : "off"}.`)
  if (on && ready && renewsFrom && state.plan && state.renewCeilingRaw) {
    notice(
      ctx.deps,
      "stdout",
      "note",
      `From ${formatTime(renewsFrom, { now: ctx.deps.now() })}, the first candle command run at a terminal renews Candle ${planName(state.plan)} for 30 days from ${state.payer}, up to ${usdcText(BigInt(state.renewCeilingRaw))} USDC, after the vault unlock. candle spend pause stops it.`,
    )
  } else if (on) {
    notice(
      ctx.deps,
      "stdout",
      "note",
      "Nothing renews yet: auto-renew pays only for a plan bought or renewed from this machine, which records the plan, its period end and its price.",
    )
  }
  return 0
}

/** `candle plan status [--json]`: plan, period end, auto-renew and the last x402 plan payment. */
export async function planStatus(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed || parsed.positionals.length !== 0) {
    writeUsageFailure(ctx.deps, "Usage: candle plan status [--json]", ctx.json)
    return 2
  }
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  const paths = pathsFor(ctx, apiKey ? ctx.profile : (ctx.profile ?? (await signupProfile(ctx))))
  const state = await readPlanState(paths)
  const live = apiKey ? await serverPlan(ctx, apiKey) : null
  let lastServer: Record<string, unknown> | null = null
  let paymentNote: string | undefined
  if (apiKey) {
    const payments = await apiRequest("/api/v1/agent/x402/payments?limit=50", {
      apiUrl: ctx.apiUrl,
      auth: "key",
      credentials: { apiKey },
      env: ctx.deps.env,
      fetch: ctx.deps.fetch,
    })
    if (!payments.ok && payments.status === 404) {
      paymentNote =
        "x402 payment history is not available yet on this Candle server; any payment shown is this machine's record."
    }
    if (payments.ok && isObject(payments.body) && Array.isArray(payments.body.payments)) {
      const found = payments.body.payments.find((p) => isObject(p) && p.kind === PLAN_SPEND_KIND)
      lastServer = isObject(found) ? found : null
    }
  }
  const local = foldSpendLog(await readSpendLog(paths))
    .filter((e) => e.kind === PLAN_SPEND_KIND)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  const now = ctx.deps.now()
  const periodEnd = state.periodEnd ?? (live?.tier === "max" ? live.maxUntil : null) ?? null
  const renewsFrom =
    state.autoRenew && state.periodEnd
      ? new Date(Date.parse(state.periodEnd) - AUTO_RENEW_WINDOW_MS).toISOString()
      : null
  const lastPayment = lastServer
    ? {
        source: "server",
        status: String(lastServer.status ?? ""),
        amountUsdc:
          typeof lastServer.amountUsdMicros === "string" && /^[0-9]+$/.test(lastServer.amountUsdMicros)
            ? usdcText(BigInt(lastServer.amountUsdMicros))
            : null,
        at: typeof lastServer.createdAt === "string" ? lastServer.createdAt : null,
        signature: typeof lastServer.signature === "string" ? lastServer.signature : null,
      }
    : local
      ? {
          source: "local",
          status: local.state,
          amountUsdc: usdcText(local.amountRaw),
          at: local.startedAt,
          signature: local.signature ?? null,
        }
      : null
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({
        ok: true,
        plan: live?.tier ?? state.plan ?? null,
        periodEnd,
        autoRenew: state.autoRenew,
        renewsFrom,
        payer: state.payer ?? null,
        lastPayment,
        unresolvedPayment: state.pending
          ? {
              id: state.pending.id,
              plan: state.pending.plan,
              amountUsdc: usdcText(BigInt(state.pending.amountRaw)),
              at: state.pending.startedAt,
            }
          : null,
        ...(apiKey ? {} : { note: "no API key on this profile; the plan shown is this machine's record" }),
        ...(paymentNote ? { note: paymentNote } : {}),
      })}\n`,
    )
    return 0
  }
  writeFields(
    ctx.deps,
    "stdout",
    [
      ["Plan", live?.tier ?? state.plan ?? undefined],
      ["Period ends", periodEnd ? formatTime(periodEnd, { now }) : undefined],
      ["Auto-renew", state.autoRenew ? (renewsFrom ? `on, from ${formatTime(renewsFrom, { now })}` : "on") : "off"],
      ["Pays from", state.payer],
      [
        "Last x402 payment",
        lastPayment
          ? `${lastPayment.amountUsdc ?? "?"} USDC, ${lastPayment.status}${lastPayment.at ? `, ${formatTime(lastPayment.at, { now })}` : ""}`
          : undefined,
      ],
    ],
    "Plan",
  )
  if (state.pending) {
    notice(
      ctx.deps,
      "stdout",
      "warning",
      `A plan payment of ${usdcText(BigInt(state.pending.amountRaw))} USDC is not resolved yet. Resume it with: candle plan ${state.pending.renew ? "renew" : `buy ${state.pending.plan}`} (it resends the same payment and never pays twice).`,
    )
  }
  if (!apiKey)
    notice(ctx.deps, "stdout", "note", "No API key on this profile: the plan shown is this machine's record.")
  if (paymentNote) notice(ctx.deps, "stdout", "note", paymentNote)
  return 0
}

/**
 * 6.3: before a command runs, renew when auto-renew is on and the period ends within 3 days. Quiet
 * unless it acts; never fails the command it runs in front of. Interactive only (the vault unlock is
 * a hidden prompt), and at most one attempt per 12 hours per profile, claimed under the state's lock
 * so two processes never both try.
 */
export async function maybeAutoRenew(word: string, ctx: CommandContext): Promise<void> {
  if (AUTO_RENEW_SKIPPED.has(word) || ctx.json) return
  if (!ctx.deps.isTTY.stdin || !ctx.deps.isTTY.stdout) return
  let paths: SpendPaths
  try {
    paths = pathsFor(ctx, ctx.profile)
    const state = await readPlanState(paths)
    const now = ctx.deps.now()
    if (!due(state, now)) return
    const claimed = await updatePlanState(paths, (s) =>
      due(s, now)
        ? { state: { ...s, lastRenewAttemptAt: new Date(now).toISOString() }, result: s }
        : { state: null, result: null },
    )
    if (!claimed?.plan || !claimed.payer) return
    // The command's stdout is its own: everything auto-renew says goes to stderr.
    const quiet: CommandContext = { ...ctx, json: false, deps: { ...ctx.deps, stdout: ctx.deps.stderr } }
    notice(
      quiet.deps,
      "stderr",
      "note",
      `Auto-renew: Candle ${planName(claimed.plan)} ends ${formatTime(claimed.periodEnd as string, { now })}. Renewing it now.`,
    )
    await runVaultCommand(quiet, () =>
      runPlanPayment(quiet, {
        mode: "auto",
        plan: claimed.plan as PaidPlanName,
        wallet: claimed.payer as string,
        yes: true,
        autoRenewFlag: false,
      }),
    )
  } catch (error) {
    const message = error instanceof VaultError || error instanceof Error ? error.message : String(error)
    notice(ctx.deps, "stderr", "note", `Auto-renew did not run: ${terminalText(message)}`)
  }
}

function due(state: PlanState, now: number): boolean {
  if (!state.autoRenew || !state.plan || !state.payer || !state.periodEnd || !state.renewCeilingRaw) return false
  if (state.pending) return false
  const end = Date.parse(state.periodEnd)
  if (!Number.isFinite(end) || now < end - AUTO_RENEW_WINDOW_MS || now >= end) return false
  const last = state.lastRenewAttemptAt ? Date.parse(state.lastRenewAttemptAt) : Number.NaN
  return !(Number.isFinite(last) && now - last < AUTO_RENEW_RETRY_MS)
}
