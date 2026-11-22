/**
 * Hood holder exits (BE-3794, card E of the BE-3630 design,
 * `docs/superpowers/specs/2026-11-18-hood-gen2-holder-exits-design.md` section 6.1): the types the
 * holder-exit routes answer with, and the one error they throw.
 *
 *   GET  /api/v1/hood/curves/{curve}/holder-exit?account=   `getHolderExit`     public read
 *   GET  /api/v1/hood/holder-exits?account=                 `getHolderExits`    public read
 *   POST /api/v1/hood/curves/{curve}/holder-exit/build      `buildHolderExit`   unsigned calls, holder-signed
 *   POST /api/v1/hood/curves/{curve}/holder-exit/record     `recordHolderExit`  proves a sent exit
 *   POST /api/v1/agent/hood/holder-exit/{curve}             `holderExit`        agent key, Candle signs
 *   POST /api/v1/agent/hood/holder-exit/{curve}/submit      `submitHolderExit`  linked wallet's signed bytes
 *
 * The SDK derives nothing: `holderExit.state`, `actions` and `disclosure` are the API's, and a
 * surface shows `disclosure` verbatim. It encodes no calldata either: every call comes from the
 * API's builder, which only ever returns `curve.enterRecovery()`, `base.approve(curve, amount)`,
 * `curve.claimRecovery(amount)` or `curve.teamEscrow().claim()`. No request has a destination field.
 *
 * All amounts are raw integer strings in the token's smallest unit.
 */
import { CandleApiError } from "./errors"

export type HolderExitState =
  | "none"
  | "awaiting_migration"
  | "recovery_open"
  | "recovery"
  | "rescue_pending"
  | "rescued"

export type HolderExitAction = "enter_recovery" | "claim_recovery" | "claim_team"

/** Where a holder of one Hood curve stands if the launch does not migrate. The API's derivation, as sent. */
export interface HolderExit {
  generation: 1 | 2
  state: HolderExitState
  lifecycle: "trading" | "graduated" | "migrated" | "recovery"
  /** When Recovery may be entered (creator after 7 days, anyone after 30). Null while trading. Unix seconds as strings. */
  recoveryWindow: {
    creatorMayEnterAt: string
    anyoneMayEnterAt: string
    creatorMayEnterNow: boolean
    anyoneMayEnterNow: boolean
    secondsUntilPermissionlessExit: string
  } | null
  /** The fixed Recovery rate and progress. Recovery pays by tokens held, not by cost. */
  recovery: {
    quoteToken: string
    quoteDecimals: number
    reserveSnapshotRaw: string
    eligibleSupplyRaw: string
    surrenderedRaw: string
    remainingRaw: string
    /** Quote raw units per 10^baseDecimals base raw units, floored. Display only. */
    ratePerTokenRaw: string
    paysBy: "tokens_held"
  } | null
  /** A rescue request on a generation 2 curve. `valid: false` is a void request that cannot execute. */
  rescue: {
    to: string
    executableAt: string
    executableNow: boolean
    valid: boolean
    voidReason: "quote_readmitted" | "superseded_by_new_denial" | "curve_migrated" | null
    rescuedAmountRaw?: string
    rescuedTx?: string
  } | null
  /** The generation 2 team vesting escrow, when the launch locked a team allocation. */
  team: {
    escrow: string
    recipient: string
    amountRaw: string
    startTime: string
    cliffTime: string
    vestingDays: number
    vestedRaw: string
    claimedRaw: string
    claimableRaw: string
    status: "before_cliff" | "vesting_locked_until_migration" | "claimable" | "fully_claimed" | "stranded"
  } | null
  /** Present when the read named an account. */
  account?: {
    address: string
    baseBalanceRaw: string
    allowanceToCurveRaw: string
    /** What a Recovery claim of the whole balance pays now; "0" outside `recovery`. */
    recoveryQuoteOutRaw: string
    mayEnterRecoveryNow: boolean
    isTeamRecipient: boolean
  }
  /** Only what would succeed now (for `account` when given). */
  actions: HolderExitAction[]
  /** One plain sentence for this state. Show it verbatim before acting. */
  disclosure: string
}

/** `getHolderExit`: one curve, optionally for one account. */
export interface HolderExitRead {
  curve: string
  /** The curve's base token (the registry's record). */
  token: string
  holderExit: HolderExit
}

