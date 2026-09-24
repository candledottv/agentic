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

const POS_OPEN = "PositionNftAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const POS_UNPRICED = "PositionNftBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const POS_SWEPT = "PositionNftCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
const POOL = "PoolAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
const TEE = "TeeWalletAddressTTTTTTTTTTTTTTTTTTTTTTTTTTT"

/** The LP section the API adds when it serves LP (BE-323): one valued, one unpriced, one swept. */
const LP = {
  read: true,
  realizedUsd: 16.5,
  withdrawnUsd: 315,
  realizedBasisUsd: 300,
  claimedFeesUsd: 1.5,
  unrealizedUsd: 3.5,
  valueUsd: 303.5,
  costBasisUsd: 300,
  holdValueUsd: 350,
  vsHoldingUsd: -46.5,
  vsHoldingPositions: 1,
  openPositions: 3,
  valued: 1,
  unpriced: 1,
  unreadable: 0,
  closedOutsideLedger: 1,
  closedPositions: 1,
  unvalued: 0,
  basisIncomplete: 0,
  complete: true,
  lookback: 500,
  truncated: false,
  positions: [
    {
      position: POS_OPEN,
      pool: POOL,
      wallet: TEE,
      book: "Scalper",
      status: "valued",
      costBasisUsd: 300,
      claimedFeesUsd: 1.5,
      realizedUsd: 1.5,
      valueUsd: 303.5,
      unrealizedUsd: 3.5,
      holdValueUsd: 350,
      vsHoldingUsd: -46.5,
    },
    {
      position: POS_SWEPT,
      pool: POOL,
      wallet: TEE,
      book: null,
      status: "closed-outside-ledger",
      costBasisUsd: 120,
      claimedFeesUsd: 0,
      realizedUsd: 0,
    },
    {
      position: POS_UNPRICED,
      pool: POOL,
      wallet: TEE,
      book: "Scalper",
      status: "unpriced",
      costBasisUsd: 50,
      claimedFeesUsd: 0,
      realizedUsd: 0,
      unpriced: 1,
    },
  ],
}

