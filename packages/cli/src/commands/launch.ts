import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeUsageFailure } from "../render"
import { createSolanaRpc } from "../solana-lite"
import {
  claimOperation,
  confirmQuote,
  launchBuildSchema,
  relaySign,
  request,
  rpcUrl,
  savedOperation,
  saveOperationSignature,
  TradingError,
  tradingKey,
  tradingWallet,
} from "../trading"
import { lookupOperation, printTradingResult, tradingFailure, validClientId } from "./swap"

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
    !validClientId(id)
  ) {
    writeUsageFailure(
      ctx.deps,
      "Usage: candle launch --name <name> --symbol <symbol> --image-url <https-url> --wallet <tee> [--client-trade-id <id>] [--rpc-url <url>] [--quote-asset sol|usdc|cndl] [--mode <mode>] [--yes]",
      ctx.json,
    )
    return 2
  }
  try {
    const key = await tradingKey(ctx)
    const prior = await lookupOperation(ctx, key, id, "launch")
    if (prior) {
      const local = await savedOperation(ctx, key, id)
      if (local?.signature && prior.job?.status !== "confirmed" && prior.job?.status !== "failed") {
        const result = await request(ctx, key, "/api/v1/launch/self/confirm", {
          clientLaunchId: id,
          signature: local.signature,
        })
        return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch" })
      }
      return printTradingResult(ctx, prior)
    }
    const url = rpcUrl(ctx, flags["--rpc-url"])
    const wallet = await tradingWallet(ctx, key, flags["--wallet"], "launch:write")
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
        buyAmount: 0,
        name: flags["--name"],
        symbol: flags["--symbol"],
        imageUrl: flags["--image-url"],
        linkedWalletId: wallet.id,
        ...(flags["--description"] ? { description: flags["--description"] } : {}),
        ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"] } : {}),
        ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
      }),
    )
    if (!built.transaction || !/^\d+$/.test(built.maxDebitLamports ?? ""))
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle did not return a launch transaction and maximum debit; nothing was signed.",
      )
    const quote = {
      intent: `Launch ${flags["--name"]} (${flags["--symbol"]})`,
      wallet: wallet.address,
      venue: "curve launch",
      priceImpactPct: null,
      fee: built.fee ?? { bps: 0, feeRaw: "0" },
      minimumReceived: "0 tokens (no first buy)",
      maxDebitLamports: built.maxDebitLamports,
      tokenRisks: [],
    }
    ctx.deps.stderr.write(
      "Launch creates the token only. Make the first buy with a separate candle swap. Price impact does not apply to creation.\n",
    )
    if (!(await confirmQuote(ctx, quote, parsed.booleans.has("--yes"))))
      return printTradingResult(ctx, { success: true, status: "cancelled", clientTradeId: id, kind: "launch", quote })
    if (!Number.isFinite(built.expiresAt) || built.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The launch build expired before signing.")
    const signed = await relaySign(ctx, key, wallet, built.transaction)
    const signature = await saveOperationSignature(ctx, key, id, "launch", signed)
    const broadcastSignature = await createSolanaRpc(url, ctx.deps.fetch).sendTransaction(signed)
    if (broadcastSignature !== signature)
      throw new TradingError("RPC_FAILED", "RPC returned a different transaction signature; check the saved operation.")
    ctx.deps.stderr.write(`Launch signature: ${signature}\n`)
    const result = await request(ctx, key, "/api/v1/launch/self/confirm", { clientLaunchId: id, signature })
    return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch", quote })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}
