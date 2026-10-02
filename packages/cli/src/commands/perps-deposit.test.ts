/**
 * Hyperliquid perps C (BE-647, HL-ED-8, R2): `candle perps deposit` against a fake API, a fake relay
 * that really signs Hood legs, and a fake Solana RPC that serves the deposit's lookup table.
 *
 * What is pinned: the asset picks the paying TEE wallet's chain; from Hood the Hyperliquid account
 * is that wallet's own address and `--to` is refused, from Solana it is the key's EVM TEE wallet;
 * a build that lands elsewhere, on another chain or currency, or with a Candle fee is refused with
 * nothing signed; each Hood leg and the Solana deposit pass `candle swap`'s bridge checks before the
 * relay signs; the signed legs or deposit go to `/perps/deposit/submit`; and `deposit status` reads.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AddressLookupTableAccount,
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
const solanaKey = Keypair.generate()
const solanaTee = solanaKey.publicKey.toBase58()
const SOLANA_RPC = "http://localhost/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const REQUEST_ID = "ab".repeat(32)
const USDC_HL = "0x00000000000000000000000000000000"
const table = Keypair.generate().publicKey
const tableAddresses = [Keypair.generate().publicKey, Keypair.generate().publicKey]

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")
const uint = (value: bigint | string) => BigInt(value).toString(16).padStart(64, "0")
const leg = (nonce: number, to: string, data: string): SequencedLeg => ({
  chainId: 4663,
  nonce,
  gas: "90000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000",
  to,
  data,
  value: "0",
})
const approveLeg = (amount: string) =>
  leg(7, HOOD_USDG_ADDRESS, `0x095ea7b3${pad(RELAY_HOOD_DEPOSITORY)}${uint(amount)}`)
const depositLeg = (amount: string) =>
  leg(
    8,
    RELAY_HOOD_DEPOSITORY,
    `${RELAY_HOOD_DEPOSIT_ERC20_SELECTOR}${pad(hoodTee)}${pad(HOOD_USDG_ADDRESS)}${uint(amount)}${REQUEST_ID}`,
  )

function lookupTableData(addresses: PublicKey[]): string {
  const data = new Uint8Array(56 + 32 * addresses.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 0xffffffffffffffffn, true)
  for (const [i, address] of addresses.entries()) data.set(address.toBytes(), 56 + 32 * i)
  return Buffer.from(data).toString("base64")
}

function solanaDeposit(program = RELAY_SOLANA_DEPOSITORY_PROGRAM): string {
  const deposit = new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: solanaKey.publicKey, isSigner: true, isWritable: true },
      ...tableAddresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([9]),
  })
  const message = new TransactionMessage({
    payerKey: solanaKey.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [deposit],
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

interface Options {
  /** Overrides on the build's top level, or on its `destination`. */
  build?: Record<string, unknown>
  destination?: Record<string, unknown>
  legs?: Array<{ kind: "approval" | "bridgeDeposit"; leg: SequencedLeg }>
  transaction?: string
  evmRows?: number
}

