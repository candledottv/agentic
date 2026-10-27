/**
 * The local spend log and the spending limits (spec 10.3 and 10.4, decision A9).
 *
 * `<config dir>/spend/<profile>.jsonl`: append-only, one JSON line per event, file mode 0600 in a
 * 0700 directory. A payment is a `pending` line written before it is sent, then one line per state
 * it reaches (`settled`, `failed`, `unknown`, `credited`); `foldSpendLog` folds them by `id`.
 *
 * `<config dir>/spend/<profile>.limits.json`: the daily per-use limit (default $5), the per-call
 * ceiling (default $1) and the pause switch, all local. Plan purchases are outside the daily limit.
 *
 * The daily check and the `pending` line are written under one exclusive lock on the log file
 * (`withFileLock`), so two CLI processes cannot both spend the same headroom.
 */
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withFileLock } from "../file-lock"
import { candleConfigDir } from "../vault/store"

export const DEFAULT_DAILY_LIMIT_USD_MICROS = 5_000_000n
export const DEFAULT_MAX_PER_CALL_USD_MICROS = 1_000_000n
/** An `unknown` older than this is reconciled against the server's payment list (10.4). */
export const UNKNOWN_RECONCILE_AFTER_MS = 15 * 60_000

export type SpendState = "pending" | "settled" | "failed" | "unknown" | "credited"
const STATES: readonly SpendState[] = ["pending", "settled", "failed", "unknown", "credited"]

export interface SpendLine {
  v: 1
  at: string
  id: string
  state: SpendState
  kind?: string
  route?: string
  network?: string
  amountRaw?: string
  payTo?: string
  payer?: string
  quoteMemo?: string
  /** True when the call carried no API key: a failure credit then belongs to the wallet (3.7). */
  keyless?: boolean
  signature?: string
  reason?: string
}

/** One payment, its lines folded: the first line's facts, the last line's state. */
export interface SpendEntry {
  id: string
  startedAt: string
  updatedAt: string
  state: SpendState
  kind: string
  route: string
  network: string
  amountRaw: bigint
  payTo: string
  payer: string
  quoteMemo: string
  keyless: boolean
  signature?: string
  reason?: string
}

export interface SpendLimits {
  dailyLimitUsdMicros: bigint
  maxPerCallUsdMicros: bigint
  paused: boolean
}

export interface SpendPaths {
  dir: string
  log: string
  limits: string
}

/** The profile's log and limits files. A profile name is already validated by dispatch. */
export function spendPaths(env: Record<string, string | undefined>, home: string, profile?: string): SpendPaths {
  const dir = join(candleConfigDir(env, home), "spend")
  const name = profile ?? "default"
  return { dir, log: join(dir, `${name}.jsonl`), limits: join(dir, `${name}.limits.json`) }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null
    throw error
  }
}

// ── Limits ────────────────────────────────────────────────────────────────────────────────────

const micros = (value: unknown, fallback: bigint): bigint =>
  typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? BigInt(value) : fallback

export async function readLimits(paths: SpendPaths): Promise<SpendLimits> {
  const text = await readIfPresent(paths.limits)
  let raw: Record<string, unknown> = {}
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        raw = parsed as Record<string, unknown>
    } catch {
      // An unreadable file is the defaults, which are the strictest values this CLI ships.
    }
  }
  return {
    dailyLimitUsdMicros: micros(raw.dailyLimitUsdMicros, DEFAULT_DAILY_LIMIT_USD_MICROS),
    maxPerCallUsdMicros: micros(raw.maxPerCallUsdMicros, DEFAULT_MAX_PER_CALL_USD_MICROS),
    paused: raw.paused === true,
  }
}

export async function writeLimits(paths: SpendPaths, limits: SpendLimits): Promise<void> {
  await ensureDir(paths.dir)
  const body = `${JSON.stringify({
    v: 1,
    dailyLimitUsdMicros: limits.dailyLimitUsdMicros.toString(),
    maxPerCallUsdMicros: limits.maxPerCallUsdMicros.toString(),
    paused: limits.paused,
  })}\n`
  const temp = `${paths.limits}.tmp`
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 })
  await rename(temp, paths.limits)
}

// ── The log ───────────────────────────────────────────────────────────────────────────────────

