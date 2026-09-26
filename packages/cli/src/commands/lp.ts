/**
 * Ember Phase 3 PR D, CLI half (BE-315, R4): `candle lp pools | add | positions | remove | claim`.
 *
 * Meteora DAMM v2 liquidity from a TEE wallet, on Candle's agent rail. Every write here is the
 * same shape as `candle swap`: the wallet's BOUND key authenticates (scope `lp:write`, opt-in), the
 * server builds the transaction and quotes it, the quote is shown and confirmed, Privy signs the
 * payer through Candle's relay, this machine broadcasts over the user's own RPC, and the server's
 * `/confirm` writes the ledger once the transaction is confirmed on chain. No vault or TEE private
 * key is opened on any path in this file; local signing of a position close belongs to `tee sweep`
 * alone (P3-ED-6, `lp-close.ts`).
 *
 * The server half (#1200, behind `LP_ENABLED`) owns admission, the pre-artifact Ember spend gate on
 * an add, the thin-pool and Token-2022 warnings (R5, both pool tokens), the idempotent build per
 * client id, and the confirm that reads actual token deltas. This file only drives it.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { writeUsageFailure } from "../render"
import { postSignatureRateLimitMessage, postSignatureSuggestion, type SolanaClient } from "../solana-endpoint"
import { isRateLimited, type SolanaRpc } from "../solana-lite"
import { classifyStatus } from "../sweep-pending"
import {
  BASES,
  baseAsset,
  claimOperation,
  completeTradingWallet,
  decimalAmount,
  type Json,
  listTradingWallets,
  lpBuildSchema,
  lpPoolsSchema,
  lpPositionsSchema,
  rawAmount,
  relaySign,
  safeText,
  savedOperation,
  saveOperationSignature,
  TradingError,
  type TradingWallet,
  tradingKey,
  tradingSolanaClient,
  tradingWallet,
} from "../trading"
import { decimalsFor, printTradingResult, tradingFailure, validClientId } from "./swap"

const LP_SCOPE = "lp:write"
/** Confirmation polling after the broadcast: 2 s apart, up to 45 tries (90 s), as `tee sweep` waits. */
const CONFIRM_POLL_MS = 2_000
const CONFIRM_MAX_POLLS = 45

type LpAction = "add" | "remove" | "claim"

/**
 * One LP request. The LP router answers a plain 404 with no Candle error code while `LP_ENABLED`
 * is off (`agent-lp.ts`), which `request()` would report as a generic REQUEST_FAILED; naming it is
 * the difference between "the deployment has not enabled this" and "something broke".
 */