async function fixture(opts: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-perps-deposit-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const planned = opts.legs ?? [
    { kind: "approval" as const, leg: approveLeg("25000000") },
    { kind: "bridgeDeposit" as const, leg: depositLeg("25000000") },
  ]
  const landed: Array<{ kind: string; hash: string }> = []
  let index = 0
  const sequenced = (i: number) => ({
    mode: "sequenced",
    operationId: "op-d",
    legKind: planned[i]?.kind,
    legIndex: i,
    plannedLegCount: planned.length,
    nextLeg: planned[i]?.leg,
    landedLegs: [...landed],
    expiresAt: 10_000,
  })
  const evmRows = Array.from({ length: opts.evmRows ?? 1 }, (_, i) => ({
    id: i === 0 ? "hood-tee" : `hood-tee-${i + 1}`,
    address: i === 0 ? hoodTee : evmAddressFromSecret(hexToBytes(`0x${String(44 + i).repeat(32)}`)),
    label: i === 0 ? "hood" : `hood${i + 1}`,
    chain: "evm",
  }))
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    const ok = (value: unknown) => Response.json(value)
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
      throw new Error(`unexpected Solana RPC ${body.method}`)
    }
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["swap:write"],
        privyAppId: "app",
        page: [{ id: "sol-tee", address: solanaTee, label: "sol", chain: "solana" }, ...evmRows].map((row) => ({
          ...row,
          active: true,
          allowLaunch: false,
          privyWalletId: `privy-${row.id}`,
        })),
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded") return ok({ success: true, wallets: { solana: null, evm: null } })
    if (path === "/api/v1/agent/keys/self/limits") return ok({ success: true, keyLimits: null })
    if (path === "/api/v1/agent/perps/deposit") {
      const hood = body.asset === "ETH" || body.asset === "USDG"
      const destinationWallet = evmRows.find((row) => row.id === (hood ? body.walletId : body.perpsWalletId))
      return ok({
        success: true,
        status: "built",
        clientDepositId: body.clientDepositId,
        depositId: "dep-1",
        chain: hood ? "hood" : "solana",
        venue: "relay",
        network: "mainnet",
        asset: body.asset,
        amountRaw: body.amountRaw,
        walletId: body.walletId,
        walletAddress: hood ? hoodTee : solanaTee,
        destination: {
          walletId: destinationWallet?.id,
          address: destinationWallet?.address,
          chainId: 1337,
          currency: USDC_HL,
          ...opts.destination,
        },
        firstDeposit: true,
        expectedOutRaw: "2497000000",
        minimumOutRaw: "2472000000",
        outDecimals: 8,
        fee: { bps: 0, feeRaw: "0" },
        statusChecks: ["/intents/status?requestId=0xr1"],
        requestId: "0xr1",
        ...(hood ? sequenced(0) : { expiresAt: 10_000, transactionsBase64: [opts.transaction ?? solanaDeposit()] }),
        ...opts.build,
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
    if (path === "/api/v1/agent/perps/deposit/submit") {
      if (body.signedTransactionsBase64)
        return ok({ success: true, status: "submitted", chain: "solana", hashes: ["SolDeposit1"] })
      const hash = `0x${String(index + 1).repeat(64)}`
      landed.push({ kind: planned[index]?.kind as string, hash })
      index += 1
      if (index < planned.length) return ok({ success: true, status: "built", chain: "hood", ...sequenced(index) })
      return ok({
        success: true,
        status: "submitted",
        chain: "hood",
        hashes: landed.map((l) => l.hash),
        landedLegs: landed,
      })
    }
    if (path === "/api/v1/agent/perps/deposit/dep-x")
      return ok({
        success: true,
        job: {
          clientDepositId: "dep-x",
          status: "submitted",
          signature: "0xbbb",
          asset: "USDG",
          amountRaw: "25000000",
          destination: { address: hoodTee },
          relay: { status: "success" },
        },
      })
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key" },
    store: createFakeStore({
      "wallet_signer_sol-tee": pemToStoredSigner(pem),
      "wallet_signer_hood-tee": pemToStoredSigner(pem),
    }),
    stdout,
    stderr,
    promptLine: async () => "y",
  })
  return { deps, calls, stdout, stderr }
}

const paths = (calls: { path: string }[]) => calls.map((c) => c.path)

