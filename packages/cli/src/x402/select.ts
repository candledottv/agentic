/**
 * Which x402 requirement this CLI can pay (spec 10.2 `select.ts`, 10.3 rule 4): `exact` on the
 * Solana network the CLI is configured for, in that network's USDC, to the pay-to address pinned
 * for that network. Anything else is refused with what was offered, and nothing is signed.
 *
 * The network is mainnet unless `CANDLE_X402_NETWORK=devnet` (tests and staging). The pay-to is
 * pinned in the CLI, so a man-in-the-middle 402 cannot redirect a payment; only devnet takes an
 * override, `CANDLE_X402_PAY_TO`. Mainnet's pin is Candle's receive address (decision A10), which
 * this build does not carry: until a release pins it here, a mainnet 402 is shown and never paid.
 */
import { decodePubkey } from "../solana-lite"
import type { PaymentRequired, PaymentRequirements } from "./codec"

export const NETWORK_ENV = "CANDLE_X402_NETWORK"
export const PAY_TO_ENV = "CANDLE_X402_PAY_TO"

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

/** USDC per network: Circle's mainnet mint, and the devnet mint the x402.org testnet facilitator settles. */
export const USDC_MINTS = {
  [SOLANA_MAINNET]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  [SOLANA_DEVNET]: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const

/** Mainnet's pinned pay-to. Null in this build: mainnet payments stay off until it is pinned. */
export const MAINNET_PAY_TO: string | null = null

/** The public devnet RPC, for a devnet payment's blockhash. Mainnet uses the CLI's own RPC. */
export const DEVNET_RPC_URL = "https://api.devnet.solana.com"

export type X402ClientNetwork = typeof SOLANA_MAINNET | typeof SOLANA_DEVNET

export interface NetworkConfig {
  network: X402ClientNetwork
  asset: string
  /** The only address this CLI pays on this network, or null when none is pinned. */
  payTo: string | null
}

function isAddress(value: string): boolean {
  try {
    decodePubkey(value)
    return true
  } catch {
    return false
  }
}

/** The configured network, or why the configuration is unusable. */
export function networkConfig(
  env: Record<string, string | undefined>,
): { ok: true; config: NetworkConfig } | { ok: false; message: string } {
  const raw = env[NETWORK_ENV]?.trim() ?? ""
  let network: X402ClientNetwork
  if (raw === "" || raw === "mainnet" || raw === SOLANA_MAINNET) network = SOLANA_MAINNET
  else if (raw === "devnet" || raw === SOLANA_DEVNET) network = SOLANA_DEVNET
  else return { ok: false, message: `${NETWORK_ENV} must be mainnet or devnet, not "${raw}".` }
  const override = env[PAY_TO_ENV]?.trim() ?? ""
  if (network === SOLANA_MAINNET) {
    if (override !== "") {
      return { ok: false, message: `${PAY_TO_ENV} is for devnet tests only; mainnet pays its pinned address.` }
    }
    return { ok: true, config: { network, asset: USDC_MINTS[network], payTo: MAINNET_PAY_TO } }
  }
  if (override !== "" && !isAddress(override)) {
    return { ok: false, message: `${PAY_TO_ENV} is not a Solana address.` }
  }
  return { ok: true, config: { network, asset: USDC_MINTS[network], payTo: override === "" ? null : override } }
}

export interface SelectedRequirement {
  requirement: PaymentRequirements
  amountRaw: bigint
  feePayer: string
  memo: string
}

export type Selection = { ok: true; selected: SelectedRequirement } | { ok: false; reason: string }

const U64_MAX = 0xffffffffffffffffn

function describeOffer(r: PaymentRequirements): string {
  return `${r.scheme} ${r.network} ${r.asset} ${r.amount}`
}

/**
 * The one requirement in `required.accepts` this CLI pays: `exact`, on `config.network`, in its
 * USDC, with an amount, a fee payer and a Candle memo it can read. The pay-to is checked by the
 * spending rules (10.3 rule 4), not here, so the refusal names it on its own.
 */
export function selectRequirement(required: PaymentRequired, config: NetworkConfig): Selection {
  const candidates = required.accepts.filter(
    (r) => r.scheme === "exact" && r.network === config.network && r.asset === config.asset,
  )
  if (candidates.length === 0) {
    const offered = required.accepts.map(describeOffer).join("; ") || "nothing"
    return {
      ok: false,
      reason: `No offer this CLI can pay: it pays exact USDC on ${config.network}, and the server offered ${offered}.`,
    }
  }
  const requirement = candidates[0] as PaymentRequirements
  if (!/^[1-9][0-9]{0,19}$/.test(requirement.amount) || BigInt(requirement.amount) > U64_MAX) {
    return {
      ok: false,
      reason: `The offer's amount is not a positive whole number of base units: ${requirement.amount}`,
    }
  }
  const feePayer = requirement.extra?.feePayer
  if (typeof feePayer !== "string" || !isAddress(feePayer)) {
    return { ok: false, reason: "The offer names no fee payer (extra.feePayer)." }
  }
  const memo = requirement.extra?.memo
  if (typeof memo !== "string" || !/^cndl:[0-9a-f]{32}$/.test(memo)) {
    return { ok: false, reason: "The offer carries no Candle quote memo (extra.memo)." }
  }
  if (!isAddress(requirement.payTo)) return { ok: false, reason: "The offer's payTo is not a Solana address." }
  return { ok: true, selected: { requirement, amountRaw: BigInt(requirement.amount), feePayer, memo } }
}

/** "0.01" for 10000 base units: USDC has six decimals. */
export function usdcText(amountRaw: bigint): string {
  const whole = amountRaw / 1_000_000n
  const fraction = (amountRaw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction.length < 2 ? fraction.padEnd(2, "0") : fraction}` : `${whole}`
}
