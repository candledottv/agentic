/**
 * The core's operation journal (BE-1665, spec C-4 and K-10): `journal.jsonl`, append-only, one
 * JSON row per line, fsync'd before `append` resolves.
 *
 * Every card, approval, operation transition, refused call and client event becomes one row. The
 * order matters for reconciliation (K-7, R-2): an operation's `submitting` row is on disk before
 * its request is sent, so a core that dies mid-call finds it on the next start. That is why a
 * row is never buffered: `append` resolves only after the file descriptor has been synced.
 *
 * Invariant 8: every row carries `environment`, `profile` and `mode`, and passed the redactor.
 * Both are enforced here, at the one writer, rather than trusted to every caller.
 *
 * A row is never rewritten or deleted. A torn last line (the process died mid-write) is left
 * where it is; the next start terminates it with a newline, skips it when reading, and records
 * that it did so in a row of its own.
 */
import { chmod, type FileHandle, open, readFile } from "node:fs/promises"
import type { Redactor } from "./redact"

export type CoreEnvironment = "staging" | "production"
/** `paper` for a paper trade's rows; `live` for everything else, which acts on the real environment. */
export type JournalMode = "paper" | "live"

export interface JournalRow {
  seq: number
  at: string
  type: string
  environment: CoreEnvironment
  profile: string
  mode: JournalMode
  [field: string]: unknown
}

export type JournalInput = { type: string; mode?: JournalMode } & Record<string, unknown>

export interface JournalReadResult {
  rows: JournalRow[]
  /** Lines that did not parse as a row: a torn tail, or damage. Counted, never thrown on. */
  skipped: number
  /** Whether the file ended mid-line when it was opened. */
  tornTail: boolean
}

const RESERVED = new Set(["seq", "at", "environment", "profile"])

export class Journal {
  private chain: Promise<unknown> = Promise.resolve()
  private seq: number
  private closed = false

  private constructor(
    private readonly handle: FileHandle,
    private readonly redactor: Redactor,
    private readonly identity: { environment: CoreEnvironment; profile: string },
    private readonly now: () => number,
    readonly history: JournalReadResult,
  ) {
    this.seq = history.rows.reduce((max, row) => Math.max(max, row.seq), 0)
  }

  /**
   * Opens (creating, mode 0600) the journal at `path` and reads what it already holds. A row
   * written under a different environment or profile is a sign the state directory was copied
   * or reused, and is refused rather than merged: the core is bound to one of each for its life.
   */
  static async open(input: {
    path: string
    redactor: Redactor
    environment: CoreEnvironment
    profile: string
    now: () => number
  }): Promise<Journal> {
    const history = await readJournal(input.path)
    const foreign = history.rows.find((row) => row.environment !== input.environment || row.profile !== input.profile)
    if (foreign !== undefined) {
      throw new JournalIdentityError(
        `This journal holds rows for profile "${foreign.profile}" on ${foreign.environment}; this core is profile "${input.profile}" on ${input.environment}.`,
      )
    }
    const handle = await open(input.path, "a", 0o600)
    // The mode on `open` applies only when the file is created; an older, looser file is tightened.
    await chmod(input.path, 0o600)
    const journal = new Journal(
      handle,
      input.redactor,
      { environment: input.environment, profile: input.profile },
      input.now,
      history,
    )
    if (history.tornTail) {
      await journal.raw("\n")
      await journal.append({ type: "journal.torn_tail", skipped: history.skipped })
    }
    return journal
  }

  /** Appends one row and resolves once it is on disk. Rows are written in call order. */
  append(input: JournalInput): Promise<JournalRow> {
    const next = this.chain.then(async () => {
      if (this.closed) throw new Error("The journal is closed.")
      for (const field of Object.keys(input)) {
        if (RESERVED.has(field)) throw new Error(`A journal row may not set "${field}"; the journal does.`)
      }
      const mode = input.mode ?? "live"
      if (mode !== "paper" && mode !== "live")
        throw new Error(`A journal row's mode must be paper or live, not ${mode}.`)
      if (typeof input.type !== "string" || input.type.length === 0) throw new Error("A journal row needs a type.")
      const row = this.redactor.value({
        ...input,
        seq: this.seq + 1,
        at: new Date(this.now()).toISOString(),
        environment: this.identity.environment,
        profile: this.identity.profile,
        mode,
      }) as JournalRow
      await this.raw(`${JSON.stringify(row)}\n`)
      this.seq = row.seq
      this.history.rows.push(row)
      return row
    })
    // A failed append must not wedge every later one behind it.
    this.chain = next.catch(() => {})
    return next
  }

  /** Every row, in order: what was on disk at open, then what this core appended. */
  rows(): readonly JournalRow[] {
    return this.history.rows
  }

  async close(): Promise<void> {
    await this.chain
    this.closed = true
    await this.handle.close()
  }

  private async raw(text: string): Promise<void> {
    await this.handle.write(text)
    await this.handle.sync()
  }
}

export class JournalIdentityError extends Error {
  readonly code = "JOURNAL_IDENTITY_MISMATCH"
  constructor(message: string) {
    super(message)
    this.name = "JournalIdentityError"
  }
}

/** Reads a journal file without opening it for writing. A missing file is an empty journal. */
export async function readJournal(path: string): Promise<JournalReadResult> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], skipped: 0, tornTail: false }
    throw error
  }
  const tornTail = text.length > 0 && !text.endsWith("\n")
  const rows: JournalRow[] = []
  let skipped = 0
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const row = parseRow(line)
    if (row === undefined) skipped++
    else rows.push(row)
  }
  return { rows, skipped, tornTail }
}

function parseRow(line: string): JournalRow | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== "object") return undefined
  const row = value as Partial<JournalRow>
  if (typeof row.seq !== "number" || typeof row.type !== "string") return undefined
  if (row.environment !== "staging" && row.environment !== "production") return undefined
  if (typeof row.profile !== "string" || (row.mode !== "paper" && row.mode !== "live")) return undefined
  return row as JournalRow
}
