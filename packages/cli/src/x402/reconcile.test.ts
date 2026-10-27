import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readServerPayments, reconcileUnknown, type ServerPayment } from "./reconcile"
import { appendSpendLines, foldSpendLog, readSpendLog, type SpendPaths, spendPaths } from "./spend-log"

let dir: string
let paths: SpendPaths
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-reconcile-"))
  paths = spendPaths({ CANDLE_CONFIG_DIR: dir }, "/nonexistent")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const started = "2026-11-02T10:00:00.000Z"
const unknown = async (id: string, at = started) =>
  appendSpendLines(paths, [
    { v: 1, id, at, state: "pending", kind: "vamp", amountRaw: "50000", payer: "P" },
    { v: 1, id, at, state: "unknown", reason: "PAYMENT_PENDING" },
  ])
const row = (over: Partial<ServerPayment> = {}): ServerPayment => ({
  id: "srv1",
  kind: "vamp",
  status: "fulfilled",
  reason: null,
  payer: "P",
  amountUsdMicros: "50000",
  signature: "sig1",
  createdAt: "2026-11-02T10:00:20.000Z",
  ...over,
})

describe("reconciling unknown payments (spec 10.4)", () => {
  test("an unknown older than 15 minutes takes the matching server row's state", async () => {
    await unknown("a")
    let reads = 0
    const n = await reconcileUnknown(paths, Date.parse(started) + 16 * 60_000, async () => {
      reads++
      return [row({ payer: "other" }), row()]
    })
    expect([n, reads]).toEqual([1, 1])
    expect(foldSpendLog(await readSpendLog(paths)).map((e) => [e.state, e.signature, e.reason])).toEqual([
      ["settled", "sig1", "server:fulfilled"],
    ])
  })

  test("a younger unknown is left alone and costs no request", async () => {
    await unknown("a")
    let reads = 0
    expect(
      await reconcileUnknown(paths, Date.parse(started) + 5 * 60_000, async () => {
        reads++
        return []
      }),
    ).toBe(0)
    expect(reads).toBe(0)
  })

  test("no match, an unreadable list, or a server still unsure leaves it unknown", async () => {
    await unknown("a")
    const later = Date.parse(started) + 20 * 60_000
    expect(await reconcileUnknown(paths, later, async () => null)).toBe(0)
    expect(await reconcileUnknown(paths, later, async () => [row({ createdAt: "2026-11-02T10:05:00.000Z" })])).toBe(0)
    expect(await reconcileUnknown(paths, later, async () => [row({ status: "settle_unknown" })])).toBe(0)
    expect(foldSpendLog(await readSpendLog(paths))[0]?.state).toBe("unknown")
    expect(await reconcileUnknown(paths, later, async () => [row({ status: "settle_failed", signature: null })])).toBe(
      1,
    )
    expect(foldSpendLog(await readSpendLog(paths))[0]?.state).toBe("failed")
  })

  test("one server row resolves one entry", async () => {
    await unknown("a")
    await unknown("b", "2026-11-02T10:00:30.000Z")
    await reconcileUnknown(paths, Date.parse(started) + 20 * 60_000, async () => [row({ status: "credited" })])
    expect(foldSpendLog(await readSpendLog(paths)).map((e) => [e.id, e.state])).toEqual([
      ["a", "credited"],
      ["b", "unknown"],
    ])
  })

  test("readServerPayments keeps only rows of the documented shape", () => {
    expect(readServerPayments({ payments: [row(), { id: 1 }] })).toEqual([row()])
    expect(readServerPayments({})).toBeNull()
  })
})
