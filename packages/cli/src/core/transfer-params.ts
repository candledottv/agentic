/**
 * A transfer out of a user wallet, as the core holds it (BE-1680, spec S4 T-2 to T-5). Pure: the
 * parameters a `transfer` card is bound to, how an address is normalized before any card exists,
 * and the typed confirmation the core checks inside `cards.approve` (T-5): the word `confirm`, asked
 * on every transfer. BE-1710 removed the destination's last six that followed it.
 *
 * The wording and the comparison rules are the CLI's (`commands/vault-support.ts`: `confirmSend`,
 * `describeSend`, `groupAddress`), so a send reads the same in the terminal and
 * the TUI.
 */
import { checkEvmAddress } from "../evm-lite"
import { decodePubkey } from "../solana-lite"
import { refused } from "./rpc"

export type TransferSourceKind = "vault" | "embedded"
export type TransferChain = "solana" | "hood"
export const BASE_SYMBOLS = ["SOL", "USDC", "CNDL", "ETH", "USDG"] as const
export type BaseSymbol = (typeof BASE_SYMBOLS)[number]

/** T-4: what a `transfer` card is bound to (its hash covers exactly this). */
export interface TransferParams {
  source: { kind: TransferSourceKind; walletId?: string; address: string }
  chain: TransferChain
  asset: { symbol: BaseSymbol } | { mint: string } | { token: string }
  /** Raw base units, or everything the wallet holds when it is sent (`max`, the CLI's behaviour). */
  amount: { raw: string } | { max: true }
  /** Normalized and full: base58 on Solana, EIP-55 on Hood. */
  to: string
}

/** The chain each base asset lives on, and its decimals. */
export const BASE_ASSETS: Record<BaseSymbol, { chain: TransferChain; decimals: number }> = {
  SOL: { chain: "solana", decimals: 9 },
  USDC: { chain: "solana", decimals: 6 },
  CNDL: { chain: "solana", decimals: 6 },
  ETH: { chain: "hood", decimals: 18 },
  USDG: { chain: "hood", decimals: 6 },
}

/** The contract address the screens draw beside a base ticker (design 7): never shortened. */
export const BASE_CONTRACTS: Record<BaseSymbol, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  CNDL: "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL",
  ETH: "(native ETH)",
  USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
}

/**
 * T-3: an address as typed or pasted, normalized for `chain`, or a refusal. Spaces anywhere are
 * removed (an address pasted in its grouped form); EVM becomes its checksum spelling.
 */
export function normalizeAddress(chain: TransferChain, input: unknown): string {
  if (typeof input !== "string") throw refused("INVALID_DESTINATION", "The destination must be an address.")
  const compact = input.replace(/\s+/g, "")
  if (chain === "hood") {
    const checked = checkEvmAddress(compact)
    if (!checked.ok) throw refused("INVALID_DESTINATION", `Not a Hood address: ${checked.reason}.`)
    return checked.address
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(compact)) {
    throw refused("INVALID_DESTINATION", "Not a Solana address: a base58 public key of 32 to 44 characters.")
  }
  try {
    decodePubkey(compact)
  } catch {
    throw refused("INVALID_DESTINATION", "Not a Solana address: it does not decode to 32 bytes.")
  }
  return compact
}

