/**
 * The two reads that may cost a per-use x402 payment (spec 7.2, 7.4 and 10.1): token forensics past
 * the free rate, and the vamp finder without a key or past a Free account's daily allowance. Each
 * is an ordinary read until the API answers a payable 402; then `paidRequest` pays inside the local
 * spending rules or prints the price and stops (`packages/cli/src/x402/pay.ts`). With the API's
 * `X402_PER_USE` off nothing is ever charged and these behave as plain reads.
 *
 * A configured API key is sent when there is one: the key's account is credited for the payment and
 * its credits are drawn first (5.1 rule 1, 3.7).
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { ApiResult } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { resolveSolanaEndpoint, solanaClientFor } from "../solana-endpoint"
import { createSolanaRpc } from "../solana-lite"
import { type PaidCallResult, paidRequest } from "../x402/pay"
import { DEVNET_RPC_URL, SOLANA_DEVNET, type X402ClientNetwork } from "../x402/select"
import { spendPaths } from "../x402/spend-log"
import { vaultPayer } from "../x402/vault-payer"
import { runVaultCommand } from "./vault-support"

const PAY_FLAGS = ["--wallet"]
const PAY_BOOLEANS = ["--yes"]

/** A recent blockhash on the payment's network: the CLI's own RPC on mainnet, public devnet on devnet. */
function blockhashFor(ctx: CommandContext) {
  return async (network: X402ClientNetwork): Promise<string> => {
    if (network === SOLANA_DEVNET) {
      return createSolanaRpc(DEVNET_RPC_URL, ctx.deps.fetch, ctx.deps.sleep).getLatestBlockhash()
    }
    const endpoint = resolveSolanaEndpoint(ctx, undefined, await ctx.deps.readConfig())
    if ("error" in endpoint) throw new Error(endpoint.error)
    const solana = solanaClientFor(ctx, endpoint)
    return solana.read(() => solana.rpc.getLatestBlockhash())
  }
}

function paymentLine(paid: PaidCallResult): string | null {
  if (paid.servedFromCredit) return "Served from this wallet's Candle credit; nothing was paid."
  const p = paid.payment
  if (!p) return null
  switch (p.state) {
    case "settled":
      return `Paid ${p.amountUsdc} USDC from ${p.payer}${p.signature ? ` (${p.signature})` : ""}.`
    case "credited":
      return `Paid ${p.amountUsdc} USDC, and the call failed: Candle credited it to your balance (candle spend shows it).`
    case "failed":
      return `The payment of ${p.amountUsdc} USDC did not go through (${p.reason ?? "refused"}); nothing moved.`
    default:
      return `Whether the payment of ${p.amountUsdc} USDC settled is not known yet (${p.reason ?? "no answer"}). It counts toward today's limit until candle spend resolves it.`
  }
}

