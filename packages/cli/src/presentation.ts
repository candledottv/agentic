import type { Deps } from "./deps"
import { TERMINAL_TOKENS } from "./terminal-theme"
import { CLI_VERSION } from "./version"

export interface PresentationFlags {
  plain?: boolean
  noColor?: boolean
}

export interface TerminalStyle {
  width: number
  styled: boolean
  color: 0 | 16 | 256 | 24
  theme: "light" | "dark"
  motion: boolean
}

/** Inspect the stream being rendered, never stdin or a different output stream. Unknown
 * backgrounds use the conservative light palette; foreground/background remain terminal defaults. */
export function terminalStyle(deps: Deps, stream: "stdout" | "stderr", machine = false): TerminalStyle {
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

/** Wrap at spaces only. An identifier longer than a line is left intact for terminal soft
 * wrapping and copying; no ellipsis, inserted break or discarded byte. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (!line || line.length + word.length + 1 <= width) line += `${line ? " " : ""}${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
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
