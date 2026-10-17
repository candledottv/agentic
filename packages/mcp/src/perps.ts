/**
 * Hyperliquid perps B (BE-646, spec 2026-10-01-hyperliquid-perps-tee-design.md, HL-ED-2, HL-ED-5,
 * HL-ED-11): the seven `candle_perps_*` tools, the MCP mirror of `candle perps`, and from perps C
 * (BE-647, HL-ED-8) `candle_perps_deposit`.
 *
 * Same discipline as the CLI and the SDK. Candle's server builds each action; this server
 * recomputes the action hash from the plaintext and checks the action type, Candle's builder and
 * the typed-data shape (`verifyPerpsBuild` in hyperliquid.ts, the SDK's file byte for byte) before
 * anything is signed; the relay signs; this server posts the signed action to Hyperliquid itself.
 * A build that fails the check is refused with nothing signed.
 *
 * Signing needs the key signer's private key, which an MCP server otherwise never holds. It reads
 * it from `CANDLE_KEY_SIGNER_PEM_FILE`, the plaintext PEM `candle tee signer new --out <pem>`
 * writes for exactly this kind of process. Without it the write tools refuse before any build, so
 * no claim is stamped and nothing is reserved. The reads need only the API key.
 *
 * `CANDLE_HYPERLIQUID_BUILDER` pins Candle's builder; unset, this release's constant applies when
 * it carries one, else the builder `/perps/config` reports. `CANDLE_HYPERLIQUID_NETWORK=testnet`
 * trades testnet.
 *
 * BE-1583 (spec 2026-10-17-hyperliquid-phase1-c-small-items-design.md): `candle_perps_fills` and
 * `candle_perps_funding` page history straight from Hyperliquid's `/info` (`perps-history.ts`, the
 * SDK's file byte for byte) and need only the API key; setup reads the account mode from
 * Hyperliquid first and checks Candle's answer, `ready` included; open and close take `clientId`,
 * and a retry under it returns the original operation with nothing signed.
 */
import { createPrivateKey, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { RequestConfig } from "./client"
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  HYPERLIQUID_EXCHANGE_URLS,
  HYPERLIQUID_STANDARD_ACCOUNT_MODES,
  type HyperliquidNetwork,
  type HyperliquidTypedData,
  hyperliquidAccountMode,
  hyperliquidCanonicalJson,
  hyperliquidCloseOrder,
  hyperliquidExchangeBody,
  hyperliquidOrderMarket,
  hyperliquidRelayBody,
  perpsSetupStatusProblem,
  verifyPerpsBuild,
} from "./hyperliquid"
import type { FetchLike, ToolText } from "./orchestrate"
import { PERPS_HISTORY_MAX_LIMIT, PerpsHistoryError, readPerpsHistoryPage } from "./perps-history"

import { executePerpsRisk, positionsAdditions } from "./perps-risk"

/** BE-1582 (spec A-12): the read-only risk tools; perps-risk.ts runs them. None signs. */
export const PERPS_RISK_TOOL_NAMES = [
  "candle_perps_account",
  "candle_perps_risk",
  "candle_perps_thresholds",
  "candle_perps_set_thresholds",
] as const
export type PerpsRiskToolName = (typeof PERPS_RISK_TOOL_NAMES)[number]

export const PERPS_TOOL_NAMES = [
  "candle_perps_setup",
  "candle_perps_open",
  "candle_perps_close",
  "candle_perps_cancel",
  "candle_perps_orders",
  "candle_perps_positions",
  "candle_perps_fills",
  "candle_perps_funding",
  "candle_perps_leverage",
  ...PERPS_RISK_TOOL_NAMES,
] as const
export type PerpsToolName = (typeof PERPS_TOOL_NAMES)[number]

const isRiskTool = (tool: PerpsToolName): tool is PerpsRiskToolName =>
  (PERPS_RISK_TOOL_NAMES as readonly string[]).includes(tool)

