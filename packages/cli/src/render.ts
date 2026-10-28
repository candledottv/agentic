/**
 * render: the CLI's plain fixed-width table helper, the human error-message mapping, the
 * machine error envelope, scope-label formatting, and the portal-URL helper. Every human-mode
 * error message routes through `renderError`; every `--json` failure routes through
 * `errorEnvelope`. `writeFailure`/`writeLocalFailure`/`writeUsageFailure` are the only places
 * that branch between the two modes, and in `--json` mode they write the envelope to STDOUT --
 * the CLI's contract with agents (documented in README/AGENTS.md) is that stdout under
 * `--json` always carries exactly one JSON value, a result on success or an
 * `{ok:false,...}` envelope on failure, with stderr reserved for diagnostics.
 */

import { sortAgentKeyScopes } from "./agent-key-access"
import {
  accent,
  clipDisplay,
  dim,
  displayWidth,
  failure,
  fitsWidth,
  padDisplay,
  proseWidth,
  symbols,
  type TerminalStyle,
  wrapText,
} from "./presentation"

/** Mirrors `apps/api/src/lib/agent-keys.ts`'s `AGENT_KEY_SCOPES`, duplicated here since the CLI
 * has zero runtime dependencies and no cross-package import (spec decision 4: the CLI is
 * standalone). Order matches the API's own array. */
export const ALL_AGENT_SCOPES = [
  "launch:write",
  "launch:read",
  // Read the whole account and write nothing; the whole of the portal's "Read" preset (Read and
  // Read:Write agent key scopes, 2026-09-22 spec). Read-only, so it is in the default too.
  "account:read",
  "activity:write",
  "swap:write",
  "transfer:write",
  // Read:Write:Transfer (2026-09-24 spec, D1): move funds out of the wallet this key runs. Never
  // in the default, and never put on a device login by this CLI (the API refuses it there).
  "transfer:bound",
  // Hyperliquid perps: set up and trade perps from the key's EVM TEE wallet. Never in the default;
  // `keys create --access trade-perps` grants it with `account:read` (2026-10-17 C spec, section 7).
  "perps:write",
] as const
export type AgentScope = (typeof ALL_AGENT_SCOPES)[number]

/** Mirrors `DEFAULT_AGENT_KEY_SCOPES`: what `POST /keys` grants when `scopes` is omitted.
 * `swap:write` moves real funds on every call, so it is deliberately excluded from the default. */
export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ALL_AGENT_SCOPES.filter(
  (scope) =>
    scope !== "swap:write" && scope !== "transfer:write" && scope !== "transfer:bound" && scope !== "perps:write",
)

const SWAP_WRITE_NOTE = "moves funds -- this key can execute swaps on your behalf"
const TRANSFER_WRITE_NOTE = "moves funds -- this key can transfer assets between your wallets"
const TRANSFER_BOUND_NOTE =
  "moves funds -- this key can move funds out of the wallet it runs, to your linked wallets and its vault"
const PERPS_WRITE_NOTE =
  "trades Hyperliquid perps -- this key can open and close positions from its EVM TEE wallet, within its limits"

/** Renders a scope list for a human, calling `swap:write`, `transfer:write` and `transfer:bound`
 * out explicitly as fund-moving, and `perps:write` as perps trading. Every other scope renders as its raw name. Sorted first, in the one order raw
 * scopes are shown to a person everywhere (`keys list --scopes`, the web key detail), so the same
 * set never reads as two different lists (keys list Access and Name spec, 2026-09-23, D6). */
export function formatScopesForSummary(scopes: readonly string[]): string {
  return sortAgentKeyScopes(scopes)
    .map((scope) =>
      scope === "swap:write"
        ? `${scope} (${SWAP_WRITE_NOTE})`
        : scope === "transfer:write"
          ? `${scope} (${TRANSFER_WRITE_NOTE})`
          : scope === "transfer:bound"
            ? `${scope} (${TRANSFER_BOUND_NOTE})`
            : scope === "perps:write"
              ? `${scope} (${PERPS_WRITE_NOTE})`
              : scope,
    )
    .join(", ")
}

