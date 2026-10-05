/**
 * Ember Phase 4b-2 CLI (BE-394, spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D9).
 *
 * H11, the CLI half: `candle launch --wallet <hood tee>` runs its `createCurve` and fee legs
 * through the D4 leg loop, with `buyAmount` 0 (the dev buy is a separate, gated `candle swap`);
 * `candle transfer` from a Hood TEE wallet sends any token or `max` to the pinned vault and base
 * assets to a trusted linked wallet, one relay-signed leg the CLI checks moves exactly what was
 * confirmed. The wei ceiling, the caps and the destination rules are Candle's (BE-393); here they
 * surface as refusals that sign nothing.
 *
 * The fake relay really signs (the swap-hood.test.ts construction), so the CLI's own check that a
 * signature covers exactly the leg Candle built runs against real bytes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EvmRecordAppendOutcome, EvmRecordTokenEntry } from "../deps"
import {
  bytesToHex,
  encodeErc20Transfer,
  evmAddressFromSecret,
  HOOD_USDG_ADDRESS,
  hexToBigInt,
  hexToBytes,
  signTransaction,
  toChecksumAddress,
} from "../evm-lite"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import type { SequencedLeg } from "../trading"
import { transferLegMoves } from "./transfer"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const teeSecret = hexToBytes(`0x${"11".repeat(32)}`)
const hoodTee = evmAddressFromSecret(teeSecret)
const solanaTee = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const factory = toChecksumAddress("0x4444444444444444444444444444444444444444")
const curve = toChecksumAddress("0x5555555555555555555555555555555555555555")
const launched = toChecksumAddress("0x6666666666666666666666666666666666666666")
const treasury = toChecksumAddress("0x3333333333333333333333333333333333333333")
const vault = toChecksumAddress("0x7777777777777777777777777777777777777777")
const FIVE_ETH = (5n * 10n ** 18n).toString()
const NINE_NINETY_NINE_ETH = (999n * 10n ** 18n).toString()
const trusted = toChecksumAddress("0x8888888888888888888888888888888888888888")
const token = toChecksumAddress("0x1111111111111111111111111111111111111111")
const EVM_RPC = "https://hood.test/rpc"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function leg(nonce: number, to: string, data = "0x", value = "0"): SequencedLeg {
  return {
    chainId: 4663,
    nonce,
    gas: "300000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000",
    to,
    data,
    value,
  }
}

type Outcome = "land" | "revert" | "unconfirmed"

interface FixtureOptions {
  /** The launch's planned legs, by kind, in order. */
  launchLegs?: Array<{ kind: string; leg: SequencedLeg }>
  /** What the transfer build's one leg is; default: exactly what was asked. */
  transferLeg?: (asked: { asset?: string; mint?: string; to: string; amountRaw: string }) => SequencedLeg
  /** What /transfer/build answers for `max`. */
  maxAmount?: string
  outcomes?: Outcome[]
  /** A deployment without the sequenced rail: the Hood build answers the caller-broadcast shape. */
  unsequenced?: boolean
  /** A Candle error the build answers instead. */
  buildError?: { code: string; message: string; field?: string }
  rows?: Array<"hood" | "solana">
  scopes?: string[]
  prompt?: string
  /** What the launch jobs read answers once a build exists. */
  job?: Record<string, unknown>
  vaultDestination?: string
  appendEvmRecord?: (entry: EvmRecordTokenEntry) => Promise<EvmRecordAppendOutcome>
  /** Overrides on the Hood launch build body. */
  launchBuild?: Record<string, unknown>
  finalMint?: string | null
  /**
   * `plannedLegCount` on the sequenced body at each index. Default: the plan's length. A later
   * index can change it, which the leg loop must refuse.
   */
  plannedLegCountAt?: (index: number) => number
  /**
   * After the planned legs have landed, the submit answers one more sequenced leg instead of the
   * final result. `plannedLegCount` defaults to the original plan's length, so the server can
   * offer another leg without raising the count the CLI accepted.
   */
  trailingLeg?: { kind: string; leg: SequencedLeg; plannedLegCount?: number }
}

