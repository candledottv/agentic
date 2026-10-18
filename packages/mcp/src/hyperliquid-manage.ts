/**
 * Hyperliquid phase 1 D (BE-1584, spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md,
 * sections 3, 6 and 8): the two multi-step management plans, post-open take-profit / stop-loss
 * changes and flatten, run the same way by every Candle surface.
 *
 * Neither is a new signer or a single venue action. Each step is one ordinary Candle build (a
 * targeted cancel, a reducing trigger, a reducing IOC close), checked by `verifyPerpsBuildAgainstVenue`
 * against this machine's own read of Hyperliquid, signed through the relay, submitted to
 * Hyperliquid from here, and judged on the venue's answer per leg. A step that is not confirmed
 * stops what depends on it; nothing is retried in a loop, no compensating order is ever placed, and
 * an incomplete plan is reported as incomplete with every confirmed effect and every remaining
 * target named.
 *
 * `packages/cli/src/hyperliquid-manage.ts` and `packages/mcp/src/hyperliquid-manage.ts` are
 * byte-identical copies of this file (drift tests enforce it). Its only import is `./hyperliquid`,
 * which is copied the same way.
 */
import {
  HYPERLIQUID_EXCHANGE_URLS,
  type HyperliquidNetwork,
  type HyperliquidSnapshotOrder,
  type HyperliquidTypedData,
  type HyperliquidWalletSnapshot,
  hyperliquidExchangeBody,
  hyperliquidExchangeOutcome,
  hyperliquidWalletSnapshot,
  type PerpsIntentMethod,
  snapshotPosition,
  verifyPerpsBuildAgainstVenue,
} from "./hyperliquid"

/** At most this many signed steps per invocation (spec D, section 8); the caller invokes again. */
export const PERPS_FLATTEN_MAX_STEPS = 100

export type PerpsStepStatus = "planned" | "built" | "submitted" | "confirmed" | "rejected" | "unknown" | "skipped"

/** One step of a plan, as it ended. `exchangeBody` is kept whenever a signature exists but did not settle. */
export interface PerpsWorkflowStep {
  step: number
  kind: "cancel" | "attach" | "close"
  coin: string
  leg?: "tp" | "sl"
  target: { oid: number; cloid: string | null } | null
  perpOrderId: string | null
  nonce: number | null
  /** The new order's cloid (an attach or a close), when it has one. */
  cloid: string | null
  status: PerpsStepStatus
  detail?: string
  signature?: string
  exchange?: unknown
  exchangeBody?: unknown
  /** A close: what the venue reports filled, and what of the planned size is left. */
  filledSz?: string
  remainingSz?: string
}

export interface PerpsWorkflowResult {
  operation: "tpsl" | "flatten"
  walletId: string
  address: string
  network: HyperliquidNetwork
  /** Epoch ms of the last venue read this result rests on. */
  readAt: number
  /** True only when every step settled as planned and, for flatten, a final read showed nothing left. */
  complete: boolean
  steps: PerpsWorkflowStep[]
  /** What is still open: targets not acted on, positions not closed, legs not placed. */
  remaining: Record<string, unknown>[]
  warnings: string[]
  /** Flatten reaches Hyperliquid's main perp exchange only. */
  scope?: "main-perps"
  /** Take-profit / stop-loss legs on the venue that Candle did not build: listed, never touched. */
  unowned?: { leg: "tp" | "sl"; oid: number; cloid: string | null; triggerPx: string | null }[]
}

/** A refusal before anything was signed: the plan could not be made safely. */
export class PerpsWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>

/**
 * What a surface supplies. `build` posts one Candle build and returns its body, or throws an Error
 * carrying the Candle `code`; `read` gets one Candle read. `sign` asks the relay for one signature.
 * `confirm` sees the whole plan once, before the first signature; a surface whose caller already
 * expressed intent (an SDK or MCP call) passes none, and never invents a prompt.
 */
