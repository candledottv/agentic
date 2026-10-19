/**
 * BE-1665 (spec C-4, K-10, invariant 8): the core's append-only journal. T-12's journal half: an
 * error carrying the fake API key reaches the file only as the redaction marker.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, JournalIdentityError, readJournal } from "./journal"
import { REDACTED, Redactor } from "./redact"

const FAKE_KEY = `cndl_test_${"k".repeat(43)}`
const dirs: string[] = []

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "candle-core-journal-"))
  dirs.push(dir)
  return join(dir, "journal.jsonl")
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function openJournal(path: string, redactor = new Redactor(), profile = "staging") {
  return Journal.open({
    path,
    redactor,
    environment: "staging",
    profile,
    now: () => Date.parse("2026-10-19T12:00:00Z"),
  })
}

describe("Journal", () => {
  test("every row carries environment, profile, mode, seq and time, and lands on disk before append resolves", async () => {
    const path = await freshPath()
    const journal = await openJournal(path)
    const row = await journal.append({ type: "core.started", pid: 42 })
    expect(row).toMatchObject({
      seq: 1,
      type: "core.started",
      environment: "staging",
      profile: "staging",
      mode: "live",
      pid: 42,
    })
    expect(row.at).toBe("2026-10-19T12:00:00.000Z")
    // Read back while the journal is still open: the row is already in the file.
    const onDisk = await readJournal(path)
    expect(onDisk.rows).toEqual([row])
    await journal.close()
  })

  test("T-12: an error carrying the API key is written with the redaction marker, never the key", async () => {
    const path = await freshPath()
    const redactor = new Redactor()
    redactor.add(FAKE_KEY)
    const journal = await openJournal(path, redactor)
    await journal.append({ type: "operation.failed", error: `upstream 500: key ${FAKE_KEY} rejected`, mode: "paper" })
    await journal.close()
    const text = await readFile(path, "utf8")
    expect(text).not.toContain(FAKE_KEY)
    expect(text).toContain(REDACTED)
    expect(JSON.parse(text.trim()).mode).toBe("paper")
  })

  test("a caller cannot set the fields the journal owns, or an invalid mode", async () => {
    const journal = await openJournal(await freshPath())
    await expect(journal.append({ type: "x", environment: "production" })).rejects.toThrow(/may not set "environment"/)
    await expect(journal.append({ type: "x", profile: "other" })).rejects.toThrow(/may not set "profile"/)
    await expect(journal.append({ type: "x", seq: 9 })).rejects.toThrow(/may not set "seq"/)
    await expect(journal.append({ type: "x", mode: "sim" as never })).rejects.toThrow(/paper or live/)
    // A refused row does not wedge the ones after it.
    expect((await journal.append({ type: "ok" })).seq).toBe(1)
    await journal.close()
  })

  test("rows are rebuilt on open and seq continues", async () => {
    const path = await freshPath()
    const first = await openJournal(path)
    await first.append({ type: "a" })
    await first.append({ type: "b" })
    await first.close()
    const second = await openJournal(path)
    expect(second.rows().map((row) => row.type)).toEqual(["a", "b"])
    expect((await second.append({ type: "c" })).seq).toBe(3)
    await second.close()
  })

  test("a torn last line is kept, skipped, terminated and recorded; nothing is rewritten", async () => {
    const path = await freshPath()
    const first = await openJournal(path)
    await first.append({ type: "a" })
    await first.close()
    await appendFile(path, '{"seq":2,"type":"half')
    const before = await readFile(path, "utf8")
    const second = await openJournal(path)
    expect(second.history.tornTail).toBe(true)
    expect(second.history.skipped).toBe(1)
    const marker = second.rows().at(-1)
    expect(marker).toMatchObject({ type: "journal.torn_tail", skipped: 1, seq: 2 })
    await second.close()
    const after = await readFile(path, "utf8")
    expect(after.startsWith(before)).toBe(true)
    expect((await readJournal(path)).tornTail).toBe(false)
  })

  test("a journal written for another profile or environment is refused, not merged", async () => {
    const path = await freshPath()
    await writeFile(
      path,
      `${JSON.stringify({ seq: 1, at: "x", type: "a", environment: "production", profile: "staging", mode: "live" })}\n`,
    )
    await expect(openJournal(path)).rejects.toBeInstanceOf(JournalIdentityError)
  })

  test("the file is created mode 0600", async () => {
    const path = await freshPath()
    const journal = await openJournal(path)
    await journal.close()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
