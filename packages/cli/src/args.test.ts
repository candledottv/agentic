/**
 * `parseArgs` / `parseScopesList`: the shared flag parser every command routes through (fix
 * round 1, item 3), and the shared `--scopes` value parser (item 11).
 */

import { describe, expect, test } from "bun:test"
import { parseArgs, parseExpiresInDays, parseScopesList, parseUsdToMicros } from "./args"

describe("parseArgs", () => {
  test("parses a recognized value flag", () => {
    const result = parseArgs(["--scopes", "launch:write"], { valueFlags: ["--scopes"] })
    if ("error" in result) throw new Error("expected success")
    expect(result.values["--scopes"]).toBe("launch:write")
    expect(result.positionals).toEqual([])
  })

  test("parses a recognized boolean flag", () => {
    const result = parseArgs(["--keep-key"], { booleanFlags: ["--keep-key"] })
    if ("error" in result) throw new Error("expected success")
    expect(result.booleans.has("--keep-key")).toBe(true)
  })

  test("collects positional arguments", () => {
    const result = parseArgs(["ck_liveab"], {})
    if ("error" in result) throw new Error("expected success")
    expect(result.positionals).toEqual(["ck_liveab"])
  })

  test("an unrecognized flag is a usage error naming the flag, not a silently ignored no-op", () => {
    const result = parseArgs(["--keep-keys"], { booleanFlags: ["--keep-key"] })
    expect(result).toEqual({ error: "Unknown flag: --keep-keys" })
  })

  test("a value flag with nothing after it is a usage error", () => {
    const result = parseArgs(["--scopes"], { valueFlags: ["--scopes"] })
    expect(result).toEqual({ error: "--scopes requires a value" })
  })

  test("a value flag followed by another flag (no value supplied) is a usage error, not a value of '--other'", () => {
    const result = parseArgs(["--scopes", "--no-browser"], { valueFlags: ["--scopes"], booleanFlags: ["--no-browser"] })
    expect(result).toEqual({ error: "--scopes requires a value" })
  })

  test("recognizing a flag as unknown does not depend on flag ORDER relative to positionals", () => {
    const result = parseArgs(["ck_liveab", "--bogus"], {})
    expect(result).toEqual({ error: "Unknown flag: --bogus" })
  })

  test("an empty args array with an empty spec parses to no flags and no positionals", () => {
    const result = parseArgs([], {})
    if ("error" in result) throw new Error("expected success")
    expect(result.values).toEqual({})
    expect(result.booleans.size).toBe(0)
    expect(result.positionals).toEqual([])
  })
})

describe("parseScopesList", () => {
  test("splits, trims, and drops empty entries", () => {
    expect(parseScopesList("launch:write, launch:read ,,swap:write")).toEqual([
      "launch:write",
      "launch:read",
      "swap:write",
    ])
  })
})

describe("parseUsdToMicros", () => {
  test("accepts plain, $-prefixed, and comma-grouped amounts", () => {
    expect(parseUsdToMicros("100")).toEqual({ ok: true, usdMicros: 100_000_000 })
    expect(parseUsdToMicros("$1,500.50")).toEqual({ ok: true, usdMicros: 1_500_500_000 })
    expect(parseUsdToMicros("0.5")).toEqual({ ok: true, usdMicros: 500_000 })
  })
  test("rejects blank, non-numeric, zero, and negative amounts", () => {
    for (const raw of ["", "  ", "a-lot", "0", "-5"]) {
      expect(parseUsdToMicros(raw).ok).toBe(false)
    }
  })
})

describe("parseExpiresInDays", () => {
  test("accepts positive whole days only", () => {
    expect(parseExpiresInDays("30")).toEqual({ ok: true, days: 30 })
    for (const raw of ["0", "-1", "1.5", "soon"]) {
      expect(parseExpiresInDays(raw).ok).toBe(false)
    }
  })
})
