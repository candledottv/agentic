import { z } from "zod"
import { decimalAmount, safeText } from "./trading"

const check = z.object({
  check: z.string(),
  status: z.enum(["pass", "skip", "refuse"]),
  code: z.string().optional(),
  message: z.string(),
})

/** Optional on old servers; required by the caller whenever --quote was requested. */
export const launchQuoteCheckSchema = z
  .object({
    requested: z.string(),
    ok: z.boolean(),
    chain: z.enum(["solana", "hood"]).optional(),
    address: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().int().min(0).max(255).optional(),
    classification: z.enum(["ordinary", "featured", "trusted", "stock"]).optional(),
    checks: z.array(check).min(1),
    economics: z
      .object({
        kind: z.enum(["fixed", "derived"]),
        economicsDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        thresholdRaw: z.string().regex(/^\d+$/),
        startFdv: z.number().finite().positive(),
        bondingFdv: z.number().finite().positive(),
        curve: z.record(z.string().regex(/^\d+$/)),
        priceUsd: z.number().finite().positive().optional(),
        raiseUsd: z.number().finite().positive().optional(),
      })
      .optional(),
    disclosure: z.string().nullable(),
    executionEnabled: z.boolean(),
  })
  .superRefine((quote, ctx) => {
    if (
      quote.ok &&
      (!quote.economics ||
        !quote.address ||
        !quote.chain ||
        quote.decimals === undefined ||
        quote.checks.some((c) => c.status === "refuse"))
    )
      ctx.addIssue({ code: "custom", message: "An admitted quote needs complete economics and passing checks" })
    if (!quote.ok && !quote.checks.some((c) => c.status === "refuse"))
      ctx.addIssue({ code: "custom", message: "A refused quote needs a named check" })
  })

export type LaunchQuoteCheck = z.infer<typeof launchQuoteCheckSchema>

export function launchQuoteLines(quote: LaunchQuoteCheck): string[] {
  const symbol = safeText(quote.symbol ?? quote.requested)
  const lines = [
    `Quote ${symbol}${quote.address ? ` (${safeText(quote.address)})` : ""}: ${quote.ok ? "admitted" : "refused"}.`,
  ]
  for (const c of quote.checks)
    lines.push(`  ${c.status.toUpperCase()} ${safeText(c.code ?? c.check)}: ${safeText(c.message)}`)
  const e = quote.economics
  if (e) {
    const raise =
      quote.decimals === undefined
        ? `${e.thresholdRaw} raw`
        : decimalAmount(e.thresholdRaw, quote.decimals)
            .replace(/(\.\d*?)0+$/, "$1")
            .replace(/\.$/, "")
    lines.push(`Curve (${e.kind}): starting FDV ${e.startFdv} ${symbol}; graduation FDV ${e.bondingFdv} ${symbol}.`)
    lines.push(`Graduation raise: ${raise} ${symbol}${e.raiseUsd === undefined ? "" : ` ($${e.raiseUsd})`}.`)
    if (e.priceUsd !== undefined) lines.push(`Quote price: $${e.priceUsd}.`)
    for (const [key, value] of Object.entries(e.curve)) lines.push(`  ${safeText(key)}: ${value}`)
    lines.push(`Economics digest: ${e.economicsDigest}`)
  }
  if (quote.disclosure) lines.push(safeText(quote.disclosure))
  if (!quote.executionEnabled)
    lines.push("New-quote launch execution is not enabled; this result is a read-only check.")
  return lines
}
