/**
 * Quant over an agent key (BE-1678's `/api/v1/agent/quant/*`; spec S5 Q-2, BE-1737): a plain HTTP
 * client for the five key routes, with the route spec's timing rules. It holds no state: the caller
 * keeps the `clientTurnId`, the poll cursor and anything it shows.
 *
 *   GET  /status                     5 s
 *   POST /turns {text, clientTurnId}  5 s   (resend the same `clientTurnId` after a lost answer)
 *   GET  /turns/:id/events?after=    35 s  (one held poll, about 25 s on the server)
 *   POST /turns/:id/cancel           5 s
 *   GET  /history?before=&limit=     5 s
 *
 * A refusal is read as `body.code ?? body.error?.code`: the Quant handlers answer `{code, ...}` (the
 * relay shape), the key middleware answers `{success: false, error: {code}}` (the envelope shape),
 * and `RATE_LIMITED` comes in both, meaning different limits. `shape` says which one arrived.
 *
 * The key is sent as `x-api-key` and never follows a redirect (`redirect: "error"`), so it cannot be
 * forwarded to another host. Use a Read key (`account:read`): Quant needs nothing more.
 *
 * Dependency-free on purpose. The CLI carries a byte-identical copy (`packages/cli/src/quant.ts`,
 * kept equal by `quant.drift.test.ts`). Copy any change verbatim:
 * `cp packages/sdk/src/quant.ts packages/cli/src/quant.ts`.
 */

export const QUANT_AGENT_PATH = "/api/v1/agent/quant"
export const QUANT_CALL_TIMEOUT_MS = 5_000
export const QUANT_POLL_TIMEOUT_MS = 35_000
/** hacc's B0 figure, used until a status read says otherwise (the route's `DEFAULT_MAX_TEXT_CHARS`). */
export const QUANT_DEFAULT_MAX_TEXT_CHARS = 4_000

/** `GET /status`. With the switch off the route answers `{enabled: false}` and nothing else. */
export interface QuantKeyStatus {
  enabled: boolean
  allowed?: boolean
  tier?: string | null
  marketAccess?: boolean
  linked?: boolean
  remaining?: number | null
  maxTextChars?: number | null
  activeTurnId?: string | null
}

export interface QuantTurnStarted {
  turnId: string
  cursor?: number
}

/** One event of a turn: `turn_started`, `working`, `tool_started`, `tool_finished`, `text`, `done`, `error`. */
export interface QuantTurnEvent {
  seq: number
  kind: string
  data: Record<string, unknown>
  createdAt?: string
}

export interface QuantEventsPage {
  events: QuantTurnEvent[]
  next: number
  /** `running`, or the terminal state (`done`, `error`, `cancelled`, ...). */
  status: string
}

export interface QuantHistoryItem {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: string
}

export interface QuantHistoryPage {
  items: QuantHistoryItem[]
  next: string | null
}

/**
 * Why a call did not succeed. `shape` is `relay` for `{code}`, `envelope` for `{error: {code}}`, and
 * `transport` when no answer arrived (`NETWORK_ERROR`, `TIMEOUT`) or it could not be read
 * (`BAD_RESPONSE`): a lost answer to `POST /turns` is safe to resend with the same `clientTurnId`.
 */
export interface QuantRefusal {
  code: string
  status: number
  shape: "relay" | "envelope" | "transport"
  retryable?: boolean
  resetsAt?: string | number
  turnId?: string
  limit?: number
}

export type QuantAnswer<T> = { ok: true; status: number; body: T } | { ok: false; refusal: QuantRefusal }

export interface QuantKeyClientOptions {
  apiUrl: string
  apiKey: string
  fetch?: typeof fetch
  callTimeoutMs?: number
  pollTimeoutMs?: number
}

export interface QuantKeyClient {
  status(): Promise<QuantAnswer<QuantKeyStatus>>
  sendTurn(input: { text: string; clientTurnId: string }): Promise<QuantAnswer<QuantTurnStarted>>
  events(turnId: string, after: number, options?: { signal?: AbortSignal }): Promise<QuantAnswer<QuantEventsPage>>
  cancel(turnId: string): Promise<QuantAnswer<Record<string, unknown>>>
  history(input?: { before?: string; limit?: number }): Promise<QuantAnswer<QuantHistoryPage>>
}

