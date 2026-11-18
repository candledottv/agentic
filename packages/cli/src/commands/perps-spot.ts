/**
 * BE-3771 (HM2, Andrew H1: agents may trade any Hyperliquid market): `candle perps spot`, Hyperliquid
 * spot from the same EVM TEE wallet as perps. Every order goes through the perps write path: Candle
 * builds it, this machine checks the build against its own read of Hyperliquid
 * (`verifySpotBuildAgainstVenue`), the relay signs, and this machine submits.
 *
 *   candle perps spot markets [--all] [--limit <n>]
 *   candle perps spot balances [--wallet tee]
 *   candle perps spot buy <pair> <size> [--price <px>] [--tif Gtc|Alo|Ioc] [--slippage-bps <n>] [--client-id <id>]
 *   candle perps spot sell <pair> <size> [...same]
 *   candle perps spot cancel <cloid>
 *
 * `<pair>` is the pair name (`HYPE/USDC`) or Hyperliquid's index (`@107`); `<size>` is in the base
 * token. Spot and perps balances are separate on Hyperliquid: a buy spends the wallet's spot USDC.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import { writeUsageFailure } from "../render"
import { type Json, safeText, tradingKey } from "../trading"
import { perpsRequest, perpsWallet, runPerpsWrite, sharedWrite, slippage } from "./perps"
import { printTradingResult, tradingFailure } from "./swap"

const DEC_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const CLOID_RE = /^0x[0-9a-fA-F]{32}$/
const PAIR_RE = /^([A-Za-z0-9]{1,20}\/[A-Za-z0-9]{1,20}|@(0|[1-9][0-9]{0,5}))$/

export const SPOT_USAGE = [
  "Usage: candle perps spot <markets|balances|buy|sell|cancel>",
  "  candle perps spot markets [--all] [--limit <n>]",
  "  candle perps spot balances [--wallet tee]",
  "  candle perps spot buy|sell <pair> <size> [--price <px>] [--tif Gtc|Alo|Ioc] [--slippage-bps <n>] [--client-id <0x+32 hex>] [--yes]",
  "  candle perps spot cancel <cloid> [--yes]",
  "  <pair> is HYPE/USDC or @107; <size> is in the base token. Spot pairs quoted in USDC only.",
].join("\n")

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

export async function perpsSpot(args: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case "markets":
      return spotMarkets(rest, ctx)
    case "balances":
      return spotBalances(rest, ctx)
    case "buy":
    case "sell":
      return spotOrder(sub, rest, ctx)
    case "cancel":
      return spotCancel(rest, ctx)
    default:
      return usage(ctx, SPOT_USAGE)
  }
}

async function spotMarkets(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--limit"], booleanFlags: ["--all"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps spot markets [--all] [--limit <n>]")
  const limit = parsed.values["--limit"]
  if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) return usage(ctx, "--limit must be from 1 to 500.")
  const query = new URLSearchParams()
  if (limit !== undefined) query.set("limit", limit)
  if (parsed.booleans.has("--all")) query.set("all", "true")
  try {
    const key = await tradingKey(ctx)
    const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/spot/markets${query.size ? `?${query}` : ""}`)
    if (ctx.json) return printTradingResult(ctx, result)
    const rows = Array.isArray(result.markets) ? (result.markets as Json[]) : []
    for (const m of rows) {
      const terms = (m.terms ?? {}) as Json
      writeFields(ctx.deps, "stdout", [
        ["Market", `${safeText(m.market)} (${safeText(m.coin)}, asset ${safeText(m.asset)})`],
        ["Mid", m.midPx == null ? "none" : `${safeText(m.midPx)} ${safeText(m.quote ?? "")}`.trim()],
        ["24h volume", m.dayVolumeUsd == null ? "unknown" : `${safeText(m.dayVolumeUsd)} USD`],
        ["Fee", m.terms ? `taker ${safeText(terms.takerFeePct)}%, maker ${safeText(terms.makerFeePct)}%` : undefined],
        ["Refused", m.tradable === false ? safeText((m.refusal as Json | null)?.message ?? "yes") : undefined],
      ])
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

async function spotBalances(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps spot balances [--wallet tee]")
  if (parsed.values["--wallet"] === "embedded")
    return usage(ctx, "Hyperliquid spot uses the key's EVM TEE wallet; the embedded wallet is not offered for spot.")
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const result = await perpsRequest(
      ctx,
      key,
      `/api/v1/agent/perps/spot/balances?walletId=${encodeURIComponent(row.id)}`,
    )
    if (ctx.json) return printTradingResult(ctx, result)
    writeFields(ctx.deps, "stdout", [["Address", safeText(result.address)]])
    const balances = Array.isArray(result.balances) ? (result.balances as Json[]) : []
    if (balances.length === 0) writeFields(ctx.deps, "stdout", [["Spot balances", "none"]])
    for (const b of balances)
      writeFields(ctx.deps, "stdout", [
        [
          safeText(b.coin),
          `${safeText(b.total)}${b.hold && b.hold !== "0.0" && b.hold !== "0" ? ` (${safeText(b.hold)} on hold)` : ""}`,
        ],
      ])
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

async function spotOrder(side: "buy" | "sell", args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--price", "--tif", "--slippage-bps", "--client-id"],
    booleanFlags: ["--yes", "--no-submit", "--sign-only"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [market, size] = parsed.positionals
  if (parsed.positionals.length !== 2 || !market || !size) return usage(ctx, SPOT_USAGE)
  if (!PAIR_RE.test(market)) return usage(ctx, "The pair must be a name such as HYPE/USDC, or an index such as @107.")
  if (!DEC_RE.test(size)) return usage(ctx, "The size must be a plain decimal in the base token, e.g. 1.5.")
  const { values } = parsed
  if (values["--wallet"] === "embedded")
    return usage(ctx, "Hyperliquid spot uses the key's EVM TEE wallet; the embedded wallet is not offered for spot.")
  const price = values["--price"]
  if (price !== undefined && !DEC_RE.test(price)) return usage(ctx, "--price must be a plain decimal.")
  const tif = values["--tif"]
  if (tif !== undefined && !["Gtc", "Alo", "Ioc"].includes(tif)) return usage(ctx, "--tif must be Gtc, Alo or Ioc.")
  if (tif !== undefined && tif !== "Ioc" && price === undefined) return usage(ctx, "--tif Gtc or Alo needs --price.")
  const slippageBps = slippage(values["--slippage-bps"])
  if (slippageBps === null) return usage(ctx, "--slippage-bps must be a whole number of at least 1.")
  const clientId = values["--client-id"]
  if (clientId !== undefined && !CLOID_RE.test(clientId))
    return usage(ctx, "--client-id must be 0x followed by 32 hex digits.")
  const body: Json = {
    market,
    side,
    size,
    type: price === undefined ? "market" : "limit",
    ...(price !== undefined ? { price } : {}),
    ...(tif !== undefined && price !== undefined ? { tif } : {}),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
    ...(clientId !== undefined ? { clientId: clientId.toLowerCase() } : {}),
  }
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/spot/order",
      body,
      method: "spotOrder",
      ...sharedWrite(values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

async function spotCancel(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"], booleanFlags: ["--yes", "--no-submit", "--sign-only"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [cloid] = parsed.positionals
  if (parsed.positionals.length !== 1 || !cloid || !CLOID_RE.test(cloid))
    return usage(ctx, "Usage: candle perps spot cancel <cloid> [--yes]  (cloid: 0x + 32 hex)")
  if (parsed.values["--wallet"] === "embedded")
    return usage(ctx, "Hyperliquid spot uses the key's EVM TEE wallet; the embedded wallet is not offered for spot.")
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/spot/cancel",
      body: { cloid: cloid.toLowerCase() },
      method: "spotCancel",
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
