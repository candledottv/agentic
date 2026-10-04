import { randomUUID } from "node:crypto"
import { z } from "zod"
import { parseArgs } from "../args"
import {
  BRIDGE_ASSETS,
  BRIDGE_WAIT_MS,
  BRIDGE_WAIT_POLL_MS,
  type BridgeAsset,
  type BridgeFacts,
  bridgeLegKinds,
  bridgePair,
  bridgePlanAdmitted,
  bridgeStatusFinal,
  describeBridgeJob,
  relayHoodLegProblem,
  relaySolanaDepositProblem,
} from "../bridge"
import type { CommandContext } from "../deps"
import {
  createEvmRpc,
  EVM_RPC_URL_ENV,
  type EvmRpc,
  formatUnits,
  HOOD_USDG_ADDRESS,
  resolveEvmRpcUrl,
  rpcHostOf,
  sameEvmAddress,
  toChecksumAddress,
} from "../evm-lite"
import { apiKeyPrefix } from "../profiles"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { describeRpcFailure, type SolanaClient } from "../solana-endpoint"
import { isRateLimited, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  BASES,
  baseAsset,
  chainMismatch,
  chainName,
  claimOperation,
  classifyAsset,
  confirmQuote,
  decimalAmount,
  describeWallet,
  HOOD_BASES,
  type JobKind,
  type Json,
  jobPath,
  type LandedLeg,
  type LegKind,
  listTradingWallets,
  matchesName,
  type OperationKind,
  operationSchema,
  pairChain,
  plannedLegKinds,
  type QuoteDisplay,
  rawAmount,
  relaySign,
  request,
  rowChain,
  runSequencedLegs,
  type SequencedBody,
  safeText,
  savedOperation,
  saveOperationBridge,
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
  if (error instanceof TradingError && error.details)
    describeSwapEvidence(ctx, error.details, error.details.terminal === true)
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
async function requestSwapBuild(ctx: CommandContext, key: string, body: Json): Promise<Json> {
  try {
    return await request(ctx, key, "/api/v1/agent/swap/build", body)
  } catch (error) {
    if (
      (body.payer as Json)?.type === "main" &&
      error instanceof TradingError &&
      error.code === "VALIDATION_FAILED" &&
      error.details?.field === "payer"
    ) {
      throw new TradingError(
        "EMBEDDED_PAYER_UNSUPPORTED",
        "This Candle deployment cannot hold an embedded-wallet swap back for confirmation. Nothing was built. Name a TEE wallet with --wallet, or point at a deployment that supports embedded swap builds.",
      )
    }
    throw error
  }
}

function describeSwapEvidence(ctx: CommandContext, details: Json, terminal: boolean): void {
  if (details.stage === "not_broadcast" && terminal)
    ctx.deps.stderr.write("Nothing was sent. This swap job is terminal; retry with a new id.\n")
  if (details.stage === "unconfirmed") {
    const hashes = Array.isArray(details.hashes)
      ? details.hashes
      : typeof details.signature === "string"
        ? [details.signature]
        : []
    ctx.deps.stderr.write(
      `Swap outcome needs verification${details.leg !== undefined ? ` (leg ${safeText(String(details.leg))})` : ""}. Known hashes: ${hashes.length ? hashes.map((hash) => safeText(String(hash))).join(", ") : "unknown"}. Do not automatically retry or use a new id.\n`,
    )
  }
}

export function printTradingResult(ctx: CommandContext, result: Json): number {
  if (result.kind === "swap" && result.job && typeof result.job === "object") {
    const job = result.job as Json
    describeSwapEvidence(ctx, job, job.status === "failed")
  }
  ctx.deps.stdout.write(ctx.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  return 0
}

/**
 * BE-505 (R8.4): what a base-pair swap settled, as `/agent/swap/submit` reports it (BE-504, R8.1).
 * Only the fields the line below reads are checked; the object itself is passed through as sent.
 */
const settlementSchema = z.object({
  state: z.enum(["settled", "pending", "failed", "uncertain"]),
  settledOutRaw: z.string().regex(/^\d+$/).optional(),
})

/**
 * BE-505 (R8.4): one line on stderr after a base-pair swap's submit, and the `settlement` to pass
 * through in the JSON result. `settled <amount> <asset>` when the server measured the fill;
 * otherwise the state and the job read to re-check it with. An older API sends no `settlement`,
 * which is "not measured", never a zero. The re-check is the job read: `candle swap` always sends a
 * `clientTradeId`, and the one-shot receipt route does not serve a submitted swap.
 */
function reportSettlement(
  ctx: CommandContext,
  settlement: unknown,
  out: { asset: string; decimals: number },
  id: string,
): { settlement?: unknown } {
  const parsed = settlementSchema.safeParse(settlement)
  const reading = parsed.success ? parsed.data : undefined
  if (reading?.state === "settled" && reading.settledOutRaw !== undefined)
    ctx.deps.stderr.write(`settled ${decimalAmount(reading.settledOutRaw, out.decimals)} ${out.asset}\n`)
  else {
    // A settled state with no measured amount is still not a number to print.
    const state = !reading
      ? "not measured"
      : reading.state === "settled"
        ? "settled, amount not measured"
        : reading.state
    ctx.deps.stderr.write(
      `Settlement: ${state}. Re-check with GET /api/v1/agent/swap/jobs/${id} (candle swap status ${id}).\n`,
    )
  }
  return settlement !== null && typeof settlement === "object" ? { settlement } : {}
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
  const parsed = parseArgs(args, { valueFlags: ["--kind"], booleanFlags: ["--wait"] })
  if (
    "error" in parsed ||
    parsed.positionals.length !== 1 ||
    !validClientId(parsed.positionals[0] ?? "") ||
    (parsed.values["--kind"] !== undefined && !["trade", "swap", "launch"].includes(parsed.values["--kind"]))
  ) {
    writeUsageFailure(ctx.deps, "Usage: candle swap status <id> [--kind trade|swap|launch] [--wait]", ctx.json)
    return 2
  }
  try {
    const key = await tradingKey(ctx)
    const id = parsed.positionals[0] as string
    const kind = parsed.values["--kind"] as JobKind | undefined
    const facts = bridgeFactsOf((await savedOperation(ctx, key, id))?.bridge)
    const found = await lookupOperation(ctx, key, id, kind)
    if (!found)
      throw new TradingError(
        "JOB_NOT_FOUND",
        `No operation ${id} is visible to key ${apiKeyPrefix(key) ?? "this key"} on the ${kind ?? "trade, swap, launch"} rail(s). Nothing was resent.`,
        {
          suggestion: `Trade and launch jobs are readable by any key on this account; swap jobs only by the key that placed them. If another key or profile placed it, run: candle swap status ${id} --profile <that profile>`,
        },
      )
    const result = parsed.booleans.has("--wait")
      ? await waitForSettlement(ctx, key, id, found, facts)
      : { ...found, ...bridgeStatusField(ctx, found, facts) }
    return printTradingResult(ctx, result)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── Ember 4c: bridge status and --wait (4c-ED-9, R1) ─────────────────────────────────────────

const bridgeFactsSchema = z.object({
  from: z.enum(["SOL", "USDC", "ETH", "USDG"]),
  to: z.enum(["SOL", "USDC", "ETH", "USDG"]),
  recipient: z.string(),
  statusCheck: z.string().optional(),
})

function bridgeFactsOf(raw: unknown): BridgeFacts | undefined {
  const parsed = bridgeFactsSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** A swap job is a bridge when the server says one is open, or this machine recorded it as one. */
function isBridgeJob(job: Json, facts: BridgeFacts | undefined): boolean {
  return facts !== undefined || (job.bridge !== null && typeof job.bridge === "object")
}

/**
 * `bridgeStatus` for the JSON result, and the same words on stderr: the phase, what arrived, and
 * the open or two-hour state. Only on a bridge; any other operation prints exactly as before.
 */
function bridgeStatusField(ctx: CommandContext, found: Json, facts: BridgeFacts | undefined): Json {
  const job = (found.job ?? {}) as Json
  if (found.kind !== "swap" || !isBridgeJob(job, facts)) return {}
  const status = describeBridgeJob(job, facts)
  for (const line of status.lines) ctx.deps.stderr.write(`${line}\n`)
  const { lines: _lines, ...rest } = status
  return { bridgeStatus: rest }
}

/**
 * Whether `--wait` has nothing more to follow: a bridge at an end state or past its two hours, or
 * any other job whose settlement is not `pending`. A job with no settlement has nothing to follow.
 */
function waitFinished(current: Json, facts: BridgeFacts | undefined, sent: boolean): boolean {
  const job = (current.job ?? {}) as Json
  if (current.kind === "swap" && isBridgeJob(job, facts)) {
    const status = describeBridgeJob(job, facts)
    // Right after this command's own submit, a read that does not show the deposit yet is lag,
    // not a build that was never broadcast.
    if (sent && status.phase === "not_broadcast") return false
    return bridgeStatusFinal(status)
  }
  const settlement = settlementSchema.safeParse(job.settlement)
  return !settlement.success || settlement.data.state !== "pending"
}

/**
 * R1: poll the job read until the settlement ends (settled, failed or uncertain), the bridge
 * passes its two hours, or ten minutes go by. Reads only; nothing is ever resent.
 */
async function waitForSettlement(
  ctx: CommandContext,
  key: string,
  id: string,
  first: Json,
  facts: BridgeFacts | undefined,
  /** This command just submitted the deposit itself. */
  sent = false,
): Promise<Json> {
  const deadline = ctx.deps.now() + BRIDGE_WAIT_MS
  let current = first
  while (!waitFinished(current, facts, sent) && ctx.deps.now() < deadline) {
    await ctx.deps.sleep(BRIDGE_WAIT_POLL_MS)
    current = { ...current, ...operationSchema.parse(await request(ctx, key, jobPath(current.kind as JobKind, id))) }
  }
  const field = bridgeStatusField(ctx, current, facts)
  const finished = waitFinished(current, facts, sent)
  if (!finished)
    ctx.deps.stderr.write(`Still not final after ten minutes. Re-check with candle swap status ${id} --wait.\n`)
  return { ...current, ...field, waited: { final: finished } }
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
    valueFlags: ["--amount", "--percent", "--wallet", "--to", "--client-trade-id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--yes", "--wait"],
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
      "Usage: candle swap <from> <to> --amount <decimal> | --percent <n> [--wallet <tee-or-embedded>] [--to <tee>] [--wait] [--client-trade-id <id>] [--slippage-bps 50] [--rpc-url <url>] [--yes]. Solana: SOL, USDC, CNDL or a mint. Hood: ETH, USDG or a 0x token. SOL or USDC to ETH or USDG, or back, is a bridge between two TEE wallets.",
      ctx.json,
    )
    return 2
  }
  try {
    // Phase 4b (D6): the assets decide the chain, and both sides must agree, before any request.
    const fromAsset = classifyAsset(parsed.positionals[0] as string)
    const toAsset = classifyAsset(parsed.positionals[1] as string)
    // Ember 4c (R1): a base asset on each chain is a bridge. Every other cross-chain pair is still
    // CHAIN_MISMATCH below, and --to and --wait mean nothing on a same-chain swap.
    const bridge = bridgePair(fromAsset, toAsset)
    if (bridge)
      return await bridgeSwap(ctx, {
        flags,
        yes: parsed.booleans.has("--yes"),
        wait: parsed.booleans.has("--wait"),
        id,
        slippage,
        ...bridge,
      })
    if (flags["--to"] !== undefined || parsed.booleans.has("--wait"))
      throw new TradingUsage("--to and --wait are for a bridge: SOL or USDC to ETH or USDG, or back.")
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
    if (payerWallet.kind === "embedded" && kind === "trade") await assertDeferredExecuteSupported(ctx, key, id)
    if (!(await claimOperation(ctx, key, id, kind)))
      throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
    ctx.deps.stderr.write(`Operation: ${id}\n`)
    const payer =
      payerWallet.kind === "tee" ? { type: "linked", linkedWalletId: payerWallet.wallet.id } : { type: "main" }
    const built =
      kind === "swap"
        ? await requestSwapBuild(ctx, key, {
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
      throw new TradingError("INVALID_RESPONSE", "A base swap must use Jupiter and return to its payer.")
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
    // Embedded swaps submit the stored swap plan; embedded token trades keep /execute.
    if (payerWallet.kind === "embedded") {
      const executed =
        kind === "swap"
          ? await request(ctx, key, "/api/v1/agent/swap/submit", { clientTradeId: id, swapId: data.swapId })
          : await request(ctx, key, "/api/v1/trade/agent/execute", { clientTradeId: id })
      const settled =
        kind === "swap"
          ? reportSettlement(
              ctx,
              (executed.payload as Json | undefined)?.settlement,
              { asset: to, decimals: outDecimals },
              id,
            )
          : {}
      return printTradingResult(ctx, {
        ...executed,
        ...settled,
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
    // BE-505 (R8.4): the Solana submit carries `settlement` inside `payload`, beside `hashes`.
    const settled =
      kind === "swap"
        ? reportSettlement(
            ctx,
            (result.payload as Json | undefined)?.settlement,
            { asset: to, decimals: outDecimals },
            id,
          )
        : {}
    return printTradingResult(ctx, {
      ...result,
      clientTradeId: id,
      kind,
      quote,
      wallet: safeText(wallet.address),
      ...settled,
    })
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
export function lazyEvmRpc(ctx: CommandContext, flag: string | undefined): () => EvmRpc {
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

export async function hoodDecimals(asset: TradeAsset, rpc: () => EvmRpc): Promise<number> {
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
export async function recordTradedToken(
  ctx: CommandContext,
  wallet: string,
  token: string,
): Promise<string | undefined> {
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

/** The legs a Hood trade or base swap may sign (D4). A launch's or a transfer's leg kind is refused. */
const HOOD_TRADE_LEGS: readonly LegKind[] = ["approval", "permit2Approval", "trade", "feeTransfer"]

function describeHoodLegs(
  first: SequencedBody,
  hasFee: boolean,
  primary: "trade" | "bridgeDeposit" = "trade",
): string[] {
  const kinds = plannedLegKinds(first.legKind, first.plannedLegCount, hasFee, primary)
  const names: Record<string, string> = {
    approval: "approve",
    permit2Approval: "Permit2 approve",
    trade: "trade",
    feeTransfer: "fee",
    bridgeDeposit: "bridge deposit",
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
  if (payer.kind === "embedded" && kind === "trade") await assertDeferredExecuteSupported(ctx, key, id)
  if (!(await claimOperation(ctx, key, id, kind)))
    throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const payerBody = payer.kind === "tee" ? { type: "linked", linkedWalletId: payer.wallet.id } : { type: "main" }
  const base = (from.base ?? to.base) as string
  const token = from.base ? to.asset : from.asset
  const built =
    kind === "swap"
      ? await requestSwapBuild(ctx, key, {
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
    const executed =
      kind === "swap"
        ? await request(ctx, key, "/api/v1/agent/swap/submit", { clientTradeId: id, swapId: data.swapId })
        : await request(ctx, key, "/api/v1/trade/agent/execute", { clientTradeId: id })
    const settled =
      kind === "swap"
        ? reportSettlement(
            ctx,
            (executed.payload as Json | undefined)?.settlement,
            { asset: to.asset, decimals: outDecimals },
            id,
          )
        : {}
    return printTradingResult(ctx, {
      ...executed,
      ...settled,
      clientTradeId: id,
      kind,
      quote,
      wallet: safeText(payerAddress),
    })
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
    allowedLegs: HOOD_TRADE_LEGS,
    onLanded: async (_leg: LandedLeg) => {
      const notice = await recordTradedToken(ctx, wallet.address, toChecksumAddress(recorded))
      if (notice) notices.push(notice)
    },
  })
  // BE-505 (R8.4): the Hood sequenced `completed` payload carries `settlement` itself.
  const settled =
    kind === "swap" ? reportSettlement(ctx, run.final.settlement, { asset: to.asset, decimals: outDecimals }, id) : {}
  return printTradingResult(ctx, {
    ...run.final,
    ...settled,
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

// ── Ember Phase 4c: the bridge (R1, R4) ──────────────────────────────────────────────────────

/** A bridge build's payload (`POST /agent/swap/build` for a TEE payer on a cross-chain pair). */
const bridgeBuildSchema = z
  .object({
    status: z.literal("built"),
    swapId: z.string().min(1),
    venue: z.string(),
    fee: z.object({ bps: z.number(), feeRaw: z.string() }).passthrough(),
    expectedOutRaw: z.string().regex(/^\d+$/),
    expiresAt: z.number().finite(),
    recipient: z.string().min(1),
    statusChecks: z.array(z.string()).default([]),
    transactionsBase64: z.array(z.string()).optional(),
    walletAddress: z.string().optional(),
    venueCostUsd: z.number().finite().optional(),
    venueTimeEstimateSec: z.number().finite().optional(),
  })
  .passthrough()

/** The payer's spendable balance of a bridge's origin asset, for `--percent`. */
async function bridgeOriginBalance(
  ctx: CommandContext,
  from: BridgeAsset,
  address: string,
  solana: () => Promise<SolanaClient>,
  evm: () => EvmRpc,
): Promise<bigint> {
  if (from === "ETH") return evmRead("the ETH balance", () => evm().getBalance(address))
  if (from === "USDG") return evmRead("the USDG balance", () => evm().erc20BalanceOf(HOOD_USDG_ADDRESS, address))
  const reader = await solana()
  if (from === "SOL") return tradingRead(ctx, reader, () => reader.rpc.getBalance(address))
  const mint = BASES.USDC?.mint
  const accounts = (
    await tradingRead(ctx, reader, () =>
      Promise.all([
        reader.rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID),
        reader.rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID),
      ]),
    )
  ).flat()
  return accounts
    .filter((account) => account.mint === mint)
    .reduce((sum, account) => sum + BigInt(account.amountRaw), 0n)
}

/**
 * `candle swap` across chains (Ember 4c, R1): a TEE wallet on one chain pays, this key's TEE wallet
 * on the other chain receives, and Relay carries it. The server resolves and checks the destination,
 * caps the origin asset and verifies Relay's steps (4c-ED-1, 4c-ED-3, 4c-ED-5); this command checks
 * again before anything is signed (4c-ED-6): the recipient is a TEE wallet this key lists, Candle
 * charges nothing, and every leg or the Solana deposit is exactly the confirmed one.
 */
async function bridgeSwap(
  ctx: CommandContext,
  args: {
    flags: Record<string, string>
    yes: boolean
    wait: boolean
    id: string
    slippage: number
    from: BridgeAsset
    to: BridgeAsset
  },
): Promise<number> {
  const { flags, id, from, to } = args
  const origin = BRIDGE_ASSETS[from].chain
  const destination = BRIDGE_ASSETS[to].chain
  const walletFlag = flags["--wallet"]
  const named = walletFlag === undefined ? undefined : walletNameChain(walletFlag)
  if (named !== undefined && named !== origin) throw chainMismatch(`--wallet ${safeText(walletFlag)}`, named, origin)
  if (flags["--amount"]) rawAmount(flags["--amount"], 18)
  const percent = flags["--percent"] ? BigInt(rawAmount(flags["--percent"], 6)) : undefined
  if (percent !== undefined && percent > 100_000_000n)
    throw new TradingError(
      "INVALID_AMOUNT",
      "Percent must be greater than 0 and at most 100 (up to six decimal places).",
    )
  const key = await tradingKey(ctx)
  const prior = await lookupOperation(ctx, key, id, "swap")
  if (prior)
    return printTradingResult(ctx, {
      ...prior,
      ...bridgeStatusField(ctx, prior, bridgeFactsOf((await savedOperation(ctx, key, id))?.bridge)),
    })
  const payer = await tradingPayer(ctx, key, walletFlag, "swap:write", origin)
  if (payer.kind !== "tee")
    throw new TradingError(
      "CHAIN_MISMATCH",
      `Only a TEE wallet bridges, and the embedded wallet ${safeText(payer.address)} is not one. Name a ${chainName(origin)} TEE wallet with --wallet. Nothing was built.`,
    )
  const wallet = payer.wallet

  // 4c-ED-1: the destination is this key's own TEE wallet on the other chain, and nothing else.
  const { rows } = await listTradingWallets(ctx, key, "swap:write")
  const onDestination = rows.filter((row) => rowChain(row) === destination)
  const toFlag = flags["--to"]
  let toWalletId: string | undefined
  let candidates = onDestination.filter((row) => row.active)
  if (toFlag !== undefined) {
    const matches = rows.filter((row) => matchesName(row, toFlag))
    const match = matches[0]
    if (matches.length > 1)
      throw new TradingError(
        "TEE_WALLET_REQUIRED",
        `"${safeText(toFlag)}" matches ${matches.length} TEE wallets on this key: ${matches.map(describeWallet).join("; ")}. Name one by id or address.`,
      )
    if (!match || rowChain(match) !== destination)
      throw new TradingError(
        "BRIDGE_DESTINATION_MISSING",
        `--to ${safeText(toFlag)} is not a ${chainName(destination)} TEE wallet on this key. A bridge lands only in this key's own TEE wallet on ${chainName(destination)}${onDestination.length > 0 ? `: ${onDestination.map(describeWallet).join("; ")}` : ""}. Nothing was built.`,
      )
    if (!match.active)
      throw new TradingError(
        "TEE_WALLET_INACTIVE",
        `The destination ${describeWallet(match)} is not a verified-active TEE wallet. Nothing was built.`,
      )
    toWalletId = match.id
    candidates = [match]
  } else if (candidates.length !== 1) {
    throw new TradingError(
      "BRIDGE_DESTINATION_MISSING",
      candidates.length === 0
        ? `This key has no active ${chainName(destination)} TEE wallet to bridge into. Promote one onto this key (candle vault promote), then bridge. Nothing was built.`
        : `This key has more than one ${chainName(destination)} TEE wallet; name the destination with --to: ${candidates.map(describeWallet).join("; ")}. Nothing was built.`,
    )
  }

  const solana = lazySolanaClient(ctx, flags["--rpc-url"])
  const evm = lazyEvmRpc(ctx, flags["--rpc-url"])
  const decimals = BRIDGE_ASSETS[from].decimals
  let amountRaw: string
  if (percent !== undefined) {
    const balance = await bridgeOriginBalance(ctx, from, wallet.address, solana, evm)
    amountRaw = ((balance * percent) / 100_000_000n).toString()
    if (amountRaw === "0") throw new TradingError("INVALID_AMOUNT", "The selected percentage rounds to zero raw units.")
  } else amountRaw = rawAmount(flags["--amount"] as string, decimals)
  if (!(await claimOperation(ctx, key, id, "swap")))
    throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const built = await requestSwapBuild(ctx, key, {
    clientTradeId: id,
    from,
    to,
    amountRaw,
    maxSlippageBps: args.slippage,
    payer: { type: "linked", linkedWalletId: wallet.id },
    ...(toWalletId !== undefined ? { toWalletId } : {}),
  })
  if (built.job || built.status === "executed")
    return printTradingResult(ctx, { ...built, clientTradeId: id, kind: "swap" })
  const body = (built.payload ?? {}) as Json
  const parsedBuild = bridgeBuildSchema.safeParse(body)
  if (!parsedBuild.success)
    throw new TradingError("INVALID_RESPONSE", "Candle did not return a complete bridge quote; nothing was signed.")
  const data = parsedBuild.data
  if (data.venue !== "relay")
    throw new TradingError(
      "INVALID_RESPONSE",
      `A bridge goes through Relay, not ${safeText(data.venue)}; nothing was signed.`,
    )
  // 4c-AD-4: a swap between two base assets is free. A fee here is not the quote this command shows.
  if (data.fee.bps !== 0 || data.fee.feeRaw !== "0")
    throw new TradingError(
      "INVALID_RESPONSE",
      "A bridge carries no Candle fee, and this quote has one; nothing was signed.",
    )
  const recipient = candidates.find((row) =>
    destination === "hood" ? sameEvmAddress(row.address, data.recipient) : row.address === data.recipient,
  )
  if (!recipient)
    throw new TradingError(
      "INVALID_RESPONSE",
      `Candle named ${safeText(data.recipient)} as the destination, which is not ${toWalletId !== undefined ? "the TEE wallet --to named" : `this key's ${chainName(destination)} TEE wallet`}; nothing was signed.`,
    )
  const facts: BridgeFacts = {
    from,
    to,
    recipient: recipient.address,
    ...(data.statusChecks[0] !== undefined ? { statusCheck: data.statusChecks[0] } : {}),
  }
  await saveOperationBridge(ctx, key, id, { ...facts })

  // 4c-ED-6: the CLI's own check of what is about to be signed, before the prompt.
  const refused = (problem: string) =>
    new TradingError(
      "RELAY_STEP_REFUSED",
      `Relay's deposit did not pass this machine's check (${problem}); nothing was signed.`,
    )
  let sequenced: SequencedBody | undefined
  let transaction: string | undefined
  const hoodOrigin = from === "ETH" || from === "USDG" ? from : undefined
  if (hoodOrigin) {
    const parsedLeg = sequencedSchema.safeParse(body)
    if (!parsedLeg.success)
      throw new TradingError(
        "SEQUENCED_RAIL_REQUIRED",
        "A Hood TEE wallet bridges one leg at a time, and this Candle deployment did not answer with a sequenced leg. Nothing was signed.",
      )
    sequenced = parsedLeg.data
    if (typeof data.walletAddress !== "string" || !sameEvmAddress(data.walletAddress, wallet.address))
      throw new TradingError(
        "INVALID_RESPONSE",
        "The Hood build does not name the requested payer; nothing was signed.",
      )
    const plan = plannedLegKinds(sequenced.legKind, sequenced.plannedLegCount, false, "bridgeDeposit")
    if (!bridgePlanAdmitted(hoodOrigin, plan))
      throw refused(`the plan is ${sequenced.plannedLegCount} leg(s) starting with ${sequenced.legKind}`)
    const problem = relayHoodLegProblem(sequenced.legKind, sequenced.nextLeg, {
      origin: hoodOrigin,
      payer: wallet.address,
      amountRaw,
    })
    if (problem) throw refused(problem)
  } else {
    if (data.transactionsBase64?.length !== 1)
      throw refused(`Candle returned ${data.transactionsBase64?.length ?? 0} transactions, not one deposit`)
    transaction = data.transactionsBase64[0] as string
    const reader = await solana()
    const problem = await tradingRead(ctx, reader, () =>
      relaySolanaDepositProblem(transaction as string, wallet.address, reader.rpc),
    )
    if (problem) throw refused(problem)
  }

  const outDecimals = BRIDGE_ASSETS[to].decimals
  // Relay's quote carries no guaranteed minimum; the bound is its estimate less the slippage it
  // was quoted with.
  const minimumRaw = ((BigInt(data.expectedOutRaw) * BigInt(10_000 - args.slippage)) / 10_000n).toString()
  const quote: QuoteDisplay & Json = {
    intent: `Bridge ${decimalAmount(amountRaw, decimals)} ${from} on ${chainName(origin)} to ${to} on ${chainName(destination)}`,
    wallet: wallet.address,
    venue: "relay",
    priceImpactPct: null,
    minimumReceived: `${decimalAmount(minimumRaw, outDecimals)} ${to} (Relay's estimate ${decimalAmount(data.expectedOutRaw, outDecimals)} ${to}, less the ${args.slippage} bps slippage bound)`,
    minimumReceivedRaw: minimumRaw,
    expectedOutRaw: data.expectedOutRaw,
    destination: `${recipient.label ? `${recipient.label} ` : ""}${recipient.address} (${chainName(destination)} TEE wallet on this key)`,
    candleFee: "none",
    relayFees: data.venueCostUsd !== undefined ? `about $${data.venueCostUsd} as Relay reports it` : "not reported",
    estimatedTime:
      data.venueTimeEstimateSec !== undefined
        ? `about ${data.venueTimeEstimateSec}s as Relay reports it`
        : "not reported",
    tokenRisks: [],
  }
  if (sequenced) {
    const leg = sequenced.nextLeg
    const maxFee = BigInt(leg.maxFeePerGas)
    const reserve = sweepReserveFloor(maxFee, [])
    quote.legs = describeHoodLegs(sequenced, false, "bridgeDeposit")
    quote.gas = `the ${sequenced.legKind} leg up to ${formatUnits(BigInt(leg.gas) * maxFee, 18)} ETH (gas ${leg.gas} at ${formatUnits(maxFee, 9)} gwei); each later leg is priced by Candle when it becomes next`
    quote.reserve = `at least ${formatUnits(reserve.wei, 18)} ETH stays in the wallet for a sweep home (${reserve.erc20Transfers} ERC-20 transfers and the final ETH transfer at twice the fee); a bridge never spends it`
    quote.operationId = sequenced.operationId
  }
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    if (sequenced)
      ctx.deps.stderr.write(
        `Nothing was signed. Operation ${sequenced.operationId} holds this wallet until ${new Date(sequenced.expiresAt).toISOString()}; a new Hood trade or sweep from it waits until then.\n`,
      )
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "swap",
      quote,
      ...(sequenced ? { operationId: sequenced.operationId, walletHeldUntil: sequenced.expiresAt } : {}),
    })
  }
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= ctx.deps.now())
    throw new TradingError("QUOTE_EXPIRED", "The quote expired before signing. Start a new intention with a new id.")

  let result: Json
  let depositHash: string | undefined
  if (sequenced && hoodOrigin) {
    const run = await runSequencedLegs(ctx, key, {
      wallet,
      first: sequenced,
      submitPath: "/api/v1/agent/swap/submit",
      submitFields: { clientTradeId: id, swapId: data.swapId },
      unwrap: (answer) => (answer.payload ?? {}) as Json,
      clientId: id,
      kind: "swap",
      primaryLeg: "bridgeDeposit",
      allowedLegs: bridgeLegKinds(hoodOrigin),
      checkLeg: (kind, leg) =>
        relayHoodLegProblem(kind, leg, { origin: hoodOrigin, payer: wallet.address, amountRaw }) === null,
      onLanded: async () => {},
    })
    depositHash = run.landed.find((leg) => leg.kind === "bridgeDeposit")?.hash
    result = {
      ...run.final,
      chain: "hood",
      operationId: sequenced.operationId,
      landedLegs: run.landed,
    }
  } else {
    const signed = await relaySign(ctx, key, wallet, transaction as string)
    const submitted = await request(ctx, key, "/api/v1/agent/swap/submit", {
      clientTradeId: id,
      swapId: data.swapId,
      signedTransactionsBase64: [signed],
    })
    const payload = (submitted.payload ?? {}) as Json
    const hashes = Array.isArray(payload.hashes) ? payload.hashes.filter((h): h is string => typeof h === "string") : []
    depositHash = hashes[0]
    result = submitted
  }
  ctx.deps.stderr.write(
    `Deposit ${depositHash ? safeText(depositHash) : "sent"}: filling.${args.wait ? "" : ` Check it with candle swap status ${id} (add --wait to follow it).`}\n`,
  )
  const receipt: Json = {
    ...result,
    clientTradeId: id,
    kind: "swap",
    bridge: { from, to, destination: recipient.address, ...(depositHash ? { depositHash } : {}) },
    quote,
    wallet: safeText(wallet.address),
  }
  if (!args.wait) return printTradingResult(ctx, receipt)
  // The deposit is out. A read that fails while following it is not a failed bridge: the receipt
  // still prints, so nobody sends it again under a new id.
  try {
    const found = await lookupOperation(ctx, key, id, "swap")
    if (!found) return printTradingResult(ctx, { ...receipt, waited: { final: false } })
    const waited = await waitForSettlement(ctx, key, id, found, facts, true)
    return printTradingResult(ctx, {
      ...receipt,
      job: waited.job,
      bridgeStatus: waited.bridgeStatus,
      waited: waited.waited,
    })
  } catch (error) {
    const reason = safeText(error instanceof Error ? describeRpcFailure(error) : String(error))
    ctx.deps.stderr.write(
      `Could not follow the bridge (${reason}). The deposit was sent; do not send it again. Re-check with candle swap status ${id} --wait.\n`,
    )
    return printTradingResult(ctx, { ...receipt, waited: { final: false, error: reason } })
  }
}
