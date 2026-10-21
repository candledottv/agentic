/**
 * Signals in the core (BE-1737, spec S5 G-1 to G-3): one socket to the public tape per core, the
 * `signals` topic, and the core-local read tool `candle_get_signals`.
 *
 * G-1. The socket is `/api/v1/hacc-signals/stream` on the core's environment, with no key. It is
 * opened when a view or harness subscribes to `signals` or a harness calls `candle_get_signals`,
 * and closed 5 minutes after the last subscriber leaves. One socket keeps the core inside the
 * route's 8-per-IP cap with web tabs open (Q-I8). The cache holds the latest 100 rows, merged by
 * `haccId` with the API's own rules (`mergeTapeRow`, `sortTape`; `signals.test.ts` pins equal
 * output). A `snapshot` frame replaces the cache. Reconnects back off 1, 2, 5, 15, 30 s; a refused
 * upgrade (429 or 503) holds at 30 s and the status says "paused".
 *
 * The watchlist. `GET /api/v1/agent/tracked-wallets` with the Read key, at a view's `scope: "mine"`
 * subscribe and every 5 minutes while one lasts. It is used only to filter "Mine" (`signals:mine`,
 * view only). A harness's `signals` subscription and `candle_get_signals` carry the "All" rows
 * only and take no `mine` argument, so nothing a harness reads says which wallets the user
 * watches (Q-I10).
 *
 * G-3, Q-I9. A row is data. Nothing here creates a card, fills an amount or makes a call.
 */
import type { EventHub } from "./events"

export const SIGNAL_TAPE_CAP = 100
export const SIGNAL_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const
export const SIGNAL_PAUSED_BACKOFF_MS = 30_000
export const SIGNAL_IDLE_CLOSE_MS = 5 * 60_000
export const WATCHLIST_REFRESH_MS = 5 * 60_000
export const SIGNAL_QUERY_WAIT_MS = 5_000
export const SIGNAL_QUERY_DEFAULT_LIMIT = 20

/** A tape row as the API's stream sends it (`apps/api/src/lib/signal-tape.ts`, `TapeRow`). */
export type TapeRow = {
  haccId: number
  pattern: string
  summary: string
  chain: "solana" | "hood"
  mint: string
  createdAt: number
  symbol?: string
  marketCap?: number
  walletLabel?: string
  wallet?: string
}

export interface WatchedWallet {
  chain: "solana" | "hood"
  address: string
}

export type TapeState = "closed" | "connecting" | "live" | "backoff"

// ── The API's merge rules, copied (pinned to `apps/api/src/lib/signal-tape.ts` by a test) ─────

export function mergeTapeRow(prev: TapeRow | undefined, next: TapeRow): TapeRow {
  return {
    ...next,
    ...(next.symbol === undefined && prev?.symbol !== undefined ? { symbol: prev.symbol } : {}),
    ...(next.walletLabel === undefined && prev?.walletLabel !== undefined ? { walletLabel: prev.walletLabel } : {}),
    ...(next.marketCap === undefined && prev?.marketCap !== undefined ? { marketCap: prev.marketCap } : {}),
  }
}

export function sortTape(rows: TapeRow[]): TapeRow[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || b.haccId - a.haccId)
}

export function replaceTape(rows: TapeRow[]): TapeRow[] {
  const byId = new Map<number, TapeRow>()
  for (const row of rows) byId.set(row.haccId, row)
  return sortTape([...byId.values()]).slice(0, SIGNAL_TAPE_CAP)
}

export function upsertTape(rows: TapeRow[], row: TapeRow): TapeRow[] {
  const prev = rows.find((r) => r.haccId === row.haccId)
  const merged = mergeTapeRow(prev, row)
  return sortTape([...rows.filter((r) => r.haccId !== row.haccId), merged]).slice(0, SIGNAL_TAPE_CAP)
}

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/

