import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { checkEvmAddress, formatUnits, sameEvmAddress, toChecksumAddress } from "../evm-lite"
import { writeUsageFailure } from "../render"
import { postSignatureRateLimitMessage, postSignatureSuggestion } from "../solana-endpoint"
import { isRateLimited } from "../solana-lite"
import {
  BASES,
  chainName,
  claimOperation,
  confirmQuote,
  decimalAmount,
  HOOD_BASES,
  type Json,
  launchBuildSchema,
  type QuoteDisplay,
  rawAmount,
  relaySign,
  request,
  runSequencedLegs,
  type SequencedBody,
  safeText,
  savedOperation,
  saveOperationSignature,
  sequencedSchema,
  sweepReserveFloor,
  type TradeChain,
  TradingError,
  TradingUsage,
  type TradingWallet,
  tradingKey,
  tradingSolanaClient,
  tradingWallet,
  walletNameChain,
} from "../trading"
import { lookupOperation, printTradingResult, recordTradedToken, tradingFailure, validClientId } from "./swap"

const USAGE =
  "Usage: candle launch --name <name> --symbol <symbol> --image-url <https-url> --wallet <tee> [--buy <amount>] [--client-trade-id <id>] [--quote-asset sol|usdc|cndl|eth|usdg] [--dex-version v3|v4] [--mode <mode>] [--rpc-url <url>] [--yes]. A Hood TEE wallet launches on Hood and needs --dex-version."

/** The launch quote assets by chain, as the server's launch matrix lists them. */
const QUOTE_CHAIN: Record<string, TradeChain> = {
  sol: "solana",
  usdc: "solana",
  cndl: "solana",
  eth: "hood",
  usdg: "hood",
}

/** A Hood TEE launch signs these legs and no other (D9): the curve, then the fee when one applies. */
const HOOD_LAUNCH_LEGS = ["createCurve", "feeTransfer"] as const
/** With `--buy` (BE-869): Candle's server-built curve buy follows the curve and the fee. */
const HOOD_LAUNCH_BUY_LEGS = ["createCurve", "feeTransfer", "trade"] as const

/** A launch's first buy (BE-869): `--buy` in whole units of the quote asset, and the same in base units. */
interface LaunchBuy {
  raw: string
  display: string
}

/**
 * `--buy` converted as `candle swap` converts `--amount`: whole units of the launch's quote asset
 * (SOL by default on Solana, ETH on Hood) to its base units. Undefined without `--buy`, which
 * launches exactly as before.
 */
function launchBuy(flags: Record<string, string>, chain: TradeChain): LaunchBuy | undefined {
  const amount = flags["--buy"]
  if (amount === undefined) return undefined
  const quote = (flags["--quote-asset"] ?? (chain === "hood" ? "eth" : "sol")).toUpperCase()
  const decimals = chain === "hood" ? HOOD_BASES[quote]?.decimals : BASES[quote]?.decimals
  if (decimals === undefined)
    throw new TradingError(
      "INVALID_AMOUNT",
      `--buy is in the launch's quote asset, and ${safeText(quote)} is not one on ${chainName(chain)}. Nothing was built.`,
    )
  const raw = rawAmount(amount, decimals)
  return { raw, display: `${decimalAmount(raw, decimals)} ${quote}` }
}

/**
 * The server's refusal of a non-zero `buyAmount` from a TEE wallet, said plainly (BE-869). Candle
 * takes a first buy on a TEE launch only with TEE_LAUNCH_BUYS_ENABLED on, and answers
 * `VALIDATION_FAILED` on field `buyAmount` while it is off. Any other error passes through as is.
 */
function buyRefusal(error: unknown): unknown {
  if (!(error instanceof TradingError) || error.code !== "VALIDATION_FAILED" || error.details?.field !== "buyAmount")
    return error
  return new TradingError(
    "VALIDATION_FAILED",
    `Candle refused the first buy on this TEE launch: ${safeText(error.message)}. A TEE wallet's launch takes --buy only where the server has TEE_LAUNCH_BUYS_ENABLED on, and it is off on this deployment. Nothing was built or signed.`,
    {
      suggestion:
        "Launch without --buy under a new --client-trade-id, then make the first buy with candle swap once the token lands.",
      details: error.details,
    },
  )
}

