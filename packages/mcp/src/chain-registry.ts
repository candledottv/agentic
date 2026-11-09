/**
 * The chain registry as the MCP server's own facade (Multi-EVM F5, BE-2959, spec item 6).
 *
 * F1b/F4 landed the generated client registry at `./chains` (built by
 * `scripts/chains/export-client-registry.ts`, drift-checked in CI), which is the published
 * packages' copy of `packages/shared/src/chains/registry.json`. This module is the thin F5
 * layer over it: every tool's `chain` parameter and its description are built from that data,
 * so a chain added to the registry lands in the generated copy and every tool starts accepting
 * it. An unknown or disabled chain is refused with the enabled list, never routed to Hood
 * (spec A6).
 */
import { z } from "zod"
import { type ChainEntry, getChain, listChains } from "./chains"

export type McpChainEntry = ChainEntry
export { __resetChainRegistryForTest, __setChainRegistryForTest } from "./chains"

const enabled = (slug: string): boolean => {
  const e = getChain(slug)
  return e !== undefined && e.enabled
}

export function enabledChainSlugs(): string[] {
  return listChains({ enabledOnly: true }).map((e) => e.slug)
}

export function chainEntry(slug: string) {
  return getChain(slug)
}

/** True for `solana` or any enabled registry EVM chain. */
export function isChainSlug(value: unknown): boolean {
  return typeof value === "string" && enabled(value)
}

/** The short label tool descriptions and refusals show. */
export function chainLabel(slug: string): string {
  if (slug === "solana") return "Solana"
  // chain-lint-allowed: preserve Hood's established short display label; other chains use their registry displayName.
  if (slug === "hood") return "Hood"
  return getChain(slug)?.displayName ?? slug
}

/** `"solana" or "hood" or ...`: the list every chain parameter's description names (A9). */
export function chainDescriptionText(): string {
  const slugs = enabledChainSlugs()
  return slugs.length <= 1 ? slugs.join(", ") : `${slugs.slice(0, -1).join(", ")} or ${slugs[slugs.length - 1]}`
}

/**
 * A `chain` parameter: a `z.enum` over `solana` and every enabled EVM chain, so the JSON Schema
 * a client sees lists the actual values (A9). An unknown or disabled chain is refused with the
 * enabled list and never routed to Hood (spec A6). Built when a tool's shape is built, so it
 * reads the registry as it stands then.
 */
export function chainSchema(description?: string) {
  const slugs = enabledChainSlugs()
  const listed = chainDescriptionText()
  return z
    .enum(slugs as [string, ...string[]], {
      errorMap: () => ({ message: `chain must be one of ${listed}` }),
    })
    .describe(description ?? `"${listed}"`)
}
