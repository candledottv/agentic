/**
 * Hyperliquid perps B (BE-646, spec 2026-10-01-hyperliquid-perps-tee-design.md, HL-ED-2, HL-ED-11):
 * `candle perps setup | open | close | cancel | orders | positions | leverage`, and from perps C
 * (BE-647, HL-ED-8) `deposit`, which pays Relay from the key's Hood or Solana TEE wallet.
 *
 * Perpetuals on Hyperliquid's main perp exchange from the key's EVM TEE wallet. Every write is the
 * same four steps: Candle's server builds the action and stamps a single-use relay claim; this
 * machine recomputes the action hash from the plaintext and checks the action type, Candle's builder
 * and the typed-data shape (`hyperliquid.ts`, `verifyPerpsBuild`) before anything is signed; Privy
 * signs through Candle's relay with the key's signer; and this machine posts the signed action to
 * Hyperliquid itself. A build that fails the check is refused with nothing signed.
 *
 * The bound key authenticates and must hold `perps:write` (owner-granted, never a default). No
 * vault or TEE private key is opened on any path in this file.
 *
 * `CANDLE_HYPERLIQUID_BUILDER` pins Candle's builder address for the check. Unset, this release's
 * `CANDLE_HYPERLIQUID_BUILDER_ADDRESS` applies when it carries one, and otherwise the builder the
 * server's `/perps/config` reports. `CANDLE_HYPERLIQUID_NETWORK=testnet` trades testnet.
 */
import { randomUUID, sign } from "node:crypto"
import { parseArgs } from "../args"
import {
  BRIDGE_ASSETS,
  type BridgeAsset,
  bridgeLegKinds,
  bridgePlanAdmitted,
  relayHoodLegProblem,
  relaySolanaDepositProblem,
} from "../bridge"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { sameEvmAddress } from "../evm-lite"
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  HYPERLIQUID_EXCHANGE_URLS,
  type HyperliquidNetwork,
  type HyperliquidTypedData,
  hyperliquidCanonicalJson,
  hyperliquidCloseOrder,
  hyperliquidExchangeBody,
  hyperliquidRelayBody,
  verifyPerpsBuild,
} from "../hyperliquid"
import { writeUsageFailure } from "../render"
import {
  completeTradingWallet,
  decimalAmount,
  describeWallet,
  type Json,
  listTradingWallets,
  matchesName,
  plannedLegKinds,
  rawAmount,
  relaySign,
  runSequencedLegs,
  type SequencedBody,
  safeText,
  sequencedSchema,
  TradingError,
  type TradingWallet,
  tradingKey,
  tradingPayer,
} from "../trading"
import { lazySolanaClient, printTradingResult, tradingFailure, tradingRead } from "./swap"

const PERPS_SCOPE = "perps:write"
const DEC_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const CLOID_RE = /^0x[0-9a-fA-F]{32}$/

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

/**
 * One perps request. The perps router answers a bare 404 with no Candle error code while
 * `HYPERLIQUID_ENABLED` is off; naming it separates "this deployment has not enabled perps" from
 * "something broke". A refusal keeps the server's `limit`, the limit that refused (R3).
 */
async function perpsRequest(ctx: CommandContext, key: string, path: string, body?: Json): Promise<Json> {
  const result = await apiRequest(path, {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: body ? "POST" : "GET",
    body,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    if (result.status === 404 && !result.code)
      throw new TradingError(
        "PERPS_NOT_ENABLED",
        "This Candle deployment does not serve perps routes (HYPERLIQUID_ENABLED is off there, or the API predates them).",
      )
    throw new TradingError(result.code ?? "REQUEST_FAILED", result.message)
  }
  if (!result.body || typeof result.body !== "object")
    throw new TradingError("INVALID_RESPONSE", "Candle returned an invalid response.")
  return result.body as Json
}

function network(ctx: CommandContext): HyperliquidNetwork {
  return ctx.deps.env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet"
}

/** Candle's builder for the pre-sign check: the operator's pin, this release's, or the server's. */
async function builderPin(ctx: CommandContext, key: string): Promise<string> {
  const pinned = ctx.deps.env.CANDLE_HYPERLIQUID_BUILDER ?? CANDLE_HYPERLIQUID_BUILDER_ADDRESS
  if (pinned) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(pinned))
      throw new TradingError("INVALID_ADDRESS", "CANDLE_HYPERLIQUID_BUILDER must be an EVM address.")
    return pinned.toLowerCase()
  }
  const config = await perpsRequest(ctx, key, "/api/v1/agent/perps/config")
  if (typeof config.builder !== "string")
    throw new TradingError("PERPS_NOT_CONFIGURED", "The server reports no Hyperliquid builder address.")
  return config.builder.toLowerCase()
}

