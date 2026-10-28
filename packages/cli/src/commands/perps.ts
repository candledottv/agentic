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
 * This release pins Candle's builder independently of the API. `CANDLE_HYPERLIQUID_BUILDER` is an
 * explicit replacement of that trust anchor, shown in the preview and validated before use.
 * `CANDLE_HYPERLIQUID_NETWORK=testnet` trades testnet.
 *
 * BE-1583 (spec 2026-10-17-hyperliquid-phase1-c-small-items-design.md): `fills` and `funding` read
 * history straight from Hyperliquid's `/info` (`perps-history.ts`, the SDK's file byte for byte);
 * `setup` reads the account mode from Hyperliquid before asking Candle, and checks Candle's answer,
 * `ready` included; `open` and `close` take `--client-id`, and a retry under it returns the
 * original operation without signing anything.
 */
import { randomUUID, sign } from "node:crypto"
import { z } from "zod"
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
import { writeFields } from "../human-output"
import {
  HYPERLIQUID_CLOID_RE,
  HYPERLIQUID_EXCHANGE_URLS,
  HYPERLIQUID_STANDARD_ACCOUNT_MODES,
  type HyperliquidNetwork,
  type HyperliquidTypedData,
  hyperliquidAccountMode,
  hyperliquidCanonicalJson,
  hyperliquidClosePct,
  hyperliquidExchangeBody,
  hyperliquidExchangeOutcome,
  hyperliquidRelayBody,
  type PerpsIntentMethod,
  perpsSetupStatusProblem,
  resolveHyperliquidBuilder,
  verifyPerpsBuild,
  verifyPerpsBuildAgainstVenue,
} from "../hyperliquid"
import {
  PERPS_HISTORY_MAX_LIMIT,
  type PerpsFillsPage,
  type PerpsFundingPage,
  PerpsHistoryError,
  perpsHistoryLines,
  readPerpsHistoryPage,
} from "../perps-history"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { solanaSpendProblem } from "../solana-verify"
import {
  BASES,
  completeTradingWallet,
  decimalAmount,
  describeWallet,
  type Json,
  type LegKind,
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
import { positionsAdditions, writePositionsText } from "./perps-risk"
import { lazySolanaClient, printTradingResult, tradingFailure, tradingRead } from "./swap"

export const PERPS_SCOPE = "perps:write"
const DEC_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const CLOID_RE = /^0x[0-9a-fA-F]{32}$/

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

/**
 * One perps request. An API that predates the perps router answers a bare 404 with no Candle
 * error code; naming it separates "this deployment does not serve perps" from "something broke".
 * A refusal keeps the server's `limit`, the limit that refused (R3).
 */
export async function perpsRequest(ctx: CommandContext, key: string, path: string, body?: Json): Promise<Json> {
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
        "This Candle deployment does not serve perps routes (the API predates them).",
      )
    throw new TradingError(result.code ?? "REQUEST_FAILED", result.message)
  }
  if (!result.body || typeof result.body !== "object")
    throw new TradingError("INVALID_RESPONSE", "Candle returned an invalid response.")
  return result.body as Json
}

export function perpsNetwork(ctx: CommandContext): HyperliquidNetwork {
  return ctx.deps.env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet"
}

/** The builder is local configuration, never the API's own assertion of its identity. */
export function builderPin(ctx: CommandContext): string {
  try {
    return resolveHyperliquidBuilder(ctx.deps.env.CANDLE_HYPERLIQUID_BUILDER)
  } catch (error) {
    throw new TradingError("PERPS_BUILD_REFUSED", (error as Error).message)
  }
}

