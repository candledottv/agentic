/**
 * `candle wallets allowlist` (BE-2672 / R26): the withdrawal allowlist read, printed. Driven
 * through `run()` against a stub server, the same shape as command-legibility.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { displayWidth } from "../presentation"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

const COLD = "0x1234567890123456789012345678901234567890"
const HOT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"

function allowlistFetch(rows: Record<string, unknown>[], seen: string[] = []) {
  const { fetch } = createRoutedFetch({
    "/api/v1/agent/withdrawal-addresses": (request) => {
      seen.push(String(request.url))
      return jsonResponse(200, { success: true, addresses: rows })
    },
  })
  return fetch
}

const unusedFetch = (async () => {
  throw new Error("unexpected network request")
}) as unknown as typeof fetch

function depsFor(fetchImpl: typeof fetch, columns = 120, plain = true) {
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetchImpl,
    stdout,
    stderr,
    env: { CANDLE_API_KEY: "test-key", ...(plain ? { CANDLE_PLAIN: "1" } : {}) },
    columns: { stdout: columns, stderr: columns },
  })
  return { deps, stdout, stderr }
}

const ROWS = [
  { id: "wa-cold", chain: "hood", address: COLD, label: "cold", createdAt: 1_700_000_000 },
  { id: "wa-hot", chain: "solana", address: HOT },
]

describe("candle wallets allowlist (BE-2672)", () => {
  test("lists the rows with id, chain, address and label, and says where the list is managed", async () => {
    const { deps, stdout, stderr } = depsFor(allowlistFetch(ROWS))
    expect(await run(["wallets", "allowlist"], deps)).toBe(0)
    expect(stdout.text).toContain("Withdrawal allowlist (2)")
    expect(stdout.text).toContain("wa-cold")
    expect(stdout.text).toContain(COLD)
    expect(stdout.text).toContain("cold")
    expect(stdout.text).toContain("hood")
    expect(stdout.text).toContain(HOT)
    expect(stdout.text).toContain("agent console's Wallets tab")
    expect(stderr.text).toBe("")
  })

  test("--json echoes the server's rows with a count, one line", async () => {
    const seen: string[] = []
    const { deps, stdout } = depsFor(allowlistFetch(ROWS, seen))
    expect(await run(["wallets", "allowlist", "--json"], deps)).toBe(0)
    const lines = stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({ success: true, addresses: ROWS, count: 2 })
  })

  test("--all asks the server for revoked rows too", async () => {
    const seen: string[] = []
    const { deps } = depsFor(
      allowlistFetch([...ROWS, { id: "wa-old", chain: "hood", address: COLD, revokedAt: 1 }], seen),
    )
    expect(await run(["wallets", "allowlist", "--all", "--json"], deps)).toBe(0)
    expect(seen[0]).toContain("includeRevoked=true")
  })

  test("an empty allowlist says so and names what an agent can still reach", async () => {
    const { deps, stdout } = depsFor(allowlistFetch([]))
    expect(await run(["wallets", "allowlist"], deps)).toBe(0)
    expect(stdout.text).toContain("Withdrawal allowlist (0)")
    expect(stdout.text).toContain("No approved withdrawal addresses")
    const hint = stdout.text.replace(/\s+/g, " ")
    expect(hint).toContain("an API key cannot approve")
    expect(hint).toContain("An acting key can revoke one; a read-only key cannot.")
    expect(hint).not.toContain("cannot change")
  })

  test("a revoked row shows Revoked yes in the table", async () => {
    const { deps, stdout } = depsFor(
      allowlistFetch([{ id: "wa-old", chain: "hood", address: COLD, label: "old", revokedAt: 1 }]),
    )
    expect(await run(["wallets", "allowlist"], deps)).toBe(0)
    expect(stdout.text.replace(/\s+/g, " ")).toMatch(/old\s+yes/)
  })

  test("at 40 columns it keeps full addresses whole, one block per row", async () => {
    const { deps, stdout } = depsFor(allowlistFetch(ROWS), 40)
    expect(await run(["wallets", "allowlist"], deps)).toBe(0)
    const screen = stdout.text.slice(stdout.text.indexOf("Withdrawal allowlist"))
    expect(screen).toContain(COLD)
    expect(screen).toContain(HOT)
    for (const line of screen.split("\n")) {
      if (!line.includes(COLD) && !line.includes(HOT)) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  test("without an API key it fails with the repair, and sends nothing", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      env: { CANDLE_PLAIN: "1" },
      columns: { stdout: 80, stderr: 80 },
    })
    expect(await run(["wallets", "allowlist"], deps)).toBe(1)
    expect(stderr.text).toContain("No API key available")
    expect(stdout.text).not.toContain("No API key")
    stdout.text = ""
    expect(await run(["wallets", "allowlist", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text)).toMatchObject({ code: "NO_API_KEY" })
  })

  test("an unexpected positional is a usage failure", async () => {
    const { deps, stdout } = depsFor(allowlistFetch(ROWS))
    expect(await run(["wallets", "allowlist", "extra"], deps)).toBe(2)
    expect(stdout.text).toBe("")
  })

  test("a body without a list is an INVALID_RESPONSE failure, not a crash", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/withdrawal-addresses": () => jsonResponse(200, { success: true }),
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["wallets", "allowlist"], deps)).toBe(1)
    expect(stdout.text).not.toContain("Withdrawal allowlist")
    stdout.text = ""
    expect(await run(["wallets", "allowlist", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text)).toMatchObject({ code: "INVALID_RESPONSE" })
  })
})