/**
 * Text from a server, made safe to print on a terminal (BE-316 review): every C0 and C1 control
 * character removed, DEL included. A token's symbol and name reach Candle from market data anyone
 * can influence by minting a token, so `\x1b[2J` in a symbol would otherwise clear or recolour the
 * rows around it -- in a table that carries balances and a total. `--json` needs none of this:
 * `JSON.stringify` escapes control characters.
 */
export function terminalText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

/** One column of a `renderTable` given options. Every field is optional. */
export interface TableColumn {
  /** `auto` (the default) right-aligns a column whose every known cell reads as a number. */
  align?: "left" | "right" | "auto"
  /** When the table is wider than `width`, the column with the LOWEST priority drops first
   * (rightmost first on a tie). A column without a priority is never dropped. */
  priority?: number
  /** An id column: never truncated, since a cut id is neither scenery nor input. The table drops
   * a lower-priority column instead, and when nothing is left to drop it overflows. */
  id?: boolean
  /** Color each cell by its sign: a leading `+` positive, a leading `-` negative. The sign stays in
   * the text, so the cell reads the same with no color. */
  signed?: boolean
}

export interface TableOptions {
  columns?: readonly (TableColumn | undefined)[]
  /** The width to fit, usually `terminalStyle(...).width`. Omitted: no limit. */
  width?: number
  /** Colors (dim header, signed cells) and the ellipsis come from this; omitted, the table is plain. */
  style?: TerminalStyle
  /** Spaces before every row. Default 0. */
  indent?: number
  /** The dashed rule under the header. Default true, the table every command prints today. */
  rule?: boolean
}

const NUMERIC_CELL = /^[+\-−]?(?:<|>|~)?[$]?[\d,]*\.?\d+(?:[%xKMBT]|\/h)?$/

/** A column reads as numbers when every cell that is not the missing mark or empty does. */
function numericColumn(rows: string[][], col: number): boolean {
  const known = rows.map((row) => row[col] ?? "").filter((cell) => cell !== "" && cell !== "–" && cell !== "-")
  return known.length > 0 && known.every((cell) => NUMERIC_CELL.test(cell))
}

/**
 * A fixed-width table: a header row, by default a separator row of dashes, then one row per data
 * row, every column padded to its widest cell (header included). No box drawing.
 *
 * With no `options` this is exactly the table every command prints today: left-aligned, no color,
 * no width limit. With `options` it is the kit's table (CLI legibility audit, rule 3 and 5):
 * numbers right-aligned, and when `width` is set it fits: the lowest-priority columns drop first,
 * then the widest non-id columns shrink, their long cells cut with an ellipsis. Widths are display
 * columns, so a CJK character counts as two and a combining mark stays with its base. An id column
 * is never cut. A header is never cut. Colors are applied after padding, so alignment never counts
 * escape codes. `…` and `–` stay one column.
 */
