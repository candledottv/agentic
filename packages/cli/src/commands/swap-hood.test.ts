/**
 * Ember Phase 4b-1 CLI trading (BE-392, spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`).
 *
 * H7: chain selection. The wallet decides; without `--wallet` the assets decide; every mismatch is
 * `CHAIN_MISMATCH` before anything is built (and, when the assets or a 0x `--wallet` already
 * disagree, before any request at all).
 *
 * H8: the leg loop, only on `mode: "sequenced"`: each leg relay-signed with `eth_signTransaction`
 * in the authorization, posted as `{ operationId, signedTransaction }`, the next leg taken from the
 * server's answer; a failed leg exits 1 with the legs that landed; an uncertain leg exits 3 with
 * its hash; `swap status` reads without resending.
 *
 * The fake relay really signs: it builds the type-2 transaction from the relay body's wire fields
 * and signs it with a throwaway secret, so the CLI's own check that the signature covers exactly
 * the leg Candle built runs against real bytes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalAuthorizationPayloadBytes } from "../../../sdk/src/authorization-signature"
import type { EvmRecordAppendOutcome, EvmRecordTokenEntry } from "../deps"
import {
  bytesToHex,
  encodeErc20Transfer,
  evmAddressFromSecret,
  HOOD_USDG_ADDRESS,
  HOOD_WETH_ADDRESS,
  hexToBigInt,
  hexToBytes,
  signedTransactionCovers,
  signTransaction,
  toChecksumAddress,
} from "../evm-lite"
import {
  CURVE_BUY_SELECTOR,
  CURVE_SELL_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  HOOD_KYBER_ROUTER,
  HOOD_PERMIT2,
  HOOD_SPLITTER_FACTORY,
  HOOD_UNIV3_ROUTER,
  HOOD_V4_UNIVERSAL_ROUTER,
  PERMIT2_APPROVE_SELECTOR,
} from "../hood-legs"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import {
  kyberSwap,
  v3Buy,
  v3Multicall,
  v3Refund,
  v3Sell,
  v3Single,
  v3Unwrap,
  v4Direct,
  v4Raw,
} from "../test-hood-calldata"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import {
  classifyAsset,
  ERC20_TRANSFER_GAS,
  ETH_TRANSFER_GAS,
  evmAuthorizationSignature,
  pairChain,
  plannedLegKinds,
  RESERVE_EXTRA_ERC20_TRANSFERS,
  RESERVE_FEE_MULTIPLIER,
  type SequencedLeg,
  sweepReserveFloor,
} from "../trading"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
/** The throwaway TEE key the fake relay signs with; its address is the Hood TEE wallet. */
const teeSecret = hexToBytes(`0x${"11".repeat(32)}`)
const hoodTee = evmAddressFromSecret(teeSecret)
const otherSecret = hexToBytes(`0x${"22".repeat(32)}`)
const hoodEmbedded = evmAddressFromSecret(hexToBytes(`0x${"33".repeat(32)}`))
const solanaTee = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const token = toChecksumAddress("0x1111111111111111111111111111111111111111")
const router = toChecksumAddress(HOOD_UNIV3_ROUTER)
const treasury = toChecksumAddress("0x3333333333333333333333333333333333333333")
/** The token's Candle curve, as the registry's `curveForBaseToken` names it. */
const tokenCurve = toChecksumAddress("0x5555555555555555555555555555555555555555")
const attacker = toChecksumAddress("0x6666666666666666666666666666666666666666")
/** What `--amount 0.01` is in base units, at the fake RPC's 18 decimals. */
const AMOUNT = 10n ** 16n
const word = (hex: string | bigint) =>
  (typeof hex === "bigint" ? hex.toString(16) : hex.replace(/^0x/, "").toLowerCase()).padStart(64, "0")
/** `approve(spender, amount)`, exactly as the server's `buildApproveTx` encodes it. */
const approveData = (spender: string, amount = AMOUNT) => `${ERC20_APPROVE_SELECTOR}${word(spender)}${word(amount)}`
/** Permit2's `approve(token, spender, amount, expiration)`. */
const permit2Data = (spender: string, amount = AMOUNT, asset = token) =>
  `${PERMIT2_APPROVE_SELECTOR}${word(asset)}${word(spender)}${word(amount)}${word(9_999_999_999n)}`
const EVM_RPC = "https://hood.test/rpc"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function leg(nonce: number, to: string, data = "0x095ea7b3", value = "0"): SequencedLeg {
  return {
    chainId: 4663,
    nonce,
    gas: "120000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000",
    to,
    data,
    value,
  }
}

type Kind = "approval" | "permit2Approval" | "trade" | "feeTransfer"
interface Planned {
  kind: Kind
  leg: SequencedLeg
}

/**
 * What the fake submit does with each posted leg, in order: `land` answers the next leg (or the
 * final result after the last), `revert` answers the route's reverted failure, `unconfirmed` the
 * route's no-receipt answer, `lost` throws as a dropped connection.
 */
type Outcome = "land" | "revert" | "unconfirmed" | "executed" | "lost"

interface FixtureOptions {
  legs?: Planned[]
  outcomes?: Outcome[]
  /** A deployment that predates the sequenced rail: the TEE build answers the all-legs shape. */
  allLegs?: boolean
  /** Sign each leg with a different key, or over a different nonce than the leg. */
  relay?: "honest" | "wrong-nonce"
  /** The Hood TEE wallet is the only row, or both chains have one. */
  rows?: Array<"hood" | "solana">
  embedded?: { solana?: string; evm?: string }
  prompt?: string
  appendEvmRecord?: (entry: EvmRecordTokenEntry) => Promise<EvmRecordAppendOutcome>
  fee?: string
  /** `fee.treasury` on the trade build. Default: `treasury`; null as a build with none configured. */
  feeTreasury?: string | null
  /** The splitter factory's `platformVault()`. Default: `treasury`; "error" fails the read. */
  chainTreasury?: string | "error"
  /** `artifacts.venue` on the trade build. Default: `dex`. */
  venue?: string
  /** The curve the registry's `curveForBaseToken` names. Default: `tokenCurve`; null names none. */
  registeredCurve?: string | null
  expiresAt?: number
  /** BE-500: `teeReadiness` on GET /keys/self/limits. Absent by default, as an older API answers. */
  readiness?: unknown
  /** BE-505: `settlement` on the swap rail's `completed` payload. Absent by default, as an older API answers. */
  settlement?: unknown
}

