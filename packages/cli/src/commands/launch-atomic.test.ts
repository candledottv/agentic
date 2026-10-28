/**
 * BE-1721 (spec 2026-10-20-tee-launch-buy-packet-size-design.md, option D): `candle launch` on
 * Solana with a TEE `--wallet` and `--buy` is an atomic launch. The wallet is the creator and the
 * only first buyer; both legs are relay-signed in order, saved with the bundle, and sent by Candle
 * through one `/launch/atomic/submit`. The fake API hands out real legs (`launch-bundle.fixtures`).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { buyLeg, expectedLamports, type LegOptions, launchLeg, relaySigned } from "../launch-bundle.fixtures"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createTestDeps } from "../test-support"

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const WALLET = Keypair.generate().publicKey.toBase58()
const MINT = Keypair.generate().publicKey.toBase58()
const FEE = { SOL: 50_000n, USDC: 12_500n }
const MIN_OUT = "4000000"
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

type Submit = "landed" | "failed" | "timeout" | { status: number; error: Record<string, unknown> } | "lost"

async function fixture(
  opts: {
    scopes?: string[]
    /** A Candle error `/launch/self/build` answers, with its HTTP status. */
    buildError?: { status: number; error: Record<string, unknown> }
    /** Change the legs the build hands out. */
    legs?: Partial<LegOptions>
    submit?: Submit
    /** What `GET /launch/headless/jobs/:id` answers once a build exists. */
    jobStatus?: string
    env?: Record<string, string>
    prompt?: string
    /** The relay refuses the n-th signature it is asked for (1-based), once. */
    signFailAt?: number
    /** BE-1806: what either dry run answers, echoing the body's curve fields in `resolved`. */
    dryRunError?: { status: number; error: Record<string, unknown> }
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-atomic-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined; operations: unknown[] }[] = []
  const operations = () => {
    try {
      return readdirSync(join(dir, "operations")).map((file) =>
        JSON.parse(readFileSync(join(dir, "operations", file), "utf8")),
      )
    } catch {
      return []
    }
  }
  let built = 0
  let signed = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, body, operations: operations() })
    const ok = (value: unknown, status = 200) => Response.json(value, { status })
    if (path === "/api/v1/uploads/agent-image") return ok({ success: true, imageUrl: "https://hosted.test/banner.png" })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["launch:write", "swap:write", "launch:read"],
        privyAppId: "app",
        page: [
          {
            id: "wallet",
            address: WALLET,
            label: "tee",
            chain: "solana",
            active: true,
            allowLaunch: true,
            privyWalletId: "privy",
          },
        ],
        isDone: true,
      })
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return built
        ? ok({ success: true, job: { status: opts.jobStatus ?? "built", clientLaunchId: "launch-1" } })
        : ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    if (path === "/api/v1/launch/self/dry-run" || path === "/api/v1/launch/self/dry-run") {
      if (opts.dryRunError) return ok({ success: false, error: opts.dryRunError.error }, opts.dryRunError.status)
      return ok(dryRunAnswer(body, Number(body.buyAmount) > 0))
    }
    if (path === "/api/v1/launch/self/build") {
      if (opts.buildError) return ok({ success: false, error: opts.buildError.error }, opts.buildError.status)
      built++
      const quote = String(body.quoteAsset ?? "sol").toUpperCase() as "SOL" | "USDC"
      const legOpts: LegOptions = {
        wallet: WALLET,
        quote,
        buyRaw: BigInt(body.buyAmount),
        feeRaw: FEE[quote],
        minOutRaw: BigInt(MIN_OUT),
        ...opts.legs,
      }
      return ok({
        bundleId: `bundle-${built}`,
        legs: [
          { index: 0, role: "launch", signer: "client", unsignedTxBase64: launchLeg(legOpts) },
          {
            index: 1,
            role: "buy",
            signer: "client",
            unsignedTxBase64: buyLeg(legOpts),
            expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: MIN_OUT },
          },
        ],
        expiresAt: Date.now() + 600_000,
      })
    }
    if (path === "/api/v1/agent/wallets/wallet/sign") {
      if (++signed === opts.signFailAt)
        return ok({ success: false, error: { code: "SPEND_POLICY_DENIED", message: "denied" } }, 403)
      return ok({ signedTransaction: relaySigned(body.body.params.transaction, signed), encoding: "base64" })
    }
    if (path === "/api/v1/launch/atomic/submit") {
      const bundleId = body.bundleId
      const submit = opts.submit ?? "landed"
      if (submit === "lost") throw new Error("lost response")
      if (submit === "landed")
        return ok({
          status: "landed",
          bundleId,
          mint: MINT,
          signatures: [sig(1), sig(2)],
          booking: { state: "booked", missing: [] },
        })
      if (submit === "failed" || submit === "timeout") return ok({ status: submit, bundleId, retryable: false }, 502)
      return ok({ success: false, error: submit.error }, submit.status)
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      CANDLE_SOLANA_RPC_URL: "http://localhost/rpc",
      ...opts.env,
    },
    store: createFakeStoreWithSigner(),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  return { deps, calls, stdout, stderr, operations, paths: () => calls.map((call) => call.path) }
}

