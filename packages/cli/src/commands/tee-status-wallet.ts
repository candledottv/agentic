import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { sameEvmAddress } from "../evm-lite"
import { apiKeyPrefix } from "../profiles"
import { listTradingWallets, TradingError } from "../trading"

export const UNVERIFIED_KEY_LINE = "Key not verified on this machine. Pass --verify to open the vault and check it."

/** A read under the selected key, without touching the vault or Phase 1 keystore. */
export async function serverTeeWallet(ctx: CommandContext, address: string, chain: "solana" | "evm") {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  const suggestion = "Pass --verify to read it from this machine's vault, or select the profile holding its key."
  if (!apiKey) throw new TradingError("TEE_WALLET_NOT_ON_KEY", `${address}: no API key available.`, { suggestion })
  const { rows } = await listTradingWallets(ctx, apiKey)
  const row = rows.find(
    (candidate) =>
      candidate.chain === chain &&
      (chain === "evm" ? sameEvmAddress(candidate.address, address) : candidate.address === address),
  )
  if (!row)
    throw new TradingError(
      "TEE_WALLET_NOT_ON_KEY",
      `${address} is not a TEE wallet bound to key ${apiKeyPrefix(apiKey) ?? "this key"}.`,
      { suggestion },
    )
  return { row, apiKey }
}