export function renderTable(headers: string[], rows: string[][], options?: TableOptions): string {
  if (!options) return renderPlainTable(headers, rows)
  const specs = headers.map((_, col) => options.columns?.[col] ?? {})
  const align = headers.map((_, col) => {
    const spec = specs[col]?.align ?? "auto"
    return spec === "auto" ? (numericColumn(rows, col) ? "right" : "left") : spec
  })
  const natural = headers.map((header, col) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[col] ?? ""))),
  )
  let visible = headers.map((_, col) => col)
  const widths = [...natural]
  const indent = options.indent ?? 0
  const total = () => indent + visible.reduce((sum, col) => sum + (widths[col] ?? 0), 0) + 2 * (visible.length - 1)
  const limit = options.width
  if (limit !== undefined) {
    // Drop: lowest priority first, the rightmost of equals first.
    while (total() > limit) {
      const droppable = visible.filter((col) => specs[col]?.priority !== undefined)
      if (droppable.length === 0) break
      const drop = droppable.reduce((a, b) => ((specs[b]?.priority ?? 0) <= (specs[a]?.priority ?? 0) ? b : a))
      visible = visible.filter((col) => col !== drop)
    }
    // Shrink: the widest cuttable column loses a column at a time, never below its header or 3.
    while (total() > limit) {
      const cuttable = visible.filter(
        (col) => !specs[col]?.id && (widths[col] ?? 0) > Math.max(3, displayWidth(headers[col] ?? "")),
      )
      if (cuttable.length === 0) break
      const widest = cuttable.reduce((a, b) => ((widths[b] ?? 0) > (widths[a] ?? 0) ? b : a))
      widths[widest] = (widths[widest] ?? 0) - 1
    }
  }
  const style = options.style
  const ellipsis = style ? symbols(style).ellipsis : "..."
  const pad = " ".repeat(indent)
  // As in the plain table, a left-aligned last column is never padded on the right.
  const line = (cells: string[], header: boolean) =>
    pad +
    visible
      .map((col, i) => {
        const width = widths[col] ?? 0
        const text = clipDisplay(cells[col] ?? "", width, ellipsis)
        const gap = " ".repeat(Math.max(0, width - displayWidth(text)))
        const last = i === visible.length - 1
        const padded = align[col] === "right" ? `${gap}${text}` : last ? text : `${text}${gap}`
        if (!style) return padded
        if (header) return dim(padded, style)
        if (specs[col]?.signed && /^[+]/.test(text)) return accent(padded, style, "positive")
        if (specs[col]?.signed && /^[-−]/.test(text)) return accent(padded, style, "negative")
        return padded
      })
      .join("  ")
  const rule = pad + visible.map((col) => "-".repeat(widths[col] ?? 0)).join("  ")
  return [
    line(headers, true),
    ...((options.rule ?? true) ? [style ? dim(rule, style) : rule] : []),
    ...rows.map((row) => line(row, false)),
  ].join("\n")
}

/** The table every command printed before the kit, kept byte for byte: a column per cell of each
 * row, every column padded to its widest cell, the last never padded (padding it would only add
 * trailing whitespace nobody reads, which would otherwise break every exact-string assertion). */
function renderPlainTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? (cell ?? "") : (cell ?? "").padEnd(widths[col] ?? 0)))
      .join("  ")
  const separator = widths.map((width) => "-".repeat(width)).join("  ")
  return [line(headers), separator, ...rows.map(line)].join("\n")
}

/** Renders a timestamp (epoch ms) for a human, or `whenAbsent` (default `"never"`) when absent. */
export function formatTimestamp(ms: number | undefined, whenAbsent = "never"): string {
  return ms === undefined ? whenAbsent : new Date(ms).toISOString()
}

/** The one mark for a missing value on a human screen (en dash). Plain mode prints `-` instead;
 * `symbols(style).missing` gives the right one for a stream. */
export const MISSING = "–"

/**
 * `9EAq…9Hd7`: the first four, an ellipsis, the last four, for an id that is scenery in a dense
 * table. `full` (the global `--full`) prints the id whole. A value of twelve characters or fewer
 * is already short and prints whole. Never use this for a value the user must paste into the
 * next command (a new key, a funding address, a fingerprint): the CLI cannot take a short id back.
 */