/** The key's EVM TEE wallet: the one named, or the only one bound to the key. */
export async function perpsWallet(
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
        ? "This key has no EVM TEE wallet bound to it. Hyperliquid perps sign only from one. Give it one: candle vault new-key --chain evm, then candle vault promote --from <cold> --to-key <prefix> (candle tee new is Solana only), and candle tee signer new --key <prefix> on the machine that trades."
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
export function typedDataAuthorization(wallet: TradingWallet, typedData: HyperliquidTypedData) {
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
  // BE-1584: what the build's own preview warns about (a wallet-wide timer, a protection gap).
  const preview = (build.preview ?? {}) as Record<string, unknown>
  const notes = [
    ...(Array.isArray(preview.warnings) ? preview.warnings : []),
    ...(typeof preview.warning === "string" ? [preview.warning] : []),
    ...(Array.isArray(preview.notes) ? preview.notes : []),
  ].map((line) => safeText(line))
  if (preview.reduceOnlyKey === true || build.perpsReduceOnly === true) notes.push("This key is reduce-only.")
  if (action.type === "scheduleCancel")
    return [
      "time" in action
        ? `Schedule Hyperliquid's cancel-all timer for ${new Date(Number(action.time)).toISOString()}.`
        : "Clear Hyperliquid's cancel-all timer.",
      ...notes,
    ]
  if (action.type === "updateIsolatedMargin")
    return [
      `Add ${safeText(Number(action.ntli) / 1_000_000)} USDC of isolated margin to asset ${safeText(action.asset)}.`,
      ...notes,
    ]
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
  return [...lines, ...notes]
}

async function confirm(ctx: CommandContext, build: Json, address: string, yes: boolean): Promise<boolean> {
  writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [
    ["Hyperliquid account", safeText(address)],
    ["Network", safeText(build.network)],
  ])
  if (ctx.deps.env.CANDLE_HYPERLIQUID_BUILDER !== undefined)
    notice(
      ctx.deps,
      ctx.json ? "stderr" : "stdout",
      "warning",
      `Builder trust override: ${builderPin(ctx)} (replaces this release's pin).\n`.trim(),
    )
  for (const line of previewLines(build)) notice(ctx.deps, ctx.json ? "stderr" : "stdout", "note", `${line}\n`.trim())
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or use --yes.")
  return (await ctx.deps.promptLine("Sign and submit? [y/N] ")).trim().toLowerCase() === "y"
}

