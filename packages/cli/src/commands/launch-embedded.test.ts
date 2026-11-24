import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const DIGEST = `0x${"ab".repeat(32)}`
const REFUSED_MINT = "So11111111111111111111111111111111111111113"
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
    /** BE-3673: which answers echo `hide: true` when the request asked for it (default: both). */
    hideEcho?: { dryRun: boolean; live: boolean }
    /** BE-3575: the headless route's refusal, as `fail()` sends it. */
    headlessError?: Record<string, unknown>
    /** BE-3575: one `getSignatureStatuses` value per read, the last repeated; a string throws. */
    chain?: Array<Record<string, unknown> | null | "rpc-error">
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
      const url = new URL(String(input))
      const path = url.pathname
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (url.host === "api.mainnet-beta.solana.com") {
        calls.push({ path: `rpc:${body.method}`, body })
        const reads = calls.filter((call) => call.path === "rpc:getSignatureStatuses").length
        const answer = opts.chain?.[Math.min(reads, opts.chain.length) - 1] ?? null
        if (answer === "rpc-error") return new Response("down", { status: 503 })
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: [answer] } })
      }
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
      if (path === "/api/v1/launch/preflight") {
        // BE-3633: the check a new-quote launch pins. Echoes the requested mint; a test can refuse it.
        const quote = url.searchParams.get("quote") ?? ""
        const refuse = url.searchParams.get("quote") === REFUSED_MINT
        return Response.json({
          success: true,
          key: {
            keyPrefix: "cndl_test",
            scopes: ["launch:write"],
            tier: "max",
            selfLaunch: true,
            embeddedWalletPermission: "allowed",
          },
          switches: { headlessLaunch: true, agentTrading: true, teeLaunchBuys: false },
          wallets: [],
          quote: {
            requested: quote,
            ok: !refuse,
            chain: "solana",
            address: quote,
            symbol: "BONK",
            decimals: 6,
            classification: "ordinary",
            checks: [
              refuse
                ? { check: "liquidity", status: "refuse", code: "QUOTE_TOO_THIN", message: "thin" }
                : { check: "liquidity", status: "pass", message: "ok" },
            ],
            ...(refuse
              ? {}
              : {
                  economics: {
                    kind: "derived",
                    economicsDigest: DIGEST,
                    thresholdRaw: "1000000000",
                    startFdv: 1,
                    bondingFdv: 2,
                    curve: { sqrtStartPrice: "1" },
                  },
                }),
            disclosure: null,
            executionEnabled: true,
          },
        })
      }
      if (path === "/api/v1/launch/headless/dry-run") {
        if (opts.error) return Response.json({ error: opts.error }, { status: 403 })
        return Response.json({
          success: true,
          dryRun: true,
          resolved: { chain: body.chain, quoteAsset: body.quoteAsset ?? "sol", mode: body.mode ?? "open" },
          ...(body.hide === true && (opts.hideEcho?.dryRun ?? true) ? { hide: true } : {}),
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
        if (opts.headlessError) return Response.json({ success: false, error: opts.headlessError }, { status: 500 })
        // launch-creator-buy.ts legacyResult: headless success shape, retaining bundleId.
        return Response.json({
          success: true,
          clientLaunchId: body.clientLaunchId,
          mint: EMBEDDED,
          signature: "launchSig",
          ...(body.hide === true && (opts.hideEcho?.live ?? true) ? { hide: true } : {}),
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

describe("BE-3673: embedded launch --hide checks the live response too", () => {
  test("a live success that echoes hide exits 0", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--yes", "--hide"], f.deps)).toBe(0)
    expect(f.calls.at(-1)?.body).toMatchObject({ hide: true })
    expect(json(f.stdout.text)).toMatchObject({ success: true, hide: true })
  })

  test("a dry run that echoes hide but a live success that does not: result kept, warning, exit nonzero", async () => {
    const f = await fixture({ hideEcho: { dryRun: true, live: false } })
    const code = await run([...launchArgs, "--yes", "--hide"], f.deps)
    expect(code).not.toBe(0)
    expect(f.paths().filter((path) => path === "/api/v1/launch/headless")).toHaveLength(1)
    // The launch ran, so its identifiers stay available for recovery.
    expect(json(f.stdout.text)).toMatchObject({
      success: true,
      clientTradeId: "launch-1",
      mint: EMBEDDED,
      signature: "launchSig",
    })
    expect(humanText(f.stderr.text)).toContain(humanText("Treat launch launch-1 as PUBLIC"))
    expect(humanText(f.stderr.text)).toContain(humanText("do not send it again"))
  })

  test("a dry run without the echo never reaches the live launch", async () => {
    const f = await fixture({ hideEcho: { dryRun: false, live: false } })
    expect(await run([...launchArgs, "--yes", "--hide"], f.deps)).not.toBe(0)
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })
})

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
      expect(await run([...launchArgs, "--buy", "0.1", ...extra], f.deps)).toBe(extra.length ? 0 : 5)
      expect(f.paths()).not.toContain("/api/v1/launch/headless")
      expect(f.operations()).toEqual([])
      expect(json(f.stdout.text)).toMatchObject(extra.length ? { dryRun: true } : { status: "cancelled" })
    }
  })

  test("BE-3633: --quote <mint> sends the mint, case intact, as the quote asset of the launch", async () => {
    const NEW_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    const f = await fixture()
    const code = await run([...launchArgs, "--quote", NEW_MINT, "--dry-run"], f.deps)
    if (code !== 0) throw new Error(f.stdout.text + f.stderr.text)
    expect(code).toBe(0)
    const sent = f.calls.find((call) => call.path === "/api/v1/launch/headless/dry-run")?.body
    // The check's digest is pinned in the body, read before anything was uploaded or built.
    expect(sent).toMatchObject({ chain: "solana", quoteAsset: NEW_MINT, economicsDigest: DIGEST })
    expect(f.paths().indexOf("/api/v1/launch/preflight")).toBeLessThan(
      f.paths().indexOf("/api/v1/launch/headless/dry-run"),
    )
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })

  test("BE-3633: a refused quote check stops the launch before any upload, build or id claim", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--quote", REFUSED_MINT, "--dry-run"], f.deps)).toBe(1)
    expect(f.paths()).not.toContain("/api/v1/launch/headless/dry-run")
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
  })

  test("BE-3633: a first buy against a new quote is refused before any request", async () => {
    const NEW_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    const f = await fixture()
    expect(await run([...launchArgs, "--quote", NEW_MINT, "--buy", "0.1"], f.deps)).toBe(2)
    expect(f.calls.filter((call) => call.path.startsWith("/api/v1/launch"))).toEqual([])
  })

  test("BE-2668: --dry-run with --image checks the file and uploads nothing", async () => {
    const f = await fixture()
    const image = join(f.dir, "logo.png")
    const banner = join(f.dir, "wide.png")
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    await writeFile(image, png)
    await writeFile(banner, png)
    const args = launchArgs.map((arg, i) =>
      arg === "--image-url" ? "--image" : launchArgs[i - 1] === "--image-url" ? image : arg,
    )
    expect(await run([...args, "--banner", banner, "--dry-run"], f.deps)).toBe(0)
    const checks = f.calls.filter((call) => call.path === "/api/v1/uploads/agent-image")
    // Both files went to the check-only mode; the fixture cannot tell the query, so the proof of
    // "no upload" is the body the dry run was sent: flags, no URL, and no real launch afterwards.
    expect(checks).toHaveLength(2)
    const sent = f.calls.find((call) => call.path === "/api/v1/launch/headless/dry-run")?.body
    expect(sent).toMatchObject({ imageChecked: true, bannerChecked: true })
    expect(sent).not.toHaveProperty("imageUrl")
    expect(sent).not.toHaveProperty("bannerUrl")
    expect(f.paths()).not.toContain("/api/v1/launch/headless")
    expect(json(f.stdout.text)).toMatchObject({ dryRun: true, imageChecked: true, bannerChecked: true })
    expect(json(f.stdout.text).imageUrl).toBeUndefined()
    expect(humanText(f.stderr.text)).not.toContain(humanText("public and permanent"))
  })

  test("BE-2668: the check goes to the upload route's dryRun mode", async () => {
    const urls: string[] = []
    const f = await fixture()
    const inner = f.deps.fetch
    f.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input))
      return inner(input, init)
    }) as typeof fetch
    const image = join(f.dir, "logo.png")
    await writeFile(image, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
    const args = launchArgs.map((arg, i) =>
      arg === "--image-url" ? "--image" : launchArgs[i - 1] === "--image-url" ? image : arg,
    )
    expect(await run([...args, "--dry-run"], f.deps)).toBe(0)
    expect(urls.filter((url) => url.includes("/uploads/agent-image")).map((url) => new URL(url).search)).toEqual([
      "?dryRun=true",
    ])
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

  test.each(["LAUNCH_DISABLED", "DEV_BUY_TOO_HIGH", "EMBEDDED_WALLET_NOT_PERMITTED"])(
    "server %s refusal passes through and consumes no id",
    async (code) => {
      const f = await fixture({ error: { code, message: "Server refusal" } })
      expect(await run(buyArgs, f.deps)).toBe(1)
      expect(json(f.stdout.text).code).toBe(code)
      expect(json(f.stdout.text).message).toStartWith("Server refusal")
      expect(f.operations()).toEqual([])
      expect(f.paths()).not.toContain("/api/v1/launch/headless")
    },
  )

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

  // BE-2572 (W6): a live embedded Solana launch warns on stderr when the fee wallet defaults;
  // a chosen one and a Hood launch (no fee wallet) stay quiet.
  test("a live embedded launch warns when the fee wallet defaults", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(0)
    expect(humanText(f.stderr.text)).toContain("No --fee-wallet given")
    const chosen = await fixture()
    expect(await run([...launchArgs, "--fee-wallet", EMBEDDED, "--yes"], chosen.deps)).toBe(0)
    expect(humanText(chosen.stderr.text)).not.toContain("No --fee-wallet given")
    const hood = await fixture()
    expect(await run([...launchArgs, "--quote-asset", "eth", "--dex-version", "v4", "--yes"], hood.deps)).toBe(0)
    expect(humanText(hood.stderr.text)).not.toContain("No --fee-wallet given")
  })
})

