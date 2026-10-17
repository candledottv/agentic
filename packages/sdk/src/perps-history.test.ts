import { describe, expect, test } from "bun:test"
import {
  PERPS_HISTORY_DEFAULT_WINDOW_MS,
  PERPS_HISTORY_INFO_URLS,
  type PerpsFillsPage,
  type PerpsFundingPage,
  PerpsHistoryError,
  type PerpsHistoryFetch,
  perpsHistoryLines,
  perpsHistoryMoney,
  readPerpsHistoryPage,
} from "./perps-history"

const ADDRESS = "0x00000000000000000000000000000000000000aa"
const NOW = 1_800_000_000_000
const UNIVERSE = [
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
  { name: "OLDCOIN", szDecimals: 0, maxLeverage: 3, isDelisted: true },
]
/** Hyperliquid's `metaAndAssetCtxs`, which the shared markets reader (Spec B) reads. */
const MARKETS = [{ universe: UNIVERSE }, UNIVERSE.map(() => ({ markPx: "1", midPx: "1", openInterest: "1" }))]

function fill(time: number, tid: number, extra: Record<string, unknown> = {}) {
  return {
    coin: "BTC",
    px: "60000.5",
    sz: "0.01",
    side: "B",
    time,
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0.0",
    hash: `0x${tid.toString(16).padStart(64, "0")}`,
    oid: 1000 + tid,
    crossed: true,
    fee: "0.27",
    tid,
    feeToken: "USDC",
    ...extra,
  }
}

function funding(time: number, hash: string, coin = "BTC", usdc = "-1.234567") {
  return { time, hash, delta: { type: "funding", coin, usdc, szi: "0.5", fundingRate: "0.0000125", nSamples: null } }
}

interface Call {
  url: string
  body: Record<string, unknown>
}

/** A fake `/info`: `metaAndAssetCtxs` answers the universe; history types answer `history(body)`. */
function venue(history: (body: Record<string, unknown>) => unknown, opts: { meta?: unknown } = {}) {
  const calls: Call[] = []
  const fetch: PerpsHistoryFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, body })
    const answer = body.type === "metaAndAssetCtxs" ? (opts.meta ?? MARKETS) : history(body)
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return { fetch, calls, historyCalls: () => calls.filter((c) => c.body.type !== "metaAndAssetCtxs") }
}

/** Upstream that serves `rows` (sorted by time) from startTime, at most `cap` per response. */
function server(rows: { time: number }[], cap: number) {
  return (body: Record<string, unknown>) => {
    const start = body.startTime as number
    const end = body.endTime as number
    return rows.filter((r) => r.time >= start && r.time <= end).slice(0, cap)
  }
}

const read = (
  kind: "fills" | "funding",
  fetch: PerpsHistoryFetch,
  options: Parameters<typeof readPerpsHistoryPage>[0]["options"] = {},
) =>
  readPerpsHistoryPage({ kind, network: "mainnet", walletId: "w1", address: ADDRESS, options, fetch, now: () => NOW })

