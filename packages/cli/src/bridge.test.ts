/**
 * Ember Phase 4c rollout C (BE-560, spec 2026-09-29-ember-phase-4c-relay-bridging-design.md, T5):
 * the CLI's own check of a bridge, from its copy of the pinned constants.
 *
 * Every Hood mutation T1 names for the server's verifier is refused here too: another `to`, another
 * spender, a larger approve, another selector, a changed `depositor`, `token` or `amount`, a wrong
 * calldata length or value. The Solana deposit is refused for another fee payer, an extra signer,
 * an extra program, a Compute Budget instruction and a lookup table that does not resolve; the
 * simulation, the network-fee cap and the `details.recipient` echo are the server's alone (the CLI
 * only sees the compiled transaction). The Solana fixtures are built with `@solana/web3.js` as an
 * independent oracle, as `solana-alt.test.ts` does.
 */
import { describe, expect, test } from "bun:test"
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import {
  bridgeDisableWarnings,
  bridgeLegKinds,
  bridgePair,
  bridgePlanAdmitted,
  bridgeStatusFinal,
  bridgeSweepGate,
  describeBridgeJob,
  relayHoodLegProblem,
  relaySolanaDepositProblem,
  walletBridgesOf,
} from "./bridge"
import { HOOD_USDG_ADDRESS } from "./evm-lite"
import {
  RELAY_HOOD_DEPOSIT_ERC20_SELECTOR,
  RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR,
  RELAY_HOOD_DEPOSITORY,
  RELAY_SOLANA_DEPOSITORY_PROGRAM,
} from "./relay-constants"
import type { AccountView, SolanaRpc } from "./solana-lite"
import { classifyAsset, plannedLegKinds, type SequencedLeg } from "./trading"

const PAYER = "0x1111111111111111111111111111111111111111"
const OTHER = "0x2222222222222222222222222222222222222222"
const AMOUNT = "20000000"
const REQUEST_ID = `${"ab".repeat(32)}`

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")
const uint = (value: bigint | string) => BigInt(value).toString(16).padStart(64, "0")

function leg(to: string, data: string, value = "0"): SequencedLeg {
  return {
    chainId: 4663,
    nonce: 3,
    gas: "90000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000",
    to,
    data,
    value,
  }
}
const approve = (spender = RELAY_HOOD_DEPOSITORY, amount = AMOUNT, to = HOOD_USDG_ADDRESS) =>
  leg(to, `0x095ea7b3${pad(spender)}${uint(amount)}`)
const ethDeposit = (depositor = PAYER, value = AMOUNT, selector = RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR) =>
  leg(RELAY_HOOD_DEPOSITORY, `${selector}${pad(depositor)}${REQUEST_ID}`, value)
const usdgDeposit = (
  depositor = PAYER,
  token = HOOD_USDG_ADDRESS,
  amount = AMOUNT,
  selector = RELAY_HOOD_DEPOSIT_ERC20_SELECTOR,
) => leg(RELAY_HOOD_DEPOSITORY, `${selector}${pad(depositor)}${pad(token)}${uint(amount)}${REQUEST_ID}`)

const usdg = { origin: "USDG" as const, payer: PAYER, amountRaw: AMOUNT }
const eth = { origin: "ETH" as const, payer: PAYER, amountRaw: AMOUNT }

describe("which pairs bridge (4c-ED-2)", () => {
  test("SOL or USDC against ETH or USDG, either way; nothing else", () => {
    const pair = (a: string, b: string) => bridgePair(classifyAsset(a), classifyAsset(b))
    expect(pair("SOL", "ETH")).toEqual({ from: "SOL", to: "ETH" })
    expect(pair("USDC", "USDG")).toEqual({ from: "USDC", to: "USDG" })
    expect(pair("ETH", "SOL")).toEqual({ from: "ETH", to: "SOL" })
    expect(pair("USDG", "USDC")).toEqual({ from: "USDG", to: "USDC" })
    expect(pair("CNDL", "ETH")).toBeNull()
    expect(pair("SOL", "0x3333333333333333333333333333333333333333")).toBeNull()
    expect(pair("SOL", "USDC")).toBeNull()
    expect(pair("ETH", "USDG")).toBeNull()
  })

  test("plannedLegKinds learns both bridge shapes (4c-ED-7), and never a fee", () => {
    expect(plannedLegKinds("approval", 2, false, "bridgeDeposit")).toEqual(["approval", "bridgeDeposit"])
    expect(plannedLegKinds("bridgeDeposit", 1, false, "bridgeDeposit")).toEqual(["bridgeDeposit"])
    expect(plannedLegKinds("bridgeDeposit", 2, false, "bridgeDeposit")).toBeUndefined()
    expect(plannedLegKinds("approval", 2, true, "bridgeDeposit")).toBeUndefined()
    expect(bridgeLegKinds("USDG")).toEqual(["approval", "bridgeDeposit"])
    expect(bridgeLegKinds("ETH")).toEqual(["bridgeDeposit"])
    // 4c-ED-5: zero or one approve, then the deposit. USDG may skip the approve when its allowance
    // already covers the amount; ETH never has one.
    expect(bridgePlanAdmitted("USDG", ["approval", "bridgeDeposit"])).toBe(true)
    expect(bridgePlanAdmitted("USDG", ["bridgeDeposit"])).toBe(true)
    expect(bridgePlanAdmitted("ETH", ["bridgeDeposit"])).toBe(true)
    expect(bridgePlanAdmitted("ETH", ["approval", "bridgeDeposit"])).toBe(false)
    expect(bridgePlanAdmitted("USDG", undefined)).toBe(false)
    // The trade shapes are unchanged.
    expect(plannedLegKinds("approval", 2, false)).toEqual(["approval", "trade"])
  })
})