/** Did Hyperliquid accept it? `status: "ok"`, and no per-order `error` inside an order answer. */
export function venueRefusal(exchange: unknown): string | null {
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
export async function runPerpsWrite(
  ctx: CommandContext,
  opts: {
    path: string
    body: Json
    wallet?: string
    yes: boolean
    submit: boolean
    signOnly: boolean
    /** The intent the build is bound to; by default the route's last segment. */
    method?: PerpsIntentMethod
  },
): Promise<number> {
  const key = await tradingKey(ctx)
  const { wallet } = await perpsWallet(ctx, key, opts.wallet, PERPS_SCOPE)
  if (!wallet) throw new TradingError("TEE_WALLET_REQUIRED", "No EVM TEE wallet resolved.")
  const builder = builderPin(ctx)
  const net = perpsNetwork(ctx)
  const method = opts.method ?? (opts.path.split("/").at(-1) as PerpsIntentMethod)
  // Setup (spec 2026-10-17 C, section 5): the mode comes from Hyperliquid itself, before Candle is
  // asked, and an unsupported one stops here with nothing requested, reserved or signed.
  let mode: string | undefined
  if (method === "setup") {
    try {
      mode = await hyperliquidAccountMode(ctx.deps.fetch, net, wallet.address)
    } catch (error) {
      throw new TradingError(
        "PERPS_UNAVAILABLE",
        `${error instanceof Error ? error.message : "Cannot read the account mode from Hyperliquid"}. Nothing was requested.`,
      )
    }
    if (!HYPERLIQUID_STANDARD_ACCOUNT_MODES.includes(mode))
      throw new TradingError(
        "PERPS_ACCOUNT_MODE",
        `This Hyperliquid account is in ${safeText(mode)} mode. Candle trades only a standard account and does not change modes; switch it back to standard mode on Hyperliquid, then run setup again. This is not a missing fee approval. Nothing was requested or signed.`,
      )
  }
  const clientId = typeof opts.body.clientId === "string" ? opts.body.clientId : undefined
  const build = await perpsRequest(ctx, key, opts.path, { walletId: wallet.id, ...opts.body })
  build.preview = {
    ...(build.preview as Json | undefined),
    builderTrust: {
      address: builder,
      source: ctx.deps.env.CANDLE_HYPERLIQUID_BUILDER === undefined ? "release" : "override",
    },
  }
  if (method === "setup") {
    const problem = perpsSetupStatusProblem(build, {
      network: net,
      address: wallet.address,
      builder,
      mode: mode as string,
    })
    if (problem)
      throw new TradingError("PERPS_BUILD_REFUSED", `Refused this setup answer: ${problem}. Nothing was signed.`)
  }
  // Setup with the builder already approved on Hyperliquid builds nothing: report the account.
  if (build.ready === true) return printTradingResult(ctx, build)
  // A retry under a client order id: the original operation, reported, and nothing signed or sent.
  if (build.replayed === true) {
    if (clientId === undefined || build.clientId !== clientId || build.walletId !== wallet.id)
      throw new TradingError(
        "PERPS_BUILD_REFUSED",
        "Refused a replay that does not name this request's client id and wallet. Nothing was signed.",
      )
    notice(
      ctx.deps,
      "stderr",
      "note",
      `Client id ${clientId} already names order ${safeText(build.perpOrderId)} (${safeText(build.status)}${build.venueStatus ? `, ${safeText(build.venueStatus)} on Hyperliquid` : ""}). Nothing was signed or sent; use a new --client-id for a new order.\n`.trim(),
    )
    return printTradingResult(ctx, build)
  }
  // An API that predates client ids drops the field and builds under a random cloid: refused.
  if (clientId !== undefined && (build.clientId !== clientId || build.cloid !== clientId))
    throw new TradingError(
      "PERPS_CLIENT_ID_UNSUPPORTED",
      "This Candle API did not echo the client order id, so a retry could not be recognized. Nothing was signed.",
    )
  // BE-1584 (spec D, section 4): every method is checked against this machine's own read of
  // Hyperliquid, and against the key's reduce-only setting as the build reports it.
  const verifyOpts = {
    builder,
    network: net,
    address: wallet.address,
    intent: { method, params: opts.body },
    keyReduceOnly: build.perpsReduceOnly === true,
  }
  const check =
    method === "setup"
      ? verifyPerpsBuild(build as never, verifyOpts)
      : await verifyPerpsBuildAgainstVenue(build as never, {
          ...verifyOpts,
          fetcher: ctx.deps.fetch,
          now: ctx.deps.now,
        })
  if (!check.ok)
    throw new TradingError("PERPS_BUILD_REFUSED", `Refused to sign this build: ${check.reason}. Nothing was signed.`)
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
      preview: { builderTrust: (build.preview as Json).builderTrust },
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
  // Judged per leg (spec D, section 3): HTTP 200 alone is not confirmation.
  const outcome = hyperliquidExchangeOutcome(exchange)
  if (outcome.status === "rejected")
    throw new TradingError(
      method === "scheduleCancel" ? "PERPS_SCHEDULE_CANCEL_REJECTED" : "PERPS_VENUE_REFUSED",
      `Hyperliquid refused it: ${safeText(outcome.error)}`,
      {
        details: {
          perpOrderId: build.perpOrderId,
          exchange,
          ...(method === "scheduleCancel" ? { limit: "scheduleCancel" } : {}),
        },
      },
    )
  if (outcome.status === "unknown")
    throw new TradingError(
      "PERPS_SUBMIT_FAILED",
      `Signed and submitted, but Hyperliquid's answer could not be read (${safeText(outcome.error)}). The signed action is in details.exchangeBody; check candle perps orders before acting again.`,
      { exitCode: 3, details: { perpOrderId: build.perpOrderId, exchangeBody, exchange } },
    )
  const extra = await afterConfirmed(ctx, key, net, wallet, build, method, opts.body, exchange)
  return printTradingResult(ctx, {
    ...extra,
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
    preview: { builderTrust: (build.preview as Json).builderTrust },
  } as Json)
}

const WRITE_FLAGS = { valueFlags: ["--wallet"], booleanFlags: ["--yes", "--no-submit", "--sign-only"] }

export function sharedWrite(values: Record<string, string>, booleans: Set<string>) {
  return {
    ...(values["--wallet"] !== undefined ? { wallet: values["--wallet"] } : {}),
    yes: booleans.has("--yes"),
    submit: !booleans.has("--no-submit"),
    signOnly: booleans.has("--sign-only"),
  }
}

export function slippage(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * BE-1584: what a confirmed action still records or reads. A scheduled cancel is acknowledged on
 * Candle (the only record of it; not proof the timer fires). A margin-mode change reports the mode
 * Hyperliquid shows afterwards beside the one asked for. Neither can turn a confirmed submit into a
 * failure: a failed follow-up is reported as such.
 */
async function afterConfirmed(
  ctx: CommandContext,
  key: string,
  net: HyperliquidNetwork,
  wallet: TradingWallet,
  build: Json,
  method: PerpsIntentMethod,
  body: Json,
  exchange: unknown,
): Promise<Json> {
  if (method === "scheduleCancel") {
    const preview = (build.preview ?? {}) as Record<string, unknown>
    let acknowledged = false
    try {
      const ack = await perpsRequest(ctx, key, "/api/v1/agent/perps/schedule-cancel/ack", {
        walletId: wallet.id,
        perpOrderId: build.perpOrderId as string,
        exchange: exchange as Json,
      })
      acknowledged = ack.acknowledged === true
    } catch {
      acknowledged = false
    }
    return {
      operation: preview.operation ?? null,
      time: (build.time as number | null | undefined) ?? null,
      acknowledged,
      verified: false,
    } as Json
  }
  if (method === "leverage" && typeof body.mode === "string") {
    let confirmedMode: string | null = null
    try {
      const res = await ctx.deps.fetch(HYPERLIQUID_EXCHANGE_URLS[net].replace("/exchange", "/info"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "activeAssetData",
          user: wallet.address,
          coin: String((build.preview as Record<string, unknown> | undefined)?.coin ?? body.coin),
        }),
      })
      const type = (JSON.parse(await res.text()) as { leverage?: { type?: unknown } })?.leverage?.type
      confirmedMode = type === "cross" || type === "isolated" ? type : null
    } catch {
      confirmedMode = null
    }
    return { requestedMode: body.mode, confirmedMode } as Json
  }
  return {}
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
  "Usage: candle perps open <coin> <long|short> <size> [--price <px>] [--tif Gtc|Alo|Ioc] [--slippage-bps <n>] [--tp <px>] [--sl <px>] [--client-id <0x+32 hex>] [--wallet <tee>] [--yes]"

/** `--client-id`: a cloid the caller chose, lowercased; null when malformed. */
function clientIdFlag(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined
  const lower = value.toLowerCase()
  return HYPERLIQUID_CLOID_RE.test(lower) ? lower : null
}

const CLIENT_ID_USAGE = "--client-id must be 0x followed by 32 hex digits."

export async function perpsOpen(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--price", "--tif", "--slippage-bps", "--tp", "--sl", "--client-id"],
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
  const clientId = clientIdFlag(values["--client-id"])
  if (clientId === null) return usage(ctx, CLIENT_ID_USAGE)
  const body: Json = {
    coin,
    side,
    size,
    ...(clientId !== undefined ? { clientId } : {}),
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
    valueFlags: ["--wallet", "--size", "--pct", "--slippage-bps", "--client-id"],
    booleanFlags: ["--yes", "--no-submit", "--sign-only"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin] = parsed.positionals
  if (parsed.positionals.length !== 1 || !coin)
    return usage(
      ctx,
      "Usage: candle perps close <coin> [--size <n> | --pct <1-100>] [--slippage-bps <n>] [--client-id <0x+32 hex>] [--wallet <tee>] [--yes]",
    )
  const size = parsed.values["--size"]
  if (size !== undefined && !DEC_RE.test(size)) return usage(ctx, "--size must be a plain decimal.")
  // BE-1584 (spec D, section 8): a percentage of the position, sized from a direct read.
  const pct = parsed.values["--pct"]
  if (pct !== undefined && hyperliquidClosePct(pct) === null)
    return usage(ctx, "--pct must be above 0 and at most 100, with at most 4 decimals.")
  if (pct !== undefined && size !== undefined) return usage(ctx, "Give --size or --pct, not both.")
  const slippageBps = slippage(parsed.values["--slippage-bps"])
  if (slippageBps === null) return usage(ctx, "--slippage-bps must be a whole number of at least 1.")
  const clientId = clientIdFlag(parsed.values["--client-id"])
  if (clientId === null) return usage(ctx, CLIENT_ID_USAGE)
  const body: Json = {
    coin,
    ...(clientId !== undefined ? { clientId } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(pct !== undefined ? { pct } : {}),
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

function formatUsdcMicros(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "?"
  const micros = BigInt(value)
  const frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return frac ? `${micros / 1_000_000n}.${frac}` : `${micros / 1_000_000n}`
}

export async function perpsPositions(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps positions [--wallet <tee>]")
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, parsed.values["--wallet"])
    const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(row.id)}`)
    // BE-1582 (spec A-3): every field the server sends, unchanged, plus `rows`, `accountLine` and
    // `risk` from a direct read of Hyperliquid on this machine. The two reads are separate requests
    // (the server caches for about 2 s); the three additions all come from the direct one.
    const additions = await positionsAdditions(ctx, key, row)
    if (ctx.json) return printTradingResult(ctx, { ...result, ...additions })

    writeFields(ctx.deps, "stdout", [
      ["Address", safeText(result.address)],
      ["Network", safeText(result.network)],
      ["Mode", safeText(result.mode)],
    ])
    writePositionsText(ctx, additions)
    // BE-1573 (withdrawals W1): what can leave the account now, and any withdrawal in flight. An API
    // that predates withdrawals sends no `openWithdrawals`, and the line says only what it knows.
    const open = Array.isArray(result.openWithdrawals) ? (result.openWithdrawals as Record<string, unknown>[]) : null
    writeFields(ctx.deps, "stdout", [
      ["Withdrawable now", `${safeText(result.withdrawable)} USDC`],
      ["Withdrawal in flight", open === null ? undefined : open.length === 0 ? "none" : open.length],
    ])
    for (const w of open ?? []) {
      writeFields(ctx.deps, "stdout", [
        ["Withdrawal", safeText(w.id)],
        ["Status", safeText(w.status)],
        ["Amount", `${formatUsdcMicros(w.amountUsdcMicros)} USDC`],
        ["To", safeText(w.to)],
        ["Check", `candle perps withdraw status ${safeText(w.id)}`],
      ])
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
    const open = (result.open ?? []) as Record<string, unknown>[]
    writeFields(ctx.deps, "stdout", [["Orders", open.length]], "Open on Hyperliquid")
    for (const o of open) {
      writeFields(ctx.deps, "stdout", [
        ["Coin", safeText(o.coin)],
        ["Side", o.side === "B" ? "buy" : "sell"],
        ["Size", safeText(o.sz)],
        ["Limit price", safeText(o.limitPx)],
        ["Reduce only", o.reduceOnly ? "yes" : "no"],
        ["Trigger", o.isTrigger ? safeText(o.triggerPx) : undefined],
        ["Client order id", o.cloid ? safeText(o.cloid) : undefined],
      ])
    }
    const recorded = (result.recorded ?? []) as Record<string, unknown>[]
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Orders", recorded.length],
        ["Order", "newest first"],
      ],
      "Built by Candle",
    )
    for (const r of recorded) {
      writeFields(ctx.deps, "stdout", [
        ["Kind", safeText(r.kind)],
        ["Coin", r.coin ? safeText(r.coin) : undefined],
        ["Status", safeText(r.status)],
        ["Venue status", r.venueStatus ? safeText(r.venueStatus) : undefined],
        ["Client order id", r.cloid ? safeText(r.cloid) : undefined],
        ["Target client order id", r.targetCloid ? safeText(r.targetCloid) : undefined],
      ])
    }
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── fills and funding (BE-1583, spec 2026-10-17 C, sections 3 and 4) ─────────────────────────

const HISTORY_FLAGS = { valueFlags: ["--wallet", "--start-time", "--end-time", "--limit", "--cursor"] }

function epochMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  return /^[0-9]{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
}

/**
 * `candle perps fills|funding`: one page of the wallet's history, read directly from Hyperliquid's
 * `/info`. Candle only resolves which EVM TEE wallet is this key's; no Candle credential reaches
 * Hyperliquid, and a read-only key with no signer is enough. Wallet-level live venue data, not
 * Candle's ledger.
 */
async function perpsHistory(kind: "fills" | "funding", args: string[], ctx: CommandContext): Promise<number> {
  const usageLine = `Usage: candle perps ${kind} [--wallet <tee>] [--start-time <ms>] [--end-time <ms>] [--limit <n>] [--cursor <cursor>]`
  const parsed = parseArgs(args, HISTORY_FLAGS)
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, usageLine)
  const { values } = parsed
  const startTime = epochMs(values["--start-time"])
  const endTime = epochMs(values["--end-time"])
  if (startTime === null || endTime === null)
    return usage(ctx, "--start-time and --end-time are epoch milliseconds, e.g. 1790000000000.")
  const max = PERPS_HISTORY_MAX_LIMIT[kind]
  const limitRaw = values["--limit"]
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!/^[0-9]{1,4}$/.test(limitRaw as string) || limit < 1 || limit > max))
    return usage(ctx, `--limit must be a whole number from 1 to ${max}.`)
  if (startTime !== undefined && endTime !== undefined && startTime > endTime)
    return usage(ctx, "--start-time must not be after --end-time.")
  const cursor = values["--cursor"]
  try {
    const key = await tradingKey(ctx)
    const { row } = await perpsWallet(ctx, key, values["--wallet"])
    const page = (await readPerpsHistoryPage({
      kind,
      network: perpsNetwork(ctx),
      walletId: row.id,
      address: row.address,
      options: {
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      fetch: ctx.deps.fetch,
      now: ctx.deps.now,
    })) as PerpsFillsPage | PerpsFundingPage
    if (ctx.json) return printTradingResult(ctx, page as unknown as Json)
    const walletFlag = values["--wallet"] !== undefined ? ` --wallet ${values["--wallet"]}` : ""
    for (const line of perpsHistoryLines(
      page,
      (next) => `Next page: candle perps ${kind}${walletFlag} --cursor ${next}`,
    ))
      notice(ctx.deps, "stdout", "note", `${line}\n`.trim())
    return 0
  } catch (error) {
    if (error instanceof PerpsHistoryError) {
      if (error.code === "VALIDATION_FAILED") return usage(ctx, error.message)
      return tradingFailure(
        ctx,
        new TradingError(error.code, error.message, {
          suggestion:
            error.extra.retryAfterMs !== undefined
              ? `Retry after ${Math.ceil(error.extra.retryAfterMs / 1000)}s with the same command${cursor ? " and --cursor" : ""}.`
              : `Retry shortly with the same command${cursor ? " and --cursor" : ""}.`,
        }),
      )
    }
    return tradingFailure(ctx, error)
  }
}

export function perpsFills(args: string[], ctx: CommandContext): Promise<number> {
  return perpsHistory("fills", args, ctx)
}

export function perpsFunding(args: string[], ctx: CommandContext): Promise<number> {
  return perpsHistory("funding", args, ctx)
}

// ── deposit (BE-647, HL-ED-8, R2) ────────────────────────────────────────────────────────────

/** Relay's chain and currency for Hyperliquid perps USDC: what every deposit build must name. */
const HYPERLIQUID_RELAY_CHAIN_ID = 1337
const HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000"
const DEPOSIT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const DEPOSIT_USAGE =
  "Usage: candle perps deposit <amount> <SOL|USDC|ETH|USDG> [--wallet <tee>] [--to <evm tee>] [--id <clientDepositId>] [--slippage-bps <n>] [--rpc-url <url>] [--yes] [--no-submit] | candle perps deposit status <clientDepositId>"

/** A preview's planned Hood legs (BE-1747): kind and calldata, nothing sequenced. */
const plannedDepositLegsSchema = z
  .array(
    z.object({
      kind: z.enum(["approval", "bridgeDeposit"]),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
      value: z.string().regex(/^(0|[1-9][0-9]*)$/),
    }),
  )
  .min(1)
  .max(2)

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
  writeFields(ctx.deps, "stdout", [
    ["Deposit", safeText(id)],
    ["Status", safeText(job.status)],
    ["Signature", job.signature ? safeText(job.signature) : undefined],
    ["Raw amount", safeText(job.amountRaw)],
    ["Asset", safeText(job.asset)],
    ["Hyperliquid account", safeText(destination.address)],
    ["Relay", relay ? safeText(relay.status) : undefined],
  ])
  return 0
}

/**
 * `candle perps deposit`: move USDC onto the key's Hyperliquid account through Relay, from its Hood
 * or Solana TEE wallet. The asset decides the paying chain. From Hood the account is the paying
 * wallet's own address; from Solana it is the key's EVM TEE wallet (`--to` names it when the key has
 * more than one). Needs `swap:write`; any cap on the asset still applies. `candle perps withdraw` brings it
 * back to the key's own Solana or Hood TEE wallet (`perps:withdraw`); `tee disable` and `tee sweep`
 * do not reach it, so withdraw before disabling.
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
    // BE-1747: --no-submit asks for a preview, which locks no wallet, reserves no USD window and
    // records no id; an API that predates previews builds for real, and that is reported below.
    const noSubmit = parsed.booleans.has("--no-submit")
    writeFields(ctx.deps, "stderr", [["Deposit", id]])
    const build = await perpsRequest(ctx, key, "/api/v1/agent/perps/deposit", {
      clientDepositId: id,
      walletId: wallet.id,
      asset,
      amountRaw,
      maxSlippageBps: slippageBps,
      ...(origin === "solana" ? { perpsWalletId: destination.id } : {}),
      ...(noSubmit ? { preview: true } : {}),
    })
    const preview = build.preview === true
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
    let previewLegs: LegKind[] | undefined
    let transaction: string | undefined
    const hoodOrigin = asset === "ETH" || asset === "USDG" ? asset : undefined
    if (hoodOrigin && preview) {
      // A preview's Hood legs are calldata only (nothing sequenced): every one gets the leg check.
      const planned = plannedDepositLegsSchema.safeParse(build.plannedLegs)
      if (!planned.success) throw refused("Candle did not answer with the planned Hood legs")
      previewLegs = planned.data.map((leg) => leg.kind)
      if (!bridgePlanAdmitted(hoodOrigin, previewLegs)) throw refused(`the plan is ${previewLegs.join(", ")}`)
      for (const leg of planned.data) {
        const legProblem = relayHoodLegProblem(leg.kind, leg, { origin: hoodOrigin, payer: wallet.address, amountRaw })
        if (legProblem) throw refused(legProblem)
      }
    } else if (hoodOrigin) {
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
      // SEC-003: as for a bridge, the simulation holds the deposit to the confirmed amount of the
      // confirmed asset; the wallet loses nothing else and keeps control of every account it owns.
      const spent = await tradingRead(ctx, reader, () =>
        solanaSpendProblem(transaction as string, wallet.address, reader.rpc, {
          kind: "swap",
          spend: asset === "SOL" ? "SOL" : (BASES[asset]?.mint ?? asset),
          maxSpendRaw: BigInt(amountRaw),
        }),
      )
      if (spent) throw refused(spent)
    }

    const decimals = Number(build.outDecimals)
    const minimum = decimalAmount(String(build.minimumOutRaw), decimals)
    const estimate = decimalAmount(String(build.expectedOutRaw), decimals)

    writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [
      ["Deposit", `${amount} ${asset}`],
      ["From", safeText(wallet.address)],
      ["Origin", `${origin === "hood" ? "Hood" : "Solana"} TEE wallet`],
      ["Hyperliquid account", safeText(destination.address)],
      ["Route", "Relay"],
      ["Minimum USDC", minimum],
      ["Estimated USDC", estimate],
      ["Candle fee", "none"],
    ])
    if (build.firstDeposit)
      notice(
        ctx.deps,
        ctx.json ? "stderr" : "stdout",
        "warning",
        "Hyperliquid keeps 1 USDC to activate this new account.",
      )
    notice(
      ctx.deps,
      ctx.json ? "stderr" : "stdout",
      "warning",
      "To bring it back: candle perps withdraw <amount> --to solana|hood (perps:withdraw). `candle tee disable` and `tee sweep` do not reach it, so withdraw before disabling.\n".trim(),
    )
    if (sequenced)
      writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [
        ["Legs (signed one at a time)", sequenced.plannedLegCount === 2 ? "approval, bridgeDeposit" : "bridgeDeposit"],
      ])
    if (previewLegs)
      writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [["Legs (signed one at a time)", previewLegs.join(", ")]])
    if (noSubmit) {
      if (preview)
        notice(
          ctx.deps,
          "stderr",
          "note",
          "Dry run: nothing was signed, no wallet is held and no limit was used; the same --id still builds a new deposit.\n".trim(),
        )
      else
        notice(
          ctx.deps,
          "stderr",
          "note",
          `This server predates dry-run deposits and built this one for real. Nothing was signed, but ${sequenced ? `operation ${sequenced.operationId} holds this wallet until ${new Date(sequenced.expiresAt).toISOString()}, and ` : ""}the build counts against the key's limits until it expires.\n`.trim(),
        )
      return printTradingResult(ctx, { ...build, signed: false, submitted: false })
    }
    if (!parsed.booleans.has("--yes")) {
      if (!ctx.deps.isTTY.stdin)
        throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or use --yes.")
      if ((await ctx.deps.promptLine("Sign and send? [y/N] ")).trim().toLowerCase() !== "y") {
        if (sequenced)
          notice(
            ctx.deps,
            "stderr",
            "note",
            `Nothing was signed. Operation ${sequenced.operationId} holds this wallet until ${new Date(sequenced.expiresAt).toISOString()}.\n`.trim(),
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
    notice(
      ctx.deps,
      "stderr",
      "note",
      `Deposit sent; Relay fills it on Hyperliquid. Check it with candle perps deposit status ${id}.\n`.trim(),
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
