/**
 * Multi-EVM F5 (BE-2959, spec A5/A6/A9): command-level `--chain testevm` tests. With `testevm`
 * installed in the registry, each command takes it or refuses it by name; with it disabled each
 * command refuses it. No case returns Hood output for a testevm request.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { __resetChainRegistryForTest, __setChainRegistryForTest } from "../chain-registry"
import { registryWithTestevm } from "../chain-test-fixtures"
import { run } from "../index"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"

const ADDR = "0x0000000000000000000000000000000000000001"

afterEach(() => __resetChainRegistryForTest())

function setup() {
  const stdout = createCapture()
  const stderr = createCapture()
  const seen: { url: string; body: string }[] = []
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_PLAIN: "1", CANDLE_API_KEY: "fixture-key" },
    fetch: (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body ?? "") })
      return jsonResponse(200, { success: true, events: [], nextCursor: null, profileId: "prof_0123456789abcdef" })
    }) as unknown as typeof fetch,
  })
  return { deps, stdout, stderr, seen }
}

describe("testevm disabled: every command refuses it and reads nothing", () => {
  const argvs: string[][] = [
    ["portfolio", "--chain", "testevm"],
    ["token", "events", ADDR, "--chain", "testevm"],
    ["agent", "post", "create", "--text", "x", "--chain", "testevm", "--mint", ADDR],
  ]
  for (const argv of argvs) {
    test(argv.slice(0, 2).join(" "), async () => {
      __setChainRegistryForTest(registryWithTestevm("disabled"))
      const f = setup()
      expect(await run(argv, f.deps)).toBe(2)
      expect(f.seen).toEqual([])
      expect(f.stdout.text).not.toContain("hood")
    })
  }
})

describe("testevm enabled", () => {
  test("token events takes it and asks the API for testevm, never hood", async () => {
    __setChainRegistryForTest(registryWithTestevm("enabled"))
    const f = setup()
    expect(await run(["token", "events", ADDR, "--chain", "testevm"], f.deps)).toBe(0)
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]?.url).toContain(`/api/v1/tokens/testevm/${ADDR}/events`)
    expect(f.seen[0]?.url).not.toContain("/hood/")
  })

  test("agent post create sends token.chain testevm", async () => {
    __setChainRegistryForTest(registryWithTestevm("enabled"))
    const f = setup()
    expect(await run(["agent", "post", "create", "--text", "x", "--chain", "testevm", "--mint", ADDR], f.deps)).toBe(0)
    expect(JSON.parse(f.seen[0]?.body ?? "{}").token).toEqual({ chain: "testevm", mint: ADDR })
  })

  test("portfolio refuses it by name and reads nothing: never a Hood answer for a testevm request", async () => {
    __setChainRegistryForTest(registryWithTestevm("enabled"))
    const f = setup()
    expect(await run(["portfolio", "--chain", "testevm", "--json"], f.deps)).toBe(2)
    expect(f.seen).toEqual([])
    expect(f.stderr.text + f.stdout.text).toContain("portfolio cannot read testevm yet")
    expect(f.stdout.text).not.toContain('"chain":"hood"')
  })
})
