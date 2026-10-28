import { randomUUID } from "node:crypto"
import { z } from "zod"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import {
  claimOperation,
  decimalAmount,
  type Json,
  rawAmount,
  relaySign,
  request,
  safeText,
  savedOperation,
  saveOperationSignature,
  saveStakingRequest,
  TradingError,
  tradingKey,
  tradingWallet,
} from "../trading"
import { printTradingResult, tradingFailure, validClientId } from "./swap"

const withdrawal = z
  .object({ withdrawal: z.string(), amountRaw: z.string(), endTime: z.string(), claimable: z.boolean() })
  .passthrough()
const positionsSchema = z.object({
  success: z.literal(true),
  pool: z
    .object({ withdrawalTimelockSeconds: z.number(), paused: z.boolean(), maxActiveWithdrawals: z.number() })
    .nullable(),
  notes: z.array(z.string()),
  wallets: z.array(
    z
      .object({
        payer: z.enum(["main", "linked"]),
        address: z.string(),
        linkedWalletId: z.string().optional(),
        label: z.string().nullable().optional(),
        tee: z.boolean().optional(),
        cndl: z.object({ amountRaw: z.string(), decimals: z.number().int() }).passthrough(),
        staked: z.object({ amountRaw: z.string(), decimals: z.number().int() }).passthrough(),
        pendingWithdrawalRaw: z.string(),
        withdrawals: z.object({ active: z.array(withdrawal), finished: z.array(withdrawal) }),
        unclaimedRewards: z.array(
          z.object({ rewardId: z.string(), amountRaw: z.string(), mint: z.string() }).passthrough(),
        ),
      })
      .passthrough(),
  ),
})
type Position = z.infer<typeof positionsSchema>["wallets"][number]
const ROOT = "/api/v1/agent/staking"

function selected(wallets: Position[], name?: string): Position[] {
  if (name === undefined) return wallets
  const matches = wallets.filter(
    (w) =>
      ((name === "main" || name === "embedded") && w.payer === "main") ||
      w.address === name ||
      w.linkedWalletId === name ||
      w.label === name,
  )
  if (matches.length !== 1)
    throw new TradingError(
      "STAKING_WALLET_REQUIRED",
      "--wallet must name one eligible Solana wallet by main, id, address or label. See candle stake.",
    )
  return matches
}

async function approval(ctx: CommandContext, message: string, yes: boolean): Promise<boolean> {
  ;(ctx.json ? ctx.deps.stderr : ctx.deps.stdout).write(`${message}\n`)
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or pass --yes.")
  return (await ctx.deps.promptLine("Proceed? [y/N] ")).trim().toLowerCase() === "y"
}

export async function stake(args: string[], ctx: CommandContext): Promise<number> {
  return runStake("positions", args, ctx)
}
export const stakeAdd = (args: string[], ctx: CommandContext) => runStake("stake", args, ctx)
export const stakeRemove = (args: string[], ctx: CommandContext) => runStake("unstake", args, ctx)
export const stakeFinish = (args: string[], ctx: CommandContext) => runStake("finish", args, ctx)
export const stakeClaim = (args: string[], ctx: CommandContext) => runStake("claim", args, ctx)

