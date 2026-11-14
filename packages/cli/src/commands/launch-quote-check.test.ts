import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const STOCK = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"
const MINT = "So11111111111111111111111111111111111111112"
const stock = (requested = "NVDA") => ({
  requested,
  ok: true,
  chain: "hood",
  address: STOCK,
  symbol: "NVDA",
  decimals: 18,
  classification: "stock",
  executionEnabled: false,
  checks: [
    { check: "issuer", status: "pass", message: "Authenticated factory membership" },
    { check: "liquidity", status: "skip", message: "Stock quote admitted by issuer" },
    { check: "price", status: "pass", message: "Two fresh prices agree" },
  ],
  economics: {
    kind: "derived",
    economicsDigest: `0x${"ab".repeat(32)}`,
    thresholdRaw: "74263600000000000000",
    startFdv: 20,
    bondingFdv: 400,
    priceUsd: 100,
    raiseUsd: 7426.36,
    curve: { sqrtStartPrice: "18446744073709551616", seg0Liquidity: "123456789012345678901234567890" },
  },
  disclosure:
    "This token is priced in NVDA. Its issuer can pause, block or burn NVDA; if it does, trading and graduation stop until it is lifted.",
})

function fixture(quote: unknown, walletsWork = true) {
  const calls: URL[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    env: { CANDLE_API_KEY: "test-key", CANDLE_CONFIG_DIR: "/tmp/candle-launch-quote-check-test" },
    stdout,
    stderr,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url)
      expect(url.pathname).toBe("/api/v1/launch/preflight")
      expect(init?.method ?? "GET").toBe("GET")
      return Response.json({
        success: true,
        key: {
          keyPrefix: "cndl_test_check",
          scopes: ["launch:write"],
          tier: "max",
          selfLaunch: true,
          embeddedWalletPermission: "denied",
        },
        switches: { headlessLaunch: true, agentTrading: true, teeLaunchBuys: false },
        wallets: walletsWork
          ? [
              {
                id: "hood-wallet",
                address: `0x${"12".repeat(20)}`,
                chain: "evm",
                label: "hood",
                active: true,
                allowLaunch: true,
              },
            ]
          : [],
        ...(quote === undefined ? {} : { quote }),
      })
    }) as typeof fetch,
  })
  return { deps, stdout, stderr, calls }
}

describe("launch --quote --check", () => {
  test("stock check prints admission, raw curve figures, raise and disclosure without any build or upload", async () => {
    const f = fixture(stock())
    expect(
      await run(
        ["launch", "--quote", "NVDA", "--check", "--image", "./missing.png", "--banner", "./missing-banner.png"],
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.searchParams.get("quote")).toBe("NVDA")
    expect(f.stdout.text).toContain("Quote NVDA")
    expect(f.stdout.text).toContain("admitted")
    expect(f.stdout.text).toContain("SKIP liquidity")
    expect(f.stdout.text).toContain("123456789012345678901234567890")
    expect(f.stdout.text).toContain("Graduation raise: 74.2636 NVDA ($7426.36)")
    expect(f.stdout.text).toContain("Its issuer can pause, block or burn NVDA")
    expect(f.stdout.text).toContain("execution is not enabled")
  })

  test("a thin quote returns exit 1 and the named refusal, even with a working wallet", async () => {
    const f = fixture({
      ...stock("THIN"),
      ok: false,
      economics: undefined,
      classification: "ordinary",
      disclosure: null,
      checks: [{ check: "liquidity", status: "refuse", code: "QUOTE_TOO_THIN", message: "Insufficient DEX liquidity" }],
    })
    expect(await run(["launch", "--quote", "THIN", "--check", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      works: false,
      walletWorks: true,
      quote: { ok: false, checks: [{ code: "QUOTE_TOO_THIN" }] },
    })
    expect(f.calls).toHaveLength(1)
  })

  test("JSON is one value, preserves integer precision, and includes the disclosure", async () => {
    const f = fixture(stock())
    expect(await run(["launch", "--quote", "NVDA", "--check", "--json"], f.deps)).toBe(0)
    const out = JSON.parse(f.stdout.text)
    expect(out).toMatchObject({ requestedChain: "hood", quote: stock() })
    expect(out.quote.economics.thresholdRaw).toBe("74263600000000000000")
    expect(f.stdout.text.trim().split("\n")).toHaveLength(1)
  })

  test("a quote admission never overrides a refused wallet", async () => {
    const f = fixture(stock(), false)
    expect(await run(["launch", "--quote", "NVDA", "--check", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ works: false, walletWorks: false, quote: { ok: true } })
  })

  test("an older server cannot silently pass an unchecked quote", async () => {
    const f = fixture(undefined)
    expect(await run(["launch", "--quote", "NVDA", "--check", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("QUOTE_CHECK_UNAVAILABLE")
    expect(f.calls).toHaveLength(1)
  })

  test("a misbound result or a contradictory admission fails closed", async () => {
    for (const result of [
      stock("OTHER"),
      { ...stock(), checks: [{ check: "pause", status: "refuse", code: "QUOTE_PAUSED", message: "Paused" }] },
    ]) {
      const f = fixture(result)
      expect(await run(["launch", "--quote", "NVDA", "--check"], f.deps)).toBe(1)
    }
  })

  test("addresses retain their case, and economics selections go to the server", async () => {
    const f = fixture({ ...stock(MINT), chain: "solana", address: MINT })
    await run(["launch", "--quote", MINT, "--check", "--mode", "exclusive", "--staker-allocation-bps", "100"], f.deps)
    expect(f.calls[0]?.searchParams.get("quote")).toBe(MINT)
    expect(f.calls[0]?.searchParams.get("chain")).toBe("solana")
    expect(f.calls[0]?.searchParams.get("mode")).toBe("exclusive")
    expect(f.calls[0]?.searchParams.get("stakerAllocationBps")).toBe("100")
  })

  test("conflicting selectors and chain hints fail before any request", async () => {
    for (const flags of [
      ["--quote-asset", "eth"],
      ["--wallet", "0x1111111111111111111111111111111111111111"],
    ]) {
      const f = fixture(stock())
      expect(await run(["launch", "--quote", MINT, "--check", ...flags], f.deps)).not.toBe(0)
      expect(f.calls).toEqual([])
    }
  })

  test("new quotes cannot enter a live launch or publish an image", async () => {
    const f = fixture(stock())
    expect(
      await run(
        [
          "launch",
          "--quote",
          "NVDA",
          "--name",
          "Demo",
          "--symbol",
          "DEMO",
          "--image",
          "./missing.png",
          "--wallet",
          "hood",
          "--json",
        ],
        f.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("QUOTE_LAUNCH_UNAVAILABLE")
    expect(f.calls).toEqual([])
  })

  test("blank --quote is a usage error", async () => {
    const f = fixture(stock())
    expect(await run(["launch", "--quote", " ", "--check"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})
