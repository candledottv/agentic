/**
 * Quant in the core (BE-1737, spec S5 Q-1 to Q-7): the four view-only methods `quant.status`,
 * `quant.send`, `quant.cancel` and `quant.history`, and the `quant` event topic.
 *
 * Q-1, Q-I1. Every call uses the core's Read key through the key route (`../quant.ts`, the SDK's
 * client). No Quant path reads the Write key, the device token or the vault, so Quant works with
 * trading off and on a profile with no Write key.
 *
 * Q-4, Q-I8. At most one held poll per account, whatever the number of attached views: this core
 * polls the active turn once and fans its events out on `quant`. That leaves the account's second
 * held poll (the route's `HELD_POLLS_PER_ACCOUNT`) to a web tab. `too_many_polls` waits 2 s and
 * polls again, up to 5 times; a lost connection polls again from `after = next` and never resends
 * a turn to recover events. A turn this core did not start (a web tab's, or one from before a
 * restart) is followed read-only from `after = 0`.
 *
 * Q-5, Q-I6, Q-I7. A send is refused here, before any call, when the text matches a value the
 * core holds, a Candle key's shape or a key parameter (`SECRET_IN_TEXT`, the K-10 redactor's
 * matcher), or when it is over `maxTextChars` in code points (`text_too_long`). The only context
 * the core adds is `Context: <chain> <address>`, when the view sends one; never a ticker, name,
 * description, summary, memory or wallet list. A lost answer to `POST /turns` is resent with the
 * same `clientTurnId`, which hacc answers with the same turn and no second spend; after 3 tries it
 * stops.
 *
 * Q-6, Q-I3. Nothing here writes to disk. The current turn's events and the last history page are
 * kept in memory; the journal gets no Quant row. Everything a view receives passes the server's
 * redactor (K-10), and the view strips control sequences before drawing (Q-7).
 */
import {
  QUANT_DEFAULT_MAX_TEXT_CHARS,
  type QuantKeyClient,
  type QuantKeyStatus,
  type QuantRefusal,
  quantCodePoints,
} from "../quant"
import { isPlausibleTokenAddress } from "./addresses"
import type { EventHub } from "./events"
import { invalidParams, type RpcError, refused } from "./rpc"
import type { CoreServer } from "./server"

export const QUANT_STATUS_TTL_MS = 30_000
export const QUANT_SEND_TRIES = 3
export const TOO_MANY_POLLS_WAIT_MS = 2_000
export const TOO_MANY_POLLS_RETRIES = 5
const LOST_POLL_RETRIES = 10

/**
 * The event kinds the web's chat handles. Others (the web's `block`, which it ignores too, or any
 * kind hacc adds) are ignored and counted (V-2): none of them can become a card.
 */
export const QUANT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn_started",
  "working",
  "tool_started",
  "tool_finished",
  "text",
  "done",
  "error",
])

/**
 * A turn that has not ended: hacc answers `queued` before a worker takes it and `running` while it
 * works (the web's `isLiveTurnStatus`, found against real hacc on 2026-10-14). Anything else ends it.
 */
