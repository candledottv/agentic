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

/** Wrapped notes and captions read as one line. */
const flat = (text: string): string => text.replace(/\s+/g, " ")

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
    expect(out).toMatch(/Realized net\s+\+\$97\.00\s+gross \$100\.00, fees \$3\.00/)
    expect(out).toMatch(/Unrealized\s+\+\$12\.00\s+1 of 2 open positions marked; 1 unpriced, not counted/)
    expect(out).toMatch(/Total\s+\+\$109\.00/)
    expect(out).toContain("History is truncated: this covers the most recent 2000 ledger rows")
    // `solana: {}` and `hood: {}` carry no figures: no chain blocks, the output an older API gets.
    expect(out).not.toContain("All chains")
    expect(out).toMatch(/MEME\s+solana\s+6\s+\$1\.00\s+\$3\.00\s+\+\$12\.00\s+Scalper/)
    // No name and no mark: the short mint, "unpriced", and no figure -- never $0.00.
    expect(out).toMatch(/Dust…2222\s+solana\s+1,000\s+\$0\.001\s+unpriced\s+–\s+–/)
  })

  test("--full retains every ID in account and profile tables at 80 columns", async () => {
    const wallet = `Wall${"A".repeat(40)}`
    const movedFrom = `From${"C".repeat(40)}`
    const mint = `Mint${"B".repeat(40)}`
    const positions = [
      {
        ...BOOKS.positions[0],
        symbol: null,
        mint,
        wallet,
        transferredIn: true,
        movedInFromWallet: movedFrom,
        basisSource: "chain",
      },
    ]
    for (const profile of [false, true]) {
      const h = harness({
        withProfiles: profile,
        books: Response.json({ ...BOOKS, positions, lp: LP }),
        profile: Response.json({
          ...PROFILE_PNL,
          lp: LP,
          pnl: {
            ...PROFILE_PNL.pnl,
            totalUsd: 21,
            openPositions: positions,
            byWallet: [
              {
                wallet,
                label: "long wallet",
                chain: "solana",
                tradesConsidered: 2,
                realizedNetUsd: 9,
                unrealizedUsd: 12,
                openPositions: positions,
                unmarkedPositions: 0,
              },
            ],
          },
        }),
      })
      h.deps.columns = { stdout: 80 }
      expect(await run(["pnl", "--full", ...(profile ? ["--profile", "scalper"] : [])], h.deps)).toBe(0)
      for (const id of [wallet, movedFrom, mint, POS_OPEN, POS_UNPRICED, POS_SWEPT, POOL, TEE]) {
        expect(h.stdout.text).toContain(id)
      }
      expect(h.stdout.text).not.toContain("Mint…")
      expect(h.stdout.text).not.toContain("Wall…")
      expect(h.stderr.text).toBe("")
      for (const line of h.stdout.text.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80)
    }
  })

  test("40-column account and profile output wraps titles and keeps unnamed tokens and figures meaningful", async () => {
    const mint = `Mint${"B".repeat(40)}`
    const wallet = `Wall${"A".repeat(40)}`
    const positions = [{ ...BOOKS.positions[0], symbol: null, mint, wallet, markPriceUsd: 2 }]
    for (const profile of [false, true]) {
      for (const plain of [false, true]) {
        const h = harness({
          withProfiles: profile,
          books: Response.json({ ...BOOKS, positions }),
          profile: Response.json({
            ...PROFILE_PNL,
            pnl: { ...PROFILE_PNL.pnl, totalUsd: 21, openPositions: positions },
          }),
        })
        h.deps.columns = { stdout: 40 }
        expect(
          await run(
            ["pnl", ...(plain ? ["--plain"] : ["--no-color"]), ...(profile ? ["--profile", "scalper"] : [])],
            h.deps,
          ),
        ).toBe(0)
        const output = h.stdout.text.split("\n\n").slice(1).join("\n\n") // identity is a separate shared surface
        expect(flat(output)).toContain(profile ? "P&L for profile scalper" : "P&L for the account")
        expect(output).toContain("Mint…BBBB")
        expect(output).toContain("Wall…AAAA")
        expect(output).toMatch(/AVG ENTRY\s+\$1\.00/)
        expect(output).toMatch(/MARK\s+\$2\.00/)
        expect(output).toMatch(/UNREALIZED\s+\+\$12\.00/)
        expect(output).not.toContain("$...")
        for (const line of output.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40)
        expect(h.stderr.text).toBe("")
      }
    }
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
    expect(h.stdout.text).toMatch(/Total\s+\+\$9\.00/)
    expect(h.stdout.text).toContain("No open positions.")

    const j = harness({ withProfiles: true })
    expect(await run(["pnl", "--profile=scalper", "--json"], j.deps)).toBe(0)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: true, scope: "profile", keyPrefix: "BBBBBBBB" })
  })

  test("CANDLE_PROFILE picks the credentials but still reads the account's books", async () => {
    const h = harness({ withProfiles: true, env: { CANDLE_PROFILE: "scalper" } })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ path: "/api/v1/agent/books", key: KEY_B }])
    expect(h.stdout.text).not.toContain("Hyperliquid")
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
    expect(out).toMatch(/Realized net\s+\+\$97\.00/)
    expect(out).toMatch(/Unrealized\s+\+\$12\.00/)
    expect(out).toMatch(
      /LP realized\s+\+\$16\.50\s+withdrawn \$315\.00 against \$300\.00 of cost basis, plus \$1\.50 claimed fees/,
    )
    expect(flat(out)).toMatch(
      /LP unrealized \+\$3\.50 1 of 3 open LP positions valued; 1 unpriced, not counted; 1 closed outside the ledger, not counted/,
    )
    expect(out).toMatch(
      /LP vs holding\s+-\$46\.50\s+1 of 1 valued, against holding the deposited tokens \(now \$350\.00\)/,
    )
    // The token Total is the console's figure (P&L spec R4); LP is added on its own line: 109 + 16.5 + 3.5.
    expect(out).toMatch(/Total\s+\+\$109\.00\s+realized net plus unrealized, tokens only, as the console shows it/)
    expect(out).toMatch(/Total with LP\s+\+\$129\.00\s+the total plus LP realized and unrealized/)
    expect(out).toContain("1 LP position was closed outside the ledger")
    expect(out).toContain("Open LP positions")
    expect(out).toMatch(/Posi…AAAA\s+Pool…XXXX\s+TeeW…TTTT\s+\$303\.50\s+\$300\.00\s+\+\$3\.50\s+-\$46\.50\s+Scalper/)
    expect(out).toMatch(/Posi…CCCC\s+Pool…XXXX\s+TeeW…TTTT\s+closed outside the ledger\s+\$120\.00\s+–\s+–\s+–/)
    expect(out).toMatch(/Posi…BBBB\s+Pool…XXXX\s+TeeW…TTTT\s+unpriced\s+\$50\.00\s+–\s+–\s+Scalper/)
    // The token positions table is still there, before the LP one.
    expect(out.indexOf("Open positions")).toBeLessThan(out.indexOf("Open LP positions"))
  })

  test("--json carries the lp section as the API sent it, and --profile renders LP without a book column", async () => {
    const j = harness({ books: Response.json({ ...BOOKS, lp: LP }) })
    expect(await run(["pnl", "--json"], j.deps)).toBe(0)
    expect(JSON.parse(j.stdout.text).lp).toEqual(LP)

    const p = harness({ withProfiles: true, profile: Response.json({ ...PROFILE_PNL, lp: LP }) })
    expect(await run(["pnl", "--profile", "scalper"], p.deps)).toBe(0)
    expect(p.stdout.text).toMatch(/Total\s+\+\$9\.00\s+realized net plus unrealized, tokens only/)
    expect(p.stdout.text).toMatch(/Total with LP\s+\+\$29\.00/)
    expect(p.stdout.text).toMatch(/Posi…AAAA\s+Pool…XXXX\s+TeeW…TTTT\s+\$303\.50\s+\$300\.00\s+\+\$3\.50\s+-\$46\.50\n/)
    expect(p.stdout.text).not.toContain("BOOK")
  })

  test("an LP read the API could not make is a line, not a figure, and the total says tokens only", async () => {
    const h = harness({
      books: Response.json({ ...BOOKS, lp: { read: false, reason: "The LP ledger or positions could not be read" } }),
    })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/LP\s+not read\s+The LP ledger or positions could not be read; not in the total/)
    expect(h.stdout.text).toMatch(/Total\s+\+\$109\.00\s+realized net plus unrealized, tokens only/)
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
    expect(h.stdout.text).toMatch(/LP unrealized\s+\$0\.00\s+0 of 0 open LP positions valued/)
    expect(h.stdout.text).toMatch(/LP vs holding\s+–\s+no valued LP position with every deposit priced/)
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
    expect(h.stdout.text).toMatch(/\[2JMEME\s+solana\s+6\s+\$1\.00\s+\$3\.00\s+\+\$12\.00\s+Scal\[31mper/)

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
    expect(r.stdout.text).toContain("down; not in the total")
  })
})

