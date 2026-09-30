/**
 * Ember Phase 4c rollout C (BE-560, spec 2026-09-29-ember-phase-4c-relay-bridging-design.md, R1,
 * R4, T5): `candle swap` across chains, end to end against a fake API, a fake relay that really
 * signs Hood legs, and a fake Solana RPC that serves the deposit's lookup table.
 *
 * What is pinned: a base pair on each chain builds a bridge and anything else stays
 * CHAIN_MISMATCH; the destination is this key's own TEE wallet (one is used, two need --to, --to is
 * sent as toWalletId, and a recipient the key does not list is refused); a Candle fee refuses; each
 * Hood leg and the Solana deposit are checked before the relay signs; the deposit prints and the
 * command returns while Relay fills, or follows it with --wait; and `swap status` renders the bridge.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import {
  bytesToHex,
  evmAddressFromSecret,
  HOOD_USDG_ADDRESS,
  hexToBigInt,
  hexToBytes,
  signTransaction,
} from "../evm-lite"
import { run } from "../index"
import {
  RELAY_HOOD_DEPOSIT_ERC20_SELECTOR,
  RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR,
  RELAY_HOOD_DEPOSITORY,
  RELAY_SOLANA_DEPOSITORY_PROGRAM,
} from "../relay-constants"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import type { SequencedLeg } from "../trading"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const teeSecret = hexToBytes(`0x${"11".repeat(32)}`)
const hoodTee = evmAddressFromSecret(teeSecret)
const hoodTee2 = evmAddressFromSecret(hexToBytes(`0x${"44".repeat(32)}`))
const solanaKey = Keypair.generate()
const solanaTee = solanaKey.publicKey.toBase58()
const EVM_RPC = "https://hood.test/rpc"
const SOLANA_RPC = "http://localhost/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const REQUEST_ID = "ab".repeat(32)
const STATUS_URL = "https://api.relay.link/intents/status?requestId=0xr1"
const table = Keypair.generate().publicKey
const tableAddresses = [Keypair.generate().publicKey, Keypair.generate().publicKey]

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")
const uint = (value: bigint | string) => BigInt(value).toString(16).padStart(64, "0")

function leg(nonce: number, to: string, data: string, value = "0"): SequencedLeg {
  return {
    chainId: 4663,
    nonce,
    gas: "90000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000",
    to,
    data,
    value,
  }
}
const approveLeg = (amount: string) =>
  leg(7, HOOD_USDG_ADDRESS, `0x095ea7b3${pad(RELAY_HOOD_DEPOSITORY)}${uint(amount)}`)
const usdgDepositLeg = (amount: string, depositor = hoodTee) =>
  leg(
    8,
    RELAY_HOOD_DEPOSITORY,
    `${RELAY_HOOD_DEPOSIT_ERC20_SELECTOR}${pad(depositor)}${pad(HOOD_USDG_ADDRESS)}${uint(amount)}${REQUEST_ID}`,
  )
const ethDepositLeg = (amount: string, depositor = hoodTee) =>
  leg(7, RELAY_HOOD_DEPOSITORY, `${RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR}${pad(depositor)}${REQUEST_ID}`, amount)

function lookupTableData(addresses: PublicKey[]): string {
  const data = new Uint8Array(56 + 32 * addresses.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 0xffffffffffffffffn, true)
  for (const [i, address] of addresses.entries()) data.set(address.toBytes(), 56 + 32 * i)
  return Buffer.from(data).toString("base64")
}

function solanaDeposit(extra: TransactionInstruction[] = []): string {
  const deposit = new TransactionInstruction({
    programId: new PublicKey(RELAY_SOLANA_DEPOSITORY_PROGRAM),
    keys: [
      { pubkey: solanaKey.publicKey, isSigner: true, isWritable: true },
      ...tableAddresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([9]),
  })
  const message = new TransactionMessage({
    payerKey: solanaKey.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [...extra, deposit],
  }).compileToV0Message([
    new AddressLookupTableAccount({
      key: table,
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: tableAddresses,
      },
    }),
  ])
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64")
}

type Row = "sol" | "hood" | "hood2"

interface Options {
  rows?: Row[]
  /** The Hood legs the build and each submit hand out, in order. */
  legs?: Array<{ kind: "approval" | "bridgeDeposit"; leg: SequencedLeg }>
  /** The Solana deposit the build returns. */
  transaction?: string
  recipient?: string
  fee?: { bps: number; feeRaw: string }
  prompt?: string
  /** What successive job reads answer after the build; the last one repeats. */
  jobs?: Array<Record<string, unknown>>
  embedded?: { solana?: string; evm?: string }
  /** The job reads answer from the start, as for an operation built earlier. */
  built?: boolean
  /** Every job read after the build answers 503, as a transient API failure. */
  jobsDown?: boolean
}