const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, "a plain decimal string")
const wallet = z
  .string()
  .optional()
  .describe("The EVM TEE wallet by id, address or label. Omit when the key has exactly one.")
const submit = z.boolean().optional().describe("false: build and check only, sign and submit nothing. Default true.")
const clientId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{32}$/)
  .optional()
  .describe(
    "Optional client order id (0x + 32 hex) used as the order's cloid. Retrying with the same id and request returns " +
      "the original operation (replayed: true) and signs nothing; the same id with another request is refused " +
      "(PERPS_CLIENT_ID_CONFLICT). It deduplicates, it does not resume. Use a new id for a new order.",
  )
const epochMs = z.number().int().min(0)
const history = (max: number) => ({
  wallet,
  startTime: epochMs.optional().describe("Inclusive epoch milliseconds. Default: 7 days before endTime."),
  endTime: epochMs.optional().describe("Inclusive epoch milliseconds. Default: now, fixed into the cursor."),
  limit: z.number().int().min(1).max(max).optional().describe(`Rows per page (default 100, at most ${max}).`),
  cursor: z
    .string()
    .min(1)
    .max(200_000)
    .optional()
    .describe("nextCursor from the previous page. The window and limit must not change."),
})

export const perpsShapes = {
  candle_perps_setup: { wallet, submit },
  candle_perps_open: {
    coin: z.string().describe("A market on Hyperliquid's main perp exchange, e.g. BTC"),
    side: z.enum(["long", "short"]),
    size: decimal.describe('Size in the coin, decimal (e.g. "0.01")'),
    price: decimal.optional().describe("Limit price. Omit for a market order (IOC within slippageBps of the mid)."),
    tif: z.enum(["Gtc", "Alo", "Ioc"]).optional().describe("With price: time in force (default Gtc)"),
    slippageBps: z.number().int().min(1).optional(),
    takeProfit: decimal.optional().describe("Reduce-only take-profit trigger price"),
    stopLoss: decimal.optional().describe("Reduce-only stop-loss trigger price"),
    clientId,
    wallet,
    submit,
  },
  candle_perps_close: {
    coin: z.string(),
    size: decimal.optional().describe("Part of the position to close; the whole position when omitted"),
    slippageBps: z.number().int().min(1).optional(),
    clientId,
    wallet,
    submit,
  },
  candle_perps_cancel: {
    cloid: z
      .string()
      .regex(/^0x[0-9a-fA-F]{32}$/)
      .describe("The cloid of an order Candle built (an open, or one of its take-profit / stop-loss legs)"),
    wallet,
    submit,
  },
  candle_perps_orders: { wallet, limit: z.number().int().min(1).max(200).optional() },
  candle_perps_positions: { wallet },
  candle_perps_fills: history(PERPS_HISTORY_MAX_LIMIT.fills),
  candle_perps_funding: history(PERPS_HISTORY_MAX_LIMIT.funding),
  candle_perps_leverage: {
    coin: z.string(),
    leverage: z.number().int().min(1),
    mode: z.enum(["cross", "isolated"]).optional(),
    wallet,
    submit,
  },
} as const