function createFakeStoreWithSigner() {
  // Imported lazily so this file reads top to bottom like swap.test.ts's fixture.
  const { createFakeStore } = require("../test-support") as typeof import("../test-support")
  return createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) })
}

/**
 * What the API's dry runs answer for a body (BE-1806), in their shape: the resolved block the API
 * would validate (V and G in raw SOL units), the preview, and the atomic route's fills.
 */
function dryRunAnswer(body: Record<string, unknown>, atomic: boolean): Record<string, unknown> {
  const curve = body.curve as { virtualQuote: string; threshold: string } | undefined
  const raw = (whole: string) => (BigInt(Math.round(Number(whole) * 1e9)) * 1n).toString()
  const resolved = {
    chain: "solana",
    quoteAsset: String(body.quoteAsset ?? "sol"),
    mode: String(body.mode ?? "open"),
    stakerAllocationBps: 500,
    ...(body.creatorFeeBps ? { creatorFeeBps: body.creatorFeeBps } : {}),
    ...(curve ? { curve: { virtualQuoteRaw: raw(curve.virtualQuote), thresholdRaw: raw(curve.threshold) } } : {}),
    visibility: "production",
    ...(atomic ? {} : { dexVersion: null, buyAmount: String(body.buyAmount ?? "0") }),
  }
  return {
    success: true,
    dryRun: true,
    launchWallet: WALLET,
    resolved,
    curveTerms: {
      symbol: "SOL",
      thresholdRaw: "20000000000",
      raise: 20,
      startFdv: 4.21,
      bondingFdv: 151.58,
      supplySoldPct: 79.17,
      virtualQuoteRaw: "4000000000",
      firstBuyRaw: "1000000000",
      firstBuySupplyPct: 19,
      firstBuy: {
        basis: "reference",
        amountRaw: "1000000000",
        curveFeeRaw: "20000000",
        tokensOutRaw: "186947791164658",
        supplyPct: 18.6948,
      },
      fees: {
        curve: { feeBps: 200, fee: 0.02, creatorShare: 0.015, platformShare: 0.005 },
        pool: { feeBps: 150, fee: 0.015, creatorShare: 0.0125, platformShare: 0.0025 },
      },
      migration: {
        venue: "meteora_damm_v2",
        poolFeeBps: 150,
        poolShape: "floor",
        openingPriceStepPct: 0,
        lpLock: "permanent",
      },
    },
    ...(atomic
      ? {
          fills: [
            {
              index: 1,
              signer: "client",
              payerType: "linked",
              wallet: WALLET,
              amountRaw: String(body.buyAmount),
              feeRaw: "0",
              expectedFill: { amountOutRaw: "4040404", minAmountOutRaw: "4000000" },
              supplyPct: 2.1,
            },
          ],
          graduatesInBundle: false,
        }
      : { devBuyMax: "500000000" }),
    checks: { image: "ok" },
    matrixVersion: 1,
  }
}