export function shortId(id: string, full = false): string {
  return full || id.length <= 12 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type TimeInput = number | string | Date | undefined | null

function toDate(at: TimeInput): Date | undefined {
  if (at === undefined || at === null || at === "") return undefined
  const date = at instanceof Date ? at : new Date(at)
  return Number.isFinite(date.getTime()) ? date : undefined
}

/**
 * A short UTC time for a human: `Oct 27 22:36Z`, with no seconds or milliseconds. UTC because the
 * API, logs, cards and support all speak it; `Z` says so. The year appears only when it is not
 * `now`'s year (`Oct 27 2025 22:36Z`). `date: true` drops the clock (`Oct 27`). Epoch ms, an ISO
 * string or a Date; anything absent or unparseable is the missing mark. `--json` keeps full ISO.
 */
export function formatTime(at: TimeInput, options: { now?: number; date?: boolean; missing?: string } = {}): string {
  const date = toDate(at)
  if (!date) return options.missing ?? MISSING
  const nowYear = new Date(options.now ?? Date.now()).getUTCFullYear()
  const year = date.getUTCFullYear() === nowYear ? "" : ` ${date.getUTCFullYear()}`
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${year}`
  if (options.date) return day
  const clock = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
  return `${day} ${clock}Z`
}

/**
 * How long ago, in the largest whole unit: `just now`, `5 min ago`, `2h ago`, `34d ago`. Past 90
 * days, or more than a minute in the future (clock skew is not a time), the date instead
 * (`formatTime` with `date: true`). Absent is the missing mark.
 */
export function formatAgo(at: TimeInput, now: number, missing = MISSING): string {
  const date = toDate(at)
  if (!date) return missing
  const seconds = Math.floor((now - date.getTime()) / 1000)
  if (seconds < -60) return formatTime(date, { now, date: true })
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days <= 90 ? `${days}d ago` : formatTime(date, { now, date: true })
}

export interface ErrorRenderContext {
  apiUrl: string
  authType?: "device" | "key" | "none"
}

interface FailureLike {
  retryable?: boolean
  routing?: Record<string, unknown>
  discovery?: Record<string, unknown>
  status: number
  code?: string
  message: string
  rfcError?: string
  /** The API's own plain-language fix, lifted off its error envelope (ERROR_UI_CATALOG). */
  uiHint?: string
  /** The API's docs path for this error, relative to docs.candle.tv. */
  docsPath?: string
}

/**
 * One plain-language line, never a raw envelope. Three mappings are pinned exactly
 * (task-3-brief.md Step 3):
 *
 *   DEVICE_TOKEN_INVALID -> "This device was revoked or its token is stale. Run: candle auth login"
 *   401 on an agent-key call -> "API key invalid or revoked. Run: candle keys create"
 *   network failure (status 0) -> "Could not reach <url>. Set CANDLE_API_URL to override the API endpoint."
 *
 * A fourth mapping appends a fix line to 403 SCOPE_MISSING rather than replacing the message:
 * the API's own text already names the missing scope ("This key lacks the launch:write scope"),
 * which is the part a CLI-side constant could not supply, so the CLI adds only the two commands
 * that resolve it. Without this, a scope-gated route (GET /agent/tier and GET /wallets both sit
 * behind `requireAgentKey("launch:write")`) failed with a statement of fact and no next step.
 *
 * Everything else falls back to the API's own message -- still plain language (launch-errors.ts's
 * `errorBody` messages are already written for a human), just without a CLI-specific fix line.
 */
export function renderError(result: FailureLike, ctx: ErrorRenderContext): string {
  if (result.code === "DEVICE_TOKEN_INVALID") {
    return "This device was revoked or its token is stale. Run: candle auth login"
  }
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return `${result.message}. Mint one that has it with: candle keys create --scopes <a,b,c>, or check an existing key's scopes with: candle keys list`
  }
  if (result.status === 401 && ctx.authType === "key") {
    return "API key invalid or revoked. Run: candle keys create"
  }
  if (result.status === 0) {
    return `Could not reach ${ctx.apiUrl}. Set CANDLE_API_URL to override the API endpoint.`
  }
  return result.message
}

/**
 * The fix a caller can act on, as a command or a setting -- the machine-envelope counterpart of
 * the fix lines `renderError` weaves into its sentences (same four mappings, kept adjacent so
 * they cannot drift apart silently; renderError's exact human strings are pinned by task-3's
 * brief and stay untouched). Falls back to the API's own `uiHint` (ERROR_UI_CATALOG), which is
 * exactly this field server-side.
 */
export function suggestionFor(result: FailureLike, ctx: ErrorRenderContext): string | undefined {
  if (result.code === "DEVICE_TOKEN_INVALID") return "Run: candle auth login"
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return "Mint a key that has it: candle keys create --scopes <a,b,c>, or check an existing key's scopes: candle keys list"
  }
  if (result.status === 401 && ctx.authType === "key") return "Run: candle keys create"
  if (result.status === 0) return "Set CANDLE_API_URL to override the API endpoint."
  return result.uiHint
}

