/**
 * Multi-EVM F5 (BE-2959, spec A5/A6): the core transfer card accepts a chain at parse time only
 * for chains it can source from. A non-Hood EVM chain is refused up front with one code, and
 * nothing is prepared or signed.
 */
import { afterEach, expect, test } from "bun:test"
import { __resetChainRegistryForTest, __setChainRegistryForTest } from "../chain-registry"
import { registryWithTestevm } from "../chain-test-fixtures"
import type { Card } from "./cards"
import { DEST_EVM, startKit, VAULT_EVM } from "./s4-test-kit"

afterEach(() => __resetChainRegistryForTest())

test("transfer.prepare and transfer.destinations refuse an enabled non-Hood EVM chain with INVALID_CHAIN", async () => {
  __setChainRegistryForTest(registryWithTestevm("enabled"))
  const k = await startKit({})
  try {
    const view = await k.view()
    const prepared = await view.request("transfer.prepare", {
      params: {
        source: { kind: "vault", walletId: "k_evm", address: VAULT_EVM },
        chain: "testevm",
        asset: { symbol: "ETH" },
        amount: { decimal: "0.1" },
        to: DEST_EVM,
      },
    })
    expect((prepared.error?.data as { code?: string } | undefined)?.code).toBe("INVALID_CHAIN")
    const destinations = await view.request("transfer.destinations", {
      source: { kind: "vault" },
      chain: "testevm",
    })
    expect((destinations.error?.data as { code?: string } | undefined)?.code).toBe("INVALID_CHAIN")
    expect(k.cards.list("", false)).toEqual([] as Card[])
    expect(k.chain.signed).toEqual([])
  } finally {
    await k.close()
  }
})