describe("window and validation", () => {
  test("default window is the seven days before the first call's clock, fixed into the cursor", async () => {
    const v = venue(server([fill(NOW - 10, 1), fill(NOW - 5, 2)], 2000))
    const page = (await read("fills", v.fetch, { limit: 1 })) as PerpsFillsPage
    expect(page.startTime).toBe(NOW - PERPS_HISTORY_DEFAULT_WINDOW_MS)
    expect(page.endTime).toBe(NOW)
    expect(v.historyCalls()[0]?.body).toEqual({
      type: "userFillsByTime",
      user: ADDRESS,
      startTime: NOW - PERPS_HISTORY_DEFAULT_WINDOW_MS,
      endTime: NOW,
      aggregateByTime: false,
    })
    expect(v.calls.every((c) => c.url === PERPS_HISTORY_INFO_URLS.mainnet)).toBe(true)
    // A later page keeps the first call's end even though the clock moved.
    const next = (await readPerpsHistoryPage({
      kind: "fills",
      network: "mainnet",
      walletId: "w1",
      address: ADDRESS,
      options: { cursor: page.nextCursor as string },
      fetch: v.fetch,
      now: () => NOW + 60_000,
    })) as PerpsFillsPage
    expect(next.endTime).toBe(NOW)
    expect(next.fills.map((f) => f.tid)).toEqual([2])
  })

  for (const [name, options, field] of [
    ["negative start", { startTime: -1 }, "startTime"],
    ["fractional end", { endTime: 1.5 }, "endTime"],
    ["start after end", { startTime: 10, endTime: 5 }, "startTime"],
    ["limit zero", { limit: 0 }, "limit"],
    ["limit over the fills maximum", { limit: 2001 }, "limit"],
    ["garbage cursor", { cursor: "nope" }, "cursor"],
    ["tampered cursor", { cursor: "ph1.e30" }, "cursor"],
  ] as const) {
    test(`${name} fails before any I/O`, async () => {
      const v = venue(() => [])
      const err = await read("fills", v.fetch, options as never).catch((e) => e)
      expect(err).toBeInstanceOf(PerpsHistoryError)
      expect(err.code).toBe("VALIDATION_FAILED")
      expect(err.extra.field).toBe(field)
      expect(v.calls).toHaveLength(0)
    })
  }

  test("funding's maximum page is 500", async () => {
    const v = venue(() => [])
    const err = await read("funding", v.fetch, { limit: 501 }).catch((e) => e)
    expect(err.code).toBe("VALIDATION_FAILED")
    expect((await read("funding", v.fetch, { limit: 500 })).success).toBe(true)
  })

  test("a cursor is refused for another kind, wallet, network, window or page size", async () => {
    const v = venue(server([fill(NOW - 10, 1), fill(NOW - 5, 2)], 2000))
    const page = (await read("fills", v.fetch, { limit: 1 })) as PerpsFillsPage
    const cursor = page.nextCursor as string
    const calls = v.calls.length
    const refusals = [
      read("funding", v.fetch, { cursor }),
      readPerpsHistoryPage({
        kind: "fills",
        network: "mainnet",
        walletId: "w2",
        address: "0x00000000000000000000000000000000000000bb",
        options: { cursor },
        fetch: v.fetch,
        now: () => NOW,
      }),
      readPerpsHistoryPage({
        kind: "fills",
        network: "testnet",
        walletId: "w1",
        address: ADDRESS,
        options: { cursor },
        fetch: v.fetch,
        now: () => NOW,
      }),
      read("fills", v.fetch, { cursor, limit: 2 }),
      read("fills", v.fetch, { cursor, endTime: NOW - 1 }),
    ]
    for (const r of refusals) expect((await r.catch((e) => e)).code).toBe("VALIDATION_FAILED")
    expect(v.calls.length).toBe(calls)
  })
})

