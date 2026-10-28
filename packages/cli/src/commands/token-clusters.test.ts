import { describe, expect, test } from "bun:test"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"
import { CLUSTER_CAVEAT, CLUSTER_LABEL, CLUSTER_REASONS, clusterUnavailable } from "../token-clusters"

const mint = "11111111111111111111111111111111"
function setup(body: unknown, status = 200) {
  const stdout = createCapture()
  const stderr = createCapture()
  let calls = 0
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: "must-not-send" },
    fetch: (async (_url: unknown, init?: RequestInit) => {
      calls++
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false)
      return jsonResponse(status, body)
    }) as unknown as typeof fetch,
  })
  return { deps, stdout, stderr, calls: () => calls }
}
describe("candle token clusters", () => {
  test("every unavailable reason exits zero with the same JSON union and no numeric fields", async () => {
    for (const reason of CLUSTER_REASONS) {
      const result = clusterUnavailable(mint, reason)
      const f = setup({ success: true, data: { ...result, analysis: { secret: "must-drop" }, private: "must-drop" } })
      expect(await run(["token", "clusters", mint, "--json"], f.deps)).toBe(0)
      expect(JSON.parse(f.stdout.text)).toEqual(result)
      expect(f.stderr.text).toBe("")
    }
  })
  test("human unavailable reason is normal stdout; invalid mint and Hood remain normal", async () => {
    const f = setup({ success: true, data: clusterUnavailable(mint, "unsupported_chain") })
    expect(await run(["token", "clusters", mint, "--chain", "hood"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Reason unsupported_chain"))
    expect(f.stderr.text).toBe("")
    const invalid = setup({ success: true, data: clusterUnavailable("bad!", "invalid_mint") })
    expect(await run(["token", "clusters", "bad!", "--json"], invalid.deps)).toBe(0)
  })
  test("connection, HTTP, malformed union and unexpected thrown transport become normal unavailable", async () => {
    for (const [body, status] of [
      [{}, 200],
      [{ success: true, data: { status: "unavailable", reason: "private" } }, 200],
      [{ error: "private" }, 503],
    ] as const) {
      const f = setup(body, status)
      expect(await run(["token", "clusters", mint, "--json"], f.deps)).toBe(0)
      expect(JSON.parse(f.stdout.text).reason).toBe("transport_error")
      expect(f.stderr.text).toBe("")
    }
    const f = setup({})
    f.deps.fetch = (async () => {
      throw Error("private secret")
    }) as unknown as typeof fetch
    expect(await run(["token", "clusters", mint], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Reason transport_error"))
    expect(f.stdout.text).not.toContain("secret")
  })
  test("real analysis human and JSON include times and caveat; terminal controls are sanitized", async () => {
    const data = {
      status: "available",
      chain: "solana",
      mint,
      source: "third_party",
      label: CLUSTER_LABEL,
      caveat: CLUSTER_CAVEAT,
      fetchedAt: "2026-10-26T00:00:00Z",
      expiresAt: "2026-10-26T01:00:00Z",
      cache: "miss",
      analysis: { clusterSupplyPct: 12, clusters: [{ supplyPct: 12, addresses: [mint], tags: ["wallet\u001b[31m"] }] },
    }
    const human = setup({ success: true, data })
    expect(await run(["token", "clusters", mint], human.deps)).toBe(0)
    expect(human.stdout.text).toContain(CLUSTER_LABEL)
    expect(human.stdout.text).toContain("12%")
    expect(humanText(human.stdout.text)).toContain(humanText(CLUSTER_CAVEAT))
    expect(human.stdout.text).not.toContain("\u001b")
    const json = setup({ success: true, data })
    expect(await run(["token", "clusters", mint, "--json"], json.deps)).toBe(0)
    expect(JSON.parse(json.stdout.text).analysis.clusterSupplyPct).toBe(12)
  })
  test("syntax validation stays ordinary and sends no request", async () => {
    for (const args of [
      ["token", "clusters"],
      ["token", "clusters", mint, "--surprise"],
      ["token", "clusters", mint, "--chain", "other"],
    ]) {
      const f = setup({})
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls()).toBe(0)
    }
  })
})
