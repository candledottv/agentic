import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendSpendLines,
  DEFAULT_DAILY_LIMIT_USD_MICROS,
  DEFAULT_MAX_PER_CALL_USD_MICROS,
  foldSpendLog,
  readLimits,
  readSpendLog,
  recordSpendState,
  reserveSpend,
  type SpendLine,
  type SpendPaths,
  spendPaths,
  spentOn,
  writeLimits,
} from "./spend-log"

let dir: string
let paths: SpendPaths
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-spend-"))
  paths = spendPaths({ CANDLE_CONFIG_DIR: dir }, "/nonexistent", "agent")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const pending = (id: string, at: string, amountRaw: string): SpendLine & { amountRaw: string } => ({
  v: 1,
  at,
  id,
  state: "pending",
  kind: "forensics",
  route: "GET /api/v1/markets/solana/m/forensics",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  amountRaw,
  payTo: "pay",
  payer: "payer",
  quoteMemo: `cndl:${"a".repeat(32)}`,
  keyless: true,
})

describe("spend log (spec 10.4)", () => {
  test("lives at <config dir>/spend/<profile>.jsonl, file 0600 in a 0700 directory", async () => {
    expect(paths.log).toBe(join(dir, "spend", "agent.jsonl"))
    expect(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x").log).toBe(join(dir, "spend", "default.jsonl"))
    await appendSpendLines(paths, [pending("a", "2026-11-02T10:15:03.120Z", "10000")])
    expect((await stat(paths.log)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.dir)).mode & 0o777).toBe(0o700)
  })

  test("appends and folds by id: the first line's facts, the last line's state", async () => {
    await appendSpendLines(paths, [pending("a", "2026-11-02T10:15:03.120Z", "10000")])
    await recordSpendState(paths, { id: "a", at: "2026-11-02T10:15:04.880Z", state: "settled", signature: "sig" })
    await appendSpendLines(paths, [pending("b", "2026-11-02T10:16:00.000Z", "50000")])
    const entries = foldSpendLog(await readSpendLog(paths))
    expect(entries.map((e) => [e.id, e.state, e.amountRaw, e.signature])).toEqual([
      ["a", "settled", 10000n, "sig"],
      ["b", "pending", 50000n, undefined],
    ])
    expect(entries[0]?.updatedAt).toBe("2026-11-02T10:15:04.880Z")
  })

  test("a malformed line or an update for an unknown id is skipped", async () => {
    const { appendFile } = await import("node:fs/promises")
    await appendSpendLines(paths, [pending("a", "2026-11-02T10:15:03.120Z", "10000")])
    await appendFile(paths.log, '{"broken\n{"v":2,"id":"a","at":"x","state":"settled"}\n')
    await recordSpendState(paths, { id: "ghost", at: "2026-11-02T10:15:04.880Z", state: "settled" })
    expect(foldSpendLog(await readSpendLog(paths)).map((e) => [e.id, e.state])).toEqual([["a", "pending"]])
  })

  test("today's total counts pending, unknown, settled and credited, never failed, and rolls over at UTC midnight", () => {
    const lines: SpendLine[] = [
      pending("p", "2026-11-02T00:00:00.000Z", "10000"),
      pending("u", "2026-11-02T01:00:00.000Z", "20000"),
      { v: 1, id: "u", at: "2026-11-02T01:00:01.000Z", state: "unknown" },
      pending("s", "2026-11-02T02:00:00.000Z", "40000"),
      { v: 1, id: "s", at: "2026-11-02T02:00:01.000Z", state: "settled" },
      pending("c", "2026-11-02T03:00:00.000Z", "80000"),
      { v: 1, id: "c", at: "2026-11-02T03:00:01.000Z", state: "credited" },
      pending("f", "2026-11-02T04:00:00.000Z", "160000"),
      { v: 1, id: "f", at: "2026-11-02T04:00:01.000Z", state: "failed" },
      pending("y", "2026-11-01T23:59:59.999Z", "320000"),
    ]
    const entries = foldSpendLog(lines)
    expect(spentOn(entries, "2026-11-02")).toBe(150000n)
    expect(spentOn(entries, "2026-11-01")).toBe(320000n)
    expect(spentOn(entries, "2026-11-03")).toBe(0n)
  })
})

describe("limits (spec 10.3, decision A9)", () => {
  test("default to $5 a day, $1 a call, not paused, and persist", async () => {
    expect(await readLimits(paths)).toEqual({
      dailyLimitUsdMicros: DEFAULT_DAILY_LIMIT_USD_MICROS,
      maxPerCallUsdMicros: DEFAULT_MAX_PER_CALL_USD_MICROS,
      paused: false,
    })
    expect([DEFAULT_DAILY_LIMIT_USD_MICROS, DEFAULT_MAX_PER_CALL_USD_MICROS]).toEqual([5_000_000n, 1_000_000n])
    await writeLimits(paths, { dailyLimitUsdMicros: 2_000_000n, maxPerCallUsdMicros: 100_000n, paused: true })
    expect(await readLimits(paths)).toEqual({
      dailyLimitUsdMicros: 2_000_000n,
      maxPerCallUsdMicros: 100_000n,
      paused: true,
    })
    expect((await stat(paths.limits)).mode & 0o777).toBe(0o600)
  })
})

describe("reserveSpend: the daily check and the pending line under one lock (10.3 rules 3 and 5)", () => {
  test("refuses past the limit, counting pending entries, and writes nothing", async () => {
    const at = "2026-11-02T10:00:00.000Z"
    expect(await reserveSpend(paths, 100_000n, pending("a", at, "60000"))).toEqual({ ok: true })
    expect(await reserveSpend(paths, 100_000n, pending("b", at, "50000"))).toEqual({ ok: false, spentToday: 60000n })
    expect(await reserveSpend(paths, 100_000n, pending("c", at, "40000"))).toEqual({ ok: true })
    expect(foldSpendLog(await readSpendLog(paths)).map((e) => e.id)).toEqual(["a", "c"])
  })

  test("two CLI processes cannot both spend the same headroom", async () => {
    const script = join(import.meta.dir, "spend-log.ts")
    const child = (id: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(script)});
           const paths = m.spendPaths({ CANDLE_CONFIG_DIR: ${JSON.stringify(dir)} }, "/nonexistent", "agent");
           const results = [];
           for (let i = 0; i < 10; i++) {
             const r = await m.reserveSpend(paths, 100000n, { v: 1, at: "2026-11-02T10:00:00.000Z", id: "${id}" + i, state: "pending", kind: "forensics", amountRaw: "10000" });
             results.push(r.ok);
           }
           console.log(results.filter(Boolean).length);`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
    const [a, b] = [child("a"), child("b")]
    const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()])
    await Promise.all([a.exited, b.exited])
    expect(Number(outA.trim()) + Number(outB.trim())).toBe(10)
    const entries = foldSpendLog(await readSpendLog(paths))
    expect(entries).toHaveLength(10)
    expect(spentOn(entries, "2026-11-02")).toBe(100_000n)
  }, 30_000)
})