describe("Hood legs (T5, the T1 Hood mutations from the CLI's copy)", () => {
  test("the live-shaped legs pass", () => {
    expect(relayHoodLegProblem("approval", approve(), usdg)).toBeNull()
    expect(relayHoodLegProblem("bridgeDeposit", usdgDeposit(), usdg)).toBeNull()
    expect(relayHoodLegProblem("bridgeDeposit", ethDeposit(), eth)).toBeNull()
    // Addresses compare case-insensitively.
    expect(relayHoodLegProblem("bridgeDeposit", ethDeposit(), { ...eth, payer: PAYER.toUpperCase() })).toBeNull()
  })

  const refusals: Array<[string, Parameters<typeof relayHoodLegProblem>]> = [
    ["an approve to another token", ["approval", approve(RELAY_HOOD_DEPOSITORY, AMOUNT, OTHER), usdg]],
    ["an approve for another spender", ["approval", approve(OTHER), usdg]],
    ["a larger approve", ["approval", approve(RELAY_HOOD_DEPOSITORY, "20000001"), usdg]],
    [
      "an approve with another selector",
      ["approval", leg(HOOD_USDG_ADDRESS, `0xa9059cbb${pad(RELAY_HOOD_DEPOSITORY)}${uint(AMOUNT)}`), usdg],
    ],
    ["an approve with extra calldata", ["approval", leg(HOOD_USDG_ADDRESS, `${approve().data}00`), usdg]],
    ["an approve carrying ETH", ["approval", { ...approve(), value: "1" }, usdg]],
    ["an approve on a native ETH bridge", ["approval", approve(), eth]],
    [
      "an approve with dirty address padding",
      [
        "approval",
        leg(HOOD_USDG_ADDRESS, `0x095ea7b3${"f".repeat(24)}${RELAY_HOOD_DEPOSITORY.slice(2)}${uint(AMOUNT)}`),
        usdg,
      ],
    ],
    ["a deposit to another contract", ["bridgeDeposit", { ...usdgDeposit(), to: OTHER }, usdg]],
    [
      "an ERC-20 deposit with the native selector",
      ["bridgeDeposit", usdgDeposit(PAYER, HOOD_USDG_ADDRESS, AMOUNT, RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR), usdg],
    ],
    [
      "a native deposit with the ERC-20 selector",
      ["bridgeDeposit", ethDeposit(PAYER, AMOUNT, RELAY_HOOD_DEPOSIT_ERC20_SELECTOR), eth],
    ],
    ["an unknown selector", ["bridgeDeposit", ethDeposit(PAYER, AMOUNT, "0xdeadbeef"), eth]],
    ["a changed depositor (ERC-20)", ["bridgeDeposit", usdgDeposit(OTHER), usdg]],
    ["a changed token", ["bridgeDeposit", usdgDeposit(PAYER, OTHER), usdg]],
    ["a changed amount", ["bridgeDeposit", usdgDeposit(PAYER, HOOD_USDG_ADDRESS, "20000001"), usdg]],
    ["an ERC-20 deposit carrying ETH", ["bridgeDeposit", { ...usdgDeposit(), value: "1" }, usdg]],
    [
      "an ERC-20 deposit of the wrong length",
      ["bridgeDeposit", { ...usdgDeposit(), data: `${usdgDeposit().data}00` }, usdg],
    ],
    ["a changed depositor (native)", ["bridgeDeposit", ethDeposit(OTHER), eth]],
    ["a native deposit of another value", ["bridgeDeposit", ethDeposit(PAYER, "20000001"), eth]],
    [
      "a native deposit of the wrong length",
      ["bridgeDeposit", { ...ethDeposit(), data: `${ethDeposit().data}00` }, eth],
    ],
    ["a trade leg", ["trade", usdgDeposit(), usdg]],
    ["a fee leg", ["feeTransfer", leg(OTHER, "0x", AMOUNT), eth]],
  ]
  for (const [name, args] of refusals)
    test(`refuses ${name}`, () => {
      expect(relayHoodLegProblem(...args)).toEqual(expect.any(String))
    })
})

