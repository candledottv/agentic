/**
 * Approval cards and their execution (BE-1665, spec K-2 to K-9).
 *
 * A card is one live money action a client wants, bound by hash to the exact parameters that will
 * be sent. Only a view may approve it, with a vault factor (or inside a timed window the kind
 * allows), and only for the hash it drew. The operation id is fixed when the card is created and
 * never changes: it rides in the tool's own id field (`classify.ts`), so a re-send can never become
 * a second write. Execution is write-ahead (K-7): the operation's `submitting` row is on disk before
 * the request leaves, which is what lets reconciliation (R) find an interrupted call.
 *
 * Reconciliation (R) lives here too: a lost answer is read back by its id at once and polled while
 * pending; an operation the core cannot confirm raises a reconcile card the user resolves (check,
 * re-send under the same id, or stop tracking; D2 default A, never an automatic re-send); and the
 * book is rebuilt from the journal at start, where every operation still in flight becomes
 * `unknown` before any client can attach. See `reconcile.ts` for what each kind can be read by.
 *
 * Not in this slice: re-reading quotes onto a card (`display.estimate`) and the key-limit check
 * against a fresh read (`OVER_KEY_LIMIT`). Those arrive with the screens.
 *
 * S4 (BE-1680) adds the two money flows S1 left as placeholders:
 *
 *   - Launch (L-4). A `launch` card starts `proposed`. The core runs the tool with exactly the
 *     card's `params` plus `dryRun: true` under an open paper or live window, stores the passing
 *     answer on the card (`display.checks`) and only then makes it `awaiting_approval`; a failing
 *     dry run withdraws it (`by: "dry_run"`). `cards.approve` on a launch without a passing dry
 *     run is `DRY_RUN_REQUIRED`. A dry run is never reused across cards.
 *   - Transfers (T-1 to T-9). A `transfer` card is created only by `transfer.prepare` from a view
 *     ({@link CardBook.createTransferCard}); `cards.propose` refuses the kind for every role. Its
 *     approval checks, in one call and in this order, the typed `confirm` (every transfer; BE-1710
 *     removed the destination's last six that followed it) and then a factor verified in that
 *     call, so no factor helper runs before the confirmation. A `vault` send is
 *     signed with the vault open, its signature journaled and its bytes kept 0600 before the
 *     broadcast; an `embedded` send goes through `candle_transfer` with the Withdraw key and
 *     `clientTransferId = opId`. An unknown outcome is re-sent only as the same signed bytes, and
 *     an `embedded` one never (T-8, which corrects S1 R-3 for transfers).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { terminalText } from "../render"
import { canonicalJson } from "../vault/canonical-json"
import { type CardKind, cardLifetimeMs, classifyCall, FACTOR_KINDS, type IdKey } from "./classify"
import type { EventHub } from "./events"
import type { CoreEnvironment, Journal, JournalRow } from "./journal"
import { claimableFor, nextPollMs, readOnce, readsById, reconcileMessage, transferReconcileMessage } from "./reconcile"
import { invalidParams, RpcError, refused } from "./rpc"
import { type Factor, formatKeyLimit, type OpenVault, type TradingState } from "./trading"
import { confirmTyped, type TransferChain, type TransferParams, type TransferSourceKind } from "./transfer-params"

export type CardState = "proposed" | "awaiting_approval" | "approved" | "rejected" | "withdrawn" | "expired"
/** `attested_*` (S4 T-8): an `embedded` transfer the core cannot read back, resolved by the user's own statement. */
export type OperationState =
  | "submitting"
  | "pending"
  | "succeeded"
  | "failed"
  | "refused"
  | "unknown"
  | "resolved_resent"
  | "resolved_abandoned"
  | "attested_sent"
  | "attested_not_sent"

export type ReconcileAction = "check" | "resend" | "abandon" | "rebroadcast" | "attest_sent" | "attest_not_sent"

/** What the transfer card draws (T-4, T-5), beside the generic display fields. */
export interface TransferDisplay {
  sourceKind: TransferSourceKind
  /** The source address in full. */
  source: string
  sourceLabel?: string
  /** The destination in full, and grouped in fours on its own line. */
  to: string
  toGrouped: string
  toLabel?: string
  /** The server's class for an `embedded` destination; `unlisted` is a Hood address the core could not class. */
  serverClass?: "own" | "approved" | "linked" | "unlisted"
  /** A display hint only (T-3): false shows "sent here before" and never skips a step. */
  newDestination: boolean
  asset: { label: string; contract: string }
  amount: { decimal: string; raw: string; max?: boolean; balanceAtPreview?: string }
  feeEstimate?: string
  /** The CLI's decoded plan, for a `vault` send. */
  previewLines?: string[]
  /** `send <amount> <asset> to <address>`: the confirm prompt and the factor dialog's reason. */
  describeSend: string
}

/** Who suggested what the user is acting on (S5 K-2). Quant is the only agent that can. */
export interface SuggestedBy {
  agent: "quant"
  turnId: string
}

/** A view's `suggestedBy`, checked. A harness never sets it: it proposes as itself. */
export function parseSuggestedBy(value: unknown, origin: Pick<CardOrigin, "role">): SuggestedBy | undefined {
  if (value === undefined || value === null) return undefined
  if (origin.role !== "view") throw invalidParams("suggestedBy is set by a view only.")
  const given = value as { agent?: unknown; turnId?: unknown }
  if (
    typeof given !== "object" ||
    given.agent !== "quant" ||
    typeof given.turnId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(given.turnId) ||
    Object.keys(given).some((key) => key !== "agent" && key !== "turnId")
  )
    throw invalidParams('suggestedBy is {agent: "quant", turnId}.')
  return { agent: "quant", turnId: given.turnId }
}

export interface CardOrigin {
  clientId: string
  role: "view" | "harness"
  clientName: string
  harnessKind?: string
}

export interface Card {
  cardId: string
  opId: string
  idKey: IdKey
  kind: CardKind
  tool: string
  params: Record<string, unknown>
  cardHash: string
  origin: CardOrigin
  reason?: string
  display: {
    title: string
    contract: string
    chain: string
    amount: string
    amountUsd?: string
    keyLimitUsd?: string
    estimate?: Record<string, unknown>
    checks?: Record<string, unknown>
    environment: CoreEnvironment
    transfer?: TransferDisplay
    /**
     * S5 K-2 (BE-1737): the user reached this token from a Quant answer. Display only: never in
     * `params`, never in `cardHash`, and only a view may set it.
     */
    suggestedBy?: SuggestedBy
  }
  policy: "ask"
  needsFactor: boolean
  createdAt: string
  expiresAt: string
  state: CardState
  proposalKey?: string
}

/** What the core records about a transfer operation (T-7, T-9): never the signed bytes or a key. */
export interface TransferRef {
  source: TransferSourceKind
  chain: TransferChain
  from: string
  to: string
  /** The Solana signature or the EVM hash, computed before the broadcast. */
  id?: string
  blockhash?: string
  nonce?: string
}

export interface Operation {
  opId: string
  cardId: string
  kind: CardKind
  tool: string
  idKey: IdKey
  ownerClientId: string
  state: OperationState
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: { code: string; message: string }
  /** How the user resolved an `unknown` (R-3). The state then follows what happened next. */
  resolution?: "resent" | "abandoned"
  /** Set when reading this operation back needs the vault factor (the Write key is sealed). */
  readNeedsFactor?: boolean
  /** V-5: what `candle_get_fees` showed before the claim and at the last check. */
  evidence?: { before?: unknown; after?: unknown }
  /** A record that appeared after the user stopped tracking (R-3). */
  lateRecord?: unknown
  /** Present while the operation is `unknown`: what the reconcile card offers. */
  reconcile?: { actions: ReconcileAction[]; message: string }
  /** A transfer's source, destination and, for `vault`, its signature or hash. */
  transfer?: TransferRef
}

export type ExecutionOutcome =
  | { state: "succeeded" | "pending"; result: unknown }
  | { state: "failed" | "refused"; error: { code: string; message: string }; result?: unknown }
  /**
   * `transient`: the answer was lost or unreadable (a transport failure, a 5xx, a body that is not
   * JSON), as opposed to an API error the tool relayed. For a write it is still `unknown`; for a
   * dry run, which writes nothing, it means the check could not run rather than that it failed.
   */
  | { state: "unknown"; error: { code: string; message: string }; transient?: boolean; result?: unknown }