/**
 * Ember Phase 4d PR B (BE-670, 4d-ED-8, 4d-ED-9): both chains in `candle pnl`. The account answer's
 * `solana` and `hood` summaries, and the key answer's `byChain` and `byWallet[].chain`.
 */
const HOODIE = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
const HOOD_WALLET = "0xF628F9fb00000000000000000000000000000001"

const chainSummary = (realizedNetUsd: number, unrealizedUsd: number, openPositions: number, unmarked = 0) => ({
  realizedNetUsd,
  realizedGrossUsd: realizedNetUsd + 1,
  feesUsd: 1,
  unrealizedUsd,
  totalUsd: realizedNetUsd + unrealizedUsd,
  openPositions,
  closedRounds: 0,
  unmarked,
  counted: 3,
  unvalued: 0,
  unresolved: 0,
  unresolvedMints: [],
})

const BOTH_CHAINS_BOOKS = {
  ...BOOKS,
  all: { ...BOOKS.all, realizedNetUsd: 97, unrealizedUsd: 12 + 20, totalUsd: 129, openPositions: 3 },
  solana: chainSummary(90, 12, 2, 1),
  hood: chainSummary(7, 20, 1),
  positions: [
    ...BOOKS.positions,
    {
      mint: HOODIE,
      symbol: "HOODIE",
      name: "Hoodie",
      chain: "hood",
      book: "Scalper",
      quantity: 40,
      avgEntryUsd: 0.5,
      costBasisUsd: 20,
      markPriceUsd: 1,
      marketValueUsd: 40,
      unrealizedUsd: 20,
    },
  ],
}

