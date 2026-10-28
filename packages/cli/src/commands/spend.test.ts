import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { appendSpendLines, readLimits, spendPaths } from "../x402/spend-log"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-spend-cmd-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const NOW = Date.parse("2026-11-02T12:00:00.000Z")

function setup(env: Record<string, string> = {}, routes: Parameters<typeof createRoutedFetch>[0] = {}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch(routes)
  const deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: "https://api.test", ...env },
    now: () => NOW,
  })
  return { deps, stdout, stderr, routed }
}

describe("candle spend limits (spec 10.1, 10.3)", () => {
  test("limit and max-per-call show the defaults, then set and persist", async () => {
    const f = setup()
    expect(await run(["spend", "limit"], f.deps)).toBe(0)
    expect(f.stdout.text).toBe("  Daily per-use limit  $5\n")
    f.stdout.text = ""
    expect(await run(["spend", "max-per-call", "$0.25"], f.deps)).toBe(0)
    expect(await run(["spend", "limit", "2", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")).toEqual({
      ok: true,
      limits: { dailyLimitUsd: "2", maxPerCallUsd: "0.25", paused: false },
    })
    expect(await readLimits(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"))).toEqual({
      dailyLimitUsdMicros: 2_000_000n,
      maxPerCallUsdMicros: 250_000n,
      paused: false,
    })
  })

  test("a malformed amount is a usage error and changes nothing", async () => {
    const f = setup()
    for (const bad of ["-1", "abc", "1.0000001", "1e3"]) expect(await run(["spend", "limit", bad], f.deps)).toBe(2)
    expect((await readLimits(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"))).dailyLimitUsdMicros).toBe(5_000_000n)
  })

  test("pause and resume, with no login and no request", async () => {
    const f = setup()
    expect(await run(["spend", "pause"], f.deps)).toBe(0)
    expect((await readLimits(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"))).paused).toBe(true)
    expect(await run(["spend", "resume"], f.deps)).toBe(0)
    expect((await readLimits(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"))).paused).toBe(false)
    expect(f.routed.calls).toHaveLength(0)
  })
})

describe("candle spend (the log, spec 10.4)", () => {
  test("shows today's total against the limit, the payments, and the server's credit with a key", async () => {
    await appendSpendLines(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"), [
      { v: 1, id: "a", at: "2026-11-02T10:00:00.000Z", state: "pending", kind: "forensics", amountRaw: "10000" },
      { v: 1, id: "a", at: "2026-11-02T10:00:01.000Z", state: "settled", signature: "sig-a" },
      { v: 1, id: "b", at: "2026-11-01T10:00:00.000Z", state: "pending", kind: "vamp", amountRaw: "50000" },
      { v: 1, id: "b", at: "2026-11-01T10:00:01.000Z", state: "failed", reason: "quote_expired" },
    ])
    const f = setup(
      { CANDLE_API_KEY: "cndl_live_k" },
      {
        "/api/v1/agent/x402/credits": () =>
          jsonResponse(200, {
            success: true,
            holder: { kind: "account", id: "u" },
            balanceUsdMicros: "30000",
            entries: [],
          }),
      },
    )
    expect(await run(["spend", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({
      ok: true,
      limits: { dailyLimitUsd: "5", maxPerCallUsd: "1", paused: false },
      today: { day: "2026-11-02", spentUsd: "0.01", limitUsd: "5" },
      credit: { balanceUsd: "0.03" },
      payments: [
        {
          id: "a",
          at: "2026-11-02T10:00:00.000Z",
          kind: "forensics",
          route: "",
          network: "",
          amountUsdc: "0.01",
          state: "settled",
          payer: "",
          payTo: "",
          signature: "sig-a",
        },
        {
          id: "b",
          at: "2026-11-01T10:00:00.000Z",
          kind: "vamp",
          route: "",
          network: "",
          amountUsdc: "0.05",
          state: "failed",
          payer: "",
          payTo: "",
          reason: "quote_expired",
        },
      ],
    })
    f.stdout.text = ""
    expect(await run(["spend"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Today (UTC) 2026-11-02 Spent $0.01 Daily per-use limit $5"))
    expect(humanText(f.stdout.text)).toContain(humanText("Candle credit 0.03 USDC"))
    expect(f.stdout.text).toContain("sig-a")
  })

  test("without a key no request is made and the credit is not shown; x402 off reads as off", async () => {
    let f = setup()
    expect(await run(["spend"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Candle credit not shown: no API key on this profile"))
    expect(humanText(f.stdout.text)).toContain(humanText("No x402 payments in the last 7 days."))
    expect(f.routed.calls).toHaveLength(0)
    f = setup({ CANDLE_API_KEY: "k" }, { "/api/v1/agent/x402/credits": () => jsonResponse(404, {}) })
    expect(await run(["spend", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).credit).toEqual({ unavailable: "x402 is off on this API" })
  })

  test("a stale unknown is resolved against the server's payments before it is shown", async () => {
    await appendSpendLines(spendPaths({ CANDLE_CONFIG_DIR: dir }, "/x"), [
      { v: 1, id: "u", at: "2026-11-02T11:00:00.000Z", state: "pending", kind: "vamp", amountRaw: "50000", payer: "P" },
      { v: 1, id: "u", at: "2026-11-02T11:00:01.000Z", state: "unknown" },
    ])
    const f = setup(
      { CANDLE_API_KEY: "k" },
      {
        "/api/v1/agent/x402/payments": () =>
          jsonResponse(200, {
            success: true,
            payments: [
              {
                id: "s",
                kind: "vamp",
                status: "fulfilled",
                reason: null,
                payer: "P",
                amountUsdMicros: "50000",
                signature: "sig-u",
                createdAt: "2026-11-02T11:00:10.000Z",
              },
            ],
          }),
        "/api/v1/agent/x402/credits": () => jsonResponse(200, { success: true, balanceUsdMicros: "0" }),
      },
    )
    expect(await run(["spend", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).payments[0]).toMatchObject({ id: "u", state: "settled", signature: "sig-u" })
  })

  test("--days must be a positive whole number", async () => {
    const f = setup()
    expect(await run(["spend", "--days", "0"], f.deps)).toBe(2)
    expect(await run(["spend", "--days", "x"], f.deps)).toBe(2)
  })
})
