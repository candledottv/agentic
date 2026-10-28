import { describe, expect, test } from "bun:test"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"

const mint = "11111111111111111111111111111111"
const wallet = {
  address: "Wallet1111111111111111111111111111111111",
  name: null,
  walletKind: "smart" as const,
  groups: [{ name: "winner", visibility: "public" as const }],
  image: null,
  isDev: false,
}

const page = {
  success: true,
  nextCursor: "eyJhdCI6IjIwMjYtMTAtMjgifQ",
  events: [
    {
      id: "trade:1",
      chain: "solana",
      mint,
      at: 1761652900000,
      kind: "trade",
      side: "sell",
      usd: 3000,
      tokenAmount: 62.5,
      priceUsd: 48,
      marketCapUsd: null,
      tx: "tx-1",
      result: "W",
      wallet,
    },
    {
      id: "signal:1",
      chain: "solana",
      mint,
      at: 1761652800000,
      kind: "signal",
      pattern: "dormant_buy",
      summary: "A wallet that had been quiet bought.",
      tx: null,
      wallet: null,
    },
    {
      id: "callout:1",
      chain: "solana",
      mint,
      at: 1761652700000,
      kind: "callout",
      caller: { handle: "@hitman", name: null, rank: 3 },
      size: 1200,
      marketCapUsd: 48000,
      tx: "tx-3",
      status: "open",
      wallet: null,
    },
  ],
}

function setup(body: unknown, status = 200, env: Record<string, string> = { CANDLE_PLAIN: "1" }) {
  const stdout = createCapture()
  const stderr = createCapture()
  const seen: string[] = []
  const deps = createTestDeps({
    stdout,
    stderr,
    env,
    fetch: (async (url: unknown, init?: RequestInit) => {
      seen.push(String(url))
      void init
      return jsonResponse(status, body)
    }) as unknown as typeof fetch,
  })
  return { deps, stdout, stderr, seen }
}

