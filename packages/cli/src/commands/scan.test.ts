import { describe, expect, test } from "bun:test"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { displayWidth } from "../presentation"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"
import { chainOfAddress } from "./scan"

const mint = "11111111111111111111111111111111"
const hoodToken = `0x${"a".repeat(40)}`

const fact = (display: string, value: number) => ({
  value,
  display,
  state: "ok",
  source: "Helius",
  as_of: "2026-10-28T12:00:00.000Z",
  basis: "5 of 20 top wallet holders",
  note: null,
})
const unknown = {
  value: null,
  display: "–",
  state: "unavailable",
  source: null,
  as_of: null,
  basis: null,
  note: "fill is off",
}

function cardBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    card: {
      chain: "solana",
      mint,
      generatedAt: Date.UTC(2026, 9, 28, 12, 0),
      identity: { name: "Cuzco the Goat", symbol: "CUZCO", launchpad: "pump.fun", isCandle: false },
      market: {
        priceUsd: 0.000018,
        marketCapUsd: 18200,
        liquidityUsd: 9100,
        change5mPct: -14,
        volume5mUsd: 5200,
        buys5m: 31,
        sells5m: 29,
        updatedAt: Date.UTC(2026, 9, 28, 11, 59),
      },
      ath: {
        marketCapUsd: 35500,
        at: Date.UTC(2026, 9, 27),
        precision: "day",
        basis: "price times current supply (FDV)",
      },
      forensics: { state: "not_covered", coverage: { covered: false } },
      events: {
        state: "ok",
        windowMinutes: 60,
        trackedBuys: 2,
        trackedSells: 1,
        signals: 1,
        callouts: 0,
        names: ["Starlight"],
      },
      hacc: {
        state: "ok",
        facts: {
          fields: {
            bundles: unknown,
            snipers: fact("4%", 4),
            insiders: unknown,
            fresh_1d: fact("5%", 5),
            fresh_7d: fact("17%", 17),
            avg_wallet_age: fact("16w", 112),
          },
        },
      },
      sameName: {
        state: "found",
        source: "dexscreener",
        display: "LaunchLab CUZCO leads",
        leader: { ticker: "CUZCO", name: "Cuzco", venue: "LaunchLab" },
        subject: null,
        trailing: true,
        others: [],
        detail: null,
      },
      sources: { market: "candle feed", ath: "birdeye daily bars since launch" },
      links: { token: `https://candle.tv/token/${mint}` },
      ...overrides,
    },
  }
}

function setup(body: unknown, status = 200, env: Record<string, string> = { CANDLE_PLAIN: "1" }) {
  const stdout = createCapture()
  const stderr = createCapture()
  const seen: Array<{ url: string; headers: Headers }> = []
  const deps = createTestDeps({
    stdout,
    stderr,
    env,
    fetch: (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) })
      return jsonResponse(status, body)
    }) as unknown as typeof fetch,
  })
  return { deps, stdout, stderr, seen }
}

