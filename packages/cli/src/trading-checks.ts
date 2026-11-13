/** Diagnostics stop before broadcast. Only tee check --sign may consume a signing claim. */
import { randomUUID } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import { z } from "zod"
import { parseArgs } from "./args"
import { decimalsFor, lazySolanaClient, tradingFailure, tradingRead } from "./commands/swap"
import type { CommandContext } from "./deps"
import { writeUsageFailure } from "./render"
import { decodeStrictBase64, decodeTransaction } from "./solana-alt"
import { describeRpcFailure } from "./solana-endpoint"
import { solanaSpendProblem } from "./solana-verify"
import {
  BASES,
  baseAsset,
  classifyAsset,
  decimalAmount,
  describeWallet,
  inspectTradingWallet,
  type Json,
  listTradingWallets,
  matchesName,
  rawAmount,
  relaySign,
  request,
  safeText,
  selectTradingPayer,
  swapBuildSchema,
  TradingError,
  TradingUsage,
  type TradingWallet,
  type TradingWalletListing,
  type TradingWalletRow,
  tradingKey,
} from "./trading"

export interface WalletCheck {
  id: string
  status: "pass" | "fail" | "skipped"
  code?: string
  message?: string
  suggestion?: string
  because?: string
  needs?: "balance"
  cause?: string
  differences?: Record<string, { trading: unknown; wallets: unknown }>
}
export interface WalletReport {
  address?: string
  id?: string
  label?: string
  name?: string
  ok: boolean
  checks: WalletCheck[]
  quote?: Json
}
const pass = (id: string): WalletCheck => ({ id, status: "pass" })
const skipped = (id: string, because: string): WalletCheck => ({ id, status: "skipped", because })
function failure(id: string, error: unknown): WalletCheck {
  if (error instanceof TradingUsage) throw error
  return {
    id,
    status: "fail",
    code: error instanceof TradingError ? error.code : "INVALID_RESPONSE",
    message: error instanceof Error ? describeRpcFailure(error) : "The check could not complete.",
    ...(error instanceof TradingError && error.suggestion ? { suggestion: error.suggestion } : {}),
  }
}
function balanceProblem(value: unknown): boolean {
  return /InsufficientFunds(?:ForFee)?|AccountNotFound|insufficient[_ ](?:funds|balance|lamports)/i.test(
    value instanceof Error ? `${value instanceof TradingError ? value.code : ""} ${value.message}` : String(value),
  )
}
function needsBalance(id: string): WalletCheck {
  return {
    id,
    status: "skipped",
    needs: "balance",
    message: "This check needs balance; fund the wallet and check again.",
  }
}
async function diagnosticListing(ctx: CommandContext, key: string): Promise<TradingWalletListing> {
  try {
    return await listTradingWallets(ctx, key)
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new TradingError("INVALID_RESPONSE", "Trading wallet discovery returned a malformed page.")
    throw error
  }
}
const linkedRow = z.object({
  _id: z.string(),
  address: z.string(),
  chain: z.string(),
  label: z.string().optional(),
  signerQuorumId: z.string().optional(),
  profile: z.string().optional(),
  revokedAt: z.number().optional(),
})
type LinkedRow = z.infer<typeof linkedRow>
async function readWalletRecords(ctx: CommandContext, key: string): Promise<LinkedRow[]> {
  const rows: LinkedRow[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 25; page++) {
    const result = z
      .object({
        page: z.array(linkedRow),
        isDone: z.boolean(),
        continueCursor: z.string().nullable().optional(),
      })
      .safeParse(
        await request(
          ctx,
          key,
          `/api/v1/agent/wallets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
    if (!result.success) throw new TradingError("INVALID_RESPONSE", "Wallet records did not return a valid page.")
    rows.push(...result.data.page)
    if (result.data.isDone) return rows
    cursor = result.data.continueCursor ?? undefined
    if (!cursor || seen.has(cursor)) break
    seen.add(cursor)
  }
  throw new TradingError("INVALID_RESPONSE", "Wallet records did not complete.")
}

/** Compare the two actual API views, including missing fields (BE-2930). */
export function walletRecordCheck(
  row: TradingWalletRow,
  trading: TradingWalletRow[],
  records: LinkedRow[],
): WalletCheck {
  const found = records.filter((record) => record.address === row.address)
  const differences: NonNullable<WalletCheck["differences"]> = {}
  const other = found[0]
  const count = trading.filter((record) => record.address === row.address).length
  if (count !== 1 || found.length !== 1) differences.addressCount = { trading: count, wallets: found.length }
  for (const [left, right] of [
    ["id", "_id"],
    ["signerQuorumId", "signerQuorumId"],
    ["chain", "chain"],
    ["label", "label"],
    ["address", "address"],
  ] as const) {
    if (!other || row[left] !== other[right])
      differences[left] = { trading: row[left] ?? null, wallets: other?.[right] ?? null }
  }
  if (!other || !["ember-tee", "ember-hot"].includes(other.profile ?? ""))
    differences.profile = { trading: "TEE", wallets: other?.profile ?? null }
  if (other?.revokedAt !== undefined) differences.revokedAt = { trading: null, wallets: other.revokedAt }
  return Object.keys(differences).length
    ? {
        id: "record",
        status: "fail",
        code: "WALLET_RECORD_MISMATCH",
        message: `Trading and wallet records differ: ${JSON.stringify(differences)}.`,
        differences,
      }
    : pass("record")
}

async function inspectReport(
  ctx: CommandContext,
  key: string,
  row: TradingWalletRow | undefined,
  listing: TradingWalletListing,
  records: LinkedRow[],
  payable?: unknown,
  name?: string,
): Promise<{ report: WalletReport; wallet?: TradingWallet }> {
  const checks: WalletCheck[] = [pass("key"), payable ? failure("payable", payable) : pass("payable")]
  checks.push(
    listing.scopes.includes("swap:write")
      ? pass("scope")
      : failure("scope", new TradingError("SCOPE_MISSING", "The bound key needs swap:write.")),
  )
  const report: WalletReport = {
    ...(row ? { id: row.id, address: row.address, label: row.label } : { name }),
    ok: false,
    checks,
  }
  if (!row) {
    checks.push(...["record", "active", "signer"].map((id) => skipped(id, "payable")))
    return { report }
  }
  checks.push(walletRecordCheck(row, listing.rows, records))
  const inspected = await inspectTradingWallet(ctx, row, listing.appId, "swap:write", "solana", {
    apiKey: key,
    keyPrefix: listing.keyPrefix,
  })
  const active = inspected.failures.filter((error) => error.code !== "SIGNER_UNAVAILABLE")
  checks.push(...(active.length ? active.map((error) => failure("active", error)) : [pass("active")]))
  const signer = inspected.failures.find((error) => error.code === "SIGNER_UNAVAILABLE")
  checks.push(signer ? failure("signer", signer) : pass("signer"))
  return { report, wallet: inspected.row }
}

export function printWalletReports(ctx: CommandContext, reports: WalletReport[], swap = false): number {
  for (const report of reports) report.ok = !report.checks.some((check) => check.status === "fail")
  const failed = reports.filter((report) => !report.ok).length
  const summary = { total: reports.length, pass: reports.length - failed, fail: failed }
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({
        success: failed === 0,
        dryRun: true,
        wallets: reports,
        summary,
        ...(swap ? { checks: reports[0]?.checks, quote: reports[0]?.quote } : {}),
      })}\n`,
    )
  } else {
    for (const report of reports) {
      const first = report.checks.find((check) => check.status === "fail")
      ctx.deps.stdout.write(
        `${safeText(report.label ?? report.name ?? report.id ?? "wallet")}  ${safeText(report.address ?? "")}  ${report.ok ? "PASS" : "FAIL"}${first ? `  ${first.id}/${first.code}` : ""}\n`,
      )
      if (reports.length === 1) {
        for (const check of report.checks)
          ctx.deps.stdout.write(
            `  ${check.id}  ${check.status}${check.code ? `  ${check.code}` : ""}${check.message ? `  ${safeText(check.message)}` : ""}${check.because ? ` (${check.because})` : ""}\n`,
          )
        if (report.quote) ctx.deps.stdout.write(`  quote  ${safeText(JSON.stringify(report.quote))}\n`)
      }
    }
    if (reports.length > 1) ctx.deps.stdout.write(`${summary.pass} pass, ${summary.fail} fail\n`)
  }
  return failed ? 1 : 0
}

/** Both Solana builds use the real payload, quote validation and SEC-003 limits. No operation state. */
async function buildCheck(
  ctx: CommandContext,
  key: string,
  wallet: TradingWallet,
  report: WalletReport,
  from: string,
  to: string,
  amount: string,
  slippage: number,
  rpcUrl: string | undefined,
  sign: boolean,
): Promise<void> {
  const checks = report.checks
  const blocked = checks.find((check) => check.status === "fail")
  if (blocked) {
    checks.push(skipped("quote", blocked.id), skipped("spend", "quote"))
    if (sign) checks.push(skipped("sign", "spend"))
    return
  }
  const solana = lazySolanaClient(ctx, rpcUrl)
  let transaction: string
  let quote: Json
  let amountRaw: string
  let minimumRaw: string
  let feeRaw: bigint
  const fromBase = baseAsset(from)
  const toBase = baseAsset(to)
  const kind = fromBase && toBase ? "swap" : "trade"
  try {
    const decimals = await decimalsFor(ctx, from, solana)
    const outDecimals = await decimalsFor(ctx, to, solana)
    amountRaw = rawAmount(amount, decimals)
    if (BigInt(amountRaw) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TradingError("INVALID_AMOUNT", "Amount exceeds the venue's exact integer range.")
    const payer = { type: "linked", linkedWalletId: wallet.id }
    const clientTradeId = `swap-${randomUUID()}`
    const built =
      kind === "swap"
        ? await request(ctx, key, "/api/v1/agent/swap/build", {
            clientTradeId,
            from,
            to,
            amountRaw,
            maxSlippageBps: slippage,
            payer,
          })
        : await request(ctx, key, "/api/v1/trade/agent/build", {
            clientTradeId,
            chain: "solana",
            mint: fromBase ? to : from,
            side: fromBase ? "buy" : "sell",
            quoteAsset: (fromBase ?? toBase)?.toLowerCase(),
            amountRaw,
            maxSlippageBps: slippage,
            payer,
          })
    const parsed = swapBuildSchema.safeParse(kind === "swap" ? built.payload : built)
    if (!parsed.success || built.job || built.status === "executed")
      throw new TradingError("INVALID_RESPONSE", "Candle did not return a complete built quote.")
    const data = parsed.data
    if (kind === "swap" && (data.venue !== "jupiter" || data.recipient !== wallet.address))
      throw new TradingError("INVALID_RESPONSE", "A base swap must use Jupiter and return to its payer.")
    if (kind === "trade" && (built.chain !== "solana" || built.walletAddress !== wallet.address))
      throw new TradingError("INVALID_RESPONSE", "The token build does not name the requested Solana payer.")
    const artifacts = kind === "swap" ? data : data.artifacts
    if (!artifacts) throw new TradingError("INVALID_RESPONSE", "Missing quote artifacts.")
    if (kind === "trade" && data.artifacts?.quoteAsset !== (fromBase ?? toBase)?.toLowerCase())
      throw new TradingError("PAIR_UNSUPPORTED", "The token settles in a different quote asset.")
    if (data.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The quote expired; build a fresh check.")
    minimumRaw =
      !fromBase && artifacts.venue === "curve"
        ? (BigInt(data.minOutRaw) > BigInt(data.fee.feeRaw)
            ? BigInt(data.minOutRaw) - BigInt(data.fee.feeRaw)
            : 0n
          ).toString()
        : data.minOutRaw
    quote = {
      venue: (kind === "trade" ? data.artifacts?.quoteSource : undefined) ?? artifacts.venue,
      priceImpactPct: artifacts.priceImpactPct ?? null,
      fee: data.fee,
      minimumReceived: `${decimalAmount(minimumRaw, outDecimals)} ${to}`,
      minOutRaw: data.minOutRaw,
      minimumReceivedRaw: minimumRaw,
      tokenRisks: artifacts.tokenRisks ?? [],
    }
    const tx = kind === "swap" ? data.transactionsBase64?.[0] : data.artifacts?.transactionBase64
    if (!tx || (kind === "swap" && data.transactionsBase64?.length !== 1))
      throw new TradingError("INVALID_RESPONSE", "A TEE swap must contain exactly one same-chain transaction.")
    transaction = tx
    feeRaw = BigInt(data.fee.feeRaw)
    report.quote = quote
    checks.push(pass("quote"))
  } catch (error) {
    checks.push(balanceProblem(error) ? needsBalance("quote") : failure("quote", error), skipped("spend", "quote"))
    if (sign) checks.push(skipped("sign", "spend"))
    return
  }
  const assetOf = (asset: string) => (asset === "SOL" ? "SOL" : (BASES[asset]?.mint ?? asset))
  let reader: Awaited<ReturnType<typeof solana>>
  try {
    reader = await solana()
    const problem = await tradingRead(ctx, reader, () =>
      solanaSpendProblem(transaction, wallet.address, reader.rpc, {
        kind: "swap",
        spend: assetOf(from),
        maxSpendRaw: BigInt(amountRaw) + (kind === "trade" && fromBase ? feeRaw : 0n),
        receive: { asset: assetOf(to), minRaw: BigInt(minimumRaw) },
      }),
    )
    if (problem) {
      checks.push(
        balanceProblem(problem)
          ? needsBalance("spend")
          : failure(
              "spend",
              new TradingError(
                "INVALID_RESPONSE",
                `The transaction Candle built does not match the quote (${safeText(problem)}); nothing was signed.`,
              ),
            ),
      )
      if (sign) checks.push(skipped("sign", "spend"))
      return
    }
    checks.push(pass("spend"))
  } catch (error) {
    checks.push(balanceProblem(error) ? needsBalance("spend") : failure("spend", error))
    if (sign) checks.push(skipped("sign", "spend"))
    return
  }
  if (!sign) return
  try {
    const signed = await relaySign(ctx, key, wallet, transaction)
    const decoded = decodeTransaction(decodeStrictBase64(signed))
    const original = decodeTransaction(decodeStrictBase64(transaction))
    if (
      decoded.message.staticKeys[0] !== wallet.address ||
      !Buffer.from(decoded.message.bytes).equals(Buffer.from(original.message.bytes)) ||
      !ed25519.verify(decoded.signatures[0] as Uint8Array, decoded.message.bytes, base58.decode(wallet.address))
    )
      throw new TradingError(
        "SIGNATURE_INVALID",
        "The relay did not return the payer's signature over the built message.",
      )
    checks.push(pass("sign"))
    try {
      const simulation = await tradingRead(ctx, reader, () =>
        reader.rpc.simulateTransaction(signed, [], { sigVerify: true }),
      )
      const problem = simulation.err == null ? undefined : JSON.stringify(simulation.err)
      if (!problem) checks.push(pass("simulation"))
      else if (balanceProblem(problem)) checks.push(needsBalance("simulation"))
      else if (/BlockhashNotFound|blockhash not found|blockhash.*expir|block.?height.*exceed/i.test(problem))
        checks.push({ id: "simulation", status: "skipped", message: "The blockhash expired; run a fresh check." })
      else
        checks.push({
          ...failure("simulation", new TradingError("SIGN_FAILED", "Signed simulation failed.")),
          cause: problem,
        })
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error)
      if (balanceProblem(problem)) checks.push(needsBalance("simulation"))
      else if (/BlockhashNotFound|blockhash not found|blockhash.*expir|block.?height.*exceed/i.test(problem))
        checks.push({ id: "simulation", status: "skipped", message: "The blockhash expired; run a fresh check." })
      else if (error instanceof TradingError && error.code === "RPC_RATE_LIMITED")
        checks.push(failure("simulation", error))
      else
        checks.push({
          ...failure("simulation", new TradingError("SIGN_FAILED", "Signed simulation could not complete.")),
          cause: error instanceof TradingError ? error.code : "RPC_FAILED",
        })
    }
  } catch (error) {
    checks.push({
      ...failure("sign", new TradingError("SIGN_FAILED", "The signer did not produce a verified signature.")),
      cause: error instanceof TradingError ? error.code : "INVALID_RESPONSE",
    })
  }
}

export async function teeCheck(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--label-prefix", "--max", "--rpc-url"], booleanFlags: ["--sign"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const max = Number(parsed.values["--max"] ?? "10")
  if (
    (!parsed.positionals.length && parsed.values["--label-prefix"] === undefined) ||
    !Number.isSafeInteger(max) ||
    max < 1
  ) {
    writeUsageFailure(
      ctx.deps,
      "Usage: candle tee check <address|id|label>... [--label-prefix <p>] [--sign] [--max <n>] [--rpc-url <url>]",
      ctx.json,
    )
    return 2
  }
  try {
    const key = await tradingKey(ctx)
    const listing = await diagnosticListing(ctx, key)
    const names = [...new Set(parsed.positionals)]
    const prefix = parsed.values["--label-prefix"]
    if (prefix !== undefined) {
      const selected = listing.rows.filter((row) => row.label?.startsWith(prefix))
      if (!selected.length)
        throw new TradingError(
          "TEE_WALLET_REQUIRED",
          `No TEE wallet matches this prefix. Bound to this key: ${listing.rows.map(describeWallet).join("; ") || "none"}.`,
        )
      for (const row of selected) names.push(row.id)
    }
    // Distinct aliases of one wallet consume one claim, never several.
    const selected = new Set<string>()
    const targets = names.filter((name) => {
      const matches = listing.rows.filter((row) => matchesName(row, name))
      const id = matches.length === 1 ? (matches[0] as TradingWalletRow).id : `name:${name}`
      if (selected.has(id)) return false
      selected.add(id)
      return true
    })
    const sign = parsed.booleans.has("--sign")
    if (sign && targets.length > max)
      throw new TradingError(
        "VALIDATION_FAILED",
        `Signing ${targets.length} wallets exceeds the batch cap ${max}; raise it explicitly with --max.`,
      )
    const records = await readWalletRecords(ctx, key)
    const reports: WalletReport[] = []
    for (const name of targets) {
      const matches = listing.rows.filter((row) => matchesName(row, name))
      const payable =
        matches.length === 1
          ? undefined
          : new TradingError(
              "TEE_WALLET_REQUIRED",
              `"${safeText(name)}" matches ${matches.length} TEE wallets. Bound to this key: ${listing.rows.map(describeWallet).join("; ") || "no TEE wallets bound to this key"}.`,
            )
      const { report, wallet } = await inspectReport(
        ctx,
        key,
        matches.length === 1 ? matches[0] : undefined,
        listing,
        records,
        payable,
        name,
      )
      if (sign && wallet)
        await buildCheck(ctx, key, wallet, report, "SOL", "USDC", "0.000001", 50, parsed.values["--rpc-url"], true)
      else
        report.checks.push(
          skipped(
            "sign",
            sign ? (report.checks.find((check) => check.status === "fail")?.id ?? "signer") : "--sign not set",
          ),
        )
      reports.push(report)
    }
    return printWalletReports(ctx, reports)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

export async function swapCheck(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--percent", "--wallet", "--to", "--client-trade-id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--dry-run", "--yes", "--wait"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  try {
    if (
      parsed.booleans.has("--yes") ||
      parsed.values["--client-trade-id"] !== undefined ||
      parsed.values["--percent"] !== undefined
    )
      throw new TradingError("VALIDATION_FAILED", "--dry-run refuses --yes, --client-trade-id and --percent.")
    if (parsed.positionals.length !== 2 || !parsed.values["--amount"]) {
      writeUsageFailure(ctx.deps, "Usage: candle swap <from> <to> --amount <n> [--wallet <w>] --dry-run", ctx.json)
      return 2
    }
    const slippage = Number(parsed.values["--slippage-bps"] ?? "50")
    if (!Number.isInteger(slippage) || slippage < 0 || slippage > 5000) {
      writeUsageFailure(ctx.deps, "Slippage must be an integer from 0 to 5000 bps.", ctx.json)
      return 2
    }
    const from = classifyAsset(parsed.positionals[0] as string)
    const to = classifyAsset(parsed.positionals[1] as string)
    if (from.chain !== "solana" || to.chain !== "solana")
      throw new TradingError(
        "VALIDATION_FAILED",
        "Dry run checks Solana TEE pairs; Hood and bridge pairs are unsupported.",
      )
    if (parsed.values["--to"] !== undefined || parsed.booleans.has("--wait")) {
      writeUsageFailure(
        ctx.deps,
        "--to selects a bridge destination; --wait follows a bridge or a Hood TEE swap without --dry-run. Follow a Hood swap with candle swap status --operation <id>, or a job with candle swap status <client-trade-id>.",
        ctx.json,
      )
      return 2
    }
    if (from.asset === to.asset || (!from.base && !to.base))
      throw new TradingError("PAIR_UNSUPPORTED", "Choose distinct assets with SOL, USDC or CNDL on one side.")
    rawAmount(parsed.values["--amount"], 18)
    const key = await tradingKey(ctx)
    const listing = await diagnosticListing(ctx, key)
    let row: TradingWalletRow | undefined
    let payable: unknown
    try {
      const selected = await selectTradingPayer(ctx, key, parsed.values["--wallet"], listing)
      if (selected.kind === "embedded") throw new TradingError("VALIDATION_FAILED", "dry run checks TEE payers")
      row = selected.row
    } catch (error) {
      if (error instanceof TradingError && error.code === "VALIDATION_FAILED") throw error
      if (!(error instanceof TradingError)) throw error
      payable = error
    }
    const records = await readWalletRecords(ctx, key)
    const { report, wallet } = await inspectReport(ctx, key, row, listing, records, payable, parsed.values["--wallet"])
    if (wallet)
      await buildCheck(
        ctx,
        key,
        wallet,
        report,
        from.asset,
        to.asset,
        parsed.values["--amount"],
        slippage,
        parsed.values["--rpc-url"],
        false,
      )
    else
      report.checks.push(
        skipped("quote", report.checks.find((check) => check.status === "fail")?.id ?? "signer"),
        skipped("spend", "quote"),
      )
    return printWalletReports(ctx, [report], true)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
