/**
 * The agent-rail tools this MCP server exposes, and their mapping onto the Candle REST surface
 * (apps/api/src/routes/{launch-headless,markets,activity,users,trade}.ts).
 *
 * `buildRequest` is pure -- no fetch, no SDK types -- so the mapping from tool name + args to
 * (url, init) is fully unit-tested on its own (tools.test.ts) without spinning up a server or
 * mocking a transport. `registerTools` is the only function that touches the MCP SDK; it wires
 * each tool's zod input schema, calls `buildRequest`, fetches, and hands the response text back
 * verbatim -- this package never reinterprets an error body, it relays exactly what the endpoint
 * sent. That body is NOT one uniform shape across all six one-request tools:
 *   - `candle_launch_token`, `candle_get_market`, `candle_get_feed`, and `candle_swap` hit
 *     endpoints that use the structured `{ success: false, error: { code, message, ... } }`
 *     envelope (apps/api/src/lib/launch-errors.ts); agents branch on `error.code`.
 *   - `candle_report_activity` relays `activity.ts`'s own plain error shape verbatim:
 *     `{ error: true, payload: string }`.
 *   - `candle_get_agent_profile` relays `users.ts`'s own plain error shape verbatim:
 *     `{ error: string }`.
 *
 * `candle_trade` and `candle_launch_and_seed` are not one-request mappings: `candle_trade` needs
 * pre-request reads (the market, for the token's own decimals on a sell and its QUOTE asset's
 * decimals on a buy, or wallet address + balance for a percent sell), and
 * `candle_launch_and_seed` needs a devBuy decimal-to-raw conversion plus a best-effort follow-up
 * market read after the launch. Both are built in orchestrate.ts (`executeTrade` /
 * `executeLaunchAndSeed`) behind an injectable fetch, and registered here the same way the other
 * six are. `candle_trade`'s relayed text wraps the trade endpoint's body verbatim under `api`,
 * alongside the echoed `clientTradeId` and the `resolved` conversion; `candle_launch_and_seed`'s
 * wraps the launch endpoint's body under `launch` (or `api` for dryRun/error), alongside the
 * echoed `clientLaunchId` and, on a real launch, the best-effort `market` read (see
 * orchestrate.ts's doc comment).
 *
 * No `candle_import_wallet` tool: MCP hosts commonly log stdio tool call arguments (for replay,
 * debugging, or transcripts), which is an unacceptable place for a plaintext private key to ever
 * transit even briefly, so wallet import ships only in packages/sdk (wallet-import.ts /
 * `CandleClient.importWallet`), never as an MCP tool.
 *
 * Input schemas are intentionally permissive: the REST API is the authoritative validator (see
 * apps/api/src/lib/headless-validation.ts), so duplicating its rules here would just be a second
 * place for them to go stale. Shapes and required-ness are enough to give an MCP client useful
 * autocomplete.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type RequestConfig, resolveConfig } from "./client"
import { decimalToRaw, QUOTE_DECIMALS } from "./convert"
import { executeLaunchAndSeed, executeSweep, executeTrade, executionStatus, resolveToken } from "./orchestrate"
import { executePerps, executePerpsDeposit, type PerpsToolName, perpsDepositShape, perpsShapes } from "./perps"
import { PLAN_CAPABILITY_NOTE, type PlanTable, planPromotionLine, planTableMarkdown } from "./plans"
import { noteVersionHeaders } from "./update-notice"

export const TOOL_NAMES = [
  "candle_launch_token",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_report_activity",
  "candle_get_agent_profile",
  // BE-723 (Plans v2 P6): the served plan table, keyless.
  "candle_get_plans",
  "candle_trade",
  "candle_launch_and_seed",
  "candle_swap",
  "candle_transfer",
  "candle_sweep",
  "candle_get_wallets",
  "candle_get_profile_wallets",
  "candle_set_profile_wallets",
  "candle_get_profile_pnl",
  "candle_get_profile_trades",
  "candle_get_portfolio",
  "candle_resolve_token",
  "candle_execution_status",
  "candle_get_operation",
  // Hyperliquid perps B (BE-646): the `candle perps` mirror (perps.ts).
  "candle_perps_setup",
  "candle_perps_open",
  "candle_perps_close",
  "candle_perps_cancel",
  "candle_perps_orders",
  "candle_perps_positions",
  "candle_perps_leverage",
  // Hyperliquid perps C (BE-647): the Relay deposit (perps.ts).
  "candle_perps_deposit",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Resolves the CANDLE_MCP_TOOLS allowlist (CLI P0 plan, Task 2): a comma-separated subset of
 * TOOL_NAMES, set by `candle mcp --tools`/`--read-only` (or by hand). Unset or blank means
 * every tool. An unknown name is a hard error, not a silent skip -- a server that quietly
 * dropped a typo'd allowlist entry would register everything the operator meant to exclude.
 * Pure and injected-env so tools.test.ts covers it without touching process.env.
 */
export function resolveToolAllowlist(env: Record<string, string | undefined>): Set<ToolName> {
  const raw = env.CANDLE_MCP_TOOLS?.trim()
  if (!raw) return new Set(TOOL_NAMES)
  const requested = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  const unknown = requested.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name))
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(
      `CANDLE_MCP_TOOLS contains unknown tool name(s): ${unknown.join(", ") || "(none given)"}. Valid names: ${TOOL_NAMES.join(", ")}`,
    )
  }
  return new Set(requested as ToolName[])
}

/**
 * The tool names that map onto a single request via `buildRequest`. `candle_trade` and
 * `candle_launch_and_seed` are deliberately excluded: both are multi-call orchestrations (see
 * orchestrate.ts's `executeTrade` / `executeLaunchAndSeed`), never built as a single (url, init)
 * pair, so they're kept out of this type rather than added as dead switch cases.
 */
type RestToolName = Exclude<
  ToolName,
  | "candle_trade"
  | "candle_launch_and_seed"
  | "candle_sweep"
  | "candle_resolve_token"
  | "candle_execution_status"
  | PerpsToolName
  | "candle_perps_deposit"
>

export interface BuiltRequest {
  url: string
  init: RequestInit
}

function requireApiKey(cfg: RequestConfig): string {
  if (!cfg.apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.")
  }
  return cfg.apiKey
}

function jsonHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["x-api-key"] = apiKey
  return headers
}

/**
 * Pure mapping from a tool call to a fetchable request. No I/O -- see the file doc comment.
 */
/**
 * candle_swap's body: exactly one of `amount` (decimal) or `amountRaw`, resolved to the
 * `amountRaw` the API takes.
 *
 * Both-or-neither is rejected rather than resolved by precedence. A caller that sends both has
 * two different numbers in mind and silently honouring one of them spends the wrong amount; the
 * error costs a round trip and says which field to drop.
 */
