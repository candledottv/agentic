/**
 * Multi-EVM F5 test fixtures (BE-2959, spec A9): a full `testevm` entry and a registry builder
 * over the generated copy's live entries, for `__setChainRegistryForTest`. The entry mirrors
 * `packages/shared/src/chains/testevm.ts` (F1b), which the CLI cannot import in the public
 * mirrors; keep the two in spirit when either changes. Test-only, imported by no shipped path.
 */
import type { ChainEntry } from "./chains"
import { listChains } from "./chains"

/** The chain id no public chain uses (shared's testevm uses the neighbouring 999_999_901). */
export const TESTEVM_CHAIN_ID = 909_090_901

export const TESTEVM_ENTRY = (enabled: boolean): ChainEntry => ({
  slug: "testevm",
  family: "evm",
  displayName: "Test EVM",
  enabled,
  addressFormat: "evm-hex20",
  native: { symbol: "TST", name: "Test EVM Token", decimals: 8 },
  explorer: null,
  rpc: { env: {}, publicUrl: "https://rpc.testevm.example", fallbackSwitchEnv: null },
  evm: {
    chainId: TESTEVM_CHAIN_ID,
    wrappedNative: { symbol: "WTEVM", address: "0x00000000000000000000000000000000000a0001", decimals: 8 },
    stablecoins: [{ symbol: "TUSD", address: "0x00000000000000000000000000000000000a0002", decimals: 18 }],
    quoteAssets: ["0x00000000000000000000000000000000000a0001", "0x00000000000000000000000000000000000a0002"],
    l1DataFee: "none",
    blockTimeMs: 100,
    publicMempool: true,
    multicall3: null,
    dex: {
      uniswapV3: {
        factory: "0x00000000000000000000000000000000000b0001",
        router: "0x00000000000000000000000000000000000b0002",
        quoter: "0x00000000000000000000000000000000000b0003",
        initCodeHash: "0x00000000000000000000000000000000000000000000000000000000000c0001",
      },
      uniswapV4: null,
      permit2: null,
    },
    aggregators: [],
    vendors: { dexscreener: null, birdeye: null, geckoterminal: null },
    cvcBaseUrlEnv: null,
    feeTreasuryEnv: null,
    gasReserve: { feeMultiplier: 3, extraErc20Transfers: 2, legGasFallback: "700000" },
    teePolicyChainId: null,
    launch: null,
  },
})

/** The generated registry's own entries plus testevm in the state asked for. */
export function registryWithTestevm(state: "enabled" | "disabled" | "absent" = "enabled"): ChainEntry[] {
  const entries = structuredClone([...listChains()]) as ChainEntry[]
  if (state !== "absent") entries.push(TESTEVM_ENTRY(state === "enabled"))
  return entries
}