/** One way out of a failure: what it does, and the command (or setting) that does it. */
export interface ErrorFix {
  label: string
  command?: string
}

/** A human failure in two parts (audit rule 8): the message on one line, then the fixes. */
export interface ErrorParts {
  message: string
  fixes: ErrorFix[]
}

/**
 * `renderError`'s four mappings, split into the message and the fix, for the kit's two-part
 * error (`renderErrorBlock`). Same words and same commands as `renderError` and `suggestionFor`
 * (render.test.ts pins that), so moving a command onto this changes the layout, not the advice.
 * Anything else is the API's own message, with its `uiHint` as the one fix when it sent one.
 */
export function errorParts(result: FailureLike, ctx: ErrorRenderContext): ErrorParts {
  if (result.code === "DEVICE_TOKEN_INVALID") {
    return {
      message: "This device was revoked or its token is stale.",
      fixes: [{ label: "Log in again", command: "candle auth login" }],
    }
  }
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return {
      message: `${result.message}.`,
      fixes: [
        { label: "Mint a key that has it", command: "candle keys create --scopes <a,b,c>" },
        { label: "Check an existing key's scopes", command: "candle keys list" },
      ],
    }
  }
  if (result.status === 401 && ctx.authType === "key") {
    return {
      message: "API key invalid or revoked.",
      fixes: [{ label: "Mint a new key", command: "candle keys create" }],
    }
  }
  if (result.status === 0) {
    return {
      message: `Could not reach ${ctx.apiUrl}.`,
      fixes: [{ label: "Use another API endpoint", command: "CANDLE_API_URL=<url>" }],
    }
  }
  return { message: result.message, fixes: result.uiHint ? [{ label: result.uiHint }] : [] }
}

/**
 * A two-part failure for a human: `✗ message` in the negative color, then, after a blank line,
 * one fix per line with the commands in one column. A fix without a command is advice, wrapped
 * to the prose width.
 *
 *   ✗ API key invalid or revoked.
 *
 *     Mint a new key:   candle keys create
 */
export function renderErrorBlock(parts: ErrorParts, style: TerminalStyle): string[] {
  const budget = proseWidth(style)
  const out = [...errorMessageLines(parts.message, style, budget)]
  if (parts.fixes.length === 0) return out
  out.push("")
  const labelWidth = Math.max(
    0,
    ...parts.fixes.filter((fix) => fix.command).map((fix) => displayWidth(`${fix.label}:`)),
  )
  for (const fix of parts.fixes) {
    if (fix.command) out.push(...errorCommandLines(fix.label, fix.command, style, labelWidth, budget))
    else out.push(...errorAdviceLines(fix.label, budget))
  }
  return out
}

/** The message uses the columns left after `✗ `, not a 20-column floor that ignores that prefix.
 * When an ordinary word cannot sit beside the mark, the mark takes its own line. */
function errorMessageLines(message: string, style: TerminalStyle, budget: number): string[] {
  const lead = displayWidth(symbols(style).danger) + 1
  const tight = budget - Math.max(lead, 2)
  if (tight >= 1 && fitsWidth(message, tight)) {
    const [first = "", ...rest] = wrapText(message, tight)
    return [failure(first, style), ...rest.map((line) => `  ${accent(line, style, "negative")}`)]
  }
  const mark = accent(symbols(style).danger, style, "negative")
  return [mark, ...prefixedWrap(message, budget, (line) => accent(line, style, "negative"))]
}

/** A command stays on the label's line when that line fits. Otherwise the label and the command
 * each wrap into the remaining columns. A single token wider than the terminal stays whole. */
function errorCommandLines(
  label: string,
  command: string,
  style: TerminalStyle,
  labelWidth: number,
  budget: number,
): string[] {
  const aligned = `  ${padDisplay(`${label}:`, labelWidth)}   ${command}`
  if (displayWidth(aligned) <= budget) {
    return [`  ${dim(padDisplay(`${label}:`, labelWidth), style)}   ${command}`]
  }
  return [...prefixedWrap(`${label}:`, budget, (line) => dim(line, style)), ...prefixedWrap(command, budget)]
}