export function swapBody(args: Record<string, unknown>): Record<string, unknown> {
  const { amount, amountRaw, ...rest } = args as { amount?: string; amountRaw?: string }
  const hasAmount = typeof amount === "string" && amount.length > 0
  const hasRaw = typeof amountRaw === "string" && amountRaw.length > 0
  if (hasAmount && hasRaw) {
    throw new Error("Pass exactly one of amount or amountRaw, not both.")
  }
  if (!hasAmount && !hasRaw) {
    throw new Error('Pass an amount, e.g. amount: "0.5".')
  }
  if (hasRaw) return { ...rest, amountRaw }
  const from = String((rest as { from?: unknown }).from ?? "").toLowerCase()
  const decimals = QUOTE_DECIMALS[from]
  if (decimals === undefined) {
    throw new Error(`Unknown decimals for base asset "${from}". Pass amountRaw instead.`)
  }
  return { ...rest, amountRaw: decimalToRaw(amount as string, decimals) }
}

export function buildRequest(name: RestToolName, args: Record<string, unknown>, cfg: RequestConfig): BuiltRequest {
  const base = cfg.apiUrl.replace(/\/$/, "")

  switch (name) {
    case "candle_launch_token": {
      const apiKey = requireApiKey(cfg)
      const { dryRun, ...body } = args as { dryRun?: boolean }
      const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless"
      return {
        url: `${base}${path}`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) },
      }
    }

    case "candle_get_market": {
      const { chain, mint } = args as { chain: string; mint: string }
      return {
        url: `${base}/api/v1/markets/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}`,
        init: { method: "GET", headers: jsonHeaders() },
      }
    }

    case "candle_token_forensics": {
      const { chain, mint } = args as { chain: string; mint: string }
      return {
        url: `${base}/api/v1/markets/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}/forensics`,
        init: { method: "GET", headers: jsonHeaders() },
      }
    }

    case "candle_get_feed": {
      const { bucket, chain, where, sort, fields, limit } = args as {
        bucket: string
        chain?: string
        where?: string
        sort?: string
        fields?: string
        limit?: string
      }
      // Every optional knob is forwarded only when set. An empty string would reach the API as a
      // present-but-blank parameter, and a blank `where` treated as "no filter" would hand back
      // the whole feed to a caller who believed they had narrowed it.
      const query = new URLSearchParams({
        bucket,
        ...(chain ? { chain } : {}),
        ...(where ? { where } : {}),
        ...(sort ? { sort } : {}),
        ...(fields ? { fields } : {}),
        ...(limit ? { limit } : {}),
      })
      return {
        url: `${base}/api/v1/markets/feed?${query.toString()}`,
        init: { method: "GET", headers: jsonHeaders() },
      }
    }

    case "candle_report_activity": {
      const apiKey = requireApiKey(cfg)
      return {
        url: `${base}/api/v1/activity/report`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(args) },
      }
    }

    case "candle_get_agent_profile": {
      const { idOrWallet } = args as { idOrWallet: string }
      return {
        url: `${base}/api/v1/users/${encodeURIComponent(idOrWallet)}/agent`,
        init: { method: "GET", headers: jsonHeaders() },
      }
    }

    case "candle_get_plans": {
      // Public: no key is sent even when one is configured, since the table is about no account.
      return { url: `${base}/api/v1/agent/plans`, init: { method: "GET", headers: jsonHeaders() } }
    }

    case "candle_swap": {
      const apiKey = requireApiKey(cfg)
      // `amount` is decimal, `amountRaw` is what the API takes. Converting here is safe without a
      // network read because `from` is one of the five BASE assets, whose decimals are pinned in
      // QUOTE_DECIMALS; a token trade cannot do this, which is why candle_trade reads the market
      // first and this does not.
      //
      // This tool took raw units only until now, while candle_trade next to it took decimals. Two
      // sibling money-moving tools disagreeing about units is the kind of difference a model gets
      // wrong in one direction: 0.5 SOL sent as "0.5" raw is 5e-10 SOL and looks like a rounding
      // bug, while 0.5 sent as 500000000 to a decimal field would be half a billion SOL.
      return {
        url: `${base}/api/v1/agent/swap`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(swapBody(args)) },
      }
    }

    case "candle_get_operation": {
      const apiKey = requireApiKey(cfg)
      // Two rails, two ledgers, one tool. The path is chosen by `kind` rather than sniffed from
      // the id: clientTradeId and clientLaunchId are both caller-chosen strings, so there is
      // nothing in an id to dispatch on, and guessing wrong returns a 404 for the wrong rail.
      const { clientId, kind } = args as { clientId: string; kind: "trade" | "launch" }
      const path =
        kind === "launch"
          ? `/api/v1/launch/headless/jobs/${encodeURIComponent(clientId)}`
          : `/api/v1/trade/agent/jobs/${encodeURIComponent(clientId)}`
      return { url: `${base}${path}`, init: { method: "GET", headers: jsonHeaders(apiKey) } }
    }

    case "candle_get_wallets": {
      const apiKey = requireApiKey(cfg)
      return {
        url: `${base}/api/v1/agent/wallets/embedded`,
        init: { method: "GET", headers: jsonHeaders(apiKey) },
      }
    }

    case "candle_get_profile_wallets": {
      const apiKey = requireApiKey(cfg)
      const { keyPrefix } = args as { keyPrefix: string }
      return {
        url: `${base}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`,
        init: { method: "GET", headers: jsonHeaders(apiKey) },
      }
    }

    case "candle_set_profile_wallets": {
      const apiKey = requireApiKey(cfg)
      const { keyPrefix, walletIds } = args as { keyPrefix: string; walletIds: string[] }
      return {
        url: `${base}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`,
        init: { method: "PUT", headers: jsonHeaders(apiKey), body: JSON.stringify({ walletIds }) },
      }
    }

    case "candle_get_profile_pnl": {
      const apiKey = requireApiKey(cfg)
      const { keyPrefix } = args as { keyPrefix: string }
      return {
        url: `${base}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/pnl`,
        init: { method: "GET", headers: jsonHeaders(apiKey) },
      }
    }

    case "candle_get_portfolio": {
      const apiKey = requireApiKey(cfg)
      return {
        url: `${base}/api/v1/agent/portfolio`,
        init: { method: "GET", headers: jsonHeaders(apiKey) },
      }
    }

    case "candle_get_profile_trades": {
      const apiKey = requireApiKey(cfg)
      const { keyPrefix, limit } = args as { keyPrefix: string; limit?: number }
      const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`
      return {
        url: `${base}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/trades${query}`,
        init: { method: "GET", headers: jsonHeaders(apiKey) },
      }
    }

    case "candle_transfer": {
      const apiKey = requireApiKey(cfg)
      return {
        url: `${base}/api/v1/agent/transfer`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(args) },
      }
    }
  }
}

/** Fetches the request and hands the raw response text back to the agent, error body included. */
/** The served table as Markdown, with the promotion line. Falls back to nothing on a body it cannot read. */
export function plansMarkdown(body: string): string {
  try {
    const table = JSON.parse(body) as PlanTable
    if (!Array.isArray(table.plans)) return ""
    const promotion = planPromotionLine(table)
    const markdown = `${planTableMarkdown(table)}\n\n${PLAN_CAPABILITY_NOTE}`
    return promotion ? `${markdown}\n\n${promotion}` : markdown
  } catch {
    return ""
  }
}

async function callAndRelay(name: RestToolName, args: Record<string, unknown>, cfg: RequestConfig) {
  const { url, init } = buildRequest(name, args, cfg)
  const res = await fetch(url, init)
  noteVersionHeaders(res)
  const text = await res.text()
  return {
    content: [{ type: "text" as const, text }],
    ...(res.ok ? {} : { isError: true }),
  }
}

const launchTokenShape = {
  clientLaunchId: z.string().describe("Caller-chosen idempotency key, unique per account"),
  name: z.string().describe("Token name"),
  symbol: z.string().describe("Token symbol"),
  imageUrl: z
    .string()
    .describe(
      "https URL to the token image. Must be roughly SQUARE (aspect ratio at most 1.5:1): it " +
        "renders as a small circle/square avatar everywhere. Share cards, OG images and banners " +
        "are rejected with IMAGE_WRONG_SHAPE -- pass those as bannerUrl instead",
    ),
  bannerUrl: z
    .string()
    .optional()
    .describe(
      "Optional https URL to WIDE artwork for the token page's banner strip (wider than 1.5:1, " +
        "e.g. 1200x630). This is where a share card or OG image belongs. A square image here is " +
        "rejected with BANNER_WRONG_SHAPE. Omit it and the strip falls back to imageUrl",
    ),
  chain: z.string().optional().describe('"solana" or "hood"; defaults to solana'),
  quoteAsset: z.string().optional().describe("Quote asset symbol; defaults per chain"),
  mode: z
    .string()
    .optional()
    .describe(
      '"open" or "exclusive"; defaults to open. "test-open" / "test-exclusive" launch the ' +
        "low-threshold test curves (~1/80 economics) where the API has ENABLE_TEST_CURVES on",
    ),
  stakerAllocationBps: z.number().optional().describe("Staker allocation in basis points"),
  dexVersion: z.string().nullable().optional().describe('"v3" or "v4"; required for hood launches'),
  buyAmount: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Initial buy, in quote base units (string or number)"),
  description: z.string().optional(),
  socials: z.record(z.string()).optional().describe("Social links keyed by platform"),
  visibility: z.string().optional().describe('"production", "test", "local", or "hidden"'),
  dryRun: z.boolean().optional().describe("Validate without executing the launch"),
}

const getMarketShape = {
  chain: z.string().describe('"solana" or "hood"'),
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
}

const tokenForensicsShape = {
  chain: z.string().describe('"solana" or "hood"'),
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
}

const getFeedShape = {
  bucket: z.enum(["new", "graduated", "onfire", "bluechip"]),
  chain: z.string().optional().describe("Optional chain filter"),
  where: z
    .string()
    .optional()
    .describe(
      'JSON filter, e.g. {"marketCap":{"lt":150000},"liquidityUsd":{"gte":25000},"mintAuthorityDisabled":{"eq":true}}. ' +
        "Comparators: eq, ne, lt, lte, gt, gte, present. An ABSENT field satisfies none of them except " +
        "present:false, so a filter for mintAuthorityDisabled eq true returns only tokens that actually say " +
        "true, never ones where the flag is simply missing. Use present:false to find the tokens with no data.",
    ),
  sort: z.string().optional().describe('Sort as "field" or "field:asc" / "field:desc". A bare field means desc.'),
  fields: z
    .string()
    .optional()
    .describe(
      "Comma-separated fields to return, e.g. symbol,marketCap,liquidityUsd. chain, address and symbol always " +
        "ride along. Cuts a 135KB response to a couple of KB.",
    ),
  limit: z.string().optional().describe("Max rows to return, 1-200."),
}

// The activity report body is a passthrough: the API is the authoritative validator, and its
// shape already varies by chain (solana signature vs hood signature). See apps/api/src/routes/activity.ts.
const reportActivityShape = {
  chain: z.string().describe('"solana" or "hood"'),
  signature: z.string().describe("Transaction signature/hash to verify and record"),
}

const getAgentProfileShape = {
  idOrWallet: z.string().describe("Candle username or wallet address"),
}

const getOperationShape = {
  clientId: z
    .string()
    .describe("The clientTradeId or clientLaunchId the write used, or that the tool echoed back to you"),
  kind: z
    .enum(["trade", "launch"])
    .describe("Which rail the id belongs to. Required: ids are caller-chosen strings with no shape to dispatch on"),
}

const resolveTokenShape = {
  mint: z.string().describe("Token mint (Solana, base58) or contract address (Hood, 0x-prefixed)"),
}

const profileWalletsShape = {
  keyPrefix: z.string().describe("The profile's API key prefix, as listed by candle keys list or in the dashboard"),
}

const profilePnlShape = {
  keyPrefix: z.string().describe("The profile's API key prefix"),
}

const profileTradesShape = {
  keyPrefix: z.string().describe("The profile's API key prefix"),
  limit: z.number().optional().describe("How many of the most recent trades to return. Default 200, max 1000."),
}

const setProfileWalletsShape = {
  keyPrefix: z.string().describe("The profile's API key prefix"),
  walletIds: z
    .array(z.string())
    .describe(
      "The linked-wallet ids the profile may spend from -- ids, not addresses. This REPLACES the " +
        "whole set: any wallet omitted loses access. An empty array assigns none.",
    ),
}

const swapShape = {
  from: z.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to spend"),
  to: z.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to receive; must differ from `from`"),
  amount: z
    .string()
    .optional()
    .describe('Decimal amount of `from` to spend, e.g. "0.5". Preferred. Pass exactly one of amount or amountRaw.'),
  amountRaw: z
    .string()
    .optional()
    .describe(
      "Raw base units of `from`, as a positive integer string. Kept for callers that already " +
        "compute raw units; new callers should use `amount`.",
    ),
  maxSlippageBps: z.number().optional().describe("Slippage bound in bps, 0-10000. Server defaults to 100 (1%)"),
  clientSwapId: z
    .string()
    .optional()
    .describe(
      "Durable idempotency key. Same id + same from/to/amountRaw/effective slippage (omitted means " +
        "100 bps) replays the stored result, including an indeterminate SWAP_FAILED with the " +
        "signature in the message. A different body is rejected. Omit it and nothing is coalesced. " +
        "Pass one so a timeout retry returns that stored result.",
    ),
}

const tradeShape = {
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
  side: z.enum(["buy", "sell"]),
  amount: z
    .string()
    .optional()
    .describe(
      "Decimal amount. Buys: how much of THIS TOKEN'S OWN quote asset to spend (SOL for a " +
        'SOL-launched token, USDC for a USDC-quoted one, and so on: e.g. "0.5"). Sells: how many ' +
        "TOKENS to sell. Pass exactly one of amount or percent.",
    ),
  percent: z
    .number()
    .optional()
    .describe(
      "Sells only: sell this percent (integer 1-100) of the holding. Live trades size against the " +
        "embedded wallet. Paper trades (`paper: true`) size against this key's paper inventory -- " +
        "the position a previous paper buy credited -- because paper never moves the live wallet.",
    ),
  quoteAsset: z
    .string()
    .optional()
    .describe(
      'What the wallet spends on a buy or receives on a sell: "sol", "usdc" or "cndl" on Solana, ' +
        '"eth" or "usdg" on Hood. Echoing the `quoteAsset` a quote (POST /api/v1/trade/agent/quote) returned is safe. On Solana it applies only ' +
        "to an arbitrary mint Candle never launched (a buy needs Pro or Max; a sell works on any plan) and is ignored for a Candle token, " +
        "whose quote comes from the token itself. On Hood it is the settlement asset of a DEX " +
        "trade; a USDG buy adds an approval transaction an ETH buy does not. It is not the route: " +
        "the cheapest path to the asset is chosen separately. Defaults to sol / ETH settlement.",
    ),
  maxSlippageBps: z.number().optional().describe("Max slippage in basis points; API default applies when omitted"),
  clientTradeId: z
    .string()
    .optional()
    .describe(
      "Idempotency key. Auto-generated when omitted and echoed in the result. Retrying with the " +
        "SAME id is safe (idempotent replay); a new id is a SECOND trade.",
    ),
  paper: z.preprocess(
    (value) =>
      value === "true" || value === 1 || value === "1"
        ? true
        : value === "false" || value === 0 || value === "0"
          ? false
          : value,
    z
      .boolean()
      .optional()
      .describe(
        "Rehearse instead of trading. The request passes every admission rule a live trade passes " +
          "-- the same planner, spend gate, key cap and loss limits -- and records the quote, but " +
          "nothing is ever broadcast and no funds move. Use it to check that a strategy is admitted " +
          "before risking anything on it. A paper fill is optimistic by construction: it books the " +
          "quoted price, so the gap between a paper arm and a live one IS the execution cost. " +
          "A sell of a mint this key already paper-bought also closes that paper book when the " +
          "live wallet is empty, even if this flag is omitted.",
      ),
  ),
}

// `buyAmount` (raw base units) is destructured out rather than spread in: this tool's one seed
// input is `devBuy`, in decimal quote units, and advertising both would invite a caller to pass a
// raw amount the tool never converted. executeLaunchAndSeed strips it from the body as well.
const { buyAmount: _rawBuyAmount, ...seedableLaunchShape } = launchTokenShape

const launchAndSeedShape = {
  ...seedableLaunchShape,
  clientLaunchId: z
    .string()
    .optional()
    .describe("Idempotency key. Auto-generated when omitted and echoed in the result."),
  devBuy: z
    .string()
    .optional()
    .describe(
      'Seed buy in DECIMAL units of the quote asset this launch selects (e.g. "0.25" SOL, or ' +
        "ETH on hood), bundled into the launch transaction itself. Follows quoteAsset, which " +
        "defaults to sol on solana and eth on hood. Capped by the platform dev-buy ceiling; for " +
        "a larger seed, launch then follow with candle_trade.",
    ),
}

const transferShape = {
  chain: z.enum(["solana", "hood"]).describe("Which chain the transfer executes on"),
  asset: z
    .enum(["SOL", "USDC", "CNDL", "ETH", "USDG"])
    .optional()
    .describe("A base asset key. Pass exactly one of asset or mint."),
  mint: z
    .string()
    .optional()
    .describe(
      "An arbitrary token: SPL mint (Solana) or ERC-20 contract (Hood). Own-wallet destinations only; withdrawals to approved addresses are base-assets-only.",
    ),
  amountRaw: z
    .string()
    .describe(
      'RAW base units as a decimal string (lamports, wei, token raw units), or "max" to sweep the spendable balance. NOT a human decimal: 1 SOL is "1000000000".',
    ),
  to: z
    .string()
    .describe(
      "Destination address. Must be one of the account's own wallets, or an address the OWNER pre-approved as a withdrawal address in the Candle console -- anything else is refused before signing.",
    ),
  clientTransferId: z.string().optional().describe("Caller-chosen idempotency key for safe retries"),
}

const sweepShape = {
  chain: z.enum(["solana", "hood"]).describe("Which chain to sweep"),
  to: z.string().describe("Destination address, same rules as candle_transfer's `to`"),
  mints: z
    .array(z.string())
    .optional()
    .describe("Extra token mints/contracts to sweep besides the chain's base assets (own-wallet destinations only)."),
}

/**
 * Wires the tools onto an McpServer instance. Kept out of index.ts so tests never import a
 * module that constructs a transport-connected server. Config is resolved from the environment
 * once, at registration time (`client.ts`'s `resolveConfig`).
 */
export function registerTools(server: McpServer, env: Record<string, string | undefined> = process.env): void {
  // `env`, not the ambient environment: an in-process host (`candle mcp`) passes a deliberately
  // reduced environment, and reading process.env here would restore what that strip removed.
  const cfg = resolveConfig(env)
  // Fail-fast at startup on a bad allowlist: the process exits before the transport connects,
  // and the operator sees the valid names instead of a server that silently has the wrong tools.
  const allowed = resolveToolAllowlist(env)
  // One local guard for all eight registrations rather than eight if-wrappers: every call site
  // below goes through `register`, so the filter cannot drift out of one of them.
  const register: McpServer["registerTool"] = (name, ...rest) => {
    if (!allowed.has(name as ToolName)) return undefined as never
    return (server.registerTool as (...a: unknown[]) => never)(name, ...rest)
  }
  register(
    "candle_launch_token",
    {
      title: "Launch a token on Candle",
      description:
        "Launch a new token via the Candle headless launch API. Set dryRun: true to validate without spending anything.",
      inputSchema: launchTokenShape,
    },
    async (args) => callAndRelay("candle_launch_token", args, cfg),
  )

  register(
    "candle_get_market",
    {
      title: "Get market state",
      description:
        "Read Candle and indexed external markets, including indexed-but-not-routable tokens. No key needed. " +
        "Read candleLaunched, launchpad, venue and trade.routable; jupiterOk and discovery flags are distinct. " +
        "Routability is stored eligibility, not a quote or permission. General quotes use POST /api/v1/trade/agent/quote. " +
        "Curve quotes and lifecycle describe Candle launches. MARKET_NOT_FOUND is a legacy code: read " +
        "error.routing.reason, error.discovery and sibling error.retryable. A curve-only 404 does not mean untradeable.",
      inputSchema: getMarketShape,
    },
    async (args) => callAndRelay("candle_get_market", args, cfg),
  )

  register(
    "candle_token_forensics",
    {
      title: "Token forensics",
      description:
        "Gate a buy before making it: who launched it (resolved on-chain; pump.fun's shared updateAuthority is never the developer; when no developer is on chain, deployer.attribution names the launchpad or issuer instead, e.g. launched via stonk.fun or issued by xStocks), their went-to-zero rate and last coins, who bought in the deploy window (the creator's own wallets are marked disclosed; strangers in the same slot are the bundle signal), same-funder insider share, same-funder deployer cluster, and safety.summary with six sourced flags (mintAuthority, freezeAuthority, tokenExtensions, lpLock, sellability, liquidityDrain). Refuse an unprompted buy when flagged; incomplete or unknown is not clearance. launch.deployerLaunches is an inclusive informational count, never a warning. Every measurement carries a coverage note -- 'unavailable' is not 'clean'. No key needed.\n\nMARKET_NOT_FOUND means Candle has no market for that token and this could not run. That is also not 'clean': report that you could not check it, rather than reporting the token as safe. That refusal now carries error.coverage -- covered:false, a reason ('external_launchpad' when the token launched somewhere else, 'unknown_mint' when nobody has indexed it), the launchpad when known, and every check that consequently did not run. Read it instead of guessing. Most of the feed, and any Solana mint Jupiter's index knows, now answers with a partial report instead. On Hood, a token Candle did not launch names its launch account (deployer.method cvc_launch_account) for pons.family and pools.trade launches, with no record of earlier coins; other Hood launchpads return no developer.",
      inputSchema: tokenForensicsShape,
    },
    async (args) => callAndRelay("candle_token_forensics", args, cfg),
  )

  register(
    "candle_get_feed",
    {
      title: "Get a token feed",
      description:
        "Read one of the trade page's public feeds: new, graduated, onfire, or bluechip. Reads " +
        "only; moves nothing. No key needed. Start here when nobody has named a token.\n\n" +
        "This indexes the WIDER market, not just Candle's own launches. Rows carry launchpad and " +
        "discovery flags (jupiterOk, externalTradeable, paperDiscoveryOk, organic0LiveOk). " +
        "candle_get_market resolves Jupiter-indexed rows; do not hard-skip organicScore=0 on live " +
        "when organic0LiveOk is true. liquidityDrawdownBps is a signal only — nothing here blocks " +
        "resolve or trade on drain; filter with where if you want to avoid draining pools.\n\n" +
        "Filter, sort and pick fields SERVER-SIDE rather than reading the whole feed: an " +
        "unfiltered response is around 135KB and will not fit in a tool result. See `where`, " +
        "`sort` and `fields`.\n\n" +
        "One rule to know before screening on safety: a missing field is NOT a false one. " +
        "mintAuthorityDisabled and freezeAuthorityDisabled are absent on a real share of rows, " +
        "and absent means nobody checked, not that the authority is disabled. `where` never lets " +
        'an absent field satisfy a comparison, so {"mintAuthorityDisabled":{"eq":true}} returns ' +
        "only tokens that actually say so.",
      inputSchema: getFeedShape,
    },
    async (args) => callAndRelay("candle_get_feed", args, cfg),
  )

  register(
    "candle_report_activity",
    {
      title: "Report on-chain activity",
      description: "Report a client-executed transaction (transfer, swap, stake) so Candle records and verifies it.",
      inputSchema: reportActivityShape,
    },
    async (args) => callAndRelay("candle_report_activity", args, cfg),
  )

  register(
    "candle_get_agent_profile",
    {
      title: "Get an agent profile",
      description: "Read a Candle user's public agent profile: whether agent features are enabled and launch counts.",
      inputSchema: getAgentProfileShape,
    },
    async (args) => callAndRelay("candle_get_agent_profile", args, cfg),
  )

  register(
    "candle_get_plans",
    {
      title: "Plans: prices, fees, limits and what each can do",
      description:
        "The plan table this Candle deployment serves (GET /api/v1/agent/plans). No key needed. Reads only. For " +
        "each plan: price (null when not sold), feeBps (the agent fee charged on top of every trade or dev buy the " +
        "API builds), perpFeeBps (the Hyperliquid builder fee), limits for a new key (requests per minute, launches " +
        "per day, uploads per minute, linked wallets) and capabilities: buyExternalTokens, sellExternalTokens, " +
        "tradeBaseAssets, tradeCandleTokens, selfLaunch, atomicLaunch, createLinkedWallets, importLinkedWallets, " +
        "hyperliquidPerps, limitOrders, quant, freeBaseTransfers. promoMaxDays is the days of Max a first Pro " +
        "purchase includes (0: no promotion). Quote prices and fees from here, never from memory: they differ by " +
        "deployment and change at the three-plan launch (Free, Pro, Max). The account's own plan and fee are in " +
        "candle_execution_status's tier. A TIER_REQUIRED refusal names a capability this table shows the account's " +
        "plan lacks. A capability true here is plan eligibility, not deployment availability: perps and own-wallet bridges " +
        "are each behind a deployment switch and need their wallet, scopes and setup. Returns the server's JSON, then the same table as Markdown.",
      inputSchema: {},
    },
    async () => {
      const { url, init } = buildRequest("candle_get_plans", {}, cfg)
      const res = await fetch(url, init)
      noteVersionHeaders(res)
      const text = await res.text()
      if (!res.ok) return { content: [{ type: "text" as const, text }], isError: true }
      return {
        content: [
          { type: "text" as const, text },
          { type: "text" as const, text: plansMarkdown(text) },
        ],
      }
    },
  )

  register(
    "candle_get_operation",
    {
      title: "What happened to a write",
      description:
        "Look up a trade or launch by the id its write used, and find out whether it landed. " +
        "Reads only; moves nothing.\n\n" +
        "Call this after a timeout, after a restart, or any time you hold an id and do not know " +
        "the outcome. Do NOT re-send the write to find out.\n\n" +
        "Four answers, four different next moves:\n" +
        "- `confirmed`/`failed`: it is over. `signature` proves the first, `errorCode` explains " +
        "the second.\n" +
        "- `built`/`submitted`: still in flight. Wait and ask again.\n" +
        "- 404 (`JOB_NOT_FOUND`): Candle never saw this id, so the write never reached the rail " +
        "and nothing moved. The original request is safe to send again exactly as it was. This " +
        "is a definite answer, not a failure to retry.\n\n" +
        "Amounts come back RAW, deliberately: the answer you need after a timeout is the outcome, " +
        "and you already know what you asked for.",
      inputSchema: getOperationShape,
    },
    async (args) => callAndRelay("candle_get_operation", args, cfg),
  )

  register(
    "candle_get_wallets",
    {
      title: "List the wallets Candle executes with",
      description:
        "The account's EMBEDDED wallets, one per chain, with their delegation state. These are " +
        "the wallets candle_trade, candle_swap and candle_transfer spend from, so this is how an " +
        "agent finds its own funding addresses. Reads only; moves nothing. Not the same as the " +
        "account's LINKED wallets, which are the owner's own wallets and are not spent from here. " +
        "Balances are not included: read a specific one with the market and balance endpoints.",
      inputSchema: {},
    },
    async () => callAndRelay("candle_get_wallets", {}, cfg),
  )

  register(
    "candle_get_profile_wallets",
    {
      title: "Read which wallets an agent profile can spend from",
      description:
        "An agent profile (API key) either spends from EVERY wallet on its account or only from " +
        "the ones assigned to it. Read walletScope before drawing any conclusion from the list: " +
        "an empty list means 'every wallet' under scope 'all' and 'none at all' under 'selected'. " +
        "Reads only; moves nothing.",
      inputSchema: profileWalletsShape,
    },
    async (args) => callAndRelay("candle_get_profile_wallets", args, cfg),
  )

  register(
    "candle_set_profile_wallets",
    {
      title: "Set which wallets an agent profile can spend from",
      description:
        "REPLACES the profile's whole wallet set with the ids given, so a wallet left out of the " +
        "list loses access; pass an empty list to leave the profile with no wallets. NARROWING " +
        "ONLY: an API key can remove wallets from its OWN profile, but naming one it does not " +
        "already hold is a grant and needs a human in the dashboard, as does editing any other " +
        "profile. Takes effect only while the profile's scope is 'selected'. Wallet ids are the " +
        "linked-wallet ids, not addresses.",
      inputSchema: setProfileWalletsShape,
    },
    async (args) => callAndRelay("candle_set_profile_wallets", args, cfg),
  )

  register(
    "candle_get_profile_pnl",
    {
      title: "Read an agent profile's P&L",
      description:
        "This profile's share of the account's P&L: realized profit on the sales it made, the Candle fees " +
        "charged against it, and the positions that belong to it (the wallet's bound key, else the key " +
        "whose buy opened them) with their cost basis, each MARKED at Candle's current price where one " +
        "exists: `markPriceUsd`, `marketValueUsd` and `unrealizedUsd` per position, and `unrealizedUsd` " +
        "overall. A position with no price is counted in `unmarkedPositions` and left out of unrealized, " +
        "never valued at zero; `oldestMarkAt` says how old the marks are. Deposits and withdrawals are " +
        "excluded: funding a wallet is not profit. Check `unvalued` and `truncated` before quoting the " +
        "number; they mean the total is partial. The figures come from the account's one P&L read, the " +
        "same as the console's, to the cent: `pnl.totalUsd` (realized net plus unrealized) is the " +
        "console's P&L. Positions live in wallets: each wallet is its own average-cost pool, the total " +
        "is the sum of `pnl.byWallet` (one row per wallet, main or linked, with the linked wallet's " +
        "label; `unknown:solana` or `unknown:hood` is the row for fills no record places in a wallet), " +
        "and one token held in two wallets is two positions, each with its `wallet`. A recorded move " +
        "between the account's wallets carries its cost and realizes nothing. Each position carries " +
        "`agent` (the key it belongs to) and `dust` when it is worth under one cent; dust stays listed " +
        "and counted, and `openPositionsExDust` leaves it out. `closed` gives the closed positions as " +
        "`madeUsd` + `lostUsd` + `partialSellsUsd` = `realizedNetUsd`, with `wins` and `losses`. " +
        "`lookback` and `truncated` are the account's activity bound, and `tradesConsidered` counts this " +
        "key's ledger fills. Since 2026-10-02 the total is the sum of wallets rather than one pool across " +
        "them, so realized figures can differ from earlier reads; a server that predates it omits " +
        "`totalUsd`, `closed`, `openPositionsExDust`, `wallet`, `agent` and `dust`. " +
        "Every open position and every `byWallet` row (and its positions) carries `chain` ('solana' or " +
        "'hood'), and `pnl.byChain` has the total's figures over each chain's fills alone, both chains " +
        "always present, with `openPositions` there a count (the positions are in `pnl.openPositions`, by " +
        "`chain`). The two chains sum to the total. A " +
        "server that predates per-chain P&L omits `chain` and `byChain`. While Hyperliquid is enabled, " +
        "`hyperliquid` separately reports main-perp realized gross, signed funding, fees (inclusive of builder fees), " +
        "and net = gross + funding - fees, for currently bound EVM TEE wallets since the current TEE binding. " +
        "Check `read` and `truncated`; historical bindings and unrealized perps are excluded. Reads only.",
      inputSchema: profilePnlShape,
    },
    async (args) => callAndRelay("candle_get_profile_pnl", args, cfg),
  )

  register(
    "candle_get_profile_trades",
    {
      title: "Read an agent profile's trade history",
      description:
        "Orders, actual fills, fees, timestamps and transaction hashes for this profile. Includes FAILED " +
        "trades, with an errorCode saying why each did not go through, so this answers 'what happened to " +
        "my order' as well as 'what did I trade'. Reads only; moves nothing.",
      inputSchema: profileTradesShape,
    },
    async (args) => callAndRelay("candle_get_profile_trades", args, cfg),
  )

  register(
    "candle_get_portfolio",
    {
      title: "Read what the account holds, on Solana and Hood",
      description:
        "Balances and prices for the wallets Candle already knows on this account, on both chains: the " +
        "embedded wallet and every TEE wallet. Solana wallets are in `embedded` and `tee` (SOL as raw " +
        "`lamports`, tokens as raw `amountRaw` with `decimals`). Hood wallets are in `hood.embedded` and " +
        "`hood.tee` (ETH as raw `wei`, ERC-20s including USDG), never in the top-level arrays. Every " +
        "wallet and holding carries `chain`. Prices are in `prices`: a Solana mint under its own " +
        "address, Hood ETH under `hood:native`, and a Hood token under `hood:<contract lowercased>`, so " +
        "lowercase the address before looking it up. An unpriced entry is `priceUsd: null`, never zero; " +
        "a Hood one says why in `unpricedReason` (no-market-row, unusable-price, stale-mark, " +
        "source-unavailable), and `hood.unpriced` / `hood.unpricedByReason` count them. A Hood token " +
        "mark older than six hours is not used, so many Hood tokens read unpriced. A wallet whose read " +
        "failed has null balances, never zero, and is listed in `unavailable` (Solana) or " +
        "`hood.unavailable`; check `complete` before quoting a total. Vault and external wallets are " +
        "not included: Candle does not know their addresses (the Candle CLI's `candle portfolio` reads " +
        "them over your own RPC). Needs a key with the account:read scope; without it the answer is " +
        "SCOPE_MISSING. A server that predates Hood in the portfolio omits `hood` and `chain`. Reads " +
        "only; moves nothing.",
      inputSchema: {},
    },
    async () => callAndRelay("candle_get_portfolio", {}, cfg),
  )

  register(
    "candle_resolve_token",
    {
      title: "Resolve a contract address to a token",
      description:
        "Turn a bare contract address or mint into Candle's market for it: chain, symbol, " +
        "decimals, quote asset, and whether Candle can trade it. Start here when a human gives " +
        "you an address and nothing else. The chain is read off the address's own shape and is " +
        "not guessed, so it does not need to be supplied. Reads only; moves nothing. A 404 means " +
        "Candle has no market for that address, which is an answer, not a failure to retry.",
      inputSchema: resolveTokenShape,
    },
    async (args) => {
      const result = await resolveToken(args as never, cfg, fetch)
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  register(
    "candle_execution_status",
    {
      title: "Can this key execute right now",
      description:
        "One call before trading: the embedded wallets to spend from, the tier that decides what " +
        "may be traded, and this key's own spend limits. Reads only; moves nothing. Call it when " +
        "a run starts, or after an authorization error, rather than inferring readiness from a " +
        "failed trade. If a read could not be completed the tool says which one and does NOT " +
        "claim the account is unready: an unreachable endpoint and a missing tier are different " +
        "problems with different fixes.",
      inputSchema: {},
    },
    async () => {
      const result = await executionStatus(cfg, fetch)
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  register(
    "candle_swap",
    {
      title: "Convert between base assets",
      description:
        "Convert one base asset into another through the account's own embedded wallets. MOVES " +
        "REAL FUNDS.\n\n" +
        "SOL, USDC and CNDL are on Solana. ETH and USDG are on Hood. A pair drawn from ONE of " +
        "those groups settles on that chain in a single transaction. A pair spanning both is a " +
        "BRIDGE, and this is how a Hood wallet gets funded before launching or trading there.\n\n" +
        "A bridge behaves differently and the difference matters:\n" +
        "- It is several transactions, not one, and it takes time rather than settling on the call.\n" +
        "- A confirmed source transaction is NOT proof the destination was credited. Read the " +
        "returned status before treating the funds as arrived; the response carries the venue's " +
        "own status URLs for the cross-chain fill.\n" +
        "- A timeout is unknown, not failed. Pass a `clientSwapId` and retry the SAME request, " +
        "including the same slippage. The replay returns the stored result: the original success, " +
        "or a stored error. An indeterminate first leg comes back as SWAP_FAILED, retryable false, " +
        "with the signature in the message -- verify that on-chain before a new id. A swap that is " +
        "still running, with no stored outcome, is a retryable conflict. A different body under the " +
        "same id is rejected. A confirmed first leg is replayed with its hash, retryable false, and " +
        "is not run again. retryable true on the first LEG2_FAILED means send leg 2 as a new request. " +
        "Omitting the id never coalesces -- do not retry a timed-out call that had no id.\n" +
        "- If a bridge times out, check the returned status URLs rather than treating the funds " +
        "as arrived or lost.\n\n" +
        'Amounts are decimal (`amount`, e.g. "0.5"); `amountRaw` still accepts raw base units for ' +
        "callers that already compute them. Test-environment keys are refused: every leg settles " +
        "on a live venue.\n\n" +
        "This tool spends the embedded wallets. A TEE wallet also bridges, from SOL or USDC to ETH " +
        "or USDG or back, but only into the same key's TEE wallet on the other chain, with no Candle " +
        "fee: that runs through `candle swap` with the wallet's bound key, not this tool.",
      inputSchema: swapShape,
    },
    async (args) => callAndRelay("candle_swap", args, cfg),
  )

  register(
    "candle_transfer",
    {
      title: "Transfer an asset",
      description:
        "Move an asset from the account's embedded wallet to one of the account's own wallets, or to an owner-approved withdrawal address. amountRaw 'max' sweeps the spendable balance of that asset.",
      inputSchema: transferShape,
    },
    async (args) => callAndRelay("candle_transfer", args, cfg),
  )

  register(
    "candle_sweep",
    {
      title: "Sweep a wallet",
      description:
        "Sweep the embedded wallet on one chain to a destination: every base asset (plus any explicitly named mints), one transfer per asset with amountRaw 'max'. Assets with nothing spendable are reported as empty, not errors.",
      inputSchema: sweepShape,
    },
    async (args) => {
      const result = await executeSweep(args as never, cfg, fetch)
      return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  register(
    "candle_trade",
    {
      title: "Buy or sell a token",
      description:
        "Buy or sell a token. MOVES REAL FUNDS: the payer is the account's embedded (main) " +
        "wallet, executed server-side via delegation.\n\n" +
        "Before the first trade of a run, once:\n" +
        "1. candle_execution_status  -- confirms the wallets, the tier and this key's spend " +
        "limits. Call it at the start, or after an auth error; do not infer readiness from a " +
        "failed trade.\n" +
        "2. candle_resolve_token  -- if a human handed you a bare address. It returns the chain, " +
        "so you never have to guess it.\n" +
        "3. candle_token_forensics  -- before you quote or buy anything. It returns safety.summary and sourced flags " +
        "with timestamps and details. Unknown is not clean. MARKET_NOT_FOUND there means Candle has no market for the " +
        "token, NOT that the token is clean.\n\n" +
        "Arguments: `mint` and `side` are required. Amounts are DECIMAL, never raw base units " +
        '(amount: "0.5", not lamports). Omitting the amount on a sell sells the whole ' +
        "position.\n\n" +
        "Plans: every plan can buy and sell Candle-launched tokens and base assets, and SELL a token it holds that " +
        "Candle did not launch. BUYING such a token needs Pro or Max (TIER_REQUIRED otherwise). Each trade pays the " +
        "plan's agent fee on top (feeBps in candle_get_plans).\n\n" +
        "Pass `paper: true` to rehearse: every admission rule runs and the quote is recorded, but " +
        "nothing broadcasts and no funds move. A paper buy credits this key's paper inventory, " +
        "including for external Solana mints routed through Jupiter. A later sell by amount or " +
        "percent closes that book without reading the live wallet and without MARKET_NOT_FOUND " +
        "-- including when `paper` is omitted on the exit, as long as the paper position exists. " +
        "Do this before the first live trade of a new strategy, and whenever you are unsure a " +
        "trade would be admitted at all.\n\n" +
        "After the call:\n" +
        "- A timeout is not a failure. Retry with the SAME clientTradeId from the result -- it " +
        "coalesces the duplicate. A NEW id is a SECOND trade, and that is how you double-spend.\n" +
        "- If you no longer hold the result, do not re-send to find out what happened. Ask " +
        "candle_get_operation with the clientTradeId; a 404 there means the trade never reached " +
        "the rail and nothing moved.",
      inputSchema: tradeShape,
    },
    async (args) => {
      const result = await executeTrade(args as never, cfg, fetch)
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  register(
    "candle_launch_and_seed",
    {
      title: "Launch a token and seed it",
      description:
        "Launch a new token with an optional dev-buy seed bundled into the launch itself, then " +
        "return the fresh market state and token links in one result. MOVES REAL FUNDS unless " +
        "dryRun. Seeds above the platform dev-buy ceiling are rejected (DEV_BUY_TOO_HIGH); " +
        "launch, then top up with candle_trade.",
      inputSchema: launchAndSeedShape,
    },
    async (args) => {
      const result = await executeLaunchAndSeed(args as never, cfg, fetch)
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  // Hyperliquid perps B (BE-646): perpetuals from the key's EVM TEE wallet. Every write is built by
  // Candle, checked here before signing (hash, action type, builder), relay-signed, and submitted
  // to Hyperliquid by this server. Writes need CANDLE_KEY_SIGNER_PEM_FILE.
  const perpsTool = (tool: PerpsToolName) => async (args: Record<string, unknown>) => {
    const result = await executePerps(tool, args, cfg, env, fetch)
    return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
  }
  const perpsWrite =
    " MOVES REAL FUNDS on Hyperliquid unless submit is false. Candle builds the action within this key's limits " +
    "(USD window, maximum leverage, maximum position, slippage and price bands, main-exchange markets only); this " +
    "server recomputes its hash and checks the action type and Candle's builder before signing, then submits it to " +
    "Hyperliquid itself. Needs perps:write on the key and CANDLE_KEY_SIGNER_PEM_FILE. A refusal names the limit " +
    "that refused it (error.limit)."

  register(
    "candle_perps_setup",
    {
      title: "Set up Hyperliquid perps",
      description:
        "Approve Candle's Hyperliquid builder fee (0.1%) once for the key's EVM TEE wallet, and report the " +
        "account's mode and balance. Idempotent: nothing is signed when the approval is already on Hyperliquid." +
        perpsWrite,
      inputSchema: perpsShapes.candle_perps_setup,
    },
    perpsTool("candle_perps_setup"),
  )

  register(
    "candle_perps_open",
    {
      title: "Open a perps position",
      description:
        "Open or add to a perpetual position on Hyperliquid's main perp exchange: a market order (IOC within " +
        "slippageBps of the mid) without `price`, a limit order with it, and optional reduce-only takeProfit and " +
        "stopLoss triggers. Every plan except Max pays Candle a builder fee on each order (0.1% today; perpFeeBps in " +
        "candle_get_plans); Max pays none." +
        perpsWrite,
      inputSchema: perpsShapes.candle_perps_open,
    },
    perpsTool("candle_perps_open"),
  )

  register(
    "candle_perps_close",
    {
      title: "Close a perps position",
      description:
        "Close all or part of a position with a reduce-only IOC order. It reserves nothing, so a key at its USD " +
        "cap can still close." +
        perpsWrite,
      inputSchema: perpsShapes.candle_perps_close,
    },
    perpsTool("candle_perps_close"),
  )

  register(
    "candle_perps_cancel",
    {
      title: "Cancel a perps order",
      description:
        "Cancel an order Candle built, by its cloid (from candle_perps_open or candle_perps_orders)." + perpsWrite,
      inputSchema: perpsShapes.candle_perps_cancel,
    },
    perpsTool("candle_perps_cancel"),
  )

  register(
    "candle_perps_orders",
    {
      title: "Perps orders",
      description:
        "Open orders on Hyperliquid for the key's EVM TEE wallet, and every action Candle built for it with what " +
        "the venue shows. Reads only; moves nothing.",
      inputSchema: perpsShapes.candle_perps_orders,
    },
    perpsTool("candle_perps_orders"),
  )

  register(
    "candle_perps_positions",
    {
      title: "Perps positions",
      description:
        "Positions, account value and withdrawable balance on Hyperliquid for the key's EVM TEE wallet, read " +
        "live by its address. Reads only; moves nothing.",
      inputSchema: perpsShapes.candle_perps_positions,
    },
    perpsTool("candle_perps_positions"),
  )

  register(
    "candle_perps_leverage",
    {
      title: "Set perps leverage",
      description:
        "Set a market's leverage and margin mode (cross or isolated) on the account, within the key's maximum leverage." +
        perpsWrite,
      inputSchema: perpsShapes.candle_perps_leverage,
    },
    perpsTool("candle_perps_leverage"),
  )

  register(
    "candle_perps_deposit",
    {
      title: "Deposit to Hyperliquid",
      description:
        "MOVES REAL FUNDS unless submit is false. Deposit onto the key's Hyperliquid account through Relay: SOL or " +
        "USDC from its Solana TEE wallet, or ETH or USDG from its Hood TEE wallet, credited as Hyperliquid perps " +
        "USDC at the key's EVM TEE wallet's own address (Candle resolves it; no recipient is taken). Refused below a " +
        "floor that covers Hyperliquid's 1 USDC first-deposit charge. No Candle fee. Needs swap:write and a raw cap " +
        "on the asset, and CANDLE_KEY_SIGNER_PEM_FILE to sign. There is no withdrawal from Hyperliquid yet.",
      inputSchema: perpsDepositShape,
    },
    async (args) => {
      const result = await executePerpsDeposit(args as Record<string, unknown>, cfg, env, fetch)
      return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )
}