async function fixture(opts: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-hood-4b2-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined; url: string }[] = []
  let planned: Array<{ kind: string; leg: SequencedLeg }> = []
  const outcomes = [...(opts.outcomes ?? [])]
  const landed: Array<{ kind: string; hash: string }> = []
  let index = 0
  let built = false
  let trailed = false
  const sequenced = (i: number) => ({
    mode: "sequenced",
    operationId: "op-1",
    legKind: planned[i]?.kind,
    legIndex: i,
    plannedLegCount: opts.plannedLegCountAt ? opts.plannedLegCountAt(i) : planned.length,
    nextLeg: planned[i]?.leg,
    landedLegs: [...landed],
    expiresAt: 10_000,
  })
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, url })
    const ok = (value: unknown) => Response.json(value)
    const candleError = (error: Record<string, unknown>, status = 400) =>
      Response.json({ success: false, error }, { status })
    if (url.startsWith(EVM_RPC)) {
      const selector = body.method === "eth_call" ? String(body.params[0].data).slice(0, 10) : ""
      const result = selector === "0x313ce567" ? `0x${"0".repeat(62)}12` : "0x0"
      return ok({ jsonrpc: "2.0", id: body.id, result })
    }
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return built && opts.job
        ? ok({ success: true, job: opts.job })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["launch:write", "transfer:write", "transfer:bound"],
        privyAppId: "app",
        page: (opts.rows ?? ["hood"]).map((chain) =>
          chain === "hood"
            ? {
                id: "hood-tee",
                address: hoodTee,
                label: "hood",
                chain: "evm",
                active: true,
                allowLaunch: true,
                privyWalletId: "privy-hood",
              }
            : {
                id: "sol-tee",
                address: solanaTee,
                label: "sol",
                chain: "solana",
                active: true,
                allowLaunch: true,
                privyWalletId: "privy-sol",
              },
        ),
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded") return ok({ success: true, wallets: { solana: null, evm: null } })
    if (path === "/api/v1/agent/wallets")
      return ok({
        success: true,
        page: [
          { _id: "hood-tee", address: hoodTee, label: "hood", chain: "evm" },
          { _id: "lw-trusted", address: trusted.toLowerCase(), label: "cold", chain: "evm" },
          { _id: "lw-sol", address: solanaTee, label: "sol-treasury", chain: "solana" },
        ],
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/hood-tee/lifecycle")
      return ok({ state: "enabled", vaultDestination: opts.vaultDestination ?? vault.toLowerCase() })
    if (path === "/api/v1/launch/self/build") {
      if (opts.buildError) return candleError(opts.buildError, 403)
      built = true
      if (opts.unsequenced)
        return ok({
          success: true,
          transaction: { to: factory, data: "0x1234" },
          curveAddress: curve,
          clientLaunchId: body.clientLaunchId,
          expiresAt: 10_000,
          walletAddress: hoodTee,
        })
      planned = opts.launchLegs ?? [
        { kind: "createCurve", leg: leg(3, factory, "0xc0ffee") },
        { kind: "feeTransfer", leg: leg(4, treasury, "0x", "5000") },
      ]
      return ok({
        success: true,
        status: "built",
        chain: "hood",
        clientLaunchId: body.clientLaunchId,
        curveAddress: curve,
        walletAddress: hoodTee,
        ...sequenced(0),
        ...(opts.launchBuild ?? {}),
      })
    }
    if (path === "/api/v1/agent/transfer/build") {
      if (opts.buildError) return candleError(opts.buildError, 403)
      if (opts.unsequenced)
        return ok({ success: true, transferId: "tr-1", payerAddress: hoodTee, unsignedTransactionsBase64: ["x"] })
      const amountRaw = body.amountRaw === "max" ? (opts.maxAmount ?? "900000000000000000") : body.amountRaw
      const asked = { asset: body.asset, mint: body.mint, to: body.to, amountRaw }
      const erc20 = body.asset === "USDG" ? HOOD_USDG_ADDRESS : body.mint
      planned = [
        {
          kind: "transfer",
          leg: opts.transferLeg
            ? opts.transferLeg(asked)
            : erc20
              ? leg(5, toChecksumAddress(erc20), bytesToHex(encodeErc20Transfer(body.to, BigInt(amountRaw))))
              : leg(5, body.to, "0x", amountRaw),
        },
      ]
      return ok({
        success: true,
        transferId: "tr-1",
        walletId: "hood-tee",
        payerAddress: hoodTee,
        chain: "hood",
        asset: body.asset ?? body.mint,
        amountRaw,
        destinationClass: "own",
        destinationKind: String(body.to).toLowerCase() === vault.toLowerCase() ? "vault" : "linked",
        ...sequenced(0),
      })
    }
    if (path.endsWith("/sign")) {
      const wire = body.body.params.transaction
      const tx = {
        chainId: BigInt(wire.chain_id),
        nonce: BigInt(wire.nonce),
        maxPriorityFeePerGas: hexToBigInt(wire.max_priority_fee_per_gas),
        maxFeePerGas: hexToBigInt(wire.max_fee_per_gas),
        gas: hexToBigInt(wire.gas_limit),
        to: wire.to,
        value: hexToBigInt(wire.value),
        data: hexToBytes(wire.data),
      }
      return ok({ success: true, signedTransaction: bytesToHex(signTransaction(tx, teeSecret).raw), encoding: "rlp" })
    }
    if (path === "/api/v1/launch/self/confirm" || path === "/api/v1/agent/transfer/submit") {
      const launch = path.includes("launch")
      if (body.signedTransaction === undefined) {
        // Recovery (launch only): recorded from the legs the server sent.
        return ok({ success: true, chain: "hood", mint: launched, pool: curve, signature: `0x${"1".repeat(64)}` })
      }
      const current = planned[index]
      const outcome = outcomes.shift() ?? "land"
      const hash = `0x${String(index + 1).repeat(64)}`
      const code = launch ? "LAUNCH_FAILED" : "TRANSFER_FAILED"
      if (outcome === "revert")
        return candleError({ code, message: "reverted", stage: "reverted", signature: hash, landedLegs: landed })
      if (outcome === "unconfirmed")
        return candleError(
          {
            code,
            message: "no receipt",
            stage: "unconfirmed",
            signature: hash,
            landedLegs: landed,
            operationId: "op-1",
          },
          500,
        )
      landed.push({ kind: current?.kind as string, hash })
      index += 1
      if (index < planned.length)
        return ok({
          success: true,
          status: "built",
          chain: "hood",
          ...(launch ? { clientLaunchId: body.clientLaunchId, curveAddress: curve } : { transferId: "tr-1" }),
          ...sequenced(index),
        })
      if (opts.trailingLeg && !trailed) {
        trailed = true
        return ok({
          success: true,
          status: "built",
          chain: "hood",
          ...(launch ? { clientLaunchId: body.clientLaunchId, curveAddress: curve } : { transferId: "tr-1" }),
          mode: "sequenced",
          operationId: "op-1",
          legKind: opts.trailingLeg.kind,
          legIndex: index,
          plannedLegCount: opts.trailingLeg.plannedLegCount ?? planned.length,
          nextLeg: opts.trailingLeg.leg,
          landedLegs: [...landed],
          expiresAt: 10_000,
        })
      }
      return ok(
        launch
          ? {
              success: true,
              chain: "hood",
              ...(opts.finalMint === null ? {} : { mint: opts.finalMint ?? launched }),
              pool: curve,
              signature: landed[0]?.hash,
            }
          : {
              success: true,
              chain: "hood",
              signature: hash,
              from: hoodTee,
              destinationClass: "own",
              operationId: "op-1",
            },
      )
    }
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const appended: EvmRecordTokenEntry[] = []
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_EVM_RPC_URL: EVM_RPC },
    store: createFakeStore({
      "wallet_signer_hood-tee": pemToStoredSigner(pem),
      "wallet_signer_sol-tee": pemToStoredSigner(pem),
    }),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
    ...(opts.appendEvmRecord
      ? {
          appendEvmRecord: async (_ctx, entry) => {
            appended.push(entry)
            return (opts.appendEvmRecord as NonNullable<FixtureOptions["appendEvmRecord"]>)(entry)
          },
        }
      : {}),
  })
  return { deps, calls, stdout, stderr, appended }
}

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}
const paths = (calls: { path: string }[]) => calls.map((call) => call.path)
const signs = <T extends { path: string }>(calls: T[]) => calls.filter((call) => call.path.endsWith("/sign"))
const builds = <T extends { path: string }>(calls: T[]) => calls.filter((call) => call.path.endsWith("/build"))
const WIRE_KEYS = [
  "chain_id",
  "data",
  "from",
  "gas_limit",
  "max_fee_per_gas",
  "max_priority_fee_per_gas",
  "nonce",
  "to",
  "type",
  "value",
]

