import type { Chain, LaunchRequest } from "./client"
import { CandleApiError } from "./errors"
import { LAUNCH_DEFINITION } from "./launch-definition"

export function embeddedLaunchWallet(wallet: LaunchRequest["wallet"]): boolean {
  return (
    wallet === undefined ||
    (typeof wallet === "string" && (LAUNCH_DEFINITION.wallet.embeddedNames as readonly string[]).includes(wallet))
  )
}

export function launchInputError(field: string, message: string, code = "VALIDATION_FAILED"): CandleApiError {
  return new CandleApiError({ status: 400, code, field, message, retryable: false })
}

/** Local shape refusals happen before discovery, build or signing. Server limits stay server-owned. */
export function validateLaunchInput(req: LaunchRequest): void {
  if (req.buy !== undefined && req.buyAmount !== undefined)
    throw launchInputError("buy", "Pass buy or the deprecated buyAmount, never both.")
  if (req.wallet !== undefined && "linkedWalletId" in req)
    throw launchInputError("wallet", "Pass wallet without the legacy linkedWalletId field.")
  if (
    req.wallet !== undefined &&
    typeof req.wallet !== "string" &&
    (!req.wallet ||
      typeof req.wallet.linkedWalletId !== "string" ||
      !req.wallet.linkedWalletId ||
      typeof req.wallet.privyWalletId !== "string" ||
      !req.wallet.privyWalletId)
  )
    throw launchInputError("wallet", "wallet needs linkedWalletId and privyWalletId.")
  if (
    req.buy !== undefined &&
    (typeof req.buy !== "string" || (req.buy.trim() !== "" && !/^\d+(\.\d+)?$/.test(req.buy)))
  )
    throw launchInputError("buy", "buy must be a non-negative decimal string in whole quote units.")
  const keys = LAUNCH_DEFINITION.fields
    .filter((field) => field.key.startsWith("socials."))
    .map((field) => field.key.slice(8))
  if (req.socials !== undefined) {
    if (!req.socials || typeof req.socials !== "object" || Array.isArray(req.socials))
      throw launchInputError("socials", `socials accepts only ${keys.join(", ")}.`)
    for (const [key, value] of Object.entries(req.socials)) {
      if (!keys.includes(key)) throw launchInputError("socials", `socials accepts only ${keys.join(", ")}.`)
      if (value === undefined) continue
      try {
        if (typeof value !== "string") throw new Error()
        const url = new URL(value)
        if (!["http:", "https:"].includes(url.protocol)) throw new Error()
      } catch {
        throw launchInputError(`socials.${key}`, `${key} must be an http(s) URL.`)
      }
    }
  }
  // When the caller supplied a quote, precision can be checked before wallet discovery too.
  if (req.quoteAsset !== undefined || req.chain !== undefined || embeddedLaunchWallet(req.wallet)) launchBody(req)
}

/** Strip SDK controls and translate the whole-unit first buy without floating point rounding. */
export function launchBody(req: LaunchRequest, chain?: Chain): Omit<LaunchRequest, "wallet" | "buy"> {
  const { wallet: _wallet, buy, ...body } = req
  if (chain !== undefined) body.chain = chain
  const quote = body.quoteAsset ?? LAUNCH_DEFINITION.defaultQuote[body.chain ?? "solana"]
  const quoteChain = LAUNCH_DEFINITION.quoteChains[quote]
  if (!quoteChain) throw launchInputError("quoteAsset", "Unsupported launch quote asset.")
  if (body.chain !== undefined && body.chain !== quoteChain)
    throw launchInputError("quoteAsset", "The quote asset disagrees with the launch chain.", "CHAIN_MISMATCH")
  if (buy === undefined || buy.trim() === "" || /^0+(\.0+)?$/.test(buy)) return body
  const decimals = LAUNCH_DEFINITION.quoteDecimals[quote]
  const [whole = "0", fraction = ""] = buy.split(".")
  if (fraction.length > decimals) throw launchInputError("buy", `buy allows at most ${decimals} decimals for ${quote}.`)
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"))
  if (raw === 0n) return body
  if (quoteChain === "solana" && raw > BigInt(Number.MAX_SAFE_INTEGER))
    throw launchInputError("buy", "buy exceeds the safe integer range for this quote asset.")
  body.buyAmount = quoteChain === "solana" ? Number(raw) : String(raw)
  return body
}
