/**
 * `candle wallet close-empty` (BE-418): close the embedded wallet's empty token accounts and take
 * their rent back into that same wallet, with the preview and confirm `candle swap` uses.
 *
 *   POST /agent/wallets/embedded/close-empty/preview  ->  confirm  ->  POST /agent/wallets/embedded/close-empty
 *
 * Candle decides which accounts qualify (balance zero on either token program, owned by the
 * wallet, not wrapped SOL, not frozen, no Token-2022 withheld fees or confidential state), signs
 * with the embedded wallet's delegation and broadcasts. This machine signs nothing. Execute sends
 * exactly the accounts the preview showed, so an account that emptied after the prompt waits for
 * the next run. `--keep` leaves a mint's account open, for the pair token a held holder-reward coin
 * pays into.
 *
 * The run is keyed by a clientTradeId, durable on Candle: re-running with the same
 * `--client-trade-id` prints the stored report instead of closing again.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeUsageFailure } from "../render"
import { type Json, request, safeText, TradingError, tradingKey } from "../trading"
import { printTradingResult, tradingFailure, validClientId } from "./swap"

const USAGE =
  "Usage: candle wallet close-empty [--wallet embedded] [--keep <mint>]... [--client-trade-id <id>] [--yes] [--json]"

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** Rows printed before the list is summarized; the full list is always in the --json output. */
const LISTED_ROWS = 50

interface PreviewAccount {
  account: string
  mint: string
  tokenProgram: string
  lamports: string
}

interface Preview {
  wallet: string
  accounts: PreviewAccount[]
  accountCount: number
  totalSol: string
  totalLamports: string
  transactions: number
  estimatedFeeLamports: string
  netSol: string
  skipped: (PreviewAccount & { reason: string })[]
  maxAccountsPerCall?: number
}

/**
 * Every `--keep`, repeated or comma-separated. The shared parser keeps only the last value of a
 * repeated flag, so the repeats are lifted out here first and the rest is parsed as usual.
 */
export function splitKeep(args: string[]): { rest: string[]; keep: string[] } | { error: string } {
  const rest: string[] = []
  const keep: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--keep") {
      rest.push(args[i] as string)
      continue
    }
    const value = args[++i]
    if (value === undefined || value.startsWith("--")) return { error: "--keep requires a mint" }
    keep.push(...value.split(",").filter((mint) => mint.length > 0))
  }
  return { rest, keep: [...new Set(keep)] }
}

const SKIP_WORDS: Record<string, string> = {
  kept: "kept by --keep",
  wrapped_sol: "wrapped SOL",
  not_owner: "not owned by this wallet",
  close_authority: "another address is its close authority",
  frozen: "frozen",
  withheld_transfer_fees: "Token-2022 transfer fees withheld in it",
  confidential_transfer: "Token-2022 confidential-transfer state",
}

function solOf(lamports: string): string {
  const digits = lamports.padStart(10, "0")
  return `${digits.slice(0, -9)}.${digits.slice(-9)}`.replace(/\.?0+$/, "")
}