/** A row from the stream, read fail-closed: anything not in `TapeRow`'s shape is dropped. */
export function parseStreamRow(raw: unknown): TapeRow | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.haccId !== "number" || !Number.isFinite(r.haccId) || r.haccId <= 0) return undefined
  if (typeof r.pattern !== "string" || r.pattern.length === 0 || r.pattern.length > 64) return undefined
  if (typeof r.summary !== "string" || r.summary.length === 0) return undefined
  if (r.chain !== "solana" && r.chain !== "hood") return undefined
  if (typeof r.mint !== "string" || !(r.chain === "hood" ? EVM : SOLANA).test(r.mint)) return undefined
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return undefined
  const row: TapeRow = {
    haccId: r.haccId,
    pattern: r.pattern,
    summary: r.summary.slice(0, 1_000),
    chain: r.chain,
    mint: r.mint,
    createdAt: r.createdAt,
  }
  if (typeof r.symbol === "string" && r.symbol.length > 0) row.symbol = r.symbol.slice(0, 64)
  if (typeof r.marketCap === "number" && Number.isFinite(r.marketCap)) row.marketCap = r.marketCap
  if (typeof r.walletLabel === "string" && r.walletLabel.length > 0) row.walletLabel = r.walletLabel.slice(0, 128)
  if (typeof r.wallet === "string" && r.wallet.trim() !== "") row.wallet = r.wallet.trim()
  return row
}

// ── The socket ──────────────────────────────────────────────────────────────────────────────

export interface TapeHandlers {
  open(): void
  message(text: string): void
  /** `refusedStatus` when the upgrade was refused with an HTTP status the opener could read. */
  closed(info: { refusedStatus?: number }): void
}

export interface TapeConnection {
  close(): void
}

export type OpenTape = (url: string, handlers: TapeHandlers) => TapeConnection

/** The stream's URL on an API base: `https://x` becomes `wss://x/api/v1/hacc-signals/stream`. */
export function tapeUrl(apiUrl: string): string {
  return `${apiUrl
    .replace(/\/+$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")}/api/v1/hacc-signals/stream`
}

/**
 * The runtime's WebSocket as an {@link OpenTape}, or undefined when there is none. A refused upgrade
 * reaches a WebSocket client as an error event whose text, on Bun, names the status; a 429 or 503
 * read from it holds the backoff. When the text names none, the ordinary backoff applies.
 */
export function webSocketOpener(
  WebSocketImpl: typeof WebSocket | undefined = globalThis.WebSocket,
): OpenTape | undefined {
  if (WebSocketImpl === undefined) return undefined
  return (url, handlers) => {
    const socket = new WebSocketImpl(url)
    let opened = false
    let refusedStatus: number | undefined
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      handlers.closed(refusedStatus !== undefined ? { refusedStatus } : {})
    }
    socket.addEventListener("open", () => {
      opened = true
      handlers.open()
    })
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") handlers.message(event.data)
    })
    socket.addEventListener("error", (event) => {
      const text = String((event as { message?: unknown }).message ?? "")
      const status = /\b(429|503)\b/.exec(text)?.[1]
      if (!opened && status) refusedStatus = Number(status)
    })
    socket.addEventListener("close", finish)
    return {
      close: () => {
        finished = true
        socket.close()
      },
    }
  }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────

export interface SignalQuery {
  chain?: "solana" | "hood"
  mint?: string
  pattern?: string
  limit: number
}

/** `candle_get_signals`'s arguments. Any key but the four, `mine` and `kind` included, is refused. */
export function parseSignalQuery(args: Record<string, unknown>): SignalQuery | { error: string } {
  const allowed = new Set(["chain", "mint", "pattern", "limit"])
  const unknown = Object.keys(args).filter((key) => !allowed.has(key))
  if (unknown.length > 0)
    return { error: `candle_get_signals takes chain, mint, pattern and limit only, not ${unknown.join(", ")}.` }
  const query: SignalQuery = { limit: SIGNAL_QUERY_DEFAULT_LIMIT }
  if (args.chain !== undefined) {
    if (args.chain !== "solana" && args.chain !== "hood") return { error: "chain is solana or hood." }
    query.chain = args.chain
  }
  if (args.mint !== undefined) {
    if (typeof args.mint !== "string" || args.mint.length === 0 || args.mint.length > 64)
      return { error: "mint is a token address." }
    query.mint = args.mint
  }
  if (args.pattern !== undefined) {
    if (typeof args.pattern !== "string" || args.pattern.length === 0 || args.pattern.length > 64)
      return { error: "pattern is a signal pattern name." }
    query.pattern = args.pattern
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
      return { error: "limit is 1 to 100." }
    query.limit = args.limit
  }
  return query
}

export function sameWallet(chain: "solana" | "hood", a: string, b: string): boolean {
  return chain === "hood" ? a.toLowerCase() === b.toLowerCase() : a === b
}

