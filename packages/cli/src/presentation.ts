import type { Deps } from "./deps"
import { TERMINAL_TOKENS } from "./terminal-theme"
import { CLI_VERSION } from "./version"

export interface PresentationFlags {
  plain?: boolean
  noColor?: boolean
  /** The global `--full`: every id a dense table would shorten (`shortId`) prints in full. */
  full?: boolean
}

/** What `terminalStyle` reads: the environment, the cosmetic flags, and the stream's TTY and width. */
export type StyleDeps = Pick<Deps, "env" | "presentation" | "isTTY" | "columns">

export interface TerminalStyle {
  width: number
  styled: boolean
  color: 0 | 16 | 256 | 24
  theme: "light" | "dark"
  motion: boolean
}

/** Inspect the stream being rendered, never stdin or a different output stream. Unknown
 * backgrounds use the conservative light palette; foreground/background remain terminal defaults. */
export function terminalStyle(deps: StyleDeps, stream: "stdout" | "stderr", machine = false): TerminalStyle {
  const { env, presentation } = deps
  const styled = !(
    machine ||
    presentation?.plain ||
    env.CANDLE_PLAIN === "1" ||
    !deps.isTTY[stream] ||
    env.CI ||
    env.TERM === "dumb"
  )
  const noColor = presentation?.noColor || Boolean(env.NO_COLOR)
  const color =
    !styled || noColor
      ? 0
      : /truecolor|24bit/i.test(env.COLORTERM ?? "")
        ? 24
        : /256color/i.test(env.TERM ?? "")
          ? 256
          : env.TERM
            ? 16
            : 0
  const background = Number(env.COLORFGBG?.split(";").at(-1))
  const theme = Number.isFinite(background) && background >= 0 && background <= 6 ? "dark" : "light"
  const columns = deps.columns?.[stream]
  return {
    width: columns && Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 118,
    styled,
    color,
    theme,
    motion: styled && !noColor,
  }
}

export function accent(text: string, style: TerminalStyle, role: keyof typeof TERMINAL_TOKENS.light = "brand"): string {
  if (!style.color) return text
  const token = TERMINAL_TOKENS[style.theme][role]
  const code =
    style.color === 24
      ? `38;2;${token.hex
          .slice(1)
          .match(/../g)
          ?.map((part) => Number.parseInt(part, 16))
          .join(";")}`
      : style.color === 256
        ? `38;5;${token.ansi256}`
        : `${token.ansi16}`
  return `\x1b[${code}m${text}\x1b[0m`
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" })

interface BunWidth {
  stringWidth?: (value: string) => number
}

/** Terminal columns, not code points. Wide characters count as two and a combining mark stays
 * with its base. Bun's own measure is what the review checks against; Node (the published
 * bundle) uses {@link estimateDisplayWidth}. */
export function displayWidth(text: string): number {
  const measure = (globalThis as { Bun?: BunWidth }).Bun?.stringWidth
  return measure ? measure(text) : estimateDisplayWidth(text)
}

/** A word this wide, or wider, is an id: `wrapText` keeps it whole, and a narrow column may let
 * it stick out rather than cut it. Shorter words are prose and have to fit. */
const ORDINARY_WORD = 24

/** Whether `text` wraps into `width` columns without an ordinary word sticking out. */
export function fitsWidth(text: string, width: number): boolean {
  if (width < 1) return false
  for (const part of text.split("\n")) {
    for (const word of part.split(" ")) {
      if (!word) continue
      const wordWidth = displayWidth(word)
      if (wordWidth > width && wordWidth <= ORDINARY_WORD) return false
    }
  }
  return true
}

/** Pad with spaces up to `width` display columns. A string that is already wider is unchanged. */
export function padDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text
}

/** Cut `text` to `width` display columns. Graphemes stay whole, so a wide character or a combining
 * mark is never split, and the result is never wider than `width`. An ellipsis that itself does
 * not fit is left off. */
export function clipDisplay(text: string, width: number, ellipsis: string): string {
  if (width < 1) return ""
  if (displayWidth(text) <= width) return text
  const mark = displayWidth(ellipsis) <= width ? ellipsis : ""
  const budget = width - displayWidth(mark)
  let kept = ""
  let used = 0
  for (const { segment } of GRAPHEMES.segment(text)) {
    const segmentWidth = displayWidth(segment)
    if (used + segmentWidth > budget) break
    kept += segment
    used += segmentWidth
  }
  return `${kept}${mark}`
}