async function lpRequest(ctx: CommandContext, key: string, path: string, body?: Json): Promise<Json> {
  const result = await apiRequest(path, {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: body ? "POST" : "GET",
    body,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    if (result.status === 404 && !result.code)
      throw new TradingError(
        "LP_NOT_ENABLED",
        "This Candle deployment does not serve LP routes (LP_ENABLED is off there, or the API predates them).",
      )
    throw new TradingError(result.code ?? "REQUEST_FAILED", result.message)
  }
  if (!result.body || typeof result.body !== "object")
    throw new TradingError("INVALID_RESPONSE", "Candle returned an invalid response.")
  return result.body as Json
}

function solanaAddress(value: string, what: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new TradingError("INVALID_ADDRESS", `${what} must be a Solana address (base58).`)
  return value
}

/** A pool token as the operator names it: SOL, USDC, CNDL or a mint. */
function poolToken(value: string): string {
  const base = baseAsset(value)
  if (base) return BASES[base]?.mint as string
  return solanaAddress(value, "The token")
}

function matchesWallet(row: { id: string; address: string; label?: string }, name: string): boolean {
  return row.id === name || row.address === name || row.label === name
}

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

function amountLine(amount: { mint: string; raw: string; decimals: number }): string {
  const base = Object.entries(BASES).find(([, asset]) => asset.mint === amount.mint)?.[0]
  return `${decimalAmount(amount.raw, amount.decimals)} ${base ?? amount.mint}`
}

// ── pools ─────────────────────────────────────────────────────────────────────────────────────

export async function lpPools(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--page"] })
  const page = Number(parsed && !("error" in parsed) ? (parsed.values["--page"] ?? "1") : "1")
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 1 || !Number.isSafeInteger(page) || page < 1)
    return usage(ctx, "Usage: candle lp pools <token> [--page <n>]")
  try {
    const token = poolToken(parsed.positionals[0] as string)
    const key = await tradingKey(ctx)
    const pools = lpPoolsSchema.parse(
      await lpRequest(ctx, key, `/api/v1/agent/lp/pools/${encodeURIComponent(token)}?page=${page}`),
    )
    if (ctx.json) return printTradingResult(ctx, { success: true, token, ...pools })
    const out = ctx.deps.stdout
    if (pools.pools.length === 0) {
      out.write(`No DAMM v2 pool lists ${token} (page ${pools.page} of ${pools.pages}).\n`)
      return 0
    }
    const usd = (value: number | null | undefined) =>
      value === null || value === undefined ? "unavailable" : `$${value.toFixed(2)}`
    const pct = (value: number | null | undefined) =>
      value === null || value === undefined ? "unavailable" : `${value.toFixed(2)}%`
    out.write(`DAMM v2 pools for ${token} (page ${pools.page} of ${pools.pages}):\n`)
    for (const pool of pools.pools) {
      out.write(
        `  ${safeText(pool.pool)}\n    pair ${pool.tokens.map(safeText).join(" / ")}\n    liquidity ${usd(pool.liquidityUsd)}, fee ${pct(pool.baseFeePercent)}, 24h volume ${usd(pool.volume24hUsd)}, est. yield ${pct(pool.estimatedAprPercent)} APR (indexed, not a quote)\n`,
      )
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── positions ─────────────────────────────────────────────────────────────────────────────────

export async function lpPositions(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle lp positions [--wallet <tee>]")
  try {
    const key = await tradingKey(ctx)
    // A read `requireAgentKey("any")` admits: no scope is demanded of the key here.
    const { rows } = await listTradingWallets(ctx, key)
    const name = parsed.values["--wallet"]
    const wallets = rows.filter((row) => row.chain === "solana" && (name === undefined || matchesWallet(row, name)))
    if (name !== undefined && wallets.length === 0)
      throw new TradingError("TEE_WALLET_REQUIRED", `No TEE wallet on this key is called "${name}".`)
    const report: Array<{
      id: string
      address: string
      label?: string
      positions: ReturnType<typeof lpPositionsSchema.parse>["positions"]
    }> = []
    for (const row of wallets) {
      const positions = lpPositionsSchema.parse(
        await lpRequest(ctx, key, `/api/v1/agent/lp/positions?linkedWalletId=${encodeURIComponent(row.id)}`),
      )
      report.push({
        id: row.id,
        address: row.address,
        ...(row.label ? { label: row.label } : {}),
        positions: positions.positions,
      })
    }
    if (ctx.json) return printTradingResult(ctx, { success: true, wallets: report })
    const out = ctx.deps.stdout
    const total = report.reduce((n, wallet) => n + wallet.positions.length, 0)
    if (total === 0) {
      out.write(`No DAMM v2 positions across ${report.length} TEE wallet(s).\n`)
      return 0
    }
    for (const wallet of report) {
      if (wallet.positions.length === 0) continue
      out.write(`${wallet.label ? `${safeText(wallet.label)} ` : ""}(${wallet.id}, ${safeText(wallet.address)})\n`)
      for (const position of wallet.positions) {
        out.write(`  position ${safeText(position.position)} in pool ${safeText(position.pool)}\n`)
        for (const token of position.tokens) {
          out.write(
            `    ${amountLine({ mint: token.mint, raw: token.amountRaw, decimals: token.decimals })}, unclaimed fees ${decimalAmount(token.unclaimedFeesRaw, token.decimals)}${token.valueUsd === null || token.valueUsd === undefined ? "" : ` ($${token.valueUsd.toFixed(2)})`}\n`,
          )
        }
        out.write(
          `    value ${position.valueUsd === null || position.valueUsd === undefined ? "unpriced" : `$${position.valueUsd.toFixed(2)}`}${position.poolShare === undefined ? "" : `, ${(position.poolShare * 100).toFixed(4)}% of the pool`}\n`,
        )
      }
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── the shared write path ─────────────────────────────────────────────────────────────────────

/** Which bound TEE wallet holds `position`: the one named, or the one whose positions list it. */
async function walletHolding(
  ctx: CommandContext,
  key: string,
  position: string,
  name: string | undefined,
): Promise<TradingWallet> {
  if (name !== undefined) return tradingWallet(ctx, key, name, LP_SCOPE)
  const { rows, appId, keyPrefix } = await listTradingWallets(ctx, key, LP_SCOPE)
  for (const row of rows) {
    if (row.chain !== "solana") continue
    const positions = lpPositionsSchema.parse(
      await lpRequest(ctx, key, `/api/v1/agent/lp/positions?linkedWalletId=${encodeURIComponent(row.id)}`),
    )
    if (positions.positions.some((held) => held.position === position))
      return completeTradingWallet(ctx, row, appId, LP_SCOPE, "solana", { apiKey: key, keyPrefix })
  }
  throw new TradingError(
    "LP_POSITION_NOT_FOUND",
    `No TEE wallet bound to this key holds position ${position}. See candle lp positions, or name the wallet with --wallet.`,
  )
}

/**
 * BE-355 (D4): a rate limit on the send, or on a status read after it (the client already retried
 * the read once), is the uncertain outcome: exit 3 with the saved signature, and nothing re-sent.
 * The resume path in `runLpOperation` confirms the saved signature on the next run.
 */
function postSignatureRateLimit(ctx: CommandContext, signature: string, id: string): TradingError {
  return new TradingError(
    "RPC_RATE_LIMITED",
    `${postSignatureRateLimitMessage(signature)} Re-run the same command with --client-trade-id ${id}: it confirms the saved signature and sends nothing new.`,
    { suggestion: postSignatureSuggestion(ctx), exitCode: 3 },
  )
}

/** Wait until the broadcast transaction is at least confirmed, which is what the server's `/confirm` reads. */
async function waitConfirmed(ctx: CommandContext, rpc: SolanaRpc, signature: string, id: string): Promise<void> {
  for (let i = 0; i < CONFIRM_MAX_POLLS; i++) {
    let status: Awaited<ReturnType<SolanaRpc["getSignatureStatus"]>>
    try {
      status = await rpc.getSignatureStatus(signature)
    } catch (error) {
      if (isRateLimited(error)) throw postSignatureRateLimit(ctx, signature, id)
      throw error
    }
    const observed = classifyStatus(status)
    if (observed.kind === "finalized") return
    if (observed.kind === "failed")
      throw new TradingError(
        "LP_TRANSACTION_FAILED",
        `Transaction ${signature} failed on chain: ${JSON.stringify(observed.err)}.`,
      )
    if (observed.kind === "nonfinal") {
      if (observed.err !== null && observed.err !== undefined)
        throw new TradingError(
          "LP_TRANSACTION_FAILED",
          `Transaction ${signature} failed: ${JSON.stringify(observed.err)}.`,
        )
      if (observed.confirmationStatus === "confirmed") return
    }
    await ctx.deps.sleep(CONFIRM_POLL_MS)
  }
  throw new TradingError(
    "LP_CONFIRM_PENDING",
    `Transaction ${signature} was sent but not confirmed within ${(CONFIRM_MAX_POLLS * CONFIRM_POLL_MS) / 1000}s. Re-run the same command with --client-trade-id ${id}: it confirms the saved signature and sends nothing new.`,
  )
}

interface LpPlan {
  action: LpAction
  id: string
  key: string
  wallet: TradingWallet
  solana: SolanaClient
  intent: string
  body: Json
  yes: boolean
}

async function confirmPreview(
  ctx: CommandContext,
  plan: LpPlan,
  built: ReturnType<typeof lpBuildSchema.parse>,
): Promise<boolean> {
  const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
  output.write(`${safeText(plan.intent)}\nPayer: ${safeText(plan.wallet.address)}\n`)
  output.write(`Pool: ${safeText(built.build.pool)}\nPosition: ${safeText(built.build.position)}\n`)
  const preview = built.preview
  const amounts = preview?.amounts ?? []
  if (amounts.length > 0) {
    const verb =
      plan.action === "add"
        ? "Deposit (maximum, at the pool's ratio)"
        : plan.action === "remove"
          ? "Withdraw (minimum)"
          : "Claim"
    output.write(`${verb}: ${amounts.map(amountLine).join(" + ")}\n`)
  }
  output.write(`Candle LP fee: ${safeText(preview?.candleFeeBps ?? 0)} bps\n`)
  for (const warning of preview?.warnings ?? []) output.write(`Warning: ${safeText(warning)}\n`)
  for (const risk of preview?.tokenRisks ?? [])
    output.write(`Warning (${safeText(risk.mint)}): ${safeText(risk.message)}\n`)
  if (built.replay) output.write("This client id was already built; the same artifact is shown again.\n")
  if (plan.yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError(
      "CONFIRMATION_REQUIRED",
      "Run interactively to confirm, or use --yes for an ordinary LP prompt.",
    )
  return (await ctx.deps.promptLine("Proceed? [y/N] ")).trim().toLowerCase() === "y"
}

async function runLpOperation(ctx: CommandContext, plan: LpPlan): Promise<number> {
  const { id, key, wallet, action } = plan
  const confirm = async (signature: string, extra: Json): Promise<number> => {
    const result = await lpRequest(ctx, key, "/api/v1/agent/lp/confirm", { clientTradeId: id, signature })
    return printTradingResult(ctx, {
      ...result,
      clientTradeId: id,
      kind: "lp",
      action,
      signature,
      wallet: safeText(wallet.address),
      ...extra,
    })
  }
  // A signature saved by an earlier run of this id: confirm it, send nothing new.
  const local = await savedOperation(ctx, key, id)
  if (local?.signature) return confirm(local.signature, { resumed: true })
  if (!local && !(await claimOperation(ctx, key, id, "lp")))
    throw new TradingError("OPERATION_ALREADY_STARTED", "This machine already started this id; no write was resent.")
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const built = lpBuildSchema.parse(
    await lpRequest(ctx, key, `/api/v1/agent/lp/${action}/build`, {
      linkedWalletId: wallet.id,
      clientTradeId: id,
      ...plan.body,
    }),
  )
  if (built.build.walletAddress !== wallet.address || built.build.action !== action)
    throw new TradingError(
      "INVALID_RESPONSE",
      "The LP build does not name the requested wallet and action; nothing was signed.",
    )
  // The server already holds a confirmation for this id (a replay after a crash between the
  // broadcast and the local record): confirm again, which is idempotent, rather than re-sign.
  if (built.build.signature) return confirm(built.build.signature, { resumed: true })
  const preview = {
    pool: built.build.pool,
    position: built.build.position,
    amounts: built.preview?.amounts ?? [],
    warnings: built.preview?.warnings ?? [],
    tokenRisks: built.preview?.tokenRisks ?? [],
    candleFeeBps: built.preview?.candleFeeBps ?? 0,
  }
  if (!(await confirmPreview(ctx, plan, built)))
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "lp",
      action,
      preview,
    })
  const signed = await relaySign(ctx, key, wallet, built.build.transaction)
  const signature = await saveOperationSignature(ctx, key, id, "lp", signed)
  const rpc = plan.solana.rpc
  let echoed: string
  try {
    echoed = await rpc.sendTransaction(signed)
  } catch (error) {
    if (isRateLimited(error)) throw postSignatureRateLimit(ctx, signature, id)
    throw error
  }
  if (echoed !== signature)
    throw new TradingError("RPC_FAILED", "RPC returned a different transaction signature; check the saved operation.")
  ctx.deps.stderr.write(`LP ${action} signature: ${signature}\n`)
  await waitConfirmed(ctx, rpc, signature, id)
  return confirm(signature, { preview })
}

function slippageOf(flag: string | undefined): number {
  const slippage = Number(flag ?? "100")
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 1000)
    throw new TradingError("INVALID_AMOUNT", "--slippage-bps must be an integer from 0 to 1000.")
  return slippage
}

// ── add ───────────────────────────────────────────────────────────────────────────────────────

export async function lpAdd(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--wallet", "--position", "--client-trade-id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `lp-${randomUUID()}`
  if (parsed.positionals.length !== 2 || !flags["--amount"] || !flags["--wallet"] || !validClientId(id))
    return usage(
      ctx,
      "Usage: candle lp add <pool> --amount <decimal> <token> --wallet <tee> [--position <nft-mint>] [--slippage-bps 100] [--client-trade-id <id>] [--rpc-url <url>] [--yes]",
    )
  try {
    const pool = solanaAddress(parsed.positionals[0] as string, "The pool")
    const token = poolToken(parsed.positionals[1] as string)
    const position = flags["--position"] ? solanaAddress(flags["--position"], "--position") : undefined
    rawAmount(flags["--amount"], 18)
    const slippageBps = slippageOf(flags["--slippage-bps"])
    const solana = await tradingSolanaClient(ctx, flags["--rpc-url"])
    const key = await tradingKey(ctx)
    const wallet = await tradingWallet(ctx, key, flags["--wallet"], LP_SCOPE)
    const decimals = await decimalsFor(ctx, baseAsset(token) ?? token, () => Promise.resolve(solana))
    const amountRaw = rawAmount(flags["--amount"], decimals)
    return await runLpOperation(ctx, {
      action: "add",
      id,
      key,
      wallet,
      solana,
      yes: parsed.booleans.has("--yes"),
      intent: `Add ${decimalAmount(amountRaw, decimals)} ${baseAsset(token) ?? token} of liquidity to DAMM v2 pool ${pool}${position ? ` (position ${position})` : " (new position)"}`,
      body: { pool, token, amountRaw, slippageBps, ...(position ? { position } : {}) },
    })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}

// ── remove ────────────────────────────────────────────────────────────────────────────────────

export async function lpRemove(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--percent", "--wallet", "--client-trade-id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `lp-${randomUUID()}`
  const percent = Number(flags["--percent"])
  if (
    parsed.positionals.length !== 1 ||
    !flags["--percent"] ||
    !/^\d+(\.\d{1,2})?$/.test(flags["--percent"]) ||
    !(percent > 0 && percent <= 100) ||
    !validClientId(id)
  )
    return usage(
      ctx,
      "Usage: candle lp remove <position> --percent <0.01-100> [--wallet <tee>] [--slippage-bps 100] [--client-trade-id <id>] [--rpc-url <url>] [--yes]",
    )
  try {
    const position = solanaAddress(parsed.positionals[0] as string, "The position")
    const slippageBps = slippageOf(flags["--slippage-bps"])
    const solana = await tradingSolanaClient(ctx, flags["--rpc-url"])
    const key = await tradingKey(ctx)
    const wallet = await walletHolding(ctx, key, position, flags["--wallet"])
    return await runLpOperation(ctx, {
      action: "remove",
      id,
      key,
      wallet,
      solana,
      yes: parsed.booleans.has("--yes"),
      intent:
        percent === 100
          ? `Remove all liquidity from position ${position}, claim its fees and close it (rent returns to the wallet)`
          : `Remove ${percent}% of the liquidity in position ${position}`,
      body: { position, percent, slippageBps },
    })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}

// ── claim ─────────────────────────────────────────────────────────────────────────────────────

export async function lpClaim(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--client-trade-id", "--rpc-url"],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `lp-${randomUUID()}`
  if (parsed.positionals.length !== 1 || !validClientId(id))
    return usage(
      ctx,
      "Usage: candle lp claim <position> [--wallet <tee>] [--client-trade-id <id>] [--rpc-url <url>] [--yes]",
    )
  try {
    const position = solanaAddress(parsed.positionals[0] as string, "The position")
    const solana = await tradingSolanaClient(ctx, flags["--rpc-url"])
    const key = await tradingKey(ctx)
    const wallet = await walletHolding(ctx, key, position, flags["--wallet"])
    return await runLpOperation(ctx, {
      action: "claim",
      id,
      key,
      wallet,
      solana,
      yes: parsed.booleans.has("--yes"),
      intent: `Claim the fees and any rewards of position ${position}`,
      body: { position },
    })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}
