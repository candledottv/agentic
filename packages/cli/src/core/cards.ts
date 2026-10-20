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
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { terminalText } from "../render"
import { canonicalJson } from "../vault/canonical-json"
import { type CardKind, cardLifetimeMs, classifyCall, FACTOR_KINDS, type IdKey } from "./classify"
import type { EventHub } from "./events"
import type { CoreEnvironment, Journal, JournalRow } from "./journal"
import { claimableFor, nextPollMs, readOnce, readsById, reconcileMessage } from "./reconcile"
import { invalidParams, refused } from "./rpc"
import { type Factor, formatKeyLimit, type TradingState } from "./trading"

export type CardState = "proposed" | "awaiting_approval" | "approved" | "rejected" | "withdrawn" | "expired"
export type OperationState =
  | "submitting"
  | "pending"
  | "succeeded"
  | "failed"
  | "refused"
  | "unknown"
  | "resolved_resent"
  | "resolved_abandoned"

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
  }
  policy: "ask"
  needsFactor: boolean
  createdAt: string
  expiresAt: string
  state: CardState
  proposalKey?: string
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
  reconcile?: { actions: ("check" | "resend" | "abandon")[]; message: string }
}

export type ExecutionOutcome =
  | { state: "succeeded" | "pending"; result: unknown }
  | { state: "failed" | "refused"; error: { code: string; message: string }; result?: unknown }
  | { state: "unknown"; error: { code: string; message: string } }

/** Sends one tool call with the Write key. The real one is `executor.ts`; tests pass a fake API. */
export interface Executor {
  execute(tool: string, params: Record<string, unknown>, writeKey: string): Promise<ExecutionOutcome>
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
    // K-3: no harness, and no agent text, can start a transfer.
    if (kind === "transfer") {
      await this.refusal(origin, tool, origin.role === "harness" ? "TRANSFER_USER_ONLY" : "TRANSFER_NOT_IN_THIS_BUILD")
      if (origin.role === "harness")
        throw refused("TRANSFER_USER_ONLY", "Only you can start a transfer, from the Candle TUI.")
      throw refused("TRANSFER_NOT_IN_THIS_BUILD", "Transfers from the TUI arrive with the transfer screens.")
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
      const open = entry.card.state === "awaiting_approval"
      if (
        open &&
        entry.card.origin.clientId === origin.clientId &&
        entry.proposedKey === proposedKey &&
        entry.card.proposalKey === proposalKey
      ) {
        return this.view(entry.card)
      }
    }
    const openByClient = [...this.cards.values()].filter(
      (e) => e.card.state === "awaiting_approval" && e.card.origin.clientId === origin.clientId,
    ).length
    if (openByClient >= OPEN_CARD_CAP) {
      await this.refusal(origin, tool, "TOO_MANY_OPEN_CARDS")
      throw refused("TOO_MANY_OPEN_CARDS", `A client may hold ${OPEN_CARD_CAP} open cards at once.`)
    }

    const opId = this.opIdFor(idKey, proposed)
    const sent = idKey === "coreOpId" || idKey === "rewardId" ? proposed : { ...proposed, [idKey]: opId }
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
      display: displayFor(kind, tool, sent, this.deps.environment, formatKeyLimit(this.deps.trading.lastKeyLimit())),
      policy: "ask",
      needsFactor: FACTOR_KINDS.has(kind),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + cardLifetimeMs(kind)).toISOString(),
      state: "awaiting_approval",
      ...(proposalKey !== undefined ? { proposalKey } : {}),
    }
    this.cards.set(card.cardId, { card, proposedKey })
    await this.deps.journal.append({ type: "card.created", card, proposedKey })
    this.publish(card)
    return this.view(card)
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
    input: { cardId: unknown; cardHash: unknown; factor: Factor | undefined },
    viewClientId: string,
  ): Promise<{ card: Card; operation: Operation }> {
    await this.expireDue()
    const entry = typeof input.cardId === "string" ? this.cards.get(input.cardId) : undefined
    if (entry === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    const card = entry.card
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
      if (card.state === "awaiting_approval" && card.origin.clientId === clientId)
        await this.close(card.cardId, "withdrawn", { by: "clients.kill" })
    }
  }

  /** C-3: with the last view gone, nobody can see an open card, so every one expires. */
  async expireAllOpen(reason: string): Promise<void> {
    for (const { card } of this.cards.values()) {
      if (card.state === "awaiting_approval" && !this.approving.has(card.cardId))
        await this.close(card.cardId, "expired", { reason })
    }
  }

  async expireDue(): Promise<void> {
    const now = this.deps.now()
    for (const { card } of this.cards.values()) {
      if (card.state === "awaiting_approval" && !this.approving.has(card.cardId) && Date.parse(card.expiresAt) <= now) {
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
        })
        continue
      }
      const op = typeof row.opId === "string" ? this.operations.get(row.opId) : undefined
      if (op === undefined) continue
      if (row.type === "operation.resend") op.resolution = "resent"
      if (row.type === "operation.late_record") op.lateRecord = row.record
      if (row.type === "operation.evidence" && row.evidence) op.evidence = row.evidence as Operation["evidence"]
      const opState = /^operation\.(pending|succeeded|failed|refused|unknown|resolved_abandoned)$/.exec(
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
      if (op.state === "unknown") op.readNeedsFactor = readsById(op) || op.tool === "candle_claim_fees"
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
    if (card.state !== "awaiting_approval" || this.approving.has(card.cardId)) {
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