// ── Solana ───────────────────────────────────────────────────────────────────────────────────

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const payer = Keypair.generate()
const depository = new PublicKey(RELAY_SOLANA_DEPOSITORY_PROGRAM)
const table = Keypair.generate().publicKey
const tableAddresses = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey]

function lookupTableData(addresses: PublicKey[]): Uint8Array {
  const data = new Uint8Array(56 + 32 * addresses.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 0xffffffffffffffffn, true)
  data[21] = 1
  data.set(payer.publicKey.toBytes(), 22)
  for (const [i, address] of addresses.entries()) data.set(address.toBytes(), 56 + 32 * i)
  return data
}

function rpcWith(accounts: Record<string, AccountView | null>): SolanaRpc {
  return {
    getMultipleAccounts: async (addresses: string[]) => addresses.map((address) => accounts[address] ?? null),
  } as unknown as SolanaRpc
}
const tableRpc = rpcWith({
  [table.toBase58()]: {
    owner: "AddressLookupTab1e1111111111111111111111111",
    lamports: 1n,
    data: lookupTableData(tableAddresses),
  },
})

function depositIx(extraSigner?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: depository,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      ...(extraSigner ? [{ pubkey: extraSigner, isSigner: true, isWritable: false }] : []),
      ...tableAddresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([1, 2, 3]),
  })
}

function v0(instructions: TransactionInstruction[], feePayer = payer.publicKey): string {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: BLOCKHASH,
    instructions,
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

describe("Solana deposit decode (T5)", () => {
  const address = payer.publicKey.toBase58()

  test("a one-instruction depository deposit through a resolved lookup table passes", async () => {
    expect(await relaySolanaDepositProblem(v0([depositIx()]), address, tableRpc)).toBeNull()
  })

  test("refuses another fee payer", async () => {
    const other = Keypair.generate().publicKey
    const problem = await relaySolanaDepositProblem(v0([depositIx()], other), address, tableRpc)
    expect(problem).toContain("signatures")
  })

  test("refuses a transaction whose one signer is not this wallet", async () => {
    const other = Keypair.generate()
    const ix = new TransactionInstruction({
      programId: depository,
      keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    })
    expect(await relaySolanaDepositProblem(v0([ix], other.publicKey), address, tableRpc)).toContain("fee payer")
  })

  test("refuses an extra signer", async () => {
    const problem = await relaySolanaDepositProblem(v0([depositIx(Keypair.generate().publicKey)]), address, tableRpc)
    expect(problem).toContain("2 signatures")
  })

  test("refuses an extra program", async () => {
    const transfer = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tableAddresses[0] as PublicKey,
      lamports: 1,
    })
    const problem = await relaySolanaDepositProblem(v0([depositIx(), transfer]), address, tableRpc)
    expect(problem).toContain("not Relay's depository")
  })

  test("refuses a Compute Budget instruction", async () => {
    const priority = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
    const problem = await relaySolanaDepositProblem(v0([priority, depositIx()]), address, tableRpc)
    expect(problem).toContain("Compute Budget")
  })

  test("refuses a lookup table that does not resolve, rather than skipping it", async () => {
    const problem = await relaySolanaDepositProblem(v0([depositIx()]), address, rpcWith({}))
    expect(problem).toContain("lookup table")
  })

  test("refuses bytes that are not one transaction", async () => {
    expect(await relaySolanaDepositProblem("AAAA", address, tableRpc)).toContain("does not decode")
  })
})

