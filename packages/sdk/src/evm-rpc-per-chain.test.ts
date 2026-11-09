/**
 * Multi-EVM F5 (BE-2959, spec A9): the SDK resolves its EVM RPC per chain. `evmRpcUrls` is keyed
 * by registry chain slug; `evmRpcUrl` stays as Hood's single endpoint, so existing callers keep
 * working and a chain the registry gains later needs only its own entry.
 */
import { describe, expect, test } from "bun:test"
import { CandleClient } from "./client"

const HOOD_RPC = "https://rpc.mainnet.chain.robinhood.com"
const TESTEVM_RPC = "https://rpc.testevm.example"

function client(opts: Partial<ConstructorParameters<typeof CandleClient>[0]>): CandleClient {
  return new CandleClient({ apiUrl: "https://api.example.test", ...opts })
}

describe("per-chain EVM RPC resolution (A9)", () => {
  test("evmRpcUrl alone still names Hood's endpoint", () => {
    const c = client({ evmRpcUrl: HOOD_RPC })
    expect(c.evmRpcUrlForChain("hood")).toBe(HOOD_RPC)
    expect(c.evmRpcUrlForChain("testevm")).toBeUndefined()
    expect(c.evmRpcUrlForChain("solana")).toBeUndefined()
  })

  test("evmRpcUrls keys an endpoint per chain and overrides hood's", () => {
    const c = client({ evmRpcUrl: HOOD_RPC, evmRpcUrls: { hood: "https://other.example", testevm: TESTEVM_RPC } })
    expect(c.evmRpcUrlForChain("hood")).toBe("https://other.example")
    expect(c.evmRpcUrlForChain("testevm")).toBe(TESTEVM_RPC)
  })

  test("with no URL for the chain there is none, never a silent fallback to Hood's", () => {
    const c = client({ evmRpcUrl: HOOD_RPC })
    expect(c.evmRpcUrlForChain("testevm")).toBeUndefined()
  })

  test("an EVM one-shot without any EVM URL still refuses by name, before any request", () => {
    const c = client({})
    expect(c.evmRpcUrlForChain("hood")).toBeUndefined()
  })
})
