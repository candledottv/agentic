/**
 * Builder-dex funding (BE-3765, H2-A): `candle perps transfer --to-dex <dex> <amount>`,
 * `--from-dex <dex> <amount|--all>`, plus `candle perps transfer status <id>`. `--to-spot` and
 * `--from-spot` are not offered; an older caller passing one is refused before any request
 * (perps to spot is BE-3864).
 *
 * USDC moves between the key's OWN Hyperliquid balances (main perps, a builder-deployed dex, or
 * spot). Candle builds the action with the destination pinned to the wallet itself; this machine
 * checks that pin again before the relay signs (`verifyTransferBuild`), and posts the signed
 * action to Hyperliquid itself. Money never leaves the wallet, so the confirm is the order-style
 * prompt (`--yes` allowed), not the withdrawal's vault gate.
 *
 * Needs `perps:write` — the same scope as orders, not `perps:withdraw`.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import {
  HYPERLIQUID_EXCHANGE_URLS,
  type HyperliquidTypedData,
  hyperliquidExchangeBody,
  hyperliquidExchangeOutcome,
} from "../hyperliquid"
import { verifyOwnTransferBuild } from "../hyperliquid-transfer"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { CANCELLED_EXIT, type Json, safeText, TradingError, tradingKey } from "../trading"
import { perpsRequest, perpsWallet, typedDataAuthorization, venueRefusal } from "./perps"
import { printTradingResult, tradingFailure } from "./swap"

const TRANSFER_SCOPE = "perps:write"
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const AMOUNT_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/
const DEX_RE = /^[A-Za-z0-9]{1,16}$/
const USAGE =
  "Usage: candle perps transfer (--to-dex <dex> | --from-dex <dex>) <amount|--all> [--wallet <evm tee>] [--id <id>] [--yes] [--no-submit] | candle perps transfer status <id>"

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

type TransferMode = "toDex" | "fromDex" | "toSpot" | "fromSpot"

interface ParsedTransfer {
  mode: TransferMode
  dex?: string
  amount?: string
  all: boolean
}

function parseTransferArgs(args: string[]): ParsedTransfer | { error: string } {
  const directions: TransferMode[] = []
  if (args.includes("--to-dex")) directions.push("toDex")
  if (args.includes("--from-dex")) directions.push("fromDex")
  if (args.includes("--to-spot")) directions.push("toSpot")
  if (args.includes("--from-spot")) directions.push("fromSpot")
  if (directions.length !== 1) return { error: "Name exactly one direction: --to-dex or --from-dex." }
  const mode = directions[0] as TransferMode
  // Not in this release: the staging Privy probe denied the UsdClassTransfer policy rule
  // (2026-11-18), so the API builds no perps<->spot move. Refused here before any request.
  if (mode === "toSpot" || mode === "fromSpot")
    return { error: "Perps to spot transfers (--to-spot, --from-spot) are not available in this release." }
  const parsed = parseArgs(args, {
    valueFlags: ["--to-dex", "--from-dex", "--wallet", "--id"],
    booleanFlags: ["--yes", "--no-submit", "--to-spot", "--from-spot", "--all"],
  })
  if ("error" in parsed) return parsed
  const positionals = parsed.positionals.filter((value) => value !== undefined)
  const dexMode = mode === "toDex" || mode === "fromDex"
  const dex = dexMode ? parsed.values[mode === "toDex" ? "--to-dex" : "--from-dex"] : undefined
  if (dexMode && (dex === undefined || !DEX_RE.test(dex) || dex.toLowerCase() === "spot"))
    return { error: "--to-dex/--from-dex name a builder dex: 1 to 16 letters or digits, and not spot." }
  if (!dexMode && (parsed.values["--to-dex"] !== undefined || parsed.values["--from-dex"] !== undefined))
    return { error: "A perps-to-spot transfer takes no --to-dex/--from-dex." }
  const all = parsed.booleans.has("--all")
  const amount = positionals[0]
  if (all) {
    if (mode === "toDex") return { error: "--all moves money INTO a builder dex; name an amount instead." }
    if (positionals.length > 0) return { error: "--all takes no amount." }
    return { mode, ...(dex !== undefined ? { dex } : {}), all: true }
  }
  if (positionals.length !== 1 || amount === undefined || !AMOUNT_RE.test(amount) || Number(amount) <= 0)
    return { error: "The amount must be a positive USDC decimal with at most 6 decimals." }
  return { mode, ...(dex !== undefined ? { dex } : {}), amount, all: false }
}

export function amountMicrosOf(amount: string): bigint | null {
  if (!AMOUNT_RE.test(amount)) return null
  const [whole = "0", frac = ""] = amount.split(".")
  const micros = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"))
  return micros > 0n ? micros : null
}

/** Relay's fixed-6 form ("15.000000"), the other wire shape the server may pin. */
export function fixed6Micros(value: string): bigint | null {
  if (!/^\d+\.\d{6}$/.test(value)) return null
  const [whole = "0", frac = ""] = value.split(".")
  return BigInt(whole) * 1_000_000n + BigInt(frac)
}

