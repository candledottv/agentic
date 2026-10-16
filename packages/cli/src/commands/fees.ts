/**
 * `candle fees` and `candle fees claim <mint> [--dry-run]` (FE-438): the creator fees this
 * account's launched tokens can pay, and the claim.
 *
 *   GET  /agent/fees               -> the account's launched tokens, with what each could pay now
 *   POST /agent/fees/{mint}/claim  -> collects and pays the creator's share to the recipient
 *
 * The request carries a mint and a dry-run flag, nothing else: the money goes to the recipient
 * fixed at launch, and this machine signs nothing (Candle signs with the embedded wallet, which
 * pays the network fee). Amounts are shown in each asset's own units from the raw figure the
 * server read off chain; `--json` is the server's answer as sent.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeUsageFailure } from "../render"
import { decimalAmount, type Json, request, safeText, tradingKey } from "../trading"
import { printTradingResult, tradingFailure } from "./swap"

const LIST_USAGE = "Usage: candle fees [--cursor <cursor>] [--limit <1-50>] [--json]"
const CLAIM_USAGE = "Usage: candle fees claim <mint> [--dry-run] [--json]"

interface FeeAmount {
  symbol?: string
  mint?: string
  decimals?: number
  amountRaw?: string
  txHash?: string | null
}

function amountText(row: FeeAmount): string {
  const raw = typeof row.amountRaw === "string" && /^\d+$/.test(row.amountRaw) ? row.amountRaw : null
  if (raw === null) return "unknown"
  const decimals = Number.isInteger(row.decimals) ? (row.decimals as number) : 0
  const label = row.symbol ? row.symbol : (row.mint ?? "")
  const value = decimalAmount(raw, decimals)
  return `${value.includes(".") ? value.replace(/\.?0+$/, "") : value} ${safeText(label)}`.trim()
}

function amountsText(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0) return "none"
  return rows.map((row) => amountText(row as FeeAmount)).join(", ")
}

const REASON_WORDS: Record<string, string> = {
  below_dust: "under the dust floor",
  wallet_not_signable: "the recipient is a wallet Candle cannot sign for",
  delegation_off: "the embedded wallet is not delegated for agent access",
  embedded_wallet_not_permitted: "this key may not use the embedded wallet",
  not_recipient: "the fees go to someone else, or the token has no fee vault",
  insufficient_gas: "the recipient wallet cannot cover the network fee",
}

function reasonText(reason: unknown): string {
  return typeof reason === "string" ? (REASON_WORDS[reason] ?? safeText(reason)) : "unknown"
}

export async function feesList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--cursor", "--limit"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const limit = parsed.values["--limit"]
  if (parsed.positionals.length !== 0 || (limit !== undefined && !/^(?:[1-9]|[1-4]\d|50)$/.test(limit))) {
    writeUsageFailure(ctx.deps, LIST_USAGE, ctx.json)
    return 2
  }
  const cursor = parsed.values["--cursor"]
  try {
    const key = await tradingKey(ctx)
    const params = new URLSearchParams()
    if (cursor !== undefined) params.set("cursor", cursor)
    if (limit !== undefined) params.set("limit", limit)
    const body = await request(ctx, key, `/api/v1/agent/fees${params.size ? `?${params}` : ""}`)
    if (ctx.json) return printTradingResult(ctx, body)
    const page = Array.isArray(body.page) ? (body.page as Json[]) : []
    const out = ctx.deps.stdout
    if (page.length === 0) out.write("No launched tokens on this account.\n")
    for (const row of page) {
      const name = safeText(String(row.symbol ?? row.name ?? row.mint))
      const status = row.unreadable
        ? "could not be read"
        : row.claimable
          ? `claimable: ${amountsText(row.claimableAmounts)}`
          : `not claimable: ${reasonText(row.reason)}`
      out.write(`${name}  ${safeText(String(row.chain))}  ${safeText(String(row.mint))}  ${status}\n`)
    }
    if (body.isDone === false && typeof body.continueCursor === "string")
      out.write(`More: candle fees --cursor ${safeText(body.continueCursor)}\n`)
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

export async function feesClaim(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { booleanFlags: ["--dry-run"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const mint = parsed.positionals[0]
  if (parsed.positionals.length !== 1 || !mint) {
    writeUsageFailure(ctx.deps, CLAIM_USAGE, ctx.json)
    return 2
  }
  const dryRun = parsed.booleans.has("--dry-run")
  try {
    const key = await tradingKey(ctx)
    const body = await request(ctx, key, `/api/v1/agent/fees/${encodeURIComponent(mint)}/claim`, { dryRun })
    if (ctx.json) return printTradingResult(ctx, body)
    const out = ctx.deps.stdout
    const claimed = Array.isArray(body.claimed) ? (body.claimed as FeeAmount[]) : []
    if (dryRun) {
      out.write(
        body.claimable === false
          ? `Dry run: would be refused: ${reasonText(body.reason)}. Nothing was sent.\n`
          : `Dry run: would claim ${amountsText(claimed)} to ${safeText(String(body.recipient))}. Nothing was sent.\n`,
      )
    } else {
      out.write(`Claimed ${amountsText(claimed)} to ${safeText(String(body.recipient))}\n`)
      for (const row of claimed) if (row.txHash) out.write(`  ${safeText(row.txHash)}\n`)
    }
    out.write(`Still claimable: ${amountsText(body.remaining)}\n`)
    if (Array.isArray(body.warnings))
      for (const warning of body.warnings) ctx.deps.stderr.write(`Warning: ${safeText(String(warning))}\n`)
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