/** Wrap at spaces only, counting display columns. An identifier longer than a line is left intact
 * for terminal soft wrapping and copying; no ellipsis, inserted break or discarded byte. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word
    if (!line || displayWidth(next) <= width) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}

function codePointsOf(text: string): number[] {
  const points: number[] = []
  for (const char of text) {
    const point = char.codePointAt(0)
    if (point !== undefined) points.push(point)
  }
  return points
}

function eastAsianWide(codePoint: number): boolean {
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return true
  if (codePoint >= 0x2329 && codePoint <= 0x232a) return true
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) return true
  if (codePoint >= 0xa960 && codePoint <= 0xa97f) return true
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return true
  if (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) return true
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true
  if (codePoint >= 0xfe10 && codePoint <= 0xfe19) return true
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return true
  if (codePoint >= 0xff01 && codePoint <= 0xff60) return true
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return true
  if (codePoint >= 0x1f300 && codePoint <= 0x1f64f) return true
  if (codePoint >= 0x1f900 && codePoint <= 0x1faff) return true
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return true
  return false
}

function estimateCodePoint(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint === 0xad ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f
  ) {
    return 0
  }
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0
  // Wide before the combining-mark check: a voiced kana mark is Mn and still takes two columns.
  if (eastAsianWide(codePoint)) return 2
  const char = String.fromCodePoint(codePoint)
  if (/^\p{Mn}$/u.test(char) || /^\p{Me}$/u.test(char) || /^\p{Cf}$/u.test(char)) return 0
  if (/^\p{Emoji_Presentation}$/u.test(char)) return 2
  return 1
}

function estimateGrapheme(segment: string): number {
  const points = codePointsOf(segment)
  if (points.some((point) => point === 0xfe0f)) return 2
  if (points.length >= 2 && points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff)) return 2
  if (points.includes(0x200d) && points.some((point) => point !== 0x200d && point !== 0xfe0f)) return 2
  let width = 0
  for (const point of points) width += estimateCodePoint(point)
  return width
}

/** The Node fallback for {@link displayWidth}. Covers ASCII, CJK, fullwidth forms and combining
 * marks; Bun's measure wins when this process is Bun. */
export function estimateDisplayWidth(text: string): number {
  let width = 0
  for (const { segment } of GRAPHEMES.segment(text)) width += estimateGrapheme(segment)
  return width
}

// The established block-letter CANDLE, condensed to three lines for a compact terminal header.
const WORDMARK = ["█▀▀ ▄▀█ █▄░█ █▀▄ █░░ █▀▀", "█▄▄ █▀█ █░▀█ █▄▀ █▄▄ ██▄"]

export function brandHeader(style: TerminalStyle): string[] {
  if (!style.styled) return []
  const lines = [
    ...(style.width >= 80 ? WORDMARK : ["CANDLE"]),
    `CLI ${CLI_VERSION}`,
    "",
    ...wrapText("Your wallets and agent tools, one command away.", style.width - 6),
  ]
  const width = Math.min(style.width - 2, 68)
  return [
    accent(`┌${"─".repeat(width - 2)}┐`, style),
    ...lines.map((line) => `│ ${accent(line, style)}${" ".repeat(Math.max(0, width - 4 - line.length))} │`),
    accent(`└${"─".repeat(width - 2)}┘`, style),
    "",
  ]
}

// ── The output kit (CLI legibility audit, 2026-10-27, section 3) ─────────────────────────────
// Every human screen is built from these: one fact per line, groups with air, never wider than
// the terminal, warnings set apart. `--json` never reaches any of them. Plain mode (`--plain`,
// CANDLE_PLAIN, a pipe, CI, TERM=dumb) and `--no-color` add no escape codes at all; plain mode
// also swaps every symbol for ASCII, so a pipe or a log reads the same layout in seven-bit text.

/** Prose never runs wider than this, however wide the terminal: past ~100 columns a line is
 * harder to read, not easier. Tables are bounded by the terminal width instead. */
