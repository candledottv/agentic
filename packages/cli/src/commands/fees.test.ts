/** `candle fees` and `candle fees claim` (FE-438), driven through `run()` against a stub server. */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const SOL = { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9, amountRaw: "1500000000" }

function fixture(answers: Record<string, () => Response>) {
  const calls: { path: string; method: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const answer = answers[url.pathname]
    if (!answer) throw new Error(`Unexpected ${url.pathname}`)
    return answer()
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({ fetch: fetcher, env: { CANDLE_API_KEY: "main-key" }, stdout, stderr })
  return { deps, calls, stdout, stderr }
}

describe("candle fees (FE-438)", () => {
  test("lists tokens with their amounts and reasons, and the next page's cursor", async () => {
    const f = fixture({
      "/api/v1/agent/fees": () =>
        Response.json({
          success: true,
          page: [
            {
              mint: "MintA",
              chain: "solana",
              symbol: "AAA",
              recipient: "W1",
              claimableAmounts: [SOL],
              claimable: true,
            },
            {
              mint: "MintB",
              chain: "hood",
              symbol: "BBB",
              recipient: "W2",
              claimableAmounts: [],
              claimable: false,
              reason: "below_dust",
            },
          ],
          isDone: false,
          continueCursor: "next1",
        }),
    })
    expect(await run(["fees", "--limit", "2"], f.deps)).toBe(0)
    expect(f.calls[0]).toMatchObject({ path: "/api/v1/agent/fees?limit=2", method: "GET" })
    expect(f.stdout.text).toContain("claimable: 1.5 SOL")
    expect(f.stdout.text).toContain("not claimable: under the dust floor")
    expect(f.stdout.text).toContain("More: candle fees --cursor next1")
  })

  test("--json prints the server's answer as sent", async () => {
    const body = { success: true, page: [], isDone: true, continueCursor: null }
    const f = fixture({ "/api/v1/agent/fees": () => Response.json(body) })
    expect(await run(["fees", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual(body)
  })

  test("a limit outside 1 to 50 is a usage error and sends nothing", async () => {
    const f = fixture({})
    expect(await run(["fees", "--limit", "51"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})

describe("candle fees claim (FE-438)", () => {
  const PATH = "/api/v1/agent/fees/MintA/claim"

  test("--dry-run posts dryRun true and says nothing was sent", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({
          success: true,
          mint: "MintA",
          chain: "solana",
          dryRun: true,
          recipient: "W1",
          claimable: true,
          claimed: [{ ...SOL, txHash: null }],
          remaining: [],
        }),
    })
    expect(await run(["fees", "claim", "MintA", "--dry-run"], f.deps)).toBe(0)
    expect(f.calls[0]).toEqual({ path: PATH, method: "POST", body: { dryRun: true } })
    expect(f.stdout.text).toContain("Dry run")
    expect(f.stdout.text).toContain("1.5 SOL")
    expect(f.stdout.text).toContain("W1")
    expect(f.stdout.text).toContain("Nothing was sent.")
  })

  test("a real claim posts dryRun false and prints the transaction and what remains", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({
          success: true,
          mint: "MintA",
          chain: "solana",
          dryRun: false,
          recipient: "W1",
          claimed: [{ ...SOL, txHash: "Sig1" }],
          remaining: [{ ...SOL, amountRaw: "1" }],
          warnings: ["a leg failed"],
        }),
    })
    expect(await run(["fees", "claim", "MintA"], f.deps)).toBe(0)
    expect(f.calls[0]?.body).toEqual({ dryRun: false })
    expect(f.stdout.text).toContain("Claimed")
    expect(f.stdout.text).toContain("1.5 SOL")
    expect(f.stdout.text).toContain("W1")
    expect(f.stdout.text).toContain("Sig1")
    expect(f.stdout.text).toContain("0.000000001 SOL")
    expect(f.stderr.text).toContain("a leg failed")
  })

  test("a LAUNCH_DISABLED 503 answer exits 1", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({ success: false, error: { code: "LAUNCH_DISABLED", message: "off" } }, { status: 503 }),
    })
    expect(await run(["fees", "claim", "MintA", "--json"], f.deps)).toBe(1)
    expect(f.stderr.text + f.stdout.text).toContain("LAUNCH_DISABLED")
  })

  test("no mint, or a destination argument, is a usage error and sends nothing", async () => {
    const f = fixture({})
    expect(await run(["fees", "claim"], f.deps)).toBe(2)
    expect(await run(["fees", "claim", "MintA", "--to", "Elsewhere"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})