/** The line printed before the confirm: what the launch does about a first buy. */
function buyNotice(buy: LaunchBuy | undefined, chain: TradeChain): string {
  if (!buy)
    return "Launch creates the token only. Make the first buy with a separate candle swap. Price impact does not apply to creation.\n"
  return chain === "hood"
    ? `Launch creates the token, then spends ${buy.display} on a first buy on the new curve, as the last leg. Candle reserves the buy against this key's spend window before any leg is signed. If the buy leg never lands, the token exists with no first buy. Price impact does not apply to creation.\n`
    : `Launch creates the token and spends ${buy.display} on a first buy in the same transaction. Candle reserves the whole debit against this key's spend window before anything is signed. Price impact does not apply to creation.\n`
}

/**
 * Phase 4b-2 (D6, D9): the wallet decides a launch's chain. Before any request, what the flags
 * already say must agree: a 0x `--wallet` is Hood, `--quote-asset` names its chain, and
 * `--dex-version` exists only on Hood. Undefined when nothing says.
 */
function flagChain(flags: Record<string, string>): TradeChain | undefined {
  const said: Array<[string, TradeChain]> = []
  const named = walletNameChain(flags["--wallet"] ?? "")
  if (named) said.push([`--wallet ${flags["--wallet"]}`, named])
  const quote = flags["--quote-asset"]
  const quoteChain = quote === undefined ? undefined : QUOTE_CHAIN[quote.toLowerCase()]
  if (quoteChain) said.push([`--quote-asset ${quote}`, quoteChain])
  if (flags["--dex-version"] !== undefined) said.push(["--dex-version", "hood"])
  const [first, ...rest] = said
  const other = rest.find(([, chain]) => chain !== first?.[1])
  if (first && other)
    throw new TradingError(
      "CHAIN_MISMATCH",
      `${safeText(first[0])} is ${chainName(first[1])} and ${safeText(other[0])} is ${chainName(other[1])}; a launch is on one chain. Nothing was built.`,
    )
  return first?.[1]
}