export interface TransferBuild {
  id: string
  status: string
  mode: TransferMode
  dex?: string
  amountUsdc?: string
  walletId?: string
  nonce?: number
  typedData?: HyperliquidTypedData
  action?: Record<string, unknown>
  signature?: string
  failureReason?: string
}

/**
 * The client-side check before anything is signed (HL-ED-5's rule, applied to transfers): the
 * typed data names THIS wallet as destination (SendAsset) or names no destination at all
 * (UsdClassTransfer), the pinned token, empty sub-account fields, the dex pair asked for, and the
 * amount asked for. `null` is the refusal reason.
 */
export function verifyTransferBuild(
  build: TransferBuild,
  expect: { id: string; account: string; mode: TransferMode; dex?: string; amountMicros: bigint | null },
): string | null {
  return verifyOwnTransferBuild(build, expect)
}

const describe: Record<TransferMode, (dex?: string) => [string, string]> = {
  toDex: (dex) => ["Main perps", `builder dex ${dex ?? ""}`],
  fromDex: (dex) => [`builder dex ${dex ?? ""}`, "Main perps"],
  toSpot: () => ["Perps", "Spot"],
  fromSpot: () => ["Spot", "Perps"],
}

async function transferStatus(ctx: CommandContext, id: string): Promise<number> {
  const key = await tradingKey(ctx)
  const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/transfer/${encodeURIComponent(id)}`)
  if (ctx.json) return printTradingResult(ctx, result)
  writeFields(ctx.deps, "stdout", [
    ["Transfer", safeText(id)],
    ["Status", safeText(result.status)],
    ["Amount", `${safeText(result.amountUsdc)} USDC`],
    ["Mode", safeText(result.mode)],
    ["Failure", result.failureReason ? safeText(result.failureReason) : undefined],
  ])
  return 0
}

export async function perpsTransfer(args: string[], ctx: CommandContext): Promise<number> {
  if (args[0] === "status") {
    if (args.length !== 2 || !ID_RE.test(args[1] as string)) return usage(ctx, USAGE)
    try {
      return await transferStatus(ctx, args[1] as string)
    } catch (error) {
      return tradingFailure(ctx, error)
    }
  }
  const idFlag = args.indexOf("--id")
  const rawId = idFlag >= 0 ? args[idFlag + 1] : undefined
  if (rawId !== undefined && !ID_RE.test(rawId))
    return usage(ctx, "--id must be 1 to 128 letters, digits, '.', '_', ':' or '-'.")
  const id = rawId ?? `transfer-${randomUUID()}`
  const parsed = parseTransferArgs(args)
  if ("error" in parsed) return usage(ctx, parsed.error)
  const noSubmit = args.includes("--no-submit")

  try {
    const key = await tradingKey(ctx)
    const { wallet, row } = await perpsWallet(ctx, key, findFlag(args, "--wallet"), TRANSFER_SCOPE)
    if (!wallet || row.id === "embedded")
      throw new TradingError(
        "PERPS_EMBEDDED_DISABLED",
        "Embedded wallets cannot transfer between balances in this release.",
      )
    const [fromLabel, toLabel] = describe[parsed.mode](parsed.dex)
    const body: Json = {
      clientTransferId: id,
      mode: parsed.mode,
      ...(parsed.dex !== undefined ? { dex: parsed.dex } : {}),
      ...(parsed.all ? { all: true } : { amountUsdc: parsed.amount }),
      walletId: wallet.id,
    }
    writeFields(ctx.deps, "stderr", [
      ["Transfer", id],
      ["Amount", parsed.all ? "all free USDC" : `${parsed.amount} USDC`],
      ["From", fromLabel],
      ["To", toLabel],
      ["Wallet", row.address],
    ])
    if (!args.includes("--yes") && (await ctx.deps.promptLine("Move? [y/N] ")).trim().toLowerCase() !== "y")
      throw new TradingError("CANCELLED", "Transfer cancelled", { exitCode: CANCELLED_EXIT })

    const build = (await perpsRequest(ctx, key, "/api/v1/agent/perps/transfer", body)) as unknown as TransferBuild
    if (build.status !== "built" || !build.typedData) return printTradingResult(ctx, build as unknown as Json)
    const problem = verifyTransferBuild(build, {
      id,
      account: row.address,
      mode: parsed.mode,
      ...(parsed.dex !== undefined ? { dex: parsed.dex } : {}),
      amountMicros: parsed.all || parsed.amount === undefined ? null : amountMicrosOf(parsed.amount),
    })
    if (problem)
      throw new TradingError("PERPS_BUILD_REFUSED", `Refused to sign this transfer: ${problem}. Nothing was signed.`)
    if (noSubmit) return printTradingResult(ctx, { ...build, submitted: false } as unknown as Json)

    const { relay, exchange } = await submitTransferBuild(ctx, key, wallet, build)
    const refusal = venueRefusal(exchange)
    if (refusal) throw new TradingError("PERPS_VENUE_REFUSED", refusal, { details: { clientTransferId: id, exchange } })
    notice(ctx.deps, "stderr", "note", `Moved ${safeText(build.amountUsdc)} USDC: ${fromLabel} -> ${toLabel}.\n`.trim())
    return printTradingResult(ctx, { ...build, signature: relay.signature, exchange } as unknown as Json)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

/** Submit exactly the checked build. Reused by the withdrawal's persisted sweep operation. */
export async function submitTransferBuild(
  ctx: CommandContext,
  key: string,
  wallet: NonNullable<Awaited<ReturnType<typeof perpsWallet>>["wallet"]>,
  build: TransferBuild,
) {
  const relay = build.signature
    ? { signature: build.signature }
    : await perpsRequest(
        ctx,
        key,
        `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
        typedDataAuthorization(wallet, build.typedData as HyperliquidTypedData) as unknown as Json,
      )
  if (typeof relay.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(relay.signature))
    throw new TradingError("INVALID_RESPONSE", "The relay did not return a signature.")
  const exchangeBody = hyperliquidExchangeBody(
    build.action as Record<string, unknown>,
    Number(build.nonce),
    relay.signature,
  )
  let exchange: unknown
  try {
    const res = await ctx.deps.fetch(HYPERLIQUID_EXCHANGE_URLS.mainnet, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchangeBody),
    })
    exchange = await res.json()
    if (!res.ok || hyperliquidExchangeOutcome(exchange).status === "unknown")
      throw new Error("Unconfirmed venue answer")
  } catch (error) {
    throw new TradingError(
      "PERPS_SUBMIT_FAILED",
      `Signed, but the submit to Hyperliquid failed (${error instanceof Error ? error.message : "unknown"}). The signed action is in details.exchangeBody and stays valid for two days; check candle perps transfer status ${build.id} before resubmitting.`,
      { exitCode: 3, details: { clientTransferId: build.id, exchangeBody } },
    )
  }
  await perpsRequest(ctx, key, "/api/v1/agent/perps/transfer/submitted", {
    clientTransferId: build.id,
    exchangeResponse: exchange as Json,
  })
  return { relay, exchange }
}

function findFlag(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