function errorAdviceLines(label: string, budget: number): string[] {
  return prefixedWrap(label, budget)
}

/** Wrap `text` under a two-space indent when ordinary words fit there, otherwise at the full budget. */
function prefixedWrap(text: string, budget: number, paint?: (line: string) => string): string[] {
  const indented = budget - 2
  const width = indented >= 1 && fitsWidth(text, indented) ? indented : Math.max(1, budget)
  const prefix = width === indented ? "  " : ""
  return wrapText(text, width).map((line) => {
    if (!line) return ""
    const body = paint ? paint(line) : line
    return `${prefix}${body}`
  })
}

/** The stable machine failure shape. `code` is always present so a caller can switch on it
 * without probing; `suggestion`/`docsUrl` appear only when there is a real one to give. */
export interface ErrorEnvelope {
  retryable?: boolean
  routing?: Record<string, unknown>
  discovery?: Record<string, unknown>
  ok: false
  code: string
  status: number
  message: string
  suggestion?: string
  docsUrl?: string
}

/**
 * Builds the `--json` failure envelope from a failed `ApiResult`. `message` stays the API's own
 * words except for a network failure, where there is no API to quote and `renderError`'s
 * could-not-reach sentence is the honest message. `docsUrl` is absolute: the caller is an agent
 * that will fetch it, not a human who knows the docs host.
 */
export function errorEnvelope(result: FailureLike, ctx: ErrorRenderContext): ErrorEnvelope {
  const code = result.code ?? result.rfcError ?? (result.status === 0 ? "NETWORK_UNREACHABLE" : `HTTP_${result.status}`)
  const message = result.status === 0 ? `Could not reach ${ctx.apiUrl}.` : result.message
  const suggestion = suggestionFor(result, ctx)
  const docsUrl = result.docsPath ? `https://docs.candle.tv/${result.docsPath}` : undefined
  return {
    ok: false,
    ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    ...(result.routing ? { routing: result.routing } : {}),
    ...(result.discovery ? { discovery: result.discovery } : {}),
    code,
    status: result.status,
    message,
    ...(suggestion ? { suggestion } : {}),
    ...(docsUrl ? { docsUrl } : {}),
  }
}

interface ModeWriters {
  stdout: { write(chunk: string): void }
  stderr: { write(chunk: string): void }
}

/** Writes a failed `ApiResult`: the `errorEnvelope` to STDOUT in `--json` mode (the machine
 * contract -- stdout always carries one JSON value), `renderError`'s plain-language line to
 * STDERR otherwise. The one place every command branches between the two, so no call site can
 * accidentally print an envelope in human mode or a rendered sentence in JSON mode. */
export function writeFailure(
  deps: ModeWriters,
  result: FailureLike & Record<string, unknown>,
  ctx: ErrorRenderContext,
  json: boolean,
): void {
  if (json) deps.stdout.write(`${JSON.stringify(errorEnvelope(result, ctx))}\n`)
  else deps.stderr.write(`${renderError(result, ctx)}\n`)
}

/**
 * A LOCAL failure, decided before any request was made: the command needs a credential the CLI
 * does not have, or dispatch will not let it act (an unresolved profile, a mismatched account).
 * Same two-mode contract `writeFailure` gives an API failure -- a machine-readable object in
 * `--json` mode, the plain line otherwise -- so a `--json` caller never has to parse a sentence.
 * Deliberately not routed through `writeFailure`: that takes an HTTP status, and there is no
 * honest one here (status 0 specifically means "could not reach the server", which `renderError`
 * would then print INSTEAD of the message this failure carries).
 *
 * A one-line suggestion reads as the tail of the sentence and is joined to it with a space ("No
 * API key available. Run: candle auth login"). A suggestion that is ITSELF several lines (the
 * guard's three repairs, a list of profiles to pick from) is its own block and keeps the newline:
 * gluing a list onto the end of a sentence produces a first line that is neither.
 */
