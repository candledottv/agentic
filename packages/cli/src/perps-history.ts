/**
 * Hyperliquid perps history (spec 2026-10-17-hyperliquid-phase1-c-small-items-design.md, sections 3
 * and 4): one page of a wallet's fills or funding, read directly from Hyperliquid's public `/info`.
 *
 * The caller resolves the wallet (its own EVM TEE wallet, through Candle) and passes its address;
 * this module never sees a Candle credential and never sends one to Hyperliquid. It reads the
 * network-pinned `/info` URL, never one a server names.
 *
 * Paging: the window is fixed on the first call (`endTime` defaults to that call's clock, the start
 * to seven days before it). Rows are sorted by time with a stable identity tie-break and walked in
 * order; a page ends when it holds `limit` rows. The cursor records where the walk stopped: the
 * timestamp of the last row consumed and the identities consumed at exactly that timestamp. The
 * next call reads from that timestamp inclusively and skips only those identities, so a fetched
 * row the page had no room for is read again, never discarded, and a run of rows sharing one
 * millisecond is never skipped by a `time + 1`. The cursor is bound to its network, wallet, kind,
 * window and page size, and is refused when any of them changes.
 *
 * The market list comes from `readHyperliquidMarkets` in `hyperliquid-markets.ts` (Spec B's shared
 * main-perp reader), so there is one client for it. The history reads keep their own request,
 * because their failures carry what that reader drops: a 429's `Retry-After`, and which read failed.
 *
 * `packages/cli/src/perps-history.ts` and `packages/mcp/src/perps-history.ts` are byte-identical
 * copies of this file (drift tests enforce it). Its one import is the sibling markets module, which
 * each of those packages carries byte for byte too.
 */
import { readHyperliquidMarkets } from "./hyperliquid-markets"

export type PerpsHistoryKind = "fills" | "funding"
export type PerpsHistoryNetwork = "mainnet" | "testnet"

/** Hyperliquid's public `/info` endpoint per network. Mirrors `HYPERLIQUID_INFO_URLS`. */
export const PERPS_HISTORY_INFO_URLS: Readonly<Record<PerpsHistoryNetwork, string>> = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
}

/** Rows a page holds when the caller names no limit. */
export const PERPS_HISTORY_DEFAULT_LIMIT = 100
/** The most rows one upstream response carries, and so the largest page: 2,000 fills, 500 funding rows. */
export const PERPS_HISTORY_MAX_LIMIT: Readonly<Record<PerpsHistoryKind, number>> = { fills: 2_000, funding: 500 }
/** The default window: the seven days before `endTime`. */
export const PERPS_HISTORY_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Upstream history requests one call may make before it stops with a resumable cursor. */
export const PERPS_HISTORY_REQUEST_BUDGET = 10
/** Hyperliquid serves only an account's 10,000 most recent fills; a cursor chain scans no more. */
export const PERPS_HISTORY_FILL_RETENTION = 10_000
/** The longest cursor accepted, in characters. */
export const PERPS_HISTORY_MAX_CURSOR_LENGTH = 200_000
/** How long one upstream request may take. */
export const PERPS_HISTORY_TIMEOUT_MS = 15_000

export interface PerpsHistoryOptions {
  /** Inclusive epoch milliseconds. Default: seven days before `endTime`. */
  startTime?: number
  /** Inclusive epoch milliseconds. Default: the first call's clock. */
  endTime?: number
  /** Rows per page. Default 100; at most 2,000 for fills and 500 for funding. */
  limit?: number
  /** `nextCursor` from the previous page. Other options, when given, must match it. */
  cursor?: string
}

export interface PerpsHistoryWarning {
  code: "PERPS_HISTORY_RETENTION_LIMIT" | "PERPS_HISTORY_PAGE_BUDGET" | "PERPS_HISTORY_BOUNDARY_LIMIT"
  message: string
}

/** One fill exactly as Hyperliquid reports it; decimal values stay strings. */
export type PerpsFillRow = Record<string, unknown> & {
  coin: string
  time: number
  tid: number
  oid: number
  px: string
  sz: string
  side: string
  dir?: string
  closedPnl: string
  /** Already includes `builderFee`; never subtract the builder fee again. */
  fee: string
  feeToken?: string
  builderFee?: string
}