const BOTH_CHAINS_PROFILE = {
  ...PROFILE_PNL,
  pnl: {
    ...PROFILE_PNL.pnl,
    openPositions: [
      {
        mint: HOODIE,
        symbol: "HOODIE",
        chain: "hood",
        quantity: 40,
        avgEntryUsd: 0.5,
        costBasisUsd: 20,
        markPriceUsd: 1,
        unrealizedUsd: 20,
      },
    ],
    unrealizedUsd: 20,
    byChain: {
      solana: { ...chainSummary(4, 0, 0), unmarkedPositions: 0, tradesConsidered: 1 },
      hood: { ...chainSummary(5, 20, 1), unmarkedPositions: 0, tradesConsidered: 1 },
    },
    byWallet: [
      {
        wallet: HOOD_WALLET,
        payerType: "linked",
        chain: "hood",
        linkedWalletId: "lw_1",
        label: "hood-tee",
        realizedNetUsd: 5,
        unrealizedUsd: 20,
        unmarkedPositions: 0,
        openPositions: [{ mint: HOODIE, chain: "hood" }],
        tradesConsidered: 1,
      },
      {
        wallet: "MainWa11et1111111111111111111111111111111",
        payerType: "main",
        chain: "solana",
        label: null,
        realizedNetUsd: 4,
        unrealizedUsd: 0,
        unmarkedPositions: 0,
        openPositions: [],
        tradesConsidered: 1,
      },
    ],
  },
}

