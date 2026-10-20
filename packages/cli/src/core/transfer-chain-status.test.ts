/**
 * T4-14 (T-8): the chain's `status` never calls a send "expired" because of a gap between two
 * reads. Fake RPCs only; the transaction lands inside the gap.
 */
import { describe, expect, test } from "bun:test"
import { requiredDepth } from "../evm-lite"
import type { TransferRef } from "./cards"
import { createTransferChain } from "./transfer-chain"

const HOOD_REF: TransferRef = { source: "vault", chain: "hood", from: "0xfrom", to: "0xto", id: "0xhash", nonce: "5" }
const SOL_REF: TransferRef = { source: "vault", chain: "solana", from: "A", to: "B", id: "sig1", blockhash: "bh1" }

function chainWith(rpc: { solana?: Record<string, unknown>; hood?: Record<string, unknown> }) {
  return createTransferChain({
    solana: () => ({ rpc: rpc.solana ?? {} }) as never,
    hood: { rpc: (rpc.hood ?? {}) as never, builtIn: false },
    executor: {} as never,
    pendingDir: "/nonexistent",
    recordDestination: async () => {},
  })
}

describe("T4-14: status never settles expired across a read gap", () => {
  test("Solana: landed between the status read and the blockhash check", async () => {
    let reads = 0
    const chain = chainWith({
      solana: {
        getSignatureStatus: async () => (++reads === 1 ? null : { confirmationStatus: "finalized", err: null }),
        isBlockhashValid: async () => false,
      },
    })
    expect(await chain.status(SOL_REF)).toEqual({ state: "finalized" })
  })

  test("Solana: still absent on the second read is expired; a failed second read throws", async () => {
    const absent = chainWith({
      solana: { getSignatureStatus: async () => null, isBlockhashValid: async () => false },
    })
    expect(await absent.status(SOL_REF)).toEqual({ state: "not_found", expired: true })
    let reads = 0
    const flaky = chainWith({
      solana: {
        getSignatureStatus: async () => {
          if (++reads === 2) throw new Error("rpc down")
          return null
        },
        isBlockhashValid: async () => false,
      },
    })
    await expect(flaky.status(SOL_REF)).rejects.toThrow("rpc down")
  })

  test("Hood: mined between the receipt read and the nonce read", async () => {
    let reads = 0
    const depth = BigInt(requiredDepth(BigInt(4663)))
    const chain = chainWith({
      hood: {
        getTransactionReceipt: async () => (++reads === 1 ? null : { status: 1, blockNumber: 100n }),
        getTransactionCount: async () => 6n,
        blockNumber: async () => 100n + depth,
      },
    })
    expect(await chain.status(HOOD_REF)).toEqual({ state: "finalized" })
  })

  test("Hood: a passed nonce with still no receipt is expired; a failed second read throws", async () => {
    const replaced = chainWith({
      hood: { getTransactionReceipt: async () => null, getTransactionCount: async () => 6n },
    })
    expect(await replaced.status(HOOD_REF)).toEqual({ state: "not_found", expired: true })
    let reads = 0
    const flaky = chainWith({
      hood: {
        getTransactionReceipt: async () => {
          if (++reads === 2) throw new Error("rpc down")
          return null
        },
        getTransactionCount: async () => 6n,
      },
    })
    await expect(flaky.status(HOOD_REF)).rejects.toThrow("rpc down")
  })
})