/** `getHolderExits`: the account's open exits across Hood curves. */
export interface HolderExitList {
  account: string
  exits: Array<{ curve: string; holderExit: HolderExit }>
  /** Curves whose read failed and are left out. More than zero means the list may be short. */
  unavailableCount: number
}

export interface HolderExitBuildRequest {
  curve: string
  /** The wallet that will sign and send the calls. */
  account: string
  action: HolderExitAction
  /** `claim_recovery` only: base raw units to redeem. Defaults to the whole balance, clamped to what is left. */
  amountRaw?: string
}

/** One unsigned call. Send them in order, each after the previous one confirmed. */
export interface HolderExitCall {
  kind: "approve" | "enter_recovery" | "claim_recovery" | "claim_team"
  to: string
  data: string
  value: "0"
  /** Buffered gas limit. */
  gas: string
  gasEstimated: boolean
}

/** `buildHolderExit`: the calls for the holder's own wallet to sign. Nothing was signed. */
export interface HolderExitBuild {
  curve: string
  account: string
  action: HolderExitAction
  generation: 1 | 2
  blockNumber: string
  calls: HolderExitCall[]
  /** claim_recovery: the base amount burned, after the clamp. */
  amountRaw?: string
  /** claim_recovery: what the contract pays for `amountRaw`. */
  expectedQuoteOutRaw?: string
  quoteToken?: string
  quoteDecimals?: number
  /** claim_team: what the escrow pays, always to its recipient. */
  expectedBaseOutRaw?: string
  recipient?: string
  gasCost: { maxFeePerGas: string; maxPriorityFeePerGas: string; requiredWei: string; balanceWei: string }
  holderExit: HolderExit
}

export interface HolderExitRecordRequest {
  curve: string
  account: string
  txHash: string
}

interface HolderExitRecordedCommon {
  txHash: string
  logIndex: number
  blockNumber: string
  curve: string
  generation: 1 | 2
  emitter: string
  account: string
  baseToken: string
  quoteToken: string
}

export type HolderExitRecordedExit =
  | (HolderExitRecordedCommon & { kind: "recovery_entered"; redeemableReserveRaw: string; eligibleSupplyRaw: string })
  | (HolderExitRecordedCommon & { kind: "recovery_claim"; baseBurnedRaw: string; quotePaidRaw: string })
  | (HolderExitRecordedCommon & { kind: "vesting_claim"; vestingAmountRaw: string })

/** `recordHolderExit`: the exit proved from its receipt. `duplicate` means it was already recorded. */
export interface HolderExitRecord {
  recorded: "booked" | "duplicate"
  curve: string
  account: string
  generation: 1 | 2
  exit: HolderExitRecordedExit
}

export interface AgentHolderExitRequest {
  curve: string
  action: HolderExitAction
  /** `claim_recovery` only. Defaults to the whole balance. */
  amountRaw?: string
  /** Build and simulate, sign nothing. */
  dryRun?: boolean
  /** A wallet of this account other than the embedded Hood wallet. A linked wallet also needs `linkedSigning`. */
  wallet?: string
  /** The linked wallet signs for itself: the answer carries `signing[]` and a `claimToken` for `submitHolderExit`. */
  linkedSigning?: boolean
}

export interface AgentHolderExitSubmitRequest {
  curve: string
  action: HolderExitAction
  wallet: string
  walletId: string
  claimToken: string
  /** The `signing[]` transactions, signed by the wallet, in order. */
  signedTransactions: string[]
}

export type HolderExitCallStatus = "not_sent" | "submitted_unknown" | "confirmed" | "reverted"
/** `complete` only when every call confirmed. An approval that landed with a claim that did not is `partial`. */
export type HolderExitOutcome = "not_started" | "complete" | "partial" | "failed" | "indeterminate"

export interface AgentHolderExitCallResult {
  kind: HolderExitCall["kind"]
  to: string
  status: HolderExitCallStatus
  txHash: string | null
  recorded?: "booked" | "duplicate" | "not_recorded"
}

/** A linked wallet's transaction to sign with its own key. */
export interface HolderExitSigning {
  kind: HolderExitCall["kind"]
  unsignedTransaction: string
  to: string
  data: string
  value: "0"
  chainId: number
  nonce: number
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}

/**
 * `holderExit` and `submitHolderExit`. A 2xx answer only: a refusal, or a sequence that did not
 * complete, throws `HolderExitError` carrying `outcome`, `calls` and `warnings`.
 */