// BE-3575: the headless route answers LAUNCH_FAILED with `stage: "unconfirmed"` when its
// confirmation wait runs out. The launch may have landed, so the CLI reads the signature on chain
// before it reports anything, and never reports a landed launch as LAUNCH_FAILED exit 1.
describe("an unconfirmed headless launch is read on chain before it is reported", () => {
  const SIG = "48FAKusdN2wCDbWFriS1TU4AzyS45oj7tXHhGAm71xnuMRZsV8XGZotdAr1BaNdNKGdx7aNDQcgKJz8AuKvFgVVd"
  const unconfirmed = {
    code: "LAUNCH_FAILED",
    message:
      "The launch may already be on chain. This clientLaunchId will not start another attempt. Check the mint on chain before using a new id.",
    retryable: false,
    stage: "unconfirmed",
    signature: SIG,
    recorded: true,
  }
  const signatureReads = (f: { paths: () => string[] }) =>
    f.paths().filter((path) => path === "rpc:getSignatureStatuses").length

  test("landed but unconfirmed by Candle: finalized late without an error is a landed launch, exit 0", async () => {
    // The fake confirms late: no status, then processed, then confirmed, then finalized.
    const f = await fixture({
      headlessError: unconfirmed,
      chain: [
        null,
        { confirmationStatus: "processed", err: null },
        { confirmationStatus: "confirmed", err: null },
        { confirmationStatus: "finalized", err: null, slot: 470213483 },
      ],
    })
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(0)
    expect(signatureReads(f)).toBe(4)
    expect(f.calls.find((call) => call.path === "rpc:getSignatureStatuses")?.body.params).toEqual([
      [SIG],
      { searchTransactionHistory: true },
    ])
    const out = json(f.stdout.text)
    expect(out).toMatchObject({
      success: true,
      status: "landed",
      kind: "launch",
      clientTradeId: "launch-1",
      clientLaunchId: "launch-1",
      signature: SIG,
      slot: 470213483,
      confirmation: "finalized",
      recorded: false,
    })
    expect(out.code).toBeUndefined()
    expect(humanText(f.stderr.text)).toContain("it landed")
    // Exactly one launch was sent; nothing was re-sent.
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/headless")).toHaveLength(1)
  })

  test("finalized with an error is the one LAUNCH_FAILED, exit 1", async () => {
    const f = await fixture({
      headlessError: unconfirmed,
      chain: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
    })
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(1)
    const out = json(f.stdout.text)
    expect(out.code).toBe("LAUNCH_FAILED")
    expect(out.message).toContain("finalized on chain with an error")
    expect(out.details).toMatchObject({ stage: "unconfirmed", signature: SIG, onChain: "failed" })
  })

  test.each([
    ["no status on any read", [null]],
    ["confirmed but never finalized", [{ confirmationStatus: "confirmed", err: null }]],
    ["an RPC that fails every read", ["rpc-error" as const]],
  ])("%s: LAUNCH_UNCONFIRMED, exit 3, never LAUNCH_FAILED", async (_label, chain) => {
    const f = await fixture({ headlessError: unconfirmed, chain })
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(3)
    const out = json(f.stdout.text)
    expect(out.code).toBe("LAUNCH_UNCONFIRMED")
    expect(out.message).toContain("do not launch again under a new id")
    expect(out.details).toMatchObject({ stage: "unconfirmed", serverCode: "LAUNCH_FAILED", signature: SIG })
    expect(signatureReads(f)).toBeGreaterThanOrEqual(6)
    expect(f.stdout.text).not.toContain("api.mainnet-beta.solana.com/")
  })

  test.each([
    ["an unconfirmed refusal without a signature", { ...unconfirmed, signature: undefined }],
    ["a landed launch whose recording did not finish", { ...unconfirmed, stage: "executed", mint: EMBEDDED }],
  ])("%s is exit 3 with no chain read", async (_label, headlessError) => {
    const f = await fixture({ headlessError })
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(3)
    expect(json(f.stdout.text).code).toBe("LAUNCH_UNCONFIRMED")
    expect(signatureReads(f)).toBe(0)
  })

  test("a Hood unconfirmed refusal is exit 3, not LAUNCH_FAILED", async () => {
    const f = await fixture({ headlessError: { ...unconfirmed, signature: "0xabc" } })
    expect(await run([...launchArgs, "--quote-asset", "eth", "--dex-version", "v4", "--yes"], f.deps)).toBe(3)
    expect(json(f.stdout.text).code).toBe("LAUNCH_UNCONFIRMED")
    expect(signatureReads(f)).toBe(0)
  })

  test("a refusal with no stage still fails as before", async () => {
    const f = await fixture({ headlessError: { code: "LAUNCH_FAILED", message: "Reverted", retryable: true } })
    expect(await run([...launchArgs, "--yes"], f.deps)).toBe(1)
    expect(json(f.stdout.text).code).toBe("LAUNCH_FAILED")
    expect(signatureReads(f)).toBe(0)
  })
})
