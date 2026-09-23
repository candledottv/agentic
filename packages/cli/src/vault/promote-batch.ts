/**
 * BE-285 (spec `2026-09-22-cli-vault-promote-batch-design.md`): the pure half of
 * `candle vault promote-batch`. The file parser (D3, D4, D5), Phase A (D7), the re-run classifier
 * (D11), the projected whole-set preflight (D6), the refusal report (D7) and the acknowledgement
 * rule (D10). Nothing here takes a `ctx`, prompts, or touches the network: the two checks that need
 * the unlocked vault or the API (`verifySubject`, `reconcileResume`) are injected by the command,
 * so the walk itself is a unit test.
 *
 * The centre of the spec is `preflightBatch`. Today's per-key preconditions checked against the
 * vault's CURRENT index do not prevent a batch from promoting 90 keys and refusing the 91st,
 * because the batch's own writes change the answers for its later rows: row 5 promoting `p-3`
 * turns row 90's destination `p-3` into a `tee-wallet`, and pins `p-3` against a row 91 whose
 * subject it is. So every `promote` row is checked with the SHIPPED `assertInPlacePreconditions`
 * against a projected index, and on success that row's write is applied to the projection with
 * the same `applyPromotion` the loop commits. One mutation, two callers.
 */
import { renderTable } from "../render"
import { isVaultError } from "./errors"
import type { IndexPlaintext, KeyEntry } from "./format"
import { applyPromotion, assertInPlacePreconditions, findEntryByLabelOrAddress } from "./promote-support"

/**
 * The upper bound on rows. The same number as `MAX_NEW_KEY_COUNT` and deliberately not the same
 * constant: that one bounds claimed derivation indexes, this one bounds irreversible TEE
 * exposures, and a future change to either reason must not silently move the other (D5). 256
 * sits above the 146-row run this was built for and well below anything that could be a typo for
 * a small number.
 */
export const MAX_PROMOTE_BATCH = 256

/** One row of the `--pairs-from` file, as read: a label that names an EXISTING vault key and its
 * sweep destination, plus the columns the batch echoes and never interprets. */
export interface PairRow {
  /** 1-based line in the file, which is what every refusal and every table row names. */
  line: number
  label: string
  destination: string
  /** The `order` cell, when the file has that column; checked strictly increasing (D5). */
  order?: string
  /** The `value_usd` cell, verbatim; echoed under `value_usd (yours)`, never computed (D4). */
  valueUsd?: string
}

export interface PhaseAFinding {
  /** The line it is about, or 0 for a finding about the file as a whole. */
  line: number
  problem: string
}

export type ParsedPairs =
  | { ok: true; rows: PairRow[]; format: "csv" | "pairs"; hasValueUsd: boolean }
  | { ok: false; findings: PhaseAFinding[] }

const COMMENT = /^\s*#/

/**
 * Reads the file in either accepted spelling and runs every Phase A check: both fields present, no
 * blank field, no duplicate label, `order` strictly increasing, row count in 2..256. All findings
 * are collected and reported together, so a file with three malformed lines names all three (D7).
 *
 * CSV is selected by the first non-comment line holding both `label` and `sweep_to`, and columns
 * are picked BY NAME and never by position (D3): `order,label,family,sweep_to,value_usd` is one
 * operator's column order, and positional selection would map `family` to the destination for
 * anyone whose export orders columns differently.
 */