export const PROSE_MAX = 100

/** Whether this invocation asked for full ids (`--full`); pass it to `shortId`. */
export function fullIds(deps: Pick<Deps, "presentation">): boolean {
  return deps.presentation?.full === true
}

export function proseWidth(style: TerminalStyle): number {
  return Math.min(style.width, PROSE_MAX)
}

export interface Symbols {
  ok: string
  warning: string
  danger: string
  note: string
  ellipsis: string
  /** The one mark for a value nobody knows: an en dash, never `unknown`, `?`, `not set` or `-`. */
  missing: string
}

const UNICODE_SYMBOLS: Symbols = { ok: "✓", warning: "!", danger: "✗", note: "·", ellipsis: "…", missing: "–" }
const ASCII_SYMBOLS: Symbols = { ok: "ok", warning: "!", danger: "x", note: "-", ellipsis: "...", missing: "-" }

/** `✓ ! ✗ ·` on a terminal, `ok ! x -` in plain mode. `--no-color` keeps the Unicode set: it
 * drops color, not layout. */
export function symbols(style: TerminalStyle): Symbols {
  return style.styled ? UNICODE_SYMBOLS : ASCII_SYMBOLS
}

/** SGR other than a color (bold, dim). Gated like `accent`: no color means no escape codes. */
function sgr(text: string, style: TerminalStyle, code: string): string {
  return style.color && text ? `\x1b[${code}m${text}\x1b[0m` : text
}

export function bold(text: string, style: TerminalStyle): string {
  return sgr(text, style, "1")
}

export function dim(text: string, style: TerminalStyle): string {
  return sgr(text, style, "2")
}

/** A group's heading: bold, flush left, no `==` or colon. The caller puts a blank line before it.
 * A heading longer than the prose width wraps at word boundaries, continuation flush left, so it
 * is never wider than the terminal. Text that already fits is unchanged, byte for byte. */
export function heading(text: string, style: TerminalStyle): string {
  return wrapText(text, proseWidth(style))
    .map((line) => bold(line, style))
    .join("\n")
}

/** A value the caller did not have: `undefined`, `null` or an empty string. */
export type FieldValue = string | number | undefined | null

/**
 * Label and value lines, the labels in one dim column padded to the widest label plus two. A
 * long value wraps at word boundaries under its own column, never back under the labels; an
 * identifier longer than the line is kept whole (`wrapText`). A missing value prints the one
 * missing mark. Values are printed as given: shortening an id is the caller's choice, and a
 * value the user must paste back (a new key, an address, a fingerprint) must not be.
 *
 * The value column is whatever is left after the indent and the labels. When that remainder
 * cannot hold an ordinary word, the value moves under the label instead of running past the
 * terminal. A long id still stays whole, on the label's line when the column can take it.
 */
export function fields(
  rows: ReadonlyArray<readonly [label: string, value: FieldValue]>,
  style: TerminalStyle,
  indent = 2,
): string[] {
  const budget = proseWidth(style)
  const pad = " ".repeat(Math.min(indent, Math.max(0, budget)))
  const labelWidth = Math.max(0, ...rows.map(([label]) => displayWidth(label)))
  const sideWidth = budget - pad.length - labelWidth - 2
  const out: string[] = []
  for (const [label, raw] of rows) {
    const value = raw === undefined || raw === null || raw === "" ? symbols(style).missing : String(raw)
    if (sideWidth >= 1 && fitsWidth(value, sideWidth)) {
      const [first = "", ...rest] = value.split("\n").flatMap((line) => wrapText(line, sideWidth))
      out.push(`${pad}${dim(padDisplay(label, labelWidth), style)}  ${first}`)
      for (const line of rest) out.push(`${pad}${" ".repeat(labelWidth + 2)}${line}`)
    } else {
      out.push(...stackedField(label, value, style, pad, budget))
    }
  }
  return out
}