/** Two spellings of one address are the same destination (EVM compares without case). */
export function sameAddress(chain: TransferChain, a: string, b: string): boolean {
  return chain === "hood" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The ticker a transfer names: a base symbol, or the mint or token address itself. */
export function assetLabel(asset: TransferParams["asset"]): string {
  return "symbol" in asset ? asset.symbol : "mint" in asset ? asset.mint : asset.token
}

/** The contract address beside the ticker on every screen (design 7). */
export function assetContract(asset: TransferParams["asset"]): string {
  return "symbol" in asset ? BASE_CONTRACTS[asset.symbol] : "mint" in asset ? asset.mint : asset.token
}

/** `send <amount> <asset> to <address>`: the operation a factor's dialog and the confirm prompt name. */
export function describeSend(amount: string, asset: string, to: string): string {
  return `send ${amount} ${asset} to ${to}`
}

/** An address in groups of four, `0x` its own first group (the CLI's `groupAddress`). */
export function groupAddress(address: string): string {
  const prefix = address.startsWith("0x") ? "0x" : ""
  const groups = address.slice(prefix.length).match(/.{1,4}/g) ?? []
  return [...(prefix ? [prefix] : []), ...groups].join(" ")
}

/** T-5 step 2: the word, trimmed and compared without case (`confirmSend`). */
export function confirmTyped(typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toLowerCase() === "confirm"
}

/** A raw amount as a decimal of `decimals` places, trailing zeros trimmed. */
export function rawToDecimal(raw: bigint, decimals: number): string {
  const text = raw.toString().padStart(decimals + 1, "0")
  const whole = text.slice(0, text.length - decimals)
  const fraction = text.slice(text.length - decimals).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

/** A positive decimal to raw units, or undefined when it is not one or has too many places. */
export function decimalToRaw(value: string, decimals: number): bigint | undefined {
  const text = value.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined
  const [whole = "0", fraction = ""] = text.split(".")
  if (fraction.length > decimals) return undefined
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"))
  return raw > 0n ? raw : undefined
}

/**
 * `transfer.prepare`'s input checked into {@link TransferParams}. A base asset's decimals are
 * known; a mint's or token's are read through `decimalsFor` only when the amount is a decimal.
 * The amount may come as a decimal (the form), raw units, or `max`.
 */
export async function parseTransferInput(
  input: Record<string, unknown>,
  decimalsFor: (chain: TransferChain, asset: TransferParams["asset"]) => Promise<number | undefined>,
): Promise<TransferParams> {
  const source = input.source as { kind?: unknown; walletId?: unknown; address?: unknown } | undefined
  if (source === null || typeof source !== "object") throw refused("INVALID_SOURCE", "Choose a wallet to send from.")
  if (source.kind !== "vault" && source.kind !== "embedded") {
    throw refused("INVALID_SOURCE", "A transfer sends from a vault wallet or the embedded wallet.")
  }
  const chain = input.chain
  if (chain !== "solana" && chain !== "hood") throw refused("INVALID_CHAIN", "chain is solana or hood.")
  if (typeof source.address !== "string" || source.address.length === 0)
    throw refused("INVALID_SOURCE", "The source wallet's address is missing.")
  const sourceAddress = normalizeAddress(chain, source.address)

  const rawAsset = input.asset as { symbol?: unknown; mint?: unknown; token?: unknown } | undefined
  let asset: TransferParams["asset"]
  if (rawAsset !== null && typeof rawAsset === "object" && typeof rawAsset.symbol === "string") {
    const symbol = rawAsset.symbol.toUpperCase() as BaseSymbol
    if (!BASE_SYMBOLS.includes(symbol) || BASE_ASSETS[symbol].chain !== chain) {
      throw refused(
        "INVALID_ASSET",
        `${chain === "hood" ? "Hood" : "Solana"} sends ${BASE_SYMBOLS.filter((s) => BASE_ASSETS[s].chain === chain).join(", ")} or a token address.`,
      )
    }
    asset = { symbol }
  } else if (chain === "solana" && rawAsset && typeof rawAsset.mint === "string") {
    asset = { mint: normalizeAddress("solana", rawAsset.mint) }
  } else if (chain === "hood" && rawAsset && typeof rawAsset.token === "string") {
    asset = { token: normalizeAddress("hood", rawAsset.token) }
  } else {
    throw refused("INVALID_ASSET", "Choose an asset: a base symbol, a Solana mint or a Hood token address.")
  }

  const rawAmount = input.amount as { raw?: unknown; decimal?: unknown; max?: unknown } | undefined
  let amount: TransferParams["amount"]
  if (rawAmount && typeof rawAmount === "object" && rawAmount.max === true) amount = { max: true }
  else if (
    rawAmount &&
    typeof rawAmount === "object" &&
    typeof rawAmount.raw === "string" &&
    /^[1-9]\d*$/.test(rawAmount.raw)
  ) {
    amount = { raw: rawAmount.raw }
  } else if (rawAmount && typeof rawAmount === "object" && typeof rawAmount.decimal === "string") {
    const decimals = "symbol" in asset ? BASE_ASSETS[asset.symbol].decimals : await decimalsFor(chain, asset)
    if (decimals === undefined)
      throw refused("ASSET_UNREADABLE", "The asset's decimals could not be read; nothing was prepared.")
    const raw = decimalToRaw(rawAmount.decimal, decimals)
    if (raw === undefined) {
      throw refused("INVALID_AMOUNT", `The amount is a positive decimal with at most ${decimals} places, or max.`)
    }
    amount = { raw: raw.toString() }
  } else {
    throw refused("INVALID_AMOUNT", "The amount is a positive decimal, or max.")
  }

  const to = normalizeAddress(chain, input.to)
  if (sameAddress(chain, to, sourceAddress))
    throw refused("INVALID_DESTINATION", "The destination is the source itself.")
  return {
    source: {
      kind: source.kind,
      ...(typeof source.walletId === "string" && source.walletId.length > 0 ? { walletId: source.walletId } : {}),
      address: sourceAddress,
    },
    chain,
    asset,
    amount,
    to,
  }
}
