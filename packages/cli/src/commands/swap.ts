import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import {
  createEvmRpc,
  EVM_RPC_URL_ENV,
  type EvmRpc,
  formatUnits,
  HOOD_USDG_ADDRESS,
  resolveEvmRpcUrl,
  rpcHostOf,
  toChecksumAddress,
} from "../evm-lite"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { describeRpcFailure, type SolanaClient } from "../solana-endpoint"
import { isRateLimited, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  BASES,
  baseAsset,
  chainMismatch,
  claimOperation,
  classifyAsset,
  confirmQuote,
  decimalAmount,
  HOOD_BASES,
  type JobKind,
  type Json,
  jobPath,
  type LandedLeg,
  type OperationKind,
  operationSchema,
  pairChain,
  plannedLegKinds,
  type QuoteDisplay,
  rawAmount,
  relaySign,
  request,
  runSequencedLegs,
  type SequencedBody,
  safeText,
  savedOperation,
  sequencedSchema,
  swapBuildSchema,
  sweepReserveFloor,
  type TradeAsset,
  TradingError,
  TradingUsage,
  type TradingWallet,
  tradingKey,
  tradingPayer,
  tradingRateLimited,
  tradingSolanaClient,
  walletNameChain,
} from "../trading"

/**
 * One failure envelope for every trading command. Exit 1, except the one uncertain outcome
 * (BE-355, D4): a `TradingError` that carries exit 3, a rate limit after a signature. A
 * `TradingUsage` (an endpoint that fails validation) is the `USAGE` envelope, exit 2.
 */
export function tradingFailure(ctx: CommandContext, error: unknown, id?: string): number {
  if (error instanceof TradingUsage) {
    writeUsageFailure(ctx.deps, error.message, ctx.json)
    return 2
  }
  writeLocalFailure(
    ctx.deps,
    {
      code: error instanceof TradingError ? error.code : "TRADING_FAILED",
      // BE-355 (invariant 1): a connect failure's message may carry the endpoint URL; strip it.
      message: `${error instanceof Error ? describeRpcFailure(error) : "Trading failed."}${id ? ` Operation ${id}; use candle swap status ${id} before another attempt.` : ""}`,
      ...(error instanceof TradingError && error.suggestion ? { suggestion: error.suggestion } : {}),
      // Phase 4b (D4): a sequenced failure's operation id, landed legs, and an uncertain leg's hash.
      ...(error instanceof TradingError && error.details ? { details: error.details } : {}),
    },
    ctx.json,
  )
  return error instanceof TradingError ? error.exitCode : 1
}

/**
 * The Solana client a trading command resolves only when a read actually needs one (BE-355): a
 * base-asset swap makes no RPC request, so an endpoint that fails validation must not refuse it.
 * Resolved once; every later call returns the same client, so the host line prints once.
 */
export function lazySolanaClient(ctx: CommandContext, flag: string | undefined): () => Promise<SolanaClient> {
  let pending: Promise<SolanaClient> | undefined
  return () => {
    pending ??= tradingSolanaClient(ctx, flag)
    return pending
  }
}

/**
 * One read before any signature: a rate limit that survived the client's retry is D3's
 * `RPC_RATE_LIMITED`, exit 1, nothing signed or sent. The client disclosed the host on the request.
 */