async function runPaidRead(
  ctx: CommandContext,
  input: { path: string; kind: string; wallet?: string; yes: boolean },
): Promise<number> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  return runVaultCommand(ctx, async () => {
    const paid = await paidRequest({
      path: input.path,
      request: {
        apiUrl: ctx.apiUrl,
        auth: apiKey ? "key" : "none",
        credentials: apiKey ? { apiKey } : {},
        env: ctx.deps.env,
        fetch: ctx.deps.fetch,
      },
      kind: input.kind,
      paths: spendPaths(ctx.deps.env, ctx.deps.homedir(), ctx.profile),
      payer: vaultPayer(ctx, { ...(input.wallet !== undefined ? { wallet: input.wallet } : {}), yes: input.yes }),
      blockhash: blockhashFor(ctx),
      env: ctx.deps.env,
      now: ctx.deps.now,
      newId: randomUUID,
    })
    const line = paymentLine(paid)
    if (line && !ctx.json) ctx.deps.stderr.write(`${line}\n`)
    if (paid.refusal) {
      writeLocalFailure(
        ctx.deps,
        {
          code: paid.refusal.code,
          message: paid.refusal.message,
          ...(paid.refusal.suggestion ? { suggestion: paid.refusal.suggestion } : {}),
          ...(paid.refusal.priceUsdc ? { details: { priceUsdc: paid.refusal.priceUsdc } } : {}),
        },
        ctx.json,
      )
      return 1
    }
    const result: ApiResult = paid.result
    if (!result.ok) {
      if (ctx.json && paid.payment) {
        ctx.deps.stdout.write(
          `${JSON.stringify({ ok: false, code: result.code ?? `HTTP_${result.status}`, status: result.status, message: result.message, payment: paid.payment })}\n`,
        )
      } else {
        writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: apiKey ? "key" : "none" }, ctx.json)
      }
      return 1
    }
    const body = result.body as { data?: unknown } | null
    const data = body && typeof body === "object" && "data" in body ? body.data : body
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify({ ok: true, data, ...(paid.payment ? { payment: paid.payment } : {}), ...(paid.servedFromCredit ? { servedFromCredit: true } : {}) })}\n`,
      )
    } else {
      ctx.deps.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    }
    return 0
  })
}

/** `candle token forensics <mint> [--chain solana|hood] [--wallet <vault key>] [--yes] [--json]` */
export async function tokenForensics(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain", ...PAY_FLAGS], booleanFlags: PAY_BOOLEANS })
  const chain = "error" in parsed ? undefined : (parsed.values["--chain"] ?? "solana")
  if ("error" in parsed || parsed.positionals.length !== 1 || (chain !== "solana" && chain !== "hood")) {
    writeUsageFailure(
      ctx.deps,
      "Usage: candle token forensics <mint> [--chain solana|hood] [--wallet <vault key>] [--yes]",
      ctx.json,
    )
    return 2
  }
  const mint = parsed.positionals[0] as string
  return runPaidRead(ctx, {
    path: `/api/v1/markets/${chain}/${encodeURIComponent(mint)}/forensics`,
    kind: "forensics",
    ...(parsed.values["--wallet"] !== undefined ? { wallet: parsed.values["--wallet"] } : {}),
    yes: parsed.booleans.has("--yes"),
  })
}

const VAMP_STAGES = ["final_stretch", "graduated", "all"]

/**
 * `candle token vamp-candidates [--limit <n>] [--min-copies <n>] [--stage final_stretch|graduated|all]
 * [--wallet <vault key>] [--yes] [--json]`
 */
export async function tokenVampCandidates(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--limit", "--min-copies", "--stage", ...PAY_FLAGS],
    booleanFlags: PAY_BOOLEANS,
  })
  const usageLine =
    "Usage: candle token vamp-candidates [--limit <n>] [--min-copies <n>] [--stage final_stretch|graduated|all] [--wallet <vault key>] [--yes]"
  if ("error" in parsed || parsed.positionals.length !== 0) {
    writeUsageFailure(ctx.deps, "error" in parsed ? parsed.error : usageLine, ctx.json)
    return 2
  }
  const limit = parsed.values["--limit"]
  const minCopies = parsed.values["--min-copies"]
  const stage = parsed.values["--stage"]
  if (
    (limit !== undefined && !/^[1-9][0-9]*$/.test(limit)) ||
    (minCopies !== undefined && !/^[0-9]+$/.test(minCopies)) ||
    (stage !== undefined && !VAMP_STAGES.includes(stage))
  ) {
    writeUsageFailure(ctx.deps, usageLine, ctx.json)
    return 2
  }
  const query = new URLSearchParams()
  if (limit !== undefined) query.set("limit", limit)
  if (minCopies !== undefined) query.set("minCopies24h", minCopies)
  if (stage !== undefined) query.set("stage", stage)
  const search = query.toString()
  return runPaidRead(ctx, {
    path: `/api/v1/markets/vamp-candidates${search ? `?${search}` : ""}`,
    kind: "vamp",
    ...(parsed.values["--wallet"] !== undefined ? { wallet: parsed.values["--wallet"] } : {}),
    yes: parsed.booleans.has("--yes"),
  })
}