/** The key's EVM TEE wallet: the one named, or the only one bound to the key. */
async function perpsWallet(
  ctx: CommandContext,
  key: string,
  name: string | undefined,
  scope?: string,
): Promise<{ row: { id: string; address: string }; wallet?: TradingWallet }> {
  const { rows, appId, keyPrefix } = await listTradingWallets(ctx, key, scope)
  const evm = rows.filter((row) => row.chain === "evm")
  const matches = name === undefined ? evm : evm.filter((row) => matchesName(row, name))
  if (matches.length !== 1) {
    throw new TradingError(
      "TEE_WALLET_REQUIRED",
      evm.length === 0
        ? "This key has no EVM TEE wallet bound to it. Hyperliquid perps sign only from one."
        : matches.length === 0
          ? `No EVM TEE wallet on this key is called "${name}". Bound to this key: ${evm.map(describeWallet).join("; ")}.`
          : `Name one EVM TEE wallet with --wallet: ${matches.map(describeWallet).join("; ")}.`,
    )
  }
  const row = matches[0] as (typeof evm)[number]
  if (scope === undefined) return { row }
  const wallet = await completeTradingWallet(ctx, row, appId, scope, "hood", {
    apiKey: key,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
  })
  return { row, wallet }
}

/**
 * The relay authorization for typed data. Privy canonicalizes the body (RFC 8785) before it checks
 * the signature, and a server-returned typed-data object is not in that order, so the payload is
 * serialized canonically rather than in insertion order.
 */
