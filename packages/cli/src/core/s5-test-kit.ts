/**
 * BE-1737 (spec S5): a fake API for the Quant key route, the tape socket and tracked wallets, with
 * the stub script's event shapes (`apps/api/src/services/quant/stub-client.ts`). Not a `*.test.ts`
 * file, and imported by nothing that ships.
 */
import type { OpenTape, TapeHandlers, TapeRow } from "./signals"

export interface FakeQuantCall {
  method: string
  path: string
  search: string
  key: string | null
  body: unknown
}

type Step = { kind: string; data: Record<string, unknown> }

/** The stub's script for a turn: a tool, three text events, done with `messagesLeft`. */
export function stubScript(reply: string, messagesLeft: number): Step[] {
  return [
    { kind: "turn_started", data: {} },
    { kind: "tool_started", data: { tool: "search_docs" } },
    { kind: "tool_finished", data: { tool: "search_docs", ok: true } },
    { kind: "text", data: { text: reply } },
    { kind: "done", data: { usage: { promptTokens: 0, completionTokens: 0, steps: 1 }, messagesLeft } },
  ]
}

export interface FakeQuantApi {
  calls: FakeQuantCall[]
  fetch: typeof fetch
  status: Record<string, unknown>
  /** Turns by id; `clientTurnId` dedupes as hacc does. */
  turns: Map<string, { clientTurnId: string; text: string; script: Step[]; cancelled: boolean }>
  /** Drop the answer to the next N `POST /turns` after the turn was created (a lost answer). */
  dropTurnAnswers: number
  /** Refuse the next N event polls with `too_many_polls`. */
  tooManyPolls: number
  /** The next `POST /turns` answers this refusal instead (status, body). */
  refuseTurn: { status: number; body: unknown } | undefined
  /** The script the next turn gets. */
  nextScript: Step[]
  /** Hold every poll until `releasePolls()`; counts how many are held at once. */
  holdPolls: boolean
  releasePolls(): void
  maxHeldPolls: number
  history: { id: string; role: "user" | "assistant"; text: string; createdAt: string }[]
  /** Other routes (tracked wallets, the core's own reads). */
  other?: (path: string, init: RequestInit) => Response | undefined
}

export function fakeQuantApi(seed: Partial<Pick<FakeQuantApi, "status" | "nextScript">> = {}): FakeQuantApi {
  let held = 0
  let waiting: (() => void)[] = []
  let turnSeq = 0
  const api: FakeQuantApi = {
    calls: [],
    status: seed.status ?? {
      enabled: true,
      allowed: true,
      tier: "pro",
      marketAccess: true,
      linked: false,
      remaining: 12,
      maxTextChars: 4000,
      activeTurnId: null,
    },
    turns: new Map(),
    dropTurnAnswers: 0,
    tooManyPolls: 0,
    refuseTurn: undefined,
    nextScript: seed.nextScript ?? stubScript("**Stub reply.**", 11),
    holdPolls: false,
    releasePolls() {
      const release = waiting
      waiting = []
      for (const resolve of release) resolve()
    },
    maxHeldPolls: 0,
    history: [],
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
      const method = init.method ?? "GET"
      api.calls.push({
        method,
        path: url.pathname,
        search: url.search,
        key: new Headers(init.headers).get("x-api-key"),
        body,
      })
      const route = url.pathname.replace(/^\/api\/v1\/agent\/quant/, "")
      if (!url.pathname.startsWith("/api/v1/agent/quant")) {
        return api.other?.(url.pathname, init) ?? new Response("{}", { status: 404 })
      }
      if (route === "/status") return Response.json(api.status)
      if (route === "/turns" && method === "POST") {
        if (api.refuseTurn) {
          const refusal = api.refuseTurn
          api.refuseTurn = undefined
          return Response.json(refusal.body, { status: refusal.status })
        }
        const { text, clientTurnId } = body as { text: string; clientTurnId: string }
        let turnId = [...api.turns.entries()].find(([, turn]) => turn.clientTurnId === clientTurnId)?.[0]
        if (turnId === undefined) {
          turnId = `turn_${++turnSeq}`
          api.turns.set(turnId, { clientTurnId, text, script: api.nextScript, cancelled: false })
        }
        if (api.dropTurnAnswers > 0) {
          api.dropTurnAnswers--
          throw new TypeError("socket hang up")
        }
        return Response.json({ turnId, cursor: 0 })
      }
      const events = /^\/turns\/([^/]+)\/events$/.exec(route)
      if (events) {
        if (api.tooManyPolls > 0) {
          api.tooManyPolls--
          return Response.json({ code: "too_many_polls", retryable: true }, { status: 429 })
        }
        const turn = api.turns.get(events[1] as string)
        if (!turn) return Response.json({ code: "not_found" }, { status: 404 })
        held++
        api.maxHeldPolls = Math.max(api.maxHeldPolls, held)
        try {
          if (api.holdPolls) await new Promise<void>((resolve) => waiting.push(resolve))
        } finally {
          held--
        }
        const after = Number(url.searchParams.get("after") ?? "0")
        const script = turn.cancelled
          ? [...turn.script.slice(0, 1), { kind: "error", data: { code: "cancelled" } }]
          : turn.script
        const all = script.map((step, i) => ({ seq: i + 1, kind: step.kind, data: step.data }))
        const fresh = all.filter((event) => event.seq > after)
        const last = all.at(-1)
        const terminal = last && (last.kind === "done" || last.kind === "error") ? last.kind : "running"
        return Response.json({ events: fresh, next: fresh.at(-1)?.seq ?? after, status: terminal })
      }
      const cancel = /^\/turns\/([^/]+)\/cancel$/.exec(route)
      if (cancel) {
        const turn = api.turns.get(cancel[1] as string)
        if (turn) turn.cancelled = true
        return Response.json({ cancelled: true })
      }
      if (route === "/history") return Response.json({ items: api.history, next: null })
      return Response.json({ code: "not_found" }, { status: 404 })
    }) as unknown as typeof fetch,
  }
  return api
}

