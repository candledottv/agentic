/**
 * Hyperliquid perps B (BE-646, spec 2026-10-01-hyperliquid-perps-tee-design.md, HL-ED-2, HL-ED-5,
 * HL-ED-11): the seven `candle_perps_*` tools, the MCP mirror of `candle perps`.
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
 */
import { createPrivateKey, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { RequestConfig } from "./client"
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
} from "./hyperliquid"
import type { FetchLike, ToolText } from "./orchestrate"

export const PERPS_TOOL_NAMES = [
  "candle_perps_setup",
  "candle_perps_open",
  "candle_perps_close",
  "candle_perps_cancel",
  "candle_perps_orders",
  "candle_perps_positions",
  "candle_perps_leverage",
] as const
export type PerpsToolName = (typeof PERPS_TOOL_NAMES)[number]

const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, "a plain decimal string")
const wallet = z
  .string()
  .optional()
  .describe("The EVM TEE wallet by id, address or label. Omit when the key has exactly one.")
const submit = z.boolean().optional().describe("false: build and check only, sign and submit nothing. Default true.")

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
    wallet,
    submit,
  },
  candle_perps_close: {
    coin: z.string(),
    size: decimal.optional().describe("Part of the position to close; the whole position when omitted"),
    slippageBps: z.number().int().min(1).optional(),
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
  candle_perps_leverage: {
    coin: z.string(),
    leverage: z.number().int().min(1),
    mode: z.enum(["cross", "isolated"]).optional(),
    wallet,
    submit,
  },
} as const

const PATHS: Record<PerpsToolName, string> = {
  candle_perps_setup: "/api/v1/agent/perps/setup",
  candle_perps_open: "/api/v1/agent/perps/open",
  candle_perps_close: "/api/v1/agent/perps/close",
  candle_perps_cancel: "/api/v1/agent/perps/cancel",
  candle_perps_orders: "/api/v1/agent/perps/orders",
  candle_perps_positions: "/api/v1/agent/perps/positions",
  candle_perps_leverage: "/api/v1/agent/perps/leverage",
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolText {
  return { text: JSON.stringify({ success: false, error: { code, message }, ...extra }), isError: true }
}

interface WalletRow {
  id: string
  address: string
  label?: string
  chain: string
  privyWalletId?: string
}

class Refusal extends Error {
  constructor(readonly tool: ToolText) {
    super("refused")
  }
}

async function call(
  cfg: RequestConfig,
  fetch: FetchLike,
  method: "GET" | "POST",
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
    // The perps router answers a bare 404 while HYPERLIQUID_ENABLED is off.
    if (res.status === 404 && (typeof parsed !== "object" || parsed === null))
      throw new Refusal(fail("PERPS_NOT_ENABLED", "This Candle deployment does not serve perps routes."))
    throw new Refusal({ text: typeof parsed === "string" ? parsed : JSON.stringify(parsed), isError: true })
  }
  if (typeof parsed !== "object" || parsed === null) throw new Refusal(fail("INVALID_RESPONSE", "Not a JSON object"))
  return parsed as Record<string, unknown>
}

async function walletFor(
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
  const network: HyperliquidNetwork = env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet"
  const name = typeof args.wallet === "string" ? args.wallet : undefined
  try {
    if (tool === "candle_perps_orders" || tool === "candle_perps_positions") {
      const { row } = await walletFor(cfg, fetch, name)
      const query = new URLSearchParams({ walletId: row.id })
      if (typeof args.limit === "number") query.set("limit", String(args.limit))
      return { text: JSON.stringify(await call(cfg, fetch, "GET", `${PATHS[tool]}?${query}`)) }
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
    const { wallet: _w, submit: _s, ...fields } = args
    const build = await call(cfg, fetch, "POST", PATHS[tool], {
      walletId: row.id,
      ...fields,
      ...(tool === "candle_perps_open" ? { type: fields.price === undefined ? "market" : "limit" } : {}),
    })
    if (build.ready === true) return { text: JSON.stringify(build) }
    const method = PATHS[tool].split("/").at(-1) as "setup" | "open" | "close" | "cancel" | "leverage"
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
