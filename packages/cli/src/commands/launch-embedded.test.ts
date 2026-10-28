import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const EMBEDDED = "11111111111111111111111111111111"
const EVM = "0x1111111111111111111111111111111111111111"
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const launchArgs = [
  "launch",
  "--name",
  "Demo",
  "--symbol",
  "DEMO",
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  "embedded",
  "--client-trade-id",
  "launch-1",
  "--json",
]
const buyArgs = [...launchArgs, "--buy", "0.1", "--yes"]
const json = (text: string) => JSON.parse(text.trim())

async function fixture(
  opts: {
    permission?: "allowed" | "denied"
    error?: Record<string, unknown>
    prompt?: string
    badFill?: boolean
    lost?: boolean
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-headless-launch-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let sent = false
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "key" },
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      calls.push({ path, body })
      if (path === "/api/v1/agent/wallets/embedded")
        return Response.json({
          embeddedWalletPermission: opts.permission ?? "allowed",
          wallets: { solana: { address: EMBEDDED }, evm: { address: EVM } },
        })
      if (path.startsWith("/api/v1/launch/headless/jobs/"))
        return sent
          ? Response.json({ success: true, job: { status: "submitted", clientLaunchId: "launch-1" } })
          : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
      if (path === "/api/v1/launch/headless/dry-run") {
        if (opts.error) return Response.json({ error: opts.error }, { status: 403 })
        return Response.json({
          success: true,
          dryRun: true,
          resolved: { chain: body.chain, quoteAsset: body.quoteAsset ?? "sol", mode: body.mode ?? "open" },
          ...(body.buyAmount && body.chain === "solana"
            ? {
                launchWallet: EMBEDDED,
                launchSigner: "server",
                fills: [
                  {
                    index: 1,
                    signer: "server",
                    payerType: "main",
                    wallet: EMBEDDED,
                    amountRaw: opts.badFill ? "2" : String(body.buyAmount),
                    feeRaw: "50000",
                    expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: "4000000" },
                    supplyPct: 0.4,
                  },
                ],
              }
            : {}),
        })
      }
      if (path === "/api/v1/launch/headless") {
        sent = true
        if (opts.lost) throw new Error("lost answer")
        // launch-creator-buy.ts legacyResult: headless success shape, retaining bundleId.
        return Response.json({
          success: true,
          clientLaunchId: body.clientLaunchId,
          mint: EMBEDDED,
          signature: "launchSig",
          ...(body.buyAmount
            ? { devBuySignature: "buySig", bundleId: "bundle-1", booking: { state: "booked", missing: [] } }
            : {}),
        })
      }
      if (path === "/api/v1/uploads/agent-image")
        return Response.json({ success: true, imageUrl: "https://example.test/upload.png" })
      throw new Error(`Unexpected ${path}`)
    }) as typeof fetch,
  })
  return {
    dir,
    deps,
    calls,
    stdout,
    stderr,
    paths: () => calls.map((call) => call.path),
    operations: () => {
      try {
        return readdirSync(join(dir, "operations"))
      } catch {
        return []
      }
    },
  }
}