function previewLines(preview: Preview): string[] {
  const lines = [
    `Close ${preview.accountCount} empty token account${preview.accountCount === 1 ? "" : "s"} on the embedded wallet ${safeText(preview.wallet)}`,
    `Rent returned to that same wallet: ${safeText(preview.totalSol)} SOL in ${preview.transactions} transaction${preview.transactions === 1 ? "" : "s"}, network fee about ${solOf(preview.estimatedFeeLamports)} SOL, net ${safeText(preview.netSol)} SOL`,
  ]
  for (const row of preview.accounts.slice(0, LISTED_ROWS))
    lines.push(`  ${safeText(row.mint)}  ${safeText(row.tokenProgram)}  ${solOf(row.lamports)} SOL`)
  if (preview.accounts.length > LISTED_ROWS)
    lines.push(`  ... and ${preview.accounts.length - LISTED_ROWS} more (--json lists every one)`)
  const cap = preview.maxAccountsPerCall
  if (cap !== undefined && preview.accountCount > cap)
    lines.push(`This run closes the first ${cap}; run it again for the rest.`)
  if (preview.skipped.length > 0) {
    const counts = new Map<string, number>()
    for (const row of preview.skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
    lines.push(
      `Left open: ${[...counts].map(([reason, n]) => `${n} ${SKIP_WORDS[reason] ?? safeText(reason)}`).join(", ")}`,
    )
  }
  return lines
}

async function confirmClose(ctx: CommandContext, lines: string[], yes: boolean): Promise<boolean> {
  const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
  for (const line of lines) output.write(`${line}\n`)
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError(
      "CONFIRMATION_REQUIRED",
      "Run interactively to confirm, or use --yes to close without a prompt.",
    )
  return (await ctx.deps.promptLine("Proceed? [y/N] ")).trim().toLowerCase() === "y"
}

/** The account's embedded Solana wallet, or a refusal naming what to use instead. */
async function embeddedSolana(ctx: CommandContext, key: string, wallet: string | undefined): Promise<string> {
  const body = await request(ctx, key, "/api/v1/agent/wallets/embedded")
  const wallets = body.wallets as { solana?: { address?: unknown } | null } | undefined
  const address = typeof wallets?.solana?.address === "string" ? wallets.solana.address : undefined
  if (!address)
    throw new TradingError(
      "AGENT_WALLET_MISSING",
      "This account has no embedded Solana wallet. Create one in the app, then run this again.",
    )
  if (wallet !== undefined && wallet !== "embedded" && wallet !== address)
    throw new TradingError(
      "PAYER_UNSUPPORTED",
      `This command closes accounts on the embedded wallet (${address}) only. A TEE wallet's empty accounts close with: candle tee sweep <address>`,
    )
  return address
}

export async function walletsCloseEmpty(args: string[], ctx: CommandContext): Promise<number> {
  const lifted = splitKeep(args)
  if ("error" in lifted) {
    writeUsageFailure(ctx.deps, `${lifted.error}. ${USAGE}`, ctx.json)
    return 2
  }
  const parsed = parseArgs(lifted.rest, { valueFlags: ["--wallet", "--client-trade-id"], booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const named = parsed.values["--client-trade-id"]
  const id = named ?? `close-${randomUUID()}`
  if (parsed.positionals.length !== 0 || !validClientId(id) || !lifted.keep.every((m) => BASE58_ADDRESS.test(m))) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  const keep = lifted.keep
  try {
    const key = await tradingKey(ctx)
    // A named id may already have run. Its stored report is the answer; nothing is resent.
    if (named !== undefined) {
      try {
        const prior = await request(
          ctx,
          key,
          `/api/v1/agent/wallets/embedded/close-empty/jobs/${encodeURIComponent(id)}`,
        )
        return printTradingResult(ctx, { ...prior, clientTradeId: id })
      } catch (error) {
        if (!(error instanceof TradingError && error.code === "JOB_NOT_FOUND")) throw error
      }
    }
    const wallet = await embeddedSolana(ctx, key, parsed.values["--wallet"])
    const preview = (await request(ctx, key, "/api/v1/agent/wallets/embedded/close-empty/preview", {
      keep,
    })) as unknown as Preview
    if (!Array.isArray(preview.accounts) || preview.wallet !== wallet)
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle's preview does not name the embedded wallet; nothing was closed.",
      )
    if (preview.accounts.length === 0) {
      const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
      output.write(`No empty token accounts to close on the embedded wallet ${safeText(wallet)}.\n`)
      for (const line of previewLines(preview).slice(2)) output.write(`${line}\n`)
      return printTradingResult(ctx, {
        success: true,
        status: "nothing_to_close",
        wallet,
        preview: preview as unknown as Json,
      })
    }
    const confirmed = await confirmClose(ctx, previewLines(preview), parsed.booleans.has("--yes"))
    if (!confirmed)
      return printTradingResult(ctx, {
        success: true,
        status: "cancelled",
        wallet,
        preview: preview as unknown as Json,
      })
    ctx.deps.stderr.write(`Operation: ${id}\n`)
    const result = await request(ctx, key, "/api/v1/agent/wallets/embedded/close-empty", {
      clientTradeId: id,
      keep,
      accounts: preview.accounts.map((row) => row.account),
    })
    return printTradingResult(ctx, { ...result, clientTradeId: id })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