/** Sends one tool call with the Write key. The real one is `executor.ts`; tests pass a fake API. */
export interface Executor {
  execute(tool: string, params: Record<string, unknown>, writeKey: string): Promise<ExecutionOutcome>
}

/** A `vault` transfer signed locally (T-7). `wire` lives only in the pending file, never in the journal. */
export interface SignedTransfer {
  chain: TransferChain
  /** The Solana signature or the EVM transaction hash, computed before the broadcast. */
  id: string
  /** The signed transaction, base64. */
  wire: string
  from: string
  blockhash?: string
  nonce?: string
  /** What the signature moves, in raw units (for `max`, what the wallet held at signing). */
  amountRaw: string
}

/** One status read of a signed transfer (T-8). */
export type TransferStatus =
  | { state: "finalized" }
  | { state: "failed"; reason: string }
  | { state: "pending" }
  /** `expired`: it can no longer land (the blockhash passed, or the nonce was used by another). */
  | { state: "not_found"; expired: boolean }

/**
 * The chain side of a transfer (T-7, T-8). The real one is `transfer-chain.ts`, over the CLI's
 * vault-transfer code; tests pass a fake RPC and a fake API.
 */
export interface TransferEngine {
  /** Plans the send again with the same params (fresh blockhash or nonce) and signs it. Never sends. */
  signVault(params: TransferParams, vault: OpenVault): Promise<SignedTransfer>
  /** Keeps the signed bytes at `<state dir>/pending/<opId>.tx` (0600) until the operation is terminal. */
  keepPending(opId: string, signed: SignedTransfer): Promise<void>
  readPending(opId: string): Promise<SignedTransfer | undefined>
  dropPending(opId: string): Promise<void>
  /** Sends the stored bytes. `definite` only when the network refused them so that they can never land. */
  broadcast(
    signed: SignedTransfer,
  ): Promise<{ ok: true } | { ok: false; definite: boolean; code: string; message: string }>
  status(ref: TransferRef): Promise<TransferStatus>
  /** `embedded`: `candle_transfer` with `clientTransferId = opId` and the Withdraw key, never the Write key. */
  sendEmbedded(params: TransferParams, clientTransferId: string, withdrawKey: string): Promise<ExecutionOutcome>
  /** A promoted TEE wallet's finalized send, reported to Candle's history as the CLI does. Best effort. */
  reportActivity?(params: TransferParams, ref: TransferRef): Promise<void>
  /** T-3: a succeeded send's destination joins the display-only history. */
  recordDestination(params: TransferParams): Promise<void>
}

/** The tool name a transfer card carries, by source: an MCP tool for `embedded`, the core's own for `vault`. */
export const TRANSFER_TOOLS: Record<TransferSourceKind, string> = {
  vault: "core_vault_transfer",
  embedded: "candle_transfer",
}

const OPEN_CARD_CAP = 5
const MAX_REASON = 500
const MAX_PARAMS_BYTES = 64 * 1024
const PERPS_CLIENT_ID = /^0x[0-9a-fA-F]{32}$/

interface Entry {
  card: Card
  /** What the proposer asked for, before the core filled the id: the dedupe key (K-2). */
  proposedKey: string
}