describe("candle perps deposit from Hood", () => {
  test("builds to the wallet's own account, checks each leg, signs and submits them one at a time", async () => {
    const f = await fixture()
    expect(await run(["perps", "deposit", "25", "USDG", "--id", "dep-1", "--yes", "--json"], f.deps)).toBe(0)
    const build = f.calls.find((c) => c.path === "/api/v1/agent/perps/deposit")?.body
    expect(build).toEqual({
      clientDepositId: "dep-1",
      walletId: "hood-tee",
      asset: "USDG",
      amountRaw: "25000000",
      maxSlippageBps: 100,
    })
    const submits = f.calls.filter((c) => c.path === "/api/v1/agent/perps/deposit/submit")
    expect(submits).toHaveLength(2)
    expect(submits[0]?.body).toMatchObject({ clientDepositId: "dep-1", depositId: "dep-1", operationId: "op-d" })
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ status: "submitted", clientDepositId: "dep-1" })
    expect(paths(f.calls)).not.toContain("/api/v1/agent/swap/submit")
  })

  test("--to is refused from Hood: the account is the paying wallet's own", async () => {
    const f = await fixture()
    expect(await run(["perps", "deposit", "25", "USDG", "--to", "hood", "--yes", "--json"], f.deps)).toBe(1)
    expect(paths(f.calls)).not.toContain("/api/v1/agent/perps/deposit")
  })

  test("a build that lands on another address, chain or currency, or charges a fee, signs nothing", async () => {
    for (const opts of [
      { destination: { address: "0x2222222222222222222222222222222222222222" } },
      { destination: { chainId: 42161 } },
      { destination: { currency: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" } },
      { build: { fee: { bps: 10, feeRaw: "25000" } } },
      { build: { amountRaw: "250000000" } },
    ]) {
      const f = await fixture(opts)
      expect(await run(["perps", "deposit", "25", "USDG", "--yes", "--json"], f.deps)).toBe(1)
      expect(f.stderr.text + f.stdout.text).toContain("PERPS_BUILD_REFUSED")
      expect(paths(f.calls).some((p) => p.endsWith("/sign"))).toBe(false)
    }
  })

  test("a deposit leg to another contract is refused before the relay signs", async () => {
    const f = await fixture({
      legs: [
        { kind: "bridgeDeposit", leg: { ...depositLeg("25000000"), to: "0x000000000000000000000000000000000000dEaD" } },
      ],
    })
    expect(await run(["perps", "deposit", "25", "USDG", "--yes", "--json"], f.deps)).toBe(1)
    expect(paths(f.calls).some((p) => p.endsWith("/sign"))).toBe(false)
  })

  test("--no-submit builds and checks only", async () => {
    const f = await fixture()
    expect(await run(["perps", "deposit", "25", "USDG", "--no-submit", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ signed: false, submitted: false })
    expect(paths(f.calls).some((p) => p.endsWith("/sign"))).toBe(false)
  })
})

describe("candle perps deposit from Solana", () => {
  test("names the key's EVM TEE wallet as the account, checks the deposit, relay-signs, submits", async () => {
    const f = await fixture()
    const args = ["perps", "deposit", "20", "USDC", "--rpc-url", SOLANA_RPC, "--yes", "--json"]
    expect(await run(args, f.deps)).toBe(0)
    expect(f.calls.find((c) => c.path === "/api/v1/agent/perps/deposit")?.body).toMatchObject({
      walletId: "sol-tee",
      perpsWalletId: "hood-tee",
      asset: "USDC",
      amountRaw: "20000000",
    })
    const submit = f.calls.find((c) => c.path === "/api/v1/agent/perps/deposit/submit")?.body
    expect(submit).toMatchObject({ depositId: "dep-1", signedTransactionsBase64: [expect.any(String)] })
  })

  test("two EVM TEE wallets need --to", async () => {
    const f = await fixture({ evmRows: 2 })
    const args = ["perps", "deposit", "20", "USDC", "--rpc-url", SOLANA_RPC, "--yes", "--json"]
    expect(await run(args, f.deps)).toBe(1)
    expect(f.stderr.text + f.stdout.text).toContain("TEE_WALLET_REQUIRED")
    const named = await fixture({ evmRows: 2 })
    expect(await run([...args, "--to", "hood2"], named.deps)).toBe(0)
    expect(named.calls.find((c) => c.path === "/api/v1/agent/perps/deposit")?.body?.perpsWalletId).toBe("hood-tee-2")
  })

  test("a deposit that calls another program is refused before the relay signs", async () => {
    const f = await fixture({ transaction: solanaDeposit(Keypair.generate().publicKey.toBase58()) })
    const args = ["perps", "deposit", "20", "USDC", "--rpc-url", SOLANA_RPC, "--yes", "--json"]
    expect(await run(args, f.deps)).toBe(1)
    expect(paths(f.calls).some((p) => p.endsWith("/sign"))).toBe(false)
  })
})

test("candle perps deposit status reads the job", async () => {
  const f = await fixture()
  expect(await run(["perps", "deposit", "status", "dep-x"], f.deps)).toBe(0)
  expect(f.stdout.text).toContain("submitted")
  expect(f.stdout.text).toContain("Relay: success")
})

test("usage: an unknown asset or a bad id is exit 2", async () => {
  const f = await fixture()
  expect(await run(["perps", "deposit", "25", "CNDL", "--yes"], f.deps)).toBe(2)
  expect(await run(["perps", "deposit", "25", "USDG", "--id", "has space", "--yes"], f.deps)).toBe(2)
  expect(f.calls).toEqual([])
})
