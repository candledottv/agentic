/** BE-1145: file checks before unlock, then whole-index checks before a single write. */
import type { IndexPlaintext, KeyEntry } from "./format"
import { resolveRenameTarget, validateLabel } from "./labels"

export const MAX_RENAME_BATCH = 256
export interface RenamePair {
  line: number
  from: string
  to: string
}
export interface RenameFinding {
  line: number
  problem: string
}
export interface PlannedRename extends RenamePair {
  entry: KeyEntry
}

/** Single-line CSV, with quoted commas and escaped quotes. Cell values are never trimmed. */
function csvCells(text: string): string[] | undefined {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  let closed = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else cell += char
    } else if (char === ",") {
      cells.push(cell)
      cell = ""
      closed = false
    } else if (char === '"' && cell === "" && !closed) quoted = true
    else if (char === '"' || closed) return undefined
    else cell += char
  }
  if (quoted) return undefined
  cells.push(cell)
  return cells
}

export function parseRenamePairs(contents: string): { rows: RenamePair[]; findings: RenameFinding[] } {
  const lines = contents
    .split(/\r?\n/)
    .map((text, at) => ({ text, line: at + 1 }))
    .filter(({ text }) => text.trim() !== "" && !/^\s*#/.test(text))
  const rows: RenamePair[] = []
  const findings: RenameFinding[] = []
  const header = csvCells(lines[0]?.text ?? "")?.map((cell) => cell.trim()) ?? []
  const csv = header.length > 1 && (header.includes("from") || header.includes("to"))
  if (
    csv &&
    (header.filter((name) => name === "from").length !== 1 || header.filter((name) => name === "to").length !== 1)
  ) {
    return {
      rows,
      findings: [{ line: lines[0]?.line ?? 0, problem: "A CSV needs exactly one from and one to column." }],
    }
  }
  const data = csv ? lines.slice(1) : lines
  if (data.length < 1 || data.length > MAX_RENAME_BATCH) {
    findings.push({ line: 0, problem: `A rename file must hold 1 to ${MAX_RENAME_BATCH} rows; found ${data.length}.` })
  }
  for (const { text, line } of data) {
    let from: string | undefined
    let to: string | undefined
    if (csv) {
      const cells = csvCells(text)
      if (cells === undefined || cells.length !== header.length) {
        findings.push({ line, problem: "Malformed CSV row or field count does not match the header." })
        continue
      }
      from = cells[header.indexOf("from")]
      to = cells[header.indexOf("to")]
    } else {
      // Separator whitespace is syntax; a trailing space in the new name is retained and refused.
      const match = /^(\S+)[ \t]+(\S+)([ \t]*)$/.exec(text)
      if (match !== null) [from, to] = [match[1], `${match[2]}${match[3]}`]
    }
    if (from === undefined || from === "" || to === undefined) {
      findings.push({ line, problem: 'A row needs "<label|address|id> <new-label>" (CSV columns: from,to).' })
      continue
    }
    rows.push({ line, from, to })
    const invalid = validateLabel(to)
    if (invalid !== undefined) findings.push({ line, problem: invalid })
  }
  for (const field of ["from", "to"] as const) {
    const seen = new Map<string, number>()
    for (const row of rows) {
      const earlier = seen.get(row[field])
      if (earlier !== undefined)
        findings.push({ line: row.line, problem: `Duplicate ${field} ${row[field]} (line ${earlier}).` })
      else seen.set(row[field], row.line)
    }
  }
  return { rows, findings }
}

export function planBatchRename(
  index: IndexPlaintext,
  rows: RenamePair[],
): { plan: PlannedRename[]; findings: RenameFinding[] } {
  const plan: PlannedRename[] = []
  const findings: RenameFinding[] = []
  const seen = new Map<string, number>()
  for (const row of rows) {
    const match = resolveRenameTarget(index, row.from)
    if (match.kind !== "found") {
      findings.push({
        line: row.line,
        problem:
          match.kind === "none"
            ? `No key matches ${row.from}.`
            : `${row.from} is ambiguous; use an id. Candidates: ${match.candidates.map((entry) => `${entry.address} (${entry.id})`).join(", ")}.`,
      })
      continue
    }
    const entry = match.entry
    const earlier = seen.get(entry.id)
    if (earlier !== undefined)
      findings.push({ line: row.line, problem: `Same key as line ${earlier}, named by another handle.` })
    else seen.set(entry.id, row.line)
    if (entry.role !== "vault" && entry.role !== "external") {
      findings.push({
        line: row.line,
        problem: `${entry.label} is a TEE wallet; vault rename only changes vault or external keys.`,
      })
    }
    if (entry.label === row.to) findings.push({ line: row.line, problem: `${row.to} is already this key's label.` })
    plan.push({ ...row, entry })
  }
  const targets = new Set(plan.map(({ entry }) => entry.id))
  for (const row of plan) {
    if (index.entries.some((entry) => entry.label === row.to && !targets.has(entry.id))) {
      findings.push({ line: row.line, problem: `New name ${row.to} is taken by a key outside the batch.` })
    }
  }
  return { plan, findings }
}
