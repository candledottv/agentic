/** Shared kit layouts for the dense P&L and portfolio screens. */
import type { CommandContext } from "../deps"
import {
  accent,
  dim,
  displayWidth,
  fields,
  fitsWidth,
  fullIds,
  heading,
  padDisplay,
  proseWidth,
  type TerminalStyle,
  terminalStyle,
  wrapText,
} from "../presentation"
import { renderTable, shortId, type TableColumn, terminalText } from "../render"

export function financialId(ctx: CommandContext, value: string): string {
  return shortId(value, fullIds(ctx.deps))
}

export function financialToken(ctx: CommandContext, symbol: string | null | undefined, mint: string): string {
  return symbol?.trim()
    ? `${symbol.trim()}${fullIds(ctx.deps) ? ` (${financialId(ctx, mint)})` : ""}`
    : financialId(ctx, mint)
}

export function financialHeading(text: string, style: TerminalStyle): string {
  return wrapText(terminalText(text), proseWidth(style))
    .map((line) => heading(line, style))
    .join("\n")
}

function signed(text: string, style: TerminalStyle): string {
  return /^\+/.test(text)
    ? accent(text, style, "positive")
    : /^[-−]/.test(text)
      ? accent(text, style, "negative")
      : text
}

/** Keep numbers whole. If the remaining columns cannot fit, stack all fields per row. */
export function financialTable(
  ctx: CommandContext,
  headers: string[],
  rows: string[][],
  columns: (TableColumn | undefined)[],
): string {
  const style = terminalStyle(ctx.deps, "stdout")
  const clean = rows.map((row) => row.map(terminalText))
  const specs = headers.map((_, col) => {
    const spec = columns[col] ?? {}
    const numeric = clean.some((row) => /^[+−-]?[<>~]?[$]?[\d,.]+(?:[%xKMBT])?$/.test(row[col] ?? ""))
    return {
      ...spec,
      ...(numeric ? { id: true } : {}),
      ...(fullIds(ctx.deps) ? { id: true, priority: undefined } : {}),
    }
  })
  const table = renderTable(headers, clean, { columns: specs, width: style.width, style, indent: 2 })
  if (style.width >= 60 && table.split("\n").every((line) => displayWidth(line) <= style.width)) return table
  // All fields survive the narrow layout, including metadata dropped from the wide table.
  return clean
    .map((row) =>
      fields(
        headers.map((label, col) => [label, specs[col]?.signed ? signed(row[col] ?? "", style) : row[col]]),
        style,
      ).join("\n"),
    )
    .join("\n\n")
}

/** Right-aligned signed figures, with notes below when their column would be too narrow. */
export function writeFinancialLines(ctx: CommandContext, rows: string[][]): void {
  const style = terminalStyle(ctx.deps, "stdout")
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label as string)))
  const valueWidth = Math.max(...rows.map(([, value]) => displayWidth(value as string)))
  const noteIndent = 2 + labelWidth + 2 + valueWidth + 2
  const noteWidth = proseWidth(style) - noteIndent
  for (const [label = "", value = "", note = ""] of rows) {
    const head = `  ${dim(padDisplay(label, labelWidth), style)}  ${" ".repeat(valueWidth - displayWidth(value))}${signed(value, style)}`
    if (displayWidth(head) > style.width) {
      ctx.deps.stdout.write(`${fields([[label, signed(value, style)]], style).join("\n")}\n`)
      if (note)
        ctx.deps.stdout.write(
          `${wrapText(terminalText(note), Math.max(1, proseWidth(style) - 4))
            .map((line) => `    ${dim(line, style)}`)
            .join("\n")}\n`,
        )
    } else if (note && (noteWidth < 16 || !fitsWidth(note, noteWidth))) {
      ctx.deps.stdout.write(
        `${head}\n${wrapText(terminalText(note), Math.max(1, proseWidth(style) - 4))
          .map((line) => `    ${dim(line, style)}`)
          .join("\n")}\n`,
      )
    } else {
      const [first = "", ...rest] = wrapText(terminalText(note), Math.max(1, noteWidth))
      ctx.deps.stdout.write(`${head}${first ? `  ${dim(first, style)}` : ""}\n`)
      for (const line of rest) ctx.deps.stdout.write(`${" ".repeat(noteIndent)}${dim(line, style)}\n`)
    }
  }
}