describe("rows", () => {
  test("empty history is an empty array, still with the retention disclosure", async () => {
    const v = venue(() => [])
    const page = (await read("fills", v.fetch)) as PerpsFillsPage
    expect(page.fills).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(page.hasMore).toBe(false)
    expect(page.truncated).toBe(false)
    expect(page.warnings.map((w) => w.code)).toEqual(["PERPS_HISTORY_RETENTION_LIMIT"])
    expect(page.source).toBe("hyperliquid")
    expect(page.readAt).toBe(NOW)
  })

  test("spot and HIP-3 rows are dropped and do not fill the page; delisted main perps are kept", async () => {
    const rows = [
      fill(1, 1, { coin: "@107" }),
      fill(2, 2, { coin: "PURR/USDC" }),
      fill(3, 3, { coin: "xyz:TSLA" }),
      fill(4, 4, { coin: "OLDCOIN" }),
      fill(5, 5),
    ]
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 10, limit: 2 })) as PerpsFillsPage
    expect(page.fills.map((f) => f.coin)).toEqual(["OLDCOIN", "BTC"])
    expect(page.nextCursor).toBeNull()
  })

  test("decimal strings are kept exactly, builder fee stays inside fee", async () => {
    const v = venue(server([fill(1, 1, { closedPnl: "-12.3456789", fee: "0.501", builderFee: "0.1" })], 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 10 })) as PerpsFillsPage
    expect(page.fills[0]?.closedPnl).toBe("-12.3456789")
    expect(page.fills[0]?.fee).toBe("0.501")
    expect(page.fills[0]?.builderFee).toBe("0.1")
    const lines = perpsHistoryLines(page, (c) => c).join("\n")
    expect(lines).toContain("closed P&L -12.35 (gross), fee 0.50 USDC, builder fee 0.10 (in fee)")
    expect(lines).toContain("not Candle's ledger")
    expect(lines).toContain("1970-01-01T00:00:00Z to 1970-01-01T00:00:00.010Z UTC")
  })

  test("funding stays signed and is labelled paid or received", async () => {
    const rows = [funding(1, "0xa", "BTC", "-1.234567"), funding(2, "0xb", "ETH", "0.5")]
    const v = venue(server(rows, 500))
    const page = (await read("funding", v.fetch, { startTime: 0, endTime: 10 })) as PerpsFundingPage
    expect(page.funding.map((f) => f.delta.usdc)).toEqual(["-1.234567", "0.5"])
    expect(v.historyCalls()[0]?.body).toEqual({ type: "userFunding", user: ADDRESS, startTime: 0, endTime: 10 })
    const lines = perpsHistoryLines(page, (c) => c).join("\n")
    expect(lines).toContain("BTC paid 1.23 USDC")
    expect(lines).toContain("ETH received 0.50 USDC")
    expect(page.warnings).toEqual([])
  })

  test("same-millisecond fills and simultaneous funding payments are all kept; exact duplicates once", async () => {
    const rows = [fill(5, 1), fill(5, 2), fill(5, 2), fill(5, 3, { oid: 9 })]
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 10 })) as PerpsFillsPage
    expect(page.fills.map((f) => f.tid)).toEqual([1, 2, 3])
    const fv = venue(server([funding(5, "0xa", "BTC"), funding(5, "0xa", "ETH"), funding(5, "0xa", "BTC")], 500))
    const fpage = (await read("funding", fv.fetch, { startTime: 0, endTime: 10 })) as PerpsFundingPage
    expect(fpage.funding.map((f) => f.delta.coin)).toEqual(["BTC", "ETH"])
  })

  test("rows are sorted by time even when the venue answers out of order", async () => {
    const v = venue(() => [fill(3, 3), fill(1, 1), fill(2, 2)])
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 10 })) as PerpsFillsPage
    expect(page.fills.map((f) => f.tid)).toEqual([1, 2, 3])
  })
})