const launchArgs = (extra: string[] = []) => [
  "launch",
  "--name",
  "Demo",
  "--symbol",
  "DEMO",
  "--image-url",
  "https://example.com/d.png",
  "--client-trade-id",
  "hl-1",
  "--yes",
  "--json",
  ...extra,
]
const hoodLaunch = (extra: string[] = []) => launchArgs(["--wallet", "hood", "--dex-version", "v4", ...extra])

describe("H11: candle launch from a Hood TEE wallet", () => {
  test("createCurve then the fee, each relay-signed with eth_signTransaction and confirmed alone; the launched token is recorded", async () => {
    const f = await fixture({ appendEvmRecord: async () => ({ appended: true }) })
    expect(await run(hoodLaunch(), f.deps)).toBe(0)
    const build = builds(f.calls)
    expect(build).toHaveLength(1)
    expect(build[0]?.path).toBe("/api/v1/launch/self/build")
    expect(build[0]?.body).toEqual({
      clientLaunchId: "hl-1",
      chain: "hood",
      buyAmount: 0,
      name: "Demo",
      symbol: "DEMO",
      imageUrl: "https://example.com/d.png",
      linkedWalletId: "hood-tee",
      dexVersion: "v4",
    })
    const signed = signs(f.calls)
    expect(signed).toHaveLength(2)
    for (const [i, sign] of signed.entries()) {
      const relay = sign.body as { body: { method: string; params: { transaction: Record<string, unknown> } } }
      expect(sign.path).toBe("/api/v1/agent/wallets/hood-tee/sign")
      expect(relay.body.method).toBe("eth_signTransaction")
      expect(Object.keys(relay.body.params.transaction)).toEqual(WIRE_KEYS)
      expect(relay.body.params.transaction).toMatchObject({ chain_id: 4663, type: 2, nonce: 3 + i, from: hoodTee })
    }
    const confirms = f.calls.filter((call) => call.path === "/api/v1/launch/self/confirm")
    expect(confirms).toHaveLength(2)
    for (const confirm of confirms) {
      expect(Object.keys(confirm.body ?? {}).sort()).toEqual(["clientLaunchId", "operationId", "signedTransaction"])
      expect(confirm.body).toMatchObject({ clientLaunchId: "hl-1", operationId: "op-1" })
    }
    // Sign one, send one: the fee leg is signed only after the curve's confirm answered.
    const order = f.calls
      .filter((call) => call.path.endsWith("/sign") || call.path.endsWith("/confirm"))
      .map((call) => call.path.split("/").at(-1))
    expect(order).toEqual(["sign", "confirm", "sign", "confirm"])
    const result = lastJson(f.stdout.text)
    expect(result).toMatchObject({ mint: launched, chain: "hood", kind: "launch", operationId: "op-1" })
    expect((result.landedLegs as Array<{ kind: string }>).map((l) => l.kind)).toEqual(["createCurve", "feeTransfer"])
    expect(f.appended).toEqual([{ kind: "token", wallet: hoodTee, token: launched }])
    expect(result.evmRecord).toEqual({ token: launched, notices: [] })
    // Nothing is read or sent over any RPC: Candle sets nonces and fees, broadcasts, and reads receipts.
    expect(f.calls.some((call) => call.url.startsWith(EVM_RPC))).toBe(false)
  })

  test("the dev buy is not part of the launch: buyAmount is 0, no trade is built, and the quote says to swap", async () => {
    const f = await fixture()
    expect(await run(hoodLaunch(["--quote-asset", "USDG"]), f.deps)).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ buyAmount: 0, quoteAsset: "usdg" })
    expect(paths(f.calls).some((path) => path.includes("/trade/") || path.includes("/swap/"))).toBe(false)
    expect(f.stderr.text).toContain("Make the first buy with a separate candle swap")
    expect(f.stderr.text).toContain("Legs, signed one at a time: create curve, fee")
    expect(f.stderr.text).toContain("Gas: the createCurve leg up to 0.0006 ETH")
    expect(f.stderr.text).toContain("Gas reserve: at least")
    expect(f.stderr.text).not.toContain("Tier fee")
  })

  const ONE_MILLI_ETH = (10n ** 15n).toString()
  const buyLegs = (value = ONE_MILLI_ETH, to = curve) => [
    { kind: "createCurve", leg: leg(3, factory, "0xc0ffee") },
    { kind: "feeTransfer", leg: leg(4, treasury, "0x", "5000") },
    { kind: "trade", leg: leg(5, to, "0xd96a094a", value) },
  ]

  test("BE-869: --buy sends the buy in wei; Candle's buy leg is signed last, to the curve, for exactly that amount", async () => {
    const f = await fixture({ launchLegs: buyLegs(), appendEvmRecord: async () => ({ appended: true }) })
    expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ chain: "hood", buyAmount: ONE_MILLI_ETH, dexVersion: "v4" })
    expect(f.stderr.text).toContain("with a first buy of 0.001000000000000000 ETH")
    expect(f.stderr.text).toContain("Legs, signed one at a time: create curve, fee, first buy")
    expect(f.stderr.text).toContain("spends 0.001000000000000000 ETH on a first buy on the new curve")
    expect(f.stderr.text).toContain("the later legs are priced by Candle")
    expect(f.stderr.text).toContain("If the buy leg never lands, the token exists with no first buy")
    expect(f.stderr.text).not.toContain("separate candle swap")
    const signed = signs(f.calls)
    expect(signed).toHaveLength(3)
    const last = (signed[2]?.body as { body: { params: { transaction: Record<string, unknown> } } }).body.params
      .transaction
    expect(last).toMatchObject({ nonce: 5, to: curve, value: "0x38d7ea4c68000" })
    const result = lastJson(f.stdout.text)
    expect((result.landedLegs as Array<{ kind: string }>).map((l) => l.kind)).toEqual([
      "createCurve",
      "feeTransfer",
      "trade",
    ])
  })

  const wrongBuys: Array<[string, ReturnType<typeof buyLegs>]> = [
    ["another amount", buyLegs("2000000000000000")],
    ["another address", buyLegs(ONE_MILLI_ETH, treasury)],
  ]
  for (const [name, legs] of wrongBuys)
    test(`BE-869: a buy leg to ${name} is never signed; the curve and fee legs that landed are listed`, async () => {
      const f = await fixture({ launchLegs: legs })
      expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(1)
      const failure = lastJson(f.stdout.text)
      expect(failure.code).toBe("INVALID_RESPONSE")
      expect(String(failure.message)).toContain("Landed: createCurve")
      expect(signs(f.calls)).toHaveLength(2)
    })

  const curveLeg = { kind: "createCurve", leg: leg(3, factory, "0xc0ffee") }
  const feeLeg = { kind: "feeTransfer", leg: leg(4, treasury, "0x", "5000") }
  const tradeLeg = (nonce = 5) => ({ kind: "trade", leg: leg(nonce, curve, "0xd96a094a", ONE_MILLI_ETH) })

  test("BE-869: a two-leg plan with --buy is the curve then the buy, and lands", async () => {
    const f = await fixture({ launchLegs: [curveLeg, tradeLeg(4)] })
    expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(0)
    expect(signs(f.calls)).toHaveLength(2)
    expect((lastJson(f.stdout.text).landedLegs as Array<{ kind: string }>).map((l) => l.kind)).toEqual([
      "createCurve",
      "trade",
    ])
  })

  const wrongOrders: Array<[string, FixtureOptions, number, string]> = [
    ["a fee-only two-leg plan", { launchLegs: [curveLeg, feeLeg] }, 1, "createCurve"],
    ["a fee after the buy", { launchLegs: [curveLeg, tradeLeg(4), feeLeg] }, 1, "createCurve"],
    [
      "a buy before the fee",
      { launchLegs: [curveLeg, tradeLeg(4), feeLeg], plannedLegCountAt: () => 3 },
      1,
      "createCurve",
    ],
  ]
  for (const [name, options, signed, landedKind] of wrongOrders)
    test(`BE-869: ${name} with --buy is not signed past the confirmed sequence`, async () => {
      const f = await fixture(options)
      expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(1)
      const failure = lastJson(f.stdout.text)
      expect(failure.code).toBe("INVALID_RESPONSE")
      expect(String(failure.message)).toContain(`Landed: ${landedKind}`)
      expect(signs(f.calls)).toHaveLength(signed)
    })

  test("BE-869: a final answer before the buy landed is rejected with the landed curve and fee listed", async () => {
    const f = await fixture({ launchLegs: [curveLeg, feeLeg], plannedLegCountAt: () => 3 })
    expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain("createCurve")
    expect(String(failure.message)).toContain("feeTransfer")
    expect(signs(f.calls)).toHaveLength(2)
  })

  test("BE-869: a final answer right after the curve in a three-leg plan is rejected", async () => {
    const f = await fixture({ launchLegs: [curveLeg], plannedLegCountAt: () => 3 })
    expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain("Landed: createCurve")
    expect(signs(f.calls)).toHaveLength(1)
  })

  test("BE-869: without --buy a buy leg is never signed", async () => {
    const f = await fixture({ launchLegs: buyLegs() })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(signs(f.calls)).toEqual([])
  })

  test("BE-869: a server that refuses a TEE first buy is told plainly: TEE_LAUNCH_BUYS_ENABLED, nothing signed", async () => {
    const f = await fixture({
      buildError: {
        code: "VALIDATION_FAILED",
        message: "A TEE wallet launches with buyAmount 0; buy the new token with a separate swap once it lands",
        field: "buyAmount",
      },
    })
    expect(await run(hoodLaunch(["--buy", "0.001"]), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("VALIDATION_FAILED")
    expect(String(failure.message)).toContain("TEE_LAUNCH_BUYS_ENABLED")
    expect(String(failure.suggestion)).toContain("candle swap")
    expect(signs(f.calls)).toEqual([])
  })

  test("a single-leg launch (no fee) signs one leg and records the token", async () => {
    const f = await fixture({ launchLegs: [{ kind: "createCurve", leg: leg(3, factory, "0xc0ffee") }] })
    expect(await run(hoodLaunch(), f.deps)).toBe(0)
    expect(signs(f.calls)).toHaveLength(1)
    expect(f.stderr.text).toContain("Legs, signed one at a time: create curve\n")
    expect(f.stderr.text).toContain("no sealed EVM record writer")
  })

  const beforeAnyRequest: Array<[string, string[]]> = [
    ["a 0x --wallet with a Solana quote asset", ["--wallet", hoodTee, "--quote-asset", "sol", "--dex-version", "v4"]],
    ["--dex-version with a Solana quote asset", ["--wallet", "hood", "--quote-asset", "usdc", "--dex-version", "v3"]],
  ]
  for (const [name, extra] of beforeAnyRequest) {
    test(`${name} is CHAIN_MISMATCH before any request`, async () => {
      const f = await fixture()
      expect(await run(launchArgs(extra), f.deps)).toBe(1)
      expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
      expect(f.calls).toEqual([])
    })
  }

  test("a 0x --wallet without --dex-version is a usage refusal before any request", async () => {
    const f = await fixture()
    expect(await run(launchArgs(["--wallet", hoodTee]), f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(await run(launchArgs(["--wallet", "hood", "--dex-version", "v5"]), f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })

  test("a Hood TEE wallet named by label without --dex-version is a usage refusal after the listing, before any build", async () => {
    const f = await fixture()
    expect(await run(launchArgs(["--wallet", "hood"]), f.deps)).toBe(2)
    expect(builds(f.calls)).toEqual([])
    expect(f.stdout.text).toContain("--dex-version")
  })

  test("the wallet decides: a Solana TEE wallet with --dex-version, or a Hood one with a Solana quote, is CHAIN_MISMATCH before any build", async () => {
    const sol = await fixture({ rows: ["hood", "solana"] })
    expect(await run(launchArgs(["--wallet", "sol", "--dex-version", "v4"]), sol.deps)).toBe(1)
    expect(lastJson(sol.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(sol.calls)).toEqual([])
    const hood = await fixture({ rows: ["hood", "solana"] })
    expect(await run(launchArgs(["--wallet", "hood", "--quote-asset", "cndl"]), hood.deps)).toBe(1)
    expect(lastJson(hood.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(hood.calls)).toEqual([])
  })

  test("a deployment without the sequenced launch rail never has a Hood TEE leg signed", async () => {
    const f = await fixture({ unsequenced: true })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("SEQUENCED_RAIL_REQUIRED")
    expect(signs(f.calls)).toEqual([])
  })

  test("a build that names another payer, or starts with anything but createCurve, is never signed", async () => {
    const other = await fixture({ launchBuild: { walletAddress: treasury } })
    expect(await run(hoodLaunch(), other.deps)).toBe(1)
    expect(lastJson(other.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(signs(other.calls)).toEqual([])
    const fee = await fixture({ launchLegs: [{ kind: "feeTransfer", leg: leg(3, treasury, "0x", "5") }] })
    expect(await run(hoodLaunch(), fee.deps)).toBe(1)
    expect(lastJson(fee.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(signs(fee.calls)).toEqual([])
  })

  test("a later leg of a kind a launch never signs is refused, and the landed curve is listed", async () => {
    const f = await fixture({
      launchLegs: [
        { kind: "createCurve", leg: leg(3, factory, "0xc0ffee") },
        { kind: "transfer", leg: leg(4, treasury, "0x", "5") },
      ],
    })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain("Landed: createCurve")
    expect(signs(f.calls)).toHaveLength(1)
  })

  test("a second createCurve after a one-leg launch is not signed, and the landed curve is listed", async () => {
    const f = await fixture({
      launchLegs: [{ kind: "createCurve", leg: leg(3, factory, "0xc0ffee") }],
      trailingLeg: {
        kind: "createCurve",
        plannedLegCount: 1,
        leg: leg(4, treasury, "0x", FIVE_ETH),
      },
    })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain(`Landed: createCurve 0x${"1".repeat(64)}`)
    const signed = signs(f.calls)
    expect(signed).toHaveLength(1)
    const relay = signed[0]?.body as { body: { params: { transaction: Record<string, unknown> } } }
    expect(relay.body.params.transaction).toMatchObject({ to: factory, value: "0x0" })
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/self/confirm")).toHaveLength(1)
  })

  test("a later body that changes plannedLegCount is not signed, and the landed curve is listed", async () => {
    const f = await fixture({
      plannedLegCountAt: (index) => (index === 0 ? 2 : 3),
    })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain("planned leg count")
    expect(String(failure.message)).toContain(`Landed: createCurve 0x${"1".repeat(64)}`)
    expect(signs(f.calls)).toHaveLength(1)
  })

  test("a second createCurve inside a two-leg plan is not signed, and the landed curve is listed", async () => {
    const f = await fixture({
      launchLegs: [
        { kind: "createCurve", leg: leg(3, factory, "0xc0ffee") },
        { kind: "createCurve", leg: leg(4, treasury, "0x", FIVE_ETH) },
      ],
    })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain(`Landed: createCurve 0x${"1".repeat(64)}`)
    expect(signs(f.calls)).toHaveLength(1)
    expect(f.calls.filter((call) => call.path === "/api/v1/launch/self/confirm")).toHaveLength(1)
  })

  test("a createCurve leg that carries ETH is not signed", async () => {
    const f = await fixture({
      launchLegs: [{ kind: "createCurve", leg: leg(3, factory, "0xc0ffee", FIVE_ETH) }],
    })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(String(lastJson(f.stdout.text).message)).toContain("No leg landed.")
    expect(signs(f.calls)).toEqual([])
  })

  test("declining signs nothing and says the build holds the wallet", async () => {
    const f = await fixture({ prompt: "n" })
    f.deps.isTTY.stdin = true
    expect(
      await run(
        hoodLaunch().filter((arg) => arg !== "--yes"),
        f.deps,
      ),
    ).toBe(0)
    expect(signs(f.calls)).toEqual([])
    expect(lastJson(f.stdout.text)).toMatchObject({ status: "cancelled", operationId: "op-1", walletHeldUntil: 10_000 })
    expect(f.stderr.text).toContain("WALLET_BUSY")
  })

  test("a reverted createCurve exits 1 with no landed legs; the fee is never signed", async () => {
    const f = await fixture({ outcomes: ["revert"] })
    expect(await run(hoodLaunch(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("LAUNCH_FAILED")
    expect(String(failure.message)).toContain("No leg landed.")
    expect(signs(f.calls)).toHaveLength(1)
  })

  test("an uncertain leg exits 3 with its hash; a re-run while the operation holds the wallet posts nothing; after it lets go, the re-run records from the legs Candle sent", async () => {
    const job = { status: "submitted", operation: { operationId: "op-1", status: "active", expiresAt: 10_000 } }
    const f = await fixture({ outcomes: ["unconfirmed"], job })
    expect(await run(hoodLaunch(), f.deps)).toBe(3)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("LEG_UNCONFIRMED")
    expect((failure.details as { hash: string }).hash).toBe(`0x${"1".repeat(64)}`)
    expect(String(failure.message)).toContain("candle swap status hl-1")

    const before = f.calls.length
    expect(await run(hoodLaunch(), f.deps)).toBe(3)
    expect(lastJson(f.stdout.text).code).toBe("OPERATION_IN_FLIGHT")
    expect(paths(f.calls.slice(before))).toEqual(["/api/v1/launch/headless/jobs/hl-1"])

    job.operation.status = "expired"
    const again = f.calls.length
    expect(await run(hoodLaunch(), f.deps)).toBe(0)
    const resumed = f.calls.slice(again)
    expect(paths(resumed)).toEqual(["/api/v1/launch/headless/jobs/hl-1", "/api/v1/launch/self/confirm"])
    expect(resumed[1]?.body).toEqual({ clientLaunchId: "hl-1", operationId: "op-1" })
    expect(lastJson(f.stdout.text)).toMatchObject({ mint: launched, operationId: "op-1" })
  })

  test("a final answer that names no token lands the launch and prints a record notice", async () => {
    const f = await fixture({ finalMint: null, appendEvmRecord: async () => ({ appended: true }) })
    expect(await run(hoodLaunch(), f.deps)).toBe(0)
    expect(f.appended).toEqual([])
    expect(f.stderr.text).toContain("did not name the launched token")
  })

  test("a Solana TEE launch is unchanged: chain solana, no dexVersion, the Solana rail", async () => {
    const f = await fixture({ rows: ["solana"], buildError: { code: "STOP", message: "stop here" } })
    expect(await run(launchArgs(["--wallet", "sol"]), f.deps)).toBe(1)
    const build = builds(f.calls)[0]
    expect(build?.body).toMatchObject({ chain: "solana", buyAmount: 0, linkedWalletId: "sol-tee" })
    expect(build?.body).not.toHaveProperty("dexVersion")
  })
})

const transferArgs = (extra: string[]) => ["transfer", "--wallet", "hood", "--yes", "--json", ...extra]

describe("H11: candle transfer from a Hood TEE wallet", () => {
  test("to the vault, ETH max: one transfer leg of the built amount to the pinned vault, relay-signed and submitted alone", async () => {
    const f = await fixture()
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "max"]), f.deps)).toBe(0)
    expect(builds(f.calls)[0]?.body).toEqual({
      walletId: "hood-tee",
      chain: "hood",
      asset: "ETH",
      amountRaw: "max",
      to: vault,
    })
    const signed = signs(f.calls)
    expect(signed).toHaveLength(1)
    const relay = signed[0]?.body as { body: { method: string; params: { transaction: Record<string, unknown> } } }
    expect(relay.body.method).toBe("eth_signTransaction")
    expect(Object.keys(relay.body.params.transaction)).toEqual(WIRE_KEYS)
    expect(relay.body.params.transaction).toMatchObject({ to: vault, data: "0x", from: hoodTee })
    const submit = f.calls.find((call) => call.path === "/api/v1/agent/transfer/submit")
    expect(Object.keys(submit?.body ?? {}).sort()).toEqual(["operationId", "signedTransaction", "transferId"])
    expect(submit?.body).toMatchObject({ transferId: "tr-1", operationId: "op-1" })
    const receipt = lastJson(f.stdout.text)
    expect(receipt).toMatchObject({
      chain: "hood",
      transferId: "tr-1",
      destination: { kind: "vault", address: vault },
      destinationKind: "vault",
      signature: `0x${"1".repeat(64)}`,
    })
    expect((receipt.landedLegs as Array<{ kind: string }>).map((l) => l.kind)).toEqual(["transfer"])
    expect(f.stderr.text).toContain("Built transfer tr-1: 0.900000000000000000 ETH to the vault")
    expect(f.stderr.text).toContain("sweep-home gas reserve")
    expect(f.calls.some((call) => call.url.startsWith(EVM_RPC))).toBe(false)
  })

  test("to the vault, any token: --token reads its decimals over the Hood RPC and the leg is that token's transfer", async () => {
    const f = await fixture()
    expect(await run(transferArgs(["--to", "vault", "--token", token.toLowerCase(), "--amount", "1.5"]), f.deps)).toBe(
      0,
    )
    expect(builds(f.calls)[0]?.body).toEqual({
      walletId: "hood-tee",
      chain: "hood",
      mint: token,
      amountRaw: "1500000000000000000",
      to: vault,
    })
    const relay = signs(f.calls)[0]?.body as { body: { params: { transaction: Record<string, unknown> } } }
    expect(relay.body.params.transaction).toMatchObject({ to: token, value: "0x0" })
    expect(f.stderr.text).toContain("Reading from hood.test")
  })

  test("to a trusted linked wallet by label: USDG at its six decimals, to that wallet's address", async () => {
    const f = await fixture()
    expect(await run(transferArgs(["--to", "cold", "--asset", "USDG", "--amount", "250"]), f.deps)).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ asset: "USDG", amountRaw: "250000000", to: trusted.toLowerCase() })
    expect(f.stderr.text).toContain(`linked wallet cold (lw-trusted, ${trusted.toLowerCase()})`)
    expect(lastJson(f.stdout.text).destinationKind).toBe("linked")
  })

  const refusedByCandle: Array<[string, string[], string]> = [
    ["a token to a linked wallet", ["--to", "cold", "--token", token, "--amount", "1"], "TRANSFER_ASSET_NOT_SUPPORTED"],
    ["ETH over the key's cap", ["--to", "cold", "--asset", "ETH", "--amount", "5"], "SPEND_LIMIT_EXCEEDED"],
    ["ETH over the wei ceiling", ["--to", "vault", "--asset", "ETH", "--amount", "11"], "SPEND_LIMIT_EXCEEDED"],
    [
      "an address that is not the vault or trusted",
      ["--to", treasury, "--asset", "ETH", "--amount", "1"],
      "TRANSFER_DESTINATION_NOT_APPROVED",
    ],
  ]
  for (const [name, extra, code] of refusedByCandle) {
    test(`${name}: Candle's ${code} passes through and nothing is signed`, async () => {
      const f = await fixture({ buildError: { code, message: "refused" } })
      expect(await run(transferArgs(extra), f.deps)).toBe(1)
      expect(lastJson(f.stdout.text).code).toBe(code)
      expect(builds(f.calls)).toHaveLength(1)
      expect(signs(f.calls)).toEqual([])
    })
  }

  test("a leg that moves another amount, to another address, or ETH with a token send is never signed", async () => {
    const wrongTo = await fixture({ transferLeg: (asked) => leg(5, treasury, "0x", asked.amountRaw) })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), wrongTo.deps)).toBe(1)
    expect(lastJson(wrongTo.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(signs(wrongTo.calls)).toEqual([])
    const wrongAmount = await fixture({ transferLeg: (asked) => leg(5, asked.to, "0x", "2") })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), wrongAmount.deps)).toBe(1)
    expect(signs(wrongAmount.calls)).toEqual([])
  })

  test("a second transfer leg after the confirmed one is not signed, and the landed leg is listed", async () => {
    const f = await fixture({
      trailingLeg: {
        kind: "transfer",
        plannedLegCount: 1,
        leg: leg(6, treasury, "0x", NINE_NINETY_NINE_ETH),
      },
    })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("INVALID_RESPONSE")
    expect(String(failure.message)).toContain(`Landed: transfer 0x${"1".repeat(64)}`)
    const signed = signs(f.calls)
    expect(signed).toHaveLength(1)
    const relay = signed[0]?.body as { body: { params: { transaction: Record<string, unknown> } } }
    expect(relay.body.params.transaction).toMatchObject({ to: vault, data: "0x", value: "0xde0b6b3a7640000" })
    expect(f.calls.filter((call) => call.path === "/api/v1/agent/transfer/submit")).toHaveLength(1)
  })

  test("transferLegMoves: exactly this amount of this asset to this address, nothing else", () => {
    const amount = "1000"
    const data = bytesToHex(encodeErc20Transfer(vault, 1000n))
    const eth = { token: null, to: vault, amountRaw: amount }
    const erc20 = { token, to: vault, amountRaw: amount }
    expect(transferLegMoves(leg(1, vault.toLowerCase(), "0x", amount), eth)).toBe(true)
    expect(transferLegMoves(leg(1, vault, "0x00", amount), eth)).toBe(false)
    expect(transferLegMoves(leg(1, vault, "0x", "1001"), eth)).toBe(false)
    expect(transferLegMoves(leg(1, trusted, "0x", amount), eth)).toBe(false)
    expect(transferLegMoves(leg(1, token, data), erc20)).toBe(true)
    expect(transferLegMoves(leg(1, token, data, "1"), erc20)).toBe(false)
    expect(transferLegMoves(leg(1, trusted, data), erc20)).toBe(false)
    expect(transferLegMoves(leg(1, token, bytesToHex(encodeErc20Transfer(trusted, 1000n))), erc20)).toBe(false)
    expect(transferLegMoves(leg(1, token, bytesToHex(encodeErc20Transfer(vault, 999n))), erc20)).toBe(false)
    expect(transferLegMoves(leg(1, token, `0x095ea7b3${data.slice(10)}`), erc20)).toBe(false)
  })

  test("a deployment without the sequenced transfer rail never has a Hood TEE leg signed", async () => {
    const f = await fixture({ unsequenced: true })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("SEQUENCED_RAIL_REQUIRED")
    expect(signs(f.calls)).toEqual([])
  })

  test("a reverted leg exits 1; an uncertain one exits 3 with its hash and resends nothing", async () => {
    const reverted = await fixture({ outcomes: ["revert"] })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), reverted.deps)).toBe(1)
    expect(lastJson(reverted.stdout.text).code).toBe("TRANSFER_FAILED")
    const uncertain = await fixture({ outcomes: ["unconfirmed"] })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), uncertain.deps)).toBe(3)
    const failure = lastJson(uncertain.stdout.text)
    expect(failure.code).toBe("LEG_UNCONFIRMED")
    expect((failure.details as { hash: string; operationId: string }).operationId).toBe("op-1")
    expect(uncertain.calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(1)
  })

  test("without transfer:bound the key is SCOPE_MISSING before any build", async () => {
    const f = await fixture({ scopes: ["transfer:write"] })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("SCOPE_MISSING")
    expect(builds(f.calls)).toEqual([])
  })

  test("destinations: a Solana address, the source itself, or a vault pin that is not EVM is refused before any build", async () => {
    const sol = await fixture()
    expect(
      await run(transferArgs(["--to", solanaTee.replace("7", "9"), "--asset", "ETH", "--amount", "1"]), sol.deps),
    ).toBe(1)
    expect(lastJson(sol.stdout.text).code).toBe("DESTINATION_UNKNOWN")
    expect(builds(sol.calls)).toEqual([])
    const self = await fixture()
    expect(await run(transferArgs(["--to", hoodTee.toLowerCase(), "--asset", "ETH", "--amount", "1"]), self.deps)).toBe(
      1,
    )
    expect(lastJson(self.stdout.text).code).toBe("DESTINATION_IS_SOURCE")
    const pin = await fixture({ vaultDestination: solanaTee })
    expect(await run(transferArgs(["--to", "vault", "--asset", "ETH", "--amount", "1"]), pin.deps)).toBe(1)
    expect(lastJson(pin.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(builds(pin.calls)).toEqual([])
  })

  test("chain selection: a 0x --wallet or --to on a Solana asset is CHAIN_MISMATCH before any request", async () => {
    for (const argv of [
      ["transfer", "--wallet", hoodTee, "--to", "vault", "--asset", "SOL", "--amount", "1", "--yes", "--json"],
      ["transfer", "--to", trusted, "--asset", "USDC", "--amount", "1", "--yes", "--json"],
    ]) {
      const f = await fixture()
      expect(await run(argv, f.deps)).toBe(1)
      expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
      expect(f.calls).toEqual([])
    }
  })

  test("chain selection: a Solana TEE wallet named for ETH is CHAIN_MISMATCH before any build; without --wallet the Hood one pays", async () => {
    const named = await fixture({ rows: ["hood", "solana"] })
    expect(
      await run(
        ["transfer", "--wallet", "sol", "--to", "vault", "--asset", "ETH", "--amount", "1", "--yes", "--json"],
        named.deps,
      ),
    ).toBe(1)
    expect(lastJson(named.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(named.calls)).toEqual([])
    const auto = await fixture({ rows: ["hood", "solana"] })
    expect(
      await run(["transfer", "--to", "vault", "--asset", "ETH", "--amount", "1", "--yes", "--json"], auto.deps),
    ).toBe(0)
    expect(builds(auto.calls)[0]?.body).toMatchObject({ walletId: "hood-tee", chain: "hood" })
  })
})
