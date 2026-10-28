/**
 * `candle wallet close-empty` (BE-418, BE-1687): close a wallet's empty token accounts and take
 * their rent back into that same wallet, with the preview and confirm `candle swap` uses.
 *
 * The embedded wallet (the default, `--wallet embedded` or its address), `transfer:write`:
 *
 *   POST /agent/wallets/embedded/close-empty/preview  ->  confirm  ->  POST /agent/wallets/embedded/close-empty
 *
 * Candle signs with the embedded wallet's delegation and broadcasts. This machine signs nothing.
 *
 * A Solana TEE wallet bound to this key (`--wallet <address|label|id>`), `swap:write`:
 *
 *   POST /agent/wallets/:id/close-empty/preview  ->  confirm  ->  POST .../build
 *     ->  check every transaction here  ->  POST /agent/wallets/:id/sign, once each  ->  POST .../submit
 *
 * Candle builds the close transactions; this machine refuses any that is not CloseAccount alone,
 * with the TEE wallet as fee payer, rent destination and owner, over the accounts the preview
 * showed, before the relay signs it with the profile's key signer. The server then sends the whole
 * signed batch. A disabled or quarantined TEE wallet still closes with `candle tee sweep`.
 *
 * Candle decides which accounts qualify (balance zero on either token program, owned by the
 * wallet, not wrapped SOL, not frozen, no Token-2022 withheld fees or confidential state). Execute
 * closes exactly the accounts the preview showed, so an account that emptied after the prompt waits
 * for the next run. `--keep` leaves a mint's account open, for the pair token a held holder-reward
 * coin pays into.
 *
 * The run is keyed by a clientTradeId, durable on Candle: re-running with the same
 * `--client-trade-id` prints the stored report instead of closing again. A TEE close the chain has
 * not settled yet answers `recovering` (exit 3); that same re-run reads it again and sends nothing.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { decodeStrictBase64, decodeTransaction, TransactionDecodeError } from "../solana-alt"
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  type Json,
  relaySign,
  request,
  safeText,
  TradingError,
  type TradingWallet,
  tradingKey,
  tradingPayer,
} from "../trading"
import { printTradingResult, tradingFailure, validClientId } from "./swap"

const USAGE =
  "Usage: candle wallet close-empty [--wallet embedded|<tee address|label>] [--keep <mint>]... [--client-trade-id <id>] [--yes] [--json]"

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** Rows printed before the list is summarized; the full list is always in the --json output. */
const LISTED_ROWS = 50
/** SPL Token `CloseAccount`, the same discriminator under Token-2022. */
const TOKEN_IX_CLOSE_ACCOUNT = 9

interface PreviewAccount {
  account: string
  mint: string
  tokenProgram: string
  lamports: string
}