describe("paging", () => {
  test("a page smaller than the response keeps the rest: every row arrives exactly once", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => fill(100 + Math.floor(i / 3), i + 1))
    const v = venue(server(rows, 2000))
    const seen: number[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const page = (await read("fills", v.fetch, {
        startTime: 0,
        endTime: 1000,
        limit: 4,
        ...(cursor ? { cursor } : {}),
      })) as PerpsFillsPage
      seen.push(...page.fills.map((f) => f.tid))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(rows.map((r) => r.tid))
  })

  test("at the 2,000-fill upstream maximum it continues from the last timestamp, inclusively", async () => {
    // 2,000 fills at t=1..2000, then 3 more at t=2000 and one at t=2001: the second read must
    // start at 2000 again and skip only the one already emitted there.
    const rows = [
      ...Array.from({ length: 2000 }, (_, i) => fill(i + 1, i + 1)),
      fill(2000, 5001),
      fill(2000, 5002),
      fill(2000, 5003),
      fill(2001, 6000),
    ]
    rows.sort((a, b) => a.time - b.time || a.tid - b.tid)
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 5000, limit: 2000 })) as PerpsFillsPage
    expect(page.fills).toHaveLength(2000)
    const next = (await read("fills", v.fetch, { cursor: page.nextCursor as string })) as PerpsFillsPage
    const tids = [...page.fills, ...next.fills].map((f) => f.tid)
    expect(new Set(tids).size).toBe(rows.length)
    expect(next.nextCursor).toBeNull()
    expect(v.historyCalls().map((c) => c.body.startTime)).toEqual([0, 2000])
  })

  test("at the 500-row funding maximum it reads on rather than assuming completeness", async () => {
    const rows = Array.from({ length: 700 }, (_, i) => funding(i + 1, `0x${i}`))
    const v = venue(server(rows, 500))
    const page = (await read("funding", v.fetch, { startTime: 0, endTime: 5000, limit: 500 })) as PerpsFundingPage
    const next = (await read("funding", v.fetch, { cursor: page.nextCursor as string })) as PerpsFundingPage
    expect(page.funding.length + next.funding.length).toBe(700)
    expect(next.nextCursor).toBeNull()
  })

  test("a full response stuck on one millisecond stops with the boundary limit, never time + 1", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => fill(7, i + 1))
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 7, endTime: 100, limit: 2000 })) as PerpsFillsPage
    expect(page.fills).toHaveLength(2000)
    expect(page.truncated).toBe(true)
    expect(page.nextCursor).toBeNull()
    expect(page.warnings.map((w) => w.code)).toContain("PERPS_HISTORY_BOUNDARY_LIMIT")
    expect(v.historyCalls()).toHaveLength(1)
    expect(v.historyCalls()[0]?.body.startTime).toBe(7)
  })

  test("a later read that cannot leave its boundary millisecond also stops there", async () => {
    const rows = [fill(1, 1), ...Array.from({ length: 2100 }, (_, i) => fill(7, i + 2))]
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 100, limit: 10 })) as PerpsFillsPage
    expect(page.fills).toHaveLength(10)
    expect(page.fills[0]?.tid).toBe(1)
    const next = (await read("fills", v.fetch, { cursor: page.nextCursor as string, limit: 10 })) as PerpsFillsPage
    expect(next.fills).toHaveLength(10)
    // Draining: the cursor stays on t=7 and stops at the boundary once a full read cannot advance.
    let cursor = next.nextCursor
    let last = next
    let pages = 0
    while (cursor && pages < 300) {
      last = (await read("fills", v.fetch, { cursor, limit: 10 })) as PerpsFillsPage
      cursor = last.nextCursor
      pages++
    }
    expect(last.truncated).toBe(true)
    expect(last.warnings.map((w) => w.code)).toContain("PERPS_HISTORY_BOUNDARY_LIMIT")
    expect(v.historyCalls().every((c) => c.body.startTime === 0 || c.body.startTime === 7)).toBe(true)
  })

  test("ten upstream reads per call, then a resumable cursor with the page-budget warning", async () => {
    // 2,000-row responses that are all spot fills: the page never fills, the window keeps going.
    const rows = Array.from({ length: 30_000 }, (_, i) => fill(i + 1, i + 1, { coin: "@1" }))
    const v = venue(server(rows, 2000))
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 100_000 })) as PerpsFillsPage
    // Each read after the first re-reads its boundary row, so the sixth read crosses 10,000 distinct
    // fills, the scan ceiling, before the ten-read budget.
    expect(v.historyCalls()).toHaveLength(6)
    expect(page.warnings.map((w) => w.code)).toContain("PERPS_HISTORY_RETENTION_LIMIT")
    expect(page.truncated).toBe(true)
    expect(page.nextCursor).toBeNull()

    const fundingRows = Array.from({ length: 6000 }, (_, i) => funding(i + 1, `0x${i}`, "@spot"))
    const fv = venue(server(fundingRows, 500))
    const fpage = (await read("funding", fv.fetch, { startTime: 0, endTime: 100_000 })) as PerpsFundingPage
    expect(fv.historyCalls()).toHaveLength(10)
    expect(fpage.funding).toEqual([])
    expect(fpage.warnings.map((w) => w.code)).toEqual(["PERPS_HISTORY_PAGE_BUDGET"])
    expect(fpage.truncated).toBe(false)
    expect(fpage.hasMore).toBe(true)
    const resumed = (await read("funding", fv.fetch, { cursor: fpage.nextCursor as string })) as PerpsFundingPage
    // Resumes from the last consumed timestamp (each read re-reads its one boundary row).
    expect(fv.historyCalls()[10]?.body.startTime).toBe(4991)
    expect(resumed.funding).toEqual([])
  })

  test("the fill scan budget is carried across a cursor chain", async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => fill(i + 1, i + 1))
    const v = venue(server(rows, 2000))
    let total = 0
    let cursor: string | undefined
    let last: PerpsFillsPage | undefined
    for (let i = 0; i < 10; i++) {
      last = (await read("fills", v.fetch, {
        startTime: 0,
        endTime: 100_000,
        limit: 2000,
        ...(cursor ? { cursor } : {}),
      })) as PerpsFillsPage
      total += last.fills.length
      if (!last.nextCursor) break
      cursor = last.nextCursor
    }
    expect(total).toBe(10_000)
    expect(last?.truncated).toBe(true)
    expect(last?.warnings.map((w) => w.code)).toEqual(["PERPS_HISTORY_RETENTION_LIMIT"])
  })
})