export function writeLocalFailure(
  deps: ModeWriters,
  // `details` (D3, BE-241) is an optional nested object of facts the caller can act on, spread
  // into the `--json` envelope by whoever builds `failure` and deliberately absent from the human
  // rendering: the same facts are already in `message`, written as a sentence.
  failure: { code: string; message: string; suggestion?: string; details?: Record<string, unknown> },
  json: boolean,
): void {
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: false, ...failure })}\n`)
    return
  }
  const separator = failure.suggestion?.includes("\n") ? "\n" : " "
  deps.stderr.write(`${failure.suggestion ? `${failure.message}${separator}${failure.suggestion}` : failure.message}\n`)
}

/**
 * A usage failure: the arguments themselves were wrong, decided before anything ran. Exit 2 at
 * every call site (the caller returns it; this only writes). In `--json` mode this is still an
 * envelope on stdout -- an agent that misassembles a flag must get the same parseable shape as
 * any other failure, not a bare sentence on stderr it never reads.
 */
export function writeUsageFailure(deps: ModeWriters, message: string, json: boolean): void {
  if (json) deps.stdout.write(`${JSON.stringify({ ok: false, code: "USAGE", message })}\n`)
  else deps.stderr.write(`${message}\n`)
}

/**
 * The portal's device-management screen URL. `portalOrigin` -- persisted at login from the origin
 * of the device-code response's own `verificationUri`, which the API computes from its `FRONTEND_URL`
 * -- is AUTHORITATIVE when present: it is the portal the API itself points device approvals at, so
 * it is right by construction on every environment, including ones no derivation rule could guess.
 *
 * The derivation below is the fallback for a config written before this field existed, or for
 * env-only usage that never ran `auth login` on this machine. The API lives one "api" label above
 * the portal on every deployment (api.alpha.candle.tv -> alpha.candle.tv, api.candle.tv ->
 * candle.tv, staging.api.candle.tv -> staging.candle.tv), so it removes the first host LABEL that
 * is exactly "api" -- anywhere in the hostname, not only leading (a leading-only rule pointed the
 * staging case back at the API host, which 404s). A convenience pointer
 * in a printed message, not a routing decision -- kept small on purpose.
 *
 * Parses the URL and operates on `hostname` LABELS specifically, never a string replace on the
 * whole URL: `"staging-api.candle.tv".replace("api.", "")` would wrongly cut the middle of a
 * hostname that merely CONTAINS "api." (producing "staging-.candle.tv"), and could just as easily
 * match "api." inside a path segment that has nothing to do with the host. Only the hostname is
 * ever touched -- the reconstructed URL is always `<origin>/agents`, never carrying over any
 * path `apiUrl` had (this is a portal deep link with its own fixed path, not a URL rewrite).
 */
export function portalDevicesUrl(apiUrl: string, portalOrigin?: string): string {
  return `${portalDeviceUrl(apiUrl, portalOrigin)}?tab=keys#connected-devices`
}

export function portalDeviceUrl(apiUrl: string, portalOrigin?: string): string {
  if (portalOrigin) {
    try {
      return `${new URL(portalOrigin).origin}/agents`
    } catch {
      // A hand-edited or corrupted config value: fall through to the derivation rather than
      // emitting a broken URL built out of it.
    }
  }
  try {
    const url = new URL(apiUrl)
    const labels = url.hostname.split(".")
    const apiLabel = labels.indexOf("api")
    // `labels.length > 1` guards a hostname that is nothing but "api": removing its only label
    // would leave an empty hostname, which the URL setter silently ignores anyway.
    if (apiLabel !== -1 && labels.length > 1) {
      labels.splice(apiLabel, 1)
      url.hostname = labels.join(".")
    }
    return `${url.origin}/agents`
  } catch {
    // Not a parseable URL -- shouldn't happen in practice (apiUrl always comes from
    // resolveApiUrl/--api-url), but fail soft rather than throw out of a printed-message helper.
    return `${apiUrl}/agents`
  }
}
