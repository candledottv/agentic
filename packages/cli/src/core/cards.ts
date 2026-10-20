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
 * Not in this slice: re-reading quotes onto a card (`display.estimate`), the key-limit check against
 * a fresh read (`OVER_KEY_LIMIT`), rebuilding open cards from the journal at start, and the
 * reconciliation of `unknown` operations. Those arrive with R and the screens.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { terminalText } from "../render"
import { canonicalJson } from "../vault/canonical-json"
import { type CardKind, cardLifetimeMs, classifyCall, FACTOR_KINDS, type IdKey } from "./classify"
import type { EventHub } from "./events"
import type { CoreEnvironment, Journal } from "./journal"
import { invalidParams, refused } from "./rpc"
import type { Factor, TradingState } from "./trading"

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
    },
  ) {}

  /** Expires cards on a one-second sweep; `stop` ends it. */
  start(): void {
    this.sweep = setInterval(() => void this.expireDue(), 1000)
    this.sweep.unref?.()
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
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
    const proposalKey = typeof input.proposalKey === "string" ? input.proposalKey.slice(0, 128) : undefined
    const proposedKey = canonicalJson({ tool, params: proposed })

    // A-5: an id the core already holds is a read when the request is the same, a conflict when not.
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
        return this.view(held.card)
      }
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
      display: displayFor(kind, tool, sent, this.deps.environment),
      policy: "ask",
      needsFactor: FACTOR_KINDS.has(kind),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + cardLifetimeMs(kind)).toISOString(),
      state: "awaiting_approval",
      ...(proposalKey !== undefined ? { proposalKey } : {}),
    }
    this.cards.set(card.cardId, { card, proposedKey })
    await this.deps.journal.append({ type: "card.created", card })
    this.publish(card)
    return this.view(card)
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
      .map((op) => ({ ...op }))
  }

  operation(opId: unknown, clientId: string, ownOnly: boolean): Operation {
    const op = typeof opId === "string" ? this.operations.get(opId) : undefined
    if (op === undefined || (ownOnly && op.ownerClientId !== clientId))
      throw refused("OPERATION_NOT_HELD", "The core holds no operation with that id.")
    return { ...op }
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
    }
    this.operations.set(op.opId, op)
    await this.deps.journal.append({
      type: "operation.submitting",
      opId: op.opId,
      cardId: card.cardId,
      tool: card.tool,
      idKey: card.idKey,
      params: card.params,
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
    op.state = outcome.state
    op.updatedAt = new Date(this.deps.now()).toISOString()
    if ("result" in outcome && outcome.result !== undefined) op.result = outcome.result
    if ("error" in outcome) op.error = outcome.error
    await this.deps.journal.append({
      type: `operation.${op.state}`,
      opId: op.opId,
      cardId: card.cardId,
      result: op.result,
      error: op.error,
    })
    this.publishOperation(op)
    return { ...op }
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

  private publish(card: Card): void {
    this.deps.events.publish("cards", { card: this.view(card) }, card.origin.clientId)
  }

  private publishOperation(op: Operation): void {
    this.deps.events.publish("operations", { operation: { ...op } }, op.ownerClientId)
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
  return { title, contract, chain, amount, environment }
}