function harness(
  opts: { env?: Record<string, string>; books?: Response; profile?: Response; withProfiles?: boolean } = {},
) {
  const calls: { path: string; key: string | null }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, key: new Headers(init?.headers).get("x-api-key") })
    if (url.pathname === "/api/v1/agent/books") return opts.books ?? Response.json(BOOKS)
    if (url.pathname === "/api/v1/agent/keys/BBBBBBBB/pnl") return opts.profile ?? Response.json(PROFILE_PNL)
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

  /**
   * BE-323 (E2). With an `lp` section the summary gains the three LP lines and the total covers
   * tokens and LP; the open LP positions get their own table; every kind of absence is a word.
   */
  test("an lp section adds LP realized, unrealized and vs holding, a total across both, and an LP table", async () => {
    const h = harness({ books: Response.json({ ...BOOKS, lp: LP }) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    const out = h.stdout.text
    expect(out).toMatch(/Realized net\s+\$97\.00/)
    expect(out).toMatch(/Unrealized\s+\$12\.00/)
    expect(out).toMatch(
      /LP realized\s+\$16\.50\s+\(withdrawn \$315\.00 against \$300\.00 of cost basis, plus \$1\.50 claimed fees\)/,
    )
    expect(out).toMatch(
      /LP unrealized\s+\$3\.50\s+\(1 of 3 open LP positions valued; 1 unpriced, not counted; 1 closed outside the ledger, not counted\)/,
    )
    expect(out).toMatch(
      /LP vs holding\s+-\$46\.50\s+\(1 of 1 valued, against holding the deposited tokens \(now \$350\.00\)\)/,
    )
    // 97 + 12 + 16.5 + 3.5
    expect(out).toMatch(/Total\s+\$129\.00\s+\(realized net plus unrealized, tokens and LP\)/)
    expect(out).toContain("1 LP position was closed outside the ledger")
    expect(out).toContain("Open LP positions")
    expect(out).toMatch(/Posi…AAAA\s+Pool…XXXX\s+TeeW…TTTT\s+\$303\.50\s+\$300\.00\s+\$3\.50\s+-\$46\.50\s+Scalper/)
    expect(out).toMatch(/Posi…CCCC\s+Pool…XXXX\s+TeeW…TTTT\s+closed outside the ledger\s+\$120\.00\s+-\s+-\s+-/)
    expect(out).toMatch(/Posi…BBBB\s+Pool…XXXX\s+TeeW…TTTT\s+unpriced\s+\$50\.00\s+-\s+-\s+Scalper/)
    // The token positions table is still there, before the LP one.
    expect(out.indexOf("Open positions")).toBeLessThan(out.indexOf("Open LP positions"))
  })

  test("--json carries the lp section as the API sent it, and --profile renders LP without a book column", async () => {
    const j = harness({ books: Response.json({ ...BOOKS, lp: LP }) })
    expect(await run(["pnl", "--json"], j.deps)).toBe(0)
    expect(JSON.parse(j.stdout.text).lp).toEqual(LP)

    const p = harness({ withProfiles: true, profile: Response.json({ ...PROFILE_PNL, lp: LP }) })
    expect(await run(["pnl", "--profile", "scalper"], p.deps)).toBe(0)
    expect(p.stdout.text).toMatch(/Total\s+\$29\.00\s+\(realized net plus unrealized, tokens and LP\)/)
    expect(p.stdout.text).toMatch(/Posi…AAAA\s+Pool…XXXX\s+TeeW…TTTT\s+\$303\.50\s+\$300\.00\s+\$3\.50\s+-\$46\.50\n/)
    expect(p.stdout.text).not.toContain("BOOK")
  })

  test("an LP read the API could not make is a line, not a figure, and the total says tokens only", async () => {
    const h = harness({
      books: Response.json({ ...BOOKS, lp: { read: false, reason: "The LP ledger or positions could not be read" } }),
    })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/LP\s+not read\s+\(The LP ledger or positions could not be read; not in the total\)/)
    expect(h.stdout.text).toMatch(/Total\s+\$109\.00\s+\(realized net plus unrealized, tokens only\)/)
    expect(h.stdout.text).not.toContain("Open LP positions")
  })

  test("an lp section with no open positions, truncated: the lines, the caption, no table", async () => {
    const lp = {
      ...LP,
      openPositions: 0,
      valued: 0,
      unpriced: 0,
      closedOutsideLedger: 0,
      vsHoldingPositions: 0,
      unrealizedUsd: 0,
      positions: [],
      truncated: true,
      unvalued: 2,
    }
    const h = harness({ books: Response.json({ ...BOOKS, lp }) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/LP unrealized\s+\$0\.00\s+\(0 of 0 open LP positions valued\)/)
    expect(h.stdout.text).toMatch(/LP vs holding\s+-\s+\(no valued LP position with every deposit priced\)/)
    expect(h.stdout.text).toContain("2 LP ledger legs could not be valued and are not in these figures.")
    expect(h.stdout.text).toContain("LP history is truncated: this covers the most recent 500 LP operations")
    expect(h.stdout.text).not.toContain("Open LP positions")
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

    // The LP table and the not-read reason pass through the same filter.
    const lpHostile = {
      ...BOOKS,
      lp: { ...LP, positions: [{ ...LP.positions[0], book: "Pool\u001b[2Jer" }] },
    }
    const l = harness({ books: Response.json(lpHostile) })
    expect(await run(["pnl"], l.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(l.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(l.stdout.text).toContain("Pool[2Jer")
    const r = harness({ books: Response.json({ ...BOOKS, lp: { read: false, reason: "down\u0007" } }) })
    expect(await run(["pnl"], r.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(r.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(r.stdout.text).toContain("(down; not in the total)")
  })
})