/** A fake tape socket opener: records each open, and lets a test push frames or refuse. */
export function fakeTape() {
  const sockets: { url: string; handlers: TapeHandlers; closed: boolean }[] = []
  const open: OpenTape = (url, handlers) => {
    const socket = { url, handlers, closed: false }
    sockets.push(socket)
    return {
      close: () => {
        socket.closed = true
      },
    }
  }
  const live = () => sockets.filter((socket) => !socket.closed)
  return {
    open,
    sockets,
    live,
    accept(index = sockets.length - 1) {
      sockets[index]?.handlers.open()
    },
    snapshot(rows: TapeRow[], index = sockets.length - 1) {
      sockets[index]?.handlers.message(JSON.stringify({ type: "snapshot", signals: rows }))
    },
    signal(row: TapeRow, index = sockets.length - 1) {
      sockets[index]?.handlers.message(JSON.stringify({ type: "signal", signal: row }))
    },
    refuse(status: number, index = sockets.length - 1) {
      const socket = sockets[index]
      if (socket) {
        socket.closed = true
        socket.handlers.closed({ refusedStatus: status })
      }
    },
    drop(index = sockets.length - 1) {
      const socket = sockets[index]
      if (socket) {
        socket.closed = true
        socket.handlers.closed({})
      }
    },
  }
}

/** A manual clock and scheduler: `advance(ms)` runs what fell due, in order. */
export function manualTimers() {
  let now = 0
  const pending: { at: number; run: () => void; cancelled: boolean }[] = []
  return {
    now: () => now,
    schedule(run: () => void, ms: number) {
      const entry = { at: now + ms, run, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = pending.filter((entry) => !entry.cancelled && entry.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.cancelled = true
        now = due.at
        due.run()
      }
      now = until
    },
    pendingDelays: () => pending.filter((entry) => !entry.cancelled).map((entry) => entry.at - now),
  }
}

export const SOL_MINT_A = "So11111111111111111111111111111111111111112"
export const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"
export const WATCHED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
export const STRANGER = "3Kz9ePmZRgUhRw5w9tpb6ZHfbD5uYm2BvDWq9w8pLsXe"

export function tapeRow(id: number, extra: Partial<TapeRow> = {}): TapeRow {
  return {
    haccId: id,
    pattern: "whale_buy",
    summary: `whale bought ${id}`,
    chain: "solana",
    mint: WIF,
    createdAt: 1_700_000_000_000 + id * 1000,
    symbol: "WIF",
    ...extra,
  }
}