/** The base58 signature `relaySigned` puts on the n-th signed leg. */
const sig = (n: number) => base58.encode(Buffer.alloc(64, n))
const lastJson = (text: string) => JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")

const launchArgs = [
  "launch",
  "--name",
  "N".repeat(32),
  "--symbol",
  "T".repeat(10),
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  "tee",
  "--client-trade-id",
  "launch-1",
  "--yes",
  "--json",
]
const buyArgs = [...launchArgs, "--buy", "0.01"]
const writes = (paths: string[]) =>
  paths.filter((path) => path.endsWith("/build") || path.endsWith("/sign") || path.endsWith("/submit"))

describe("BE-1721: candle launch --wallet <solana tee> --buy is an atomic launch", () => {
  test.each([false, true])("socials reach the TEE self route, buy=%s", async (dryRun) => {
    const f = await fixture()
    expect(
      await run(
        [
          ...buyArgs,
          "--website",
          "https://example.test",
          "--x",
          "https://x.com/candle",
          "--telegram",
          "https://t.me/candle",
          "--discord",
          "https://discord.gg/candle",
          "--staker-allocation-bps",
          "500",
          "--visibility",
          "hidden",
          ...(dryRun ? ["--dry-run"] : []),
        ],
        f.deps,
      ),
    ).toBe(0)
    const body = f.calls.find((call) => call.path === `/api/v1/launch/self/${dryRun ? "dry-run" : "build"}`)?.body
    expect(body).toMatchObject({
      socials: {
        website: "https://example.test",
        twitter: "https://x.com/candle",
        telegram: "https://t.me/candle",
        discord: "https://discord.gg/candle",
      },
      stakerAllocationBps: 500,
      visibility: "hidden",
    })
  })

  test("a failed atomic bundle retries with the saved banner URL, without publishing again", async () => {
    const f = await fixture({ submit: "failed", jobStatus: "failed" })
    const path = join(f.deps.env.CANDLE_CONFIG_DIR as string, "banner.png")
    await writeFile(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const args = [...buyArgs, "--banner", path]
    expect(await run(args, f.deps)).toBe(1)
    expect(await run(args, f.deps)).toBe(1)
    expect(f.calls.filter((c) => c.path === "/api/v1/uploads/agent-image")).toHaveLength(1)
    const builds = f.calls.filter((c) => c.path === "/api/v1/launch/self/build")
    expect(builds).toHaveLength(2)
    expect(builds.map((c) => c.body?.bannerUrl)).toEqual([
      "https://hosted.test/banner.png",
      "https://hosted.test/banner.png",
    ])
    expect(f.operations()[0]).toMatchObject({ bannerUrl: "https://hosted.test/banner.png" })
  })

  test("R1: one /launch/self/build with the TEE wallet and buyAmount", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    const build = f.calls.find((call) => call.path === "/api/v1/launch/self/build")?.body
    expect(build).toEqual({
      clientLaunchId: "launch-1",
      chain: "solana",
      name: "N".repeat(32),
      symbol: "T".repeat(10),
      imageUrl: "https://example.test/image.png",
      linkedWalletId: "wallet",
      buyAmount: "10000000",
    })
    expect(build).not.toHaveProperty("firstBuys")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
    expect(f.paths()).not.toContain("/api/v1/launch/self/confirm")
  })

  test("R1: --buy is in the quote asset's whole units, and the description, quote asset and mode ride along", async () => {
    const f = await fixture()
    const args = [...launchArgs, "--buy", "2.5", "--quote-asset", "usdc", "--description", "d", "--mode", "open"]
    expect(await run(args, f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      quoteAsset: "usdc",
      description: "d",
      mode: "open",
      buyAmount: "2500000",
    })
  })

  test("pool choices ride the atomic build and the self-signed build; default flags add no field", async () => {
    const choices = [
      "--pool-fee",
      "25",
      "--pool-fee-from",
      "2500",
      "--pool-fee-minutes",
      "30",
      "--pool-open",
      "curve_price",
    ]
    const f = await fixture()
    expect(await run([...buyArgs, ...choices], f.deps)).toBe(0)
    expect(f.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      poolFee: { startBps: 2500, endBps: 25, minutes: 30 },
      poolOpen: "curve_price",
    })
    const self = await fixture()
    // The fake answers no self-signed route: the recorded build body is the assertion. An exp-
    // mode launch, because expPoolShape is only valid on an experimental curve.
    await run([...launchArgs, "--mode", "exp-b", "--pool-fee", "100", "--exp-pool-shape", "full_range"], self.deps)
    expect(self.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      mode: "exp-b",
      poolFee: { tier: 100 },
      expPoolShape: "full_range",
    })
    const plain = await fixture()
    expect(await run(buyArgs, plain.deps)).toBe(0)
    const body = plain.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body ?? {}
    for (const field of ["poolFee", "poolOpen", "expPoolShape"]) expect(body).not.toHaveProperty(field)
  })

  test("a bad pool flag is a usage error before any request", async () => {
    for (const bad of [
      ["--pool-fee", "30"],
      ["--pool-fee", "25", "--pool-fee-from", "2500"],
      ["--pool-fee-from", "2500", "--pool-fee-minutes", "30"],
      ["--pool-open", "last"],
      ["--exp-pool-shape", "wide"],
    ]) {
      const f = await fixture()
      expect(await run([...buyArgs, ...bad], f.deps)).toBe(2)
      expect(writes(f.paths())).toEqual([])
    }
  })

  test("R7: without --buy the launch is the self-signed one, as before", async () => {
    const f = await fixture()
    // The fake answers no self-signed route: reaching it is the assertion.
    expect(await run(launchArgs, f.deps)).toBe(1)
    expect(f.paths()).toContain("/api/v1/launch/self/build")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
  })

  test("R2: the quote shows the fee and the most the wallet can lose, read off the legs, and the bundle notice", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    const lamports = expectedLamports({
      wallet: WALLET,
      quote: "SOL",
      buyRaw: 10_000_000n,
      feeRaw: FEE.SOL,
      minOutRaw: 0n,
    })
    expect(humanText(f.stderr.text)).toContain(humanText("land together or not at all"))
    expect(humanText(f.stderr.text)).toContain(humanText("pays a Jito tip"))
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Launch ${"N".repeat(32)} (${"T".repeat(10)}) with a first buy of 0.010000000 SOL, as one Jito bundle`),
    )
    expect(f.stderr.text).toContain(`Payer: ${WALLET}`)
    expect(humanText(f.stderr.text)).toContain(
      humanText("Candle fee: 0.000050000 SOL (the tier fee on the first buy, in its leg)"),
    )
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Minimum received: ${MIN_OUT} raw units of the new token (the first buy's floor)`),
    )
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Most this wallet can lose: 0.0${lamports.toString().padStart(8, "0")} SOL`),
    )
  })

  test("R2: a USDC launch's ceiling is SOL and USDC", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--buy", "2.5", "--quote-asset", "usdc"], f.deps)).toBe(0)
    expect(humanText(f.stderr.text)).toContain(humanText("Candle fee: 0.012500 USDC"))
    expect(f.stderr.text).toMatch(/Most this wallet can lose: 0\.\d{9} SOL and 2\.512500 USDC/)
  })

  test("R3: both legs relay-signed in order, the bundle and both signatures saved before /submit, nothing broadcast", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    const build = f.calls.findIndex((call) => call.path === "/api/v1/launch/self/build")
    const signs = f.calls.filter((call) => call.path.endsWith("/sign"))
    expect(signs).toHaveLength(2)
    expect(f.paths().indexOf("/api/v1/agent/wallets/wallet/sign")).toBeGreaterThan(build)
    const submit = f.calls.find((call) => call.path === "/api/v1/launch/atomic/submit")
    expect(submit?.body?.bundleId).toBe("bundle-1")
    // Leg order: the launch first, then the buy, as signed.
    expect((submit?.body?.signedTxsBase64 as string[]).map((tx) => Buffer.from(tx, "base64")[1])).toEqual([1, 2])
    expect(submit?.operations).toEqual([
      {
        id: "launch-1",
        kind: "launch",
        bundleId: "bundle-1",
        bundleSignatures: [sig(1), sig(2)],
        imageUrl: "https://example.test/image.png",
      },
    ])
    // No RPC at all: Candle sends the bundle.
    expect(f.paths()).not.toContain("/rpc")
  })

  test("R4 landed: exit 0, the mint and both signatures", async () => {
    const f = await fixture()
    expect(await run(buyArgs, f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out).toMatchObject({
      status: "landed",
      bundleId: "bundle-1",
      mint: MINT,
      signatures: [sig(1), sig(2)],
      clientTradeId: "launch-1",
      kind: "launch",
    })
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Mint ${MINT} Launch signature ${sig(1)} First buy signature ${sig(2)}`),
    )
  })

  test("R4 failed: nothing landed, the same id to retry with, exit 1", async () => {
    const f = await fixture({ submit: "failed" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("BUNDLE_FAILED")
    expect(out.message).toContain("neither the launch nor its first buy is on chain")
    expect(out.message).toContain("Retry with the same --client-trade-id launch-1")
    expect(out.details).toEqual({ bundleId: "bundle-1", signatures: [sig(1), sig(2)] })
  })

  test("R4 timeout: unresolved, exit 3, never a new id", async () => {
    const f = await fixture({ submit: "timeout" })
    expect(await run(buyArgs, f.deps)).toBe(3)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("BUNDLE_UNRESOLVED")
    expect(out.message).toContain("may still land")
    expect(out.message).toContain("Never relaunch under a new id")
  })

  test("a lost /submit answer is unresolved too: exit 3", async () => {
    const f = await fixture({ submit: "lost" })
    expect(await run(buyArgs, f.deps)).toBe(3)
    expect(humanText(lastJson(f.stdout.text).message)).toContain(humanText("may have been sent"))
  })

  test("R5: a re-run after a timeout reads the job, re-signs nothing and re-sends nothing", async () => {
    const f = await fixture({ submit: "timeout" })
    expect(await run(buyArgs, f.deps)).toBe(3)
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(3)
    const again = f.calls.slice(before).map((call) => call.path)
    expect(again).toContain("/api/v1/launch/headless/jobs/launch-1")
    expect(writes(again)).toEqual([])
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("OPERATION_IN_FLIGHT")
    expect(out.details).toMatchObject({ bundleId: "bundle-1", signatures: [sig(1), sig(2)] })
  })

  test("R5: a re-run once the job is confirmed reports it and posts nothing", async () => {
    const f = await fixture({ submit: "timeout", jobStatus: "confirmed" })
    expect(await run(buyArgs, f.deps)).toBe(3)
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(0)
    expect(writes(f.calls.slice(before).map((call) => call.path))).toEqual([])
    expect(lastJson(f.stdout.text)).toMatchObject({ job: { status: "confirmed" }, bundleId: "bundle-1" })
  })

  test("R4/R5: a re-run after a failed bundle builds again under the same id, without claiming it again", async () => {
    const f = await fixture({ submit: "failed", jobStatus: "failed" })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(1)
    const again = f.calls.slice(before)
    const rebuild = again.find((call) => call.path === "/api/v1/launch/self/build")
    expect(rebuild?.body?.clientLaunchId).toBe("launch-1")
    // The second bundle is new; the first is never submitted again.
    expect(again.filter((call) => call.path.endsWith("/submit")).map((call) => call.body?.bundleId)).toEqual([
      "bundle-2",
    ])
    expect(lastJson(f.stdout.text).code).toBe("BUNDLE_FAILED")
  })

  test("a relay refusal of the buy leg submits nothing, and a re-run builds again under the same id", async () => {
    const f = await fixture({ signFailAt: 2 })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/submit")
    expect(f.operations()).toMatchObject([{ bundleId: "bundle-1", bundleOutcome: "unsigned", bundleSignatures: [] }])
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(0)
    const again = f.calls.slice(before)
    expect(again.find((call) => call.path === "/api/v1/launch/self/build")?.body?.clientLaunchId).toBe("launch-1")
    expect(again.filter((call) => call.path.endsWith("/submit")).map((call) => call.body?.bundleId)).toEqual([
      "bundle-2",
    ])
  })

  test("a 4xx refused submit sent nothing, so a re-run builds again under the same id", async () => {
    const f = await fixture({
      submit: { status: 400, error: { code: "UNRECOGNIZED_TRANSACTION", message: "signature does not verify" } },
    })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(humanText(lastJson(f.stdout.text).message)).toContain(humanText("sent nothing"))
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(f.calls.slice(before).some((call) => call.path === "/api/v1/launch/self/build")).toBe(true)
  })

  test("a TEE creator buy does not require swap:write locally", async () => {
    const f = await fixture({ scopes: ["launch:write", "launch:read"] })
    expect(await run(buyArgs, f.deps)).toBe(0)
    expect(f.paths()).toContain("/api/v1/launch/self/build")
    expect(f.paths()).not.toContain("/api/v1/launch/atomic/build")
  })

  test("the TEE buy gate preserves the server code and message, adds a no-buy next step and signs nothing", async () => {
    const message = "TEE launch buys are disabled on this deployment"
    const f = await fixture({
      buildError: { status: 400, error: { code: "VALIDATION_FAILED", message, field: "buyAmount" } },
    })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("VALIDATION_FAILED")
    expect(lastJson(f.stdout.text).message).toStartWith(message)
    expect(humanText(lastJson(f.stdout.text).suggestion)).toContain(humanText("Launch without --buy"))
    expect(writes(f.paths())).toEqual(["/api/v1/launch/self/build"])
  })

  test("any other build refusal passes through", async () => {
    const f = await fixture({
      buildError: { status: 403, error: { code: "TIER_REQUIRED", message: "Atomic launches require Pro or Max tier" } },
    })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("TIER_REQUIRED")
    expect(out.message).toStartWith("Atomic launches require Pro or Max tier")
  })

  test("D2: a --buy above the dev-buy ceiling is refused in the API's words before anything is built", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, "--buy", "0.6"], f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("DEV_BUY_TOO_HIGH")
    expect(out.message).toStartWith(
      "buyAmount exceeds the per-launch dev-buy ceiling of 500000000 lamports for sol on solana",
    )
    expect(writes(f.paths())).toEqual([])
    expect(f.operations()).toEqual([])
  })

  for (const [args, ceiling] of [
    [["--buy", "500.000001", "--quote-asset", "usdc"], "500000000 USDC raw units for usdc"],
    [["--buy", "2000000.000001", "--quote-asset", "cndl"], "2000000000000 CNDL raw units for cndl"],
  ] as const)
    test(`D2: the ceiling for ${args[3]}`, async () => {
      const f = await fixture()
      expect(await run([...launchArgs, ...args], f.deps)).toBe(1)
      expect(humanText(lastJson(f.stdout.text).message)).toContain(humanText(`dev-buy ceiling of ${ceiling} on solana`))
    })

  test("D2: the ceiling reads DEV_BUY_MAX_LAMPORTS as the API does", async () => {
    const f = await fixture({ env: { DEV_BUY_MAX_LAMPORTS: "1000000000" } })
    expect(await run([...launchArgs, "--buy", "0.6"], f.deps)).toBe(0)
    const ignored = await fixture({ env: { DEV_BUY_MAX_LAMPORTS: "0" } })
    expect(await run([...launchArgs, "--buy", "0.6"], ignored.deps)).toBe(1)
    expect(humanText(lastJson(ignored.stdout.text).message)).toContain(humanText("500000000 lamports"))
  })

  test("a buy leg that swaps another amount is refused before anything is signed", async () => {
    const f = await fixture({ legs: { swapRaw: 20_000_000n } })
    expect(await run(buyArgs, f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("INVALID_RESPONSE")
    expect(out.message).toContain("does not swap the confirmed --buy")
    expect(out.message).toContain("Nothing was signed")
    expect(f.paths().some((path) => path.endsWith("/sign"))).toBe(false)
  })

  test("a launch leg paid by another wallet is refused before anything is signed", async () => {
    const f = await fixture({ legs: { launchPayer: Keypair.generate().publicKey.toBase58() } })
    expect(await run(buyArgs, f.deps)).toBe(1)
    expect(humanText(lastJson(f.stdout.text).message)).toContain(humanText("leg 0 is not paid by this wallet"))
    expect(f.paths().some((path) => path.endsWith("/sign"))).toBe(false)
  })

  test("declining the quote signs nothing", async () => {
    const f = await fixture({ prompt: "n" })
    const args = buyArgs.filter((arg) => arg !== "--yes")
    f.deps.isTTY.stdin = true
    expect(await run(args, f.deps)).toBe(0)
    expect(lastJson(f.stdout.text).status).toBe("cancelled")
    expect(humanText(f.stderr.text)).toContain(humanText("Nothing was signed"))
    expect(f.paths().some((path) => path.endsWith("/sign") || path.endsWith("/submit"))).toBe(false)
    // The id is not spent: a re-run builds again under it.
    const before = f.calls.length
    expect(await run(buyArgs, f.deps)).toBe(0)
    expect(f.calls.slice(before).some((call) => call.path === "/api/v1/launch/self/build")).toBe(true)
  })
})