/** Label, then the value underneath it, once the side-by-side column is too narrow for prose. */
function stackedField(label: string, value: string, style: TerminalStyle, pad: string, budget: number): string[] {
  const labelBudget = Math.max(1, budget - pad.length)
  const out = wrapText(label, labelBudget).map((line) => `${pad}${dim(line, style)}`)
  const nested = budget - pad.length - 2
  const flat = Math.max(1, budget - pad.length)
  let valueWidth = flat
  let valuePad = pad
  if (nested >= 1 && fitsWidth(value, nested)) {
    valueWidth = nested
    valuePad = `${pad}  `
  } else if (!fitsWidth(value, flat) && fitsWidth(value, Math.max(1, budget))) {
    valueWidth = Math.max(1, budget)
    valuePad = ""
  }
  for (const part of value.split("\n")) {
    for (const line of wrapText(part, valueWidth)) out.push(line ? `${valuePad}${line}` : "")
  }
  return out
}

export type NoticeLevel = "note" | "warning" | "danger"

/**
 * A notice's lines, without the blank lines around it: one symbol and one color by severity
 * (`·` dim note, `!` yellow warning, `✗` red danger), the text wrapped to the prose width with
 * continuation lines under the text, not the symbol. A blank line in `text` starts a new
 * paragraph inside the same notice.
 */
export function renderNotice(level: NoticeLevel, text: string, style: TerminalStyle, indent = 2): string[] {
  const sym = symbols(style)
  const mark = level === "note" ? sym.note : level === "warning" ? sym.warning : sym.danger
  const budget = proseWidth(style)
  const leadWidth = indent + displayWidth(mark) + 1
  const tight = budget - leadWidth
  const paint = (line: string) =>
    level === "note" ? dim(line, style) : accent(line, style, level === "warning" ? "warning" : "negative")
  if (tight >= 1 && fitsWidth(text, tight)) {
    const hang = " ".repeat(leadWidth)
    const lines = text.split("\n").flatMap((line) => (line ? wrapText(line, tight) : [""]))
    return lines.map((line, i) =>
      line ? `${i === 0 ? `${" ".repeat(indent)}${paint(mark)} ` : hang}${paint(line)}` : "",
    )
  }
  // The symbol's column would push an ordinary word past the terminal. Put the symbol on its own
  // line and give the text the remaining width, dropping the indent only when a word needs it.
  const markPrefix = " ".repeat(Math.min(indent, Math.max(0, budget - displayWidth(mark))))
  const indented = Math.max(1, budget - markPrefix.length)
  const textWidth = fitsWidth(text, indented) ? indented : Math.max(1, budget)
  const textPrefix = textWidth === indented ? markPrefix : ""
  const lines = text.split("\n").flatMap((line) => (line ? wrapText(line, textWidth) : [""]))
  return [`${markPrefix}${paint(mark)}`, ...lines.map((line) => (line ? `${textPrefix}${paint(line)}` : ""))]
}

type NoticeDeps = StyleDeps & Record<"stdout" | "stderr", { write(chunk: string): void }>

/**
 * Writes a notice set apart from what is around it: a blank line, the notice, a blank line. The
 * stream is the caller's argument, never chosen here, so every call site keeps the stream it
 * writes today (some warnings go to stdout, some to stderr, and a pipe must capture exactly what
 * it did before). The style is read from that same stream.
 */
export function notice(deps: NoticeDeps, stream: "stdout" | "stderr", level: NoticeLevel, text: string): void {
  const style = terminalStyle(deps, stream)
  deps[stream].write(`\n${renderNotice(level, text, style).join("\n")}\n\n`)
}

/** `✓ text` with the mark in the positive color; `ok text` in plain mode. A sentence longer than
 * the prose width wraps with the mark's column accounted for, and continuation lines run under
 * the text, not the mark. Text that already fits is unchanged, byte for byte. */
export function success(text: string, style: TerminalStyle): string {
  const mark = symbols(style).ok
  const hang = " ".repeat(displayWidth(mark) + 1)
  const budget = Math.max(1, proseWidth(style) - displayWidth(mark) - 1)
  const lines = text.split("\n").flatMap((line) => wrapText(line, budget))
  return lines.map((line, i) => (i === 0 ? `${accent(mark, style, "positive")} ${line}` : `${hang}${line}`)).join("\n")
}

/** `✗ text`, mark and text in the negative color; `x text` in plain mode. */
export function failure(text: string, style: TerminalStyle): string {
  return accent(`${symbols(style).danger} ${text}`, style, "negative")
}
