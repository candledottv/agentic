/**
 * Money and amount cells for `candle pnl` and `candle portfolio` (BE-316). One copy, so the two
 * commands print the same figure the same way.
 *
 * Absence is never rendered as zero: a caller passes `undefined`/`null` for "not known", and the
 * cell says so in words. A zero here would read as "worth nothing", which is a different answer
 * from "nobody priced it" (the same discipline the books apply to unmarked positions).
 */

import { shortId } from "./render"

export interface UsdOptions {
  /** A million and up as `$3.52M`, `$1.77B`, `$1.20T`; below a million as usual. */
  compact?: boolean
  /** A `+` on a positive value (`+$75.98`), for a gain or loss column; zero stays unsigned. */
  signed?: boolean
}

const COMPACT_UNITS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
] as const

/** `$1,234.56`, `-$12.30`, `<$0.01` for a positive dust value, `$0.00` for exactly zero.
 * `compact` and `signed` are the output kit's forms (CLI legibility audit, rule 5). */
export function formatUsd(value: number, options: UsdOptions = {}): string {
  if (!Number.isFinite(value)) return "?"
  const sign = value < 0 ? "-" : options.signed && value > 0 ? "+" : ""
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.005) return `${sign}<$0.01`
  if (options.compact) {
    for (const [unit, suffix] of COMPACT_UNITS) {
      // On the rounded value, so 999,995 reads $1.00M and 999,995,000 $1.00B, never $1000.00M.
      if (Math.round(abs / (unit / 100)) >= 100) return `${sign}$${(abs / unit).toFixed(2)}${suffix}`
    }
  }
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * A unit price. Memecoin prices live far below a cent, so two decimals would print most of them
 * as `$0.00`; below $1 this keeps four significant digits instead.
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "?"
  if (value >= 1) return formatUsd(value)
  return `$${Number(value.toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 12 })}`
}

/** A raw base-unit amount as a decimal string, trailing zeros trimmed. Integer arithmetic only. */
export function formatAmount(raw: string, decimals: number): string {
  const digits = BigInt(raw)
    .toString()
    .padStart(decimals + 1, "0")
  if (decimals === 0) return digits
  const whole = digits.slice(0, -decimals)
  const fraction = digits.slice(-decimals).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

/** A whole-token quantity (the books report floats), to at most six decimals, trimmed. */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return "?"
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

/** `7xKX…9fQa`: enough of an address to tell rows apart without widening every table. The kit's
 * `shortId` (render.ts) is the one copy; this name stays for the commands that call it. */
export function shortAddress(address: string): string {
  return shortId(address)
}