/*
  BE-1806 (spec 2026-10-23-launch-reliability-and-parity-design.md, section 4): the same launch
  inputs as HTTP (--curve-v, --curve-g, --creator-fee-bps on every body), and --dry-run, which sends
  the body the launch would build to that route's dry run and records nothing.
*/
describe("BE-1806: launch inputs and --dry-run", () => {
  const custom = ["--mode", "exp-custom", "--curve-v", "4", "--curve-g", "20", "--creator-fee-bps", "100"]
  const RESOLVED = {
    chain: "solana",
    quoteAsset: "sol",
    mode: "exp-custom",
    stakerAllocationBps: 500,
    creatorFeeBps: 100,
    curve: { virtualQuoteRaw: "4000000000", thresholdRaw: "20000000000" },
    visibility: "production",
  }

  test("candle launch --mode exp-custom --curve-v 4 --curve-g 20 --creator-fee-bps 100 --dry-run prints the preview", async () => {
    const f = await fixture()
    expect(await run([...launchArgs, ...custom, "--dry-run"], f.deps)).toBe(0)
    // The self-signed launch's body, to its dry run, and nothing else: no claim, no build, no signature.
    expect(writes(f.paths())).toEqual([])
    expect(f.paths()).not.toContain("/api/v1/launch/headless/jobs/launch-1")
    const sent = f.calls.find((call) => call.path === "/api/v1/launch/self/dry-run")?.body
    expect(sent).toEqual({
      clientLaunchId: "launch-1",
      chain: "solana",
      buyAmount: 0,
      name: "N".repeat(32),
      symbol: "T".repeat(10),
      imageUrl: "https://example.test/image.png",
      linkedWalletId: "wallet",
      mode: "exp-custom",
      curve: { virtualQuote: "4", threshold: "20" },
      creatorFeeBps: 100,
    })
    expect(f.operations()).toEqual([])
    const printed = lastJson(f.stdout.text)
    expect(printed).toMatchObject({ dryRun: true, clientTradeId: "launch-1", kind: "launch", devBuyMax: "500000000" })
    expect(printed.resolved).toEqual({ ...RESOLVED, dexVersion: null, buyAmount: "0" })
    expect(printed.curveTerms.migration.poolShape).toBe("floor")
    const notes = f.stderr.text
    expect(notes).toContain("Dry run: nothing was built, signed or recorded, and launch id launch-1 is unused.")
    expect(notes).toContain("Curve (exp-custom): raises 20 SOL")
    expect(notes).toContain("First buy (a reference buy): 1 SOL takes 18.6948% of the supply after the curve fee.")
    expect(notes).toContain("Fees: 2% on the curve, 1.5% in the pool after graduation.")
    expect(notes).toContain("Graduation: a floor pool on meteora_damm_v2, opening 0% against the curve's last price")
    expect(notes).toContain("Dev-buy ceiling: 0.5 SOL.")
  })

  test("--dry-run with --buy goes to the atomic dry run with the atomic build's body, and saves no bundle", async () => {
    const f = await fixture()
    expect(await run([...buyArgs, ...custom, "--dry-run"], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path === "/api/v1/launch/self/dry-run")?.body).toEqual({
      clientLaunchId: "launch-1",
      chain: "solana",
      name: "N".repeat(32),
      symbol: "T".repeat(10),
      imageUrl: "https://example.test/image.png",
      mode: "exp-custom",
      curve: { virtualQuote: "4", threshold: "20" },
      creatorFeeBps: 100,
      linkedWalletId: "wallet",
      buyAmount: "10000000",
    })
    expect(writes(f.paths())).toEqual([])
    expect(f.operations()).toEqual([])
    expect(lastJson(f.stdout.text).resolved).toEqual(RESOLVED)
    expect(humanText(f.stderr.text)).toContain(humanText("First buy 1: 0.01 SOL takes 2.1% of the supply."))
  })

  test("the launch itself carries the same curve fields to /launch/self/build", async () => {
    const f = await fixture()
    expect(await run([...buyArgs, ...custom], f.deps)).toBe(0)
    expect(f.calls.find((call) => call.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      mode: "exp-custom",
      curve: { virtualQuote: "4", threshold: "20" },
      creatorFeeBps: 100,
    })
  })

  test("a dry run the API refuses exits 1 with the API's code, and still records nothing", async () => {
    const f = await fixture({
      dryRunError: { status: 400, error: { code: "CURVE_OUT_OF_RANGE", message: "curve.threshold is out of range" } },
    })
    expect(await run([...launchArgs, ...custom, "--dry-run"], f.deps)).toBe(1)
    expect(f.stdout.text + f.stderr.text).toContain("CURVE_OUT_OF_RANGE")
    expect(f.operations()).toEqual([])
  })

  test.each([
    [["--curve-v", "4"], "--curve-v and --curve-g go together"],
    [["--mode", "open", "--curve-v", "4", "--curve-g", "20"], "--curve-v and --curve-g take --mode exp-custom"],
    [["--mode", "exp-custom"], "--mode exp-custom needs --curve-v and --curve-g"],
    [["--mode", "exp-custom", "--curve-v", "4e9", "--curve-g", "20"], "--curve-v takes a whole-unit decimal amount"],
    [["--mode", "exp-a", "--creator-fee-bps", "150"], "--creator-fee-bps takes 0, 100, 200"],
    [["--mode", "open", "--creator-fee-bps", "100"], "--creator-fee-bps takes an exp- --mode"],
  ])("%p is a usage error before any request", async (extra, message) => {
    const f = await fixture()
    expect(await run([...launchArgs, ...extra, "--dry-run"], f.deps)).toBe(2)
    expect(f.stdout.text + f.stderr.text).toContain(message)
    expect(f.calls).toEqual([])
  })

  test("an exp- --buy above 10% of G is refused here in the API's words, before the upload or the claim", async () => {
    const f = await fixture()
    const args = [...launchArgs, "--mode", "exp-custom", "--curve-v", "4", "--curve-g", "2", "--buy", "0.3"]
    expect(await run(args, f.deps)).toBe(1)
    expect(humanText(f.stdout.text + f.stderr.text)).toContain(
      humanText(
        "buyAmount exceeds this launch's dev-buy ceiling of 0.2 SOL (200000000 lamports): at most 0.5 SOL, or 10% of the threshold when that is lower",
      ),
    )
    expect(writes(f.paths())).toEqual([])
    const preset = await fixture()
    expect(await run([...launchArgs, "--mode", "exp-a", "--buy", "0.6"], preset.deps)).toBe(1)
    expect(humanText(preset.stdout.text + preset.stderr.text)).toContain(
      humanText("dev-buy ceiling of 0.5 SOL (500000000 lamports)"),
    )
  })
})
