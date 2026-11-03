/** `candle launch status` (BE-2573): one state, and --wait until the token is trading. */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const PATH = "/api/v1/launch/status/cl-1"
const MINT = "Mint111111111111111111111111111111111111"

function fixture(answers: Array<() => Response>) {
  const calls: string[] = []
  let n = 0
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    const answer = answers[Math.min(n, answers.length - 1)]
    n += 1
    if (!answer) throw new Error(`Unexpected ${url.pathname}`)
    return answer()
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({ fetch: fetcher, env: { CANDLE_API_KEY: "main-key" }, stdout, stderr })
  return { deps, calls, stdout, stderr }
}

const body = (status: Record<string, unknown>) => () => Response.json({ success: true, status })

describe("candle launch status", () => {
  test("a missing id is usage and sends nothing", async () => {
    const f = fixture([])
    expect(await run(["launch", "status"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(f.stderr.text).toContain("Usage: candle launch status")
  })

  test("prints the state and the market's migration fields", async () => {
    const f = fixture([
      body({
        state: "trading",
        chain: "solana",
        mint: MINT,
        clientLaunchId: "cl-1",
        lifecycle: "trading",
        migration: { status: "not_started", progressBps: 1000 },
        signature: "sig",
      }),
    ])
    expect(await run(["launch", "status", "cl-1"], f.deps)).toBe(0)
    expect(f.calls).toEqual([PATH])
    expect(f.stdout.text).toContain("state: trading")
    expect(f.stdout.text).toContain("lifecycle: trading")
    expect(f.stdout.text).toContain("migration: not_started 1000 bps")
    expect(f.stdout.text).not.toContain("progressBps")
  })

  test("--json is the server body", async () => {
    const status = { state: "build", clientLaunchId: "cl-1", chain: "solana" }
    const f = fixture([body(status)])
    expect(await run(["launch", "status", "cl-1", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({ success: true, status })
  })

  test("--wait follows until trading and then stops", async () => {
    const f = fixture([
      body({ state: "signed", clientLaunchId: "cl-1" }),
      body({ state: "trading", clientLaunchId: "cl-1", lifecycle: "trading", migration: { status: "not_started" } }),
    ])
    expect(await run(["launch", "status", "cl-1", "--wait", "--json"], f.deps)).toBe(0)
    expect(f.calls).toEqual([PATH, PATH])
    expect(JSON.parse(f.stdout.text).waited).toEqual({ final: true })
    expect(JSON.parse(f.stdout.text).status.state).toBe("trading")
  })

  test("--wait stops on a failed launch without waiting out the ten minutes", async () => {
    const f = fixture([body({ state: "signed", failed: true, errorCode: "REVERTED", clientLaunchId: "cl-1" })])
    expect(await run(["launch", "status", "cl-1", "--wait"], f.deps)).toBe(0)
    expect(f.calls).toEqual([PATH])
    expect(f.stdout.text).toContain("failed: true")
    expect(f.stdout.text).toContain("error: REVERTED")
    expect(f.stderr.text).not.toContain("ten minutes")
  })

  test("--wait gives up after ten minutes and says how to re-check", async () => {
    const f = fixture([body({ state: "confirmed", clientLaunchId: "cl-1" })])
    expect(await run(["launch", "status", "cl-1", "--wait"], f.deps)).toBe(0)
    expect(f.calls.length).toBe(61)
    expect(f.stderr.text).toContain("Still not trading after ten minutes")
    expect(f.stderr.text).toContain("candle launch status cl-1 --wait")
    expect(f.stdout.text).toContain("state: confirmed")
  })
})