describe("candle token events", () => {
  test("free-tier address display and JSON preserve the shortened address, label and kind", async () => {
    for (const name of [null, "Ada"]) {
      const event = { ...page.events[0], wallet: { ...wallet, address: "Wall…1111", name } }
      const body = { ...page, events: [event] }
      const human = setup(body)
      expect(await run(["token", "events", mint], human.deps)).toBe(0)
      expect(humanText(human.stdout.text)).toContain(`${name ?? "Wall…1111"} (smart)`)
      const json = setup(body)
      expect(await run(["--json", "token", "events", mint], json.deps)).toBe(0)
      expect(JSON.parse(json.stdout.text).data.events[0].wallet).toEqual(event.wallet)
      expect(json.stdout.text).not.toContain(wallet.address)
    }
  })

  test("human output prints one line per event with time, kind, who, action and size", async () => {
    const f = setup(page)
    expect(await run(["token", "events", mint], f.deps)).toBe(0)
    expect(f.seen[0]).toContain(`/api/v1/tokens/solana/${mint}/events`)
    const text = humanText(f.stdout.text)
    expect(text).toContain("Token")
    expect(text).toContain(mint)
    expect(text).toContain("Events 3")
    expect(text).toContain("trade")
    expect(text).toContain("Wall…1111 (smart)")
    expect(text).toContain("sold")
    expect(text).toContain("$3,000.00")
    expect(text).toContain("$48.00")
    expect(text).toContain(", W")
    expect(text).toContain("dormant_buy")
    expect(text).toContain("A wallet that had been quiet bought.")
    expect(text).toContain("@hitman (rank 3)")
    expect(text).toContain("called out")
    expect(text).toContain("$1,200.00")
    expect(text).toContain("at $48,000.00 MC")
    // The cursor is a value the operator pastes back: printed whole, never shortened.
    expect(f.stdout.text).toContain(`--before ${page.nextCursor}`)
    expect(f.stderr.text).toBe("")
  })

  test("--kind filters the page locally and the line count follows", async () => {
    const f = setup(page)
    expect(await run(["token", "events", mint, "--kind", "signal"], f.deps)).toBe(0)
    const text = humanText(f.stdout.text)
    expect(text).toContain("Events 1 (signal only)")
    expect(text).toContain("dormant_buy")
    expect(text).not.toContain("sold")
    expect(text).toContain(`--before ${page.nextCursor}`)
  })

  test("--json prints one value with the page and the cursor, kind applied", async () => {
    const f = setup(page)
    expect(await run(["token", "events", mint, "--kind", "trade", "--json"], f.deps)).toBe(0)
    const lines = f.stdout.text.trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(f.stdout.text) as { ok: boolean; data: { events: unknown[]; nextCursor: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.events).toHaveLength(1)
    expect(parsed.data.nextCursor).toBe(page.nextCursor)
    expect(f.stderr.text).toBe("")
  })

  test("query flags travel: --chain hood, --since, --limit, --before", async () => {
    const f = setup({ success: true, events: [], nextCursor: null })
    expect(
      await run(
        [
          "token",
          "events",
          "0x" + "a".repeat(40),
          "--chain",
          "hood",
          "--since",
          "2026-10-28T00:00:00Z",
          "--limit",
          "50",
          "--before",
          "cur",
        ],
        f.deps,
      ),
    ).toBe(0)
    const url = new URL(f.seen[0] ?? "")
    expect(url.pathname).toBe(`/api/v1/tokens/hood/0x${"a".repeat(40)}/events`)
    expect(url.searchParams.get("since")).toBe("2026-10-28T00:00:00Z")
    expect(url.searchParams.get("limit")).toBe("50")
    expect(url.searchParams.get("before")).toBe("cur")
    const text = humanText(f.stdout.text)
    expect(text).toContain("No events on this page")
    expect(text).not.toContain("Next page")
  })

  test("a configured key is sent so group names follow the tier", async () => {
    const headers: Headers[] = []
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      stdout,
      stderr,
      env: { CANDLE_PLAIN: "1", CANDLE_API_KEY: "test-key" },
      fetch: (async (_url: unknown, init?: RequestInit) => {
        headers.push(new Headers(init?.headers))
        return jsonResponse(200, page)
      }) as unknown as typeof fetch,
    })
    expect(await run(["token", "events", mint], deps)).toBe(0)
    expect(headers[0]?.get("x-api-key")).toBe("test-key")
  })

  test("usage failures exit 2 with the usage line and never fetch", async () => {
    for (const argv of [
      ["token", "events"],
      ["token", "events", mint, "--chain", "ethereum"],
      ["token", "events", mint, "--kind", "miner"],
      ["token", "events", mint, "--limit", "1001"],
      ["token", "events", mint, "--since", "yesterday"],
      ["token", "events", mint, "extra"],
    ] as string[][]) {
      const f = setup(page)
      expect(await run(argv, f.deps)).toBe(2)
      expect(f.seen).toHaveLength(0)
      expect(f.stderr.text).toContain("Usage")
      f.stdout.text = ""
    }
  })

  test("the API's switched-off answer is a failure with its code, and JSON stays one value", async () => {
    const f = setup(
      {
        success: false,
        error: { code: "TOKEN_EVENTS_DISABLED", message: "Token events are switched off.", retryable: false },
      },
      503,
    )
    expect(await run(["token", "events", mint], f.deps)).toBe(1)
    expect(humanText(f.stderr.text)).toContain("Token events are switched off.")
    expect(f.stdout.text).toBe("")
    const j = setup(
      {
        success: false,
        error: { code: "TOKEN_EVENTS_DISABLED", message: "Token events are switched off.", retryable: false },
      },
      503,
    )
    expect(await run(["token", "events", mint, "--json"], j.deps)).toBe(1)
    const lines = j.stdout.text.trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "TOKEN_EVENTS_DISABLED" })
    expect(j.stderr.text).toBe("")
  })
})