async function fixture(opts: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-bridge-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined; url: string }[] = []
  const planned = opts.legs ?? []
  const landed: Array<{ kind: string; hash: string }> = []
  let index = 0
  let built = opts.built ?? false
  let jobReads = 0
  const sequenced = (i: number) => ({
    mode: "sequenced",
    operationId: "op-b",
    legKind: planned[i]?.kind,
    plannedLegCount: planned.length,
    nextLeg: planned[i]?.leg,
    landedLegs: [...landed],
    expiresAt: 10_000,
  })
  const rowsFor: Record<Row, Record<string, unknown>> = {
    sol: { id: "sol-tee", address: solanaTee, label: "sol", chain: "solana" },
    hood: { id: "hood-tee", address: hoodTee, label: "hood", chain: "evm" },
    hood2: { id: "hood-tee-2", address: hoodTee2, label: "hood2", chain: "evm" },
  }
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, url })
    const ok = (value: unknown) => Response.json(value)
    if (url.startsWith(EVM_RPC)) return ok({ jsonrpc: "2.0", id: body.id, result: "0xde0b6b3a7640000" })
    if (url.startsWith(SOLANA_RPC)) {
      if (body.method === "getMultipleAccounts")
        return ok({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            value: (body.params[0] as string[]).map((address) =>
              address === table.toBase58()
                ? {
                    owner: "AddressLookupTab1e1111111111111111111111111",
                    lamports: 1,
                    data: [lookupTableData(tableAddresses), "base64"],
                  }
                : null,
            ),
          },
        })
      if (body.method === "getBalance") return ok({ jsonrpc: "2.0", id: body.id, result: { value: 4_000_000_000 } })
      throw new Error(`unexpected Solana RPC ${body.method}`)
    }
    if (path.includes("/jobs/")) {
      if (!built) return Response.json({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, { status: 404 })
      if (opts.jobsDown)
        return Response.json(
          { error: { code: "SERVICE_UNAVAILABLE", message: "try again", retryable: true } },
          { status: 503 },
        )
      const jobs = opts.jobs ?? [{ status: "built" }]
      const job = jobs[Math.min(jobReads, jobs.length - 1)]
      jobReads += 1
      return ok({ success: true, job: { clientTradeId: "b-1", kind: "swap", ...job } })
    }
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["swap:write"],
        privyAppId: "app",
        page: (opts.rows ?? ["sol", "hood"]).map((row) => ({
          ...rowsFor[row],
          active: true,
          allowLaunch: false,
          privyWalletId: `privy-${row}`,
        })),
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
    if (path === "/api/v1/agent/keys/self/limits") return ok({ success: true, keyLimits: null })
    if (path === "/api/v1/agent/swap/build") {
      built = true
      const hood = body.from === "ETH" || body.from === "USDG"
      const destination = hood ? solanaTee : body.toWalletId === "hood-tee-2" ? hoodTee2 : hoodTee
      return ok({
        success: true,
        payload: {
          status: "built",
          swapId: "swap-b",
          clientTradeId: body.clientTradeId,
          venue: "relay",
          from: body.from,
          to: body.to,
          amountRaw: body.amountRaw,
          fee: opts.fee ?? { bps: 0, feeRaw: "0" },
          expectedOutRaw: hood ? "180000000" : "16000000000000000",
          outDecimals: hood ? 9 : 18,
          statusChecks: [STATUS_URL],
          recipient: opts.recipient ?? destination,
          ...(hood
            ? { chain: "hood", walletAddress: hoodTee, ...sequenced(0) }
            : {
                minOutRaw: null,
                transactionsBase64: [opts.transaction ?? solanaDeposit()],
                venueCostUsd: 0.12,
                venueTimeEstimateSec: 20,
                expiresAt: 10_000,
              }),
        },
      })
    }
    if (path.endsWith("/sign")) {
      if (body.body.method === "signTransaction")
        return ok({ success: true, signedTransaction: body.body.params.transaction, encoding: "base64" })
      const wire = body.body.params.transaction
      const signed = signTransaction(
        {
          chainId: BigInt(wire.chain_id),
          nonce: BigInt(wire.nonce),
          maxPriorityFeePerGas: hexToBigInt(wire.max_priority_fee_per_gas),
          maxFeePerGas: hexToBigInt(wire.max_fee_per_gas),
          gas: hexToBigInt(wire.gas_limit),
          to: wire.to,
          value: hexToBigInt(wire.value),
          data: hexToBytes(wire.data),
        },
        teeSecret,
      )
      return ok({ success: true, signedTransaction: bytesToHex(signed.raw), encoding: "rlp" })
    }
    if (path === "/api/v1/agent/swap/submit") {
      if (body.signedTransactionsBase64)
        return ok({
          success: true,
          payload: {
            hashes: ["SolDeposit1"],
            statusChecks: [STATUS_URL],
            recipient: hoodTee,
            settlement: { state: "pending", legs: [{ chain: "solana", hash: "SolDeposit1", status: "confirmed" }] },
          },
        })
      const hash = `0x${String(index + 1).repeat(64)}`
      landed.push({ kind: planned[index]?.kind as string, hash })
      index += 1
      if (index < planned.length)
        return ok({ success: true, payload: { status: "built", swapId: "swap-b", ...sequenced(index) } })
      return ok({
        success: true,
        payload: {
          status: "confirmed",
          swapId: "swap-b",
          chain: "hood",
          hashes: landed.map((l) => l.hash),
          landedLegs: landed,
        },
      })
    }
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      CANDLE_EVM_RPC_URL: EVM_RPC,
      CANDLE_SOLANA_RPC_URL: SOLANA_RPC,
    },
    store: createFakeStore({
      "wallet_signer_hood-tee": pemToStoredSigner(pem),
      "wallet_signer_sol-tee": pemToStoredSigner(pem),
    }),
    stdout,
    stderr,
    promptLine: async () => opts.prompt ?? "y",
  })
  return { deps, calls, stdout, stderr }
}