function typedDataAuthorization(wallet: TradingWallet, typedData: HyperliquidTypedData) {
  const body = hyperliquidRelayBody(typedData)
  const payload = hyperliquidCanonicalJson({
    body,
    headers: { "privy-app-id": wallet.appId },
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${wallet.privyWalletId}/rpc`,
    version: 1,
  })
  return { body, authorizationSignature: sign("sha256", Buffer.from(payload), wallet.signer).toString("base64") }
}

function previewLines(build: Json): string[] {
  // Only action fields were bound to the typed data and checked against the request.
  const action = build.action as Record<string, unknown>
  if (action.type === "approveBuilderFee")
    return [`Approve Candle's builder ${safeText(action.builder)} at ${safeText(action.maxFeeRate)} (once).`]
  if (action.type === "cancel")
    return (action.cancels as { a: number; o: number }[]).map((o) => `Cancel asset ${o.a} order ${o.o}.`)
  if (action.type === "updateLeverage")
    return [
      `Set asset ${safeText(action.asset)} to ${safeText(action.leverage)}x ${action.isCross ? "cross" : "isolated"}.`,
    ]
  const orders = (action.type === "modify" ? [action.order] : action.orders) as Record<string, unknown>[]
  const lines = orders.map((o) => {
    const type = o.t as { limit?: { tif: string }; trigger?: { tpsl: string; triggerPx: string } }
    return `${action.type === "modify" ? "Modify to" : o.r ? "Close" : "Open"} ${o.b ? "buy" : "sell"} ${safeText(o.s)} asset ${safeText(o.a)} at ${safeText(o.p)}${type.limit ? ` (${safeText(type.limit.tif)})` : ` (${safeText(type.trigger?.tpsl)} trigger ${safeText(type.trigger?.triggerPx)})`}${o.r ? ", reduce-only" : ""}.`
  })
  const builder = action.builder as { b: string; f: number } | undefined
  lines.push(
    builder ? `Candle builder ${safeText(builder.b)} fee: ${builder.f / 10} bps.` : "Candle builder fee: none.",
  )
  return lines
}

async function confirm(ctx: CommandContext, build: Json, address: string, yes: boolean): Promise<boolean> {
  const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
  output.write(`Hyperliquid account: ${safeText(address)} (${safeText(build.network)})\n`)
  for (const line of previewLines(build)) output.write(`${line}\n`)
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or use --yes.")
  return (await ctx.deps.promptLine("Sign and submit? [y/N] ")).trim().toLowerCase() === "y"
}

/** Did Hyperliquid accept it? `status: "ok"`, and no per-order `error` inside an order answer. */
function venueRefusal(exchange: unknown): string | null {
  if (!exchange || typeof exchange !== "object") return "Hyperliquid returned no answer."
  const answer = exchange as { status?: unknown; response?: unknown }
  if (answer.status !== "ok") return `Hyperliquid refused it: ${safeText(JSON.stringify(answer.response ?? answer))}`
  const statuses = (answer.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses
  for (const status of statuses ?? []) {
    if (status && typeof status === "object" && "error" in status)
      return `Hyperliquid refused the order: ${safeText((status as { error: unknown }).error)}`
  }
  return null
}

/**
 * Build, check, confirm, relay-sign, submit. `submit === false` stops after the check, with nothing
 * signed (`--no-submit`); `signOnly` stops after the relay signs, with nothing submitted.
 */
async function runPerpsWrite(
  ctx: CommandContext,
  opts: { path: string; body: Json; wallet?: string; yes: boolean; submit: boolean; signOnly: boolean },
): Promise<number> {
  const key = await tradingKey(ctx)
  const { wallet } = await perpsWallet(ctx, key, opts.wallet, PERPS_SCOPE)
  if (!wallet) throw new TradingError("TEE_WALLET_REQUIRED", "No EVM TEE wallet resolved.")
  const builder = await builderPin(ctx, key)
  const build = await perpsRequest(ctx, key, opts.path, { walletId: wallet.id, ...opts.body })
  // Setup with the builder already approved on Hyperliquid builds nothing: report the account.
  if (build.ready === true) return printTradingResult(ctx, build)
  const net = network(ctx)
  const method = opts.path.split("/").at(-1) as "setup" | "open" | "close" | "cancel" | "leverage"
  const check = verifyPerpsBuild(build as never, {
    builder,
    network: net,
    address: wallet.address,
    intent: { method, params: opts.body },
  })
  if (!check.ok)
    throw new TradingError("PERPS_BUILD_REFUSED", `Refused to sign this build: ${check.reason}. Nothing was signed.`)
  if (method === "close") {
    const closeOrder = await hyperliquidCloseOrder(ctx.deps.fetch, net, wallet.address, opts.body)
    const closeCheck = verifyPerpsBuild(build as never, {
      builder,
      network: net,
      address: wallet.address,
      intent: { method, params: opts.body },
      closeOrder,
    })
    if (!closeCheck.ok)
      throw new TradingError(
        "PERPS_BUILD_REFUSED",
        `Refused to sign this build: ${closeCheck.reason}. Nothing was signed.`,
      )
  }
  if (!opts.submit) return printTradingResult(ctx, { ...build, signed: false, submitted: false })
  if (!(await confirm(ctx, build, wallet.address, opts.yes))) {
    throw new TradingError("CANCELLED", "Nothing was signed.")
  }
  const relay = await perpsRequest(
    ctx,
    key,
    `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
    typedDataAuthorization(wallet, build.typedData as HyperliquidTypedData) as unknown as Json,
  )
  const signature = relay.signature
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new TradingError("INVALID_RESPONSE", "The relay did not return a signature.")
  const exchangeBody = hyperliquidExchangeBody(
    build.action as Record<string, unknown>,
    build.nonce as number,
    signature,
  )
  // `--sign-only` (V4 in the runbook): the relay's signature and the body that would submit it,
  // with nothing posted to Hyperliquid.
  if (opts.signOnly)
    return printTradingResult(ctx, {
      success: true,
      perpOrderId: build.perpOrderId,
      kind: build.kind,
      network: build.network,
      address: wallet.address,
      nonce: build.nonce,
      signature,
      submitted: false,
      exchangeBody,
    } as unknown as Json)
  let exchange: unknown
  try {
    const res = await ctx.deps.fetch(HYPERLIQUID_EXCHANGE_URLS[net], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchangeBody),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    exchange = JSON.parse(text)
  } catch (error) {
    // The signature stays valid until the nonce leaves Hyperliquid's two-day window, so it is
    // reported, not discarded: posting `details.exchangeBody` to /exchange resubmits it.
    throw new TradingError(
      "PERPS_SUBMIT_FAILED",
      `Signed, but the submit to Hyperliquid failed (${error instanceof Error ? error.message : "unknown"}). The signed action is in details.exchangeBody; nothing was lost.`,
      { exitCode: 3, details: { perpOrderId: build.perpOrderId, exchangeBody } },
    )
  }
  const refusal = venueRefusal(exchange)
  if (refusal)
    throw new TradingError("PERPS_VENUE_REFUSED", refusal, {
      details: { perpOrderId: build.perpOrderId, exchange },
    })
  return printTradingResult(ctx, {
    success: true,
    perpOrderId: build.perpOrderId,
    kind: build.kind,
    network: build.network,
    address: wallet.address,
    ...(build.cloid ? { cloid: build.cloid } : {}),
    ...(build.childCloids ? { childCloids: build.childCloids } : {}),
    nonce: build.nonce,
    signature,
    exchange,
  } as Json)
}

const WRITE_FLAGS = { valueFlags: ["--wallet"], booleanFlags: ["--yes", "--no-submit", "--sign-only"] }

function sharedWrite(values: Record<string, string>, booleans: Set<string>) {
  return {
    ...(values["--wallet"] !== undefined ? { wallet: values["--wallet"] } : {}),
    yes: booleans.has("--yes"),
    submit: !booleans.has("--no-submit"),
    signOnly: booleans.has("--sign-only"),
  }
}

function slippage(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────

export async function perpsSetup(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, WRITE_FLAGS)
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps setup [--wallet <tee>] [--yes]")
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/setup",
      body: {},
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── open ─────────────────────────────────────────────────────────────────────────────────────

const OPEN_USAGE =
  "Usage: candle perps open <coin> <long|short> <size> [--price <px>] [--tif Gtc|Alo|Ioc] [--slippage-bps <n>] [--tp <px>] [--sl <px>] [--wallet <tee>] [--yes]"

export async function perpsOpen(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--price", "--tif", "--slippage-bps", "--tp", "--sl"],
    booleanFlags: ["--yes", "--no-submit", "--sign-only"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin, side, size] = parsed.positionals
  if (parsed.positionals.length !== 3 || !coin || !side || !size) return usage(ctx, OPEN_USAGE)
  if (side !== "long" && side !== "short") return usage(ctx, OPEN_USAGE)
  if (!DEC_RE.test(size)) return usage(ctx, "The size must be a plain decimal, e.g. 0.01.")
  const { values } = parsed
  for (const flag of ["--price", "--tp", "--sl"]) {
    const value = values[flag]
    if (value !== undefined && !DEC_RE.test(value)) return usage(ctx, `${flag} must be a plain decimal.`)
  }
  const tif = values["--tif"]
  if (tif !== undefined && !["Gtc", "Alo", "Ioc"].includes(tif)) return usage(ctx, "--tif must be Gtc, Alo or Ioc.")
  if (tif !== undefined && tif !== "Ioc" && values["--price"] === undefined)
    return usage(ctx, "--tif Gtc or Alo needs --price.")
  const slippageBps = slippage(values["--slippage-bps"])
  if (slippageBps === null) return usage(ctx, "--slippage-bps must be a whole number of at least 1.")
  const body: Json = {
    coin,
    side,
    size,
    type: values["--price"] === undefined ? "market" : "limit",
    ...(values["--price"] !== undefined ? { price: values["--price"] } : {}),
    ...(tif !== undefined && values["--price"] !== undefined ? { tif } : {}),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
    ...(values["--tp"] !== undefined ? { takeProfit: values["--tp"] } : {}),
    ...(values["--sl"] !== undefined ? { stopLoss: values["--sl"] } : {}),
  }
  try {
    return await runPerpsWrite(ctx, { path: "/api/v1/agent/perps/open", body, ...sharedWrite(values, parsed.booleans) })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── close ────────────────────────────────────────────────────────────────────────────────────

export async function perpsClose(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--size", "--slippage-bps"],
    booleanFlags: ["--yes", "--no-submit", "--sign-only"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin] = parsed.positionals
  if (parsed.positionals.length !== 1 || !coin)
    return usage(ctx, "Usage: candle perps close <coin> [--size <n>] [--slippage-bps <n>] [--wallet <tee>] [--yes]")
  const size = parsed.values["--size"]
  if (size !== undefined && !DEC_RE.test(size)) return usage(ctx, "--size must be a plain decimal.")
  const slippageBps = slippage(parsed.values["--slippage-bps"])
  if (slippageBps === null) return usage(ctx, "--slippage-bps must be a whole number of at least 1.")
  const body: Json = {
    coin,
    ...(size !== undefined ? { size } : {}),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  }
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/close",
      body,
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── cancel ───────────────────────────────────────────────────────────────────────────────────

export async function perpsCancel(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, WRITE_FLAGS)
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [cloid] = parsed.positionals
  if (parsed.positionals.length !== 1 || !cloid || !CLOID_RE.test(cloid))
    return usage(ctx, "Usage: candle perps cancel <cloid> [--wallet <tee>] [--yes]  (cloid: 0x + 32 hex)")
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/cancel",
      body: { cloid: cloid.toLowerCase() },
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── leverage ─────────────────────────────────────────────────────────────────────────────────

export async function perpsLeverage(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet"],
    booleanFlags: ["--yes", "--no-submit", "--sign-only", "--isolated"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin, leverage] = parsed.positionals
  const n = Number(leverage)
  if (parsed.positionals.length !== 2 || !coin || !Number.isInteger(n) || n < 1)
    return usage(ctx, "Usage: candle perps leverage <coin> <x> [--isolated] [--wallet <tee>] [--yes]")
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/leverage",
      body: { coin, leverage: n, mode: parsed.booleans.has("--isolated") ? "isolated" : "cross" },
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────

export async function perpsPositions(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps positions [--wallet <tee>]")
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(row.id)}`)
    if (ctx.json) return printTradingResult(ctx, result)
    const out = ctx.deps.stdout
    const account = (result.account ?? {}) as Record<string, unknown>
    out.write(
      `${safeText(result.address)} (${safeText(result.network)}, ${safeText(result.mode)} mode): account value ${safeText(account.accountValue)} USD, withdrawable ${safeText(result.withdrawable)} USD\n`,
    )
    const positions = (result.positions ?? []) as Record<string, unknown>[]
    if (positions.length === 0) out.write("No open positions.\n")
    for (const p of positions) {
      const leverage = (p.leverage ?? {}) as Record<string, unknown>
      out.write(
        `  ${safeText(p.coin)} ${safeText(p.szi)} at ${safeText(p.entryPx)}, value ${safeText(p.positionValue)}, uPnL ${safeText(p.unrealizedPnl)}, ${safeText(leverage.value)}x ${safeText(leverage.type)}, liq ${safeText(p.liquidationPx ?? "none")}\n`,
      )
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

export async function perpsOrders(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet", "--limit"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const limit = parsed.values["--limit"]
  if (parsed.positionals.length !== 0 || (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)))
    return usage(ctx, "Usage: candle perps orders [--wallet <tee>] [--limit <n>]")
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const query = new URLSearchParams({ walletId: row.id })
    if (limit !== undefined) query.set("limit", limit)
    const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/orders?${query}`)
    if (ctx.json) return printTradingResult(ctx, result)
    const out = ctx.deps.stdout
    const open = (result.open ?? []) as Record<string, unknown>[]
    out.write(`Open on Hyperliquid (${open.length}):\n`)
    for (const o of open) {
      out.write(
        `  ${safeText(o.coin)} ${o.side === "B" ? "buy" : "sell"} ${safeText(o.sz)} at ${safeText(o.limitPx)}${o.reduceOnly ? " reduce-only" : ""}${o.isTrigger ? ` trigger ${safeText(o.triggerPx)}` : ""}, cloid ${safeText(o.cloid ?? "none")}\n`,
      )
    }
    const recorded = (result.recorded ?? []) as Record<string, unknown>[]
    out.write(`Built by Candle (${recorded.length}, newest first):\n`)
    for (const r of recorded) {
      out.write(
        `  ${safeText(r.kind)} ${safeText(r.coin ?? "")} ${safeText(r.status)}${r.venueStatus ? ` (${safeText(r.venueStatus)})` : ""}${r.cloid ? `, cloid ${safeText(r.cloid)}` : ""}${r.targetCloid ? `, target ${safeText(r.targetCloid)}` : ""}\n`,
      )
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── deposit (BE-647, HL-ED-8, R2) ────────────────────────────────────────────────────────────

/** Relay's chain and currency for Hyperliquid perps USDC: what every deposit build must name. */
const HYPERLIQUID_RELAY_CHAIN_ID = 1337
const HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000"
const DEPOSIT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const DEPOSIT_USAGE =
  "Usage: candle perps deposit <amount> <SOL|USDC|ETH|USDG> [--wallet <tee>] [--to <evm tee>] [--id <clientDepositId>] [--slippage-bps <n>] [--rpc-url <url>] [--yes] [--no-submit] | candle perps deposit status <clientDepositId>"

function isDepositAsset(value: string | undefined): value is BridgeAsset {
  return value !== undefined && Object.hasOwn(BRIDGE_ASSETS, value)
}

/**
 * The deposit build, checked against what was asked before anything is signed: the source wallet,
 * asset and amount; Hyperliquid USDC on chain 1337 at the expected account; no Candle fee; and
 * Relay's own steps, by the same rules `candle swap` applies to a bridge (`bridge.ts`).
 */
function depositBuildProblem(
  build: Json,
  expect: { walletId: string; asset: BridgeAsset; amountRaw: string; destination: string },
): string | null {
  const destination = (build.destination ?? {}) as Record<string, unknown>
  if (build.walletId !== expect.walletId) return "the build names another paying wallet"
  if (build.asset !== expect.asset || build.amountRaw !== expect.amountRaw) return "the build is for another amount"
  if (destination.chainId !== HYPERLIQUID_RELAY_CHAIN_ID)
    return `the build lands on chain ${safeText(destination.chainId)}`
  if (destination.currency !== HYPERLIQUID_RELAY_USDC) return "the build does not deliver Hyperliquid USDC"
  if (typeof destination.address !== "string" || !sameEvmAddress(destination.address, expect.destination))
    return `the build lands on ${safeText(destination.address)}, not ${expect.destination}`
  const fee = (build.fee ?? {}) as Record<string, unknown>
  if (fee.bps !== 0 || fee.feeRaw !== "0") return "the build carries a Candle fee"
  return null
}

async function perpsDepositStatus(ctx: CommandContext, id: string): Promise<number> {
  const key = await tradingKey(ctx)
  const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/deposit/${encodeURIComponent(id)}`)
  if (ctx.json) return printTradingResult(ctx, result)
  const job = (result.job ?? {}) as Record<string, unknown>
  const destination = (job.destination ?? {}) as Record<string, unknown>
  const relay = job.relay as { status?: unknown } | null | undefined
  ctx.deps.stdout.write(
    `Deposit ${safeText(id)}: ${safeText(job.status)}${job.signature ? ` (${safeText(job.signature)})` : ""}, ${safeText(job.amountRaw)} raw ${safeText(job.asset)} to ${safeText(destination.address)} on Hyperliquid. Relay: ${relay ? safeText(relay.status) : "not sent yet, or unknown"}.\n`,
  )
  return 0
}

/**
 * `candle perps deposit`: move USDC onto the key's Hyperliquid account through Relay, from its Hood
 * or Solana TEE wallet. The asset decides the paying chain. From Hood the account is the paying
 * wallet's own address; from Solana it is the key's EVM TEE wallet (`--to` names it when the key has
 * more than one). Needs `swap:write` and a raw cap on the asset. No withdrawal exists yet: what is
 * deposited stays on Hyperliquid until a later release adds one, and `tee disable` or `tee sweep`
 * do not reach it.
 */
export async function perpsDeposit(args: string[], ctx: CommandContext): Promise<number> {
  if (args[0] === "status") {
    if (args.length !== 2 || !DEPOSIT_ID_RE.test(args[1] as string)) return usage(ctx, DEPOSIT_USAGE)
    try {
      return await perpsDepositStatus(ctx, args[1] as string)
    } catch (error) {
      return tradingFailure(ctx, error)
    }
  }
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--to", "--id", "--slippage-bps", "--rpc-url"],
    booleanFlags: ["--yes", "--no-submit"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [amount, asset] = parsed.positionals
  if (parsed.positionals.length !== 2 || !amount || !DEC_RE.test(amount) || !isDepositAsset(asset))
    return usage(ctx, DEPOSIT_USAGE)
  const { values } = parsed
  const id = values["--id"] ?? `deposit-${randomUUID()}`
  if (!DEPOSIT_ID_RE.test(id)) return usage(ctx, "--id must be 1 to 128 letters, digits, '.', '_', ':' or '-'.")
  const slippageBps = Number(values["--slippage-bps"] ?? "100")
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000)
    return usage(ctx, "--slippage-bps must be a whole number from 1 to 1000.")
  const origin = BRIDGE_ASSETS[asset].chain
  try {
    const key = await tradingKey(ctx)
    const payer = await tradingPayer(ctx, key, values["--wallet"], "swap:write", origin)
    if (payer.kind !== "tee")
      throw new TradingError(
        "TEE_WALLET_REQUIRED",
        `A Hyperliquid deposit pays only from this key's ${origin === "hood" ? "Hood" : "Solana"} TEE wallet, and ${safeText(payer.address)} is the embedded wallet. Name the TEE wallet with --wallet. Nothing was built.`,
      )
    const wallet = payer.wallet
    // HL-ED-1: the Hyperliquid account is an EVM TEE wallet's own address.
    let destination: { id: string; address: string }
    if (origin === "hood") {
      if (values["--to"] !== undefined)
        throw new TradingError(
          "BRIDGE_DESTINATION_MISSING",
          "From a Hood TEE wallet the deposit lands on that wallet's own Hyperliquid account; drop --to. Nothing was built.",
        )
      destination = { id: wallet.id, address: wallet.address }
    } else {
      destination = (await perpsWallet(ctx, key, values["--to"])).row
    }
    const amountRaw = rawAmount(amount, BRIDGE_ASSETS[asset].decimals)
    ctx.deps.stderr.write(`Deposit: ${id}\n`)
    const build = await perpsRequest(ctx, key, "/api/v1/agent/perps/deposit", {
      clientDepositId: id,
      walletId: wallet.id,
      asset,
      amountRaw,
      maxSlippageBps: slippageBps,
      ...(origin === "solana" ? { perpsWalletId: destination.id } : {}),
    })
    // The id already names a deposit this key built: report it, and send nothing again.
    if (build.job) return printTradingResult(ctx, build)
    const refused = (problem: string) =>
      new TradingError("PERPS_BUILD_REFUSED", `Refused to sign this deposit: ${problem}. Nothing was signed.`)
    const problem = depositBuildProblem(build, {
      walletId: wallet.id,
      asset,
      amountRaw,
      destination: destination.address,
    })
    if (problem) throw refused(problem)

    let sequenced: SequencedBody | undefined
    let transaction: string | undefined
    const hoodOrigin = asset === "ETH" || asset === "USDG" ? asset : undefined
    if (hoodOrigin) {
      const parsedLeg = sequencedSchema.safeParse(build)
      if (!parsedLeg.success) throw refused("Candle did not answer with a sequenced Hood leg")
      sequenced = parsedLeg.data
      const plan = plannedLegKinds(sequenced.legKind, sequenced.plannedLegCount, false, "bridgeDeposit")
      if (!bridgePlanAdmitted(hoodOrigin, plan))
        throw refused(`the plan is ${sequenced.plannedLegCount} leg(s) starting with ${sequenced.legKind}`)
      const legProblem = relayHoodLegProblem(sequenced.legKind, sequenced.nextLeg, {
        origin: hoodOrigin,
        payer: wallet.address,
        amountRaw,
      })
      if (legProblem) throw refused(legProblem)
    } else {
      const txs = Array.isArray(build.transactionsBase64) ? build.transactionsBase64 : []
      if (txs.length !== 1 || typeof txs[0] !== "string")
        throw refused(`Candle returned ${txs.length} transactions, not one deposit`)
      transaction = txs[0]
      const reader = await lazySolanaClient(ctx, values["--rpc-url"])()
      const solanaProblem = await tradingRead(ctx, reader, () =>
        relaySolanaDepositProblem(transaction as string, wallet.address, reader.rpc),
      )
      if (solanaProblem) throw refused(solanaProblem)
    }

    const decimals = Number(build.outDecimals)
    const minimum = decimalAmount(String(build.minimumOutRaw), decimals)
    const estimate = decimalAmount(String(build.expectedOutRaw), decimals)
    const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
    output.write(
      `Deposit ${amount} ${asset} from ${safeText(wallet.address)} (${origin === "hood" ? "Hood" : "Solana"} TEE wallet) to Hyperliquid account ${safeText(destination.address)} through Relay.\n`,
    )
    output.write(
      `Relay delivers at least ${minimum} USDC (estimate ${estimate})${build.firstDeposit ? "; Hyperliquid keeps 1 USDC to activate this new account" : ""}. Candle fee: none.\n`,
    )
    output.write(
      "There is no withdrawal from Hyperliquid in this release, and `candle tee disable` or `tee sweep` do not reach it.\n",
    )
    if (sequenced)
      output.write(
        `Legs, signed one at a time: ${sequenced.plannedLegCount === 2 ? "approval, bridgeDeposit" : "bridgeDeposit"}\n`,
      )
    if (parsed.booleans.has("--no-submit"))
      return printTradingResult(ctx, { ...build, signed: false, submitted: false })
    if (!parsed.booleans.has("--yes")) {
      if (!ctx.deps.isTTY.stdin)
        throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or use --yes.")
      if ((await ctx.deps.promptLine("Sign and send? [y/N] ")).trim().toLowerCase() !== "y") {
        if (sequenced)
          ctx.deps.stderr.write(
            `Nothing was signed. Operation ${sequenced.operationId} holds this wallet until ${new Date(sequenced.expiresAt).toISOString()}.\n`,
          )
        throw new TradingError("CANCELLED", "Nothing was signed.")
      }
    }
    if (typeof build.expiresAt !== "number" || build.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The deposit build expired before signing. Start again with a new --id.")

    let result: Json
    if (sequenced && hoodOrigin) {
      const run = await runSequencedLegs(ctx, key, {
        wallet,
        first: sequenced,
        submitPath: "/api/v1/agent/perps/deposit/submit",
        submitFields: { clientDepositId: id, depositId: build.depositId as string },
        unwrap: (answer) => answer,
        primaryLeg: "bridgeDeposit",
        allowedLegs: bridgeLegKinds(hoodOrigin),
        checkLeg: (kind, leg) =>
          relayHoodLegProblem(kind, leg, { origin: hoodOrigin, payer: wallet.address, amountRaw }) === null,
        onLanded: async () => {},
      })
      result = { ...run.final, landedLegs: run.landed }
    } else {
      const signed = await relaySign(ctx, key, wallet, transaction as string)
      result = await perpsRequest(ctx, key, "/api/v1/agent/perps/deposit/submit", {
        clientDepositId: id,
        depositId: build.depositId as string,
        signedTransactionsBase64: [signed],
      })
    }
    ctx.deps.stderr.write(
      `Deposit sent; Relay fills it on Hyperliquid. Check it with candle perps deposit status ${id}.\n`,
    )
    return printTradingResult(ctx, {
      ...result,
      clientDepositId: id,
      expectedOutRaw: build.expectedOutRaw,
      minimumOutRaw: build.minimumOutRaw,
      outDecimals: build.outDecimals,
    } as Json)
  } catch (error) {
    // The id is on stderr above; `candle perps deposit status <id>` reads it before another try.
    return tradingFailure(ctx, error)
  }
}