async function fixture(opts: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-hood-trade-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined; url: string }[] = []
  // A token sell on the v3 router: approve the router for the input, swap, then the ETH fee.
  const planned = opts.legs ?? [
    { kind: "approval", leg: leg(7, token, approveData(router)) },
    { kind: "trade", leg: leg(8, router, v3Sell(token, AMOUNT, hoodTee)) },
    { kind: "feeTransfer", leg: leg(9, treasury, "0x", "5000") },
  ]
  const outcomes = [...(opts.outcomes ?? planned.map(() => "land" as Outcome))]
  const landed: Array<{ kind: string; hash: string }> = []
  let index = 0
  let built = false
  const sequenced = (i: number, route: "trade" | "swap") => ({
    mode: "sequenced",
    operationId: "op-1",
    legKind: planned[i]?.kind,
    legIndex: i,
    plannedLegCount: planned.length,
    nextLeg: planned[i]?.leg,
    landedLegs: [...landed],
    expiresAt: opts.expiresAt ?? 10_000,
    ...(route === "trade" ? { chain: "hood" } : {}),
  })
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, url })
    const ok = (value: unknown) => Response.json(value)
    if (url.startsWith(EVM_RPC)) {
      const method = body.method as string
      const selector = method === "eth_call" ? String(body.params[0].data).slice(0, 10) : ""
      if (selector === "0x20f094f8") {
        if (
          opts.chainTreasury === "error" ||
          String(body.params[0].to).toLowerCase() !== HOOD_SPLITTER_FACTORY.toLowerCase()
        )
          return ok({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "execution reverted" } })
        return ok({ jsonrpc: "2.0", id: body.id, result: `0x${word(opts.chainTreasury ?? treasury)}` })
      }
      const result =
        method === "eth_getBalance"
          ? "0xde0b6b3a7640000"
          : selector === "0x313ce567"
            ? `0x${"0".repeat(62)}12`
            : selector === "0x70a08231"
              ? `0x${4_000_000_000_000_000_000n.toString(16).padStart(64, "0")}`
              : selector === "0x446b9253"
                ? `0x${word(opts.registeredCurve === null ? "0x0" : (opts.registeredCurve ?? tokenCurve))}`
                : method === "eth_feeHistory"
                  ? { baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], reward: [["0x0"]] }
                  : method === "eth_maxPriorityFeePerGas"
                    ? "0xf4240"
                    : "0x0"
      return ok({ jsonrpc: "2.0", id: body.id, result })
    }
    if (path.includes("/jobs/"))
      return built
        ? ok({ success: true, job: { status: "built", operation: { operationId: "op-1", status: "active" } } })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["swap:write"],
        privyAppId: "app",
        page: (opts.rows ?? ["hood"]).map((chain) =>
          chain === "hood"
            ? {
                id: "hood-tee",
                address: hoodTee,
                label: "hood",
                chain: "evm",
                active: true,
                allowLaunch: false,
                privyWalletId: "privy-hood",
              }
            : {
                id: "sol-tee",
                address: solanaTee,
                label: "sol",
                chain: "solana",
                active: true,
                allowLaunch: false,
                privyWalletId: "privy-sol",
              },
        ),
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({
        success: true,
        wallets: {
          solana: opts.embedded?.solana ? { address: opts.embedded.solana } : null,
          evm: opts.embedded?.evm ? { address: opts.embedded.evm } : null,
        },
      })
    if (path === "/api/v1/agent/keys/self/limits")
      return ok({
        success: true,
        keyLimits: null,
        ...(opts.readiness !== undefined ? { teeReadiness: opts.readiness } : {}),
      })
    if (path === "/api/v1/trade/agent/execute")
      return built
        ? ok({ success: true, status: "executed", signature: "0xexecuted" })
        : Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
    if (path === "/api/v1/trade/agent/build") {
      built = true
      const main = body.payer?.type === "main"
      const quote = {
        success: true,
        status: "built",
        clientTradeId: body.clientTradeId,
        chain: "hood",
        minOutRaw: "123456",
        expectedOutRaw: "130000",
        fee: {
          bps: 100,
          feeRaw: opts.fee ?? "5000",
          treasury: opts.feeTreasury === undefined ? treasury : opts.feeTreasury,
        },
        expiresAt: opts.expiresAt ?? 10_000,
        walletAddress: main ? hoodEmbedded : hoodTee,
        artifacts: { venue: opts.venue ?? "dex", quoteAsset: body.quoteAsset, tokenRisks: [] },
      }
      if (main || opts.allLegs) return ok({ ...quote, artifacts: { ...quote.artifacts, legs: planned } })
      return ok({ ...quote, ...sequenced(0, "trade") })
    }
    if (path === "/api/v1/agent/swap/build") {
      built = true
      return ok({
        success: true,
        payload: {
          status: "built",
          swapId: "swap-1",
          chain: "hood",
          venue: "hood-dex",
          from: body.from,
          to: body.to,
          amountRaw: body.amountRaw,
          minOutRaw: "99",
          fee: { bps: 0, feeRaw: "0" },
          expectedOutRaw: "100",
          recipient: body.payer?.type === "main" ? hoodEmbedded : hoodTee,
          walletAddress: body.payer?.type === "main" ? hoodEmbedded : hoodTee,
          ...(body.payer?.type === "main" ? { expiresAt: 10000 } : sequenced(0, "swap")),
        },
      })
    }
    if (path.endsWith("/sign")) {
      const wire = body.body.params.transaction
      const tx = {
        chainId: BigInt(wire.chain_id),
        nonce: BigInt(wire.nonce) + (opts.relay === "wrong-nonce" ? 5n : 0n),
        maxPriorityFeePerGas: hexToBigInt(wire.max_priority_fee_per_gas),
        maxFeePerGas: hexToBigInt(wire.max_fee_per_gas),
        gas: hexToBigInt(wire.gas_limit),
        to: wire.to,
        value: hexToBigInt(wire.value),
        data: hexToBytes(wire.data),
      }
      const signed = signTransaction(tx, teeSecret)
      return ok({ success: true, signedTransaction: bytesToHex(signed.raw), encoding: "rlp" })
    }
    if (path === "/api/v1/trade/agent/submit" || path === "/api/v1/agent/swap/submit") {
      if (body.swapId && !body.signedTransaction)
        return ok({
          success: true,
          payload: { hashes: ["trade-hash"], settlement: { state: "settled", settledOutRaw: "100" } },
        })
      const swapRail = path.includes("swap")
      const current = planned[index]
      const outcome = outcomes.shift() ?? "land"
      const hash = `0x${String(index + 1).repeat(64)}`
      if (outcome === "lost") throw new Error("socket hang up")
      if (outcome === "revert") {
        const error = {
          code: "TRADE_REVERTED",
          message: "reverted",
          retryable: false,
          stage: "reverted",
          signature: hash,
        }
        return Response.json(
          swapRail
            ? { success: false, error: { ...error, landedLegs: landed, operationId: "op-1" } }
            : { success: false, error, landedLegs: landed },
          { status: 400 },
        )
      }
      if (outcome === "unconfirmed" || outcome === "executed") {
        const error = {
          code: "SWAP_FAILED",
          message: outcome === "executed" ? "the trade landed; the fee leg failed" : "no receipt",
          retryable: false,
          stage: outcome,
          // `executed` names the trade leg that landed, not the leg this submit carried.
          signature: outcome === "executed" ? (landed.find((leg) => leg.kind === "trade")?.hash ?? hash) : hash,
        }
        return Response.json(
          swapRail
            ? { success: false, error: { ...error, landedLegs: landed, operationId: "op-1" } }
            : { success: false, error, landedLegs: landed, operationId: "op-1" },
          { status: 500 },
        )
      }
      landed.push({ kind: current?.kind as string, hash })
      index += 1
      if (index < planned.length) {
        const next = sequenced(index, swapRail ? "swap" : "trade")
        return ok(
          swapRail
            ? { success: true, payload: { status: "built", swapId: "swap-1", ...next } }
            : { success: true, status: "built", ...next },
        )
      }
      return ok(
        swapRail
          ? {
              success: true,
              payload: {
                status: "confirmed",
                swapId: "swap-1",
                chain: "hood",
                hashes: landed.map((l) => l.hash),
                landedLegs: landed,
                ...(opts.settlement !== undefined ? { settlement: opts.settlement } : {}),
              },
            }
          : { success: true, status: "executed", txHash: hash },
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
const buyArgs = (extra: string[] = []) => [
  "swap",
  "ETH",
  token,
  "--amount",
  "0.01",
  "--client-trade-id",
  "hood-1",
  "--yes",
  "--json",
  ...extra,
]
/** A token sell for ETH: the approval, trade and fee legs a sell plans. */
const sellArgs = (extra: string[] = []) => [
  "swap",
  token,
  "ETH",
  "--amount",
  "0.01",
  "--client-trade-id",
  "hood-1",
  "--yes",
  "--json",
  ...extra,
]
/** An ETH buy on the v3 router: no approval (the input rides msg.value), the trade, then the fee. */
const buyLegs: Planned[] = [
  { kind: "trade", leg: leg(7, router, v3Buy(token, AMOUNT, hoodTee), AMOUNT.toString()) },
  { kind: "feeTransfer", leg: leg(8, treasury, "0x", "5000") },
]
/** An ETH to USDG base swap through Kyber for the confirmed 0.5 ETH, paid to the wallet. */
const ethToUsdg = kyberSwap({ dstReceiver: hoodTee, amount: 5n * 10n ** 17n })
const builds = <T extends { path: string }>(calls: T[]) => calls.filter((call) => call.path.endsWith("/build"))
const apiCalls = <T extends { url: string }>(calls: T[]) => calls.filter((call) => !call.url.startsWith(EVM_RPC))

describe("H7: chain selection", () => {
  test("the assets decide: ETH, USDG and a 0x token are Hood; SOL, USDC, CNDL and a base58 mint are Solana", () => {
    expect(classifyAsset("eth")).toEqual({ chain: "hood", asset: "ETH", base: "ETH" })
    expect(classifyAsset("USDG")).toEqual({ chain: "hood", asset: "USDG", base: "USDG" })
    expect(classifyAsset(HOOD_USDG_ADDRESS)).toEqual({ chain: "hood", asset: "USDG", base: "USDG" })
    expect(classifyAsset(token.toLowerCase())).toEqual({ chain: "hood", asset: token })
    expect(classifyAsset("sol")).toEqual({ chain: "solana", asset: "SOL", base: "SOL" })
    expect(classifyAsset(solanaTee)).toEqual({ chain: "solana", asset: solanaTee })
    expect(() => classifyAsset(`0x${"Ab".repeat(20)}`)).toThrow(expect.objectContaining({ code: "PAIR_UNSUPPORTED" }))
    expect(() => pairChain(classifyAsset("SOL"), classifyAsset("USDG"))).toThrow(
      expect.objectContaining({ code: "CHAIN_MISMATCH" }),
    )
  })

  const beforeAnyRequest: Array<[string, string[]]> = [
    // SOL against USDG is a bridge since Ember 4c (R1); CNDL is not a bridge asset.
    ["a Solana asset against a Hood asset", ["swap", "CNDL", "USDG", "--amount", "1"]],
    ["a Hood token against a Solana mint", ["swap", token, solanaTee, "--amount", "1"]],
    ["a 0x --wallet on a Solana pair", ["swap", "SOL", "USDC", "--amount", "1", "--wallet", hoodTee]],
  ]
  for (const [name, argv] of beforeAnyRequest) {
    test(`${name} is CHAIN_MISMATCH before any request`, async () => {
      const f = await fixture()
      expect(await run([...argv, "--yes", "--json"], f.deps)).toBe(1)
      expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
      expect(f.calls).toEqual([])
    })
  }

  test("a named Solana TEE wallet on a Hood pair is CHAIN_MISMATCH after the listing and before any build", async () => {
    const f = await fixture({ rows: ["hood", "solana"] })
    expect(await run(buyArgs(["--wallet", "sol"]), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(f.calls)).toEqual([])
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("a named Hood TEE wallet on a Solana pair is CHAIN_MISMATCH before any build", async () => {
    const f = await fixture({ rows: ["hood", "solana"] })
    expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--wallet", "hood", "--yes", "--json"], f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(f.calls)).toEqual([])
  })

  test("the embedded Solana wallet named on a Hood pair is CHAIN_MISMATCH, not an unknown wallet", async () => {
    const f = await fixture({ embedded: { solana: solanaTee.replace("7", "8") } })
    expect(await run(buyArgs(["--wallet", solanaTee.replace("7", "8")]), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(builds(f.calls)).toEqual([])
  })

  test("without --wallet the key's single Hood TEE wallet pays, even when a Solana TEE wallet is also bound", async () => {
    const f = await fixture({ rows: ["hood", "solana"], legs: buyLegs })
    expect(await run(buyArgs(), f.deps)).toBe(0)
    const build = builds(f.calls)[0]
    expect(build?.path).toBe("/api/v1/trade/agent/build")
    expect(build?.body).toMatchObject({
      chain: "hood",
      mint: token,
      side: "buy",
      quoteAsset: "eth",
      amountRaw: "10000000000000000",
      payer: { type: "linked", linkedWalletId: "hood-tee" },
    })
  })

  test("without --wallet, two Hood payers (TEE and embedded) is PAYER_REQUIRED naming only Hood wallets", async () => {
    const f = await fixture({
      rows: ["hood", "solana"],
      embedded: { evm: hoodEmbedded, solana: solanaTee.replace("7", "8") },
    })
    expect(await run(buyArgs(), f.deps)).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("PAYER_REQUIRED")
    expect(String(body.message)).toContain(hoodEmbedded)
    expect(String(body.message)).toContain(hoodTee)
    expect(String(body.message)).not.toContain(solanaTee)
    expect(builds(f.calls)).toEqual([])
  })

  test("a Solana pair without --wallet ignores a bound Hood TEE wallet", async () => {
    const f = await fixture({ rows: ["hood"] })
    expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("PAYER_REQUIRED")
    expect(builds(f.calls)).toEqual([])
  })
})

describe("H8: the sequenced leg loop", () => {
  test("each leg is relay-signed with eth_signTransaction, posted alone, and the next leg comes from the server", async () => {
    const appended: string[] = []
    const f = await fixture({
      appendEvmRecord: async (entry) => {
        appended.push(entry.token)
        return { appended: true }
      },
    })
    expect(await run(sellArgs(), f.deps)).toBe(0)
    const signs = f.calls.filter((call) => call.path.endsWith("/sign"))
    const submits = f.calls.filter((call) => call.path.endsWith("/submit"))
    expect(signs).toHaveLength(3)
    expect(submits).toHaveLength(3)
    for (const [i, sign] of signs.entries()) {
      const relay = sign.body as { body: { method: string; params: { transaction: Record<string, unknown> } } }
      expect(sign.path).toBe("/api/v1/agent/wallets/hood-tee/sign")
      expect(relay.body.method).toBe("eth_signTransaction")
      // D4's wire key set, exactly: the eight mapped fields, type 2 and from, and nothing else.
      expect(Object.keys(relay.body.params.transaction)).toEqual([
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
      ])
      expect(relay.body.params.transaction).toMatchObject({ chain_id: 4663, type: 2, nonce: 7 + i, from: hoodTee })
      expect(Object.keys(submits[i]?.body ?? {}).sort()).toEqual(["clientTradeId", "operationId", "signedTransaction"])
      expect(submits[i]?.body).toMatchObject({ clientTradeId: "hood-1", operationId: "op-1" })
      expect(submits[i]?.body).not.toHaveProperty("signedTransactions")
    }
    // Sign one, send one: every submit comes after its own sign and before the next sign.
    const order = f.calls
      .filter((call) => /\/(sign|submit)$/.test(call.path))
      .map((call) => call.path.split("/").at(-1))
    expect(order).toEqual(["sign", "submit", "sign", "submit", "sign", "submit"])
    const result = lastJson(f.stdout.text)
    expect(result.operationId).toBe("op-1")
    expect((result.landedLegs as Array<{ kind: string }>).map((l) => l.kind)).toEqual([
      "approval",
      "trade",
      "feeTransfer",
    ])
    // One `token` line per landed leg, for the traded token (D1).
    expect(appended).toEqual([token, token, token])
  })

  test("the authorization is over the SDK's canonical payload for the eth_signTransaction body", () => {
    const wallet = {
      id: "hood-tee",
      address: hoodTee,
      privyWalletId: "privy",
      appId: "app",
      signer: pem,
      chain: "evm" as const,
    }
    const result = evmAuthorizationSignature(wallet, leg(3, router))
    const bytes = canonicalAuthorizationPayloadBytes({ appId: "app", privyWalletId: "privy", body: result.body })
    expect(verify("sha256", bytes, pair.publicKey, Buffer.from(result.authorizationSignature, "base64"))).toBe(true)
    expect(result.body.method).toBe("eth_signTransaction")
    expect(JSON.stringify(result)).not.toContain(pem)
  })

  test("the quote names every leg, the gas estimate and the reserve before the confirmation", async () => {
    const f = await fixture()
    expect(await run(sellArgs(), f.deps)).toBe(0)
    expect(humanText(f.stderr.text)).toContain(humanText("Legs, signed one at a time: approve, trade, fee"))
    expect(humanText(f.stderr.text)).toContain(humanText("Gas: the approval leg up to 0.00024 ETH"))
    expect(humanText(f.stderr.text)).toContain(humanText("Gas reserve: at least"))
    const quote = lastJson(f.stdout.text).quote as Record<string, unknown>
    expect(quote.legs).toEqual(["approve", "trade", "fee"])
  })

  test("declining the quote signs nothing and says the build still holds the wallet", async () => {
    const f = await fixture({ prompt: "n" })
    f.deps.isTTY.stdin = true
    expect(
      await run(
        sellArgs().filter((arg) => arg !== "--yes"),
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
    const result = lastJson(f.stdout.text)
    expect(result.status).toBe("cancelled")
    expect(result.walletHeldUntil).toBe(10_000)
    expect(f.stderr.text).toContain("WALLET_BUSY")
  })

  test("a reverted leg exits 1 and lists the legs that landed", async () => {
    const f = await fixture({ outcomes: ["land", "revert"] })
    expect(await run(sellArgs(), f.deps)).toBe(1)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("TRADE_REVERTED")
    expect(String(failure.message)).toContain(`Landed: approval 0x${"1".repeat(64)}`)
    const details = failure.details as { landedLegs: Array<{ kind: string }>; operationId: string }
    expect(details.operationId).toBe("op-1")
    expect(details.landedLegs.map((l) => l.kind)).toEqual(["approval"])
    // The fee leg is never signed after a failed trade leg.
    expect(f.calls.filter((call) => call.path.endsWith("/sign"))).toHaveLength(2)
  })

  test("an uncertain leg (no receipt) exits 3 with its hash and resends nothing", async () => {
    const f = await fixture({ outcomes: ["land", "unconfirmed"] })
    expect(await run(sellArgs(), f.deps)).toBe(3)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("LEG_UNCONFIRMED")
    expect((failure.details as { hash: string }).hash).toBe(`0x${"2".repeat(64)}`)
    expect(String(failure.message)).toContain("candle swap status hood-1")
    expect(f.calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(2)
  })

  test("BE-1397: an uncertain leg keeps the server's stage and signature beside its hash", async () => {
    const f = await fixture({ outcomes: ["land", "unconfirmed"] })
    expect(await run(sellArgs(), f.deps)).toBe(3)
    expect(lastJson(f.stdout.text).details).toMatchObject({
      stage: "unconfirmed",
      signature: `0x${"2".repeat(64)}`,
      hash: `0x${"2".repeat(64)}`,
    })
  })

  test("BE-1397: a fee leg refused after the trade landed (stage executed) exits 3 with the trade's hash", async () => {
    const f = await fixture({ outcomes: ["land", "land", "executed"] })
    expect(await run(sellArgs(), f.deps)).toBe(3)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("SWAP_FAILED")
    const details = failure.details as { stage: string; signature: string; landedLegs: Array<{ kind: string }> }
    expect(details.stage).toBe("executed")
    expect(details.signature).toBe(`0x${"2".repeat(64)}`)
    expect(details.landedLegs.map((leg) => leg.kind)).toEqual(["approval", "trade"])
    expect(humanText(f.stderr.text)).toContain(humanText("Do not retry"))
    expect(f.calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(3)
  })

  test("a submit that gets no answer at all exits 3 with the hash of the bytes it posted", async () => {
    const f = await fixture({ outcomes: ["lost"] })
    expect(await run(sellArgs(), f.deps)).toBe(3)
    const failure = lastJson(f.stdout.text)
    expect(failure.code).toBe("LEG_UNCONFIRMED")
    const posted = f.calls.find((call) => call.path.endsWith("/submit"))?.body?.signedTransaction as string
    const { keccak_256 } = await import("@noble/hashes/sha3")
    expect((failure.details as { hash: string }).hash).toBe(bytesToHex(keccak_256(hexToBytes(posted))))
  })

  test("swap status reads the operation without resending anything", async () => {
    const f = await fixture({ outcomes: ["land", "unconfirmed"] })
    expect(await run(sellArgs(), f.deps)).toBe(3)
    const before = f.calls.length
    f.stdout.text = ""
    expect(await run(["swap", "status", "hood-1", "--json"], f.deps)).toBe(0)
    const read = f.calls.slice(before)
    expect(read.map((call) => call.path)).toEqual(["/api/v1/trade/agent/jobs/hood-1"])
    const status = lastJson(f.stdout.text)
    expect((status.job as { operation: { operationId: string } }).operation.operationId).toBe("op-1")
    // The hash saved before the post (the uncertain leg's) rides back on the local read.
    const posted = f.calls.filter((call) => call.path.endsWith("/submit")).at(-1)?.body?.signedTransaction as string
    const { keccak_256 } = await import("@noble/hashes/sha3")
    expect(status.signature).toBe(bytesToHex(keccak_256(hexToBytes(posted))))
  })

  test("a relay signature over another nonce is refused and never posted", async () => {
    const f = await fixture({ relay: "wrong-nonce" })
    expect(await run(sellArgs(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.calls.some((call) => call.path.endsWith("/submit"))).toBe(false)
  })

  test("a fee leg offered before the trade landed is refused and never signed", async () => {
    const f = await fixture({ legs: [{ kind: "feeTransfer", leg: leg(1, treasury, "0x", "5") }] })
    expect(await run(sellArgs(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("a launch or transfer leg kind offered to a swap is refused and never signed (Phase 4b-2)", async () => {
    for (const kind of ["createCurve", "transfer"]) {
      const f = await fixture({ legs: [{ kind: kind as Kind, leg: leg(1, router) }] })
      expect(await run(sellArgs(), f.deps)).toBe(1)
      expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
      expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
    }
  })

  test("a leg on another chain id is refused and never signed", async () => {
    const f = await fixture({ legs: [{ kind: "trade", leg: { ...leg(1, router), chainId: 1 } }] })
    expect(await run(sellArgs(), f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("a deployment without the sequenced rail never has a Hood TEE leg signed", async () => {
    const f = await fixture({ allLegs: true })
    expect(await run(sellArgs(), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("SEQUENCED_RAIL_REQUIRED")
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("ETH to USDG runs on the swap rail with swapId, and records USDG", async () => {
    const f = await fixture({
      legs: [{ kind: "trade", leg: leg(4, HOOD_KYBER_ROUTER, ethToUsdg, "500000000000000000") }],
      appendEvmRecord: async () => ({ appended: true }),
    })
    expect(
      await run(["swap", "ETH", "USDG", "--amount", "0.5", "--client-trade-id", "hood-2", "--yes", "--json"], f.deps),
    ).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ from: "ETH", to: "USDG", amountRaw: "500000000000000000" })
    const submit = f.calls.find((call) => call.path === "/api/v1/agent/swap/submit")
    expect(submit?.body).toMatchObject({ clientTradeId: "hood-2", swapId: "swap-1", operationId: "op-1" })
    expect(f.appended.map((entry) => entry.token)).toEqual([toChecksumAddress(HOOD_USDG_ADDRESS)])
    expect(lastJson(f.stdout.text).status).toBe("confirmed")
  })

  test("BE-505 (R8.4): a completed ETH to USDG swap prints the settled USDG and passes settlement through", async () => {
    const settlement = {
      state: "settled",
      legs: [{ chain: "hood", hash: `0x${"1".repeat(64)}`, status: "confirmed" }],
      in: { asset: "ETH", raw: "500000000000000000" },
      expectedOutRaw: "100",
      settledOutRaw: "1234567",
      settledOutSource: "tx_balance_delta",
      measuredAt: { blockNumber: 123 },
    }
    const f = await fixture({
      legs: [{ kind: "trade", leg: leg(4, HOOD_KYBER_ROUTER, ethToUsdg, "500000000000000000") }],
      settlement,
    })
    expect(
      await run(["swap", "ETH", "USDG", "--amount", "0.5", "--client-trade-id", "hood-2", "--yes", "--json"], f.deps),
    ).toBe(0)
    expect(humanText(f.stderr.text)).toContain(humanText("settled 1.234567 USDG\n"))
    expect(lastJson(f.stdout.text).settlement).toEqual(settlement)
  })

  test("BE-505 (R8.4): a Hood swap with a pending or absent settlement names the job read", async () => {
    for (const settlement of [
      { state: "pending", legs: [], in: { asset: "ETH", raw: "1" }, expectedOutRaw: "100" },
      undefined,
    ]) {
      const f = await fixture({
        legs: [{ kind: "trade", leg: leg(4, HOOD_KYBER_ROUTER, ethToUsdg, "500000000000000000") }],
        ...(settlement ? { settlement } : {}),
      })
      expect(
        await run(["swap", "ETH", "USDG", "--amount", "0.5", "--client-trade-id", "hood-3", "--yes", "--json"], f.deps),
      ).toBe(0)
      expect(humanText(f.stderr.text)).toContain(
        humanText(
          `Settlement: ${settlement ? "pending" : "not measured"}. Re-check with GET /api/v1/agent/swap/jobs/hood-3 (candle swap status hood-3).`,
        ),
      )
      expect("settlement" in lastJson(f.stdout.text)).toBe(settlement !== undefined)
    }
  })

  test("BE-505 (R8.4): a Hood token trade prints no settlement line", async () => {
    const f = await fixture()
    expect(await run(sellArgs(), f.deps)).toBe(0)
    expect(f.stderr.text).not.toContain("Settlement")
    expect(f.stderr.text).not.toMatch(/^settled /m)
  })

  test("a token sell with --percent 100 reads the token balance over the Hood RPC and sells all of it", async () => {
    const f = await fixture()
    expect(
      await run(["swap", token, "ETH", "--percent", "100", "--client-trade-id", "hood-3", "--yes", "--json"], f.deps),
    ).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ side: "sell", mint: token, amountRaw: "4000000000000000000" })
    expect(humanText(f.stderr.text)).toContain(humanText("Reading from hood.test"))
  })

  test("the embedded Hood wallet trades a token through the deferred build, never the leg loop", async () => {
    const f = await fixture({ rows: [], embedded: { evm: hoodEmbedded } })
    expect(await run(sellArgs(), f.deps)).toBe(0)
    expect(builds(f.calls)[0]?.body).toMatchObject({ payer: { type: "main" }, deferExecution: true })
    expect(f.calls.some((call) => call.path.endsWith("/sign") || call.path.endsWith("/submit"))).toBe(false)
  })

  test("a skipped record append never fails a landed leg; it prints a notice", async () => {
    const f = await fixture({ appendEvmRecord: async () => ({ appended: false, notice: "the header is version 3" }) })
    expect(await run(sellArgs(), f.deps)).toBe(0)
    expect(humanText(f.stderr.text)).toContain(humanText("the sealed EVM record was not updated"))
    expect(humanText(f.stderr.text)).toContain(humanText("the header is version 3"))
    const thrown = await fixture({
      appendEvmRecord: async () => {
        throw new Error("lock busy")
      },
    })
    expect(await run(sellArgs(), thrown.deps)).toBe(0)
    expect(humanText(thrown.stderr.text)).toContain(humanText("lock busy"))
    const none = await fixture()
    expect(await run(sellArgs(), none.deps)).toBe(0)
    expect(humanText(none.stderr.text)).toContain(humanText("no sealed EVM record writer"))
  })

  test("a non-TEE Solana wallet never enters the loop (the Solana rail is unchanged)", async () => {
    const f = await fixture({ rows: ["solana"] })
    // No Solana fakes here: the Solana path must reach its own build, never /submit with operationId.
    await run(["swap", "SOL", "USDC", "--amount", "1", "--wallet", "sol", "--yes", "--json"], f.deps).catch(() => 1)
    expect(apiCalls(f.calls).some((call) => call.path.endsWith("/submit"))).toBe(false)
  })
})

describe("every leg is held to what was confirmed (hood-legs.ts)", () => {
  const signCount = <T extends { path: string }>(calls: T[]) => calls.filter((c) => c.path.endsWith("/sign")).length
  const approval = (data: string, to = token): Planned => ({ kind: "approval", leg: leg(7, to, data) })
  const sellData = v3Sell(token, AMOUNT, hoodTee)
  const buyData = v3Buy(token, AMOUNT, hoodTee)
  const v4SellData = v4Direct({ token, zeroForOne: false, amountIn: AMOUNT })
  const trade = (to: string, data: string = sellData, value = "0", nonce = 8): Planned => ({
    kind: "trade",
    leg: leg(nonce, to, data, value),
  })
  const fee = (to = treasury, data = "0x", value = "5000", nonce = 9): Planned => ({
    kind: "feeTransfer",
    leg: leg(nonce, to, data, value),
  })
  const curveSell = (amount = AMOUNT, minimum = 123456n) => `${CURVE_SELL_SELECTOR}${word(amount)}${word(minimum)}`
  const usdgFee = (recipient: string, amount: bigint) =>
    fee(HOOD_USDG_ADDRESS, bytesToHex(encodeErc20Transfer(recipient, amount)), "0")

  const honest: Array<[string, Planned[], string[], FixtureOptions]> = [
    [
      "a v4 sell: Permit2 approve, Permit2's grant to the Universal Router, the router, the fee",
      [
        approval(approveData(HOOD_PERMIT2)),
        { kind: "permit2Approval", leg: leg(8, HOOD_PERMIT2, permit2Data(HOOD_V4_UNIVERSAL_ROUTER)) },
        trade(HOOD_V4_UNIVERSAL_ROUTER, v4SellData, "0", 9),
        fee(treasury, "0x", "5000", 10),
      ],
      sellArgs(),
      {},
    ],
    [
      "a sell through the aggregator",
      [
        approval(approveData(HOOD_KYBER_ROUTER)),
        trade(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: hoodTee, amount: AMOUNT })),
        fee(),
      ],
      sellArgs(),
      {},
    ],
    [
      "a curve sell to the curve the registry names",
      [approval(approveData(tokenCurve)), trade(tokenCurve, curveSell()), fee()],
      sellArgs(),
      { venue: "curve" },
    ],
    [
      "a curve buy paying the curve its ETH",
      [
        trade(tokenCurve, `${CURVE_BUY_SELECTOR}${word(123456n)}`, AMOUNT.toString(), 7),
        fee(treasury, "0x", "5000", 8),
      ],
      buyArgs(),
      { venue: "curve" },
    ],
    [
      "a sell for USDG whose fee is a USDG transfer to the treasury",
      [
        approval(approveData(router)),
        trade(
          router,
          v3Multicall([
            v3Single({ tokenIn: token, tokenOut: HOOD_USDG_ADDRESS, recipient: hoodTee, amountIn: AMOUNT }),
          ]),
        ),
        usdgFee(treasury, 5000n),
      ],
      ["swap", token, "USDG", ...sellArgs().slice(3)],
      {},
    ],
    [
      "a fee to the treasury the chain names, when the build names none",
      [approval(approveData(router)), trade(router), fee()],
      sellArgs(),
      { feeTreasury: null },
    ],
  ]
  for (const [name, legs, argv, options] of honest)
    test(`honest: ${name} signs every leg`, async () => {
      const f = await fixture({ legs, ...options })
      expect(await run(argv, f.deps)).toBe(0)
      expect(signCount(f.calls)).toBe(legs.length)
    })

  // [name, legs, argv, fixture options, legs signed before the refusal]
  const refused: Array<[string, Planned[], string[], FixtureOptions, number]> = [
    [
      "a v3 buy of a different output token",
      [trade(router, v3Buy(attacker, AMOUNT, hoodTee), AMOUNT.toString(), 7)],
      buyArgs(),
      {},
      0,
    ],
    [
      "a v3 sell with an unwrap minimum below the quote",
      [
        approval(approveData(router)),
        trade(
          router,
          v3Multicall([
            v3Single({
              tokenIn: token,
              tokenOut: HOOD_WETH_ADDRESS,
              recipient: "0x0000000000000000000000000000000000000002",
              amountIn: AMOUNT,
            }),
            v3Unwrap(hoodTee, 123455n),
          ]),
        ),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v4 sell with a TAKE_ALL minimum below the quote",
      [
        trade(
          HOOD_V4_UNIVERSAL_ROUTER,
          v4Direct({ token, zeroForOne: false, amountIn: AMOUNT, takeMinimum: 123455n }),
          "0",
          7,
        ),
      ],
      sellArgs(),
      {},
      0,
    ],
    [
      "the Kyber attacker source-receiver reproduction",
      [
        trade(
          HOOD_KYBER_ROUTER,
          kyberSwap({
            srcToken: token,
            dstToken: attacker,
            dstReceiver: hoodTee,
            amount: AMOUNT,
            srcReceivers: [attacker],
            minimum: 0n,
          }),
          "0",
          7,
        ),
      ],
      sellArgs(),
      {},
      0,
    ],
    [
      "a base swap whose minimum is below its build floor",
      [
        trade(
          HOOD_KYBER_ROUTER,
          kyberSwap({ dstReceiver: hoodTee, amount: 5n * 10n ** 17n, minimum: 98n }),
          "500000000000000000",
          4,
        ),
      ],
      ["swap", "ETH", "USDG", "--amount", "0.5", "--client-trade-id", "hood-2", "--yes", "--json"],
      {},
      0,
    ],
    [
      "a curve sell using the net floor instead of the pre-fee floor",
      [approval(approveData(tokenCurve)), trade(tokenCurve, curveSell(AMOUNT, 123456n - 5000n))],
      sellArgs(),
      { venue: "curve" },
      1,
    ],
    [
      "a curve buy with a zero minimum",
      [trade(tokenCurve, `${CURVE_BUY_SELECTOR}${word(0n)}`, AMOUNT.toString(), 7)],
      buyArgs(),
      { venue: "curve" },
      0,
    ],
    ["an approval to an unknown spender", [approval(approveData(attacker)), trade(router), fee()], sellArgs(), {}, 0],
    [
      "an approval for more than the input",
      [approval(approveData(router, AMOUNT + 1n)), trade(router), fee()],
      sellArgs(),
      {},
      0,
    ],
    [
      "an approval of another token",
      [approval(approveData(router), HOOD_USDG_ADDRESS), trade(router), fee()],
      sellArgs(),
      {},
      0,
    ],
    [
      "an approval leg that is an ERC-20 transfer",
      [approval(bytesToHex(encodeErc20Transfer(attacker, AMOUNT))), trade(router), fee()],
      sellArgs(),
      {},
      0,
    ],
    [
      "an approval on an ETH buy",
      [approval(approveData(router)), trade(router, buyData, "1"), fee()],
      buyArgs(),
      {},
      0,
    ],
    ["a trade leg to an unknown address", [approval(approveData(router)), trade(attacker), fee()], sellArgs(), {}, 1],
    [
      "a sell's trade leg carrying ETH",
      [approval(approveData(router)), trade(router, "0xabcdef", "1"), fee()],
      sellArgs(),
      {},
      1,
    ],
    [
      "a buy's trade leg carrying more than the input",
      [trade(router, buyData, (AMOUNT + 1n).toString(), 7)],
      buyArgs(),
      {},
      0,
    ],
    [
      "a Permit2 grant to another spender",
      [
        approval(approveData(HOOD_PERMIT2)),
        { kind: "permit2Approval", leg: leg(8, HOOD_PERMIT2, permit2Data(attacker)) },
        trade(HOOD_V4_UNIVERSAL_ROUTER, v4SellData, "0", 9),
      ],
      sellArgs(),
      {},
      1,
    ],
    ["a fee leg to an attacker", [approval(approveData(router)), trade(router), fee(attacker)], sellArgs(), {}, 2],
    [
      "a fee leg carrying more than the quoted fee",
      [approval(approveData(router)), trade(router), fee(treasury, "0x", "5001")],
      sellArgs(),
      {},
      2,
    ],
    [
      "a fee leg to the treasury the build named, when the chain names another",
      [approval(approveData(router)), trade(router), fee(attacker)],
      sellArgs(),
      { feeTreasury: attacker },
      2,
    ],
    [
      "a fee leg when the RPC cannot read the chain's treasury",
      [approval(approveData(router)), trade(router), fee()],
      sellArgs(),
      { chainTreasury: "error" },
      2,
    ],
    [
      "a fee leg to a treasury the chain no longer names",
      [approval(approveData(router)), trade(router), fee()],
      sellArgs(),
      { chainTreasury: attacker },
      2,
    ],
    [
      "a USDG fee transferred to an attacker",
      [
        approval(approveData(router)),
        trade(
          router,
          v3Multicall([
            v3Single({ tokenIn: token, tokenOut: HOOD_USDG_ADDRESS, recipient: hoodTee, amountIn: AMOUNT }),
          ]),
        ),
        usdgFee(attacker, 5000n),
      ],
      ["swap", token, "USDG", ...sellArgs().slice(3)],
      {},
      2,
    ],
    [
      "a fee leg on a base swap, which carries none",
      [trade(HOOD_KYBER_ROUTER, ethToUsdg, "500000000000000000", 4), fee(treasury, "0x", "1", 5)],
      ["swap", "ETH", "USDG", "--amount", "0.5", "--client-trade-id", "hood-2", "--yes", "--json"],
      {},
      1,
    ],
    [
      "a curve approval to a contract the registry does not name",
      [approval(approveData(attacker)), trade(attacker, curveSell()), fee()],
      sellArgs(),
      { venue: "curve" },
      0,
    ],
    [
      "a curve trade when the registry names no curve for the token",
      [trade(tokenCurve, `${CURVE_BUY_SELECTOR}${word(123456n)}`, AMOUNT.toString(), 7)],
      buyArgs(),
      { venue: "curve", registeredCurve: null },
      0,
    ],
    [
      "a curve sell of more than the input",
      [approval(approveData(tokenCurve)), trade(tokenCurve, curveSell(AMOUNT + 1n)), fee()],
      sellArgs(),
      { venue: "curve" },
      1,
    ],
    [
      "a v3 sell of another token than the one confirmed",
      [approval(approveData(router)), trade(router, v3Sell(HOOD_USDG_ADDRESS, AMOUNT, hoodTee)), fee()],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v3 sell of a larger amount than the one confirmed",
      [approval(approveData(router)), trade(router, v3Sell(token, AMOUNT * 5n, hoodTee)), fee()],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v3 sell that pays another recipient",
      [approval(approveData(router)), trade(router, v3Sell(token, AMOUNT, attacker)), fee()],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v3 swap straight to another recipient",
      [
        approval(approveData(router)),
        trade(
          router,
          v3Multicall([
            v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, recipient: attacker, amountIn: AMOUNT }),
          ]),
        ),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v3 swap left in the router with no unwrap to the wallet",
      [
        approval(approveData(router)),
        trade(
          router,
          v3Multicall([
            v3Single({
              tokenIn: token,
              tokenOut: HOOD_WETH_ADDRESS,
              recipient: "0x0000000000000000000000000000000000000002",
              amountIn: AMOUNT,
            }),
            v3Unwrap(attacker),
          ]),
        ),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a v3 buy of another input token than WETH",
      [
        trade(
          router,
          v3Multicall([
            v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, recipient: hoodTee, amountIn: AMOUNT }),
            v3Refund(),
          ]),
          AMOUNT.toString(),
          7,
        ),
      ],
      buyArgs(),
      {},
      0,
    ],
    [
      "a v4 sell of a larger amount than the one confirmed",
      [
        approval(approveData(HOOD_PERMIT2)),
        { kind: "permit2Approval", leg: leg(8, HOOD_PERMIT2, permit2Data(HOOD_V4_UNIVERSAL_ROUTER)) },
        trade(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: false, amountIn: AMOUNT * 5n }), "0", 9),
      ],
      sellArgs(),
      {},
      2,
    ],
    [
      "a v4 call this check does not decode",
      [
        approval(approveData(HOOD_PERMIT2)),
        { kind: "permit2Approval", leg: leg(8, HOOD_PERMIT2, permit2Data(HOOD_V4_UNIVERSAL_ROUTER)) },
        trade(HOOD_V4_UNIVERSAL_ROUTER, v4Raw("0x0a", ["0x"]), "0", 9),
      ],
      sellArgs(),
      {},
      2,
    ],
    [
      "a Kyber swap of another token than the one confirmed",
      [
        approval(approveData(HOOD_KYBER_ROUTER)),
        trade(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: HOOD_USDG_ADDRESS, dstReceiver: hoodTee, amount: AMOUNT })),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a Kyber swap of a larger amount than the one confirmed",
      [
        approval(approveData(HOOD_KYBER_ROUTER)),
        trade(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: hoodTee, amount: AMOUNT * 5n })),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a Kyber swap that pays another recipient",
      [
        approval(approveData(HOOD_KYBER_ROUTER)),
        trade(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: attacker, amount: AMOUNT, simple: true })),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a Kyber swap with a fee receiver",
      [
        approval(approveData(HOOD_KYBER_ROUTER)),
        trade(
          HOOD_KYBER_ROUTER,
          kyberSwap({
            srcToken: token,
            dstReceiver: hoodTee,
            amount: AMOUNT,
            feeReceivers: [attacker],
            feeAmounts: [1n],
          }),
        ),
        fee(),
      ],
      sellArgs(),
      {},
      1,
    ],
    [
      "a router call with calldata this check does not decode",
      [approval(approveData(HOOD_KYBER_ROUTER)), trade(HOOD_KYBER_ROUTER, "0xabcdef"), fee()],
      sellArgs(),
      {},
      1,
    ],
    [
      "a DEX router named on the curve venue",
      [approval(approveData(router)), trade(router), fee()],
      sellArgs(),
      { venue: "curve" },
      0,
    ],
  ]
  for (const [name, legs, argv, options, signed] of refused)
    test(`refused before signing: ${name}`, async () => {
      const f = await fixture({ legs, ...options })
      expect(await run(argv, f.deps)).toBe(1)
      const failure = lastJson(f.stdout.text)
      expect(failure.code).toBe("INVALID_RESPONSE")
      expect(String(failure.message)).toContain("does not match what this operation confirmed; nothing was signed")
      expect(signCount(f.calls)).toBe(signed)
    })
})

describe("Phase 4b helpers", () => {
  test("plannedLegKinds recovers the send order from the first leg, the count and the fee", () => {
    expect(plannedLegKinds("approval", 3, true)).toEqual(["approval", "trade", "feeTransfer"])
    expect(plannedLegKinds("approval", 4, true)).toEqual(["approval", "permit2Approval", "trade", "feeTransfer"])
    expect(plannedLegKinds("permit2Approval", 3, true)).toEqual(["permit2Approval", "trade", "feeTransfer"])
    expect(plannedLegKinds("trade", 1, false)).toEqual(["trade"])
    expect(plannedLegKinds("trade", 3, true)).toBeUndefined()
  })

  test("signedTransactionCovers accepts a signature over the leg and refuses one over any other field", () => {
    const tx = {
      chainId: 4663n,
      nonce: 7n,
      maxPriorityFeePerGas: 1_000_000n,
      maxFeePerGas: 2_000_000_000n,
      gas: 120_000n,
      to: router,
      value: 0n,
      data: hexToBytes("0xabcdef"),
    }
    expect(signedTransactionCovers(signTransaction(tx, teeSecret).raw, tx)).toBe(true)
    expect(signedTransactionCovers(signTransaction(tx, otherSecret).raw, tx)).toBe(true)
    for (const changed of [
      { ...tx, nonce: 8n },
      { ...tx, gas: 120_001n },
      { ...tx, maxFeePerGas: 1n },
      { ...tx, maxPriorityFeePerGas: 2n },
      { ...tx, value: 1n },
      { ...tx, to: treasury },
      { ...tx, data: hexToBytes("0xabcdee") },
      { ...tx, chainId: 1n },
    ])
      expect(signedTransactionCovers(signTransaction(changed, teeSecret).raw, tx)).toBe(false)
    expect(signedTransactionCovers(hexToBytes("0x01"), tx)).toBe(false)
  })

  test("the reserve floor counts USDG, WETH, the traded token and one extra transfer, deduped", () => {
    const fee = 1_000_000_000n
    const floor = sweepReserveFloor(fee, [token, HOOD_USDG_ADDRESS.toUpperCase().replace("0X", "0x")])
    expect(floor.erc20Transfers).toBe(4)
    expect(floor.wei).toBe((65_000n * 4n + 21_000n) * fee * 2n)
    expect(sweepReserveFloor(fee).erc20Transfers).toBe(3)
  })

  test("drift: the reserve constants and WETH match the server's (packages/shared, apps/api)", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..")
    const reserveFile = join(root, "apps", "api", "src", "lib", "hood-gas-reserve.ts")
    const dexFile = join(root, "packages", "shared", "src", "hood-dex.ts")
    // A standalone export of this package (the public agentic mirror) has neither file.
    if (!existsSync(reserveFile) || !existsSync(dexFile)) return
    const reserve = readFileSync(reserveFile, "utf8")
    expect(reserve).toContain(
      `ERC20_TRANSFER_GAS = ${ERC20_TRANSFER_GAS.toLocaleString("en-US").replaceAll(",", "_")}n`,
    )
    expect(reserve).toContain(`ETH_TRANSFER_GAS = ${ETH_TRANSFER_GAS.toLocaleString("en-US").replaceAll(",", "_")}n`)
    expect(reserve).toContain(`RESERVE_FEE_MULTIPLIER = ${RESERVE_FEE_MULTIPLIER}n`)
    expect(reserve).toContain(`RESERVE_EXTRA_ERC20_TRANSFERS = ${RESERVE_EXTRA_ERC20_TRANSFERS}`)
    expect(readFileSync(dexFile, "utf8")).toContain(`HOOD_WETH = "${HOOD_WETH_ADDRESS}"`)
  })
})

// BE-500 (R4.6): the Hood TEE path refuses locally too, before any EVM read or build.
describe("TEE limits on Hood: only the server decides", () => {
  const caps = { SOL: false, USDC: false, CNDL: false, ETH: false, USDG: false }
  test("a buy with ETH and no limits set goes on to the build", async () => {
    const f = await fixture({ readiness: { txLimit: false, rawCaps: caps }, legs: buyLegs })
    expect(await run(buyArgs(), f.deps)).toBe(0)
    expect(builds(f.calls)).toHaveLength(1)
  })
})

test("embedded ETH to USDG builds and confirms on swap rail, with no execute probe or relay", async () => {
  const f = await fixture({ rows: [], embedded: { evm: hoodEmbedded } })
  expect(await run(["swap", "ETH", "USDG", "--amount", "0.1", "--yes", "--json"], f.deps)).toBe(0)
  expect(f.calls.find((call) => call.path === "/api/v1/agent/swap/build")?.body?.payer).toEqual({ type: "main" })
  expect(f.calls.find((call) => call.path === "/api/v1/agent/swap/submit")?.body).toMatchObject({ swapId: "swap-1" })
  expect(f.calls.some((call) => call.path.endsWith("/sign") || call.path === "/api/v1/trade/agent/execute")).toBe(false)
  expect(f.stderr.text).toContain("settled")
})
