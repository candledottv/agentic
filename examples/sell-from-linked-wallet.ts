#!/usr/bin/env bun
/**
 * sell-from-linked-wallet: sells a Candle-launched token from an agent's linked wallet, using
 * @candledottv/agent-sdk's one-shot trade(). The SDK builds the trade against the Candle API,
 * signs it locally with the linked wallet's own P-256 signer key (Candle never sees that key,
 * whichever SecretStore holds it), and (Solana) submits the signed transaction server-side in
 * one call. See docs/agent-trading.md and docs/headless-launch.md ("Self-signed launches" /
 * linked-wallet signing) at docs.candle.tv for the full model this wraps.
 *
 * Run: `bun run examples/sell-from-linked-wallet.ts`, or any Node 18+ runtime that can execute
 * TypeScript directly (tsx, ts-node, `node --experimental-strip-types`); the SDK itself has
 * near-zero runtime dependencies.
 *
 * Required environment variables:
 *   CANDLE_AGENT_API_KEY  Agent API key (cndl_live_... / cndl_test_...), needs the swap:write scope.
 *   CANDLE_API_URL        Base URL of the Candle API, e.g. https://api.candle.tv.
 *   PRIVY_APP_ID          Candle's Privy app id (a PUBLIC identifier, not a secret) -- must match
 *                         the app id the sign relay authenticates under, or Privy rejects the
 *                         forwarded signature as SIGNER_MISMATCH.
 *   LINKED_WALLET_ID      The linked wallet's row id (from importWallet(), or GET /api/v1/agent/wallets).
 *   PRIVY_WALLET_ID       That same wallet's Privy wallet id (also from importWallet()'s result).
 *   SIGNER_PEM_PATH       Path to the linked wallet's P-256 signer private-key PEM file on disk.
 *   MINT                  The token mint to sell.
 *   AMOUNT_RAW            How much to sell, in the token's raw base units, as a decimal string.
 */

import { readFile } from "node:fs/promises"
import { CandleApiError, CandleClient, InMemorySecretStore } from "@candledottv/agent-sdk"

/** The API defaults to 100 bps (1%) when maxSlippageBps is omitted; set explicitly so this example is unambiguous. Tune to taste. */
const DEFAULT_MAX_SLIPPAGE_BPS = 100

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const apiKey = requireEnv("CANDLE_AGENT_API_KEY")
  const apiUrl = requireEnv("CANDLE_API_URL")
  const privyAppId = requireEnv("PRIVY_APP_ID")
  const linkedWalletId = requireEnv("LINKED_WALLET_ID")
  const privyWalletId = requireEnv("PRIVY_WALLET_ID")
  const signerPemPath = requireEnv("SIGNER_PEM_PATH")
  const mint = requireEnv("MINT")
  const amountRaw = requireEnv("AMOUNT_RAW")

  // Load the linked wallet's signer key into an in-memory SecretStore, keyed by linkedWalletId
  // (the same ref trade() looks it up under). The PEM never leaves this process: it is read once
  // here and used locally to compute a Privy authorization signature, never sent to Candle.
  const signerPem = await readFile(signerPemPath, "utf8")
  const secretStore = new InMemorySecretStore()
  await secretStore.set(linkedWalletId, signerPem)

  const client = new CandleClient({ apiUrl, apiKey, privyAppId, secretStore })

  const result = await client.trade({
    mint,
    side: "sell",
    amountRaw,
    from: { linkedWalletId, privyWalletId },
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
  })

  console.log("Sell executed:")
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error: unknown) => {
  if (error instanceof CandleApiError) {
    console.error(`Candle API error (${error.code}, HTTP ${error.status}): ${error.message}`)
  } else if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
