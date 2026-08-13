/**
 * Pure decimal/percent math for the trade and launch-and-seed tools. Everything here is BigInt;
 * no float ever touches a raw amount, because a single float rounding error in this file is a
 * real trade for the wrong size. No I/O, fully unit-tested in convert.test.ts.
 */

/**
 * Quote-asset decimals, pinned to the API's own pair table (@candle/shared LAUNCH_QUOTE_PAIRS,
 * packages/shared/src/constants/curve.ts in the monorepo). Inlined rather than imported because
 * this package must build standalone in the public agentic repo, where @candle/shared does not
 * exist. convert.test.ts pins these values as the drift alarm.
 */
export const QUOTE_DECIMALS: Record<string, number> = {
  sol: 9,
  usdc: 6,
  cndl: 6,
  eth: 18,
  usdg: 6,
}

/**
 * The quote a launch gets when the caller names none, PER CHAIN: SOL on Solana, ETH on Hood.
 * Pinned to the API's own DEFAULT_LAUNCH_QUOTE (packages/shared/src/constants/curve.ts, consumed
 * by apps/api/src/lib/headless-validation.ts). Defaulting everything to "sol" would convert a
 * Hood dev buy at 9 decimals against an API that reads wei, a 1e9x under-seed.
 */
export function defaultQuoteId(chain: string | undefined): string {
  return chain === "hood" ? "eth" : "sol"
}

const DECIMAL_RE = /^\d+(\.\d+)?$/

/**
 * "1.5" with 9 decimals -> "1500000000". Rejects (throws) anything that is not a plain positive
 * decimal literal, a zero amount, or more fraction digits than the asset carries; truncating
 * silently would trade a different size than the caller asked for.
 */
export function decimalToRaw(amount: string, decimals: number): string {
  // The decimals argument is as load-bearing as the amount: a fractional or negative scale would
  // sail through `padEnd` and price the trade wrong instead of failing, so it is rejected here
  // rather than at each call site.
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`)
  }
  if (!DECIMAL_RE.test(amount)) {
    throw new Error(`amount must be a plain positive decimal string, got "${amount}"`)
  }
  const [whole, fraction = ""] = amount.split(".")
  if (fraction.length > decimals) {
    throw new Error(`amount "${amount}" has more fraction digits than the asset's ${decimals} decimals`)
  }
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"))
  if (raw === 0n) throw new Error("amount must be greater than zero")
  return raw.toString()
}

/**
 * Floor(balanceRaw * percent / 100) in BigInt. percent must be an integer 1-100. A result of
 * zero raw units is rejected: the API would reject a zero amountRaw anyway, and "sell 1% of
 * dust" silently selling nothing would read as success to the caller.
 */
export function percentOfBalance(balanceRaw: string, percent: number): string {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error(`percent must be an integer between 1 and 100, got ${percent}`)
  }
  if (!/^\d+$/.test(balanceRaw)) {
    throw new Error(`balanceRaw must be a raw integer string, got "${balanceRaw}"`)
  }
  const result = (BigInt(balanceRaw) * BigInt(percent)) / 100n
  if (result === 0n) {
    throw new Error(`${percent}% of the balance ${balanceRaw} floors to zero raw units; nothing to sell`)
  }
  return result.toString()
}
