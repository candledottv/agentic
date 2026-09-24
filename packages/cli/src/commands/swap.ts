import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { createSolanaRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  BASES,
  baseAsset,
  claimOperation,
  confirmQuote,
  decimalAmount,
  type JobKind,
  type Json,
  jobPath,
  type OperationKind,
  operationSchema,
  rawAmount,
  relaySign,
  request,
  rpc,
  rpcUrl,
  safeText,
  savedOperation,
  solanaAsset,
  swapBuildSchema,
  TradingError,
  tradingKey,
  tradingPayer,
} from "../trading"

export function tradingFailure(ctx: CommandContext, error: unknown, id?: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: error instanceof TradingError ? error.code : "TRADING_FAILED",
      message: `${error instanceof Error ? error.message : "Trading failed."}${id ? ` Operation ${id}; use candle swap status ${id} before another attempt.` : ""}`,
    },
    ctx.json,
  )
  return 1
}
export function printTradingResult(ctx: CommandContext, result: Json): number {
  ctx.deps.stdout.write(ctx.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  return 0
}
export function validClientId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
}

export async function lookupOperation(
  ctx: CommandContext,
  key: string,
  id: string,
  kind?: JobKind,
): Promise<(Json & { job: { status: string } }) | null> {
  const local = await savedOperation(ctx, key, id)
  const kinds: JobKind[] = kind ? [kind] : local && local.kind !== "lp" ? [local.kind] : ["trade", "swap", "launch"]
  const found: (Json & { job: { status: string } })[] = []
  for (const candidate of kinds) {
    try {
      found.push({
        ...operationSchema.parse(await request(ctx, key, jobPath(candidate, id))),
        kind: candidate,
        clientTradeId: id,
      })
    } catch (error) {
      if (!(error instanceof TradingError && error.code === "JOB_NOT_FOUND")) throw error
    }
  }
  if (found.length > 1)
    throw new TradingError(
      "AMBIGUOUS_OPERATION",
      "This id exists on multiple rails; specify --kind trade, swap or launch.",
    )
  return found[0] ? { ...found[0], ...(local?.signature ? { signature: local.signature } : {}) } : null
}
export async function swapStatus(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--kind"] })
  if (
    "error" in parsed ||
    parsed.positionals.length !== 1 ||
    !validClientId(parsed.positionals[0] ?? "") ||
    (parsed.values["--kind"] !== undefined && !["trade", "swap", "launch"].includes(parsed.values["--kind"]))
  ) {
    writeUsageFailure(ctx.deps, "Usage: candle swap status <id> [--kind trade|swap|launch]", ctx.json)
    return 2
  }
  try {
    const key = await tradingKey(ctx)
    const id = parsed.positionals[0] as string
    const result = await lookupOperation(ctx, key, id, parsed.values["--kind"] as JobKind | undefined)
    if (!result)
      throw new TradingError(
        "JOB_NOT_FOUND",
        "No operation found on the selected rail(s). This command does not resend a write.",
      )
    return printTradingResult(ctx, result)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
export async function decimalsFor(ctx: CommandContext, asset: string, url?: string): Promise<number> {
  if (BASES[asset]) return BASES[asset].decimals
  const result = await rpc(ctx, rpcUrl(ctx, url), "getTokenSupply", [asset, { commitment: "confirmed" }])
  const decimals = (result.value as { decimals?: number } | undefined)?.decimals
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new TradingError("INVALID_RESPONSE", "RPC returned invalid mint decimals.")
  return decimals
}
/**
 * Prove, BEFORE anything is built, that this deployment can defer an embedded-wallet trade.
 *
 * The one failure this cannot recover from is an API that predates `deferExecution`: it ignores
 * the flag and executes inline, so by the time the response arrives the money has moved and the
 * confirmation prompt would be printing a receipt. Alpha runs behind staging by design, so this is
 * a real deployment to be pointed at, not a hypothetical one.
 *
 * Probing with THIS trade's own id is free and writes nothing. The prior-operation lookup has just
 * established that no row exists for it, so a deployment that has the route can only answer
 * JOB_NOT_FOUND, and one that does not answers without a Candle error code at all.
 */
async function assertDeferredExecuteSupported(ctx: CommandContext, key: string, id: string): Promise<void> {
  try {
    await request(ctx, key, "/api/v1/trade/agent/execute", { clientTradeId: id })
  } catch (error) {
    if (error instanceof TradingError && error.code === "JOB_NOT_FOUND") return
    throw new TradingError(
      "EMBEDDED_PAYER_UNSUPPORTED",
      "This Candle deployment cannot hold an embedded-wallet trade back for confirmation, so the quote could not be shown before the money moved. Nothing was built. Name a TEE wallet with --wallet, or point at a deployment that has it.",
    )
  }
  // Unreachable against a correct server: there is no row for this id yet, so a 200 means the
  // route did something other than look one up, and nothing further should be built on it.
  throw new TradingError("INVALID_RESPONSE", "The execute route answered for a trade that does not exist.")
}

export async function swap(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--percent", "--wallet", "--client-trade-id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `swap-${randomUUID()}`
  const slippage = Number(flags["--slippage-bps"] ?? "50")
  if (
    parsed.positionals.length !== 2 ||
    Boolean(flags["--amount"]) === Boolean(flags["--percent"]) ||
    !validClientId(id) ||
    !Number.isInteger(slippage) ||
    slippage < 0 ||
    slippage > 10000
  ) {
    writeUsageFailure(
      ctx.deps,
      // --wallet is optional since BE-249: an account with exactly one payer does not have to name
      // it, and the payer may now be the embedded wallet as well as a TEE one.
      "Usage: candle swap <from> <to> --amount <decimal> | --percent <n> [--wallet <tee-or-embedded>] [--client-trade-id <id>] [--slippage-bps 50] [--rpc-url <url>] [--yes]",
      ctx.json,
    )
    return 2
  }
  try {
    const from = solanaAsset(parsed.positionals[0] as string)
    const to = solanaAsset(parsed.positionals[1] as string)
    if (from === to) throw new TradingError("PAIR_UNSUPPORTED", "Choose two distinct assets.")
    const fromBase = baseAsset(from)
    const toBase = baseAsset(to)
    if (!fromBase && !toBase)
      throw new TradingError(
        "PAIR_UNSUPPORTED",
        "A token trade must have SOL, USDC or CNDL on one side; token-to-token routing is unavailable.",
      )
    // Validate syntax before network access. Mint precision is checked after its RPC read.
    if (flags["--amount"]) rawAmount(flags["--amount"], 18)
    const percent = flags["--percent"] ? BigInt(rawAmount(flags["--percent"], 6)) : undefined
    if (percent !== undefined && percent > 100_000_000n)
      throw new TradingError(
        "INVALID_AMOUNT",
        "Percent must be greater than 0 and at most 100 (up to six decimal places).",
      )
    const kind: OperationKind = fromBase && toBase ? "swap" : "trade"
    const key = await tradingKey(ctx)
    const prior = await lookupOperation(ctx, key, id, kind)
    if (prior) return printTradingResult(ctx, prior)
    const payerWallet = await tradingPayer(ctx, key, flags["--wallet"])
    // BE-249's one scope boundary, stated where it bites. A base-asset pair (SOL/USDC/CNDL both
    // sides) is `kind: "swap"`, which goes to /agent/swap/build -- a route that refuses a main
    // payer outright, because the embedded rail's base-pair path is the one-shot POST /agent/swap,
    // and that executes inside the request with no quote handed back. The deferred build/execute
    // shape this command now uses exists on the TOKEN rail only. Refusing plainly is the honest
    // answer: routing to the one-shot would turn the confirmation prompt below into a prompt about
    // a trade that already happened, which is exactly the trap this card was opened to close.
    if (payerWallet.kind === "embedded" && kind === "swap")
      throw new TradingError(
        "PAIR_UNSUPPORTED",
        "The embedded wallet cannot swap between base assets from this command yet: that rail executes in one call, so there would be nothing to confirm. Trade a token with it, or name a TEE wallet for a base pair.",
      )
    const wallet = payerWallet.kind === "tee" ? payerWallet.wallet : { address: payerWallet.address }
    const decimals = await decimalsFor(ctx, from, flags["--rpc-url"])
    const outDecimals = await decimalsFor(ctx, to, flags["--rpc-url"])
    let amountRaw: string
    if (percent !== undefined) {
      const reader = createSolanaRpc(rpcUrl(ctx, flags["--rpc-url"]), ctx.deps.fetch)
      let balance: bigint
      if (from === "SOL") balance = await reader.getBalance(wallet.address)
      else {
        const mint = BASES[from]?.mint ?? from
        const accounts = (
          await Promise.all([
            reader.getTokenAccountsByOwner(wallet.address, TOKEN_PROGRAM_ID),
            reader.getTokenAccountsByOwner(wallet.address, TOKEN_2022_PROGRAM_ID),
          ])
        ).flat()
        balance = accounts
          .filter((account) => account.mint === mint)
          .reduce((sum, account) => sum + BigInt(account.amountRaw), 0n)
      }
      amountRaw = ((balance * percent) / 100_000_000n).toString()
      if (amountRaw === "0")
        throw new TradingError("INVALID_AMOUNT", "The selected percentage rounds to zero raw units.")
    } else amountRaw = rawAmount(flags["--amount"] as string, decimals)
    if (BigInt(amountRaw) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TradingError("INVALID_AMOUNT", "Amount exceeds the venue's exact integer range.")
    if (payerWallet.kind === "embedded") await assertDeferredExecuteSupported(ctx, key, id)
    if (!(await claimOperation(ctx, key, id, kind)))
      throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
    ctx.deps.stderr.write(`Operation: ${id}\n`)
    const payer =
      payerWallet.kind === "tee" ? { type: "linked", linkedWalletId: payerWallet.wallet.id } : { type: "main" }
    const built =
      kind === "swap"
        ? await request(ctx, key, "/api/v1/agent/swap/build", {
            clientTradeId: id,
            from,
            to,
            amountRaw,
            maxSlippageBps: slippage,
            payer,
          })
        : await request(ctx, key, "/api/v1/trade/agent/build", {
            clientTradeId: id,
            chain: "solana",
            mint: fromBase ? to : from,
            side: fromBase ? "buy" : "sell",
            quoteAsset: (fromBase ?? toBase)?.toLowerCase(),
            amountRaw,
            maxSlippageBps: slippage,
            payer,
            // BE-249. An embedded payer's /build executes inline unless it is asked not to, so
            // sending this is what keeps the prompt below a real dry run rather than a receipt.
            // Sent only for the embedded payer: a TEE payer's build never executed anyway, and
            // the route refuses the flag alongside a linked payer.
            ...(payerWallet.kind === "embedded" ? { deferExecution: true } : {}),
          })
    if (built.job || built.status === "executed") return printTradingResult(ctx, { ...built, clientTradeId: id, kind })
    const data = swapBuildSchema.parse(kind === "swap" ? built.payload : built)
    if (kind === "swap" && (data.venue !== "jupiter" || data.recipient !== wallet.address))
      throw new TradingError("INVALID_RESPONSE", "A TEE base swap must use Jupiter and return to its payer.")
    if (kind === "trade" && (built.chain !== "solana" || built.walletAddress !== wallet.address))
      throw new TradingError("INVALID_RESPONSE", "The token build does not name the requested Solana payer.")
    const artifacts =
      kind === "swap"
        ? { ...data, transactionBase64: undefined, quoteSource: undefined, quoteAsset: undefined }
        : data.artifacts
    if (!artifacts) throw new TradingError("INVALID_RESPONSE", "Missing quote artifacts.")
    if (kind === "trade" && artifacts.quoteAsset !== (fromBase ?? toBase)?.toLowerCase())
      throw new TradingError(
        "PAIR_UNSUPPORTED",
        `This token settles in ${artifacts.quoteAsset ?? "an unknown asset"}, not the requested pair. Nothing was signed.`,
      )
    if (
      data?.status !== "built" ||
      typeof data.minOutRaw !== "string" ||
      !/^\d+$/.test(data.minOutRaw) ||
      !data.fee ||
      !Number.isFinite(data.fee.bps)
    )
      throw new TradingError("INVALID_RESPONSE", "Candle did not return a complete quote; nothing was signed.")
    // Curve sells append the tier fee to the same transaction after the swap. Its on-chain
    // minOut is gross; display what remains for the payer after that separate fee transfer.
    const minimumRaw =
      !fromBase && artifacts.venue === "curve"
        ? (BigInt(data.minOutRaw) > BigInt(data.fee.feeRaw)
            ? BigInt(data.minOutRaw) - BigInt(data.fee.feeRaw)
            : 0n
          ).toString()
        : data.minOutRaw
    const quote = {
      intent: `Swap ${decimalAmount(amountRaw, decimals)} ${from} to ${to}`,
      wallet: wallet.address,
      venue: artifacts.quoteSource ?? artifacts.venue,
      priceImpactPct: artifacts.priceImpactPct ?? null,
      fee: data.fee,
      minimumReceived: `${decimalAmount(minimumRaw, outDecimals)} ${to}`,
      minOutRaw: data.minOutRaw,
      minimumReceivedRaw: minimumRaw,
      tokenRisks: artifacts.tokenRisks ?? [],
    }
    if (!(await confirmQuote(ctx, quote, parsed.booleans.has("--yes"))))
      return printTradingResult(ctx, { success: true, status: "cancelled", clientTradeId: id, kind, quote })
    // Checked for both payers, and before either second call. The server enforces the same window
    // (QUOTE_EXPIRED from /execute, the sign relay's own claim expiry for a TEE wallet); this is
    // the local half, which costs nothing and answers before a round trip.
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The quote expired before signing. Start a new intention with a new id.")
    // BE-249: the embedded payer's second call. Candle already holds this wallet's delegation, so
    // there is nothing for this machine to sign and nothing to hand back -- /execute takes the id
    // and signs the plan the build kept. That asymmetry is the whole reason the build above had to
    // ask to defer: without it, this line would be printing a receipt for a trade the QUOTE call
    // had already made.
    if (payerWallet.kind === "embedded") {
      const executed = await request(ctx, key, "/api/v1/trade/agent/execute", { clientTradeId: id })
      return printTradingResult(ctx, {
        ...executed,
        clientTradeId: id,
        kind,
        quote,
        wallet: safeText(payerWallet.address),
      })
    }
    const transaction = kind === "swap" ? data.transactionsBase64?.[0] : artifacts.transactionBase64
    if (kind === "swap" && data.transactionsBase64?.length !== 1)
      throw new TradingError("INVALID_RESPONSE", "A TEE swap must contain exactly one same-chain transaction.")
    if (!transaction) throw new TradingError("INVALID_RESPONSE", "Missing transaction.")
    const signed = await relaySign(ctx, key, payerWallet.wallet, transaction)
    const result =
      kind === "swap"
        ? await request(ctx, key, "/api/v1/agent/swap/submit", {
            clientTradeId: id,
            swapId: data.swapId,
            signedTransactionsBase64: [signed],
          })
        : await request(ctx, key, "/api/v1/trade/agent/submit", { clientTradeId: id, signedTransactions: [signed] })
    return printTradingResult(ctx, { ...result, clientTradeId: id, kind, quote, wallet: safeText(wallet.address) })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}