export async function launch(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: [
      "--name",
      "--symbol",
      "--image-url",
      "--description",
      "--wallet",
      "--client-trade-id",
      "--rpc-url",
      "--quote-asset",
      "--mode",
      "--dex-version",
      "--buy",
    ],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `launch-${randomUUID()}`
  if (
    parsed.positionals.length ||
    !flags["--name"] ||
    !flags["--symbol"] ||
    !flags["--image-url"] ||
    !flags["--wallet"] ||
    !validClientId(id) ||
    (flags["--dex-version"] !== undefined && flags["--dex-version"] !== "v3" && flags["--dex-version"] !== "v4")
  ) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  try {
    // Before any request, as `candle swap` checks `--amount`; the quote asset's decimals come later.
    if (flags["--buy"] !== undefined) rawAmount(flags["--buy"], 18)
    const hinted = flagChain(flags)
    if (hinted === "hood" && flags["--dex-version"] === undefined) {
      writeUsageFailure(ctx.deps, `A Hood launch needs --dex-version v3|v4. ${USAGE}`, ctx.json)
      return 2
    }
    const key = await tradingKey(ctx)
    const prior = await lookupOperation(ctx, key, id, "launch")
    if (prior) {
      const local = await savedOperation(ctx, key, id)
      const settled = prior.job?.status === "confirmed" || prior.job?.status === "failed"
      // Phase 4b-2: a Hood TEE launch saved its operation id with the leg's hash. It is recorded
      // from the legs the server sent, never from a broadcast signature.
      if (local?.operationId && !settled) return await resumeHoodLaunch(ctx, key, id, local.operationId, prior)
      if (local?.signature && !settled) {
        const result = await request(ctx, key, "/api/v1/launch/self/confirm", {
          clientLaunchId: id,
          signature: local.signature,
        })
        return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch" })
      }
      return printTradingResult(ctx, prior)
    }
    const wallet = await tradingWallet(ctx, key, flags["--wallet"], "launch:write", hinted ?? "any")
    if (wallet.chain === "evm") {
      if (flags["--dex-version"] === undefined)
        throw new TradingUsage(`${wallet.address} is a Hood TEE wallet, and a Hood launch needs --dex-version v3|v4.`)
      const buy = launchBuy(flags, "hood")
      return await hoodLaunch(ctx, key, { flags, id, wallet, buy, yes: parsed.booleans.has("--yes") })
    }
    const buy = launchBuy(flags, "solana")
    const solana = await tradingSolanaClient(ctx, flags["--rpc-url"])
    if (!(await claimOperation(ctx, key, id, "launch")))
      throw new TradingError(
        "OPERATION_ALREADY_STARTED",
        "This machine already started this launch id; no write was resent.",
      )
    ctx.deps.stderr.write(`Operation: ${id}\n`)
    const built = launchBuildSchema.parse(
      await request(ctx, key, "/api/v1/launch/self/build", {
        clientLaunchId: id,
        chain: "solana",
        buyAmount: buy ? buy.raw : 0,
        name: flags["--name"],
        symbol: flags["--symbol"],
        imageUrl: flags["--image-url"],
        linkedWalletId: wallet.id,
        ...(flags["--description"] ? { description: flags["--description"] } : {}),
        ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"] } : {}),
        ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
      }).catch((error) => {
        throw buyRefusal(error)
      }),
    )
    if (!built.transaction || !/^\d+$/.test(built.maxDebitLamports ?? ""))
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle did not return a launch transaction and maximum debit; nothing was signed.",
      )
    const quote = {
      intent: `Launch ${flags["--name"]} (${flags["--symbol"]})${buy ? ` with a first buy of ${buy.display}` : ""}`,
      wallet: wallet.address,
      venue: "curve launch",
      priceImpactPct: null,
      fee: built.fee ?? { bps: 0, feeRaw: "0" },
      minimumReceived: buy ? "not quoted (the first buy on the new curve)" : "0 tokens (no first buy)",
      maxDebitLamports: built.maxDebitLamports,
      tokenRisks: [],
    }
    ctx.deps.stderr.write(buyNotice(buy, "solana"))
    if (!(await confirmQuote(ctx, quote, parsed.booleans.has("--yes"))))
      return printTradingResult(ctx, { success: true, status: "cancelled", clientTradeId: id, kind: "launch", quote })
    if (!Number.isFinite(built.expiresAt) || built.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The launch build expired before signing.")
    const signed = await relaySign(ctx, key, wallet, built.transaction)
    const signature = await saveOperationSignature(ctx, key, id, "launch", signed)
    let broadcastSignature: string
    try {
      broadcastSignature = await solana.rpc.sendTransaction(signed)
    } catch (error) {
      // BE-355 (D4): the signature is in the operation file, the client never re-sends, and the
      // transaction may still land. Exit 3; the resume path above confirms it and sends nothing.
      if (!isRateLimited(error)) throw error
      throw new TradingError(
        "RPC_RATE_LIMITED",
        `${postSignatureRateLimitMessage(signature)} Re-run with the same --client-trade-id ${id}: it confirms the saved signature and sends nothing new.`,
        { suggestion: postSignatureSuggestion(ctx), exitCode: 3 },
      )
    }
    if (broadcastSignature !== signature)
      throw new TradingError("RPC_FAILED", "RPC returned a different transaction signature; check the saved operation.")
    ctx.deps.stderr.write(`Launch signature: ${signature}\n`)
    const result = await request(ctx, key, "/api/v1/launch/self/confirm", { clientLaunchId: id, signature })
    return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch", quote })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}

// ── Phase 4b-2: a launch from a Hood TEE wallet (D9) ──────────────────────────────────────────

/**
 * `candle launch --wallet <hood tee>`: the launch's legs (`createCurve`, then the fee when one
 * applies) run through the D4 leg loop, one at a time, each relay-signed with
 * `eth_signTransaction` and sent by Candle, which answers only after its receipt. Without `--buy`
 * the build's `buyAmount` is 0 and the first buy is a separate `candle swap`. With it (BE-869),
 * Candle adds its own curve buy as the last leg, for exactly that amount, and reserves it against
 * the key's spend window when the operation opens. Nothing here reads or writes over a Hood RPC:
 * the server sets nonces and fees, broadcasts, and records the launch from the legs it sent.
 */
async function hoodLaunch(
  ctx: CommandContext,
  key: string,
  args: { flags: Record<string, string>; id: string; wallet: TradingWallet; buy?: LaunchBuy; yes: boolean },
): Promise<number> {
  const { flags, id, wallet, buy } = args
  const allowedLegs = buy ? HOOD_LAUNCH_BUY_LEGS : HOOD_LAUNCH_LEGS
  if (!(await claimOperation(ctx, key, id, "launch")))
    throw new TradingError(
      "OPERATION_ALREADY_STARTED",
      "This machine already started this launch id; no write was resent.",
    )
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const built = await request(ctx, key, "/api/v1/launch/self/build", {
    clientLaunchId: id,
    chain: "hood",
    buyAmount: buy ? buy.raw : 0,
    name: flags["--name"],
    symbol: flags["--symbol"],
    imageUrl: flags["--image-url"],
    linkedWalletId: wallet.id,
    dexVersion: flags["--dex-version"],
    ...(flags["--description"] ? { description: flags["--description"] } : {}),
    ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"].toLowerCase() } : {}),
    ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
  }).catch((error) => {
    throw buyRefusal(error)
  })
  // D4: a Hood TEE wallet signs one leg at a time. An answer without the sequenced envelope is a
  // deployment that predates it, and its transaction is never signed from this wallet.
  const parsed = sequencedSchema.safeParse(built)
  if (!parsed.success)
    throw new TradingError(
      "SEQUENCED_RAIL_REQUIRED",
      "A Hood TEE wallet launches one leg at a time, and this Candle deployment did not answer with a sequenced leg. Nothing was signed.",
    )
  const first: SequencedBody = parsed.data
  const curve = typeof built.curveAddress === "string" ? checkEvmAddress(built.curveAddress) : undefined
  if (
    built.chain !== "hood" ||
    built.clientLaunchId !== id ||
    typeof built.walletAddress !== "string" ||
    !sameEvmAddress(built.walletAddress, wallet.address) ||
    !curve?.ok
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      "The Hood launch build does not name this launch and payer; nothing was signed.",
    )
  // With --buy the plan must have room for the buy leg after the curve.
  if (
    first.legKind !== "createCurve" ||
    first.plannedLegCount > allowedLegs.length ||
    (buy !== undefined && first.plannedLegCount < 2)
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      `A Hood launch starts with its createCurve leg, and Candle offered ${safeText(first.legKind)} of ${first.plannedLegCount}; nothing was signed.`,
    )
  const leg = first.nextLeg
  const maxFee = BigInt(leg.maxFeePerGas)
  const reserve = sweepReserveFloor(maxFee)
  const quote: QuoteDisplay & Json = {
    intent: `Launch ${flags["--name"]} (${flags["--symbol"]}) on Hood${buy ? ` with a first buy of ${buy.display}` : ""}`,
    wallet: wallet.address,
    venue: "curve launch",
    priceImpactPct: null,
    minimumReceived: buy ? "not quoted (Candle's buy leg sets its floor on the new curve)" : "0 tokens (no first buy)",
    tokenRisks: [],
    legs: hoodLaunchLegNames(first.plannedLegCount, buy !== undefined),
    gas: `the createCurve leg up to ${formatUnits(BigInt(leg.gas) * maxFee, 18)} ETH (gas ${leg.gas} at ${formatUnits(maxFee, 9)} gwei)${hoodLaterLegsGas(first.plannedLegCount, buy !== undefined)}`,
    reserve: `at least ${formatUnits(reserve.wei, 18)} ETH stays in the wallet for a sweep home (${reserve.erc20Transfers} ERC-20 transfers and the final ETH transfer at twice the fee)`,
    curveAddress: curve.address,
    operationId: first.operationId,
  }
  ctx.deps.stderr.write(buyNotice(buy, "hood"))
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    // The build holds the wallet (D4, one operation per wallet) until its window closes.
    ctx.deps.stderr.write(
      `Nothing was signed. Operation ${first.operationId} holds this wallet until ${new Date(first.expiresAt).toISOString()}; a new Hood operation from it is refused as WALLET_BUSY until then.\n`,
    )
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "launch",
      chain: "hood",
      quote,
      operationId: first.operationId,
      walletHeldUntil: first.expiresAt,
    })
  }
  const confirmedPlan: readonly string[] | undefined = buy
    ? first.plannedLegCount === 3
      ? ["createCurve", "feeTransfer", "trade"]
      : ["createCurve", "trade"]
    : undefined
  let position = 0
  const run = await runSequencedLegs(ctx, key, {
    wallet,
    first,
    submitPath: "/api/v1/launch/self/confirm",
    submitFields: { clientLaunchId: id },
    unwrap: (answer) => answer,
    clientId: id,
    kind: "launch",
    primaryLeg: "createCurve",
    allowedLegs,
    // The factory's createCurve is not payable. A fee leg may still carry ETH. The buy leg pays
    // this launch's own curve exactly the amount confirmed.
    checkLeg: (kind, leg) => {
      // With a buy, the confirmed sequence is the only one signed: each leg must be the kind the
      // plan puts at its position, so a fee in the buy's slot or after it is never signed.
      if (confirmedPlan && confirmedPlan[position++] !== kind) return false
      return kind === "createCurve"
        ? leg.value === "0"
        : kind !== "trade" || (buy !== undefined && leg.value === buy.raw && sameEvmAddress(leg.to, curve.address))
    },
    onLanded: async () => {},
  })
  // A final answer before the buy landed is not the launch the user confirmed.
  if (confirmedPlan && run.landed.map((done) => done.kind).join() !== confirmedPlan.join())
    throw new TradingError(
      "INVALID_RESPONSE",
      `Candle ended the launch before every confirmed leg landed (${confirmedPlan.join(", ")}).${
        run.landed.length === 0
          ? " No leg landed."
          : ` Landed: ${run.landed.map((done) => `${done.kind} ${safeText(done.hash)}`).join(", ")}.`
      }`,
      { details: { operationId: first.operationId, landedLegs: run.landed } },
    )
  return printTradingResult(ctx, {
    ...run.final,
    ...(await recordLaunchedToken(ctx, wallet, run.final)),
    clientTradeId: id,
    kind: "launch",
    chain: "hood",
    quote,
    wallet: safeText(wallet.address),
    operationId: first.operationId,
    landedLegs: run.landed,
  })
}