/** Unicode code points, the unit hacc counts `maxTextChars` in. */
export function quantCodePoints(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** A `clientTurnId`: a uuid v4, kept with the draft until a `turnId` arrives. */
export function newClientTurnId(): string {
  return crypto.randomUUID()
}

/** The refusal code of a body in either shape, or undefined when it names none. */
export function quantRefusalCode(body: unknown): string | undefined {
  const record = asRecord(body)
  if (typeof record?.code === "string") return record.code
  const inner = asRecord(record?.error)
  return typeof inner?.code === "string" ? inner.code : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function refusalOf(status: number, body: unknown): QuantRefusal {
  const record = asRecord(body) ?? {}
  const relayCode = typeof record.code === "string" ? record.code : undefined
  const code = quantRefusalCode(body) ?? `HTTP_${status}`
  const refusal: QuantRefusal = { code, status, shape: relayCode !== undefined ? "relay" : "envelope" }
  if (typeof record.retryable === "boolean") refusal.retryable = record.retryable
  if (typeof record.resetsAt === "string" || typeof record.resetsAt === "number") refusal.resetsAt = record.resetsAt
  if (typeof record.turnId === "string") refusal.turnId = record.turnId
  if (typeof record.limit === "number") refusal.limit = record.limit
  return refusal
}

function parseStatus(body: unknown): QuantKeyStatus | undefined {
  const b = asRecord(body)
  if (typeof b?.enabled !== "boolean") return undefined
  const status: QuantKeyStatus = { enabled: b.enabled }
  if (typeof b.allowed === "boolean") status.allowed = b.allowed
  if (typeof b.tier === "string" || b.tier === null) status.tier = b.tier
  if (typeof b.marketAccess === "boolean") status.marketAccess = b.marketAccess
  if (typeof b.linked === "boolean") status.linked = b.linked
  if (typeof b.remaining === "number" || b.remaining === null) status.remaining = b.remaining
  if (typeof b.maxTextChars === "number" || b.maxTextChars === null) status.maxTextChars = b.maxTextChars
  if (typeof b.activeTurnId === "string" || b.activeTurnId === null) status.activeTurnId = b.activeTurnId
  return status
}

function parseTurn(body: unknown): QuantTurnStarted | undefined {
  const b = asRecord(body)
  if (typeof b?.turnId !== "string" || b.turnId.length === 0) return undefined
  return { turnId: b.turnId, ...(typeof b.cursor === "number" ? { cursor: b.cursor } : {}) }
}

function parseEvents(body: unknown): QuantEventsPage | undefined {
  const b = asRecord(body)
  if (!b || !Array.isArray(b.events) || typeof b.next !== "number" || typeof b.status !== "string") return undefined
  const events: QuantTurnEvent[] = []
  for (const raw of b.events) {
    const e = asRecord(raw)
    if (typeof e?.seq !== "number" || typeof e.kind !== "string") continue
    events.push({
      seq: e.seq,
      kind: e.kind,
      data: asRecord(e.data) ?? {},
      ...(typeof e.createdAt === "string" ? { createdAt: e.createdAt } : {}),
    })
  }
  return { events, next: b.next, status: b.status }
}

function parseHistory(body: unknown): QuantHistoryPage | undefined {
  const b = asRecord(body)
  if (!b || !Array.isArray(b.items)) return undefined
  const items: QuantHistoryItem[] = []
  for (const raw of b.items) {
    const item = asRecord(raw)
    if (typeof item?.id !== "string" || typeof item.text !== "string") continue
    if (item.role !== "user" && item.role !== "assistant") continue
    items.push({
      id: item.id,
      role: item.role,
      text: item.text,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    })
  }
  return { items, next: typeof b.next === "string" ? b.next : null }
}

/** The key client. Refuses an `http://` API URL other than this machine's: the key would travel in clear. */
export function createQuantKeyClient(options: QuantKeyClientOptions): QuantKeyClient {
  const base = new URL(options.apiUrl)
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]"
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    throw new Error("Quant needs an https API URL: the key would otherwise travel in clear.")
  }
  const root = base.toString().replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch
  const callMs = options.callTimeoutMs ?? QUANT_CALL_TIMEOUT_MS
  const pollMs = options.pollTimeoutMs ?? QUANT_POLL_TIMEOUT_MS

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    parse: (body: unknown) => T | undefined,
    opts: { body?: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<QuantAnswer<T>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, opts.timeoutMs)
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const response = await doFetch(`${root}${QUANT_AGENT_PATH}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          "x-api-key": options.apiKey,
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) return { ok: false, refusal: refusalOf(response.status, body) }
      const parsed = parse(body)
      if (parsed === undefined) {
        return { ok: false, refusal: { code: "BAD_RESPONSE", status: response.status, shape: "transport" } }
      }
      return { ok: true, status: response.status, body: parsed }
    } catch {
      return {
        ok: false,
        refusal: { code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", status: 0, shape: "transport", retryable: true },
      }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  const turnPath = (turnId: string) => `/turns/${encodeURIComponent(turnId)}`
  return {
    status: () => call("GET", "/status", parseStatus, { timeoutMs: callMs }),
    sendTurn: (input) =>
      call("POST", "/turns", parseTurn, {
        body: { text: input.text, clientTurnId: input.clientTurnId },
        timeoutMs: callMs,
      }),
    events: (turnId, after, opts) =>
      call("GET", `${turnPath(turnId)}/events?after=${Math.max(0, Math.floor(after))}`, parseEvents, {
        timeoutMs: pollMs,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      }),
    cancel: (turnId) =>
      call("POST", `${turnPath(turnId)}/cancel`, (body) => asRecord(body) ?? {}, { timeoutMs: callMs }),
    history: (input = {}) => {
      const query = new URLSearchParams()
      if (input.before !== undefined) query.set("before", input.before)
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const encoded = query.toString()
      const suffix = encoded ? `?${encoded}` : ""
      return call("GET", `/history${suffix}`, parseHistory, { timeoutMs: callMs })
    },
  }
}