export function parsePairsFile(contents: string, opts: { file: string; rpcUrl: string }): ParsedPairs {
  const findings: PhaseAFinding[] = []
  const lines = contents.split(/\r?\n/)
  const meaningful: Array<{ line: number; text: string }> = []
  for (const [at, raw] of lines.entries()) {
    if (raw.trim().length === 0 || COMMENT.test(raw)) continue
    meaningful.push({ line: at + 1, text: raw })
  }
  const first = meaningful[0]
  if (first === undefined) {
    return { ok: false, findings: [{ line: 0, problem: `${opts.file} has no rows; there is nothing to promote.` }] }
  }

  const rows: PairRow[] = []
  let format: "csv" | "pairs" = "pairs"
  let hasValueUsd = false
  const headerCells = first.text.split(",").map((cell) => cell.trim())
  const namesLabel = headerCells.includes("label")
  const namesSweepTo = headerCells.includes("sweep_to")
  if (namesLabel && namesSweepTo) {
    format = "csv"
    const at = (name: string) => headerCells.indexOf(name)
    const labelAt = at("label")
    const sweepAt = at("sweep_to")
    const orderAt = at("order")
    const valueAt = at("value_usd")
    hasValueUsd = valueAt !== -1
    for (const { line, text } of meaningful.slice(1)) {
      const cells = text.split(",").map((cell) => cell.trim())
      if (cells.length !== headerCells.length) {
        findings.push({
          line,
          problem: `has ${cells.length} field${cells.length === 1 ? "" : "s"}; the header names ${headerCells.length}`,
        })
        continue
      }
      const label = cells[labelAt] ?? ""
      const destination = cells[sweepAt] ?? ""
      if (label === "" || destination === "") {
        findings.push({ line, problem: `blank ${label === "" ? "label" : "sweep_to"}` })
        continue
      }
      rows.push({
        line,
        label,
        destination,
        ...(orderAt !== -1 ? { order: cells[orderAt] ?? "" } : {}),
        ...(valueAt !== -1 ? { valueUsd: cells[valueAt] ?? "" } : {}),
      })
    }
  } else if ((namesLabel || namesSweepTo) && headerCells.length > 1) {
    // A header that names one of the two required columns and not the other is a CSV with a
    // column missing, not a whitespace file: say which columns were found (D3).
    return {
      ok: false,
      findings: [
        {
          line: first.line,
          problem: `a CSV needs both a label and a sweep_to column; found: ${headerCells.join(", ")}`,
        },
      ],
    }
  } else {
    for (const { line, text } of meaningful) {
      const fields = text.trim().split(/\s+/)
      if (fields.length !== 2) {
        findings.push({
          line,
          problem:
            fields.length === 1
              ? `only one field; a row is "<label> <destination>"`
              : `${fields.length} fields; a row is "<label> <destination>"`,
        })
        continue
      }
      rows.push({ line, label: fields[0] as string, destination: fields[1] as string })
    }
  }

  // Duplicate labels (D7, the rule `--labels-from` already enforces): two rows under one name in
  // a 1:1 migration is a mapping nobody can reconstruct afterwards. Reported on the earlier
  // line, naming the later one (§4.5).
  const seen = new Map<string, number>()
  for (const row of rows) {
    const earlier = seen.get(row.label)
    if (earlier !== undefined) {
      findings.push({ line: earlier, problem: `label ${row.label} appears again on line ${row.line}` })
      continue
    }
    seen.set(row.label, row.line)
  }

  // `order` strictly increasing down the file (D5): the file's LINE order is what runs, and a
  // spreadsheet re-sorted after the column was written is the real risk. The column need not
  // start at 1, so one global ordering split across several files keeps working.
  let previous: { line: number; value: number } | undefined
  for (const row of rows) {
    if (row.order === undefined) continue
    const value = Number(row.order)
    if (row.order.trim() === "" || !Number.isFinite(value)) {
      findings.push({ line: row.line, problem: `order "${row.order}" is not a number` })
      continue
    }
    if (previous !== undefined && !(value > previous.value)) {
      findings.push({
        line: row.line,
        problem: `order ${row.order} is not greater than the previous row's ${previous.value}; the file's line order is what runs`,
      })
    }
    previous = { line: row.line, value }
  }

  if (findings.length === 0) {
    if (rows.length === 1) {
      const only = rows[0] as PairRow
      findings.push({
        line: 0,
        problem: `${opts.file} holds one row, and a batch of one buys nothing over the single command. Run: candle vault promote --in-place ${only.label} --sweep-to ${only.destination} --rpc-url ${opts.rpcUrl}`,
      })
    } else if (rows.length > MAX_PROMOTE_BATCH) {
      findings.push({
        line: 0,
        problem: `${opts.file} holds ${rows.length} rows; a batch is capped at ${MAX_PROMOTE_BATCH}. Split the file and run each part.`,
      })
    } else if (rows.length === 0) {
      findings.push({ line: 0, problem: `${opts.file} has no rows; there is nothing to promote.` })
    }
  }

  if (findings.length > 0) return { ok: false, findings }
  return { ok: true, rows, format, hasValueUsd }
}

