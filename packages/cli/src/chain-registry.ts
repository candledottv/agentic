/**
 * The chain registry as the CLI's own facade (Multi-EVM F5, BE-2959, spec item 6).
 *
 * F1b/F4 landed the generated client registry at `./chains` (built by
 * `scripts/chains/export-client-registry.ts`, drift-checked in CI), which is the published
 * packages' copy of `packages/shared/src/chains/registry.json`. This module is the thin F5
 * layer over it: the `--chain` flag's validation and refusal wording, and the short labels the
 * terminal shows. A chain added to the registry reaches the CLI through the generated copy with
 * no other edit; an unknown chain is refused with the enabled list, a disabled chain by name,
 * and neither is ever routed to Hood (spec A5/A6).
 */
import {
  type ChainEntry,
  ChainRegistryError,
  type EvmChainEntry,
  getChain,
  listChains,
  __resetChainRegistryForTest as resetGenerated,
  __setChainRegistryForTest as setGenerated,
} from "./chains"

export type CliChainEntry = ChainEntry
export type { EvmChainEntry }
export { ChainRegistryError as CliChainError }

const entry = (slug: string): ChainEntry | undefined => getChain(slug)
const enabled = (slug: string): boolean => {
  const e = entry(slug)
  return e !== undefined && e.enabled
}

/** Every enabled chain slug, registry order: `solana` first, then every enabled EVM chain. */
export function enabledChainSlugs(): string[] {
  return listChains({ enabledOnly: true }).map((e) => e.slug)
}

/** Every enabled EVM chain slug (no `solana`), registry order. */
export function enabledEvmChainSlugs(): string[] {
  return listChains({ family: "evm", enabledOnly: true }).map((e) => e.slug)
}

/** `"solana, hood"`: the slug list a refusal can name. */
export function chainListText(): string {
  return enabledChainSlugs().join(", ")
}

/** An entry by slug, disabled entries included. */
export function chainEntry(slug: string): ChainEntry | undefined {
  return entry(slug)
}

/**
 * A `--chain` value checked against the registry: `solana` or any enabled EVM slug. An unknown
 * chain is refused with the enabled list (never routed to Hood); a disabled chain is refused by
 * name. `hood` alone must stay enabled for the CLI to work, so neither refusal has a fallback.
 */
export function requireChainSlug(slug: string): string {
  const e = entry(slug)
  if (e === undefined)
    throw new ChainRegistryError("UNKNOWN_CHAIN", slug, `Unknown chain "${slug}": chain is one of ${chainListText()}.`)
  if (!e.enabled)
    throw new ChainRegistryError(
      "CHAIN_DISABLED",
      slug,
      `Chain "${slug}" is disabled: chain is one of ${chainListText()}.`,
    )
  return slug
}

/** True for `solana` or any enabled chain slug (disabled entries are not usable values). */
export function isChainSlug(value: unknown): boolean {
  return typeof value === "string" && enabled(value)
}

/** The display name a label or table header shows. */
export function chainDisplayName(slug: string): string {
  return entry(slug)?.displayName ?? slug
}

/** The short label the terminal shows: `Solana`, `Hood` (the registry name is longer), or the display name. */
export function chainLabel(slug: string): string {
  if (slug === "solana") return "Solana"
  // chain-lint-allowed: preserve Hood's established terminal label; other chains use their registry displayName.
  if (slug === "hood") return "Hood"
  return chainDisplayName(slug)
}

/** `Solana and Hood`-style list for one-line refusals (commas once a third chain exists). */
export function chainLabelList(): string {
  const labels = enabledChainSlugs().map(chainLabel)
  return labels.length <= 1 ? labels.join(", ") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/** The native token's symbol (gas and balance lines), from the registry. */
export function chainNativeSymbol(slug: string): string {
  return entry(slug)?.native.symbol ?? ""
}

/** True when the slug is an enabled EVM chain (a 0x address is valid on it). */
export function isEvmChainSlug(slug: string): boolean {
  const e = entry(slug)
  return e !== undefined && e.enabled && e.family === "evm"
}

/**
 * The chain id an enabled EVM chain signs on, or undefined for `solana`/unknown slugs. Replaces
 * reading `HOOD_CHAIN_ID` directly wherever the chain came from a flag rather than from Hood.
 */
export function evmChainIdFor(slug: string): number | undefined {
  const e = entry(slug)
  return e !== undefined && e.family === "evm" ? e.evm.chainId : undefined
}

/**
 * The default (public) RPC for a chain, or null when the registry names none. The operator's
 * `--rpc-url` / `--evm-rpc-url` / `CANDLE_EVM_RPC_URL` still wins wherever it is set.
 */
export function defaultRpcUrlFor(slug: string): string | null {
  return entry(slug)?.rpc.publicUrl ?? null
}

/** Test-only (Multi-EVM F5 A9): installs a fake registry so `--chain testevm` is testable. */
export function __setChainRegistryForTest(next: ChainEntry[]): void {
  setGenerated(next)
}

/** Test-only: restores the generated registry data. */
export function __resetChainRegistryForTest(): void {
  resetGenerated()
}