describe("upstream failures are errors, not empty success", () => {
  test("429 carries Retry-After; the caller's cursor still works afterwards", async () => {
    let limited = false
    const rows = [fill(1, 1), fill(2, 2)]
    const v = venue((body) =>
      limited ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } }) : server(rows, 2000)(body),
    )
    const page = (await read("fills", v.fetch, { startTime: 0, endTime: 10, limit: 1 })) as PerpsFillsPage
    limited = true
    const err = await read("fills", v.fetch, { cursor: page.nextCursor as string }).catch((e) => e)
    expect(err.code).toBe("PERPS_UNAVAILABLE")
    expect(err.extra.retryAfterMs).toBe(7000)
    expect(err.extra.retryable).toBe(true)
    limited = false
    const retried = (await read("fills", v.fetch, { cursor: page.nextCursor as string })) as PerpsFillsPage
    expect(retried.fills.map((f) => f.tid)).toEqual([2])
  })

  test("a timeout or network failure is PERPS_UNAVAILABLE", async () => {
    const markets = venue(() => [])
    const fetch: PerpsHistoryFetch = async (url, init) => {
      if (JSON.parse(String(init?.body)).type === "metaAndAssetCtxs") return markets.fetch(url, init)
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    }
    const err = await read("fills", fetch).catch((e) => e)
    expect(err.code).toBe("PERPS_UNAVAILABLE")
    expect(err.message).toContain("in time")
    // The market list read failing the same way is the same error.
    const down: PerpsHistoryFetch = async () => {
      throw new Error("socket hang up")
    }
    expect((await read("funding", down).catch((e) => e)).code).toBe("PERPS_UNAVAILABLE")
  })

  test("malformed rows, a non-array answer and an unreadable market list all fail", async () => {
    for (const v of [
      venue(() => [{ coin: "BTC", time: 1 }]),
      venue(() => ({ error: "x" })),
      venue(() => [funding(1, "0xa")].map((f) => ({ ...f, delta: { coin: "BTC", usdc: 1 } }))),
      venue(() => [], { meta: [{ universe: [] }, []] }),
      venue(() => [], { meta: "nope" }),
      venue(() => [], { meta: [{ universe: [{ name: "BTC" }] }, []] }),
    ]) {
      const fillsErr = await read("fills", v.fetch).catch((e) => e)
      const fundingErr = await read("funding", v.fetch).catch((e) => e)
      expect([fillsErr.code, fundingErr.code]).toContain("PERPS_UNAVAILABLE")
    }
  })

  test("a non-JSON body is PERPS_UNAVAILABLE", async () => {
    const fetch: PerpsHistoryFetch = async () => new Response("<html>", { status: 200 })
    expect((await read("fills", fetch).catch((e) => e)).code).toBe("PERPS_UNAVAILABLE")
  })
})

test("money renders to two decimals with the sign kept", () => {
  expect(perpsHistoryMoney("1.005")).toBe("1.01")
  expect(perpsHistoryMoney("-0.001")).toBe("0.00")
  expect(perpsHistoryMoney("-12.344")).toBe("-12.34")
  expect(perpsHistoryMoney("7")).toBe("7.00")
  expect(perpsHistoryMoney(undefined)).toBe("?")
})