export class CardBook {
  private readonly cards = new Map<string, Entry>()
  private readonly operations = new Map<string, Operation>()
  private readonly approving = new Set<string>()
  /** Cards with a dry run in flight: a second one is refused, never overlapped (L-4). */
  private readonly dryRunning = new Set<string>()
  private sweep: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly deps: {
      journal: Journal
      events: EventHub
      trading: TradingState
      executor: Executor
      environment: CoreEnvironment
      profile: string
      now: () => number
      /** Timer seam for the R-2 polls; tests drive it by hand. */
      schedule?: (run: () => void, ms: number) => () => void
      /** S4 T-7: the chain side of transfers. Without it, a transfer card cannot execute. */
      transfers?: TransferEngine
    },
  ) {}

  private readonly watches = new Map<string, () => void>()

  private schedule(run: () => void, ms: number): () => void {
    if (this.deps.schedule) return this.deps.schedule(run, ms)
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }

  /** Expires cards on a one-second sweep; `stop` ends it. */
  start(): void {
    this.sweep = setInterval(() => void this.expireDue(), 1000)
    this.sweep.unref?.()
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
    for (const cancel of this.watches.values()) cancel()
    this.watches.clear()
  }

  async propose(input: Record<string, unknown>, origin: CardOrigin): Promise<Card> {
    const tool = input.tool
    if (typeof tool !== "string" || tool.length === 0 || tool.length > 64)
      throw invalidParams("tool must name an MCP tool.")
    const params = input.params
    if (params === null || typeof params !== "object" || Array.isArray(params))
      throw invalidParams("params must be an object.")
    const proposed = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > MAX_PARAMS_BYTES)
      throw invalidParams("params is over 64 KiB.")

    const verdict = classifyCall(tool, proposed)
    if (verdict.class === "unclassified") {
      await this.refusal(origin, tool, "TOOL_NOT_CLASSIFIED")
      throw refused(
        "TOOL_NOT_CLASSIFIED",
        `${terminalText(tool)} is not a tool this core has classified, so it is refused.`,
      )
    }
    if (verdict.class !== "card") {
      throw refused(
        "NOT_A_CARD",
        `This ${verdict.class === "read" ? "read" : verdict.class === "paper" ? "paper trade" : "dry run"} needs no card; call the tool directly.`,
      )
    }
    const { kind, idKey } = verdict
    if (input.kind !== undefined && input.kind !== kind) {
      throw invalidParams(`${tool} is a ${kind} card, not ${String(input.kind)}.`)
    }
    const proposalKey = typeof input.proposalKey === "string" ? input.proposalKey.slice(0, 128) : undefined
    const suggestedBy = parseSuggestedBy(input.suggestedBy, origin)
    const proposedKey = canonicalJson({ tool, params: proposed })

    // A-5, R-4: an id the core already holds is a read when the request is the same, a conflict when
    // not. Answered before every gate that refuses a NEW card (trading off here, no view in the
    // server), so a resumed harness always learns the state of what it sent.
    const givenId = typeof proposed[idKey] === "string" ? (proposed[idKey] as string) : undefined
    if (givenId !== undefined) {
      const held = this.byOpId(givenId)
      if (held !== undefined) {
        if (
          held.proposedKey !== proposedKey &&
          canonicalJson({ tool: held.card.tool, params: held.card.params }) !== proposedKey
        ) {
          await this.refusal(origin, tool, "OP_ID_CONFLICT")
          throw refused(
            "OP_ID_CONFLICT",
            "That operation id is held for a different request. Never reuse an id for new parameters.",
            {
              opId: givenId,
            },
          )
        }
        // Never a 404 for an id the core issued: the card, and its operation once there is one.
        return this.viewWithOperation(held.card)
      }
    }
    // K-3 and S4 invariant 11: no harness, and no agent text, can start a transfer. A view's
    // transfer card comes only from `transfer.prepare`, never from a proposal.
    if (kind === "transfer") {
      await this.refusal(origin, tool, origin.role === "harness" ? "TRANSFER_USER_ONLY" : "TRANSFER_FORM_ONLY")
      if (origin.role === "harness")
        throw refused("TRANSFER_USER_ONLY", "Only you can start a transfer, from the Candle TUI.")
      throw refused(
        "TRANSFER_FORM_ONLY",
        "A transfer starts from the transfer form (Holdings t, or Transfer out in ctrl-k).",
      )
    }
    // S1 reserves the perps kinds; perps writes arrive with the Hyperliquid view (S6).
    if (kind === "perps") {
      await this.refusal(origin, tool, "KIND_RESERVED")
      throw refused("KIND_RESERVED", "Perps writes from the core arrive with the Hyperliquid view.")
    }
    if (!this.deps.trading.tradingOn()) {
      await this.refusal(origin, tool, "TRADING_OFF")
      throw refused("TRADING_OFF", "Trading is off. Turn it on in Settings > Trading.")
    }
    await this.expireDue()
    for (const entry of this.cards.values()) {
      if (
        isOpen(entry.card) &&
        entry.card.origin.clientId === origin.clientId &&
        entry.proposedKey === proposedKey &&
        entry.card.proposalKey === proposalKey
      ) {
        return this.view(entry.card)
      }
    }
    await this.assertUnderCap(origin, tool)

    const opId = this.opIdFor(idKey, proposed)
    const filled = idKey === "coreOpId" || idKey === "rewardId" ? proposed : { ...proposed, [idKey]: opId }
    // L-6: a launch is sent with `dryRun` absent; the dry run adds it to these exact params (L-4).
    const sent = kind === "launch" ? withoutKey(filled, "dryRun") : filled
    const now = this.deps.now()
    const reason = typeof input.reason === "string" ? terminalText(input.reason).slice(0, MAX_REASON) : undefined
    const card: Card = {
      cardId: `card_${randomBytes(12).toString("base64url")}`,
      opId,
      idKey,
      kind,
      tool,
      params: sent,
      cardHash: hashCard({
        kind,
        tool,
        params: sent,
        opId,
        environment: this.deps.environment,
        profile: this.deps.profile,
      }),
      origin: { ...origin, clientName: terminalText(origin.clientName) },
      ...(reason ? { reason } : {}),
      display: {
        ...displayFor(kind, tool, sent, this.deps.environment, formatKeyLimit(this.deps.trading.lastKeyLimit())),
        // K-2: display only. `cardHash` above is computed without it, so the hash is the same card's.
        ...(suggestedBy ? { suggestedBy } : {}),
      },
      policy: "ask",
      needsFactor: FACTOR_KINDS.has(kind),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + cardLifetimeMs(kind)).toISOString(),
      // L-4: a launch waits for its own dry run before anyone can approve it.
      state: kind === "launch" ? "proposed" : "awaiting_approval",
      ...(proposalKey !== undefined ? { proposalKey } : {}),
    }
    if (kind === "launch") card.display.checks = { dryRun: "needed" }
    this.cards.set(card.cardId, { card, proposedKey })
    await this.deps.journal.append({ type: "card.created", card, proposedKey })
    // L-4 and T4-5: with a window open, the dry run runs before the card is drawn. Without one the
    // card is drawn as "Dry run needed" and the view runs it with `launch.dryRun`.
    if (kind === "launch") await this.tryDryRun(card)
    this.publish(card)
    return this.view(card)
  }

  /**
   * L-4: runs (or runs again) the dry run of a `launch` card still `proposed`, from a view. With a
   * factor and no window open, the factor opens a paper window first (S1 A-5's rules).
   */
  async dryRun(input: { cardId: unknown; factor: Factor | undefined }, viewClientId: string): Promise<Card> {
    await this.expireDue()
    const entry = typeof input.cardId === "string" ? this.cards.get(input.cardId) : undefined
    if (entry === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    const card = entry.card
    if (card.kind !== "launch") throw refused("NOT_A_LAUNCH", "Only a launch card has a dry run.")
    if (card.state !== "proposed") {
      throw refused("CARD_NOT_AWAITING", `This card is ${card.state}; its dry run has already decided it.`, {
        state: card.state,
      })
    }
    if (this.dryRunning.has(card.cardId)) {
      throw refused("DRY_RUN_IN_FLIGHT", "A dry run of this card is already running.")
    }
    if (input.factor !== undefined && !this.deps.trading.snapshot().paperWindow.open) {
      await this.deps.trading.openPaperWindow(viewClientId, 15, input.factor)
    }
    await this.runDryRun(card)
    this.publish(card)
    return this.view(card)
  }

  /**
   * Creates the `transfer` card `transfer.prepare` built (T-4). Only a view reaches this: the
   * method is view-only in the role table, and `origin.role` is checked again here.
   */
  async createTransferCard(input: {
    params: TransferParams
    display: TransferDisplay & { amountUsd?: string; keyLimitUsd?: string }
    origin: CardOrigin
  }): Promise<Card> {
    const { params, origin } = input
    const tool = TRANSFER_TOOLS[params.source.kind]
    if (origin.role !== "view") {
      await this.refusal(origin, tool, "TRANSFER_USER_ONLY")
      throw refused("TRANSFER_USER_ONLY", "Only you can start a transfer, from the Candle TUI.")
    }
    await this.expireDue()
    await this.assertUnderCap(origin, tool)
    const opId = this.opIdFor("coreOpId", {})
    const now = this.deps.now()
    const { amountUsd, keyLimitUsd, ...transfer } = input.display
    const sent = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
    const card: Card = {
      cardId: `card_${randomBytes(12).toString("base64url")}`,
      opId,
      idKey: "coreOpId",
      kind: "transfer",
      tool,
      params: sent,
      cardHash: hashCard({
        kind: "transfer",
        tool,
        params: sent,
        opId,
        environment: this.deps.environment,
        profile: this.deps.profile,
      }),
      origin: { ...origin, clientName: terminalText(origin.clientName) },
      display: {
        title: `SEND ${terminalText(transfer.amount.decimal)} ${terminalText(transfer.asset.label)}`,
        contract: terminalText(transfer.asset.contract),
        chain: params.chain,
        amount: terminalText(transfer.amount.decimal),
        ...(amountUsd ? { amountUsd } : {}),
        ...(keyLimitUsd ? { keyLimitUsd } : {}),
        environment: this.deps.environment,
        transfer: {
          ...transfer,
          ...(transfer.sourceLabel ? { sourceLabel: terminalText(transfer.sourceLabel) } : {}),
          ...(transfer.toLabel ? { toLabel: terminalText(transfer.toLabel) } : {}),
        },
      },
      policy: "ask",
      needsFactor: true,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + cardLifetimeMs("transfer")).toISOString(),
      state: "awaiting_approval",
    }
    const proposedKey = canonicalJson({ tool, params: sent })
    this.cards.set(card.cardId, { card, proposedKey })
    const { balanceAtPreview: _balance, ...amountShown } = transfer.amount
    await this.deps.journal.append({
      type: "transfer.prepared",
      cardId: card.cardId,
      opId,
      clientId: origin.clientId,
      params: sent,
      display: { ...transfer, amount: amountShown },
      newDestination: transfer.newDestination,
      serverClass: transfer.serverClass ?? null,
    })
    await this.deps.journal.append({ type: "card.created", card, proposedKey })
    this.publish(card)
    return this.view(card)
  }

  /** K-2's cap on open cards per client, `proposed` launches included. */
  private async assertUnderCap(origin: CardOrigin, tool: string): Promise<void> {
    const openByClient = [...this.cards.values()].filter(
      (e) => isOpen(e.card) && e.card.origin.clientId === origin.clientId,
    ).length
    if (openByClient >= OPEN_CARD_CAP) {
      await this.refusal(origin, tool, "TOO_MANY_OPEN_CARDS")
      throw refused("TOO_MANY_OPEN_CARDS", `A client may hold ${OPEN_CARD_CAP} open cards at once.`)
    }
  }

  /** The dry run when a window can supply the Write key; otherwise the card stays `proposed`. */
  private async tryDryRun(card: Card): Promise<void> {
    try {
      await this.runDryRun(card)
    } catch (error) {
      if (!(error instanceof RpcError)) throw error
      // No window, or trading off: the card waits for the user's `d` (L-4 step 2).
      card.display.checks = { dryRun: "needed", reason: error.code }
    }
  }

  /**
   * L-4 steps 2 to 4: the tool with exactly `params` plus `dryRun: true`, under the credentials of
   * an open paper or live window. A pass is stored on the card with its digest journaled; a failure
   * withdraws the card with the API's code; an answer that was lost leaves it `proposed`.
   */
  private async runDryRun(card: Card): Promise<void> {
    if (this.dryRunning.has(card.cardId)) return
    this.dryRunning.add(card.cardId)
    try {
      await this.runDryRunOnce(card)
    } finally {
      this.dryRunning.delete(card.cardId)
    }
  }

  private async runDryRunOnce(card: Card): Promise<void> {
    const params = { ...card.params, dryRun: true }
    const outcome = await this.deps.trading.withPaperCredentials((credentials) =>
      this.deps.executor.execute(card.tool, params, credentials.writeKey),
    )
    // The answer applies only to a card still waiting for it: it may have expired, been withdrawn
    // or been approved while the call was out, and a late answer must not rewrite that.
    if (card.state !== "proposed") return
    const at = new Date(this.deps.now()).toISOString()
    const body = outcome.state === "succeeded" ? record(outcome.result) : undefined
    // `candle_launch_and_seed` wraps the dry run's answer under `api` (V-S4-1).
    const answer = body && record(body.api) ? record(body.api) : body
    if (answer?.success === true && answer.dryRun === true) {
      // The API's answer carries nulls, which `canonicalJson` refuses: keys sorted, nulls kept.
      const digest = createHash("sha256").update(sortedJson(answer), "utf8").digest("hex")
      card.display.checks = {
        dryRun: "passed",
        at,
        resolved: answer.resolved ?? null,
        checks: answer.checks ?? null,
        launchWallet: answer.launchWallet ?? null,
        ...(answer.feeWallet !== undefined ? { feeWallet: answer.feeWallet } : {}),
        ...(answer.size !== undefined ? { size: answer.size } : {}),
        ...(answer.curveTerms !== undefined ? { curveTerms: answer.curveTerms } : {}),
      }
      card.state = "awaiting_approval"
      await this.deps.journal.append({
        type: "launch.dry_run",
        cardId: card.cardId,
        opId: card.opId,
        outcome: "passed",
        digest,
      })
      return
    }
    const error =
      "error" in outcome
        ? outcome.error
        : { code: "DRY_RUN_UNREADABLE", message: "The dry run answered without a pass. Nothing was launched." }
    const transient = (outcome.state === "unknown" && outcome.transient === true) || error.code === "DRY_RUN_UNREADABLE"
    if (transient) {
      // A lost answer is not a failed check: the dry run wrote nothing, and the user can run it again.
      card.display.checks = { dryRun: "error", at, error: { code: error.code, message: terminalText(error.message) } }
      await this.deps.journal.append({
        type: "launch.dry_run",
        cardId: card.cardId,
        opId: card.opId,
        outcome: "error",
        code: error.code,
      })
      return
    }
    const failedBody = record("result" in outcome ? outcome.result : undefined)
    const failedAnswer = failedBody && record(failedBody.api) ? record(failedBody.api) : failedBody
    const apiError = record(failedAnswer?.error)
    const field = typeof apiError?.field === "string" ? terminalText(apiError.field) : undefined
    card.display.checks = {
      dryRun: "failed",
      at,
      error: { code: error.code, message: terminalText(error.message), ...(field ? { field } : {}) },
    }
    await this.deps.journal.append({
      type: "launch.dry_run",
      cardId: card.cardId,
      opId: card.opId,
      outcome: "failed",
      code: error.code,
    })
    card.state = "withdrawn"
    await this.deps.journal.append({ type: "card.withdrawn", cardId: card.cardId, by: "dry_run", code: error.code })
  }

  /** Whether `cards.propose` with these params names an operation id the core already holds. */
  holdsRequest(input: Record<string, unknown>): boolean {
    const tool = input.tool
    const params = input.params
    if (typeof tool !== "string" || params === null || typeof params !== "object" || Array.isArray(params)) return false
    const verdict = classifyCall(tool, params as Record<string, unknown>)
    if (verdict.class !== "card") return false
    const id = (params as Record<string, unknown>)[verdict.idKey]
    return typeof id === "string" && this.byOpId(id) !== undefined
  }

  list(clientId: string, ownOnly: boolean): Card[] {
    return [...this.cards.values()]
      .map((e) => e.card)
      .filter((card) => !ownOnly || card.origin.clientId === clientId)
      .map((card) => this.view(card))
  }

  get(cardId: unknown, clientId: string, ownOnly: boolean): Card {
    const entry = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    // Another client's card answers as missing to a harness: it must not learn that it exists.
    if (entry === undefined || (ownOnly && entry.card.origin.clientId !== clientId)) {
      throw refused("CARD_NOT_FOUND", "No card with that id.")
    }
    return this.view(entry.card)
  }

  operationsFor(clientId: string, ownOnly: boolean): Operation[] {
    return [...this.operations.values()]
      .filter((op) => !ownOnly || op.ownerClientId === clientId)
      .map((op) => this.opView(op))
  }

  operation(opId: unknown, clientId: string, ownOnly: boolean): Operation {
    const op = typeof opId === "string" ? this.operations.get(opId) : undefined
    if (op === undefined || (ownOnly && op.ownerClientId !== clientId))
      throw refused("OPERATION_NOT_HELD", "The core holds no operation with that id.")
    return this.opView(op)
  }

  /** K-5. Only a view reaches this (the role table refuses a harness). */
  async approve(
    input: { cardId: unknown; cardHash: unknown; factor: Factor | undefined; confirm?: unknown },
    viewClientId: string,
  ): Promise<{ card: Card; operation: Operation }> {
    await this.expireDue()
    const entry = typeof input.cardId === "string" ? this.cards.get(input.cardId) : undefined
    if (entry === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    const card = entry.card
    // L-4 step 5 and invariant 15: a launch is approvable only with a passing dry run of its own.
    if (card.kind === "launch" && card.state === "proposed" && !this.approving.has(card.cardId)) {
      await this.deps.journal.append({
        type: "approval.refused",
        cardId: card.cardId,
        viewClientId,
        code: "DRY_RUN_REQUIRED",
      })
      throw refused("DRY_RUN_REQUIRED", "This launch needs its dry run first. Press d to run it.")
    }
    if (card.kind === "transfer") return this.approveTransfer(card, input, viewClientId)
    if (card.state !== "awaiting_approval" || this.approving.has(card.cardId)) {
      throw refused(
        "CARD_NOT_AWAITING",
        `This card is ${this.approving.has(card.cardId) ? "being approved" : card.state}.`,
        { state: card.state },
      )
    }
    if (input.cardHash !== card.cardHash) {
      await this.deps.journal.append({
        type: "approval.refused",
        cardId: card.cardId,
        viewClientId,
        code: "CARD_HASH_MISMATCH",
      })
      throw refused("CARD_HASH_MISMATCH", "The card changed after it was drawn. Nothing was approved; review it again.")
    }
    if (card.kind === "launch" && record(card.display.checks)?.dryRun !== "passed") {
      throw refused("DRY_RUN_REQUIRED", "This launch has no passing dry run of its own.")
    }
    if (!this.deps.trading.tradingOn())
      throw refused("TRADING_OFF", "Trading is off. Turn it on in Settings > Trading.")
    this.approving.add(card.cardId)
    try {
      return await this.deps.trading.withCredentials(
        { kind: card.kind, viewClientId, factor: input.factor },
        async (credentials) => {
          // Re-checked after the factor: the card may have expired while the user answered.
          if (card.state !== "awaiting_approval" || Date.parse(card.expiresAt) <= this.deps.now()) {
            await this.expireDue()
            throw refused("CARD_NOT_AWAITING", `This card is ${card.state}.`, { state: card.state })
          }
          // K-5: within the key limit as read now, with the credentials just unlocked. A card
          // whose USD amount the core cannot tell is left to the server's own limit.
          const limit = await this.deps.trading.refreshKeyLimit(credentials)
          const usd = cardUsdMicros(card)
          if (limit !== undefined && usd !== undefined && usd > limit.usdMicros - limit.usedUsdMicros) {
            throw refused(
              "OVER_KEY_LIMIT",
              `This is over the Write key's limit (${formatKeyLimit(limit)}). Nothing was sent.`,
              {
                keyLimitUsd: formatKeyLimit(limit),
              },
            )
          }
          await this.deps.journal.append({
            type: "card.approved",
            cardId: card.cardId,
            cardHash: card.cardHash,
            opId: card.opId,
            factorType: input.factor?.type ?? "window",
            viewClientId,
          })
          card.state = "approved"
          this.publish(card)
          const operation = await this.execute(card, credentials.writeKey)
          return { card: this.view(card), operation }
        },
      )
    } catch (error) {
      if (card.state === "awaiting_approval") {
        const code = (error as { code?: string }).code ?? "APPROVAL_FAILED"
        await this.deps.journal.append({ type: "approval.refused", cardId: card.cardId, viewClientId, code })
      }
      throw error
    } finally {
      this.approving.delete(card.cardId)
    }
  }

  /**
   * T-5 and invariant 12: in one call, in this order, the card is open and unexpired, the hash
   * matches, `typed` is `confirm` (on every transfer), and only then a factor verified in this
   * call. A wrong answer refuses before any factor helper runs, and the card stays open.
   */
  private async approveTransfer(
    card: Card,
    input: { cardHash: unknown; factor: Factor | undefined; confirm?: unknown },
    viewClientId: string,
  ): Promise<{ card: Card; operation: Operation }> {
    if (card.state !== "awaiting_approval" || this.approving.has(card.cardId)) {
      throw refused(
        "CARD_NOT_AWAITING",
        `This card is ${this.approving.has(card.cardId) ? "being approved" : card.state}.`,
        { state: card.state },
      )
    }
    // Held before the first await: a second approval of this card, from any view, is refused at the
    // check above for as long as this one runs, so one card can never be signed twice.
    this.approving.add(card.cardId)
    try {
      return await this.approveTransferHeld(card, input, viewClientId)
    } finally {
      this.approving.delete(card.cardId)
    }
  }

  private async approveTransferHeld(
    card: Card,
    input: { cardHash: unknown; factor: Factor | undefined; confirm?: unknown },
    viewClientId: string,
  ): Promise<{ card: Card; operation: Operation }> {
    const refuse = async (code: string, message: string, details: Record<string, unknown> = {}) => {
      await this.deps.journal.append({ type: "approval.refused", cardId: card.cardId, viewClientId, code, ...details })
      return refused(code, message, details)
    }
    if (input.cardHash !== card.cardHash) {
      throw await refuse(
        "CARD_HASH_MISMATCH",
        "The card changed after it was drawn. Nothing was approved; review it again.",
      )
    }
    const params = card.params as unknown as TransferParams
    const confirm = record(input.confirm)
    if (!confirmTyped(confirm?.typed)) {
      throw await refuse(
        "DESTINATION_NOT_CONFIRMED",
        "Type confirm to send. Nothing was sent; the card is still open.",
        {
          step: "confirm",
        },
      )
    }
    const engine = this.deps.transfers
    if (engine === undefined) throw refused("NOT_IN_THIS_BUILD", "Transfers are not in this build of the core.")
    const reason = card.display.transfer?.describeSend ?? `send to ${params.to}`
    try {
      const approved = async (factorType: string) => {
        // Re-checked after the factor: the card may have expired while the user answered.
        if (card.state !== "awaiting_approval" || Date.parse(card.expiresAt) <= this.deps.now()) {
          this.approving.delete(card.cardId)
          await this.expireDue()
          throw refused("CARD_NOT_AWAITING", `This card is ${card.state}.`, { state: card.state })
        }
        card.state = "approved"
        await this.deps.journal.append({
          type: "card.approved",
          cardId: card.cardId,
          cardHash: card.cardHash,
          opId: card.opId,
          factorType,
          // T-9: that it was typed, never what was typed.
          confirm: { typed: true },
          viewClientId,
        })
        this.publish(card)
      }
      const factorType = input.factor?.type ?? "none"
      let operation: Operation
      if (params.source.kind === "vault") {
        // T-7 `vault`: the vault unlock releases the signing key; no API key and no window.
        const signed = await this.deps.trading.withVaultSigner(
          { viewClientId, factor: input.factor, reason },
          async (vault) => {
            await approved(factorType)
            try {
              return { ok: true as const, signed: await engine.signVault(params, vault) }
            } catch (error) {
              return { ok: false as const, error }
            }
          },
        )
        operation = await this.executeVaultTransfer(card, params, signed)
      } else {
        // T-7 `embedded`: the Withdraw key, from the one path that returns it, for this call only.
        operation = await this.deps.trading.withTransferCredentials(
          { cardId: card.cardId, viewClientId, factor: input.factor, reason },
          async (credentials) => {
            await approved(factorType)
            return this.executeEmbeddedTransfer(card, params, credentials.withdrawKey)
          },
        )
      }
      return { card: this.view(card), operation }
    } catch (error) {
      if (card.state === "awaiting_approval") {
        const code = (error as { code?: string }).code ?? "APPROVAL_FAILED"
        await this.deps.journal.append({ type: "approval.refused", cardId: card.cardId, viewClientId, code })
      }
      throw error
    }
  }

  /** The operation row a transfer starts with (K-7), before anything leaves the machine. */
  private startTransferOperation(card: Card, params: TransferParams): Operation {
    const at = new Date(this.deps.now()).toISOString()
    const op: Operation = {
      opId: card.opId,
      cardId: card.cardId,
      kind: card.kind,
      tool: card.tool,
      idKey: card.idKey,
      ownerClientId: card.origin.clientId,
      state: "submitting",
      createdAt: at,
      updatedAt: at,
      transfer: { source: params.source.kind, chain: params.chain, from: params.source.address, to: params.to },
    }
    this.operations.set(op.opId, op)
    return op
  }

  private async journalSubmitting(op: Operation, card: Card): Promise<void> {
    await this.deps.journal.append({
      type: "operation.submitting",
      opId: op.opId,
      cardId: card.cardId,
      tool: card.tool,
      kind: card.kind,
      idKey: card.idKey,
      ownerClientId: op.ownerClientId,
      params: card.params,
      // T-9: the source kind and, for `vault`, the signature or hash. Never the signed bytes.
      ...(op.transfer ? { transfer: op.transfer } : {}),
    })
    this.publishOperation(op)
  }

  /**
   * T-7 `vault`: the signature (or hash) is on disk in the `submitting` row and the signed bytes in
   * the pending file before the broadcast. A send the network refused definitely is `failed`; any
   * other broadcast answer is read back by its signature (R-2's cadence), never re-signed.
   */
  private async executeVaultTransfer(
    card: Card,
    params: TransferParams,
    signing: { ok: true; signed: SignedTransfer } | { ok: false; error: unknown },
  ): Promise<Operation> {
    const engine = this.deps.transfers as TransferEngine
    const op = this.startTransferOperation(card, params)
    if (!signing.ok) {
      // Nothing was signed, so nothing can have left: the plan or the key refused (funds, chain).
      await this.journalSubmitting(op, card)
      const error = signing.error as { code?: unknown; message?: unknown }
      await this.settle(op, "refused", {
        error: {
          code: typeof error?.code === "string" ? error.code : "TRANSFER_NOT_SIGNED",
          message: terminalText(typeof error?.message === "string" ? error.message : String(signing.error)),
        },
      })
      return this.opView(op)
    }
    const signed = signing.signed
    op.transfer = {
      ...(op.transfer as TransferRef),
      id: signed.id,
      ...(signed.blockhash ? { blockhash: signed.blockhash } : {}),
      ...(signed.nonce ? { nonce: signed.nonce } : {}),
    }
    await engine.keepPending(op.opId, signed)
    await this.journalSubmitting(op, card)
    const sent = await engine
      .broadcast(signed)
      .catch(
        (error: unknown) => ({ ok: false, definite: false, code: "BROADCAST_FAILED", message: String(error) }) as const,
      )
    if (!sent.ok && sent.definite) {
      await engine.dropPending(op.opId)
      await this.settle(op, "failed", { error: { code: sent.code, message: terminalText(sent.message) } })
      return this.opView(op)
    }
    await this.settle(op, "pending", { result: { id: signed.id, finalized: false } })
    this.watchTransfer(op, params)
    return this.opView(op)
  }

  /** T-7 `embedded`: `candle_transfer` under `clientTransferId = opId`, once; never re-sent (T-8). */
  private async executeEmbeddedTransfer(card: Card, params: TransferParams, withdrawKey: string): Promise<Operation> {
    const engine = this.deps.transfers as TransferEngine
    const op = this.startTransferOperation(card, params)
    await this.journalSubmitting(op, card)
    let outcome: ExecutionOutcome
    try {
      outcome = await engine.sendEmbedded(params, op.opId, withdrawKey)
    } catch (error) {
      outcome = {
        state: "unknown",
        error: { code: "EXECUTOR_FAILED", message: error instanceof Error ? error.message : String(error) },
      }
    }
    if (
      (outcome.state === "refused" || outcome.state === "unknown") &&
      /^(UNAUTHORIZED|KEY_EXPIRED)$/.test(outcome.error.code)
    ) {
      // W-2: the server no longer takes the Withdraw key. Nothing moved; the source turns off.
      await this.deps.trading.withdrawKeyRefused(outcome.error.code)
      outcome = { state: "refused", error: outcome.error }
    }
    // A pending answer cannot be read back by its id (T-8), so it is the user's to check.
    const state = outcome.state === "pending" ? "unknown" : outcome.state
    await this.settle(op, state, {
      ...("result" in outcome && outcome.result !== undefined ? { result: outcome.result } : {}),
      ...("error" in outcome ? { error: outcome.error } : {}),
    })
    if (state === "succeeded") await engine.recordDestination(params).catch(() => {})
    return this.opView(op)
  }

  /** Reads a `vault` transfer by its signature until it is terminal, for ten minutes at most. */
  private watchTransfer(op: Operation, params: TransferParams): void {
    this.cancelWatch(op.opId)
    const startedAt = this.deps.now()
    const tick = async (): Promise<void> => {
      this.watches.delete(op.opId)
      if (await this.readTransfer(op, params)) return
      const delay = nextPollMs(startedAt, this.deps.now())
      if (delay === undefined) {
        if (op.state === "pending" || op.state === "submitting")
          await this.settle(op, "unknown", { reason: "watch_expired" })
        return
      }
      this.watches.set(
        op.opId,
        this.schedule(() => void tick(), delay),
      )
    }
    this.watches.set(
      op.opId,
      this.schedule(() => void tick(), 2_000),
    )
  }

  /** One status read of a `vault` transfer, applied (T-8). True when nothing is left to wait for. */
  private async readTransfer(op: Operation, params: TransferParams): Promise<boolean> {
    const engine = this.deps.transfers
    const ref = op.transfer
    if (engine === undefined || ref?.id === undefined) return true
    let status: TransferStatus
    try {
      status = await engine.status(ref)
    } catch {
      return false
    }
    if (status.state === "finalized") {
      await engine.dropPending(op.opId)
      await this.settle(op, "succeeded", { result: { id: ref.id, finalized: true } })
      await engine.recordDestination(params).catch(() => {})
      const wallet = this.deps.trading.vaultWallets()?.find((w) => w.id === params.source.walletId)
      if (wallet?.role === "tee-wallet") await engine.reportActivity?.(params, ref).catch(() => {})
      return true
    }
    if (status.state === "failed" || (status.state === "not_found" && status.expired)) {
      await engine.dropPending(op.opId)
      await this.settle(op, "failed", {
        error: {
          code: status.state === "failed" ? "TRANSFER_FAILED" : "TRANSFER_EXPIRED",
          message:
            status.state === "failed"
              ? terminalText(status.reason)
              : "It was never seen on chain and can no longer land. Nothing moved.",
        },
      })
      return true
    }
    return false
  }

  async reject(cardId: unknown, viewClientId: string): Promise<Card> {
    return this.close(cardId, "rejected", { by: viewClientId })
  }

  /** The proposer takes back a card it made. Another client's card answers as missing. */
  async withdraw(cardId: unknown, clientId: string): Promise<Card> {
    const entry = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (entry === undefined || entry.card.origin.clientId !== clientId)
      throw refused("CARD_NOT_FOUND", "No card with that id.")
    return this.close(cardId, "withdrawn", { by: clientId })
  }

  /** `clients.kill`: the killed client's open cards are withdrawn. */
  async withdrawAllFor(clientId: string): Promise<void> {
    for (const { card } of this.cards.values()) {
      if (isOpen(card) && card.origin.clientId === clientId)
        await this.close(card.cardId, "withdrawn", { by: "clients.kill" })
    }
  }

  /** C-3: with the last view gone, nobody can see an open card, so every one expires. */
  async expireAllOpen(reason: string): Promise<void> {
    for (const { card } of this.cards.values()) {
      if (isOpen(card) && !this.approving.has(card.cardId)) await this.close(card.cardId, "expired", { reason })
    }
  }

  async expireDue(): Promise<void> {
    const now = this.deps.now()
    for (const { card } of this.cards.values()) {
      if (isOpen(card) && !this.approving.has(card.cardId) && Date.parse(card.expiresAt) <= now) {
        await this.close(card.cardId, "expired", { reason: "expiresAt" })
      }
    }
  }

  /** Whether any operation is still in flight, for C-3's bounded wait before exit. */
  inFlight(): boolean {
    return [...this.operations.values()].some((op) => op.state === "submitting" || op.state === "pending")
  }

  /** K-7: write-ahead `submitting`, then the request, then the outcome. The id never changes. */
  private async execute(card: Card, writeKey: string): Promise<Operation> {
    const at = new Date(this.deps.now()).toISOString()
    const existing = this.operations.get(card.opId)
    const op: Operation = existing ?? {
      opId: card.opId,
      cardId: card.cardId,
      kind: card.kind,
      tool: card.tool,
      idKey: card.idKey,
      ownerClientId: card.origin.clientId,
      state: "submitting",
      createdAt: at,
      updatedAt: at,
    }
    op.state = "submitting"
    op.updatedAt = at
    this.operations.set(op.opId, op)
    // V-5: a fee claim has no id and no record, so the amounts before it are the only evidence.
    if (card.tool === "candle_claim_fees" && existing === undefined) {
      const before = await claimableFor(this.deps.executor, card.params.mint, writeKey).catch(() => undefined)
      op.evidence = { before }
    }
    await this.deps.journal.append({
      type: "operation.submitting",
      opId: op.opId,
      cardId: card.cardId,
      tool: card.tool,
      kind: card.kind,
      idKey: card.idKey,
      ownerClientId: op.ownerClientId,
      params: card.params,
      ...(op.evidence ? { evidence: op.evidence } : {}),
    })
    this.publishOperation(op)
    let outcome: ExecutionOutcome
    try {
      outcome = await this.deps.executor.execute(card.tool, card.params, writeKey)
    } catch (error) {
      outcome = {
        state: "unknown",
        error: { code: "EXECUTOR_FAILED", message: error instanceof Error ? error.message : String(error) },
      }
    }
    await this.settle(op, outcome.state, {
      ...("result" in outcome && outcome.result !== undefined ? { result: outcome.result } : {}),
      ...("error" in outcome ? { error: outcome.error } : {}),
    })
    // R-2 on a lost answer: read it back by its id now, and keep reading while it runs.
    const settled = op.state as OperationState
    if (settled === "unknown" || settled === "pending") this.watch(op, writeKey)
    return this.opView(op)
  }

  /**
   * R-3. `check` reads the operation again (the Write key is sealed, so it takes the factor);
   * `resend` sends the SAME request under the SAME id and always takes a fresh factor, because the
   * market has moved since the first approval; `abandon` stops tracking but keeps reading for ten
   * minutes when it can, recording anything that lands late. Only a view reaches this.
   */
  async resolve(
    input: { opId: unknown; action: unknown; factor: Factor | undefined },
    viewClientId: string,
  ): Promise<Operation> {
    const op = typeof input.opId === "string" ? this.operations.get(input.opId) : undefined
    if (op === undefined) throw refused("OPERATION_NOT_HELD", "The core holds no operation with that id.")
    const card = this.cards.get(op.cardId)?.card
    if (card === undefined) throw refused("OPERATION_NOT_HELD", "The card behind this operation is not held.")
    const action = input.action
    if (card.kind === "transfer") return this.resolveTransfer(op, card, action, input.factor, viewClientId)
    if (action !== "check" && action !== "resend" && action !== "abandon") {
      throw invalidParams("action is check, resend or abandon.")
    }
    const open = op.state === "unknown" || (action === "check" && op.state === "pending")
    if (!open) {
      throw refused("OPERATION_NOT_UNKNOWN", `This operation is ${op.state}; there is nothing to resolve.`, {
        state: op.state,
      })
    }
    if (action === "check" && !readsById(card) && card.tool !== "candle_claim_fees") {
      throw refused(
        "CHECK_NOT_AVAILABLE",
        "This kind cannot be read by its id; only a re-send of the same request can tell.",
      )
    }
    if (action === "resend" && input.factor === undefined) {
      throw refused("FACTOR_REQUIRED", "A re-send always needs a fresh factor.")
    }
    if (action === "abandon" && input.factor === undefined) {
      await this.abandon(op, undefined, viewClientId)
      return this.opView(op)
    }
    return this.deps.trading.withCredentials(
      { kind: card.kind, viewClientId, factor: input.factor },
      async (credentials) => {
        if (action === "check") {
          await this.deps.journal.append({ type: "operation.check", opId: op.opId, viewClientId })
          await this.readBack(op, card, credentials.writeKey)
          return this.opView(op)
        }
        if (action === "abandon") {
          await this.abandon(op, credentials.writeKey, viewClientId)
          return this.opView(op)
        }
        await this.deps.journal.append({ type: "operation.resend", opId: op.opId, cardId: card.cardId, viewClientId })
        op.resolution = "resent"
        this.cancelWatch(op.opId)
        return this.execute(card, credentials.writeKey)
      },
    )
  }

  /**
   * T-8 for transfers, which S1 R-3's "re-send the same request" would get wrong:
   *
   *   - `vault`: `check` reads the signature (or hash) by RPC, with no key; `rebroadcast` sends the
   *     SAME stored bytes while they can still land, never a fresh build, with a fresh factor;
   *     `abandon` stops tracking.
   *   - `embedded`: the core cannot read it back by id, so the user says what they found:
   *     `attest_sent` or `attest_not_sent`, both journaled as the user's statement. It is never
   *     sent again; a new transfer is a new card with the typed `confirm` and a fresh factor.
   */
  private async resolveTransfer(
    op: Operation,
    card: Card,
    action: unknown,
    factor: Factor | undefined,
    viewClientId: string,
  ): Promise<Operation> {
    if (op.state !== "unknown" && !(action === "check" && op.state === "pending")) {
      throw refused("OPERATION_NOT_UNKNOWN", `This operation is ${op.state}; there is nothing to resolve.`, {
        state: op.state,
      })
    }
    const params = card.params as unknown as TransferParams
    const source = op.transfer?.source ?? params.source.kind
    if (source === "embedded") {
      if (action !== "attest_sent" && action !== "attest_not_sent") {
        throw refused(
          "TRANSFER_NEVER_RESENT",
          "An embedded-wallet transfer is never sent again. Check the source wallet in an explorer, then say whether it was sent.",
        )
      }
      await this.settle(op, action === "attest_sent" ? "attested_sent" : "attested_not_sent", {
        viewClientId,
        statement: "user",
      })
      return this.opView(op)
    }
    const engine = this.deps.transfers
    if (engine === undefined) throw refused("NOT_IN_THIS_BUILD", "Transfers are not in this build of the core.")
    if (action === "check") {
      await this.deps.journal.append({ type: "operation.check", opId: op.opId, viewClientId })
      if (!(await this.readTransfer(op, params))) this.publishOperation(op)
      return this.opView(op)
    }
    if (action === "abandon") {
      this.cancelWatch(op.opId)
      await engine.dropPending(op.opId)
      op.resolution = "abandoned"
      await this.settle(op, "resolved_abandoned", { viewClientId, watching: false })
      return this.opView(op)
    }
    if (action !== "rebroadcast") {
      throw refused(
        "TRANSFER_NEVER_RESENT",
        "A transfer is never signed again under the same operation. Send the same signed bytes (rebroadcast), or start a new transfer.",
      )
    }
    // A fresh factor before the bytes go out again, as every re-send needs one (R-3).
    await this.deps.trading.withVaultSigner(
      { viewClientId, factor, reason: card.display.transfer?.describeSend ?? "send a transfer again" },
      async () => undefined,
    )
    const signed = await engine.readPending(op.opId)
    if (signed === undefined || op.transfer?.id === undefined || signed.id !== op.transfer.id) {
      throw refused(
        "REBROADCAST_NOT_AVAILABLE",
        "The signed bytes for this transfer are not held any more. Check it instead.",
      )
    }
    if (await this.readTransfer(op, params)) return this.opView(op)
    await this.deps.journal.append({ type: "operation.rebroadcast", opId: op.opId, viewClientId, id: signed.id })
    await engine.broadcast(signed).catch(() => undefined)
    await this.settle(op, "pending", { result: { id: signed.id, finalized: false }, source: "rebroadcast" })
    this.watchTransfer(op, params)
    return this.opView(op)
  }

  /**
   * Rebuilds the book from the journal at core start, before any client attaches (C-3, R-2). An
   * open card from the last run expires, because nobody approved it in a view that still exists.
   * An operation still `submitting` or `pending` becomes `unknown`: its answer was lost with the
   * process, and reading it back needs the factor.
   */
  async rebuild(rows: readonly JournalRow[]): Promise<{ expired: number; unknown: number }> {
    for (const row of rows) {
      if (row.type === "card.created" && row.card && typeof row.card === "object") {
        const card = row.card as Card
        this.cards.set(card.cardId, { card, proposedKey: typeof row.proposedKey === "string" ? row.proposedKey : "" })
        continue
      }
      const cardState = /^card\.(approved|rejected|withdrawn|expired)$/.exec(row.type)?.[1] as CardState | undefined
      if (cardState && typeof row.cardId === "string") {
        const entry = this.cards.get(row.cardId)
        if (entry) entry.card.state = cardState
        continue
      }
      if (row.type === "operation.submitting" && typeof row.opId === "string" && typeof row.cardId === "string") {
        const card = this.cards.get(row.cardId)?.card
        const previous = this.operations.get(row.opId)
        this.operations.set(row.opId, {
          ...(previous ?? {}),
          opId: row.opId,
          cardId: row.cardId,
          kind: (card?.kind ?? row.kind) as CardKind,
          tool: String(row.tool ?? card?.tool ?? ""),
          idKey: (card?.idKey ?? row.idKey) as IdKey,
          ownerClientId: String(row.ownerClientId ?? card?.origin.clientId ?? ""),
          state: "submitting",
          createdAt: previous?.createdAt ?? row.at,
          updatedAt: row.at,
          ...(row.evidence ? { evidence: row.evidence as Operation["evidence"] } : {}),
          ...(row.transfer && typeof row.transfer === "object" ? { transfer: row.transfer as TransferRef } : {}),
        })
        continue
      }
      const op = typeof row.opId === "string" ? this.operations.get(row.opId) : undefined
      if (op === undefined) continue
      if (row.type === "operation.resend") op.resolution = "resent"
      if (row.type === "operation.late_record") op.lateRecord = row.record
      if (row.type === "operation.evidence" && row.evidence) op.evidence = row.evidence as Operation["evidence"]
      const opState =
        /^operation\.(pending|succeeded|failed|refused|unknown|resolved_abandoned|attested_sent|attested_not_sent)$/.exec(
          row.type,
        )?.[1] as OperationState | undefined
      if (opState) {
        op.state = opState
        op.updatedAt = row.at
        if (opState === "resolved_abandoned") op.resolution = "abandoned"
        if (row.result !== undefined) op.result = row.result
        if (row.error && typeof row.error === "object") op.error = row.error as Operation["error"]
      }
    }
    let expired = 0
    for (const { card } of this.cards.values()) {
      if (card.state === "awaiting_approval" || card.state === "proposed") {
        card.state = "expired"
        await this.deps.journal.append({ type: "card.expired", cardId: card.cardId, reason: "core_restarted" })
        expired++
      }
    }
    let unknown = 0
    for (const op of this.operations.values()) {
      if (op.state === "submitting" || op.state === "pending") {
        await this.settle(op, "unknown", { reason: "core_restarted" })
        unknown++
      }
      // A transfer is read by its signature with no key (T-8); everything else readable needs the factor.
      if (op.state === "unknown")
        op.readNeedsFactor = op.kind !== "transfer" && (readsById(op) || op.tool === "candle_claim_fees")
    }
    return { expired, unknown }
  }

  private async abandon(op: Operation, writeKey: string | undefined, viewClientId: string): Promise<void> {
    op.resolution = "abandoned"
    const watching = this.watches.has(op.opId)
    await this.settle(op, "resolved_abandoned", {
      viewClientId,
      watching: watching || (writeKey !== undefined && readsById(op)),
    })
    if (!watching && writeKey !== undefined) this.watch(op, writeKey)
  }

  /** One read of `op`, applied. Returns true when there is nothing more to wait for. */
  private async readBack(op: Operation, card: Card, writeKey: string): Promise<boolean> {
    if (card.tool === "candle_claim_fees") {
      const after = await claimableFor(this.deps.executor, card.params.mint, writeKey).catch(() => undefined)
      op.evidence = { ...(op.evidence ?? {}), after }
      await this.deps.journal.append({ type: "operation.evidence", opId: op.opId, evidence: op.evidence })
      this.publishOperation(op)
      return true
    }
    const verdict = await readOnce(this.deps.executor, card, writeKey).catch(
      () => ({ readable: true, found: false }) as const,
    )
    if (!verdict.readable) return true
    if (!verdict.found) return false
    // A record for an operation the user stopped tracking is recorded beside it, not adopted.
    if (op.state === "resolved_abandoned") {
      op.lateRecord = verdict.record
      await this.deps.journal.append({ type: "operation.late_record", opId: op.opId, record: verdict.record })
      this.publishOperation(op)
      return true
    }
    if (verdict.state !== op.state) await this.settle(op, verdict.state, { result: verdict.record, source: "read" })
    else op.result = verdict.record
    return verdict.state !== "pending"
  }

  /**
   * Polls `op` by its id with the Write key of the approval that sent it, held in this closure
   * only, for ten minutes at most (R-2's cadence). Ends at a terminal record. Kinds with no read
   * by id are not watched: they wait for the user.
   */
  private watch(op: Operation, writeKey: string): void {
    const card = this.cards.get(op.cardId)?.card
    if (card === undefined || !readsById(card)) return
    this.cancelWatch(op.opId)
    const startedAt = this.deps.now()
    const tick = async (): Promise<void> => {
      this.watches.delete(op.opId)
      if (await this.readBack(op, card, writeKey)) return
      const delay = nextPollMs(startedAt, this.deps.now())
      if (delay === undefined) {
        // Ten minutes and nothing terminal: the user reads it again with the factor.
        if (op.state === "pending" || op.state === "submitting")
          await this.settle(op, "unknown", { reason: "watch_expired" })
        op.readNeedsFactor = true
        return
      }
      this.watches.set(
        op.opId,
        this.schedule(() => void tick(), delay),
      )
    }
    // A lost answer is read at once; a running one, one interval out.
    this.watches.set(
      op.opId,
      this.schedule(() => void tick(), op.state === "pending" ? 5_000 : 0),
    )
  }

  private cancelWatch(opId: string): void {
    this.watches.get(opId)?.()
    this.watches.delete(opId)
  }

  /** Moves `op` to `state`, journals it, and publishes it. */
  private async settle(op: Operation, state: OperationState, detail: Record<string, unknown>): Promise<void> {
    op.state = state
    op.updatedAt = new Date(this.deps.now()).toISOString()
    if (detail.result !== undefined) op.result = detail.result
    if (detail.error && typeof detail.error === "object") op.error = detail.error as Operation["error"]
    await this.deps.journal.append({ type: `operation.${state}`, opId: op.opId, cardId: op.cardId, ...detail })
    this.publishOperation(op)
  }

  private async close(
    cardId: unknown,
    state: "rejected" | "withdrawn" | "expired",
    detail: Record<string, unknown>,
  ): Promise<Card> {
    const entry = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (entry === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    const card = entry.card
    if (!isOpen(card) || this.approving.has(card.cardId)) {
      throw refused("CARD_NOT_AWAITING", `This card is ${card.state}.`, { state: card.state })
    }
    card.state = state
    await this.deps.journal.append({ type: `card.${state}`, cardId: card.cardId, ...detail })
    this.publish(card)
    return this.view(card)
  }

  private byOpId(opId: string): Entry | undefined {
    for (const entry of this.cards.values()) if (entry.card.opId === opId) return entry
    return undefined
  }

  private opIdFor(idKey: IdKey, params: Record<string, unknown>): string {
    const given = params[idKey]
    if (idKey === "rewardId") {
      if (typeof given !== "string" || given.length === 0) throw invalidParams("rewardId names the reward to claim.")
      return given
    }
    if (idKey === "coreOpId") return `op_${randomBytes(12).toString("base64url")}`
    if (typeof given === "string" && given.length > 0 && given.length <= 128) {
      if (idKey === "clientId" && !PERPS_CLIENT_ID.test(given))
        throw invalidParams("clientId is 0x and 32 hex characters.")
      return given
    }
    if (idKey === "clientId") return `0x${randomBytes(16).toString("hex")}`
    if (idKey === "clientDepositId") return `deposit-${randomUUID()}`
    return randomUUID()
  }

  private view(card: Card): Card {
    return JSON.parse(JSON.stringify(card)) as Card
  }

  /** The card an operation id belongs to, with its operation, or undefined for an id the core never issued. */
  held(opId: string): (Card & { operation?: Operation }) | undefined {
    const entry = this.byOpId(opId)
    return entry ? this.viewWithOperation(entry.card) : undefined
  }

  private viewWithOperation(card: Card): Card & { operation?: Operation } {
    const op = this.operations.get(card.opId)
    return op ? { ...this.view(card), operation: this.opView(op) } : this.view(card)
  }

  private opView(op: Operation): Operation {
    const view = JSON.parse(JSON.stringify(op)) as Operation
    if (op.state === "unknown" && op.kind === "transfer") {
      const embedded = op.transfer?.source === "embedded"
      view.reconcile = {
        actions: embedded ? ["attest_sent", "attest_not_sent"] : ["check", "rebroadcast", "abandon"],
        message: transferReconcileMessage(embedded ? "embedded" : "vault", op.transfer?.id),
      }
      return view
    }
    if (op.state === "unknown") {
      const readable = readsById(op) || op.tool === "candle_claim_fees"
      view.reconcile = {
        actions: readable ? ["check", "resend", "abandon"] : ["resend", "abandon"],
        message: reconcileMessage(op.kind, readable),
      }
    }
    return view
  }

  private publish(card: Card): void {
    this.deps.events.publish("cards", { card: this.view(card) }, card.origin.clientId)
  }

  private publishOperation(op: Operation): void {
    this.deps.events.publish("operations", { operation: this.opView(op) }, op.ownerClientId)
  }

  private async refusal(origin: CardOrigin, tool: string, code: string): Promise<void> {
    await this.deps.journal.append({ type: "card.refused", clientId: origin.clientId, role: origin.role, tool, code })
  }
}

/** K-2: sha256 of canonical JSON {kind, tool, params, opId, environment, profile}, lowercase hex. */
export function hashCard(input: {
  kind: CardKind
  tool: string
  params: Record<string, unknown>
  opId: string
  environment: CoreEnvironment
  profile: string
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")
}

const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? terminalText(String(value)) : ""

/** What the card draws, from `params` only in this slice. Contract addresses are never shortened. */
function displayFor(
  kind: CardKind,
  tool: string,
  params: Record<string, unknown>,
  environment: CoreEnvironment,
  keyLimitUsd?: string,
): Card["display"] {
  const contract = text(params.mint ?? params.outputMint ?? params.tokenMint ?? params.token ?? params.address ?? "")
  const chain = text(params.chain) || (contract.startsWith("0x") ? "hood" : contract ? "solana" : "")
  const side = text(params.side ?? params.direction)
  const symbol = text(params.symbol ?? params.ticker)
  const amount = text(
    params.amount ??
      params.amountUsd ??
      params.devBuy ??
      (params.percent !== undefined ? `${text(params.percent)}%` : ""),
  )
  const title = [
    kind === "trade" ? (side || "trade").toUpperCase() : kind.toUpperCase(),
    symbol ? `$${symbol}` : tool,
  ].join(" ")
  return { title, contract, chain, amount, environment, ...(keyLimitUsd ? { keyLimitUsd } : {}) }
}

/** The card's amount in USD micros, when its params say it: an explicit USD amount, or a stablecoin quote. */
export function cardUsdMicros(card: Pick<Card, "params">): number | undefined {
  const params = card.params
  const decimal = (value: unknown) => {
    const n =
      typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : undefined
  }
  if (params.amountUsd !== undefined) return decimal(params.amountUsd)
  const quote = typeof params.quoteAsset === "string" ? params.quoteAsset.toLowerCase() : ""
  if ((quote === "usdc" || quote === "usdg") && params.side !== "sell") return decimal(params.amount)
  return undefined
}

/** A card a user may still act on: awaiting approval, or a launch waiting for its dry run (L-4). */
function isOpen(card: Card): boolean {
  return card.state === "awaiting_approval" || card.state === "proposed"
}

function withoutKey(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = params
  return rest
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** JSON with every object's keys sorted, nulls kept: a stable digest of an API answer (L-4 step 3). */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${sortedJson(inner)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