/** One funding payment exactly as Hyperliquid reports it. `delta.usdc` is signed: negative is paid. */
export type PerpsFundingRow = Record<string, unknown> & {
  time: number
  hash: string
  delta: Record<string, unknown> & { coin: string; usdc: string; fundingRate: string; szi: string }
}

interface PageBase {
  success: true
  walletId: string
  address: string
  network: PerpsHistoryNetwork
  source: "hyperliquid"
  /** When this page was read, epoch milliseconds. */
  readAt: number
  startTime: number
  endTime: number
  /** Pass back as `cursor` for the next page; null when the window is read to its end. */
  nextCursor: string | null
  hasMore: boolean
  /** True when coverage stopped short of the window for a venue or budget limit, not for paging. */
  truncated: boolean
  warnings: PerpsHistoryWarning[]
}

export type PerpsFillsPage = PageBase & { fills: PerpsFillRow[] }
export type PerpsFundingPage = PageBase & { funding: PerpsFundingRow[] }

/** A refusal or an upstream failure. `code` is `VALIDATION_FAILED` or `PERPS_UNAVAILABLE`. */
export class PerpsHistoryError extends Error {
  constructor(
    readonly code: "VALIDATION_FAILED" | "PERPS_UNAVAILABLE",
    message: string,
    readonly extra: { field?: string; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = "PerpsHistoryError"
  }
}

export type PerpsHistoryFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>

export interface PerpsHistoryRequest {
  kind: PerpsHistoryKind
  network: PerpsHistoryNetwork
  walletId: string
  /** The wallet's EVM address: the Hyperliquid account. */
  address: string
  options?: PerpsHistoryOptions
  fetch: PerpsHistoryFetch
  now: () => number
}

const RETENTION_TEXT =
  "Hyperliquid serves only the 10,000 most recent fills for an account; older fills cannot be read here, and this history is not an all-time total."

interface CursorState {
  v: 1
  k: PerpsHistoryKind
  n: PerpsHistoryNetwork
  w: string
  s: number
  e: number
  l: number
  /** The timestamp the next read starts from, inclusively. */
  t: number
  /** Identities already consumed at exactly `t`. */
  b: string[]
  /** Distinct venue fills consumed so far in this chain, kept rows and excluded ones alike. */
  c: number
}

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function invalid(field: string, message: string): PerpsHistoryError {
  return new PerpsHistoryError("VALIDATION_FAILED", message, { field })
}

function unavailable(message: string, retryAfterMs?: number): PerpsHistoryError {
  return new PerpsHistoryError("PERPS_UNAVAILABLE", message, {
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(text: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url")
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function encodeCursor(state: CursorState): string {
  return `ph1.${base64UrlEncode(JSON.stringify(state))}`
}

function decodeCursor(cursor: string): CursorState {
  if (cursor.length > PERPS_HISTORY_MAX_CURSOR_LENGTH || !cursor.startsWith("ph1."))
    throw invalid("cursor", "cursor is not one this client issued")
  let state: CursorState
  try {
    state = JSON.parse(base64UrlDecode(cursor.slice(4))) as CursorState
  } catch {
    throw invalid("cursor", "cursor is not one this client issued")
  }
  const ok =
    state !== null &&
    typeof state === "object" &&
    state.v === 1 &&
    (state.k === "fills" || state.k === "funding") &&
    (state.n === "mainnet" || state.n === "testnet") &&
    typeof state.w === "string" &&
    EVM_ADDRESS_RE.test(state.w) &&
    isTime(state.s) &&
    isTime(state.e) &&
    state.s <= state.e &&
    Number.isSafeInteger(state.l) &&
    state.l >= 1 &&
    state.l <= PERPS_HISTORY_MAX_LIMIT[state.k] &&
    isTime(state.t) &&
    state.t >= state.s &&
    state.t <= state.e &&
    Array.isArray(state.b) &&
    state.b.every((id) => typeof id === "string" && id.length <= 512) &&
    Number.isSafeInteger(state.c) &&
    state.c >= 0
  if (!ok) throw invalid("cursor", "cursor is not one this client issued")
  return state
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value)
}

function asFill(raw: unknown): PerpsFillRow {
  const row = raw as Record<string, unknown>
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.coin !== "string" ||
    !isTime(row.time) ||
    !Number.isSafeInteger(row.tid) ||
    !Number.isSafeInteger(row.oid) ||
    !isDecimalString(row.px) ||
    !isDecimalString(row.sz) ||
    typeof row.side !== "string" ||
    !isDecimalString(row.closedPnl) ||
    !isDecimalString(row.fee) ||
    (row.builderFee !== undefined && !isDecimalString(row.builderFee))
  )
    throw unavailable("Hyperliquid returned a fill this client cannot read")
  return row as PerpsFillRow
}

function asFunding(raw: unknown): PerpsFundingRow {
  const row = raw as Record<string, unknown>
  const delta = row?.delta as Record<string, unknown> | undefined
  if (
    !row ||
    typeof row !== "object" ||
    !isTime(row.time) ||
    typeof row.hash !== "string" ||
    !delta ||
    typeof delta !== "object" ||
    typeof delta.coin !== "string" ||
    !isDecimalString(delta.usdc) ||
    !isDecimalString(delta.fundingRate) ||
    !isDecimalString(delta.szi)
  )
    throw unavailable("Hyperliquid returned a funding payment this client cannot read")
  return row as PerpsFundingRow
}

/** A fill's venue trade identity, or a funding payment's (hash, time, coin and the whole delta). */
function identity(kind: PerpsHistoryKind, row: PerpsFillRow | PerpsFundingRow): string {
  if (kind === "fills") {
    const fill = row as PerpsFillRow
    return `${fill.coin}|${fill.tid}|${fill.oid}`
  }
  const funding = row as PerpsFundingRow
  return `${funding.hash}|${funding.time}|${funding.delta.coin}|${canonical(funding.delta)}`
}

function rowCoin(kind: PerpsHistoryKind, row: PerpsFillRow | PerpsFundingRow): string {
  return kind === "fills" ? (row as PerpsFillRow).coin : (row as PerpsFundingRow).delta.coin
}

async function postInfo(req: PerpsHistoryRequest, body: Record<string, unknown>, what: string): Promise<unknown> {
  const controller = typeof AbortController === "function" ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), PERPS_HISTORY_TIMEOUT_MS) : null
  let res: Awaited<ReturnType<PerpsHistoryFetch>>
  try {
    res = await req.fetch(PERPS_HISTORY_INFO_URLS[req.network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    throw unavailable(
      aborted
        ? `Hyperliquid did not answer the ${what} read in time; retry shortly`
        : `Hyperliquid could not be reached for the ${what} read; retry shortly`,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res.ok) {
    if (res.status === 429) {
      const header = res.headers?.get("retry-after") ?? null
      const seconds = header !== null && /^[0-9]{1,6}$/.test(header.trim()) ? Number(header.trim()) : undefined
      throw unavailable(
        `Hyperliquid rate-limited the ${what} read${seconds !== undefined ? `; retry after ${seconds}s` : "; retry shortly"}`,
        seconds !== undefined ? seconds * 1000 : undefined,
      )
    }
    throw unavailable(`Hyperliquid answered the ${what} read with HTTP ${res.status}; retry shortly`)
  }
  try {
    return JSON.parse(await res.text())
  } catch {
    throw unavailable(`Hyperliquid returned an unreadable ${what} response`)
  }
}

/** Every main-perp market name, delisted ones included: historical rows are not held to today's markets. */
async function mainPerpCoins(req: PerpsHistoryRequest): Promise<Set<string>> {
  let universe: { name: string }[]
  try {
    universe = (await readHyperliquidMarkets(req.fetch, req.network)).universe
  } catch {
    throw unavailable("Hyperliquid's market list could not be read; history is not reported without it")
  }
  if (universe.length === 0)
    throw unavailable("Hyperliquid's market list could not be read; history is not reported without it")
  return new Set(universe.map((market) => market.name))
}

function resolveWindow(req: PerpsHistoryRequest): { state: CursorState } {
  const options = req.options ?? {}
  const kind = req.kind
  const address = req.address.toLowerCase()
  if (!EVM_ADDRESS_RE.test(address)) throw invalid("wallet", "The wallet's Hyperliquid account is not an EVM address")
  for (const field of ["startTime", "endTime"] as const) {
    const value = options[field]
    if (value !== undefined && !isTime(value))
      throw invalid(field, `${field} must be a whole, non-negative number of epoch milliseconds`)
  }
  const max = PERPS_HISTORY_MAX_LIMIT[kind]
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > max))
    throw invalid("limit", `limit must be a whole number from 1 to ${max} for ${kind}`)

  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || options.cursor.length === 0)
      throw invalid("cursor", "cursor is not one this client issued")
    const state = decodeCursor(options.cursor)
    if (state.k !== kind) throw invalid("cursor", `This cursor pages ${state.k}, not ${kind}`)
    if (state.n !== req.network) throw invalid("cursor", `This cursor pages ${state.n}, not ${req.network}`)
    if (state.w !== address) throw invalid("cursor", "This cursor pages another wallet")
    if (
      (options.startTime !== undefined && options.startTime !== state.s) ||
      (options.endTime !== undefined && options.endTime !== state.e) ||
      (options.limit !== undefined && options.limit !== state.l)
    )
      throw invalid("cursor", "The window or page size changed; start again without a cursor")
    return { state }
  }