const PATHS: Record<Exclude<PerpsToolName, PerpsRiskToolName>, string> = {
  candle_perps_setup: "/api/v1/agent/perps/setup",
  candle_perps_open: "/api/v1/agent/perps/open",
  candle_perps_close: "/api/v1/agent/perps/close",
  candle_perps_cancel: "/api/v1/agent/perps/cancel",
  candle_perps_orders: "/api/v1/agent/perps/orders",
  candle_perps_positions: "/api/v1/agent/perps/positions",
  candle_perps_fills: "",
  candle_perps_funding: "",
  candle_perps_leverage: "/api/v1/agent/perps/leverage",
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolText {
  return { text: JSON.stringify({ success: false, error: { code, message }, ...extra }), isError: true }
}

interface WalletRow {
  id: string
  address: string
  label?: string
  chain: string
  privyWalletId?: string
}

export class Refusal extends Error {
  constructor(readonly tool: ToolText) {
    super("refused")
  }
}

export async function call(
  cfg: RequestConfig,
  fetch: FetchLike,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  if (!res.ok) {
    // An API that predates the perps router answers a bare 404.
    if (res.status === 404 && (typeof parsed !== "object" || parsed === null))
      throw new Refusal(fail("PERPS_NOT_ENABLED", "This Candle deployment does not serve perps routes."))
    throw new Refusal({ text: typeof parsed === "string" ? parsed : JSON.stringify(parsed), isError: true })
  }
  if (typeof parsed !== "object" || parsed === null) throw new Refusal(fail("INVALID_RESPONSE", "Not a JSON object"))
  return parsed as Record<string, unknown>
}

export async function walletFor(
  cfg: RequestConfig,
  fetch: FetchLike,
  name: string | undefined,
  scope?: string,
): Promise<{ row: WalletRow; appId: string }> {
  const listed = await call(cfg, fetch, "GET", "/api/v1/agent/wallets/trading")
  if (scope && !(Array.isArray(listed.scopes) && listed.scopes.includes(scope)))
    throw new Refusal(fail("SCOPE_MISSING", `The key needs ${scope}.`))
  const rows = (Array.isArray(listed.page) ? listed.page : []) as WalletRow[]
  const evm = rows.filter((row) => row.chain === "evm")
  const matches =
    name === undefined
      ? evm
      : evm.filter((row) => row.id === name || row.label === name || row.address.toLowerCase() === name.toLowerCase())
  if (matches.length !== 1)
    throw new Refusal(
      fail(
        "TEE_WALLET_REQUIRED",
        evm.length === 0
          ? "This key has no EVM TEE wallet bound to it."
          : `Name exactly one EVM TEE wallet: ${evm.map((row) => row.label ?? row.id).join(", ")}`,
      ),
    )
  return { row: matches[0] as WalletRow, appId: typeof listed.privyAppId === "string" ? listed.privyAppId : "" }
}

async function builderPin(cfg: RequestConfig, fetch: FetchLike, env: Record<string, string | undefined>) {
  const pinned = env.CANDLE_HYPERLIQUID_BUILDER?.trim() || CANDLE_HYPERLIQUID_BUILDER_ADDRESS
  if (pinned) return pinned.toLowerCase()
  const config = await call(cfg, fetch, "GET", "/api/v1/agent/perps/config")
  if (typeof config.builder !== "string")
    throw new Refusal(fail("PERPS_NOT_CONFIGURED", "The server reports no Hyperliquid builder address."))
  return config.builder.toLowerCase()
}

/** Run one `candle_perps_*` tool. */
export async function executePerps(
  tool: PerpsToolName,
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  fetch: FetchLike,
): Promise<ToolText> {
  if (!cfg.apiKey) return fail("MCP_VALIDATION", "CANDLE_AGENT_API_KEY is required for this tool.")
  if (isRiskTool(tool)) return executePerpsRisk(tool, args, cfg, env, fetch)
  const network: HyperliquidNetwork = env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet"
  const name = typeof args.wallet === "string" ? args.wallet : undefined
  try {
    if (tool === "candle_perps_orders" || tool === "candle_perps_positions") {
      const { row } = await walletFor(cfg, fetch, name)
      const query = new URLSearchParams({ walletId: row.id })
      if (typeof args.limit === "number") query.set("limit", String(args.limit))
      const result = await call(cfg, fetch, "GET", `${PATHS[tool]}?${query}`)
      // BE-1582 (spec A-3): positions keeps the server's fields and adds rows, accountLine and risk
      // from a direct read of Hyperliquid by this server.
      if (tool === "candle_perps_positions")
        return { text: JSON.stringify({ ...result, ...(await positionsAdditions(cfg, fetch, env, row)) }) }
      return { text: JSON.stringify(result) }
    }
    if (tool === "candle_perps_fills" || tool === "candle_perps_funding") {
      // Candle resolves only which EVM TEE wallet is this key's; the history comes straight from
      // Hyperliquid, and the API key never goes there.
      const { row } = await walletFor(cfg, fetch, name)
      try {
        const page = await readPerpsHistoryPage({
          kind: tool === "candle_perps_fills" ? "fills" : "funding",
          network,
          walletId: row.id,
          address: row.address,
          options: {
            ...(typeof args.startTime === "number" ? { startTime: args.startTime } : {}),
            ...(typeof args.endTime === "number" ? { endTime: args.endTime } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
          },
          fetch: fetch as never,
          now: Date.now,
        })
        return { text: JSON.stringify(page) }
      } catch (error) {
        if (error instanceof PerpsHistoryError)
          return fail(error.code, error.message, {
            ...(error.extra.field ? { field: error.extra.field } : {}),
            ...(error.extra.retryable ? { retryable: true } : {}),
            ...(error.extra.retryAfterMs !== undefined ? { retryAfterMs: error.extra.retryAfterMs } : {}),
          })
        throw error
      }
    }

    // A write. The signer is checked before any build, so a server that cannot sign stamps nothing.
    const willSubmit = args.submit !== false
    const pemFile = env.CANDLE_KEY_SIGNER_PEM_FILE?.trim()
    let signerPem: string | null = null
    if (willSubmit) {
      if (!pemFile)
        return fail(
          "SIGNER_UNAVAILABLE",
          "Set CANDLE_KEY_SIGNER_PEM_FILE to the key signer PEM (candle tee signer new --out <pem>) to sign perps actions.",
        )
      try {
        signerPem = await readFile(pemFile, "utf8")
        createPrivateKey(signerPem)
      } catch {
        return fail("SIGNER_UNAVAILABLE", "CANDLE_KEY_SIGNER_PEM_FILE does not hold a readable private key PEM.")
      }
    }
    const { row, appId } = await walletFor(cfg, fetch, name, "perps:write")
    const builder = await builderPin(cfg, fetch, env)
    const { wallet: _w, submit: _s, ...rest } = args
    const clientId = typeof rest.clientId === "string" ? rest.clientId.toLowerCase() : undefined
    const fields: Record<string, unknown> = { ...rest, ...(clientId !== undefined ? { clientId } : {}) }
    const method = PATHS[tool].split("/").at(-1) as "setup" | "open" | "close" | "cancel" | "leverage"
    // Setup (spec 2026-10-17 C, section 5): the mode is read from Hyperliquid before Candle is asked.
    let mode: string | undefined
    if (method === "setup") {
      try {
        mode = await hyperliquidAccountMode(fetch as never, network, row.address)
      } catch (error) {
        return fail(
          "PERPS_UNAVAILABLE",
          `${error instanceof Error ? error.message : "Cannot read the account mode"}. Nothing was requested.`,
        )
      }
      if (!HYPERLIQUID_STANDARD_ACCOUNT_MODES.includes(mode))
        return fail(
          "PERPS_ACCOUNT_MODE",
          `This Hyperliquid account is in ${mode} mode. Candle trades only a standard account and does not change modes; this is not a missing fee approval. Nothing was requested or signed.`,
          { mode },
        )
    }
    const build = await call(cfg, fetch, "POST", PATHS[tool], {
      walletId: row.id,
      ...fields,
      ...(tool === "candle_perps_open" ? { type: fields.price === undefined ? "market" : "limit" } : {}),
    })
    if (method === "setup") {
      const problem = perpsSetupStatusProblem(build, { network, address: row.address, builder, mode: mode as string })
      if (problem) return fail("PERPS_BUILD_REFUSED", `Refused this setup answer: ${problem}. Nothing was signed.`)
    }
    if (build.ready === true) return { text: JSON.stringify(build) }
    // A retry under a client order id: the original operation, and nothing signed or sent.
    if (build.replayed === true) {
      if (clientId === undefined || build.clientId !== clientId || build.walletId !== row.id)
        return fail(
          "PERPS_BUILD_REFUSED",
          "Refused a replay that does not name this request's client id and wallet. Nothing was signed.",
        )
      return { text: JSON.stringify(build) }
    }
    // An API that predates client ids drops the field and builds under a random cloid: refused.
    if (clientId !== undefined && (build.clientId !== clientId || build.cloid !== clientId))
      return fail(
        "PERPS_CLIENT_ID_UNSUPPORTED",
        "This Candle API did not echo the client order id, so a retry could not be recognized. Nothing was signed.",
      )
    const check = verifyPerpsBuild(build as never, {
      builder,
      network,
      address: row.address,
      intent: { method, params: fields },
    })
    if (!check.ok)
      return fail("PERPS_BUILD_REFUSED", `Refused to sign this build: ${check.reason}. Nothing was signed.`)
    if (method === "close") {
      const closeOrder = await hyperliquidCloseOrder(fetch, network, row.address, fields)
      const closeCheck = verifyPerpsBuild(build as never, {
        builder,
        network,
        address: row.address,
        intent: { method, params: fields },
        closeOrder,
      })
      if (!closeCheck.ok)
        return fail("PERPS_BUILD_REFUSED", `Refused to sign this build: ${closeCheck.reason}. Nothing was signed.`)
    }
    if (method === "open") {
      // The asset index and price against Hyperliquid's own market, not the build's (SEC-004).
      const market = await hyperliquidOrderMarket(fetch, network, row.address, method, fields)
      const marketCheck = verifyPerpsBuild(build as never, {
        builder,
        network,
        address: row.address,
        intent: { method, params: fields },
        market,
      })
      if (!marketCheck.ok)
        return fail("PERPS_BUILD_REFUSED", `Refused to sign this build: ${marketCheck.reason}. Nothing was signed.`)
    }
    if (!willSubmit || signerPem === null)
      return { text: JSON.stringify({ ...build, signed: false, submitted: false }) }
    if (!appId || !row.privyWalletId)
      return fail("SIGNER_UNAVAILABLE", "The server did not return its relay identifiers.")

    const body = hyperliquidRelayBody(build.typedData as HyperliquidTypedData)
    const payload = hyperliquidCanonicalJson({
      body,
      headers: { "privy-app-id": appId },
      method: "POST",
      url: `https://api.privy.io/v1/wallets/${row.privyWalletId}/rpc`,
      version: 1,
    })
    const authorizationSignature = sign("sha256", Buffer.from(payload), signerPem).toString("base64")
    const relay = await call(cfg, fetch, "POST", `/api/v1/agent/wallets/${encodeURIComponent(row.id)}/sign`, {
      authorizationSignature,
      body,
    })
    const signature = relay.signature
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
      return fail("INVALID_RESPONSE", "The relay did not return a signature.")
    const exchangeBody = hyperliquidExchangeBody(
      build.action as Record<string, unknown>,
      build.nonce as number,
      signature,
    )
    let exchange: unknown
    try {
      const res = await fetch(HYPERLIQUID_EXCHANGE_URLS[network], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exchangeBody),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      exchange = JSON.parse(text)
    } catch (error) {
      // The signature stays valid until the nonce leaves the two-day window: hand it back.
      return fail(
        "PERPS_SUBMIT_FAILED",
        `Signed, but the submit to Hyperliquid failed (${error instanceof Error ? error.message : "unknown"}). POST exchangeBody to Hyperliquid's /exchange to resubmit.`,
        { perpOrderId: build.perpOrderId, exchangeBody },
      )
    }
    const accepted =
      typeof exchange === "object" &&
      exchange !== null &&
      (exchange as { status?: unknown }).status === "ok" &&
      !(
        ((exchange as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses ?? []) as unknown[]
      ).some((status) => typeof status === "object" && status !== null && "error" in status)
    return {
      text: JSON.stringify({
        success: accepted,
        perpOrderId: build.perpOrderId,
        kind: build.kind,
        network: build.network,
        address: row.address,
        ...(build.cloid ? { cloid: build.cloid } : {}),
        ...(build.childCloids ? { childCloids: build.childCloids } : {}),
        nonce: build.nonce,
        signature,
        exchange,
      }),
      ...(accepted ? {} : { isError: true }),
    }
  } catch (error) {
    if (error instanceof Refusal) return error.tool
    return fail("MCP_TRANSPORT", error instanceof Error ? error.message : "The perps call failed.")
  }
}

// ── candle_perps_deposit (Perps C, BE-647, HL-ED-8) ──────────────────────────────────────────

/** Relay's chain and currency for Hyperliquid perps USDC: what every deposit build must name. */
const HYPERLIQUID_RELAY_CHAIN_ID = 1337
const HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000"
const DEPOSIT_ASSETS = {
  SOL: { chain: "solana", decimals: 9 },
  USDC: { chain: "solana", decimals: 6 },
  ETH: { chain: "evm", decimals: 18 },
  USDG: { chain: "evm", decimals: 6 },
} as const
type DepositAsset = keyof typeof DEPOSIT_ASSETS

export const perpsDepositShape = {
  asset: z
    .enum(["SOL", "USDC", "ETH", "USDG"])
    .describe("What to deposit. SOL or USDC pay from the key's Solana TEE wallet; ETH or USDG from its Hood one."),
  amount: decimal.describe('Amount of the asset, decimal (e.g. "25")'),
  wallet: z
    .string()
    .optional()
    .describe("The paying TEE wallet by id, address or label. Omit when the key has exactly one on that chain."),
  perpsWallet: z
    .string()
    .optional()
    .describe("From Solana only: the EVM TEE wallet whose Hyperliquid account receives it. Omit when the key has one."),
  clientDepositId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional()
    .describe("Idempotency id; the same id answers the deposit it already built. Default: a new one."),
  maxSlippageBps: z.number().int().min(1).max(1000).optional().describe("Relay slippage (default 100)"),
  submit,
} as const

function rawUnits(amount: string, decimals: number): string | null {
  const [whole = "", fraction = ""] = amount.split(".")
  if (fraction.length > decimals) return null
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"))
  return raw > 0n ? raw.toString() : null
}

function pickWallet(rows: WalletRow[], chain: string, name: string | undefined, what: string): WalletRow {
  const onChain = rows.filter((row) => row.chain === chain)
  const matches =
    name === undefined
      ? onChain
      : onChain.filter(
          (row) => row.id === name || row.label === name || row.address.toLowerCase() === name.toLowerCase(),
        )
  if (matches.length !== 1)
    throw new Refusal(
      fail(
        "TEE_WALLET_REQUIRED",
        onChain.length === 0
          ? `This key has no ${what} bound to it.`
          : `Name exactly one ${what}: ${onChain.map((row) => row.label ?? row.id).join(", ")}`,
      ),
    )
  return matches[0] as WalletRow
}

/** Why the deposit build must not be signed, or null. */
function depositProblem(
  build: Record<string, unknown>,
  expect: { walletId: string; asset: DepositAsset; amountRaw: string; account: string; hood: boolean },
): string | null {
  const destination = (build.destination ?? {}) as Record<string, unknown>
  const fee = (build.fee ?? {}) as Record<string, unknown>
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()
  if (build.walletId !== expect.walletId) return "the build names another paying wallet"
  if (build.asset !== expect.asset || build.amountRaw !== expect.amountRaw) return "the build is for another amount"
  if (destination.chainId !== HYPERLIQUID_RELAY_CHAIN_ID) return "the build does not land on Hyperliquid"
  if (destination.currency !== HYPERLIQUID_RELAY_USDC) return "the build does not deliver Hyperliquid USDC"
  if (!same(destination.address, expect.account)) return "the build lands on another account"
  if (fee.bps !== 0 || fee.feeRaw !== "0") return "the build carries a Candle fee"
  if (expect.hood !== (build.chain === "hood")) return "the build pays from the wrong chain"
  if (!expect.hood && !(Array.isArray(build.transactionsBase64) && build.transactionsBase64.length === 1))
    return "the build is not one Solana deposit"
  return null
}

/**
 * Run `candle_perps_deposit`: Relay moves the asset from the key's Hood or Solana TEE wallet onto
 * Hyperliquid perps USDC at the key's EVM TEE wallet's own address. Candle builds and checks Relay's
 * steps; this server checks the build names that account on chain 1337 with no Candle fee, then
 * relay-signs the Solana deposit, or each Hood leg in turn, and submits it to Candle.
 */
export async function executePerpsDeposit(
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  fetch: FetchLike,
): Promise<ToolText> {
  if (!cfg.apiKey) return fail("MCP_VALIDATION", "CANDLE_AGENT_API_KEY is required for this tool.")
  const asset = args.asset as DepositAsset
  const spec = DEPOSIT_ASSETS[asset]
  if (!spec) return fail("MCP_VALIDATION", "asset must be SOL, USDC, ETH or USDG.")
  const amountRaw = typeof args.amount === "string" ? rawUnits(args.amount, spec.decimals) : null
  if (!amountRaw)
    return fail("MCP_VALIDATION", `amount must be a positive ${asset} amount with at most ${spec.decimals} decimals.`)
  const hood = spec.chain === "evm"
  const clientDepositId =
    typeof args.clientDepositId === "string" ? args.clientDepositId : `deposit-${crypto.randomUUID()}`
  const willSubmit = args.submit !== false
  let signerPem: string | null = null
  if (willSubmit) {
    const pemFile = env.CANDLE_KEY_SIGNER_PEM_FILE?.trim()
    if (!pemFile)
      return fail(
        "SIGNER_UNAVAILABLE",
        "Set CANDLE_KEY_SIGNER_PEM_FILE to the key signer PEM (candle tee signer new --out <pem>) to sign a deposit.",
      )
    try {
      signerPem = await readFile(pemFile, "utf8")
      createPrivateKey(signerPem)
    } catch {
      return fail("SIGNER_UNAVAILABLE", "CANDLE_KEY_SIGNER_PEM_FILE does not hold a readable private key PEM.")
    }
  }
  try {
    const listed = await call(cfg, fetch, "GET", "/api/v1/agent/wallets/trading")
    if (!(Array.isArray(listed.scopes) && listed.scopes.includes("swap:write")))
      throw new Refusal(fail("SCOPE_MISSING", "A deposit needs swap:write on the key."))
    const rows = (Array.isArray(listed.page) ? listed.page : []) as WalletRow[]
    const appId = typeof listed.privyAppId === "string" ? listed.privyAppId : ""
    const name = typeof args.wallet === "string" ? args.wallet : undefined
    const source = pickWallet(rows, spec.chain, name, `${hood ? "Hood" : "Solana"} TEE wallet`)
    if (hood && args.perpsWallet !== undefined)
      return fail(
        "MCP_VALIDATION",
        "From a Hood TEE wallet the deposit lands on that wallet's own account; omit perpsWallet.",
      )
    const account = hood
      ? source
      : pickWallet(rows, "evm", typeof args.perpsWallet === "string" ? args.perpsWallet : undefined, "EVM TEE wallet")
    const build = await call(cfg, fetch, "POST", "/api/v1/agent/perps/deposit", {
      clientDepositId,
      walletId: source.id,
      asset,
      amountRaw,
      ...(typeof args.maxSlippageBps === "number" ? { maxSlippageBps: args.maxSlippageBps } : {}),
      ...(hood ? {} : { perpsWalletId: account.id }),
    })
    if (build.job !== undefined) return { text: JSON.stringify(build) }
    const problem = depositProblem(build, { walletId: source.id, asset, amountRaw, account: account.address, hood })
    if (problem) return fail("PERPS_BUILD_REFUSED", `Refused to sign this deposit: ${problem}. Nothing was signed.`)
    if (!willSubmit || signerPem === null)
      return { text: JSON.stringify({ ...build, signed: false, submitted: false }) }
    if (!appId || !source.privyWalletId)
      return fail("SIGNER_UNAVAILABLE", "The server did not return its relay identifiers.")
    const pem = signerPem
    const relaySign = async (body: Record<string, unknown>) => {
      const payload = hyperliquidCanonicalJson({
        body,
        headers: { "privy-app-id": appId },
        method: "POST",
        url: `https://api.privy.io/v1/wallets/${source.privyWalletId}/rpc`,
        version: 1,
      })
      const authorizationSignature = sign("sha256", Buffer.from(payload), pem).toString("base64")
      const relay = await call(cfg, fetch, "POST", `/api/v1/agent/wallets/${encodeURIComponent(source.id)}/sign`, {
        authorizationSignature,
        body,
      })
      if (typeof relay.signedTransaction !== "string")
        throw new Refusal(fail("INVALID_RESPONSE", "The relay did not return a signed transaction."))
      return relay.signedTransaction
    }
    const ids = { clientDepositId, depositId: build.depositId }
    const submitPath = "/api/v1/agent/perps/deposit/submit"

    if (!hood) {
      const transaction = (build.transactionsBase64 as string[])[0] as string
      const signed = await relaySign({ method: "signTransaction", params: { encoding: "base64", transaction } })
      return {
        text: JSON.stringify(
          await call(cfg, fetch, "POST", submitPath, { ...ids, signedTransactionsBase64: [signed] }),
        ),
      }
    }

    const allowed = asset === "USDG" ? ["approval", "bridgeDeposit"] : ["bridgeDeposit"]
    const planned = build.plannedLegCount
    const hex = (value: unknown) => `0x${BigInt(String(value)).toString(16)}`
    const signedKinds = new Set<string>()
    let body = build
    while (body.mode === "sequenced") {
      const leg = body.nextLeg as Record<string, unknown> | undefined
      const kind = String(body.legKind)
      if (
        !leg ||
        body.operationId !== build.operationId ||
        body.plannedLegCount !== planned ||
        typeof planned !== "number" ||
        planned > allowed.length ||
        !allowed.includes(kind) ||
        signedKinds.has(kind) ||
        leg.chainId !== 4663
      )
        return fail(
          "PERPS_BUILD_REFUSED",
          `Refused to sign deposit leg ${kind}: it is not the plan this deposit was built with.`,
          { clientDepositId, operationId: build.operationId },
        )
      signedKinds.add(kind)
      // Privy's eth_signTransaction wire, keys in RFC 8785 order.
      const signed = await relaySign({
        method: "eth_signTransaction",
        params: {
          transaction: {
            chain_id: leg.chainId,
            data: leg.data,
            from: source.address,
            gas_limit: hex(leg.gas),
            max_fee_per_gas: hex(leg.maxFeePerGas),
            max_priority_fee_per_gas: hex(leg.maxPriorityFeePerGas),
            nonce: leg.nonce,
            to: leg.to,
            type: 2,
            value: hex(leg.value),
          },
        },
      })
      body = await call(cfg, fetch, "POST", submitPath, {
        ...ids,
        operationId: build.operationId,
        signedTransaction: signed,
      })
    }
    return { text: JSON.stringify({ ...body, clientDepositId }) }
  } catch (error) {
    if (error instanceof Refusal) return error.tool
    return fail("MCP_TRANSPORT", error instanceof Error ? error.message : "The deposit call failed.")
  }
}
