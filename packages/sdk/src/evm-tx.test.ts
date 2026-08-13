import { describe, expect, test } from "bun:test"
import type { EvmRpc } from "./evm-tx"
import {
  assembleEvmTx,
  bigIntToHexQuantity,
  decimalToHexQuantity,
  estimateGas,
  fetchChainId,
  fetchFeeData,
  fetchNonce,
  hexToBigInt,
  waitForReceipt,
} from "./evm-tx"

/** A faked rpc seam: canned responses keyed by method, plus a call log for assertions. */
function makeRpc(
  callResults: Record<string, string | Error>,
  callRawResults: Record<string, unknown> = {},
): { rpc: EvmRpc; calls: Array<{ kind: "call" | "callRaw"; method: string; params: unknown[] }> } {
  const calls: Array<{ kind: "call" | "callRaw"; method: string; params: unknown[] }> = []
  const rpc: EvmRpc = {
    call: async (method, params) => {
      calls.push({ kind: "call", method, params })
      const result = callResults[method]
      if (result === undefined) throw new Error(`makeRpc: no canned "call" response for ${method}`)
      if (result instanceof Error) throw result
      return result
    },
    callRaw: async (method, params) => {
      calls.push({ kind: "callRaw", method, params })
      if (!(method in callRawResults)) throw new Error(`makeRpc: no canned "callRaw" response for ${method}`)
      return callRawResults[method]
    },
  }
  return { rpc, calls }
}

describe("hexToBigInt / bigIntToHexQuantity", () => {
  test("hexToBigInt parses a hex-quantity string", () => {
    expect(hexToBigInt("0x5")).toBe(5n)
    expect(hexToBigInt("0x0")).toBe(0n)
    expect(hexToBigInt("0xde0b6b3a7640000")).toBe(1_000_000_000_000_000_000n)
  })

  test("bigIntToHexQuantity produces a minimal-length hex quantity", () => {
    expect(bigIntToHexQuantity(5n)).toBe("0x5")
    expect(bigIntToHexQuantity(0n)).toBe("0x0")
    expect(bigIntToHexQuantity(1_000_000_000_000_000_000n)).toBe("0xde0b6b3a7640000")
  })

  test("bigIntToHexQuantity throws on a negative value", () => {
    expect(() => bigIntToHexQuantity(-1n)).toThrow()
  })

  test("round-trips through both directions", () => {
    const values = [0n, 1n, 255n, 65_535n, 123_456_789_012_345n]
    for (const v of values) {
      expect(hexToBigInt(bigIntToHexQuantity(v))).toBe(v)
    }
  })
})

describe("decimalToHexQuantity", () => {
  test('converts a build leg\'s decimal "value" string to a hex quantity via BigInt', () => {
    expect(decimalToHexQuantity("1000000000000000000")).toBe("0xde0b6b3a7640000")
  })

  test("zero decimal converts to 0x0", () => {
    expect(decimalToHexQuantity("0")).toBe("0x0")
  })

  test("does not lose precision the way a float conversion would", () => {
    // Well past Number.MAX_SAFE_INTEGER (2^53 - 1); a float round-trip would corrupt this.
    // Pinned literal, computed independently via `123456789012345678901234567890n.toString(16)`.
    expect(decimalToHexQuantity("123456789012345678901234567890")).toBe("0x18ee90ff6c373e0ee4e3f0ad2")
  })
})

describe("fetchNonce", () => {
  test('parses eth_getTransactionCount("pending") hex into a number', async () => {
    const { rpc, calls } = makeRpc({ eth_getTransactionCount: "0x5" })
    await expect(fetchNonce(rpc, "0xFrom")).resolves.toBe(5)
    expect(calls).toEqual([{ kind: "call", method: "eth_getTransactionCount", params: ["0xFrom", "pending"] }])
  })

  test("parses a zero nonce", async () => {
    const { rpc } = makeRpc({ eth_getTransactionCount: "0x0" })
    await expect(fetchNonce(rpc, "0xFrom")).resolves.toBe(0)
  })
})

describe("fetchChainId", () => {
  test("parses eth_chainId hex into a number", async () => {
    const { rpc, calls } = makeRpc({ eth_chainId: "0x2105" }) // 8453 = Base mainnet
    await expect(fetchChainId(rpc)).resolves.toBe(8453)
    expect(calls).toEqual([{ kind: "call", method: "eth_chainId", params: [] }])
  })
})

describe("fetchFeeData", () => {
  test("computes maxFeePerGas = 2 * baseFee + priority from the faked node", async () => {
    const { rpc, calls } = makeRpc(
      { eth_maxPriorityFeePerGas: "0x3b9aca00" }, // 1 gwei
      { eth_getBlockByNumber: { baseFeePerGas: "0x77359400" } }, // 2 gwei
    )
    const feeData = await fetchFeeData(rpc)
    // maxFee = 2 * 2gwei + 1gwei = 5gwei = 0x12a05f200
    expect(feeData.maxFeePerGasHex).toBe("0x12a05f200")
    expect(feeData.maxPriorityFeePerGasHex).toBe("0x3b9aca00")
    expect(calls).toEqual([
      { kind: "call", method: "eth_maxPriorityFeePerGas", params: [] },
      { kind: "callRaw", method: "eth_getBlockByNumber", params: ["latest", false] },
    ])
  })

  test("falls back to eth_gasPrice when the node lacks eth_maxPriorityFeePerGas", async () => {
    const { rpc, calls } = makeRpc(
      {
        eth_maxPriorityFeePerGas: new Error("the method eth_maxPriorityFeePerGas does not exist"),
        eth_gasPrice: "0x3b9aca00", // 1 gwei
      },
      { eth_getBlockByNumber: { baseFeePerGas: "0x77359400" } }, // 2 gwei
    )
    const feeData = await fetchFeeData(rpc)
    expect(feeData.maxFeePerGasHex).toBe("0x12a05f200")
    expect(feeData.maxPriorityFeePerGasHex).toBe("0x3b9aca00")
    expect(calls.map((c) => c.method)).toEqual(["eth_maxPriorityFeePerGas", "eth_gasPrice", "eth_getBlockByNumber"])
  })

  test("throws a clear error when the block has no baseFeePerGas", async () => {
    const { rpc } = makeRpc({ eth_maxPriorityFeePerGas: "0x1" }, { eth_getBlockByNumber: {} })
    await expect(fetchFeeData(rpc)).rejects.toThrow(/baseFeePerGas/)
  })
})