export async function tradingRead<T>(ctx: CommandContext, client: SolanaClient, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (isRateLimited(error)) throw tradingRateLimited(ctx, client.endpoint.host, error)
    throw error
  }
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
export async function decimalsFor(
  ctx: CommandContext,
  asset: string,
  client: () => Promise<SolanaClient>,
): Promise<number> {
  if (BASES[asset]) return BASES[asset].decimals
  const reader = await client()
  let result: { decimals?: unknown }
  try {
    result = await tradingRead(ctx, reader, () => reader.rpc.getTokenSupply(asset))
  } catch (error) {
    if (error instanceof TradingError) throw error
    throw new TradingError("RPC_FAILED", "Solana getTokenSupply failed; no automatic re-send was made.")
  }
  const decimals = result.decimals
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
      "Usage: candle swap <from> <to> --amount <decimal> | --percent <n> [--wallet <tee-or-embedded>] [--client-trade-id <id>] [--slippage-bps 50] [--rpc-url <url>] [--yes]. Solana: SOL, USDC, CNDL or a mint. Hood: ETH, USDG or a 0x token.",
      ctx.json,
    )
    return 2
  }
  try {
    // Phase 4b (D6): the assets decide the chain, and both sides must agree, before any request.
    const fromAsset = classifyAsset(parsed.positionals[0] as string)
    const toAsset = classifyAsset(parsed.positionals[1] as string)
    const chain = pairChain(fromAsset, toAsset)
    const walletFlag = flags["--wallet"]
    const named = walletFlag === undefined ? undefined : walletNameChain(walletFlag)
    if (named !== undefined && named !== chain) throw chainMismatch(`--wallet ${safeText(walletFlag)}`, named, chain)
    if (chain === "hood")
      return await hoodSwap(ctx, {
        flags,
        yes: parsed.booleans.has("--yes"),
        id,
        slippage,
        from: fromAsset,
        to: toAsset,
      })
    const from = fromAsset.asset
    const to = toAsset.asset
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
    const solana = lazySolanaClient(ctx, flags["--rpc-url"])
    const decimals = await decimalsFor(ctx, from, solana)
    const outDecimals = await decimalsFor(ctx, to, solana)
    let amountRaw: string
    if (percent !== undefined) {
      const reader = await solana()
      let balance: bigint
      if (from === "SOL") balance = await tradingRead(ctx, reader, () => reader.rpc.getBalance(wallet.address))
      else {
        const mint = BASES[from]?.mint ?? from
        const accounts = (
          await tradingRead(ctx, reader, () =>
            Promise.all([
              reader.rpc.getTokenAccountsByOwner(wallet.address, TOKEN_PROGRAM_ID),
              reader.rpc.getTokenAccountsByOwner(wallet.address, TOKEN_2022_PROGRAM_ID),
            ]),
          )
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

// ── Phase 4b-1: Hood (D6) ─────────────────────────────────────────────────────────────────────

/**
 * The EVM endpoint a Hood swap READS over, resolved only when a read needs one: a token's
 * `decimals()` and, for `--percent`, the payer's balance. Trading itself never touches it: the
 * server sets every nonce and fee, broadcasts, and reads every receipt (D6). The host is printed
 * once, on first use, never the URL.
 */
function lazyEvmRpc(ctx: CommandContext, flag: string | undefined): () => EvmRpc {
  let rpc: EvmRpc | undefined
  return () => {
    if (rpc) return rpc
    const resolved = resolveEvmRpcUrl(flag, ctx.deps.env[EVM_RPC_URL_ENV], "--rpc-url")
    if ("error" in resolved) throw new TradingUsage(resolved.error)
    ctx.deps.stderr.write(`Reading from ${rpcHostOf(resolved.url)} (Hood RPC; reads only, nothing is sent there)\n`)
    rpc = createEvmRpc(resolved.url, ctx.deps.fetch)
    return rpc
  }
}

async function evmRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof TradingError || error instanceof TradingUsage) throw error
    throw new TradingError("RPC_FAILED", `Reading ${what} over the Hood RPC failed; nothing was built or signed.`)
  }
}

async function hoodDecimals(asset: TradeAsset, rpc: () => EvmRpc): Promise<number> {
  const base = asset.base ? HOOD_BASES[asset.base] : undefined
  if (base) return base.decimals
  const decimals = await evmRead(`${asset.asset} decimals()`, () => rpc().erc20Decimals(asset.asset))
  if (decimals > 36) throw new TradingError("INVALID_RESPONSE", "The token's decimals() is out of range.")
  return decimals
}

/**
 * Append one `token` line to the sealed EVM record for a leg that landed (D1). Never fails the
 * leg: any append that cannot run is a notice on stderr, and the leg's success stands.
 */
async function recordTradedToken(ctx: CommandContext, wallet: string, token: string): Promise<string | undefined> {
  const skipped = (reason: string) =>
    `Notice: the sealed EVM record was not updated for ${token} (${reason}). The leg landed. A later sweep still finds this token with --token ${token}, or with --from-block.`
  const append = ctx.deps.appendEvmRecord
  let notice: string | undefined
  if (!append) notice = skipped("this CLI build has no sealed EVM record writer")
  else {
    try {
      const outcome = await append(ctx, { kind: "token", wallet: toChecksumAddress(wallet), token })
      notice = outcome.appended ? outcome.notice : skipped(outcome.notice)
    } catch (error) {
      notice = skipped(error instanceof Error ? error.message : "the append failed")
    }
  }
  if (notice) ctx.deps.stderr.write(`${safeText(notice)}\n`)
  return notice
}

function describeHoodLegs(first: SequencedBody, hasFee: boolean): string[] {
  const kinds = plannedLegKinds(first.legKind, first.plannedLegCount, hasFee)
  const names: Record<string, string> = {
    approval: "approve",
    permit2Approval: "Permit2 approve",
    trade: "trade",
    feeTransfer: "fee",
  }
  return kinds
    ? kinds.map((kind) => names[kind] ?? kind)
    : [`${first.plannedLegCount} legs, starting with ${names[first.legKind] ?? first.legKind}`]
}

/**
 * `candle swap` on Hood (D6): ETH <-> USDG on the base rail, or a token against ETH or USDG on the
 * trade rail. A Hood TEE wallet trades only through the sequenced rail (D4); the embedded Hood
 * wallet trades tokens through the deferred build and `/execute`, as it does on Solana.
 */
async function hoodSwap(
  ctx: CommandContext,
  args: {
    flags: Record<string, string>
    yes: boolean
    id: string
    slippage: number
    from: TradeAsset
    to: TradeAsset
  },
): Promise<number> {
  const { flags, id, from, to } = args
  if (from.asset === to.asset) throw new TradingError("PAIR_UNSUPPORTED", "Choose two distinct assets.")
  if (!from.base && !to.base)
    throw new TradingError(
      "PAIR_UNSUPPORTED",
      "A Hood token trade must have ETH or USDG on one side; token-to-token routing is unavailable.",
    )
  if (flags["--amount"]) rawAmount(flags["--amount"], 18)
  const percent = flags["--percent"] ? BigInt(rawAmount(flags["--percent"], 6)) : undefined
  if (percent !== undefined && percent > 100_000_000n)
    throw new TradingError(
      "INVALID_AMOUNT",
      "Percent must be greater than 0 and at most 100 (up to six decimal places).",
    )
  const kind: OperationKind = from.base && to.base ? "swap" : "trade"
  const key = await tradingKey(ctx)
  const prior = await lookupOperation(ctx, key, id, kind)
  if (prior) return printTradingResult(ctx, prior)
  const payer = await tradingPayer(ctx, key, flags["--wallet"], "swap:write", "hood")
  if (payer.kind === "embedded" && kind === "swap")
    throw new TradingError(
      "PAIR_UNSUPPORTED",
      "The embedded wallet cannot swap ETH and USDG from this command: that rail executes in one call, so there would be nothing to confirm. Trade a token with it, or name a Hood TEE wallet.",
    )
  const payerAddress = payer.kind === "tee" ? payer.wallet.address : payer.address
  const rpc = lazyEvmRpc(ctx, flags["--rpc-url"])
  const decimals = await hoodDecimals(from, rpc)
  const outDecimals = await hoodDecimals(to, rpc)
  let amountRaw: string
  if (percent !== undefined) {
    const balance =
      from.asset === "ETH"
        ? await evmRead("the ETH balance", () => rpc().getBalance(payerAddress))
        : await evmRead(`the ${from.asset} balance`, () =>
            rpc().erc20BalanceOf(from.asset === "USDG" ? HOOD_USDG_ADDRESS : from.asset, payerAddress),
          )
    amountRaw = ((balance * percent) / 100_000_000n).toString()
    if (amountRaw === "0") throw new TradingError("INVALID_AMOUNT", "The selected percentage rounds to zero raw units.")
  } else amountRaw = rawAmount(flags["--amount"] as string, decimals)
  if (payer.kind === "embedded") await assertDeferredExecuteSupported(ctx, key, id)
  if (!(await claimOperation(ctx, key, id, kind)))
    throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const payerBody = payer.kind === "tee" ? { type: "linked", linkedWalletId: payer.wallet.id } : { type: "main" }
  const base = (from.base ?? to.base) as string
  const token = from.base ? to.asset : from.asset
  const built =
    kind === "swap"
      ? await request(ctx, key, "/api/v1/agent/swap/build", {
          clientTradeId: id,
          from: from.asset,
          to: to.asset,
          amountRaw,
          maxSlippageBps: args.slippage,
          payer: payerBody,
        })
      : await request(ctx, key, "/api/v1/trade/agent/build", {
          clientTradeId: id,
          chain: "hood",
          mint: token,
          side: from.base ? "buy" : "sell",
          quoteAsset: base.toLowerCase(),
          amountRaw,
          maxSlippageBps: args.slippage,
          payer: payerBody,
          ...(payer.kind === "embedded" ? { deferExecution: true } : {}),
        })
  if (built.job || built.status === "executed") return printTradingResult(ctx, { ...built, clientTradeId: id, kind })
  const body = (kind === "swap" ? built.payload : built) as Json | undefined
  const data = swapBuildSchema.parse(body)
  const echoed = kind === "swap" ? body?.recipient : body?.walletAddress
  if (body?.chain !== "hood" || typeof echoed !== "string" || echoed.toLowerCase() !== payerAddress.toLowerCase())
    throw new TradingError("INVALID_RESPONSE", "The Hood build does not name the requested payer; nothing was signed.")
  const artifacts = kind === "swap" ? { ...data, quoteAsset: undefined, quoteSource: undefined } : data.artifacts
  if (!artifacts) throw new TradingError("INVALID_RESPONSE", "Missing quote artifacts.")
  if (kind === "trade" && artifacts.quoteAsset !== base.toLowerCase())
    throw new TradingError(
      "PAIR_UNSUPPORTED",
      `This token settles in ${artifacts.quoteAsset ?? "an unknown asset"}, not ${base}. Nothing was signed.`,
    )
  // D4: a Hood TEE wallet signs one leg at a time. A deployment that answers with every leg at
  // once predates the sequenced rail, and its legs are never signed from this wallet.
  let sequenced: SequencedBody | undefined
  if (payer.kind === "tee") {
    const parsed = sequencedSchema.safeParse(body)
    if (!parsed.success)
      throw new TradingError(
        "SEQUENCED_RAIL_REQUIRED",
        "A Hood TEE wallet trades one leg at a time, and this Candle deployment did not answer with a sequenced leg. Nothing was signed.",
      )
    sequenced = parsed.data
  }
  const minimumRaw =
    !from.base && artifacts.venue === "curve"
      ? (BigInt(data.minOutRaw) > BigInt(data.fee.feeRaw)
          ? BigInt(data.minOutRaw) - BigInt(data.fee.feeRaw)
          : 0n
        ).toString()
      : data.minOutRaw
  const quote: QuoteDisplay & Json = {
    intent: `Swap ${decimalAmount(amountRaw, decimals)} ${from.asset} to ${to.asset} on Hood`,
    wallet: payerAddress,
    venue: artifacts.quoteSource ?? artifacts.venue,
    priceImpactPct: artifacts.priceImpactPct ?? null,
    fee: data.fee,
    minimumReceived: `${decimalAmount(minimumRaw, outDecimals)} ${to.asset}`,
    minOutRaw: data.minOutRaw,
    minimumReceivedRaw: minimumRaw,
    tokenRisks: artifacts.tokenRisks ?? [],
  }
  if (sequenced) {
    const leg = sequenced.nextLeg
    const maxFee = BigInt(leg.maxFeePerGas)
    const reserve = sweepReserveFloor(maxFee, kind === "trade" ? [token] : [])
    quote.legs = describeHoodLegs(sequenced, BigInt(data.fee.feeRaw) > 0n)
    quote.gas = `the ${sequenced.legKind} leg up to ${formatUnits(BigInt(leg.gas) * maxFee, 18)} ETH (gas ${leg.gas} at ${formatUnits(maxFee, 9)} gwei); each later leg is priced by Candle when it becomes next`
    quote.reserve = `at least ${formatUnits(reserve.wei, 18)} ETH stays in the wallet for a sweep home (${reserve.erc20Transfers} ERC-20 transfers and the final ETH transfer at twice the fee); a trade never spends it`
    quote.operationId = sequenced.operationId
  }
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    // The build already holds the wallet (D4, one operation per wallet), and nothing releases an
    // operation that never sent a leg: the next Hood build for it is WALLET_BUSY until the window closes.
    if (sequenced)
      ctx.deps.stderr.write(
        `Nothing was signed. Operation ${sequenced.operationId} holds this wallet until ${new Date(sequenced.expiresAt).toISOString()}; a new Hood trade from it is refused as WALLET_BUSY until then.\n`,
      )
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind,
      quote,
      ...(sequenced ? { operationId: sequenced.operationId, walletHeldUntil: sequenced.expiresAt } : {}),
    })
  }
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= ctx.deps.now())
    throw new TradingError("QUOTE_EXPIRED", "The quote expired before signing. Start a new intention with a new id.")
  if (payer.kind === "embedded") {
    const executed = await request(ctx, key, "/api/v1/trade/agent/execute", { clientTradeId: id })
    return printTradingResult(ctx, { ...executed, clientTradeId: id, kind, quote, wallet: safeText(payerAddress) })
  }
  const wallet = payer.wallet as TradingWallet
  if (wallet.chain !== "evm" || !sequenced)
    throw chainMismatch(`TEE wallet ${wallet.id}`, wallet.chain === "evm" ? "hood" : "solana", "hood")
  const recorded = kind === "trade" ? token : HOOD_USDG_ADDRESS
  const notices: string[] = []
  const run = await runSequencedLegs(ctx, key, {
    wallet,
    first: sequenced,
    submitPath: kind === "swap" ? "/api/v1/agent/swap/submit" : "/api/v1/trade/agent/submit",
    submitFields: kind === "swap" ? { clientTradeId: id, swapId: data.swapId } : { clientTradeId: id },
    unwrap: (answer) => (kind === "swap" ? ((answer.payload ?? {}) as Json) : answer),
    clientId: id,
    kind,
    onLanded: async (_leg: LandedLeg) => {
      const notice = await recordTradedToken(ctx, wallet.address, toChecksumAddress(recorded))
      if (notice) notices.push(notice)
    },
  })
  return printTradingResult(ctx, {
    ...run.final,
    clientTradeId: id,
    kind,
    chain: "hood",
    quote,
    wallet: safeText(wallet.address),
    operationId: sequenced.operationId,
    landedLegs: run.landed,
    evmRecord: { token: toChecksumAddress(recorded), notices },
  })
}