/** The Phase A refusal as one message (§4.5): the count, the lines, and that nothing was unlocked. */
export function renderPhaseAFindings(file: string, findings: PhaseAFinding[]): string {
  const fileLevel = findings.filter((finding) => finding.line === 0)
  const perLine = findings.filter((finding) => finding.line !== 0)
  if (perLine.length === 0) return fileLevel.map((finding) => `${finding.problem} Nothing was unlocked.`).join("\n")
  const width = Math.max(...perLine.map((finding) => String(finding.line).length))
  const lines = perLine.map((finding) => `  line ${String(finding.line).padEnd(width)}   ${finding.problem}`)
  return [
    `${file}: ${perLine.length} line${perLine.length === 1 ? "" : "s"} cannot be used, and nothing was unlocked.`,
    ...lines,
    ...fileLevel.map((finding) => finding.problem),
  ].join("\n")
}

// ── Classification (D11) ────────────────────────────────────────────────────────────────────

export type RowState = "promote" | "resume" | "skip" | "conflict"

export interface Classified {
  state: RowState
  /** The entry the label named, when one exists. Absent: `promote`, and the shipped precondition refuses it. */
  subject?: KeyEntry
  /** The address this row's `sweep_to` resolves to on the real index (or the cell itself). */
  destinationAddress: string
  /** For a `tee-wallet` subject: the destination already pinned on disk, if any. */
  onDisk?: string
}

/** The address a `sweep_to` cell names: a label's entry, or the cell itself when it is an address. */
export function resolveDestinationAddress(index: IndexPlaintext, destination: string): string {
  return findEntryByLabelOrAddress(index, destination)?.address ?? destination
}

/**
 * D11's table, against the REAL index. `promote` is anything the shipped precondition should judge
 * (a `role: "vault"` key, an unknown label, an external entry); `resume`, `skip` and `conflict`
 * are the three shapes a `tee-wallet` subject can be in relative to this row's destination.
 */
export function classifyRow(index: IndexPlaintext, row: PairRow): Classified {
  const subject = findEntryByLabelOrAddress(index, row.label)
  const destinationAddress = resolveDestinationAddress(index, row.destination)
  if (subject === undefined || subject.role !== "tee-wallet") {
    return { state: "promote", ...(subject ? { subject } : {}), destinationAddress }
  }
  const lifecycle = subject.tee?.lifecycle
  const onDisk = subject.tee?.vaultDestination
  const base = { subject, destinationAddress, ...(onDisk !== undefined ? { onDisk } : {}) }
  if (lifecycle === "import-pending" || lifecycle === "local-candidate") {
    if (onDisk === undefined || onDisk === destinationAddress) return { state: "resume", ...base }
    return { state: "conflict", ...base }
  }
  if (lifecycle === "enabled" && onDisk === destinationAddress) return { state: "skip", ...base }
  return { state: "conflict", ...base }
}

// ── The preflight (D6, D7) ──────────────────────────────────────────────────────────────────

export interface RefusedRow {
  line: number
  label: string
  destination: string
  /** The shipped `VaultError` code, verbatim. */
  code: string
  /** The shipped message, verbatim. */
  message: string
  suggestion?: string
  /** The batch's one-clause annotation naming the earlier row of this file that caused it (D7). */
  why?: string
}

export type PlannedRow =
  | {
      kind: "promote"
      row: PairRow
      subject: KeyEntry
      destination: KeyEntry
      /** Whether `--accept-unknown-exposure` was what admitted this row's destination (`promote*`). */
      acceptedUnknown: boolean
    }
  | {
      kind: "resume"
      row: PairRow
      subject: KeyEntry
      destinationAddress: string
      /** The account a grant-less entry will assert, printed once in the footer (D11). */
      account?: string
    }
  | { kind: "skip"; row: PairRow; subject: KeyEntry; destinationAddress: string }

export interface ResumeReconciled {
  ok: true
  /** The destination the loop's `confirmDestination` accepts: the pin on disk, or the server's for a local-candidate. */
  destinationAddress: string
  account?: string
}
export interface ResumeRefused {
  ok: false
  failure: Pick<RefusedRow, "code" | "message" | "suggestion" | "why">
}

