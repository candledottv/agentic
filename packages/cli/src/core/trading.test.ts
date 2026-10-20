/**
 * BE-1665 (spec K-6, K-11, S-9): trading on and off, the timed window, and what survives a restart.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEVICE_TOKEN, WRITE_KEY } from "./test-fixtures"
import { FactorRejectedError, MAX_WINDOW_MS, parseFactor, TradingState } from "./trading"

const RIGHT = { type: "passphrase" as const, value: "the-right-passphrase-example" }
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(slot = { exists: false }) {
  const dir = await mkdtemp(join(tmpdir(), "candle-trading-"))
  dirs.push(dir)
  let now = 1_000_000
  const log: string[] = []
  const deps = {
    settingsPath: join(dir, "settings.json"),
    now: () => now,
    slotExists: async () => slot.exists,
    unlockVault: async (factor: { type: string; value?: string }) => {
      if (factor.value !== RIGHT.value) throw new FactorRejectedError()
      log.push("unlock")
      return { dek: new Uint8Array(32), file: { vaultId: "v" }, close: () => log.push("close") }
    },
    openSlot: async () => {
      log.push("open")
      return { writeKey: WRITE_KEY, deviceToken: DEVICE_TOKEN }
    },
    moveToSlot: async (_vault: unknown, readKey: string) => {
      log.push(`move:${readKey}`)
      slot.exists = true
    },
    mintReadKey: async () => {
      log.push("mint")
      return "cndl_test_read_example"
    },
    remember: () => log.push("remember"),
  }
  const state = await TradingState.open(deps)
  return { dir, deps, state, log, slot, advance: (ms: number) => (now += ms) }
}

describe("TradingState", () => {
  test("turning trading on the first time mints the Read key and moves the credentials, then proves the slot opens", async () => {
    const s = await setup()
    await s.state.turnOn(RIGHT)
    expect(s.log).toEqual(["unlock", "mint", "move:cndl_test_read_example", "open", "remember", "close"])
    expect(s.state.tradingOn()).toBe(true)
    expect(JSON.parse(await readFile(s.deps.settingsPath, "utf8"))).toEqual({ tradingOn: true })
  })

  test("turning on needs the factor; a wrong one moves nothing", async () => {
    const s = await setup()
    await expect(s.state.turnOn(undefined)).rejects.toMatchObject({ code: "FACTOR_REQUIRED" })
    await expect(s.state.turnOn({ type: "passphrase", value: "nope-example" })).rejects.toMatchObject({
      code: "FACTOR_REJECTED",
    })
    // S4 F-2: a factor this machine cannot use is unavailable, never a rejection, and counts nothing.
    await expect(s.state.turnOn({ type: "touch-id" })).rejects.toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(s.log).toEqual([])
    expect(s.state.tradingOn()).toBe(false)
  })

  test("trading on survives a restart only while the slot exists; a window never does (T-18)", async () => {
    const s = await setup()
    await s.state.turnOn(RIGHT)
    await s.state.openWindow("c_view", 10, RIGHT)
    expect(s.state.snapshot().timedWindow.open).toBe(true)
    const restarted = await TradingState.open(s.deps)
    expect(restarted.tradingOn()).toBe(true)
    expect(restarted.snapshot().timedWindow).toEqual({ open: false })
    s.slot.exists = false
    expect((await TradingState.open(s.deps)).tradingOn()).toBe(false)
  })

  test("D1 B: a window is capped at 15 minutes, needs trading on and a factor, and closes when its view leaves", async () => {
    const s = await setup()
    await expect(s.state.openWindow("c_view", 5, RIGHT)).rejects.toMatchObject({ code: "TRADING_OFF" })
    await s.state.turnOn(RIGHT)
    await expect(s.state.openWindow("c_view", 5, undefined)).rejects.toMatchObject({ code: "FACTOR_REQUIRED" })
    await s.state.openWindow("c_view", 60, RIGHT)
    const window = s.state.snapshot().timedWindow
    expect(window.open && Date.parse(window.closesAt) - 1_000_000).toBe(MAX_WINDOW_MS)
    s.state.viewsAttached(new Set(["c_other"]))
    expect(s.state.snapshot().timedWindow).toEqual({ open: false })
  })

  test("a window lapses at its cap", async () => {
    const s = await setup()
    await s.state.turnOn(RIGHT)
    await s.state.openWindow("c_view", 1, RIGHT)
    s.advance(60_001)
    expect(s.state.snapshot().timedWindow).toEqual({ open: false })
  })

  test("turning off closes the window", async () => {
    const s = await setup()
    await s.state.turnOn(RIGHT)
    await s.state.openWindow("c_view", 5, RIGHT)
    await s.state.turnOff()
    expect(s.state.snapshot()).toMatchObject({ tradingOn: false, timedWindow: { open: false } })
  })

  test("A-5: the paper window has the K-6 rules, holds the key for paper only, and never survives a restart", async () => {
    const s = await setup()
    await expect(s.state.withPaperCredentials(async () => 1)).rejects.toMatchObject({ code: "TRADING_OFF" })
    await s.state.turnOn(RIGHT)
    await expect(s.state.withPaperCredentials(async () => 1)).rejects.toMatchObject({ code: "PAPER_WINDOW_REQUIRED" })
    await expect(s.state.openPaperWindow("c_view", 5, undefined)).rejects.toMatchObject({ code: "FACTOR_REQUIRED" })
    await s.state.openPaperWindow("c_view", 60, RIGHT)
    const paper = s.state.snapshot().paperWindow
    expect(paper.open && Date.parse(paper.closesAt) - 1_000_000).toBe(MAX_WINDOW_MS)
    expect(await s.state.withPaperCredentials(async (c) => c.writeKey)).toBe(WRITE_KEY)
    // A paper window approves no live card.
    await expect(
      s.state.withCredentials({ kind: "trade", viewClientId: "c_view", factor: undefined }, async () => 1),
    ).rejects.toMatchObject({
      code: "FACTOR_REQUIRED",
    })
    expect((await TradingState.open(s.deps)).snapshot().paperWindow).toEqual({ open: false })
    s.state.viewsAttached(new Set())
    expect(s.state.snapshot().paperWindow).toEqual({ open: false })
  })

  test("parseFactor keeps only the known shapes", () => {
    expect(parseFactor(undefined)).toBeUndefined()
    expect(parseFactor({ type: "passphrase", value: "x" })).toEqual({ type: "passphrase", value: "x" })
    expect(parseFactor({ type: "touch-id", value: "ignored" })).toEqual({ type: "touch-id" })
    expect(parseFactor({ type: "security-key", pin: "1234" })).toEqual({ type: "security-key", pin: "1234" })
    expect(parseFactor({ type: "security-key" })).toEqual({ type: "security-key" })
    expect(() => parseFactor({ type: "stored-yes" })).toThrow()
    expect(() => parseFactor("passphrase")).toThrow()
  })
})