export function isLiveTurnStatus(status: string): boolean {
  return status === "queued" || status === "running"
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TURN_ID = /^[A-Za-z0-9_-]{1,64}$/
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_SEND_BYTES = 64 * 1024

/** What `quant.status` answers: the route's status, plus whether the core can call it at all. */
export type CoreQuantStatus = QuantKeyStatus & {
  /** False when the core holds no Read key (the read-only skip): "Sign in to use Quant". */
  signedIn: boolean
  /** The Quant profile's Off switch (P-2). */
  on: boolean
  /** Whose turn the core is following, when one is active. */
  following: "here" | "elsewhere" | null
}

export interface QuantTurnContext {
  chain: "solana" | "hood"
  address: string
}

export interface QuantServiceDeps {
  /** A client over the core's Read key, or undefined when the core holds none. */
  client: () => QuantKeyClient | undefined
  /** The K-10 matcher: text is unchanged by it exactly when it carries nothing the core redacts. */
  redact: (text: string) => string
  events: Pick<EventHub, "publish">
  now: () => number
  /** The Quant profile's Off switch (P-2). */
  quantOn?: () => boolean
  sleep?: (ms: number) => Promise<void>
  debug?: (line: string) => void
}

interface Poll {
  turnId: string
  origin: "here" | "elsewhere"
  next: number
  stopped: boolean
  abort: AbortController
}

interface TurnMemory {
  turnId: string
  origin: "here" | "elsewhere"
  running: boolean
  events: { seq: number; kind: string; data: Record<string, unknown> }[]
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

/** One Quant refusal as an RPC refusal the view can branch on, with the fields it shows. */
function refusalError(refusal: QuantRefusal): RpcError {
  const details: Record<string, unknown> = { status: refusal.status, shape: refusal.shape }
  if (refusal.retryable !== undefined) details.retryable = refusal.retryable
  if (refusal.resetsAt !== undefined) details.resetsAt = refusal.resetsAt
  if (refusal.turnId !== undefined) details.turnId = refusal.turnId
  if (refusal.limit !== undefined) details.limit = refusal.limit
  return refused(refusal.code, `Quant refused: ${refusal.code}.`, details)
}

export class QuantService {
  private cached: { status: QuantKeyStatus; at: number } | undefined
  private poll: Poll | undefined
  private turn: TurnMemory | undefined
  private sending = false
  private lastHistory: unknown
  /** Turns followed to their end: a status that still names one never starts a second poll. */
  private readonly ended = new Set<string>()
  /** V-2: event kinds outside {@link QUANT_EVENT_KINDS}, ignored and counted. */
  unknownKinds = 0

  constructor(private readonly deps: QuantServiceDeps) {}

  private on(): boolean {
    return this.deps.quantOn?.() ?? true
  }

  private following(): CoreQuantStatus["following"] {
    return this.poll ? this.poll.origin : null
  }

  private withCore(status: QuantKeyStatus): CoreQuantStatus {
    return { ...status, signedIn: true, on: this.on(), following: this.following() }
  }

  /** What a view attaching to `quant` gets first: the status and the turn in memory. */
  snapshot(): { status: CoreQuantStatus | null; turn: TurnMemory | null } {
    return {
      status: this.cached ? this.withCore(this.cached.status) : null,
      turn: this.turn ? { ...this.turn, events: [...this.turn.events] } : null,
    }
  }

  /** `quant.status`: the route's status, cached 30 s, refreshed after every turn ends. */
  async status(options: { refresh?: boolean } = {}): Promise<CoreQuantStatus> {
    const client = this.deps.client()
    if (client === undefined) return { enabled: false, signedIn: false, on: this.on(), following: null }
    const fresh = this.cached && this.deps.now() - this.cached.at < QUANT_STATUS_TTL_MS
    if (fresh && options.refresh !== true && this.cached) return this.withCore(this.cached.status)
    const answer = await client.status()
    if (!answer.ok) throw refusalError(answer.refusal)
    const before = this.cached ? JSON.stringify(this.cached.status) : undefined
    this.cached = { status: answer.body, at: this.deps.now() }
    if (before !== JSON.stringify(answer.body)) this.publish({ kind: "status", data: this.withCore(answer.body) })
    // Q-4 and the restart edge case: a turn active on any surface is followed, never re-sent.
    const active = answer.body.activeTurnId
    if (
      answer.body.enabled &&
      typeof active === "string" &&
      TURN_ID.test(active) &&
      this.poll === undefined &&
      !this.ended.has(active)
    ) {
      this.follow(client, active, 0, "elsewhere")
    }
    return this.withCore(answer.body)
  }

  /** Starts the core's view of Quant: one status read, which follows a turn already active (T-20). */
  async start(): Promise<void> {
    if (!this.on()) return
    await this.status().catch(() => undefined)
  }

  stop(): void {
    if (this.poll) {
      this.poll.stopped = true
      this.poll.abort.abort()
      this.poll = undefined
    }
  }

  /** `quant.send {text, clientTurnId, context?}` (Q-5). Answers `{turnId}` once the route accepted it. */
  async send(params: Record<string, unknown>): Promise<{ turnId: string; text: string }> {
    const text = params.text
    const clientTurnId = params.clientTurnId
    if (typeof text !== "string" || text.trim().length === 0 || Buffer.byteLength(text, "utf8") > MAX_SEND_BYTES)
      throw invalidParams("text must be a non-empty string.")
    if (typeof clientTurnId !== "string" || !UUID.test(clientTurnId))
      throw invalidParams("clientTurnId must be a uuid, kept until a turnId arrives.")
    const context = parseContext(params.context)
    if (!this.on()) throw refused("QUANT_OFF", "Quant is off in the Agents tab.")
    const client = this.deps.client()
    if (client === undefined) throw refused("NO_READ_KEY", "Sign in to use Quant.")

    // Q-5 step 2: the only context, and the view showed it in the draft before Enter.
    const composed = context ? `Context: ${context.chain} ${context.address}\n${text}` : text
    // Q-5 step 3, Q-I7: nothing that looks like a key leaves the machine. Refused, never redacted.
    if (this.deps.redact(composed) !== composed)
      throw refused("SECRET_IN_TEXT", "That looks like a key. Candle never sends keys to Quant.")

    let status = await this.status()
    if (!status.enabled) throw refused("QUANT_DISABLED", "Quant isn't available on this server yet.")
    if (status.allowed === false) {
      status = await this.status({ refresh: true })
      if (status.allowed === false) throw refused("QUANT_NOT_ALLOWED", "Quant is unavailable right now.")
    }
    const limit = status.maxTextChars ?? QUANT_DEFAULT_MAX_TEXT_CHARS
    if (quantCodePoints(composed) > limit)
      throw refused("text_too_long", `Too long: up to ${limit} characters.`, { limit, unit: "codepoints" })
    if (this.sending || this.poll?.origin === "here")
      throw refused("turn_in_progress", "Quant is already answering.", { turnId: this.poll?.turnId ?? null })

    this.sending = true
    try {
      for (let attempt = 1; attempt <= QUANT_SEND_TRIES; attempt++) {
        const answer = await client.sendTurn({ text: composed, clientTurnId })
        if (answer.ok) {
          const turnId = answer.body.turnId
          if (!TURN_ID.test(turnId)) throw refused("BAD_RESPONSE", "Quant answered with a turn id it should not have.")
          // A web turn being followed read-only gives way to the turn this core started.
          this.stop()
          this.turn = { turnId, origin: "here", running: true, events: [] }
          this.publish({ turnId, kind: "sent", data: { text: composed }, seq: 0, origin: "here" })
          this.follow(client, turnId, 0, "here")
          return { turnId, text: composed }
        }
        // A lost answer: the same clientTurnId again, which hacc answers with the same turn.
        if (answer.refusal.shape === "transport") continue
        if (answer.refusal.code === "turn_in_progress" && answer.refusal.turnId && this.poll === undefined)
          this.follow(client, answer.refusal.turnId, 0, "elsewhere")
        throw refusalError(answer.refusal)
      }
      throw refused("QUANT_UNREACHABLE", "Quant is unavailable right now.", { tries: QUANT_SEND_TRIES })
    } finally {
      this.sending = false
    }
  }

  /** `quant.cancel {turnId}`. The poll sees the turn end; nothing else changes here. */
  async cancel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const turnId = params.turnId
    if (typeof turnId !== "string" || !TURN_ID.test(turnId)) throw invalidParams("turnId names the turn.")
    const client = this.deps.client()
    if (client === undefined) throw refused("NO_READ_KEY", "Sign in to use Quant.")
    const answer = await client.cancel(turnId)
    if (!answer.ok) throw refusalError(answer.refusal)
    return { turnId, cancelled: true }
  }

  /** `quant.history {before?, limit?}`: one page, newest first, limit 1 to 100. Kept in memory only. */
  async history(params: Record<string, unknown>): Promise<unknown> {
    const before = params.before
    const limit = params.limit
    if (before !== undefined && (typeof before !== "string" || !MESSAGE_ID.test(before)))
      throw invalidParams("before names a message id.")
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100))
      throw invalidParams("limit is 1 to 100.")
    const client = this.deps.client()
    if (client === undefined) throw refused("NO_READ_KEY", "Sign in to use Quant.")
    const answer = await client.history({
      ...(before !== undefined ? { before: before as string } : {}),
      ...(limit !== undefined ? { limit: limit as number } : {}),
    })
    if (!answer.ok) throw refusalError(answer.refusal)
    this.lastHistory = answer.body
    return answer.body
  }

  /** Whether the core is polling a turn now (Q-I8 needs at most one). */
  polling(): string | undefined {
    return this.poll?.turnId
  }

  /** The last history page read, in memory only (Q-6). */
  lastHistoryPage(): unknown {
    return this.lastHistory
  }

  private publish(data: Record<string, unknown>): void {
    this.deps.events.publish("quant", data)
  }

  private follow(client: QuantKeyClient, turnId: string, after: number, origin: Poll["origin"]): void {
    if (this.poll !== undefined) return
    const poll: Poll = { turnId, origin, next: after, stopped: false, abort: new AbortController() }
    this.poll = poll
    if (this.turn?.turnId !== turnId) this.turn = { turnId, origin, running: true, events: [] }
    void this.run(client, poll)
  }

  private async run(client: QuantKeyClient, poll: Poll): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep
    let tooMany = 0
    let lost = 0
    let failure: string | undefined
    while (!poll.stopped) {
      const answer = await client.events(poll.turnId, poll.next, { signal: poll.abort.signal })
      if (poll.stopped) return
      if (answer.ok) {
        tooMany = 0
        lost = 0
        for (const event of answer.body.events) {
          if (event.seq <= poll.next) continue
          poll.next = event.seq
          if (!QUANT_EVENT_KINDS.has(event.kind)) {
            this.unknownKinds++
            this.deps.debug?.(`[quant] ignored event kind ${event.kind.slice(0, 32)} (${this.unknownKinds} so far)`)
            continue
          }
          this.turn?.events.push({ seq: event.seq, kind: event.kind, data: event.data })
          this.publish({
            turnId: poll.turnId,
            kind: event.kind,
            data: event.data,
            seq: event.seq,
            origin: poll.origin,
          })
        }
        poll.next = Math.max(poll.next, answer.body.next)
        if (!isLiveTurnStatus(answer.body.status)) break
        continue
      }
      const refusal = answer.refusal
      if (refusal.code === "too_many_polls") {
        tooMany++
        if (tooMany > TOO_MANY_POLLS_RETRIES) {
          failure = "too_many_polls"
          break
        }
        await sleep(TOO_MANY_POLLS_WAIT_MS)
        continue
      }
      if (refusal.shape === "transport") {
        lost++
        if (lost > LOST_POLL_RETRIES) {
          failure = "QUANT_UNREACHABLE"
          break
        }
        await sleep(Math.min(1_000 * lost, 5_000))
        continue
      }
      failure = refusal.code
      break
    }
    if (this.poll !== poll) return
    this.poll = undefined
    this.ended.add(poll.turnId)
    if (this.ended.size > 100) this.ended.delete(this.ended.values().next().value as string)
    if (this.turn?.turnId === poll.turnId) this.turn.running = false
    if (failure !== undefined) {
      this.publish({
        turnId: poll.turnId,
        kind: "poll_failed",
        data: { code: failure },
        seq: poll.next,
        origin: poll.origin,
      })
    }
    // Refreshed after every turn ends, so `remaining` is the route's, never counted here.
    this.cached = undefined
    await this.status({ refresh: true }).catch(() => undefined)
  }
}

function parseContext(value: unknown): QuantTurnContext | undefined {
  if (value === undefined || value === null) return undefined
  const context = value as { chain?: unknown; address?: unknown }
  if (typeof context !== "object" || Array.isArray(context)) throw invalidParams("context is {chain, address}.")
  const extra = Object.keys(context).filter((key) => key !== "chain" && key !== "address")
  if (extra.length > 0) throw invalidParams("context carries only chain and address.")
  if (context.chain !== "solana" && context.chain !== "hood") throw invalidParams("context.chain is solana or hood.")
  if (typeof context.address !== "string" || !isPlausibleTokenAddress(context.chain, context.address))
    throw invalidParams("context.address must be a full token address on that chain.")
  return { chain: context.chain, address: context.address }
}

/** Registers `quant.*` (view only in the role table; a harness never reaches these, Q-I2). */
export function registerQuantHandlers(server: CoreServer, quant: QuantService): void {
  server.handle("quant.status", async (params) => quant.status({ refresh: params.refresh === true }))
  server.handle("quant.send", async (params) => quant.send(params))
  server.handle("quant.cancel", async (params) => quant.cancel(params))
  server.handle("quant.history", async (params) => quant.history(params))
  server.events.provideSnapshot("quant", () => quant.snapshot())
}