interface Preview {
  wallet: string
  linkedWalletId?: string
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

interface Run {
  id: string
  /** The id was given with --client-trade-id, so it may already have run. */
  named: boolean
  keep: string[]
  yes: boolean
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

/** `walletName` is how the wallet is named: "embedded wallet <address>" or "TEE wallet <label>". */
function previewLines(preview: Preview, walletName: string): string[] {
  const lines = [
    `Close ${preview.accountCount} empty token account${preview.accountCount === 1 ? "" : "s"} on the ${walletName}`,
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

/**
 * The preview, shown and confirmed. A number when the run ends here (nothing to close, or the
 * prompt was declined); otherwise the accounts to close, exactly as shown.
 */
async function previewAndConfirm(
  ctx: CommandContext,
  preview: Preview,
  walletName: string,
  yes: boolean,
): Promise<number | string[]> {
  if (preview.accounts.length === 0) {
    const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
    output.write(`No empty token accounts to close on the ${walletName}.\n`)
    for (const line of previewLines(preview, walletName).slice(2)) output.write(`${line}\n`)
    return printTradingResult(ctx, {
      success: true,
      status: "nothing_to_close",
      wallet: preview.wallet,
      preview: preview as unknown as Json,
    })
  }
  if (!(await confirmClose(ctx, previewLines(preview, walletName), yes)))
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      wallet: preview.wallet,
      preview: preview as unknown as Json,
    })
  return preview.accounts.map((row) => row.account)
}

// ── The embedded wallet (BE-418) ─────────────────────────────────────────────────────────────

/** The account's embedded Solana address, or undefined when it has none. */
async function embeddedAddress(ctx: CommandContext, key: string): Promise<string | undefined> {
  const body = await request(ctx, key, "/api/v1/agent/wallets/embedded")
  const wallets = body.wallets as { solana?: { address?: unknown } | null } | undefined
  return typeof wallets?.solana?.address === "string" ? wallets.solana.address : undefined
}

async function closeEmbedded(ctx: CommandContext, key: string, run: Run): Promise<number> {
  const { id, keep } = run
  // A named id may already have run. Its stored report is the answer; nothing is resent.
  if (run.named) {
    try {
      const prior = await request(ctx, key, `/api/v1/agent/wallets/embedded/close-empty/jobs/${encodeURIComponent(id)}`)
      return printTradingResult(ctx, { ...prior, clientTradeId: id })
    } catch (error) {
      if (!(error instanceof TradingError && error.code === "JOB_NOT_FOUND")) throw error
    }
  }
  const wallet = await embeddedAddress(ctx, key)
  if (!wallet)
    throw new TradingError(
      "AGENT_WALLET_MISSING",
      "This account has no embedded Solana wallet. Create one in the app, then run this again.",
    )
  const preview = (await request(ctx, key, "/api/v1/agent/wallets/embedded/close-empty/preview", {
    keep,
  })) as unknown as Preview
  if (!Array.isArray(preview.accounts) || preview.wallet !== wallet)
    throw new TradingError(
      "INVALID_RESPONSE",
      "Candle's preview does not name the embedded wallet; nothing was closed.",
    )
  const accounts = await previewAndConfirm(ctx, preview, `embedded wallet ${safeText(wallet)}`, run.yes)
  if (typeof accounts === "number") return accounts
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const result = await request(ctx, key, "/api/v1/agent/wallets/embedded/close-empty", {
    clientTradeId: id,
    keep,
    accounts,
  })
  return printTradingResult(ctx, { ...result, clientTradeId: id })
}

// ── A TEE wallet (BE-1687) ───────────────────────────────────────────────────────────────────

interface BuiltClose {
  index: number
  unsignedTransaction: string
  accounts: string[]
}

/**
 * Why one built transaction is not a close of `accounts` back into `wallet`, or null. Decoded here,
 * with no RPC: the fee payer and only signer is the wallet; no lookup table; every instruction is a
 * token program's CloseAccount whose destination and owner are the wallet; each closes one of
 * `accounts`, once, and every one of `accounts` is closed.
 */
export function closeProblem(transaction: string, wallet: string, accounts: ReadonlySet<string>): string | null {
  let message: ReturnType<typeof decodeTransaction>["message"]
  try {
    message = decodeTransaction(decodeStrictBase64(transaction)).message
  } catch (error) {
    if (error instanceof TransactionDecodeError) return `does not decode: ${error.message}`
    throw error
  }
  if (message.staticKeys[0] !== wallet) return `is paid by ${message.staticKeys[0]}, not this wallet`
  if (message.numRequiredSignatures !== 1)
    return `needs ${message.numRequiredSignatures} signatures, not this wallet's alone`
  if (message.lookups.length > 0) return "loads accounts from a lookup table"
  if (message.instructions.length === 0) return "closes nothing"
  const closed = new Set<string>()
  for (const [i, ix] of message.instructions.entries()) {
    const program = message.staticKeys[ix.programIdIndex]
    const account = (at: number) => message.staticKeys[ix.accountIndexes[at] ?? -1]
    if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID)
      return `instruction ${i} calls ${program ?? "an unknown program"}, not a token program`
    if (ix.data.length !== 1 || ix.data[0] !== TOKEN_IX_CLOSE_ACCOUNT) return `instruction ${i} is not CloseAccount`
    // CloseAccount(account, destination, owner), with no multisig signers.
    if (ix.accountIndexes.length !== 3) return `instruction ${i} names ${ix.accountIndexes.length} accounts, not 3`
    if (account(1) !== wallet) return `instruction ${i} sends the rent to ${account(1) ?? "?"}, not this wallet`
    if (account(2) !== wallet) return `instruction ${i} names ${account(2) ?? "?"} as the owner, not this wallet`
    const target = account(0)
    if (target === undefined || !accounts.has(target))
      return `instruction ${i} closes ${target ?? "?"}, which the build does not list for it`
    if (closed.has(target)) return `instruction ${i} closes ${target} a second time`
    closed.add(target)
  }
  if (closed.size !== accounts.size) return "lists accounts it does not close"
  return null
}

/**
 * The build, checked before anything is signed: it names this TEE wallet, and every transaction is
 * a close of accounts the preview listed (`closeProblem`), no account twice across the batch.
 */
function checkedBuild(build: Json, wallet: string, previewed: ReadonlySet<string>): BuiltClose[] {
  const refuse = (why: string) =>
    new TradingError("INVALID_RESPONSE", `The close Candle built ${why}; nothing was signed.`)
  if (build.status !== "built" || build.wallet !== wallet) throw refuse(`does not name the TEE wallet ${wallet}`)
  const list = build.transactions
  if (!Array.isArray(list) || list.length === 0) throw refuse("has no transactions")
  const indexes = new Set<number>()
  const closing = new Set<string>()
  const out: BuiltClose[] = []
  for (const entry of list) {
    const { index, unsignedTransaction, accounts } = (entry ?? {}) as Record<string, unknown>
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      indexes.has(index) ||
      typeof unsignedTransaction !== "string" ||
      !Array.isArray(accounts) ||
      !accounts.every((a): a is string => typeof a === "string")
    )
      throw refuse("is not a list of indexed transactions")
    indexes.add(index)
    for (const account of accounts) {
      if (!previewed.has(account)) throw refuse(`closes ${safeText(account)}, which the preview did not list`)
      if (closing.has(account)) throw refuse(`closes ${safeText(account)} twice`)
      closing.add(account)
    }
    const problem = closeProblem(unsignedTransaction, wallet, new Set(accounts))
    if (problem) throw refuse(`transaction ${index} ${safeText(problem)}`)
    out.push({ index, unsignedTransaction, accounts })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** The relay's answer must carry the very message this machine checked. */
function sameMessage(unsigned: string, signed: string): boolean {
  try {
    const a = decodeTransaction(decodeStrictBase64(unsigned)).message.bytes
    const b = decodeTransaction(decodeStrictBase64(signed)).message.bytes
    return Buffer.from(a).equals(Buffer.from(b))
  } catch (error) {
    if (error instanceof TransactionDecodeError) return false
    throw error
  }
}

/**
 * A TEE close the chain has not settled: printed as the server sent it, with the re-run that reads
 * it again. Exit 3: a transaction may still land, and nothing is sent again.
 */
function printRecovering(ctx: CommandContext, result: Json, id: string, wallet: string): number {
  notice(
    ctx.deps,
    "stderr",
    "note",
    `Not every close is settled on chain yet; nothing will be sent again. Read it again with: candle wallet close-empty --wallet ${safeText(wallet)} --client-trade-id ${id}\n`.trim(),
  )
  printTradingResult(ctx, { ...result, clientTradeId: id })
  return 3
}

/** What a TEE job read answers: the stored report, a recovery still open, or a build never submitted. */
function printTeeJob(ctx: CommandContext, prior: Json, id: string, wallet: string): number {
  const job = (prior.job ?? {}) as Json
  const result = (job.result ?? {}) as Json
  if (result.status === "recovering") return printRecovering(ctx, prior, id, wallet)
  if (result.status === "built")
    notice(
      ctx.deps,
      "stderr",
      "warning",
      `Operation ${id} was built and never submitted to Candle, so Candle sent nothing; its transactions expire at block height ${safeText(result.expiresAtBlockHeight)}. Run again without --client-trade-id to close under a new id.\n`.trim(),
    )
  return printTradingResult(ctx, { ...prior, clientTradeId: id })
}

async function closeTee(
  ctx: CommandContext,
  key: string,
  wallet: TradingWallet,
  name: string,
  run: Run,
): Promise<number> {
  const { id, keep } = run
  const base = `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/close-empty`
  const jobPath = `${base}/jobs/${encodeURIComponent(id)}`
  // A named id may already have run. Its stored report is the answer; nothing is resent.
  if (run.named) {
    try {
      return printTeeJob(ctx, await request(ctx, key, jobPath), id, wallet.address)
    } catch (error) {
      if (!(error instanceof TradingError && error.code === "JOB_NOT_FOUND")) throw error
    }
  }
  const preview = (await request(ctx, key, `${base}/preview`, { keep })) as unknown as Preview
  if (
    !Array.isArray(preview.accounts) ||
    preview.wallet !== wallet.address ||
    (preview.linkedWalletId !== undefined && preview.linkedWalletId !== wallet.id)
  )
    throw new TradingError("INVALID_RESPONSE", "Candle's preview does not name the TEE wallet; nothing was closed.")
  const label = safeText(name === wallet.address ? wallet.address : `${name} (${wallet.address})`)
  const accounts = await previewAndConfirm(ctx, preview, `TEE wallet ${label}`, run.yes)
  if (typeof accounts === "number") return accounts
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const build = await request(ctx, key, `${base}/build`, { clientTradeId: id, keep, accounts })
  if (build.status === "nothing_to_close") return printTradingResult(ctx, { ...build, clientTradeId: id })
  // A submit already began under this id: its outcome is the job's, and nothing is signed again.
  if (build.submitState !== undefined) return printTeeJob(ctx, await request(ctx, key, jobPath), id, wallet.address)
  const transactions = checkedBuild(build, wallet.address, new Set(accounts))
  const signed: { index: number; signedTransaction: string }[] = []
  for (const transaction of transactions) {
    const signedTransaction = await relaySign(ctx, key, wallet, transaction.unsignedTransaction)
    if (!sameMessage(transaction.unsignedTransaction, signedTransaction))
      throw new TradingError(
        "INVALID_RESPONSE",
        `The relay returned a different transaction for close ${transaction.index} than the one checked; nothing was submitted.`,
      )
    signed.push({ index: transaction.index, signedTransaction })
  }
  // The whole batch, every index once: the server sends nothing until all of it checks out.
  const result = await request(ctx, key, `${base}/submit`, { clientTradeId: id, signed })
  if (result.status === "recovering") return printRecovering(ctx, result, id, wallet.address)
  return printTradingResult(ctx, { ...result, clientTradeId: id })
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
  const run: Run = { id, named: named !== undefined, keep: lifted.keep, yes: parsed.booleans.has("--yes") }
  const walletName = parsed.values["--wallet"]
  try {
    const key = await tradingKey(ctx)
    if (walletName === undefined || walletName === "embedded") return await closeEmbedded(ctx, key, run)
    // The embedded address keeps the embedded close and its scope; anything else names a TEE wallet
    // this key is bound to, resolved as `candle swap` resolves its payer.
    if (walletName === (await embeddedAddress(ctx, key))) return await closeEmbedded(ctx, key, run)
    const payer = await tradingPayer(ctx, key, walletName, "swap:write", "solana")
    if (payer.kind === "embedded") return await closeEmbedded(ctx, key, run)
    return await closeTee(ctx, key, payer.wallet, walletName, run)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