export interface SignalServiceDeps {
  open: OpenTape | undefined
  url: string
  events: Pick<EventHub, "publish">
  /** The Read key's watchlist, or undefined when it could not be read (or the core holds no key). */
  readWatchlist: () => Promise<WatchedWallet[] | undefined>
  /** Timer seam; tests drive it by hand. */
  schedule?: (run: () => void, ms: number) => () => void
  /** The wait for a first snapshot when a tool call opens the socket. */
  waitForSnapshot?: (ms: number, ready: Promise<void>) => Promise<void>
}

export class SignalService {
  private rowsCache: TapeRow[] = []
  private socket: TapeConnection | undefined
  private state: TapeState = "closed"
  private pausedFlag = false
  private attempt = 0
  private snapshotSeen = false
  private waiters: (() => void)[] = []
  private idleCancel: (() => void) | undefined
  private retryCancel: (() => void) | undefined
  private watchCancel: (() => void) | undefined
  private watchlist: WatchedWallet[] | undefined
  private watchlistState: "none" | "loading" | "ok" | "failed" = "none"
  private counts = { all: 0, mine: 0 }
  /** How many sockets this service has opened: one per connect, never two at once (Q-I8). */
  opened = 0

  constructor(private readonly deps: SignalServiceDeps) {}

  private schedule(run: () => void, ms: number): () => void {
    if (this.deps.schedule) return this.deps.schedule(run, ms)
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }

  status(): { state: TapeState; paused: boolean; cached: number } {
    return { state: this.state, paused: this.pausedFlag, cached: this.rowsCache.length }
  }

  rows(): TapeRow[] {
    return [...this.rowsCache]
  }

  mine(): TapeRow[] {
    const list = this.watchlist ?? []
    return this.rowsCache.filter((row) => this.watched(row, list))
  }

  /** The `signals` snapshot: "All" rows. What a harness subscription gets. */
  snapshotAll(): Record<string, unknown> {
    return { type: "snapshot", rows: this.rows(), ...this.status() }
  }

  /** The `signals:mine` snapshot (view only): rows on the watchlist, and whether it was read. */
  snapshotMine(): Record<string, unknown> {
    return { type: "snapshot", rows: this.mine(), ...this.status(), watchlist: this.watchlistState }
  }

  /** Called whenever a subscription to `signals` or `signals:mine` comes or goes. */
  setSubscribers(all: number, mine: number): void {
    const hadMine = this.counts.mine > 0
    this.counts = { all, mine }
    if (all + mine > 0) {
      this.idleCancel?.()
      this.idleCancel = undefined
      this.ensureOpen()
    } else this.armIdle()
    if (mine > 0 && !hadMine) void this.refreshWatchlist()
    if (mine === 0 && hadMine) {
      this.watchCancel?.()
      this.watchCancel = undefined
    }
  }

  /** `candle_get_signals`: from the cache; opens the socket if closed and waits up to 5 s for a snapshot. */
  async query(query: SignalQuery): Promise<{ rows: TapeRow[]; stale: boolean }> {
    if (this.state === "closed") {
      this.ensureOpen()
      if (this.counts.all + this.counts.mine === 0) this.armIdle()
    }
    if (!this.snapshotSeen) {
      const ready = new Promise<void>((resolve) => this.waiters.push(resolve))
      const wait =
        this.deps.waitForSnapshot ??
        ((ms: number, until: Promise<void>) =>
          Promise.race([until, new Promise<void>((resolve) => this.schedule(resolve, ms))]))
      await wait(SIGNAL_QUERY_WAIT_MS, ready)
    }
    const rows = this.rowsCache
      .filter((row) => query.chain === undefined || row.chain === query.chain)
      .filter((row) => query.mint === undefined || sameWallet(row.chain, row.mint, query.mint))
      .filter((row) => query.pattern === undefined || row.pattern === query.pattern)
      .slice(0, query.limit)
    return { rows, stale: !this.snapshotSeen || this.state !== "live" }
  }

  stop(): void {
    this.state = "closed"
    this.idleCancel?.()
    this.retryCancel?.()
    this.watchCancel?.()
    this.idleCancel = undefined
    this.retryCancel = undefined
    this.watchCancel = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }

  private watched(row: TapeRow, list: readonly WatchedWallet[]): boolean {
    const wallet = row.wallet
    if (wallet === undefined) return false
    return list.some((entry) => entry.chain === row.chain && sameWallet(row.chain, entry.address, wallet))
  }