const lastJson = (text: string): Record<string, unknown> => JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
const apiPaths = (calls: Array<{ url: string; path: string }>) =>
  calls.filter((call) => !call.url.startsWith(EVM_RPC) && !call.url.startsWith(SOLANA_RPC)).map((call) => call.path)
const bridgeArgs = (from: string, to: string, amount: string, extra: string[] = []) => [
  "swap",
  from,
  to,
  "--amount",
  amount,
  "--client-trade-id",
  "b-1",
  "--yes",
  "--json",
  ...extra,
]

describe("R1: which pairs bridge", () => {
  test("CNDL against ETH is still CHAIN_MISMATCH before any request", async () => {
    const f = await fixture()
    expect(await run(["swap", "CNDL", "ETH", "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(f.calls).toEqual([])
  })

  test("--to and --wait on a same-chain swap are a usage error before any request", async () => {
    const f = await fixture()
    expect(await run(["swap", "SOL", "USDC", "--amount", "1", "--to", "hood", "--yes", "--json"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })

  test("a 0x --wallet on a Solana-origin bridge is CHAIN_MISMATCH before any request", async () => {
    const f = await fixture()
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--wallet", hoodTee]), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(f.calls).toEqual([])
  })

  test("the embedded wallet does not bridge: CHAIN_MISMATCH before any build", async () => {
    const embedded = Keypair.generate().publicKey.toBase58()
    const f = await fixture({ rows: ["hood"], embedded: { solana: embedded } })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("CHAIN_MISMATCH")
    expect(apiPaths(f.calls)).not.toContain("/api/v1/agent/swap/build")
  })
})

describe("4c-ED-1: the destination is this key's own TEE wallet", () => {
  test("no TEE wallet on the other chain refuses BRIDGE_DESTINATION_MISSING before any build", async () => {
    const f = await fixture({ rows: ["sol"] })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("BRIDGE_DESTINATION_MISSING")
    expect(String(out.message)).toContain("vault promote")
    expect(apiPaths(f.calls)).not.toContain("/api/v1/agent/swap/build")
  })

  test("two need --to; --to is sent as toWalletId; an unknown --to refuses before any build", async () => {
    const two = await fixture({ rows: ["sol", "hood", "hood2"] })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), two.deps)).toBe(1)
    expect(lastJson(two.stdout.text).code).toBe("BRIDGE_DESTINATION_MISSING")
    expect(String(lastJson(two.stdout.text).message)).toContain("--to")

    const named = await fixture({ rows: ["sol", "hood", "hood2"] })
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--to", "hood2"]), named.deps)).toBe(0)
    expect(named.calls.find((call) => call.path === "/api/v1/agent/swap/build")?.body?.toWalletId).toBe("hood-tee-2")

    const unknown = await fixture({ rows: ["sol", "hood"] })
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--to", "sol"]), unknown.deps)).toBe(1)
    expect(lastJson(unknown.stdout.text).code).toBe("BRIDGE_DESTINATION_MISSING")
    expect(apiPaths(unknown.calls)).not.toContain("/api/v1/agent/swap/build")
  })

  test("a recipient the key does not list is refused before anything is signed", async () => {
    const f = await fixture({ recipient: "0x9999999999999999999999999999999999999999" })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(apiPaths(f.calls).some((path) => path.endsWith("/sign"))).toBe(false)
  })

  test("a Candle fee on a bridge quote is refused before anything is signed (4c-AD-4)", async () => {
    const f = await fixture({ fee: { bps: 100, feeRaw: "10000000" } })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(apiPaths(f.calls).some((path) => path.endsWith("/sign"))).toBe(false)
  })
})

describe("Solana origin (4c-ED-6)", () => {
  test("SOL to ETH: checked, relay-signed, submitted; the deposit prints and the command returns", async () => {
    const f = await fixture()
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(0)
    const build = f.calls.find((call) => call.path === "/api/v1/agent/swap/build")?.body
    expect(build).toMatchObject({
      clientTradeId: "b-1",
      from: "SOL",
      to: "ETH",
      amountRaw: "1000000000",
      payer: { type: "linked", linkedWalletId: "sol-tee" },
    })
    expect(build?.toWalletId).toBeUndefined()
    const submit = f.calls.find((call) => call.path === "/api/v1/agent/swap/submit")?.body
    expect(submit).toMatchObject({ clientTradeId: "b-1", swapId: "swap-b" })
    const out = lastJson(f.stdout.text)
    expect(out.bridge).toMatchObject({ from: "SOL", to: "ETH", destination: hoodTee, depositHash: "SolDeposit1" })
    expect(out.quote).toMatchObject({ venue: "relay", candleFee: "none" })
    expect(String((out.quote as Record<string, unknown>).destination)).toContain(hoodTee)
    expect(f.stderr.text).toContain("Candle fee: none")
    expect(f.stderr.text).toContain("Relay fees: about $0.12")
    expect(f.stderr.text).toContain("Deposit SolDeposit1: filling.")
    expect(f.stderr.text).toContain("candle swap status b-1")
    // No job read after the submit without --wait.
    expect(apiPaths(f.calls).filter((path) => path.includes("/jobs/"))).toHaveLength(1)
  })

  test("a Compute Budget instruction in the deposit refuses RELAY_STEP_REFUSED before the relay signs", async () => {
    const f = await fixture({
      transaction: solanaDeposit([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 })]),
    })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("RELAY_STEP_REFUSED")
    expect(String(out.message)).toContain("Compute Budget")
    expect(apiPaths(f.calls).some((path) => path.endsWith("/sign"))).toBe(false)
  })

  test("--wait follows the job until it fills, and says what arrived", async () => {
    const f = await fixture({
      jobs: [
        { status: "built" },
        {
          status: "submitted",
          signature: "SolDeposit1",
          settlement: { state: "pending", legs: [{ chain: "solana", hash: "SolDeposit1", status: "confirmed" }] },
          bridge: { state: "open", blockingUntil: 7_200_000 },
        },
        {
          status: "submitted",
          signature: "SolDeposit1",
          settlement: {
            state: "settled",
            legs: [{ chain: "solana", hash: "SolDeposit1", status: "confirmed" }],
            settledOutRaw: "15900000000000000",
          },
        },
      ],
    })
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--wait"]), f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out.bridgeStatus).toMatchObject({ phase: "filled", settledOutRaw: "15900000000000000" })
    expect(out.waited).toEqual({ final: true })
    expect(f.stderr.text).toContain(`Filled: received 0.015900000000000000 ETH at ${hoodTee}.`)
    expect(f.stderr.text).toContain(`Relay status: ${STATUS_URL}`)
  })

  test("--wait gives up after ten minutes and says how to re-check", async () => {
    const f = await fixture({
      jobs: [
        { status: "built" },
        {
          status: "submitted",
          settlement: { state: "pending", legs: [{ chain: "solana", hash: "SolDeposit1", status: "confirmed" }] },
          bridge: { state: "open", blockingUntil: 7_200_000 },
        },
      ],
    })
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--wait"]), f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out.bridgeStatus).toMatchObject({ phase: "filling", open: "open" })
    expect(out.waited).toEqual({ final: false })
    expect(f.stderr.text).toContain("Still not final after ten minutes")
    // Ten minutes at ten seconds a read, plus the reads before and after the loop.
    expect(apiPaths(f.calls).filter((path) => path.includes("/jobs/")).length).toBeGreaterThanOrEqual(60)
  })
})

describe("Hood origin (4c-ED-6, 4c-ED-7)", () => {
  test("USDG to USDC: the exact approve, then the deposit, each checked and relay-signed", async () => {
    const f = await fixture({
      legs: [
        { kind: "approval", leg: approveLeg("20000000") },
        { kind: "bridgeDeposit", leg: usdgDepositLeg("20000000") },
      ],
    })
    expect(await run(bridgeArgs("USDG", "USDC", "20"), f.deps)).toBe(0)
    expect(f.calls.filter((call) => call.path.endsWith("/sign"))).toHaveLength(2)
    const out = lastJson(f.stdout.text)
    expect(out.bridge).toMatchObject({
      from: "USDG",
      to: "USDC",
      destination: solanaTee,
      depositHash: `0x${"2".repeat(64)}`,
    })
    expect(out.landedLegs).toEqual([
      { kind: "approval", hash: `0x${"1".repeat(64)}` },
      { kind: "bridgeDeposit", hash: `0x${"2".repeat(64)}` },
    ])
    expect(f.stderr.text).toContain("Legs, signed one at a time: approve, bridge deposit")
  })

  test("ETH to SOL: a deposit whose depositor is not this wallet is refused before the relay signs", async () => {
    const f = await fixture({ legs: [{ kind: "bridgeDeposit", leg: ethDepositLeg("10000000000000000", hoodTee2) }] })
    expect(await run(bridgeArgs("ETH", "SOL", "0.01"), f.deps)).toBe(1)
    const out = lastJson(f.stdout.text)
    expect(out.code).toBe("RELAY_STEP_REFUSED")
    expect(String(out.message)).toContain("depositor")
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("a later deposit leg for another amount is refused after the approve landed; it is never signed", async () => {
    const f = await fixture({
      legs: [
        { kind: "approval", leg: approveLeg("20000000") },
        { kind: "bridgeDeposit", leg: usdgDepositLeg("20000001") },
      ],
    })
    expect(await run(bridgeArgs("USDG", "USDC", "20"), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.calls.filter((call) => call.path.endsWith("/sign"))).toHaveLength(1)
  })

  test("USDG whose allowance already covers the amount is the deposit alone, and it bridges (4c-ED-5)", async () => {
    const f = await fixture({ legs: [{ kind: "bridgeDeposit", leg: usdgDepositLeg("20000000") }] })
    expect(await run(bridgeArgs("USDG", "USDC", "20"), f.deps)).toBe(0)
    expect(f.calls.filter((call) => call.path.endsWith("/sign"))).toHaveLength(1)
    const out = lastJson(f.stdout.text)
    expect(out.landedLegs).toEqual([{ kind: "bridgeDeposit", hash: `0x${"1".repeat(64)}` }])
    expect(f.stderr.text).toContain("Legs, signed one at a time: bridge deposit")
  })

  test("an approve on a native ETH bridge is refused before anything is signed", async () => {
    const f = await fixture({
      legs: [
        { kind: "approval", leg: approveLeg("10000000000000000") },
        { kind: "bridgeDeposit", leg: ethDepositLeg("10000000000000000") },
      ],
    })
    expect(await run(bridgeArgs("ETH", "SOL", "0.01"), f.deps)).toBe(1)
    expect(lastJson(f.stdout.text).code).toBe("RELAY_STEP_REFUSED")
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })

  test("declining the quote signs nothing and says the wallet is held", async () => {
    const f = await fixture({ legs: [{ kind: "bridgeDeposit", leg: ethDepositLeg("10000000000000000") }], prompt: "n" })
    expect(await run(["swap", "ETH", "SOL", "--amount", "0.01", "--client-trade-id", "b-1", "--json"], f.deps)).toBe(0)
    expect(lastJson(f.stdout.text)).toMatchObject({ status: "cancelled", operationId: "op-b" })
    expect(f.calls.some((call) => call.path.endsWith("/sign"))).toBe(false)
  })
})

describe("--wait never turns a sent bridge into a failure", () => {
  test("a job read that fails after the deposit was submitted prints the receipt, not an error", async () => {
    const f = await fixture({ jobsDown: true })
    expect(await run(bridgeArgs("SOL", "ETH", "1", ["--wait"]), f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out.bridge).toMatchObject({ depositHash: "SolDeposit1" })
    expect(out.waited).toMatchObject({ final: false })
    expect(String((out.waited as Record<string, unknown>).error)).toContain("try again")
    expect(f.stderr.text).toContain("The deposit was sent; do not send it again")
    expect(f.calls.filter((call) => call.path === "/api/v1/agent/swap/submit")).toHaveLength(1)
  })

  test("status --wait on a bridge that was never broadcast returns at once", async () => {
    const f = await fixture({ legs: [{ kind: "bridgeDeposit", leg: ethDepositLeg("10000000000000000") }], prompt: "n" })
    expect(await run(["swap", "ETH", "SOL", "--amount", "0.01", "--client-trade-id", "b-1", "--json"], f.deps)).toBe(0)
    const before = f.calls.filter((call) => call.path.includes("/jobs/")).length
    expect(await run(["swap", "status", "b-1", "--wait", "--json"], f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out.bridgeStatus).toMatchObject({ phase: "not_broadcast" })
    expect(out.waited).toEqual({ final: true })
    expect(f.calls.filter((call) => call.path.includes("/jobs/")).length - before).toBe(1)
  })
})

describe("swap status renders a bridge (4c-ED-9)", () => {
  test("open, then the two-hour warning, in words and in bridgeStatus", async () => {
    const f = await fixture({
      jobs: [
        {
          status: "submitted",
          settlement: { state: "pending", legs: [{ chain: "solana", hash: "SolDeposit1", status: "confirmed" }] },
          bridge: { state: "uncertain" },
        },
      ],
    })
    expect(await run(bridgeArgs("SOL", "ETH", "1"), f.deps)).toBe(0)
    f.stderr.text = ""
    expect(await run(["swap", "status", "b-1", "--json"], f.deps)).toBe(0)
    expect(lastJson(f.stdout.text).bridgeStatus).toMatchObject({ phase: "filling", open: "uncertain" })
    expect(f.stderr.text).toContain("Deposit landed; Relay is filling.")
    expect(f.stderr.text).toContain("no result after two hours")
  })

  test("a swap this machine did not record as a bridge, with no open bridge, prints as before", async () => {
    const f = await fixture({ built: true, jobs: [{ status: "submitted", signature: "S1" }] })
    expect(await run(["swap", "status", "same-1", "--kind", "swap", "--json"], f.deps)).toBe(0)
    const out = lastJson(f.stdout.text)
    expect(out.job).toMatchObject({ status: "submitted" })
    expect(out.bridgeStatus).toBeUndefined()
    expect(f.stderr.text).toBe("")
  })
})