/** What the gas line says about the legs after createCurve, which Candle prices when each becomes next. */
function hoodLaterLegsGas(count: number, buys: boolean): string {
  if (count < 2) return ""
  return buys
    ? "; the later legs are priced by Candle when each becomes next"
    : "; the fee leg is priced by Candle when it becomes next"
}

/** The legs a Hood launch names before its confirm, from the planned count and whether it buys. */
function hoodLaunchLegNames(count: number, buys: boolean): string[] {
  if (!buys) return count === 2 ? ["create curve", "fee"] : ["create curve"]
  return count === 3 ? ["create curve", "fee", "first buy"] : ["create curve", "first buy"]
}

/** D1: the launched token is one line of the sealed EVM record, so a later sweep finds it. */
async function recordLaunchedToken(ctx: CommandContext, wallet: TradingWallet, final: Json): Promise<Json> {
  const mint = typeof final.mint === "string" ? checkEvmAddress(final.mint) : undefined
  if (!mint?.ok) {
    const notice =
      "Notice: Candle did not name the launched token, so the sealed EVM record was not updated. The launch landed."
    ctx.deps.stderr.write(`${notice}\n`)
    return { evmRecord: { notices: [notice] } }
  }
  const token = toChecksumAddress(mint.address)
  const notice = await recordTradedToken(ctx, wallet.address, token)
  return { evmRecord: { token, notices: notice ? [notice] : [] } }
}

/**
 * A re-run of a Hood TEE launch this machine started. While the operation still holds the wallet
 * its leg may yet land, so nothing is posted: exit 3, as the first run did. Once it has let go,
 * `/confirm { operationId }` records the launch from the legs Candle sent; nothing is re-signed or
 * re-sent.
 */
async function resumeHoodLaunch(
  ctx: CommandContext,
  key: string,
  id: string,
  operationId: string,
  prior: Json & { job: { status: string } },
): Promise<number> {
  const operation = (prior.job as Json).operation as Json | undefined
  if (operation?.status === "active" && typeof operation.expiresAt === "number" && operation.expiresAt > ctx.deps.now())
    throw new TradingError(
      "OPERATION_IN_FLIGHT",
      `Operation ${operationId} still holds this wallet until ${new Date(operation.expiresAt).toISOString()}, and its leg may still land. Nothing was posted or re-sent.`,
      { exitCode: 3, details: { operationId, operation } },
    )
  const result = await request(ctx, key, "/api/v1/launch/self/confirm", { clientLaunchId: id, operationId })
  return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch", chain: "hood", operationId })
}