describe("embedded launch through headless, with an optional first buy", () => {
  test.each([false, true])("buy=%s: dry run, confirm, one headless request, one JSON value", async (buy) => {
    const f = await fixture()
    expect(await run(buy ? buyArgs : [...launchArgs, "--yes"], f.deps)).toBe(0)
    expect(f.paths()).toEqual([
      "/api/v1/launch/headless/jobs/launch-1",
      "/api/v1/agent/wallets/embedded",
      "/api/v1/launch/headless/dry-run",
      "/api/v1/launch/headless",
    ])
    const body = {
      clientLaunchId: "launch-1",
      chain: "solana",
      name: "Demo",
      symbol: "DEMO",
      imageUrl: "https://example.test/image.png",
      ...(buy ? { buyAmount: 100000000 } : {}),
    }
    expect(f.calls.at(-2)?.body).toEqual(body)
    expect(f.calls.at(-1)?.body).toEqual(body)
    expect(json(f.stdout.text)).toMatchObject({
      success: true,
      kind: "launch",
      clientTradeId: "launch-1",
      ...(buy ? { bundleId: "bundle-1", devBuySignature: "buySig" } : {}),
    })
    expect(f.paths().some((path) => path.includes("/atomic/") || path.endsWith("/sign"))).toBe(false)
  })

  test.each([undefined, "0", "0.000", ""])("buy %s is absent", async (buy) => {
    const f = await fixture()
    expect(await run([...launchArgs, ...(buy === undefined ? [] : ["--buy", buy]), "--yes"], f.deps)).toBe(0)
    expect(f.calls.at(-1)?.body).not.toHaveProperty("buyAmount")
  })

  test.each([
    ["sol", "0.1", 100000000],
    ["usdc", "2.5", 2500000],
    ["cndl", "2.5", 2500000],
    ["eth", "0.01", "10000000000000000"],
  ])("%s buy conversion", async (quote, amount, raw) => {
    const f = await fixture()
    expect(
      await run(
        [
          ...launchArgs,
          "--quote-asset",
          String(quote),
          "--buy",
          String(amount),
          ...(quote === "eth" ? ["--dex-version", "v4"] : []),
          "--yes",
        ],
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls.at(-1)?.body.buyAmount).toBe(raw)
    expect(f.calls.at(-1)?.body.chain).toBe(quote === "eth" ? "hood" : "solana")
  })

  test("Hood with no buy uses headless and requires dex version", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--quote-asset", "eth", "--yes"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(await run([...launchArgs, "--quote-asset", "eth", "--dex-version", "v3", "--yes"], f.deps)).toBe(0)
    expect(f.calls.at(-1)?.body).toMatchObject({ chain: "hood", dexVersion: "v3" })
  })

  test("socials, description, staker allocation and visibility reach preview and launch", async () => {
    const f = await fixture()
    expect(
      await run(
        [
          ...buyArgs,
          "--description",
          "A token",
          "--website",
          "https://example.test",
          "--x",
          "https://x.com/candle",
          "--telegram",
          "https://t.me/candle",
          "--discord",
          "https://discord.gg/candle",
          "--staker-allocation-bps",
          "100",
          "--visibility",
          "hidden",
        ],
        f.deps,
      ),
    ).toBe(0)
    for (const call of f.calls.filter((call) => call.path.includes("headless") && !call.path.includes("jobs")))
      expect(call.body).toMatchObject({
        description: "A token",
        socials: {
          website: "https://example.test",
          twitter: "https://x.com/candle",
          telegram: "https://t.me/candle",
          discord: "https://discord.gg/candle",
        },
        stakerAllocationBps: 100,
        visibility: "hidden",
      })
  })

  test.each([
    ["--x", "@candle"],
    ["--website", "javascript:alert(1)"],
    ["--staker-allocation-bps", "49"],
    ["--staker-allocation-bps", "50.5"],
    ["--visibility", "public"],
  ])("bad %s refuses before upload or any request", async (flag, value) => {
    const f = await fixture()
    expect(await run([...buyArgs, flag, value, "--banner", join(f.dir, "missing.png")], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })

  test.each([
    ["sol", "0.0000000001"],
    ["usdc", "0.0000001"],
    ["cndl", "0.0000001"],
    ["eth", "0.0000000000000000001"],
  ])("too many %s decimals refuses before upload", async (quote, amount) => {
    const f = await fixture()
    expect(
      await run(
        [
          ...launchArgs,
          "--quote-asset",
          quote,
          "--buy",
          amount,
          ...(quote === "eth" ? ["--dex-version", "v4"] : []),
          "--yes",
        ],
        f.deps,
      ),
    ).toBe(1)
    expect(json(f.stdout.text).code).toBe("VALIDATION_FAILED")
    expect(
      f.paths().some((path) => path.includes("uploads") || (path.includes("headless") && !path.includes("jobs"))),
    ).toBe(false)
  })

  test("main remains an embedded alias", async () => {
    const f = await fixture()
    expect(
      await run(
        buyArgs.map((arg) => (arg === "embedded" ? "main" : arg)),
        f.deps,
      ),
    ).toBe(0)
  })

  test("dry run and decline leave the launch id unused", async () => {
    for (const extra of [["--dry-run"], []]) {
      const f = await fixture({ prompt: "n" })
      expect(await run([...launchArgs, "--buy", "0.1", ...extra], f.deps)).toBe(0)
      expect(f.paths()).not.toContain("/api/v1/launch/headless")
      expect(f.operations()).toEqual([])
      expect(json(f.stdout.text)).toMatchObject(extra.length ? { dryRun: true } : { status: "cancelled" })
    }
  })

  test("noninteractive launch still requires --yes", async () => {
    const f = await fixture()
    f.deps.isTTY.stdin = false
    expect(await run(launchArgs, f.deps)).toBe(1)
    expect(json(f.stdout.text).code).toBe("CONFIRMATION_REQUIRED")
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })

  test("embedded permission refusal precedes upload", async () => {
    const f = await fixture({ permission: "denied" })
    const banner = join(f.dir, "banner.png")
    await writeFile(banner, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(await run([...buyArgs, "--banner", banner], f.deps)).toBe(1)
    expect(json(f.stdout.text).code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
    expect(json(f.stdout.text).suggestion).toContain("--wallet <tee>")
    expect(f.paths().some((path) => path.includes("uploads") || path.endsWith("dry-run"))).toBe(false)
  })

  test.each([
    "LAUNCH_DISABLED",
    "DEV_BUY_TOO_HIGH",
    "EMBEDDED_WALLET_NOT_PERMITTED",
  ])("server %s refusal passes through and consumes no id", async (code) => {
    const f = await fixture({ error: { code, message: "Server refusal" } })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(json(f.stdout.text).code).toBe(code)
    expect(json(f.stdout.text).message).toStartWith("Server refusal")
    expect(f.operations()).toEqual([])
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })

  test("a mismatching preview fill never launches", async () => {
    const f = await fixture({ badFill: true })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(json(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })

  test("a lost headless answer recovers by clientLaunchId without resending", async () => {
    const f = await fixture({ lost: true })
    expect(await run(buyArgs, f.deps)).toBe(3)
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(3)
    expect(f.paths().slice(before)).toEqual(["/api/v1/launch/headless/jobs/launch-1"])
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/headless")).toHaveLength(1)
  })
})