  const endTime = options.endTime ?? req.now()
  const startTime = options.startTime ?? Math.max(0, endTime - PERPS_HISTORY_DEFAULT_WINDOW_MS)
  if (!isTime(endTime)) throw invalid("endTime", "endTime must be epoch milliseconds")
  if (startTime > endTime) throw invalid("startTime", "startTime must not be after endTime")
  return {
    state: {
      v: 1,
      k: kind,
      n: req.network,
      w: address,
      s: startTime,
      e: endTime,
      l: options.limit ?? PERPS_HISTORY_DEFAULT_LIMIT,
      t: startTime,
      b: [],
      c: 0,
    },
  }
}

/**
 * Read one page. Validation runs before any request, so a bad bound, limit or cursor makes no I/O.
 * A rate limit, a timeout, a malformed answer or an unreadable market list throws `PERPS_UNAVAILABLE`
 * and the caller's cursor stays good for a retry; nothing is ever reported as an empty success.
 */
export async function readPerpsHistoryPage(req: PerpsHistoryRequest): Promise<PerpsFillsPage | PerpsFundingPage> {
  const { state } = resolveWindow(req)
  const kind = req.kind
  const max = PERPS_HISTORY_MAX_LIMIT[kind]
  const readAt = req.now()
  const coins = await mainPerpCoins(req)
  const page: (PerpsFillRow | PerpsFundingRow)[] = []
  const warnings: PerpsHistoryWarning[] = []
  let t = state.t
  let boundary = new Set(state.b)
  let consumed = state.c
  let done = false
  let truncated = false
  let requests = 0

  const stop = (code: PerpsHistoryWarning["code"], message: string, ends: boolean) => {
    warnings.push({ code, message })
    if (ends) {
      done = true
      truncated = true
    }
  }

  walk: while (page.length < state.l && !done) {
    if (requests >= PERPS_HISTORY_REQUEST_BUDGET) {
      stop(
        "PERPS_HISTORY_PAGE_BUDGET",
        `Stopped after ${PERPS_HISTORY_REQUEST_BUDGET} Hyperliquid reads; pass nextCursor to continue`,
        false,
      )
      break
    }
    const body =
      kind === "fills"
        ? { type: "userFillsByTime", user: state.w, startTime: t, endTime: state.e, aggregateByTime: false }
        : { type: "userFunding", user: state.w, startTime: t, endTime: state.e }
    const raw = await postInfo(req, body, kind === "fills" ? "fills" : "funding")
    requests++
    if (!Array.isArray(raw)) throw unavailable(`Hyperliquid returned an unreadable ${kind} response`)
    const rows = raw.map((r) => (kind === "fills" ? asFill(r) : asFunding(r)))
    const keyed = rows
      .map((row) => ({ row, id: identity(kind, row) }))
      .sort((a, b) => a.row.time - b.row.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const full = rows.length >= max
    const startedAt = t
    let previousId: string | null = null
    for (const { row, id } of keyed) {
      if (id === previousId) continue
      previousId = id
      if (row.time < t || row.time > state.e || (row.time === t && boundary.has(id))) continue
      if (page.length >= state.l) break walk
      if (row.time > t) {
        t = row.time
        boundary = new Set()
      }
      boundary.add(id)
      consumed++
      if (coins.has(rowCoin(kind, row))) page.push(row)
      if (kind === "fills" && consumed >= PERPS_HISTORY_FILL_RETENTION) {
        stop(
          "PERPS_HISTORY_RETENTION_LIMIT",
          "Reached Hyperliquid's 10,000-fill retention across this cursor chain; older fills are not available",
          true,
        )
        break walk
      }
    }
    if (!full) {
      done = true
    } else if (t === startedAt) {
      // A full response that could not move past its first timestamp: more rows share that
      // millisecond than one response carries, and stepping to `time + 1` would skip them unseen.
      stop(
        "PERPS_HISTORY_BOUNDARY_LIMIT",
        `More than ${max} ${kind === "fills" ? "fills" : "funding rows"} share one millisecond (${t}); coverage stops there`,
        true,
      )
    }
  }

  if (kind === "fills" && !warnings.some((w) => w.code === "PERPS_HISTORY_RETENTION_LIMIT"))
    warnings.unshift({ code: "PERPS_HISTORY_RETENTION_LIMIT", message: RETENTION_TEXT })

  const nextCursor = done ? null : encodeCursor({ ...state, t, b: [...boundary], c: consumed })
  const envelope: PageBase = {
    success: true,
    walletId: req.walletId,
    address: state.w,
    network: state.n,
    source: "hyperliquid",
    readAt,
    startTime: state.s,
    endTime: state.e,
    nextCursor,
    hasMore: nextCursor !== null,
    truncated,
    warnings,
  }
  return kind === "fills"
    ? { ...envelope, fills: page as PerpsFillRow[] }
    : { ...envelope, funding: page as PerpsFundingRow[] }
}

/** Money for a table: two decimals, sign kept. JSON keeps the venue's exact strings. */
export function perpsHistoryMoney(value: unknown): string {
  if (typeof value !== "string" || !/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return "?"
  const negative = value.startsWith("-")
  const [whole = "0", frac = ""] = (negative ? value.slice(1) : value).split(".")
  let cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2))
  if ((frac[2] ?? "0") >= "5") cents += 1n
  const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`
  return negative && cents !== 0n ? `-${text}` : text
}

/** The human lines for one page: wallet, UTC window, rows, then how to read the next page. */
export function perpsHistoryLines(page: PerpsFillsPage | PerpsFundingPage, nextHint: (cursor: string) => string) {
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  const clean = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
  const lines = [
    `${clean(page.address)} (${page.network}), ${iso(page.startTime)} to ${iso(page.endTime)} UTC. Wallet-level, live from Hyperliquid; not Candle's ledger.`,
  ]
  if ("fills" in page) {
    if (page.fills.length === 0) lines.push("No fills in this window.")
    for (const f of page.fills) {
      const builder = f.builderFee !== undefined ? `, builder fee ${perpsHistoryMoney(f.builderFee)} (in fee)` : ""
      lines.push(
        `  ${iso(f.time)}  ${clean(f.coin)} ${clean(f.dir ?? (f.side === "B" ? "Buy" : "Sell"))} ${clean(f.sz)} at ${clean(f.px)}, closed P&L ${perpsHistoryMoney(f.closedPnl)} (gross), fee ${perpsHistoryMoney(f.fee)} ${clean(f.feeToken ?? "")}${builder}`.trimEnd(),
      )
    }
  } else {
    if (page.funding.length === 0) lines.push("No funding payments in this window.")
    for (const f of page.funding) {
      const usdc = f.delta.usdc
      const paid = usdc.startsWith("-")
      lines.push(
        `  ${iso(f.time)}  ${clean(f.delta.coin)} ${paid ? "paid" : "received"} ${perpsHistoryMoney(paid ? usdc.slice(1) : usdc)} USDC, rate ${clean(f.delta.fundingRate)}, position ${clean(f.delta.szi)}`,
      )
    }
  }
  for (const warning of page.warnings) lines.push(`Note: ${warning.message}`)
  if (page.nextCursor) lines.push(nextHint(page.nextCursor))
  else lines.push(page.truncated ? "Coverage stopped early; see the notes above." : "End of this window.")
  return lines
}
