/**
 * Multi-EVM F5 (BE-2959, spec A6/A9): the `chain` parameter every tool takes accepts any
 * enabled registry EVM chain, refuses an unknown or disabled chain with the enabled list, and
 * the description lists the registry's chains. `testevm` is installed through the generated
 * registry's test hook (full entries, F1b's shape).
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetChainRegistryForTest,
  __setChainRegistryForTest,
  chainDescriptionText,
  chainSchema,
} from "./chain-registry"
import { registryWithTestevm } from "./chain-test-fixtures"

afterEach(() => __resetChainRegistryForTest())

describe("the chain parameter is registry-driven (A9)", () => {
  test("the built-in description lists the registry's chains", () => {
    expect(chainDescriptionText()).toBe("solana or hood")
    expect(chainSchema().description).toBe('"solana or hood"')
  })

  test("solana and hood pass; an unknown chain is refused with the list, never routed to Hood (A6)", () => {
    expect(chainSchema().safeParse("solana").success).toBe(true)
    expect(chainSchema().safeParse("hood").success).toBe(true)
    const refused = chainSchema().safeParse("base")
    expect(refused.success).toBe(false)
    expect(!refused.success && refused.error.issues[0]?.message).toBe("chain must be one of solana or hood")
  })

  test("a chain the registry gains later is accepted and listed with no other change (A9)", () => {
    __setChainRegistryForTest(registryWithTestevm("enabled"))
    expect(chainSchema().safeParse("testevm").success).toBe(true)
    expect(chainDescriptionText()).toBe("solana, hood or testevm")
  })

  test("a disabled chain is refused by name (A6)", () => {
    __setChainRegistryForTest(registryWithTestevm("disabled"))
    const refused = chainSchema().safeParse("testevm")
    expect(refused.success).toBe(false)
    expect(!refused.success && refused.error.issues[0]?.message).toContain("solana or hood")
  })
})
