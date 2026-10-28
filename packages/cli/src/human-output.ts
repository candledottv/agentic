import type { Deps } from "./deps"
import {
  displayWidth,
  type FieldValue,
  fields,
  heading,
  success,
  type TerminalStyle,
  terminalStyle,
} from "./presentation"
import { renderTable, type TableColumn } from "./render"

/** Small writers for command screens. The caller always chooses the existing stream;
 * machine output and confirmation prompts never pass through these helpers. */
export function writeFields(
  deps: Deps,
  stream: "stdout" | "stderr",
  rows: ReadonlyArray<readonly [string, FieldValue]>,
  title?: string,
): void {
  const style = terminalStyle(deps, stream)
  deps[stream].write(`${title ? `${heading(title, style)}\n\n` : ""}${fields(rows, style).join("\n")}\n`)
}

export function writeSuccess(deps: Deps, stream: "stdout" | "stderr", text: string): void {
  deps[stream].write(`${success(text, terminalStyle(deps, stream))}\n`)
}

export function writeTable(
  deps: Deps,
  stream: "stdout" | "stderr",
  headers: string[],
  rows: string[][],
  columns: readonly (TableColumn | undefined)[],
): void {
  const style = terminalStyle(deps, stream)
  deps[stream].write(`${renderHumanTable(headers, rows, style, columns)}\n`)
}

export function writeHeading(deps: Deps, stream: "stdout" | "stderr", text: string): void {
  deps[stream].write(`\n${heading(text, terminalStyle(deps, stream))}\n\n`)
}

/** If required identifier columns still overflow after fitting, show each row as fields.
 * This keeps the full identifiers and safety states instead of clipping or hiding them. */
export function renderHumanTable(
  headers: string[],
  rows: string[][],
  style: TerminalStyle,
  columns: readonly (TableColumn | undefined)[],
): string {
  const table = renderTable(headers, rows, { style, width: style.width, indent: 2, rule: false, columns })
  if (!table.split("\n").some((line) => displayWidth(line) > style.width)) return table
  return rows
    .map((row) =>
      fields(
        headers.map((label, i) => [label, row[i]] as const),
        style,
      ).join("\n"),
    )
    .join("\n\n")
}
