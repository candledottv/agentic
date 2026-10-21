/**
 * Whether a string is a plausible token address on a chain (BE-1737, spec S5 Q-5 and K-2): a
 * Solana base58 mint of 32 to 44 characters, or an EVM `0x` address of 40 hex digits on Hood.
 *
 * The same test as the API's `isPlausibleTokenAddress` (`apps/api/src/lib/hot-streak.ts`), which
 * `addresses.test.ts` pins. A copy rather than an import: this package ships without the API.
 */
export function isPlausibleTokenAddress(chain: "solana" | "hood", address: string): boolean {
  if (chain === "hood") return /^0x[0-9a-fA-F]{40}$/.test(address)
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}