  private armIdle(): void {
    this.idleCancel?.()
    this.idleCancel = this.schedule(() => {
      this.idleCancel = undefined
      if (this.counts.all + this.counts.mine === 0) this.stop()
    }, SIGNAL_IDLE_CLOSE_MS)
  }

  private ensureOpen(): void {
    if (this.state === "closed") this.connect()
  }

  private publishStatus(): void {
    this.deps.events.publish("signals", { type: "status", ...this.status() })
    this.deps.events.publish("signals:mine", { type: "status", ...this.status(), watchlist: this.watchlistState })
  }

  private connect(): void {
    this.retryCancel = undefined
    if (this.deps.open === undefined) {
      this.state = "backoff"
      this.publishStatus()
      return
    }
    this.state = "connecting"
    this.opened++
    this.publishStatus()
    let current: TapeConnection | undefined
    const handlers: TapeHandlers = {
      open: () => {
        if (this.socket !== current) return
        this.state = "live"
        this.attempt = 0
        this.pausedFlag = false
        this.publishStatus()
      },
      message: (text) => {
        if (this.socket !== current) return
        this.onFrame(text)
      },
      closed: (info) => {
        if (this.socket !== current) return
        this.socket = undefined
        if (this.state === "closed") return
        this.pausedFlag = info.refusedStatus === 429 || info.refusedStatus === 503
        const delay = this.pausedFlag
          ? SIGNAL_PAUSED_BACKOFF_MS
          : (SIGNAL_BACKOFF_MS[Math.min(this.attempt, SIGNAL_BACKOFF_MS.length - 1)] as number)
        this.attempt++
        this.state = "backoff"
        this.publishStatus()
        this.retryCancel = this.schedule(() => {
          if (this.state === "backoff") this.connect()
        }, delay)
      },
    }
    current = this.deps.open(this.deps.url, handlers)
    this.socket = current
  }

  private onFrame(text: string): void {
    let frame: { type?: unknown; signals?: unknown; signal?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame === null || typeof frame !== "object") return
    if (frame.type === "snapshot" && Array.isArray(frame.signals)) {
      const parsed = frame.signals.map(parseStreamRow).filter((row): row is TapeRow => row !== undefined)
      this.rowsCache = replaceTape(parsed)
      this.snapshotSeen = true
      for (const resolve of this.waiters.splice(0)) resolve()
      this.deps.events.publish("signals", this.snapshotAll())
      this.deps.events.publish("signals:mine", this.snapshotMine())
      return
    }
    if (frame.type === "signal") {
      const row = parseStreamRow(frame.signal)
      if (row === undefined) return
      this.rowsCache = upsertTape(this.rowsCache, row)
      const merged = this.rowsCache.find((r) => r.haccId === row.haccId) ?? row
      this.deps.events.publish("signals", { type: "signal", row: merged })
      if (this.watched(merged, this.watchlist ?? []))
        this.deps.events.publish("signals:mine", { type: "signal", row: merged })
    }
  }

  private async refreshWatchlist(): Promise<void> {
    this.watchCancel?.()
    this.watchlistState = this.watchlist === undefined ? "loading" : this.watchlistState
    let list: WatchedWallet[] | undefined
    try {
      list = await this.deps.readWatchlist()
    } catch {
      list = undefined
    }
    if (this.counts.mine === 0) return
    if (list === undefined) this.watchlistState = "failed"
    else {
      this.watchlist = list
      this.watchlistState = "ok"
    }
    this.deps.events.publish("signals:mine", this.snapshotMine())
    this.watchCancel = this.schedule(() => void this.refreshWatchlist(), WATCHLIST_REFRESH_MS)
  }
}

/** `GET /api/v1/agent/tracked-wallets`'s rows as watched wallets; anything malformed is skipped. */
export function watchlistFrom(body: unknown): WatchedWallet[] | undefined {
  const wallets = (body as { wallets?: unknown } | undefined)?.wallets
  if (!Array.isArray(wallets)) return undefined
  const out: WatchedWallet[] = []
  for (const raw of wallets) {
    const row = raw as { chain?: unknown; address?: unknown } | null
    if ((row?.chain === "solana" || row?.chain === "hood") && typeof row.address === "string" && row.address)
      out.push({ chain: row.chain, address: row.address })
  }
  return out
}
