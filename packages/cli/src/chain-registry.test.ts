/**
 * Multi-EVM F5 (BE-2959, spec A6/A9): the CLI's registry facade accepts any enabled EVM chain
 * wherever `--chain hood` works, refuses an unknown chain with the enabled list, and refuses a
 * disabled chain by name. `testevm` is installed through the generated registry's test hook
 * (full entries, F1b's shape).
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetChainRegistryForTest,
  __setChainRegistryForTest,
  type CliChainError,
  chainDisplayName,
  chainLabel,
  chainLabelList,
  chainListText,
  enabledEvmChainSlugs,
  evmChainIdFor,
  isChainSlug,
  isEvmChainSlug,
  requireChainSlug,
} from "./chain-registry"
import { registryWithTestevm, TESTEVM_CHAIN_ID } from "./chain-test-fixtures"

afterEach(() => __resetChainRegistryForTest())

describe("the generated registry as shipped", () => {
  test("solana and hood, in registry order, hood enabled", () => {
    expect(chainListText()).toBe("solana, hood")
    expect(chainLabelList()).toBe("Solana and Hood")
    expect(enabledEvmChainSlugs()).toEqual(["hood"])
  })

  test("hood's facts read from the generated copy", () => {
    expect(evmChainIdFor("hood")).toBe(4663)
    expect(chainDisplayName("hood")).toBe("Robinhood Chain")
    expect(chainLabel("hood")).toBe("Hood")
    expect(isEvmChainSlug("hood")).toBe(true)
    expect(isEvmChainSlug("solana")).toBe(false)
  })
})

describe("a chain the registry gains later works with no other change (A9)", () => {
  test("an enabled EVM chain passes every check", () => {
    __setChainRegistryForTest(registryWithTestevm("enabled"))
    expect(isChainSlug("testevm")).toBe(true)
    expect(isEvmChainSlug("testevm")).toBe(true)
    expect(evmChainIdFor("testevm")).toBe(TESTEVM_CHAIN_ID)
    expect(chainListText()).toBe("solana, hood, testevm")
    expect(chainDisplayName("testevm")).toBe("Test EVM")
    expect(requireChainSlug("testevm")).toBe("testevm")
  })

  test("a disabled chain is refused by name, never routed to Hood (A6)", () => {
    __setChainRegistryForTest(registryWithTestevm("disabled"))
    expect(isChainSlug("testevm")).toBe(false)
    try {
      requireChainSlug("testevm")
      throw new Error("expected a refusal")
    } catch (error) {
      const refused = error as CliChainError
      expect(refused.code).toBe("CHAIN_DISABLED")
      expect(refused.message).toContain("testevm")
      expect(refused.message).toContain("disabled")
    }
  })

  test("an unknown chain is refused with the enabled list, not a fallback (A6/A5)", () => {
    expect(() => requireChainSlug("base")).toThrow(/Unknown chain "base": chain is one of solana, hood/)
  })
})