describe("Ember 4d: both chains in candle pnl", () => {
  test("account scope: a Solana block, a Hood block, then the combined figure; a CHAIN column on positions", async () => {
    const h = harness({ books: Response.json(BOTH_CHAINS_BOOKS) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    const out = h.stdout.text
    const at = (text: string) => out.indexOf(text)
    expect(at("Solana\n")).toBeGreaterThan(-1)
    expect(at("Solana\n")).toBeLessThan(at("Hood\n"))
    expect(at("Hood\n")).toBeLessThan(at("All chains\n"))
    const solana = out.slice(at("Solana\n"), at("Hood\n"))
    expect(solana).toMatch(/Realized net\s+\+\$90\.00\s+gross \$91\.00, fees \$1\.00/)
    expect(solana).toMatch(/Unrealized\s+\+\$12\.00\s+1 of 2 open positions marked; 1 unpriced, not counted/)
    expect(solana).toMatch(/Total\s+\+\$102\.00/)
    const hood = out.slice(at("Hood\n"), at("All chains\n"))
    expect(hood).toMatch(/Realized net\s+\+\$7\.00/)
    expect(hood).toMatch(/Unrealized\s+\+\$20\.00\s+1 of 1 open position marked/)
    expect(hood).toMatch(/Total\s+\+\$27\.00/)
    const all = out.slice(at("All chains\n"))
    expect(all).toMatch(/Realized net\s+\+\$97\.00/)
    expect(all).toMatch(/Total\s+\+\$129\.00/)
    expect(out).toContain("TOKEN      CHAIN   QUANTITY")
    expect(out).toMatch(/HOODIE\s+hood\s+40\s+\$0\.5\s+\$1\.00\s+\+\$20\.00\s+Scalper/)
    expect(out).toMatch(/MEME\s+solana\s+6/)
  })

  test("account scope --json is the body as the API sent it: chain summaries and positions' chain included", async () => {
    const h = harness({ books: Response.json(BOTH_CHAINS_BOOKS) })
    expect(await run(["pnl", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.scope).toBe("account")
    expect(doc.solana.realizedNetUsd).toBe(90)
    expect(doc.hood.unrealizedUsd).toBe(20)
    expect(doc.positions.map((p: { chain: string }) => p.chain)).toEqual(["solana", "solana", "hood"])
  })

  test("key scope: byChain blocks, a CHAIN column on positions, and the by-wallet rows with their chain", async () => {
    const h = harness({ withProfiles: true, profile: Response.json(BOTH_CHAINS_PROFILE) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    const out = h.stdout.text
    const at = (text: string) => out.indexOf(text)
    expect(at("Solana\n")).toBeLessThan(at("Hood\n"))
    expect(at("Hood\n")).toBeLessThan(at("All chains\n"))
    expect(out.slice(at("Hood\n"), at("All chains\n"))).toMatch(/Total\s+\+\$25\.00/)
    expect(out).toMatch(/HOODIE\s+hood\s+40/)
    expect(out).toContain("By wallet (each its own cost basis, so the rows need not sum to the total)")
    expect(out).toMatch(/WALLET\s+CHAIN\s+TRADES\s+REALIZED NET\s+UNREALIZED\s+OPEN/)
    expect(out).toMatch(/hood-tee \(0xF6…0001\)\s+hood\s+1\s+\+\$5\.00\s+\+\$20\.00\s+1/)
    expect(out).toMatch(/main \(Main…1111\)\s+solana\s+1\s+\+\$4\.00\s+\$0\.00\s+0/)

    const j = harness({ withProfiles: true, profile: Response.json(BOTH_CHAINS_PROFILE) })
    expect(await run(["pnl", "--profile", "scalper", "--json"], j.deps)).toBe(0)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.pnl.byWallet.map((w: { chain: string }) => w.chain)).toEqual(["hood", "solana"])
    expect(Object.keys(doc.pnl.byChain)).toEqual(["solana", "hood"])
  })

  test("key scope from an API without byChain, byWallet or chain: no blocks, no wallet table, and '-' for the chain", async () => {
    const older = {
      ...PROFILE_PNL,
      pnl: {
        ...PROFILE_PNL.pnl,
        openPositions: [{ mint: MEME, symbol: "MEME", quantity: 6, avgEntryUsd: 1, costBasisUsd: 6 }],
      },
    }
    const h = harness({ withProfiles: true, profile: Response.json(older) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).not.toContain("All chains")
    expect(h.stdout.text).not.toContain("By wallet")
    expect(h.stdout.text).toMatch(/MEME\s+–\s+6\s+\$1\.00\s+unpriced/)
  })

  test("control characters in a wallet label never reach the terminal", async () => {
    const hostile = structuredClone(BOTH_CHAINS_PROFILE)
    ;(hostile.pnl.byWallet[0] as { label: string }).label = "hood\u001b[2J-tee"
    const h = harness({ withProfiles: true, profile: Response.json(hostile) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(h.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(h.stdout.text).toContain("hood[2J-tee (0xF6…0001)")
  })
})

describe("Hyperliquid profile PnL", () => {
  const W = "0x1111111111111111111111111111111111111111"
  const AT = Date.UTC(2026, 9, 27, 10, 2)
  const section = {
    read: true,
    network: "mainnet",
    coverage: "profile",
    realizedGrossUsd: 100,
    fundingUsd: 2.5,
    feesUsd: 0.5,
    realizedNetUsd: 102,
    unrealizedUsd: "-7.250000",
    netUsd: "94.750000",
    markedAt: AT,
    perpsSnapshotId: "ps1_x",
    completeThroughMs: AT,
    positions: [
      {
        kind: "perp",
        coin: "ETH",
        side: "short",
        size: "1.5",
        leverage: { value: 10, type: "cross" },
        entryPx: "2000",
        markPx: "2005",
        positionValueUsd: "3007.5",
        marginUsedUsd: "300.75",
        unrealizedPnlUsd: "-7.25",
        returnOnEquity: "-0.024",
        liquidationPx: "2200",
        liquidationDistance: 0.097,
        fundingNetUsd: "1.25",
        level: "ok",
      },
    ],
    fills: 2,
    fundingPayments: 1,
    byWallet: [
      {
        address: W,
        fromMs: Date.UTC(2026, 9, 1),
        toMs: Date.UTC(2026, 9, 10),
        startTime: Date.UTC(2026, 9, 1),
        observationCutoffMs: AT,
        completeThroughMs: AT,
        reconciliation: "settled",
      },
      {
        address: W,
        fromMs: Date.UTC(2026, 9, 20),
        toMs: null,
        startTime: Date.UTC(2026, 9, 20),
        observationCutoffMs: AT,
        completeThroughMs: AT,
        reconciliation: "live",
      },
    ],
    historyPartial: false,
    partialReasons: [],
    truncated: false,
    fillsLimit: 2000,
    fundingLimit: 500,
    walletsLimit: 20,
  }
  const SPOT_TOTAL = { ...PROFILE_PNL, pnl: { ...PROFILE_PNL.pnl, totalUsd: 9 } }
  const withPerps = {
    ...SPOT_TOTAL,
    pnl: { ...SPOT_TOTAL.pnl, totalUsd: 103.75 },
    hyperliquid: section,
    perpsInTotal: true,
  }
  test("perps and pnl help direct readers to the profile section and live unrealized views", async () => {
    for (const topic of ["perps", "pnl"]) {
      const h = harness()
      expect(await run(["help", topic, "--more"], h.deps)).toBe(0)
      // Help wraps paragraphs to terminal width; compare words across those line breaks.
      const help = h.stdout.text.replace(/\s+/g, " ")
      expect(help).toContain("--profile <name>")
      expect(help).toContain("Hyperliquid")
      expect(help).toContain("funding")
      expect(help).toContain("fees")
      expect(help).toContain("also counted in")
      expect(help).toContain("Account-wide candle pnl and its By agent table cover ledger trades only")
      expect(help).toContain("a key with only perps activity has no row there")
      expect(help).toContain("candle perps positions")
      expect(help).toContain("candle portfolio")
      expect(help).not.toContain("never added to the spot or LP totals")
      expect(help).not.toContain("The account's P&L (candle pnl) carries a Hyperliquid section")
      expect(h.calls).toEqual([])
    }
  })
  test("R7 amended: a separate heading and net, also counted in the total", async () => {
    const h = harness({ withProfiles: true, profile: Response.json(withPerps) })
    h.deps.now = () => AT
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    const text = h.stdout.text
    const perps = text.split("\nHyperliquid\n")[1] ?? ""
    expect(text).toMatch(/Total\s+\+\$103\.75\s+includes Hyperliquid; realized net plus unrealized/)
    expect(text).not.toContain("The total excludes Hyperliquid perps")
    expect(perps).toMatch(/Realized gross\s+\+\$100\.00/)
    expect(perps).toMatch(/Realized net\s+\+\$102\.00\s+gross \+ funding - fees/)
    expect(perps).toMatch(/Unrealized\s+-\$7\.25\s+open positions at Oct 27 10:02Z/)
    expect(perps).toMatch(/Net\s+\+\$94\.75\s+realized net \+ unrealized; in the total; live, not yet settled/)
    expect(flat(perps)).toContain("Coverage: every EVM TEE wallet bound to this profile, per binding period.")
    expect(perps).toMatch(new RegExp(`Wallet\\s+${W}`))
    expect(perps).toMatch(/Binding\s+Oct 1 00:00Z to Oct 10 00:00Z/)
    expect(perps).toMatch(/Reconciliation\s+settled to Oct 27 10:02Z/)
    expect(perps).toMatch(/Binding\s+Oct 20 00:00Z to now/)
    expect(perps).toMatch(/Reconciliation\s+live to Oct 27 10:02Z, not yet settled/)
    expect(perps).toMatch(/Fills\s+2/)
    expect(perps).toMatch(/Funding payments\s+1/)
    // I8: funding is positive when earned, on the figures and on every position.
    expect(perps).toMatch(/\+\$2\.50\s+received positive, paid negative/)
    expect(perps).toMatch(/Position\s+ETH 10x Short 1\.5/)
    expect(perps).toMatch(/Entry\s+2000\n/)
    expect(perps).toMatch(/Mark\s+2005\n/)
    expect(perps).toMatch(/Liquidation\s+2200\n/)
    expect(perps).toMatch(/Funding\s+\+\$1\.25\s+earned \$1\.25 funding/)
    expect(perps).not.toContain("2026-10-")
    expect(perps).not.toContain("Unrealized perps are excluded")
    expect(perps).not.toContain("previous bindings excluded")
  })
  test("a settled-only section prints no live marker; a partial one names why", async () => {
    const settled = {
      ...section,
      byWallet: [section.byWallet[0]],
      positions: [],
      historyPartial: true,
      partialReasons: ["history_partial"],
      truncated: true,
    }
    const h = harness({ withProfiles: true, profile: Response.json({ ...withPerps, hyperliquid: settled }) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).not.toContain("live, not yet settled")
    expect(h.stdout.text).not.toContain("Open perps")
    expect(h.stdout.text).toContain("These figures are partial (history_partial).")
  })
  test("an unread section leaves the spot total and says why, with no false zero", async () => {
    const reason =
      "Hyperliquid fills and funding did not reconcile with the live positions at their cutoff; retry shortly. Perps are not in the total."
    const h = harness({
      withProfiles: true,
      profile: Response.json({
        ...SPOT_TOTAL,
        hyperliquid: { read: false, code: "cutoff_unreconciled", reason },
        perpsInTotal: false,
      }),
    })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/Total\s+\+\$9\.00\s+realized net plus unrealized\n/)
    expect(h.stdout.text).not.toContain("includes Hyperliquid")
    expect(flat(h.stdout.text)).toContain(`The total excludes Hyperliquid perps: ${reason}`)
    expect(flat(h.stdout.text.split("Hyperliquid\n")[1] ?? "")).toContain(`! Unavailable: ${reason}`)
    expect(h.stdout.text.split("Hyperliquid\n")[1]).not.toContain("$0.00")
  })
  test("an older server's realized-only section is not presented as in the total", async () => {
    const old = {
      read: true,
      network: "mainnet",
      realizedGrossUsd: 10,
      fundingUsd: -1,
      feesUsd: 0.5,
      realizedNetUsd: 8.5,
      fills: 2,
      fundingPayments: 1,
      fillsLimit: 2000,
      fundingLimit: 500,
      walletsLimit: 20,
      truncated: false,
      byWallet: [{ address: W, startTime: 100 }],
    }
    const h = harness({ withProfiles: true, profile: Response.json({ ...SPOT_TOTAL, hyperliquid: old }) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/Total\s+\+\$9\.00/)
    expect(h.stdout.text).toContain("The total excludes Hyperliquid perps.")
    expect(h.stdout.text).toContain(
      "This server reports realized perps only, for the current binding, outside the total.",
    )
  })
  test("the kit keeps Hyperliquid meaning at 40 columns, without ISO times or ANSI in plain mode", async () => {
    const h = harness({
      withProfiles: true,
      profile: Response.json({
        ...withPerps,
        hyperliquid: {
          ...section,
          historyPartial: true,
          partialReasons: ["missing marks"],
          positions: [
            {
              ...section.positions[0],
              markPx: null,
              liquidationPx: null,
              fundingNetUsd: "-1.25",
            },
          ],
        },
      }),
    })
    h.deps.now = () => AT
    h.deps.columns = { stdout: 40 }
    expect(await run(["pnl", "--profile", "scalper", "--plain"], h.deps)).toBe(0)
    const perps = h.stdout.text.split("\nHyperliquid\n")[1] ?? ""
    expect(flat(perps)).toContain("received positive, paid negative")
    expect(flat(perps)).toContain("gross + funding - fees")
    expect(flat(perps)).toContain("realized net + unrealized; in the total; live, not yet settled")
    expect(flat(perps)).toContain("Coverage: every EVM TEE wallet bound to this profile, per binding period.")
    expect(flat(perps)).toContain("settled to Oct 27 10:02Z")
    expect(flat(perps)).toContain("live to Oct 27 10:02Z, not yet settled")
    expect(flat(perps)).toContain("paid $1.25 funding")
    expect(flat(perps)).toContain("no mark; not counted")
    expect(flat(perps)).toContain("no liquidation price")
    expect(flat(perps)).toContain("! These figures are partial (missing marks).")
    expect(perps).not.toContain("2026-10-")
    expect(perps).not.toContain("\x1b")
    // The one longer word is a complete wallet address, deliberately preserved for copying.
    for (const line of perps.split("\n").filter((line) => !line.includes(W))) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40)
    }
    expect(h.stderr.text).toBe("")
  })

  test("Hyperliquid signed gains and losses use the kit colors", async () => {
    const h = harness({
      withProfiles: true,
      env: { TERM: "xterm-256color", COLORFGBG: "15;0" },
      profile: Response.json(withPerps),
    })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).toContain("\x1b[38;5;42m+$100.00\x1b[0m")
    expect(h.stdout.text).toContain("\x1b[38;5;204m-$7.25\x1b[0m")
  })

  test("JSON passes through the section and perpsInTotal without extra requests", async () => {
    const h = harness({ withProfiles: true, profile: Response.json(withPerps) })
    expect(await run(["pnl", "--profile", "scalper", "--json"], h.deps)).toBe(0)
    const body = JSON.parse(h.stdout.text)
    expect(body.hyperliquid).toEqual(section)
    expect(body.perpsInTotal).toBe(true)
    expect(body.pnl.totalUsd).toBe(103.75)
    expect(h.calls).toHaveLength(1)
  })
})

/**
 * P&L rollout A4 (spec 2026-10-02-pnl-one-private-one-public-design.md, R4): both scopes read
 * the one engine A2 put behind `/books` and `/keys/{prefix}/pnl`, and print the console's figures.
 */
const WALLET_A = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1"
const WALLET_B = "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2"
const CLOSED = { closed: 3, madeUsd: 60, lostUsd: -20, partialSellsUsd: 57, wins: 1, losses: 1, costUnknown: 1 }

const ENGINE_BOOKS = {
  ...BOOKS,
  all: {
    ...BOOKS.all,
    totalUsd: 109,
    openPositions: 3,
    unmarked: 0,
    openPositionsExDust: 2,
    closedRounds: 3,
    closed: CLOSED,
  },
  positions: [
    { ...BOOKS.positions[0], wallet: WALLET_A, keyPrefix: "AAAAAAAA" },
    { ...BOOKS.positions[0], quantity: 2, costBasisUsd: 2, wallet: WALLET_B, keyPrefix: null, book: null },
    {
      mint: DUST,
      symbol: "DUSTY",
      name: null,
      chain: "solana",
      book: null,
      keyPrefix: null,
      quantity: 1,
      avgEntryUsd: 0.01,
      costBasisUsd: 0.01,
      markPriceUsd: 0.001,
      marketValueUsd: 0.001,
      unrealizedUsd: -0.009,
      dust: true,
    },
  ],
  byAgent: [
    {
      keyPrefix: "AAAAAAAA",
      label: "Scalper",
      realizedNetUsd: 80,
      unrealizedUsd: 12,
      totalUsd: 92,
      openPositions: 1,
      closedRounds: 2,
      unmarked: 0,
    },
    {
      keyPrefix: null,
      label: null,
      realizedNetUsd: 17,
      unrealizedUsd: 0,
      totalUsd: 17,
      openPositions: 2,
      closedRounds: 1,
      unmarked: 0,
    },
  ],
  costUnknown: [{ wallet: WALLET_B, mint: MEME, quantity: 5, ts: 1, reason: "no-price", chain: "solana" }],
  movedOutUntracked: [
    { wallet: WALLET_A, mint: MEME, quantity: 1, costBasisUsd: 1, ts: 2, chain: "solana" },
    { wallet: WALLET_A, mint: MEME, quantity: 1, costBasisUsd: 1, ts: 3, chain: "solana" },
  ],
}

const ENGINE_PROFILE = {
  ...PROFILE_PNL,
  pnl: {
    ...PROFILE_PNL.pnl,
    totalUsd: 9,
    openPositionsExDust: 0,
    closedRounds: 1,
    closed: { closed: 1, madeUsd: 9, lostUsd: 0, partialSellsUsd: 0, wins: 1, losses: 0, costUnknown: 0 },
    lookback: 2000,
    truncated: true,
    byWallet: [
      {
        wallet: WALLET_A,
        payerType: "main",
        chain: "solana",
        label: null,
        realizedNetUsd: 6,
        unrealizedUsd: 0,
        unmarkedPositions: 0,
        openPositions: [],
        tradesConsidered: 2,
        totalUsd: 6,
      },
      {
        wallet: "unknown:solana",
        payerType: "main",
        chain: "solana",
        label: null,
        realizedNetUsd: 3,
        unrealizedUsd: 0,
        unmarkedPositions: 0,
        openPositions: [],
        tradesConsidered: 0,
        totalUsd: 3,
      },
    ],
  },
}

describe("P&L A4: one engine in candle pnl", () => {
  test("Total is the server's totalUsd, the console's figure, not a sum the CLI makes", async () => {
    const skewed = { ...ENGINE_BOOKS, all: { ...ENGINE_BOOKS.all, totalUsd: 50 } }
    const h = harness({ books: Response.json(skewed) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    expect(h.stdout.text).toMatch(/Total\s+\+\$50\.00\s+realized net plus unrealized/)

    const chain = {
      ...ENGINE_BOOKS,
      solana: { ...BOTH_CHAINS_BOOKS.solana, totalUsd: 77 },
      hood: { ...BOTH_CHAINS_BOOKS.hood },
    }
    const c = harness({ books: Response.json(chain) })
    expect(await run(["pnl"], c.deps)).toBe(0)
    const out = c.stdout.text
    expect(out.slice(out.indexOf("Solana\n"), out.indexOf("Hood\n"))).toMatch(/Total\s+\+\$77\.00/)
    // Hood sends no totalUsd (an older API): summed here, as before.
    expect(out.slice(out.indexOf("Hood\n"), out.indexOf("All chains\n"))).toMatch(/Total\s+\+\$27\.00/)
  })

  test("account scope: the closed-position equation, dust, a WALLET column, By agent and the wallet events", async () => {
    const h = harness({ books: Response.json(ENGINE_BOOKS) })
    expect(await run(["pnl"], h.deps)).toBe(0)
    const out = h.stdout.text
    expect(flat(out)).toContain(
      "Closed 3 positions (1 won, 1 lost, 1 with unknown cost). Money made +$60.00, money lost -$20.00 and partial sells +$57.00 add up to the realized net.",
    )
    // Dust is counted in the figures and hidden from the list unless --dust asks.
    expect(flat(out)).toContain(
      "1 dust position hidden (worth under one cent; --dust to show). It is counted in the figures.",
    )
    expect(out).not.toContain("DUSTY")
    expect(out).toContain("1 arrival of tokens came with no cost anyone can state")
    expect(out).toContain("2 moves out of a wallet went where Candle does not follow")
    // One token in two wallets is two rows, each with its wallet.
    expect(out).toMatch(/TOKEN\s+CHAIN\s+WALLET\s+QUANTITY/)
    expect(out).toMatch(/MEME\s+solana\s+Wall…AAA1\s+6\s+.*Scalper/)
    expect(out).toMatch(/MEME\s+solana\s+Wall…BBB2\s+2\s+.*–\n/)
    // By agent: each key, then Manual, then the account total the rows sum to.
    expect(out).toContain("By agent (each key, then Manual; the rows sum to the account total)")
    expect(out).toMatch(/Scalper \(AAAAAAAA\)\s+\+\$80\.00\s+\+\$12\.00\s+\+\$92\.00\s+1\s+2/)
    expect(out).toMatch(/Manual \(web app\)\s+\+\$17\.00\s+\$0\.00\s+\+\$17\.00\s+2\s+1/)
    expect(out).toMatch(/Account total\s+\+\$97\.00\s+\+\$12\.00\s+\+\$109\.00\s+3\s+3/)
    expect(out.indexOf("By agent")).toBeLessThan(out.indexOf("Open positions"))
  })

  test("--dust lists the dust positions, marked, and drops the hidden-count note", async () => {
    const h = harness({ books: Response.json(ENGINE_BOOKS) })
    expect(await run(["pnl", "--dust"], h.deps)).toBe(0)
    const out = h.stdout.text
    expect(out).toMatch(/DUSTY \(dust\)\s+solana\s+–\s+1\s+/)
    expect(flat(out)).toContain(
      "1 open position is dust (worth under one cent): listed and marked, and counted in the figures.",
    )
    expect(out).not.toContain("hidden")
    // Counted either way: the figures do not move.
    const plain = harness({ books: Response.json(ENGINE_BOOKS) })
    await run(["pnl"], plain.deps)
    expect(out.match(/Total\s+\S+/)?.[0]).toBe(plain.stdout.text.match(/Total\s+\S+/)?.[0])
  })

  test("account scope from an API that predates A2: none of the new lines or columns", async () => {
    const h = harness()
    expect(await run(["pnl"], h.deps)).toBe(0)
    const out = h.stdout.text
    for (const text of ["Closed ", "dust", "By agent", "WALLET", "arrival", "moves out"])
      expect(out).not.toContain(text)
  })

  test("key scope: the key's share, the account's history bound, and wallet rows that sum to the total", async () => {
    const h = harness({ withProfiles: true, profile: Response.json(ENGINE_PROFILE) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    const out = h.stdout.text
    expect(out).toContain("P&L for profile scalper (key BBBBBBBB): this key's share of the account's P&L")
    expect(out).toMatch(/Total\s+\+\$9\.00/)
    expect(out).toContain("Closed 1 position (1 won, 0 lost). Money made +$9.00")
    expect(flat(out)).toContain("History is truncated: this covers the most recent 2000 of the account's ledger rows")
    expect(out).toContain("By wallet (each its own cost basis; the rows sum to the total)")
    expect(out).toMatch(/main \(Wall…AAA1\)\s+solana\s+2\s+\+\$6\.00/)
    // The pool for legs no record places in a wallet is not an address.
    expect(out).toMatch(/not placed in a wallet\s+solana\s+0\s+\+\$3\.00/)
    expect(out).not.toContain("unknown:")
  })

  test("key scope from an API that predates A2 keeps the old wording, because its figures mean the old thing", async () => {
    const older = { ...ENGINE_PROFILE, pnl: { ...ENGINE_PROFILE.pnl, totalUsd: undefined, closed: undefined } }
    const h = harness({ withProfiles: true, profile: Response.json(older) })
    expect(await run(["pnl", "--profile", "scalper"], h.deps)).toBe(0)
    expect(h.stdout.text).toContain("this key's own fills")
    expect(h.stdout.text).toContain("the most recent 2000 trades")
    expect(h.stdout.text).toContain("so the rows need not sum to the total")
  })

  test("--json passes the engine fields through untouched", async () => {
    const h = harness({ books: Response.json(ENGINE_BOOKS) })
    expect(await run(["pnl", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.byAgent).toEqual(ENGINE_BOOKS.byAgent)
    expect(doc.all.closed).toEqual(CLOSED)
    expect(doc.positions[2].dust).toBe(true)
    expect(doc.movedOutUntracked).toHaveLength(2)

    const p = harness({ withProfiles: true, profile: Response.json(ENGINE_PROFILE) })
    expect(await run(["pnl", "--profile", "scalper", "--json"], p.deps)).toBe(0)
    expect(JSON.parse(p.stdout.text).pnl.byWallet[1].wallet).toBe("unknown:solana")
  })
})

test("moved-in cost source is visible in the table and preserved in JSON", async () => {
  const position = {
    ...BOOKS.positions[0],
    transferredIn: true,
    basisSource: "chain",
    basisComplete: false,
    movedInFromWallet: "SenderWallet11111111111111111111111111111",
  }
  const body = { ...BOOKS, positions: [position] }
  const table = harness({ books: Response.json(body) })
  expect(await run(["pnl"], table.deps)).toBe(0)
  expect(table.stdout.text).toContain("COST SOURCE")
  expect(table.stdout.text).toContain("Moved in from")
  expect(table.stdout.text).toContain("chain (partial)")
  const json = harness({ books: Response.json(body) })
  expect(await run(["pnl", "--json"], json.deps)).toBe(0)
  expect(JSON.parse(json.stdout.text).positions[0]).toEqual(position)
})