function parseLine(text: string): SpendLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const line = parsed as Record<string, unknown>
  if (line.v !== 1 || typeof line.id !== "string" || typeof line.at !== "string") return null
  if (!STATES.includes(line.state as SpendState)) return null
  return line as unknown as SpendLine
}

export async function readSpendLog(paths: SpendPaths): Promise<SpendLine[]> {
  const text = await readIfPresent(paths.log)
  if (text === null) return []
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? null : parseLine(line)))
    .filter((line): line is SpendLine => line !== null)
}

/** Appends lines. The caller holds the lock when the append must follow a check (`reserveSpend`). */
export async function appendSpendLines(paths: SpendPaths, lines: SpendLine[]): Promise<void> {
  await ensureDir(paths.dir)
  await appendFile(paths.log, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    encoding: "utf8",
    mode: 0o600,
  })
  await chmod(paths.log, 0o600).catch(() => {})
}

/** Folds lines by id, in the order each payment started. A line for an unknown id is ignored. */
export function foldSpendLog(lines: SpendLine[]): SpendEntry[] {
  const entries = new Map<string, SpendEntry>()
  for (const line of lines) {
    const existing = entries.get(line.id)
    if (!existing) {
      if (line.state !== "pending" || line.amountRaw === undefined || !/^[0-9]{1,20}$/.test(line.amountRaw)) continue
      entries.set(line.id, {
        id: line.id,
        startedAt: line.at,
        updatedAt: line.at,
        state: "pending",
        kind: line.kind ?? "",
        route: line.route ?? "",
        network: line.network ?? "",
        amountRaw: BigInt(line.amountRaw),
        payTo: line.payTo ?? "",
        payer: line.payer ?? "",
        quoteMemo: line.quoteMemo ?? "",
        keyless: line.keyless === true,
      })
      continue
    }
    existing.state = line.state
    existing.updatedAt = line.at
    if (line.signature !== undefined) existing.signature = line.signature
    if (line.reason !== undefined) existing.reason = line.reason
  }
  return [...entries.values()]
}

/** The UTC day of an ISO time: `2026-11-02`. */
export function utcDay(at: string | number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * What counts against `day`'s limit: every payment started that UTC day that may have moved money.
 * `pending` and `unknown` count until they are known not to have; a `credited` payment did move
 * money (it came back as credit, not USDC). Only `failed` is free.
 */
export function spentOn(entries: SpendEntry[], day: string): bigint {
  let total = 0n
  for (const entry of entries) {
    if (entry.state !== "failed" && utcDay(entry.startedAt) === day) total += entry.amountRaw
  }
  return total
}

export type Reservation = { ok: true } | { ok: false; spentToday: bigint }

/**
 * 10.3 rule 3 and rule 5: under the log's lock, today's total plus `pending.amountRaw` must be at
 * most the daily limit; only then is the `pending` line written. Plan purchases never come here.
 */
export async function reserveSpend(
  paths: SpendPaths,
  dailyLimitUsdMicros: bigint,
  pending: SpendLine & { amountRaw: string },
  lock: typeof withFileLock = withFileLock,
): Promise<Reservation> {
  await ensureDir(paths.dir)
  return lock(paths.log, async () => {
    const spentToday = spentOn(foldSpendLog(await readSpendLog(paths)), utcDay(pending.at))
    if (spentToday + BigInt(pending.amountRaw) > dailyLimitUsdMicros) return { ok: false, spentToday }
    await appendSpendLines(paths, [pending])
    return { ok: true }
  })
}

/** Appends one state line for a payment already in the log. */
export async function recordSpendState(
  paths: SpendPaths,
  update: { id: string; at: string; state: SpendState; signature?: string; reason?: string },
): Promise<void> {
  const line: SpendLine = {
    v: 1,
    at: update.at,
    id: update.id,
    state: update.state,
    ...(update.signature ? { signature: update.signature } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
  }
  await withFileLock(paths.log, () => appendSpendLines(paths, [line]))
}

/** "1.5" from micro-USD, for the limits a person typed. */
export function usdText(usdMicros: bigint): string {
  const whole = usdMicros / 1_000_000n
  const fraction = (usdMicros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : `${whole}`
}