export interface PreflightOptions {
  acceptUnknownExposure: boolean
  /** The timestamp the projection writes into `promotedInPlaceAt`. */
  now: string
  /** The stored-secret-matches-address compare (`vault-promote.ts` `:372-377`), for every resolved subject. Throws to refuse. */
  verifySubject: (subject: KeyEntry) => Promise<void>
  /** Phase B's reconcile of one `resume` row: `reconcileGrant`, no write, no prompt (D11). */
  reconcileResume: (
    row: PairRow,
    subject: KeyEntry,
    resolved: { onDisk?: string; destinationAddress: string },
  ) => Promise<ResumeReconciled | ResumeRefused>
}

export interface Preflight {
  /** Every row that passed, in file order, with what the loop will do to it. */
  planned: PlannedRow[]
  /** Every row that fails given that the rows before it which could run did run (D7). */
  failures: RefusedRow[]
  /** The index as the walk left it: every accepted `promote` row applied. T-P2 compares it to disk. */
  projection: IndexPlaintext
}

/**
 * §4.6, as code. Walks the file in order. For each row: classify against the real index, verify
 * the stored secret for every resolved subject, then `skip` contributes nothing, `conflict` is a
 * failure, `resume` is reconciled without writing, and `promote` goes through the shipped
 * `assertInPlacePreconditions` against the PROJECTION and, on success, is applied to it.
 *
 * The continuation rule, stated exactly because it is the one place the report is not exhaustive:
 * a refused row's write is not projected, and checking continues against the projection as it
 * stands. That is the honest continuation, because a refused row would not have been written. Its
 * consequence is that a later row which only fails BECAUSE an earlier refused row would have run
 * is not reported; the refusal says so, and the next run re-preflights from scratch.
 */