describe("candle scan", () => {
  test("prints the card: heading, market, all-time high, facts, tracked line, same name and page", async () => {
    const f = setup(cardBody())
    expect(await run(["scan", mint], f.deps)).toBe(0)
    expect(new URL(f.seen[0]?.url ?? "").pathname).toBe(`/api/v1/tokens/solana/${mint}/card`)
    const text = humanText(f.stdout.text)
    expect(f.stdout.text.startsWith("CUZCO · Cuzco the Goat · Solana · pump.fun\n")).toBe(true)
    // The contract is a value the reader pastes elsewhere: printed whole, never shortened.
    expect(f.stdout.text).toContain(mint)
    expect(text).toContain("Price $0.000018")
    expect(text).toContain("Market cap $18,200.00")
    expect(text).toContain("All-time high $35,500.00 on Oct 27 (daily high, FDV)")
    expect(text).toContain("5m change -14%")
    expect(text).toContain("Liquidity $9,100.00")
    expect(text).toContain("Buys / sells 5m 31 / 29")
    expect(text).toContain("Snipers 4%")
    expect(text).toContain("Fresh 1d / 7d 5% / 17%")
    expect(text).toContain("Mean wallet age 16w")
    expect(text).toContain("Tracked, 1h 2 bought, 1 sold · 1 signal · 0 callouts (Starlight)")
    expect(text).toContain("Same name LaunchLab CUZCO leads (this token trails)")
    expect(text).toContain("not covered for this token (bundles, snipers and insiders are unknown, not clean)")
    expect(text).toContain(`Candle page https://candle.tv/token/${mint}`)
    expect(text).toContain("Sources market candle feed ath birdeye daily bars since launch")
    expect(f.stderr.text).toBe("")
  })

  test("a field with no source prints the missing mark, never a guess or a zero", async () => {
    const f = setup(
      cardBody({
        identity: { name: null, symbol: null, launchpad: null, isCandle: null },
        market: {
          priceUsd: null,
          marketCapUsd: null,
          liquidityUsd: null,
          change5mPct: null,
          volume5mUsd: null,
          buys5m: null,
          sells5m: null,
          updatedAt: null,
        },
        ath: null,
        forensics: { state: "unavailable" },
        events: { state: "off" },
        hacc: { state: "unavailable" },
        sameName: { state: "off" },
      }),
    )
    expect(await run(["scan", mint], f.deps)).toBe(0)
    // No ticker or name: the heading carries the short address, never a blank.
    expect(f.stdout.text.startsWith("1111…1111 · Solana\n")).toBe(true)
    const lines = f.stdout.text.split("\n")
    for (const label of [
      "Price",
      "Market cap",
      "All-time high",
      "5m change",
      "Liquidity",
      "Volume 5m",
      "Buys / sells 5m",
      "Bundles",
      "Snipers",
      "Insiders",
      "Fresh 1d / 7d",
      "Mean wallet age",
      "Market as of",
    ]) {
      const line = lines.find((l) => l.trimStart().startsWith(`${label}  `))
      expect([label, line?.trimEnd().endsWith("  -")]).toEqual([label, true])
    }
    const text = humanText(f.stdout.text)
    expect(text).toContain("Tracked, 1h - (off)")
    expect(text).toContain("Same name - (off)")
    expect(text).toContain("Forensics - (unavailable)")
    expect(text).not.toContain("$0.00")
  })

  test("a styled terminal uses the en dash for a missing field", async () => {
    const f = setup(cardBody({ ath: null }), 200, { TERM: "xterm" })
    f.deps.isTTY.stdout = true
    expect(await run(["scan", mint], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain("All-time high –")
  })

  test("a Hood address is read as Hood without --chain, and the forensics hint names the chain", async () => {
    const f = setup(cardBody({ chain: "hood", mint: hoodToken, forensics: { state: "ok", report: {} } }))
    expect(await run(["scan", hoodToken], f.deps)).toBe(0)
    expect(new URL(f.seen[0]?.url ?? "").pathname).toBe(`/api/v1/tokens/hood/${hoodToken}/card`)
    const text = humanText(f.stdout.text)
    expect(text).toContain("CUZCO · Cuzco the Goat · Hood · pump.fun")
    expect(text).toContain(`candle token forensics ${hoodToken} --chain hood`)
  })

  test("needs no key and sends none, even when one is configured", async () => {
    const f = setup(cardBody(), 200, { CANDLE_PLAIN: "1", CANDLE_API_KEY: "test-key" })
    expect(await run(["scan", mint], f.deps)).toBe(0)
    expect(f.seen[0]?.headers.has("x-api-key")).toBe(false)
    expect(f.seen[0]?.headers.has("authorization")).toBe(false)
  })

  test("--json prints one value with the route's card, untouched", async () => {
    const body = cardBody()
    const f = setup(body)
    expect(await run(["scan", mint, "--json"], f.deps)).toBe(0)
    expect(f.stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(f.stdout.text)).toEqual({ ok: true, data: { card: body.card } })
    expect(f.stderr.text).toBe("")
  })

  test("fits a 40 column terminal without clipping the contract", async () => {
    const f = setup(cardBody())
    f.deps.columns = { stdout: 40, stderr: 80 }
    expect(await run(["scan", mint], f.deps)).toBe(0)
    for (const line of f.stdout.text.split("\n")) {
      if (line.includes(mint) || line.includes("https://")) continue
      expect([line, displayWidth(line) <= 40]).toEqual([line, true])
    }
    expect(f.stdout.text).toContain(mint)
  })

  test("usage failures exit 2 and never fetch; another chain's address names the two chains", async () => {
    for (const argv of [
      ["scan"],
      ["scan", mint, "extra"],
      ["scan", mint, "--chain", "ethereum"],
      ["scan", "not-an-address"],
      ["scan", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"],
    ] as string[][]) {
      const f = setup(cardBody())
      expect([argv.join(" "), await run(argv, f.deps)]).toEqual([argv.join(" "), 2])
      expect(f.seen).toHaveLength(0)
      expect(f.stderr.text).toContain("Usage")
    }
    const other = setup(cardBody())
    expect(await run(["scan", "not-an-address"], other.deps)).toBe(2)
    expect(humanText(other.stderr.text)).toContain("Candle trades Solana and Hood today")
  })

  test("an explicit --chain still validates the address locally: zero requests, exit 2, human and JSON", async () => {
    const cases: string[][] = [
      ["scan", "not-an-address", "--chain", "solana"],
      ["scan", "0x1234", "--chain", "hood"],
      ["scan", hoodToken, "--chain", "solana"],
      ["scan", mint, "--chain", "hood"],
    ]
    for (const base of cases) {
      for (const json of [false, true]) {
        const argv = json ? [...base, "--json"] : base
        const f = setup(cardBody())
        expect([argv.join(" "), await run(argv, f.deps)]).toEqual([argv.join(" "), 2])
        expect(f.seen).toHaveLength(0)
        expect(f.stderr.text + f.stdout.text).toContain("Solana and Hood")
      }
    }
    const mismatch = setup(cardBody())
    await run(["scan", hoodToken, "--chain", "solana"], mismatch.deps)
    expect(humanText(mismatch.stderr.text)).toContain("That address is a Hood contract, not a Solana one")
  })

  test("a valid address with the matching explicit --chain is read", async () => {
    const s = setup(cardBody())
    expect(await run(["scan", mint, "--chain", "solana"], s.deps)).toBe(0)
    expect(new URL(s.seen[0]?.url ?? "").pathname).toBe(`/api/v1/tokens/solana/${mint}/card`)
    const h = setup(cardBody({ chain: "hood", mint: hoodToken }))
    expect(await run(["scan", hoodToken, "--chain", "hood", "--json"], h.deps)).toBe(0)
    expect(new URL(h.seen[0]?.url ?? "").pathname).toBe(`/api/v1/tokens/hood/${hoodToken}/card`)
  })

  test("the switched-off route is a failure with its code; JSON stays one value", async () => {
    const off = {
      success: false,
      error: { code: "TOKEN_CARD_DISABLED", message: "The token card is switched off.", retryable: false },
    }
    const f = setup(off, 503)
    expect(await run(["scan", mint], f.deps)).toBe(1)
    expect(humanText(f.stderr.text)).toContain("The token card is switched off.")
    expect(f.stdout.text).toBe("")
    const j = setup(off, 503)
    expect(await run(["scan", mint, "--json"], j.deps)).toBe(1)
    expect(j.stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "TOKEN_CARD_DISABLED" })
    expect(j.stderr.text).toBe("")
  })

  test("an answer that is not a card is BAD_RESPONSE, not a blank card", async () => {
    const f = setup({ success: true, card: { mint } })
    expect(await run(["scan", mint, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "BAD_RESPONSE" })
  })

  test("chainOfAddress reads Hood from 0x and Solana from base58, and nothing else", () => {
    expect(chainOfAddress(hoodToken)).toBe("hood")
    expect(chainOfAddress("So11111111111111111111111111111111111111112")).toBe("solana")
    expect(chainOfAddress("0x1234")).toBeNull()
    expect(chainOfAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBeNull()
  })
})
