import { afterEach, expect, test } from "bun:test"
import { __resetChainRegistryForTest, __setChainRegistryForTest, listChains, requireEvmChain } from "./chains"
import { resolveToken } from "./orchestrate"

const ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
const testevm = { ...structuredClone(requireEvmChain("hood")), slug: "testevm" }
testevm.evm.chainId = 9_990_004

afterEach(__resetChainRegistryForTest)

test("resolve-token uses an explicit EVM chain in the existing market URL", async () => {
  __setChainRegistryForTest([...listChains(), testevm])
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => JSON.stringify({ market: { decimals: 6 } }) }
  }
  const result = await resolveToken({ mint: ADDRESS, chain: "testevm" }, { apiUrl: "https://api.test" }, fetch)
  expect(JSON.parse(result.text)).toMatchObject({ success: true, chain: "testevm" })
  expect(calls).toEqual([`https://api.test/api/v1/markets/testevm/${ADDRESS}`])
})

test("a disabled or unknown explicit chain refuses before any fetch", async () => {
  __setChainRegistryForTest([...listChains(), { ...testevm, enabled: false }])
  for (const chain of ["testevm", "unknown", "solana"]) {
    let calls = 0
    const result = await resolveToken({ mint: ADDRESS, chain }, { apiUrl: "https://api.test" }, async () => {
      calls++
      throw new Error("must not fetch Hood")
    })
    expect(result.isError).toBe(true)
    expect(calls).toBe(0)
  }
})