export async function preflightBatch(
  index: IndexPlaintext,
  rows: PairRow[],
  opts: PreflightOptions,
): Promise<Preflight> {
  let projection = index
  const planned: PlannedRow[] = []
  const failures: RefusedRow[] = []
  /** Destination address -> the line whose accepted row pinned it, for the `why` on a pinned subject. */
  const pinnedBy = new Map<string, number>()
  /** Subject label and address -> the line whose accepted row promoted it, for the `why` on a promoted destination. */
  const promotedBy = new Map<string, number>()

  const refuse = (row: PairRow, failure: Pick<RefusedRow, "code" | "message" | "suggestion" | "why">) => {
    failures.push({
      line: row.line,
      label: row.label,
      destination: row.destination,
      code: failure.code,
      message: failure.message,
      ...(failure.suggestion !== undefined ? { suggestion: failure.suggestion } : {}),
      ...(failure.why !== undefined ? { why: failure.why } : {}),
    })
  }
  const refuseWith = (row: PairRow, error: unknown, why?: string) => {
    if (isVaultError(error)) {
      refuse(row, {
        code: error.code,
        message: error.message,
        ...(error.suggestion !== undefined ? { suggestion: error.suggestion } : {}),
        ...(why !== undefined ? { why } : {}),
      })
      return
    }
    refuse(row, { code: "VAULT_UNREADABLE", message: error instanceof Error ? error.message : String(error) })
  }

  for (const row of rows) {
    const classified = classifyRow(index, row)

    // D6's second uncovered check: decrypt, compare, wipe, retain nothing. A failure is that row's
    // only line and the row is not projected.
    if (classified.subject !== undefined) {
      try {
        await opts.verifySubject(classified.subject)
      } catch (error) {
        refuseWith(row, error)
        continue
      }
    }

    if (classified.state === "skip") {
      planned.push({
        kind: "skip",
        row,
        subject: classified.subject as KeyEntry,
        destinationAddress: classified.destinationAddress,
      })
      continue
    }

    if (classified.state === "conflict") {
      const subject = classified.subject as KeyEntry
      const lifecycle = subject.tee?.lifecycle ?? "unknown"
      // The shipped `PROMOTE_ALREADY_TEE_WALLET` sentence (`promote-support.ts:125-128`), then D11
      // naming the destination on disk and the one in the file.
      refuse(row, {
        code: "PROMOTE_ALREADY_TEE_WALLET",
        message: `${subject.label ?? subject.address} is already a TEE wallet (${lifecycle}).`,
        why:
          classified.onDisk !== undefined
            ? `On disk it sweeps to ${classified.onDisk}; this file says ${row.destination} (${classified.destinationAddress}).`
            : `Its lifecycle is ${lifecycle}, which is not resumable; this file says ${row.destination}.`,
      })
      continue
    }

    if (classified.state === "resume") {
      const subject = classified.subject as KeyEntry
      const reconciled = await opts.reconcileResume(row, subject, {
        ...(classified.onDisk !== undefined ? { onDisk: classified.onDisk } : {}),
        destinationAddress: classified.destinationAddress,
      })
      if (!reconciled.ok) {
        refuse(row, reconciled.failure)
        continue
      }
      planned.push({
        kind: "resume",
        row,
        subject,
        destinationAddress: reconciled.destinationAddress,
        ...(reconciled.account !== undefined ? { account: reconciled.account } : {}),
      })
      // Not projected: the pin and the exposure are already on the real index (D6).
      continue
    }

    // `promote`: the shipped function, its shipped codes and messages, against the projection.
    try {
      const { subject, destination, resume } = assertInPlacePreconditions(projection, row.label, row.destination, {
        acceptUnknownExposure: opts.acceptUnknownExposure,
      })
      if (resume) {
        // Unreachable by construction: the classifier sends every `tee-wallet` subject elsewhere.
        // Guarded so a future classifier change cannot make the preflight and the loop disagree.
        refuse(row, {
          code: "PROMOTE_ALREADY_TEE_WALLET",
          message: `${subject.label ?? subject.address} is already a TEE wallet (${subject.tee?.lifecycle ?? "unknown"}).`,
        })
        continue
      }
      const acceptedUnknown = opts.acceptUnknownExposure && destination.exposure?.exposureUnknown === true
      planned.push({ kind: "promote", row, subject, destination, acceptedUnknown })
      projection = applyPromotion(projection, subject, destination, {
        now: opts.now,
        acceptUnknownExposure: opts.acceptUnknownExposure,
      })
      if (!pinnedBy.has(destination.address)) pinnedBy.set(destination.address, row.line)
      promotedBy.set(subject.label, row.line)
      promotedBy.set(subject.address, row.line)
    } catch (error) {
      refuseWith(row, error, annotate(error, row, classified, pinnedBy, promotedBy))
    }
  }

  return { planned, failures, projection }
}

/** The one clause the report may add to a shipped message: which earlier row of this file caused it (D7). */
function annotate(
  error: unknown,
  row: PairRow,
  classified: Classified,
  pinnedBy: Map<string, number>,
  promotedBy: Map<string, number>,
): string | undefined {
  if (!isVaultError(error)) return undefined
  if (error.code === "PROMOTE_KEY_IS_PINNED_DESTINATION" && classified.subject !== undefined) {
    const line = pinnedBy.get(classified.subject.address)
    if (line !== undefined) return `Row ${line} of this file sweeps to ${row.label}.`
  }
  if (error.code === "PROMOTE_DESTINATION_NOT_COLD") {
    const line = promotedBy.get(row.destination) ?? promotedBy.get(classified.destinationAddress)
    if (line !== undefined) return `${row.destination} is promoted by row ${line} of this file.`
  }
  return undefined
}

// ── The refusal report (D7, §4.5) ───────────────────────────────────────────────────────────

/** The load-bearing sentence: the report is not "every row that will ever fail" (D7). */
export const CONTINUATION_SENTENCE = (total: number) =>
  `Each row was checked against the vault as it will be when the rows above it have run, so this is\n` +
  `every row that fails on that basis. Fix these rows and run again; the next run re-checks all ${total}\n` +
  `from scratch.`

/**
 * One function, two renderings, so they cannot drift: a table on stderr in human mode, one JSON
 * document on stdout under `--json`, carrying the same keys `writeLocalFailure` produces plus
 * `rows`. Returned rather than thrown because `VaultError.details` cannot carry a row list.
 */