async function runStake(
  action: "positions" | "stake" | "unstake" | "finish" | "claim",
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--client-stake-id"],
    booleanFlags: ["--yes", ...(action === "claim" ? ["--all"] : [])],
  })
  const usage =
    "Usage: candle stake [add <amount> | remove <amount> | finish [<withdrawal>] | claim <rewardId> | claim --all] [--wallet <main|id|address|label>] [--client-stake-id <id>] [--yes] [--json]"
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const { values, positionals, booleans } = parsed
  const id = values["--client-stake-id"] ?? `stake-${randomUUID()}`
  const all = booleans.has("--all")
  if (
    !validClientId(id) ||
    id.length > 128 ||
    (action === "positions"
      ? positionals.length !== 0
      : action === "finish"
        ? positionals.length > 1
        : action === "claim"
          ? all
            ? positionals.length !== 0
            : positionals.length !== 1
          : positionals.length !== 1)
  ) {
    writeUsageFailure(ctx.deps, usage, ctx.json)
    return 2
  }
  try {
    if (action === "stake" || action === "unstake") rawAmount(positionals[0] as string, 18)
    const key = await tradingKey(ctx)
    // A saved signed transaction resumes by posting those bytes to /submit again. Do not rebuild or re-sign.
    if (!["positions", "claim"].includes(action)) {
      const saved = await savedOperation(ctx, key, id)
      if (saved && saved.kind !== "stake")
        throw new TradingError("IDEMPOTENCY_CONFLICT", "This local id names another kind of operation.")
      // The signed bytes are on disk: /submit reads the chain for the signature before it sends,
      // so posting them again lands the same transaction once. Without them only /confirm is left.
      if (saved?.signature && saved.signedTransaction)
        return printTradingResult(ctx, {
          ...(await request(ctx, key, `${ROOT}/submit`, {
            clientStakeId: id,
            signedTransaction: saved.signedTransaction,
          })),
          resumed: true,
        })
      if (saved?.signature)
        return printTradingResult(ctx, {
          ...(await request(ctx, key, `${ROOT}/confirm`, { clientStakeId: id, signature: saved.signature })),
          resumed: true,
        })
      if (saved?.stakingRequest) {
        const intent = saved.stakingRequest
        if (intent.action !== action)
          throw new TradingError("IDEMPOTENCY_CONFLICT", "The saved staking id names a different action.")
        // Embedded builds already hold the original bytes/signature server-side. A replay
        // precedes dryRun: after a successful stake the old input balance may be gone.
        if (intent.body.payer === "main") {
          // The server refuses a reused id with other input only for linked wallets, so compare here.
          const view = positionsSchema.parse(await request(ctx, key, ROOT))
          const candidates = values["--wallet"]
            ? selected(view.wallets, values["--wallet"])
            : view.wallets.filter((w) => w.payer === "main")
          const wallet = candidates.length === 1 ? (candidates[0] as Position) : undefined
          const sameAmount =
            action === "finish"
              ? positionals[0] === undefined || positionals[0] === intent.body.withdrawal
              : wallet !== undefined &&
                intent.body.amountRaw ===
                  rawAmount(
                    positionals[0] as string,
                    action === "stake" ? wallet.cndl.decimals : wallet.staked.decimals,
                  )
          if (wallet?.payer !== "main" || !sameAmount)
            throw new TradingError(
              "IDEMPOTENCY_CONFLICT",
              "This client stake id was used with a different wallet or amount. Use a new id.",
            )
          return printTradingResult(ctx, {
            ...(await request(ctx, key, `${ROOT}/${intent.action}/build`, intent.body)),
            resumed: true,
          })
        }
      }
    }
    const view = positionsSchema.parse(await request(ctx, key, ROOT))
    const wallets = selected(view.wallets, values["--wallet"])
    if (action === "positions") {
      if (ctx.json) return printTradingResult(ctx, { ...view, wallets })

      writeFields(ctx.deps, "stdout", [
        [
          "Pool wait",
          view.pool?.withdrawalTimelockSeconds === undefined
            ? undefined
            : `${view.pool.withdrawalTimelockSeconds} seconds`,
        ],
      ])
      for (const w of wallets) {
        writeFields(ctx.deps, "stdout", [
          ["Wallet", safeText(w.label ?? w.payer)],
          ["Address", safeText(w.address)],
          ["CNDL", decimalAmount(w.cndl.amountRaw, w.cndl.decimals)],
          ["sCNDL", decimalAmount(w.staked.amountRaw, w.staked.decimals)],
          ["Pending CNDL (raw)", safeText(w.pendingWithdrawalRaw)],
        ])
        for (const row of w.withdrawals.active)
          writeFields(ctx.deps, "stdout", [
            ["Withdrawal", safeText(row.withdrawal)],
            ["CNDL (raw)", safeText(row.amountRaw)],
            ["Ends", safeText(row.endTime)],
            ["Status", row.claimable ? "ready" : "waiting"],
          ])
        for (const reward of w.unclaimedRewards)
          writeFields(ctx.deps, "stdout", [
            ["Reward", safeText(reward.rewardId)],
            ["Raw amount", safeText(reward.amountRaw)],
            ["Mint", safeText(reward.mint)],
          ])
      }
      for (const note of view.notes) notice(ctx.deps, "stdout", "note", safeText(note))
      return 0
    }
    const notes = view.notes.map(safeText).join("\n")
    if (action === "claim") {
      const rewards = wallets.flatMap((w) => w.unclaimedRewards.map((r) => ({ ...r, owner: w.address })))
      // A specific reward may already be paid: the server verifies its owner and returns the saved signature.
      const ids = all ? rewards.map((r) => r.rewardId) : [positionals[0] as string]
      if (!all && values["--wallet"] && !rewards.some((r) => r.rewardId === ids[0]))
        throw new TradingError(
          "STAKING_REWARD_NOT_OWNED",
          "The reward is not listed for --wallet. Omit --wallet to resolve an already paid reward.",
        )
      if (
        !(await approval(
          ctx,
          `MOVES REAL FUNDS: claim ${ids.length} reward(s) to their recorded owners.\n${rewards
            .filter((r) => ids.includes(r.rewardId))
            .map(
              (r) =>
                `${safeText(r.rewardId)} -> ${safeText(r.owner)} (${safeText(r.amountRaw)} raw ${safeText(r.mint)})`,
            )
            .join("\n")}\n${notes}`,
          booleans.has("--yes"),
        ))
      )
        return printTradingResult(ctx, { success: true, status: "cancelled" })
      const results: Json[] = []
      for (const rewardId of ids)
        results.push(await request(ctx, key, `${ROOT}/rewards/${encodeURIComponent(rewardId)}/claim`, {}))
      return printTradingResult(ctx, { success: true, rewards: results })
    }
    const candidates = values["--wallet"] ? wallets : wallets.filter((w) => w.payer === "main")
    if (candidates.length !== 1)
      throw new TradingError("STAKING_WALLET_REQUIRED", "Name one wallet with --wallet. See candle stake.")
    const wallet = candidates[0] as Position
    const body: Json = {
      payer: wallet.payer,
      ...(wallet.payer === "linked" ? { linkedWalletId: wallet.linkedWalletId } : {}),
      clientStakeId: id,
    }
    if (action === "finish") {
      const ready = wallet.withdrawals.active.filter((w) => w.claimable)
      const address = positionals[0] ?? (ready.length === 1 ? ready[0]?.withdrawal : undefined)
      if (!address)
        throw new TradingError(
          "STAKING_WITHDRAWAL_REQUIRED",
          "Name a withdrawal; omission requires exactly one matured withdrawal in the selected wallet.",
        )
      body.withdrawal = address
    } else
      body.amountRaw = rawAmount(
        positionals[0] as string,
        action === "stake" ? wallet.cndl.decimals : wallet.staked.decimals,
      )
    // Resolve the relay signer before reserving an id or creating a build.
    const signer =
      wallet.payer === "linked" ? await tradingWallet(ctx, key, wallet.linkedWalletId as string, "swap:write") : null
    const preview = await request(ctx, key, `${ROOT}/${action}/build`, { ...body, dryRun: true })
    if (
      preview.wallet !== wallet.address ||
      preview.action !== action ||
      preview.clientStakeId !== id ||
      preview.dryRun !== true
    )
      throw new TradingError("INVALID_RESPONSE", "The preview does not match the requested wallet and operation.")
    writeFields(ctx.deps, "stderr", [["Operation", id]])
    if (
      !(await approval(
        ctx,
        `MOVES REAL FUNDS: ${action} from ${safeText(wallet.address)}; amount ${safeText(preview.amountRaw)} raw units.\nPool wait: ${view.pool?.withdrawalTimelockSeconds ?? "unavailable"} seconds.\nSOL costs and reserve (lamports): ${safeText(JSON.stringify(preview.figures))}\n${notes}`,
        booleans.has("--yes"),
      ))
    )
      return printTradingResult(ctx, { success: true, status: "cancelled", clientStakeId: id })
    const saved = await savedOperation(ctx, key, id)
    if (!saved && !(await claimOperation(ctx, key, id, "stake")))
      throw new TradingError(
        "OPERATION_ALREADY_STARTED",
        "This machine already started this id; retry with the same id.",
      )
    await saveStakingRequest(ctx, key, id, action, body)
    const built = await request(ctx, key, `${ROOT}/${action}/build`, body)
    if (built.wallet !== wallet.address || built.action !== action || built.clientStakeId !== id)
      throw new TradingError(
        "INVALID_RESPONSE",
        "The build does not match the requested wallet and operation; nothing was signed.",
      )
    if (built.status === "confirmed") return printTradingResult(ctx, built)
    if (!signer || built.status !== "built" || typeof built.transaction !== "string")
      throw new TradingError("INVALID_RESPONSE", "Expected a linked wallet build or embedded confirmation.")
    const signed = await relaySign(ctx, key, signer, built.transaction)
    await saveOperationSignature(ctx, key, id, "stake", signed, true)
    return printTradingResult(
      ctx,
      await request(ctx, key, `${ROOT}/submit`, { clientStakeId: id, signedTransaction: signed }),
    )
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
