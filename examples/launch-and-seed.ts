#!/usr/bin/env bun
/**
 * launch-and-seed: launches a token seeded with an initial dev buy bundled into the launch
 * transaction itself, reads the fresh market, then optionally tops the position up with a
 * follow-up trade. Uses @candledottv/agent-sdk's launch() and trade({ from: "main" }): both
 * execute server-side through the account's own Privy-delegated embedded wallet, so no wallet
 * key ever appears here. See docs.candle.tv (headless launches / agent trading) for the model.
 *
 * Run: `bun run examples/launch-and-seed.ts`, or any Node 18+ runtime that can execute
 * TypeScript directly (tsx, ts-node, `node --experimental-strip-types`).
 *
 * Config is entirely environment-driven; nothing here is hardcoded and nothing here is a secret.
 *
 * Required env:
 *   CANDLE_AGENT_API_KEY   Agent key with launch:write and swap:write scopes
 *                          (cndl_live_... / cndl_test_...)
 *   TOKEN_NAME             Token name for the launch
 *   TOKEN_SYMBOL           Token symbol
 *   TOKEN_IMAGE_URL        https URL to a roughly square token image
 *
 * Optional env:
 *   CANDLE_API_URL         Base URL of the Candle API. Defaults to https://api.candle.tv
 *   CLIENT_LAUNCH_ID       Idempotency key for the launch; a fresh id is generated when unset
 *   DEV_BUY_SOL            Decimal SOL amount to seed the launch with, e.g. "0.05".
 *                          No dev buy is sent when unset.
 *   TOP_UP_SOL             Decimal SOL amount for a follow-up buy after the launch.
 *                          Skipped when unset.
 *
 * Run:
 *   CANDLE_AGENT_API_KEY=cndl_live_... TOKEN_NAME="My Token" TOKEN_SYMBOL=MTK \
 *   TOKEN_IMAGE_URL=https://example.com/token.png DEV_BUY_SOL=0.05 TOP_UP_SOL=0.1 \
 *   bun run examples/launch-and-seed.ts
 */
import { CandleClient } from "@candledottv/agent-sdk"

// -- Step 1: read config from the environment. No secrets in code, nothing hardcoded. ---------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const apiUrl = process.env.CANDLE_API_URL?.trim() || "https://api.candle.tv"
const apiKey = requireEnv("CANDLE_AGENT_API_KEY")
const name = requireEnv("TOKEN_NAME")
const symbol = requireEnv("TOKEN_SYMBOL")
const imageUrl = requireEnv("TOKEN_IMAGE_URL")
const clientLaunchId = process.env.CLIENT_LAUNCH_ID?.trim() || undefined
const devBuySol = process.env.DEV_BUY_SOL?.trim() || undefined
const topUpSol = process.env.TOP_UP_SOL?.trim() || undefined

// -- Step 2: SOL has 9 decimals. The SDK's LaunchRequest.buyAmount and TradeRequest.amountRaw
// both want RAW quote-asset base units (lamports for SOL), unlike the MCP server's
// candle_launch_and_seed/candle_trade tools, whose decimal `devBuy`/`amount` fields do this
// conversion server-side for you. Convert with plain BigInt string math, never a float, so a
// rounding error can never seed or trade a different size than intended. ----------------------

const SOL_DECIMALS = 9

function solToLamports(decimalSol: string): string {
  if (!/^\d+(\.\d+)?$/.test(decimalSol)) {
    throw new Error(`expected a plain positive decimal SOL amount, got "${decimalSol}"`)
  }
  const [whole, fraction = ""] = decimalSol.split(".")
  if (fraction.length > SOL_DECIMALS) {
    throw new Error(`too many decimal places for SOL (max ${SOL_DECIMALS}), got "${decimalSol}"`)
  }
  return BigInt(whole + fraction.padEnd(SOL_DECIMALS, "0")).toString()
}

// -- Step 3: construct the client. No wallet private key here: launch() and
// trade({ from: "main" }) both execute through the account's own Privy-delegated embedded
// wallet, server-side. The SDK never signs anything on this path. -------------------------------

const client = new CandleClient({ apiUrl, apiKey })

async function main() {
  // -- Step 4: launch, optionally seeded with a dev buy bundled into the launch transaction
  // itself. launch() blocks until the launch is confirmed (or a non-retryable failure), retrying
  // idempotent failures under the same clientLaunchId automatically. --------------------------
  const launchResult = await client.launch({
    ...(clientLaunchId ? { clientLaunchId } : {}),
    name,
    symbol,
    imageUrl,
    ...(devBuySol ? { buyAmount: solToLamports(devBuySol) } : {}),
  })
  console.log(`Launched ${launchResult.mint} on ${launchResult.chain}: ${launchResult.links.candle}`)

  // -- Step 5: read the fresh market state. ------------------------------------------------
  const market = await client.getMarket(launchResult.chain, launchResult.mint)
  console.log(`Market lifecycle: ${market.lifecycle}, buys open: ${market.buysOpen}`)

  // -- Step 6: optional top-up buy through the trade rail, same "main" wallet, same account. ---
  if (topUpSol) {
    const tradeResult = await client.trade({
      clientTradeId: `${launchResult.mint}-top-up`,
      mint: launchResult.mint,
      side: "buy",
      amountRaw: solToLamports(topUpSol),
      from: "main",
    })
    console.log(`Top-up buy executed: ${tradeResult.signature}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
