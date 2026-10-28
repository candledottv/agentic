import type { Deps } from "./deps"
import { type FieldValue, fields, heading, success, terminalStyle } from "./presentation"
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
  deps[stream].write(`${renderTable(headers, rows, { style, width: style.width, indent: 2, rule: false, columns })}\n`)
}