export interface AgentHolderExitResult {
  success: true
  curve: string
  action: HolderExitAction
  wallet: string
  signer: "embedded" | "linked"
  dryRun: boolean
  /** The build behind the calls. Absent on `/submit`. */
  build?: HolderExitBuild
  /** `dryRun` only: whether a real run could sign for this wallet, and why not. */
  signable?: boolean
  reason?: string
  outcome: HolderExitOutcome
  calls: AgentHolderExitCallResult[]
  warnings?: string[]
  /** Linked signing only. */
  walletId?: string
  claimToken?: string
  signing?: HolderExitSigning[]
}

/**
 * Every refusal from the holder-exit routes. `code` is the API's (`HOOD_RECOVERY_NOT_READY`,
 * `HOOD_VESTING_STRANDED`, `HOOD_EXIT_FAILED`, ...). `details` carries the refusal's figures (for
 * `HOOD_RECOVERY_NOT_READY`, `creatorMayEnterAt` and `anyoneMayEnterAt`). On the agent route a
 * sequence that started and did not complete also carries `outcome`, `calls` and `warnings`: an
 * `outcome` of `partial` means an approval landed and the claim did not; build again.
 */
export class HolderExitError extends CandleApiError {
  readonly details?: Record<string, string>
  readonly outcome?: HolderExitOutcome
  readonly calls?: AgentHolderExitCallResult[]
  readonly warnings?: string[]
  /** The response body as sent, for logging. */
  readonly body: unknown

  constructor(args: {
    code: string
    message: string
    status: number
    retryable: boolean
    stage?: string
    reason?: string
    details?: Record<string, string>
    outcome?: HolderExitOutcome
    calls?: AgentHolderExitCallResult[]
    warnings?: string[]
    body: unknown
    requestId?: string
  }) {
    super({
      ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      code: args.code,
      message: args.message,
      status: args.status,
      retryable: args.retryable,
      ...(args.stage !== undefined ? { stage: args.stage } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    })
    this.name = "HolderExitError"
    if (args.details !== undefined) this.details = args.details
    if (args.outcome !== undefined) this.outcome = args.outcome
    if (args.calls !== undefined) this.calls = args.calls
    if (args.warnings !== undefined) this.warnings = args.warnings
    this.body = args.body
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry
  return out
}

/**
 * The holder-exit routes answer refusals in three shapes, all read here:
 *   - agent route: `{ success: false, error: { code, message, retryable, stage?, details?, reason? }, outcome?, calls?, warnings? }`;
 *   - build and record: `{ success: false, error: "<message>", code, retryable, details? }`;
 *   - the reads: `{ error: true, code?, payload: "<message>" }`.
 * Anything else is `HTTP_<status>` with the text as the message.
 */
export function holderExitErrorFromResponse(status: number, text: string, requestId?: string): HolderExitError {
  const rid = requestId !== undefined ? { requestId } : {}
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const fallback = { code: `HTTP_${status}`, message: text || `HTTP ${status}`, status, retryable: false, body, ...rid }
  if (!isObject(body)) return new HolderExitError(fallback)
  const top = body
  const sequence = {
    ...(typeof top.outcome === "string" ? { outcome: top.outcome as HolderExitOutcome } : {}),
    ...(Array.isArray(top.calls) ? { calls: top.calls as AgentHolderExitCallResult[] } : {}),
    ...(Array.isArray(top.warnings)
      ? { warnings: top.warnings.filter((w): w is string => typeof w === "string") }
      : {}),
  }
  if (isObject(top.error) && typeof top.error.code === "string" && typeof top.error.message === "string") {
    const error = top.error
    const details = stringRecord(error.details)
    return new HolderExitError({
      code: error.code as string,
      message: error.message as string,
      status,
      retryable: error.retryable === true,
      ...(typeof error.stage === "string" ? { stage: error.stage } : {}),
      ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
      ...(details ? { details } : {}),
      ...sequence,
      body,
      ...rid,
    })
  }
  if (top.success === false && typeof top.error === "string" && typeof top.code === "string") {
    const details = stringRecord(top.details)
    return new HolderExitError({
      code: top.code,
      message: top.error,
      status,
      retryable: top.retryable === true,
      ...(details ? { details } : {}),
      body,
      ...rid,
    })
  }
  if (top.error === true && typeof top.payload === "string") {
    return new HolderExitError({
      code: typeof top.code === "string" ? top.code : `HTTP_${status}`,
      message: top.payload,
      status,
      retryable: status === 503 || status === 429,
      body,
      ...rid,
    })
  }
  return new HolderExitError(fallback)
}