describe("estimateGas", () => {
  test("applies the +20% safety buffer to eth_estimateGas's result", async () => {
    const { rpc, calls } = makeRpc({ eth_estimateGas: "0x186a0" }) // 100_000
    const gasHex = await estimateGas(rpc, { from: "0xFrom", to: "0xTo", data: "0xdeadbeef", value: "0x0" })
    // 100_000 * 1.2 = 120_000 = 0x1d4c0
    expect(gasHex).toBe("0x1d4c0")
    expect(calls).toEqual([
      {
        kind: "call",
        method: "eth_estimateGas",
        params: [{ from: "0xFrom", to: "0xTo", data: "0xdeadbeef", value: "0x0" }],
      },
    ])
  })

  test("omits value from the RPC call params when not provided", async () => {
    const { rpc, calls } = makeRpc({ eth_estimateGas: "0x64" }) // 100
    await estimateGas(rpc, { from: "0xFrom", to: "0xTo", data: "0x" })
    expect(calls).toEqual([
      { kind: "call", method: "eth_estimateGas", params: [{ from: "0xFrom", to: "0xTo", data: "0x" }] },
    ])
  })
})

describe("assembleEvmTx", () => {
  test("produces the exact EvmSignTransactionParams shape: hex strings vs numbers", () => {
    const tx = assembleEvmTx({
      from: "0xFrom",
      to: "0xTo",
      data: "0xdeadbeef",
      valueDecimal: "1000000000000000000",
      nonce: 5,
      chainId: 8453,
      gasLimitHex: "0x1d4c0",
      feeData: { maxFeePerGasHex: "0x12a05f200", maxPriorityFeePerGasHex: "0x3b9aca00" },
    })
    expect(tx).toEqual({
      from: "0xFrom",
      to: "0xTo",
      nonce: 5,
      chain_id: 8453,
      data: "0xdeadbeef",
      value: "0xde0b6b3a7640000",
      type: 2,
      gas_limit: "0x1d4c0",
      max_fee_per_gas: "0x12a05f200",
      max_priority_fee_per_gas: "0x3b9aca00",
    })
    expect(typeof tx.nonce).toBe("number")
    expect(typeof tx.chain_id).toBe("number")
    expect(typeof tx.type).toBe("number")
    expect(typeof tx.value).toBe("string")
    expect(typeof tx.gas_limit).toBe("string")
    expect(typeof tx.max_fee_per_gas).toBe("string")
    expect(typeof tx.max_priority_fee_per_gas).toBe("string")
  })

  test("zero value assembles to 0x0, not an empty string", () => {
    const tx = assembleEvmTx({
      from: "0xFrom",
      to: "0xTo",
      data: "0x",
      valueDecimal: "0",
      nonce: 0,
      chainId: 1,
      gasLimitHex: "0x5208",
      feeData: { maxFeePerGasHex: "0x1", maxPriorityFeePerGasHex: "0x1" },
    })
    expect(tx.value).toBe("0x0")
  })
})

describe("waitForReceipt", () => {
  test("resolves on a non-null, non-reverted receipt", async () => {
    const { rpc, calls } = makeRpc({}, { eth_getTransactionReceipt: { status: "0x1", transactionHash: "0xHash" } })
    const receipt = await waitForReceipt(rpc, "0xHash", { timeoutMs: 1_000, pollMs: 10 })
    expect(receipt).toEqual({ status: "0x1", transactionHash: "0xHash" })
    expect(calls).toEqual([{ kind: "callRaw", method: "eth_getTransactionReceipt", params: ["0xHash"] }])
  })

  test("polls until the receipt appears (null, then null, then a receipt)", async () => {
    let call = 0
    const results: Array<unknown> = [null, null, { status: "0x1" }]
    const rpc: EvmRpc = {
      call: async () => {
        throw new Error("unexpected call()")
      },
      callRaw: async () => results[call++],
    }
    const receipt = await waitForReceipt(rpc, "0xHash", { timeoutMs: 1_000, pollMs: 5 })
    expect(receipt).toEqual({ status: "0x1" })
    expect(call).toBe(3)
  })

  test('throws a clear error on a reverted receipt (status: "0x0")', async () => {
    const { rpc } = makeRpc({}, { eth_getTransactionReceipt: { status: "0x0", transactionHash: "0xHash" } })
    await expect(waitForReceipt(rpc, "0xHash", { timeoutMs: 1_000, pollMs: 10 })).rejects.toThrow(/revert/i)
  })

  test("throws a clear timeout error when no receipt ever appears", async () => {
    const { rpc } = makeRpc({}, { eth_getTransactionReceipt: null as unknown as Record<string, unknown> })
    await expect(waitForReceipt(rpc, "0xHash", { timeoutMs: 30, pollMs: 10 })).rejects.toThrow(/timed out/i)
  })
})
