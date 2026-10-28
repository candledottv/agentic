import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { displayWidth } from "../presentation"
import { createCapture, createFakeConfigStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

const unusedFetch = (async () => {
  throw new Error("unexpected network request")
}) as unknown as typeof fetch

describe("release C account and wallet output", () => {
  test("a wallet failure separates the repair on stderr; JSON preserves the old envelope on stdout", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      env: { CANDLE_PLAIN: "1" },
      columns: { stdout: 80, stderr: 40 },
    })
    expect(await run(["wallets"], deps)).toBe(1)
    expect(stderr.text).toBe("x No API key available.\n\n  Run:   candle keys create\n")
    expect(stdout.text).not.toContain("No API key")
    stdout.text = ""
    stderr.text = ""
    expect(await run(["wallets", "--json"], deps)).toBe(1)
    expect(stdout.text).toBe(
      `${JSON.stringify({ ok: false, code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" })}\n`,
    )
    expect(stderr.text).toBe("")
  })

  test("profile creation at 40 columns groups facts and the repair command; JSON stays one unchanged value", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const config = createFakeConfigStore({})
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      ...config,
      env: { CANDLE_PLAIN: "1" },
      columns: { stdout: 40, stderr: 80 },
    })
    expect(await run(["profile", "add", "sandbox", "--api-url", "https://staging.api.candle.tv"], deps)).toBe(0)
    expect(stdout.text).toBe(
      "ok Created profile sandbox.\n  API  https://staging.api.candle.tv\n\n  - Run:\n    candle auth login --profile sandbox\n\n",
    )
    expect(stderr.text).toBe("")
    for (const line of stdout.text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    expect(stdout.text).not.toContain("\x1b")

    stdout.text = ""
    expect(await run(["profile", "add", "other", "--api-url", "https://staging.api.candle.tv", "--json"], deps)).toBe(0)
    expect(stdout.text).toBe(`${JSON.stringify({ name: "other", apiUrl: "https://staging.api.candle.tv" })}\n`)
  })

  test("narrow wallet lists retain full copyable values and signer state; human warnings keep stdout", async () => {
    const id = "linked_wallet_for_next_command"
    const address = "11111111111111111111111111111111"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: null, evm: null } }),
      "/api/v1/agent/wallets": () =>
        jsonResponse(200, {
          success: true,
          page: [{ _id: id, address, chain: "solana", label: "desk", walletKind: "tee" }],
          isDone: true,
          continueCursor: null,
        }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      stdout,
      stderr,
      env: { CANDLE_API_KEY: "test-key", CANDLE_PLAIN: "1" },
      columns: { stdout: 40, stderr: 80 },
    })
    expect(await run(["wallets"], deps)).toBe(0)
    const screen = stdout.text.slice(stdout.text.indexOf("Linked wallets"))
    expect(screen).toContain(id)
    expect(screen).toContain(address)
    expect(screen).toContain("Signer   none")
    expect(screen).toContain("! A wallet marked none")
    expect(screen.replace(/\s+/g, " ")).toContain("candle wallets trust")
    expect(stderr.text).toBe("")
    for (const line of screen.split("\n")) {
      // Copyable identifiers stay whole, including when the kit lets one overflow its value column.
      if (!line.includes(address) && !line.includes(id)) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    }

    stdout.text = ""
    expect(await run(["wallets", "--json"], deps)).toBe(0)
    expect(stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(stdout.text).linked.page[0]).toMatchObject({ _id: id, address })
    expect(stderr.text).toBe("")
  })

  test("the profile warning wraps to stderr's width, while the selected identity stays on stdout", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const config = createFakeConfigStore({ profiles: { sandbox: { apiUrl: "https://staging.api.candle.tv" } } })
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      ...config,
      env: { CANDLE_PLAIN: "1" },
      columns: { stdout: 100, stderr: 40 },
    })
    expect(await run(["profile", "use", "sandbox"], deps)).toBe(0)
    expect(stdout.text).toContain("Profile sandbox")
    expect(stdout.text).not.toContain("No stored credentials")
    expect(stderr.text.replace(/\s+/g, " ")).toContain(
      "No stored credentials for sandbox. Run: candle auth login --profile sandbox",
    )
    for (const line of stderr.text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
  })
})

describe("release C remaining commands", () => {
  test("spend fields and unavailable-credit advice use stdout's width; JSON keeps its original schema", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      env: { CANDLE_CONFIG_DIR: "/nonexistent/candle-legibility-test", CANDLE_PLAIN: "1" },
      columns: { stdout: 40, stderr: 80 },
      now: () => Date.parse("2026-10-28T10:00:00Z"),
    })
    expect(await run(["spend"], deps)).toBe(0)
    expect(stdout.text).toContain("Per-use spend\n\n")
    expect(stdout.text).toContain("  Spent                $0\n")
    expect(stdout.text).toContain("  Daily per-use limit  $5\n")
    expect(stdout.text).toContain("  Candle credit  -\n")
    expect(stdout.text.replace(/\s+/g, " ")).toContain("Candle credit not shown: no API key on this profile")
    for (const line of stdout.text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    expect(stdout.text).not.toContain("\x1b")
    expect(stderr.text).toBe("")
    stdout.text = ""
    expect(await run(["spend", "--json"], deps)).toBe(0)
    expect(stdout.text).toBe(
      `${JSON.stringify({
        ok: true,
        limits: { dailyLimitUsd: "5", maxPerCallUsd: "1", paused: false },
        today: { day: "2026-10-28", spentUsd: "0", limitUsd: "5" },
        credit: { unavailable: "no API key on this profile" },
        payments: [],
      })}\n`,
    )
    expect(stderr.text).toBe("")
  })
})
