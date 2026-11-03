/**
 * `candle fees` and `candle fees claim <mint> [--dry-run]` (FE-438): the creator fees this
 * account's launched tokens can pay, and the claim.
 *
 *   GET  /agent/fees               -> the account's launched tokens, with what each could pay now
 *   POST /agent/fees/{mint}/claim  -> collects and pays the creator's share to the recipient
 *
 * The request carries a mint and a dry-run flag, nothing else: the money goes to the recipient
 * fixed at launch. Candle signs embedded claims. A TEE claim returns a checked build; this
 * machine authorizes its exact RPC body locally, relays the sign, then submits the signed claim.
 * Amounts are shown in each asset's own units from the raw figure the server read off chain.
 *
 * `--json` is the server body as sent, which is also what `candle_get_fees` and
 * `candle_claim_fees` relay. List is `{ success, page, isDone, continueCursor }`. Claim, including
 * `--dry-run`, is one object `{ success, mint, chain, dryRun, recipient, claimable, claimed,
 * remaining, reason?, warnings? }`: `dryRun` is the variant, not a second shape.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { bold, failure, fields, heading, notice, symbols, terminalStyle } from "../presentation"
import { renderTable, writeUsageFailure } from "../render"
import {
  authorizationSignature,
  completeTradingWallet,
  decimalAmount,
  type Json,
  listTradingWallets,
  request,
  safeText,
  TradingError,
  tradingKey,
} from "../trading"
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

function amountText(row: FeeAmount, missing: string): string {
  const raw = typeof row.amountRaw === "string" && /^\d+$/.test(row.amountRaw) ? row.amountRaw : null
  if (raw === null) return missing
  const decimals = Number.isInteger(row.decimals) ? (row.decimals as number) : 0
  const label = row.symbol ? row.symbol : (row.mint ?? "")
  const value = decimalAmount(raw, decimals)
  return `${value.includes(".") ? value.replace(/\.?0+$/, "") : value} ${safeText(label)}`.trim()
}

function amountsText(rows: unknown, missing: string): string {
  if (!Array.isArray(rows) || rows.length === 0) return "none"
  return rows.map((row) => amountText(row as FeeAmount, missing)).join(", ")
}

const REASON_WORDS: Record<string, string> = {
  below_dust: "under the dust floor",
  wallet_not_signable: "the recipient is a wallet Candle cannot sign for",
  delegation_off: "the embedded wallet is not delegated for agent access",
  embedded_wallet_not_permitted: "this key may not use the embedded wallet",
  not_recipient: "the fees go to someone else, or the token has no fee vault",
  fee_wallet_designated: "the fees go to this launch's designated fee wallet, which claims them itself",
  insufficient_gas: "the recipient wallet cannot cover the network fee",
}

function reasonText(reason: unknown, missing: string): string {
  return typeof reason === "string" ? (REASON_WORDS[reason] ?? safeText(reason)) : missing
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
    const style = terminalStyle(ctx.deps, "stdout")
    const missing = symbols(style).missing
    if (page.length === 0) notice(ctx.deps, "stdout", "note", "No launched tokens on this account.")
    else {
      const rows = page.map((row) => {
        const status = row.unreadable
          ? "could not be read"
          : row.claimable
            ? `claimable: ${amountsText(row.claimableAmounts, missing)}`
            : `not claimable: ${reasonText(row.reason, missing)}`
        return [
          safeText(String(row.symbol ?? row.name ?? row.mint)),
          safeText(String(row.chain)),
          status,
          safeText(String(row.mint)),
        ]
      })
      ctx.deps.stdout.write(
        `${renderTable(["TOKEN", "CHAIN", "STATUS", "MINT"], rows, {
          style,
          width: style.width,
          indent: 2,
          columns: [{}, { priority: 1 }, {}, { id: true }],
        })}\n`,
      )
    }
    if (body.isDone === false && typeof body.continueCursor === "string")
      notice(ctx.deps, "stdout", "note", `More: candle fees --cursor ${safeText(body.continueCursor)}`)
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
    let body = await request(ctx, key, `/api/v1/agent/fees/${encodeURIComponent(mint)}/claim`, {
      dryRun,
      teeSigning: true,
    })
    if (!dryRun && Array.isArray(body.signing) && body.signing.length > 0) {
      if (body.signing.length > 2) throw new TradingError("INVALID_RESPONSE", "Too many fee claims to sign")
      const { rows, appId, keyPrefix } = await listTradingWallets(ctx, key, "launch:write")
      const signedClaims: Json[] = []
      for (const signing of body.signing as Json[]) {
        const row = rows.find((row) => row.id === signing.walletId && row.address === signing.wallet)
        if (!row || row.chain !== "solana")
          throw new TradingError("TEE_WALLET_REQUIRED", "The claim's wallet is not bound to this key")
        // Claiming earnings does not require the owner's allowLaunch setting. The listing above
        // enforces launch:write; this resolver supplies the wallet's existing local signer only.
        const wallet = await completeTradingWallet(ctx, row, appId, "account:read", "solana", {
          apiKey: key,
          keyPrefix,
        })
        const rpc = signing.body as { params?: { transaction?: unknown } } | undefined
        const transaction = rpc?.params?.transaction
        if (typeof transaction !== "string" || !["streamer", "creator"].includes(String(signing.leg)))
          throw new TradingError("INVALID_RESPONSE", "The fee claim has no Solana transaction to sign")
        const approval = authorizationSignature(wallet, transaction)
        if (JSON.stringify(approval.body) !== JSON.stringify(signing.body))
          throw new TradingError("INVALID_RESPONSE", "The fee claim's RPC body is not the exact Solana sign request")
        const signed = await request(ctx, key, `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`, {
          ...approval,
          feeClaim: true,
        })
        if (typeof signed.signedTransaction !== "string" || signed.encoding !== "base64")
          throw new TradingError("INVALID_RESPONSE", "The relay returned no base64 signed fee claim")
        signedClaims.push({ walletId: wallet.id, leg: signing.leg, signedTransaction: signed.signedTransaction })
      }
      const submitted = await request(ctx, key, `/api/v1/agent/fees/${encodeURIComponent(mint)}/claim/submit`, {
        signedClaims,
      })
      body = {
        ...submitted,
        claimed: [
          ...(Array.isArray(body.claimed) ? body.claimed : []),
          ...(Array.isArray(submitted.claimed) ? submitted.claimed : []),
        ],
        warnings: [
          ...(Array.isArray(body.warnings) ? body.warnings : []),
          ...(Array.isArray(submitted.warnings) ? submitted.warnings : []),
        ],
      }
    }
    if (ctx.json) return printTradingResult(ctx, body)
    const style = terminalStyle(ctx.deps, "stdout")
    const missing = symbols(style).missing
    const claimed = Array.isArray(body.claimed) ? (body.claimed as FeeAmount[]) : []
    if (dryRun && body.claimable === false) {
      ctx.deps.stdout.write(`${failure(`Would be refused: ${reasonText(body.reason, missing)}.`, style)}\n`)
      ctx.deps.stdout.write(`${fields([["Still", amountsText(body.remaining, missing)]], style).join("\n")}\n`)
    } else {
      const rows: [string, string][] = [
        [dryRun ? "Would claim" : "Amount", amountsText(claimed, missing)],
        ["To", safeText(String(body.recipient))],
        ["Still", amountsText(body.remaining, missing)],
      ]
      ctx.deps.stdout.write(`${heading(dryRun ? "Dry run" : "Claimed", style)}\n\n${fields(rows, style).join("\n")}\n`)
      if (!dryRun) {
        for (const row of claimed) {
          if (row.txHash) ctx.deps.stdout.write(`${bold(safeText(row.txHash), style)}\n`)
        }
      }
    }
    if (dryRun) notice(ctx.deps, "stdout", "note", "Nothing was sent.")
    if (Array.isArray(body.warnings)) {
      for (const warning of body.warnings) notice(ctx.deps, "stderr", "warning", safeText(String(warning)))
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
