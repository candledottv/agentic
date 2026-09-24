/**
 * BE-316 (Ember Phase 3 R7, P3-ED-10): `candle pnl`.
 *
 *   - No `--profile`: the account's books, `GET /agent/books`, with the active profile's key. Also
 *     when `CANDLE_PROFILE` selects the profile: that is a standing selection, not a request for
 *     one key's P&L.
 *   - `--profile <name>`: `GET /agent/keys/<that key's prefix>/pnl`, authenticated as that key.
 *   - A key without the Read scope gets SCOPE_MISSING naming both ways forward.
 *   - Unpriced positions read "unpriced", never $0, and a truncated history says so.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "../test-support"

const API = "https://api.example.test"
const KEY_A = `cndl_live_${"A".repeat(8)}${"a".repeat(35)}`
const KEY_B = `cndl_live_${"B".repeat(8)}${"b".repeat(35)}`
const MEME = "MemeMint1111111111111111111111111111111111"
const DUST = "DustMint2222222222222222222222222222222222"

const BOOKS = {
  success: true,
  all: {
    realizedNetUsd: 97,
    realizedGrossUsd: 100,
    feesUsd: 3,
    unrealizedUsd: 12,
    totalUsd: 109,
    openPositions: 2,
    closedRounds: 1,
    unmarked: 1,
    counted: 5,
    unvalued: 0,
    unresolved: 0,
    unresolvedMints: [],
  },
  solana: {},
  hood: {},
  positions: [
    {
      mint: MEME,
      symbol: "MEME",
      name: "Meme",
      chain: "solana",
      book: "Scalper",
      quantity: 6,
      avgEntryUsd: 1,
      costBasisUsd: 6,
      markPriceUsd: 3,
      marketValueUsd: 18,
      unrealizedUsd: 12,
    },
    {
      mint: DUST,
      symbol: null,
      name: null,
      chain: "solana",
      book: null,
      quantity: 1000,
      avgEntryUsd: 0.001,
      costBasisUsd: 1,
      unpricedReason: "no-market-row",
    },
  ],
  closedRounds: [],
  lookback: 2000,
  truncated: true,
}

const PROFILE_PNL = {
  success: true,
  keyPrefix: "BBBBBBBB",
  pnl: {
    realizedGrossUsd: 10,
    feesUsd: 1,
    realizedNetUsd: 9,
    openPositions: [],
    unrealizedUsd: 0,
    unmarkedPositions: 0,
    counted: 2,
    unvalued: 0,
    tradesConsidered: 2,
    lookback: 500,
    truncated: false,
  },
}

function harness(opts: { env?: Record<string, string>; books?: Response; withProfiles?: boolean } = {}) {
  const calls: { path: string; key: string | null }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, key: new Headers(init?.headers).get("x-api-key") })
    if (url.pathname === "/api/v1/agent/books") return opts.books ?? Response.json(BOOKS)
    if (url.pathname === "/api/v1/agent/keys/BBBBBBBB/pnl") return Response.json(PROFILE_PNL)
    throw new Error(`Unexpected ${url.pathname}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const profiles = opts.withProfiles
    ? {
        store: createFakeStore({ "profile:main:api_key": KEY_A, "profile:scalper:api_key": KEY_B }),
        ...createFakeConfigStore({ profiles: { main: {}, scalper: {} }, activeProfile: "main" }),
      }
    : {}
  const deps = createTestDeps({
    fetch: fetchFn,
    stdout,
    stderr,
    env: { CANDLE_API_URL: API, ...(opts.withProfiles ? {} : { CANDLE_API_KEY: KEY_A }), ...(opts.env ?? {}) },
    ...profiles,
  })
  return { deps, stdout, stderr, calls }
}

describe("candle pnl", () => {
  test("no --profile reads the account's books with the active key and renders both kinds of unpriced honestly", async () => {
    const h = harness()
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ path: "/api/v1/agent/books", key: KEY_A }])
    const out = h.stdout.text
    expect(out).toContain("P&L for the account: every profile, the web app and the CLI, one ledger")
    expect(out).toMatch(/Realized net\s+\$97\.00\s+\(gross \$100\.00, fees \$3\.00\)/)
    expect(out).toMatch(/Unrealized\s+\$12\.00\s+\(1 of 2 open positions marked; 1 unpriced, not counted\)/)
    expect(out).toMatch(/Total\s+\$109\.00/)
    expect(out).toContain("History is truncated: this covers the most recent 2000 ledger rows")
    expect(out).toMatch(/MEME\s+6\s+\$1\.00\s+\$3\.00\s+\$12\.00\s+Scalper/)
    // No name and no mark: the short mint, "unpriced", and no figure -- never $0.00.
    expect(out).toMatch(/Dust…2222\s+1,000\s+\$0\.001\s+unpriced\s+-\s+-/)
  })

  test("--json is the books with the scope named, one line", async () => {
    const h = harness()
    expect(await run(["pnl", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc).toMatchObject({ ok: true, scope: "account", truncated: true, lookback: 2000 })
    expect(doc.all.totalUsd).toBe(109)
    expect(doc.positions).toHaveLength(2)
    expect(doc.success).toBeUndefined()
    expect(h.stdout.text.trim().split("\n")).toHaveLength(1)
  })

  test("--profile <name> reads that key's own P&L on the per-key route, as that key", async () => {
    const h = harness({ withProfiles: true })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ path: "/api/v1/agent/keys/BBBBBBBB/pnl", key: KEY_B }])
    expect(h.stdout.text).toContain("P&L for profile scalper (key BBBBBBBB): this key's own fills")
    expect(h.stdout.text).toMatch(/Total\s+\$9\.00/)
    expect(h.stdout.text).toContain("No open positions.")

    const j = harness({ withProfiles: true })
    expect(await run(["pnl", "--profile=scalper", "--json"], j.deps)).toBe(0)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: true, scope: "profile", keyPrefix: "BBBBBBBB" })
  })

  test("CANDLE_PROFILE picks the credentials but still reads the account's books", async () => {
    const h = harness({ withProfiles: true, env: { CANDLE_PROFILE: "scalper" } })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ path: "/api/v1/agent/books", key: KEY_B }])
  })

  test("a key without the Read scope is told both ways forward", async () => {
    const h = harness({
      books: Response.json(
        {
          success: false,
          error: { code: "SCOPE_MISSING", message: "The account's books require a Read key (the account:read scope)" },
        },
        { status: 403 },
      ),
    })
    expect(await run(["pnl", "--json"], h.deps)).toBe(1)
    const doc = JSON.parse(h.stdout.text)
    expect(doc).toMatchObject({ ok: false, code: "SCOPE_MISSING" })
    expect(doc.suggestion).toContain("candle pnl --profile <name>")
  })

  test("no key is NO_API_KEY before any request, and a stray argument is usage", async () => {
    const none = harness({ env: { CANDLE_API_KEY: "" } })
    expect(await run(["pnl", "--json"], none.deps)).toBe(1)
    expect(JSON.parse(none.stdout.text)).toMatchObject({ ok: false, code: "NO_API_KEY" })
    expect(none.calls).toEqual([])

    const stray = harness()
    expect(await run(["pnl", "extra", "--json"], stray.deps)).toBe(2)
    expect(JSON.parse(stray.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
  })

  test("control characters in a server-supplied symbol or book never reach the terminal", async () => {
    const hostile = {
      ...BOOKS,
      positions: [{ ...BOOKS.positions[0], symbol: "\u001b[2JMEME\u0007", book: "Scal\u001b[31mper\u009b" }],
    }
    const h = harness({ books: Response.json(hostile) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(h.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(h.stdout.text).toMatch(/\[2JMEME\s+6\s+\$1\.00\s+\$3\.00\s+\$12\.00\s+Scal\[31mper/)
  })
})