export function writeBatchRefusal(
  deps: { stdout: { write: (chunk: string) => unknown }; stderr: { write: (chunk: string) => unknown } },
  json: boolean,
  refusal: { rows: RefusedRow[]; total: number },
): void {
  const n = refusal.rows.length
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        ok: false,
        code: "PROMOTE_BATCH_REFUSED",
        message: `${n} of ${refusal.total} rows cannot run; nothing was written.`,
        suggestion: "Fix the rows below and run again; the next run re-checks every row from scratch.",
        rows: refusal.rows.map((row) => ({
          line: row.line,
          label: row.label,
          destination: row.destination,
          code: row.code,
          message: row.message,
          ...(row.why !== undefined ? { why: row.why } : {}),
        })),
      })}\n`,
    )
    return
  }
  const table = renderTable(
    ["#", "label", "destination", "code", "why"],
    refusal.rows.map((row) => [
      String(row.line),
      row.label,
      row.destination,
      row.code,
      row.why !== undefined ? `${row.message} ${row.why}` : row.message,
    ]),
  )
  deps.stderr.write(
    `This batch was refused and NOTHING was written. ${n} of ${refusal.total} rows cannot run:\n\n${table}\n\n${CONTINUATION_SENTENCE(refusal.total)}\n`,
  )
}

// ── The acknowledgement (D10) ───────────────────────────────────────────────────────────────

export interface Destination {
  label: string
  address: string
}

/**
 * The typed line against the acting count and the destinations in listed order. Split on
 * whitespace; the count as a decimal integer; each remaining token the corresponding address's
 * last six, case-sensitive (base58 is, and `confirmLastSix` compares exactly). A wrong number of
 * tokens is itself a mismatch. The reason names the POSITION and never the expected value, so a
 * refusal cannot become a copy-paste prompt.
 */
export function checkAcknowledgement(
  typed: string,
  actingCount: number,
  destinations: Destination[],
): { ok: true } | { ok: false; reason: string } {
  const tokens = typed
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  const expected = 1 + destinations.length
  if (tokens.length !== expected) {
    return {
      ok: false,
      reason: `The answer has ${tokens.length} token${tokens.length === 1 ? "" : "s"}; ${expected} were expected (the count, then the last six of each destination).`,
    }
  }
  if (tokens[0] !== String(actingCount)) return { ok: false, reason: "The count did not match." }
  for (const [at, destination] of destinations.entries()) {
    if (tokens[at + 1] !== destination.address.slice(-6)) {
      return {
        ok: false,
        reason: `Token ${at + 2} of ${expected} is not the last six of the destination ${destination.label}.`,
      }
    }
  }
  return { ok: true }
}

// ── Display helpers (D4, D8) ────────────────────────────────────────────────────────────────

/** `value_usd`, leniently: commas and a leading `$` tolerated, as `parseUsdToMicros` does. `undefined` when it does not parse. */
export function parseValueUsdCell(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "")
  if (cleaned.length === 0) return undefined
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

/** `$310,749.00`: two decimals and thousands separators, for the footer's own-column total. */
export function formatUsd(value: number): string {
  const [whole, fraction] = value.toFixed(2).split(".")
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `$${grouped}.${fraction ?? "00"}`
}

/** Lamports as SOL with six decimals, the way the transcript shows it. */
export function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n
  const fraction = lamports % 1_000_000_000n
  return `${whole}.${fraction.toString().padStart(9, "0").slice(0, 6)}`
}

/** `p-2 (…kL3f9a)`: a destination named by its label and its last six, the token the operator types. */
export function destinationCell(label: string, address: string): string {
  return `${label} (…${address.slice(-6)})`
}

/** The distinct destinations of the acting rows, in the order they first appear, with their key counts. */
export function actingDestinations(planned: PlannedRow[]): Array<Destination & { keys: number }> {
  const out: Array<Destination & { keys: number }> = []
  for (const item of planned) {
    if (item.kind === "skip") continue
    const address = item.kind === "promote" ? item.destination.address : item.destinationAddress
    const label = item.kind === "promote" ? item.destination.label : item.row.destination
    const existing = out.find((candidate) => candidate.address === address)
    if (existing !== undefined) existing.keys += 1
    else out.push({ label, address, keys: 1 })
  }
  return out
}