export interface PerpsWorkflowIo {
  network: HyperliquidNetwork
  walletId: string
  address: string
  builder: string
  keyReduceOnly: boolean
  fetcher: Fetcher
  now: () => number
  build(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
  read(path: string): Promise<Record<string, unknown>>
  sign(typedData: HyperliquidTypedData): Promise<string>
  /** `no-submit` builds and checks the first step only; `sign-only` signs the first step only. */
  mode: "submit" | "no-submit" | "sign-only"
  confirm?(plan: { steps: PerpsWorkflowStep[]; warnings: string[] }): Promise<boolean>
  /** A random 16-byte cloid. */
  cloid(): string
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  return typeof code === "string" ? code : "REQUEST_FAILED"
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Build, check against the venue, sign and submit one step, recording how it ended. True when confirmed. */
async function runStep(
  io: PerpsWorkflowIo,
  step: PerpsWorkflowStep,
  path: string,
  body: Record<string, unknown>,
  intent: { method: PerpsIntentMethod; params: Record<string, unknown> },
): Promise<boolean> {
  let build: Record<string, unknown>
  try {
    build = await io.build(path, { walletId: io.walletId, ...body })
  } catch (err) {
    step.status = "rejected"
    step.detail = `${errorCode(err)}: ${errorText(err)}`
    return false
  }
  if (build.replayed === true) {
    step.status = "skipped"
    step.detail = "This client id already names an operation; nothing was signed"
    return false
  }
  step.perpOrderId = typeof build.perpOrderId === "string" ? build.perpOrderId : null
  step.nonce = typeof build.nonce === "number" ? build.nonce : null
  if (typeof build.cloid === "string") step.cloid = build.cloid
  const check = await verifyPerpsBuildAgainstVenue(build as never, {
    builder: io.builder,
    network: io.network,
    address: io.address,
    intent,
    fetcher: io.fetcher,
    now: io.now,
    keyReduceOnly: io.keyReduceOnly,
  })
  if (!check.ok) {
    step.status = "rejected"
    step.detail = `Refused to sign this build: ${check.reason}. Nothing was signed.`
    return false
  }
  step.status = "built"
  if (io.mode === "no-submit") return false
  let signature: string
  try {
    signature = await io.sign(build.typedData as HyperliquidTypedData)
  } catch (err) {
    step.status = "rejected"
    step.detail = `The relay did not sign (${errorCode(err)}: ${errorText(err)}). Nothing was submitted.`
    return false
  }
  step.signature = signature
  const exchangeBody = hyperliquidExchangeBody(
    build.action as Record<string, unknown>,
    build.nonce as number,
    signature,
  )
  if (io.mode === "sign-only") {
    step.exchangeBody = exchangeBody
    return false
  }
  let exchange: unknown
  try {
    const res = await io.fetcher(HYPERLIQUID_EXCHANGE_URLS[io.network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchangeBody),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status ?? "error"}${res.status === 429 ? " (rate limited)" : ""}`)
    exchange = JSON.parse(text)
  } catch (err) {
    // Signed but not known to have landed: kept for recovery, never broadcast again automatically.
    step.status = "unknown"
    step.detail = `Signed, but the submit to Hyperliquid did not answer (${errorText(err)}). Reconcile before acting again.`
    step.exchangeBody = exchangeBody
    return false
  }
  step.exchange = exchange
  const outcome = hyperliquidExchangeOutcome(exchange)
  if (outcome.status === "confirmed") {
    step.status = "confirmed"
    return true
  }
  step.status = outcome.status
  step.detail = outcome.error
  if (outcome.status === "unknown") step.exchangeBody = exchangeBody
  return false
}

function blankStep(n: number, kind: PerpsWorkflowStep["kind"], coin: string, extra: Partial<PerpsWorkflowStep> = {}) {
  return {
    step: n,
    kind,
    coin,
    target: null,
    perpOrderId: null,
    nonce: null,
    cloid: null,
    status: "planned",
    ...extra,
  } as PerpsWorkflowStep
}

// ── Take-profit / stop-loss (spec D, section 6) ──────────────────────────────────────────

export interface PerpsTpslParams {
  coin: string
  takeProfit?: string
  stopLoss?: string
  removeTp?: boolean
  removeSl?: boolean
  /** Which tracked leg to change or remove when more than one matches. */
  targetTp?: string
  targetSl?: string
}

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const CLOID_RE = /^0x[0-9a-f]{32}$/

/** Why a TP/SL request cannot be planned, before anything is read, or null. */
export function perpsTpslParamsProblem(p: PerpsTpslParams): string | null {
  if (typeof p.coin !== "string" || !/^[A-Za-z0-9]{1,20}$/.test(p.coin)) return "coin must be a market name"
  for (const [field, value] of [
    ["takeProfit", p.takeProfit],
    ["stopLoss", p.stopLoss],
  ] as const)
    if (value !== undefined && (typeof value !== "string" || !DECIMAL_RE.test(value) || /^0+(\.0+)?$/.test(value)))
      return `${field} must be a positive decimal`
  if (p.takeProfit !== undefined && p.removeTp) return "cannot set and remove the take-profit together"
  if (p.stopLoss !== undefined && p.removeSl) return "cannot set and remove the stop-loss together"
  if (p.takeProfit === undefined && p.stopLoss === undefined && !p.removeTp && !p.removeSl)
    return "name at least one change: a take-profit, a stop-loss, or a removal"
  for (const [field, value] of [
    ["targetTp", p.targetTp],
    ["targetSl", p.targetSl],
  ] as const)
    if (value !== undefined && (typeof value !== "string" || !CLOID_RE.test(value.toLowerCase())))
      return `${field} must be 0x followed by 32 hex digits`
  if (p.targetTp !== undefined && p.takeProfit === undefined && !p.removeTp)
    return "targetTp needs a take-profit change"
  if (p.targetSl !== undefined && p.stopLoss === undefined && !p.removeSl) return "targetSl needs a stop-loss change"
  return null
}

interface TrackedLeg {
  leg: "tp" | "sl"
  oid: number
  cloid: string | null
  triggerPx: string | null
}

function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  const norm = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v).replace(/^0+(?=\d)/, "")
  return norm(a) === norm(b)
}

/**
 * Attach, change or remove the coin's take-profit and stop-loss. A change is explicit
 * cancel-and-replace: the old leg is canceled and seen gone, the position and mark are read again,
 * and only then is the new leg built; the protection gap between is named in the warnings. A cancel
 * that is not confirmed places no replacement; a replacement that fails leaves the old leg canceled
 * and the result incomplete. Omitting a leg never touches it. Legs Candle did not build are listed
 * and never overwritten; several matching tracked legs need an explicit target.
 */
export async function runPerpsTpsl(io: PerpsWorkflowIo, params: PerpsTpslParams): Promise<PerpsWorkflowResult> {
  const problem = perpsTpslParamsProblem(params)
  if (problem) throw new PerpsWorkflowError("VALIDATION_FAILED", problem)
  const coinQuery = encodeURIComponent(params.coin)
  const server = await io.read(`/api/v1/agent/perps/tpsl?walletId=${encodeURIComponent(io.walletId)}&coin=${coinQuery}`)
  let snapshot: HyperliquidWalletSnapshot
  try {
    snapshot = await hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now)
  } catch (err) {
    throw new PerpsWorkflowError("PERPS_UNAVAILABLE", `Cannot read the account from Hyperliquid: ${errorText(err)}`)
  }
  const coin = typeof server.coin === "string" ? server.coin : params.coin.toUpperCase()
  // Candle names which legs it built; this machine's own venue read decides which of them are open.
  const venueLegs = snapshot.orders.filter((o) => o.coin === coin && o.tpsl !== null)
  const tracked: TrackedLeg[] = []
  for (const raw of (Array.isArray(server.tracked) ? server.tracked : []) as TrackedLeg[]) {
    const seen = venueLegs.find(
      (o) => o.oid === raw.oid && o.tpsl === raw.leg && (o.cloid ?? null) === (raw.cloid ?? null),
    )
    if (seen) tracked.push({ leg: raw.leg, oid: seen.oid, cloid: seen.cloid, triggerPx: seen.triggerPx })
  }
  const trackedOids = new Set(tracked.map((l) => l.oid))
  const unowned = venueLegs
    .filter((o) => !trackedOids.has(o.oid))
    .map((o) => ({ leg: o.tpsl as "tp" | "sl", oid: o.oid, cloid: o.cloid, triggerPx: o.triggerPx }))
  const position = snapshotPosition(snapshot, coin)
  const warnings: string[] = []
  if (unowned.length > 0)
    warnings.push(
      `${unowned.length} take-profit / stop-loss leg(s) on ${coin} were not built by Candle; they are left untouched.`,
    )

  const steps: PerpsWorkflowStep[] = []
  const plans: {
    leg: "tp" | "sl"
    cancel: PerpsWorkflowStep | null
    attach: PerpsWorkflowStep | null
    triggerPx?: string
  }[] = []
  for (const leg of ["tp", "sl"] as const) {
    const set = leg === "tp" ? params.takeProfit : params.stopLoss
    const remove = leg === "tp" ? params.removeTp === true : params.removeSl === true
    if (set === undefined && !remove) continue
    const target = (leg === "tp" ? params.targetTp : params.targetSl)?.toLowerCase()
    let legs = tracked.filter((l) => l.leg === leg)
    if (target !== undefined) {
      legs = legs.filter((l) => l.cloid === target)
      if (legs.length === 0)
        throw new PerpsWorkflowError(
          "PERPS_ORDER_NOT_FOUND",
          `No open ${coin} ${leg} leg Candle built carries ${target}`,
        )
    }
    if (legs.length > 1)
      throw new PerpsWorkflowError(
        "PERPS_TPSL_CONFLICT",
        `${legs.length} ${coin} ${leg === "tp" ? "take-profit" : "stop-loss"} legs match; name one with --target-${leg} <cloid>`,
        { candidates: legs },
      )
    const existing = legs[0] ?? null
    if (set !== undefined && existing && sameDecimal(existing.triggerPx, set)) {
      steps.push(
        blankStep(steps.length, "attach", coin, {
          leg,
          target: { oid: existing.oid, cloid: existing.cloid },
          status: "skipped",
          detail: "Already in place at this trigger",
        }),
      )
      continue
    }
    if (set !== undefined && !position)
      throw new PerpsWorkflowError("PERPS_NO_POSITION", `No ${coin} position on Hyperliquid to protect`)
    if (remove && !existing) {
      steps.push(
        blankStep(steps.length, "cancel", coin, { leg, status: "skipped", detail: "No tracked leg to remove" }),
      )
      continue
    }
    const cancel = existing
      ? blankStep(steps.length, "cancel", coin, { leg, target: { oid: existing.oid, cloid: existing.cloid } })
      : null
    if (cancel) steps.push(cancel)
    const attach = set !== undefined ? blankStep(steps.length, "attach", coin, { leg }) : null
    if (attach) steps.push(attach)
    if (cancel && attach)
      warnings.push(
        `Changing the ${leg === "tp" ? "take-profit" : "stop-loss"} cancels the current leg first: ${coin} is unprotected on that side until the new one is placed.`,
      )
    if (cancel && !attach)
      warnings.push(`Removing the ${leg === "tp" ? "take-profit" : "stop-loss"} leaves ${coin} without it.`)
    plans.push({ leg, cancel, attach, ...(set !== undefined ? { triggerPx: set } : {}) })
  }
  if (plans.some((p) => p.attach))
    warnings.push(
      "New legs are sized to the position now and do not grow with later additions; triggering does not guarantee a fill.",
    )

  const result: PerpsWorkflowResult = {
    operation: "tpsl",
    walletId: io.walletId,
    address: io.address,
    network: io.network,
    readAt: snapshot.readAt,
    complete: false,
    steps,
    remaining: [],
    warnings,
    unowned,
  }
  const active = steps.filter((s) => s.status === "planned")
  if (active.length === 0) {
    result.complete = true
    return result
  }
  if (io.mode !== "no-submit" && io.confirm && !(await io.confirm({ steps, warnings })))
    throw new PerpsWorkflowError("CANCELLED", "Nothing was signed.")

  const workflowId = `tpsl-${io.cloid().slice(2, 18)}`
  let stopped = false
  for (const plan of plans) {
    if (stopped) break
    if (plan.cancel) {
      const step = plan.cancel
      const ok = await runStep(
        io,
        step,
        "/api/v1/agent/perps/tpsl",
        {
          coin,
          operation: "cancel",
          leg: plan.leg,
          ...(step.target?.cloid ? { targetCloid: step.target.cloid } : {}),
          workflowId,
          workflowStep: step.step,
        },
        { method: "cancel", params: { coin, oid: step.target?.oid } },
      )
      if (!ok) {
        stopped = true
        break
      }
      // Seen gone before anything replaces it.
      try {
        const after = await hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now)
        result.readAt = after.readAt
        if (after.orders.some((o) => o.oid === step.target?.oid)) {
          step.status = "unknown"
          step.detail = "Hyperliquid accepted the cancel but still shows the leg open; no replacement was placed"
          stopped = true
          break
        }
        if (plan.attach && !snapshotPosition(after, coin)) {
          plan.attach.status = "skipped"
          plan.attach.detail = "The position closed meanwhile; no replacement was placed"
          continue
        }
      } catch (err) {
        step.detail = `Canceled, but the follow-up read failed (${errorText(err)}); no replacement was placed`
        stopped = true
        break
      }
    }
    if (plan.attach) {
      const ok = await runStep(
        io,
        plan.attach,
        "/api/v1/agent/perps/tpsl",
        {
          coin,
          operation: "attach",
          leg: plan.leg,
          triggerPx: plan.triggerPx,
          workflowId,
          workflowStep: plan.attach.step,
        },
        { method: "tpsl", params: { coin, leg: plan.leg, triggerPx: plan.triggerPx } },
      )
      if (!ok) stopped = true
    }
  }
  for (const s of steps) {
    if (s.status === "planned") result.remaining.push({ step: s.step, kind: s.kind, leg: s.leg, coin })
    if (
      s.kind === "cancel" &&
      s.status === "confirmed" &&
      plans.find((p) => p.cancel === s)?.attach?.status !== "confirmed"
    )
      result.remaining.push({ leg: s.leg, coin, state: "old leg canceled, no new leg in place" })
  }
  result.complete = steps.every((s) => s.status === "confirmed" || s.status === "skipped") && !stopped
  return result
}

// ── Flatten (spec D, section 8) ────────────────────────────────────────────────────────

function orderTarget(o: HyperliquidSnapshotOrder) {
  return { oid: o.oid, cloid: o.cloid }
}

function snapshotOrError(io: PerpsWorkflowIo): Promise<HyperliquidWalletSnapshot> {
  return hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now)
}

/**
 * Cancel every open main-perp order on the wallet (triggers and reducing orders included), then
 * close every main-perp position with a full reducing IOC, re-reading before each close, then read
 * again. `complete` only when that final read shows no position and no order. Bounded at
 * `PERPS_FLATTEN_MAX_STEPS` signed steps; stops on an unknown submit, a rate limit or a failed
 * cancel; continues past a known close rejection. An observed snapshot, not a guarantee against
 * another client opening exposure afterwards, and never the whole wallet: spot, HIP-3 and vaults are
 * out of scope.
 */
export async function runPerpsFlatten(io: PerpsWorkflowIo): Promise<PerpsWorkflowResult> {
  let snapshot: HyperliquidWalletSnapshot
  try {
    snapshot = await snapshotOrError(io)
  } catch (err) {
    throw new PerpsWorkflowError("PERPS_UNAVAILABLE", `Cannot read the account from Hyperliquid: ${errorText(err)}`)
  }
  if (snapshot.unsupported.length > 0)
    throw new PerpsWorkflowError(
      "PERPS_MARKET_REFUSED",
      `Flatten reaches Hyperliquid's main perp exchange only, and this wallet holds rows it cannot classify there: ${snapshot.unsupported.slice(0, 5).join(", ")}. Nothing was built.`,
      { unsupported: snapshot.unsupported },
    )
  const warnings = [
    "Scope: Hyperliquid's main perp exchange only. Spot, HIP-3 and vault exposure is not read or closed.",
    "Every open order is canceled first, take-profit and stop-loss protection included.",
    "The final state is an observed snapshot; another client can open exposure afterwards.",
  ]
  const steps: PerpsWorkflowStep[] = []
  for (const o of snapshot.orders) steps.push(blankStep(steps.length, "cancel", o.coin, { target: orderTarget(o) }))
  const closeIds = new Map<string, string>()
  for (const p of snapshot.positions) {
    const id = io.cloid()
    closeIds.set(p.coin, id)
    steps.push(blankStep(steps.length, "close", p.coin, { cloid: id }))
  }
  const result: PerpsWorkflowResult = {
    operation: "flatten",
    walletId: io.walletId,
    address: io.address,
    network: io.network,
    readAt: snapshot.readAt,
    complete: false,
    steps,
    remaining: [],
    warnings,
    scope: "main-perps",
  }
  if (steps.length === 0) {
    result.complete = true
    return result
  }
  if (steps.length > PERPS_FLATTEN_MAX_STEPS)
    warnings.push(
      `${steps.length} steps planned; this run signs at most ${PERPS_FLATTEN_MAX_STEPS} and reports the rest as remaining. Run flatten again.`,
    )
  if (io.mode !== "no-submit" && io.confirm && !(await io.confirm({ steps, warnings })))
    throw new PerpsWorkflowError("CANCELLED", "Nothing was signed.")

  const workflowId = `flat-${io.cloid().slice(2, 18)}`
  const cancelStep = (step: PerpsWorkflowStep) =>
    runStep(
      io,
      step,
      "/api/v1/agent/perps/flatten/cancel",
      { coin: step.coin, oid: step.target?.oid, workflowId, workflowStep: step.step },
      { method: "cancel", params: { coin: step.coin, oid: step.target?.oid } },
    )
  const closeStep = (step: PerpsWorkflowStep) => {
    const clientId = closeIds.get(step.coin) as string
    return runStep(
      io,
      step,
      "/api/v1/agent/perps/close",
      { coin: step.coin, clientId, workflowId, workflowStep: step.step },
      { method: "close", params: { coin: step.coin, clientId } },
    )
  }
  if (io.mode !== "submit") {
    // `--no-submit` builds and checks the first step; `--sign-only` signs it. Nothing later is built
    // against a snapshot the first step would make obsolete.
    const first = steps[0] as PerpsWorkflowStep
    await (first.kind === "cancel" ? cancelStep(first) : closeStep(first))
    for (const s of steps)
      if (s.status === "planned") result.remaining.push({ step: s.step, kind: s.kind, coin: s.coin, target: s.target })
    return result
  }
  let signed = 0
  let stopped = false
  const budgetLeft = () => signed < PERPS_FLATTEN_MAX_STEPS
  for (const step of steps.filter((s) => s.kind === "cancel")) {
    if (stopped || !budgetLeft()) break
    signed++
    if (await cancelStep(step)) continue
    // A target already gone (filled or canceled meanwhile) is not a failure.
    if (step.status === "rejected" && step.detail?.startsWith("PERPS_ORDER_NOT_OPEN")) {
      step.status = "skipped"
      continue
    }
    // A cancel that failed or did not answer could leave an order that still adds exposure: stop.
    stopped = true
  }
  if (!stopped && budgetLeft()) {
    let after: HyperliquidWalletSnapshot | null = null
    try {
      after = await snapshotOrError(io)
      result.readAt = after.readAt
    } catch (err) {
      warnings.push(`The read after the cancels failed (${errorText(err)}); no position was closed.`)
      stopped = true
    }
    if (after) {
      const fresh = after.orders.filter((o) => !steps.some((s) => s.kind === "cancel" && s.target?.oid === o.oid))
      if (fresh.length > 0)
        warnings.push(`${fresh.length} order(s) appeared during the cancels and were not part of this run's plan.`)
      // Positions that exist now but were not in the first read are closed too, under new ids.
      for (const p of after.positions)
        if (!closeIds.has(p.coin)) {
          const id = io.cloid()
          closeIds.set(p.coin, id)
          steps.push(blankStep(steps.length, "close", p.coin, { cloid: id }))
        }
      for (const step of steps.filter((s) => s.kind === "close")) {
        if (stopped || !budgetLeft()) break
        // Re-read immediately before each close: no size or side comes from the plan.
        let now: HyperliquidWalletSnapshot
        try {
          now = await snapshotOrError(io)
          result.readAt = now.readAt
        } catch (err) {
          step.detail = `The read before this close failed (${errorText(err)})`
          stopped = true
          break
        }
        const held = snapshotPosition(now, step.coin)
        if (!held) {
          step.status = "skipped"
          step.detail = "No position left to close"
          continue
        }
        signed++
        if (await closeStep(step)) {
          const leg = (step.exchange as { response?: { data?: { statuses?: unknown[] } } })?.response?.data
            ?.statuses?.[0] as { filled?: { totalSz?: unknown } } | undefined
          const filled = typeof leg?.filled?.totalSz === "string" ? leg.filled.totalSz : null
          const planned = held.szi.replace(/^-/, "")
          if (filled !== null) {
            step.filledSz = filled
            if (!sameDecimal(filled, planned)) {
              step.remainingSz = `${planned} planned, ${filled} filled`
              step.detail = "Partly filled; the rest of the position is still open"
            }
          }
          continue
        }
        // A known rejection: keep closing the others. Unknown or a rate limit: stop.
        if (step.status !== "rejected" || /429|rate limit/i.test(step.detail ?? "")) stopped = true
      }
    }
  }
  // The final read decides completion; a failed read is never success.
  let final: HyperliquidWalletSnapshot | null = null
  try {
    final = await snapshotOrError(io)
    result.readAt = final.readAt
  } catch (err) {
    warnings.push(`The final read failed (${errorText(err)}); the outcome is not known.`)
  }
  for (const s of steps)
    if (s.status === "planned") result.remaining.push({ step: s.step, kind: s.kind, coin: s.coin, target: s.target })
  if (final) {
    for (const p of final.positions) result.remaining.push({ kind: "position", coin: p.coin, szi: p.szi })
    for (const o of final.orders) result.remaining.push({ kind: "order", coin: o.coin, oid: o.oid })
  }
  result.complete =
    final !== null &&
    final.positions.length === 0 &&
    final.orders.length === 0 &&
    final.unsupported.length === 0 &&
    !stopped &&
    steps.every((s) => s.status === "confirmed" || s.status === "skipped")
  return result
}