describe("open bridges on a wallet read (T5, 4c-ED-10)", () => {
  const open = { clientTradeId: "b1", role: "recipient", state: "open", openedAt: 1, blockingUntil: 7_200_001 }
  const uncertain = { clientTradeId: "b0", role: "source", state: "uncertain", openedAt: 1 }

  test("the field is a list, null when the server could not read it, and absent on an older API", () => {
    expect(walletBridgesOf({ bridges: [open] })).toHaveLength(1)
    expect(walletBridgesOf({ bridges: null })).toBeNull()
    expect(walletBridgesOf({ bridges: [{ nonsense: true }] })).toBeNull()
    expect(walletBridgesOf({ state: "quarantined" })).toBeUndefined()
  })

  test("an open bridge refuses the sweep BRIDGE_IN_FLIGHT, naming the operation and the status command", () => {
    const gate = bridgeSweepGate("W", walletBridgesOf({ bridges: [uncertain, open] }))
    expect(gate.refusal?.code).toBe("BRIDGE_IN_FLIGHT")
    expect(gate.refusal?.message).toContain("into W")
    expect(gate.refusal?.suggestion).toContain("candle swap status b1")
    expect(gate.refusal?.suggestion).toContain(new Date(7_200_001).toISOString())
  })

  test("uncertain is a warning, unread is a warning, none is silent", () => {
    const warned = bridgeSweepGate("W", walletBridgesOf({ bridges: [uncertain] }))
    expect(warned.refusal).toBeUndefined()
    expect(warned.warnings[0]).toContain("over two hours")
    expect(bridgeSweepGate("W", null).warnings[0]).toContain("could not say")
    expect(bridgeSweepGate("W", [])).toEqual({ warnings: [] })
    expect(bridgeSweepGate("W", undefined)).toEqual({ warnings: [] })
  })

  test("disable reports every bridge that still lands, and nothing when there is none", () => {
    expect(bridgeDisableWarnings("W", { bridges: [open] })[0]).toContain("still open")
    expect(bridgeDisableWarnings("W", { bridges: [uncertain] })[0]).toContain("unresolved after two hours")
    expect(bridgeDisableWarnings("W", { state: "quarantined" })).toEqual([])
  })
})

describe("swap status in words (T5, 4c-ED-9)", () => {
  const facts = {
    from: "SOL" as const,
    to: "ETH" as const,
    recipient: "0xDest",
    statusCheck: "https://relay/status?requestId=r1",
  }
  const legs = (status: string) => [{ chain: "solana", hash: "h1", status }]

  test("each settlement state reads as the bridge phase it is", () => {
    const filled = describeBridgeJob(
      {
        status: "submitted",
        settlement: { state: "settled", legs: legs("confirmed"), settledOutRaw: "16000000000000000" },
      },
      facts,
    )
    expect(filled.phase).toBe("filled")
    expect(filled.lines[0]).toBe("Filled: received 0.016000000000000000 ETH at 0xDest.")
    expect(filled.lines).toContain("Relay status: https://relay/status?requestId=r1")
    expect(describeBridgeJob({ settlement: { state: "pending", legs: legs("pending") } }).phase).toBe("depositing")
    expect(describeBridgeJob({ settlement: { state: "pending", legs: legs("confirmed") } }).phase).toBe("filling")
    const refunded = describeBridgeJob({ settlement: { state: "failed", legs: legs("confirmed") } })
    expect(refunded.phase).toBe("failed")
    expect(refunded.lines[0]).toContain("refunds to the source wallet")
    expect(describeBridgeJob({ settlement: { state: "failed", legs: legs("failed") } }).lines[0]).toContain(
      "did not land",
    )
    expect(describeBridgeJob({ settlement: { state: "uncertain", legs: legs("confirmed") } }).phase).toBe("uncertain")
    expect(describeBridgeJob({ status: "built", signature: null }).phase).toBe("not_broadcast")
    // Never broadcast and no longer held open by the server: nothing is coming, so --wait stops.
    expect(bridgeStatusFinal(describeBridgeJob({ status: "built", signature: null }))).toBe(true)
    expect(
      bridgeStatusFinal(
        describeBridgeJob({ status: "built", signature: null, bridge: { state: "open", blockingUntil: 7_200_000 } }),
      ),
    ).toBe(false)
    // Without this machine's facts the amount is raw units, never a guessed asset.
    expect(
      describeBridgeJob({ settlement: { state: "settled", legs: legs("confirmed"), settledOutRaw: "5" } }).lines[0],
    ).toBe("Filled: received 5 raw units.")
  })

  test("the open state and the two-hour warning; --wait stops on the end states and the warning", () => {
    const open = describeBridgeJob({
      settlement: { state: "pending", legs: legs("confirmed") },
      bridge: { state: "open", blockingUntil: 7_200_001 },
    })
    expect(open.open).toBe("open")
    expect(open.lines.some((line) => line.includes("BRIDGE_IN_FLIGHT"))).toBe(true)
    expect(bridgeStatusFinal(open)).toBe(false)
    const late = describeBridgeJob({
      settlement: { state: "pending", legs: legs("confirmed") },
      bridge: { state: "uncertain" },
    })
    expect(late.lines.some((line) => line.includes("no result after two hours"))).toBe(true)
    expect(bridgeStatusFinal(late)).toBe(true)
    for (const state of ["settled", "failed", "uncertain"])
      expect(bridgeStatusFinal(describeBridgeJob({ settlement: { state, legs: legs("confirmed") } }))).toBe(true)
  })
})
