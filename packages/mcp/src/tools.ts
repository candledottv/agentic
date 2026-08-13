/**
 * The agent-rail tools this MCP server exposes, and their mapping onto the Candle REST surface
 * (apps/api/src/routes/{launch-headless,markets,activity,users,trade}.ts).
 *
 * `buildRequest` is pure -- no fetch, no SDK types -- so the mapping from tool name + args to
 * (url, init) is fully unit-tested on its own (tools.test.ts) without spinning up a server or
 * mocking a transport. `registerTools` is the only function that touches the MCP SDK; it wires
 * each tool's zod input schema, calls `buildRequest`, fetches, and hands the response text back
 * verbatim -- this package never reinterprets an error body, it relays exactly what the endpoint
 * sent. That body is NOT one uniform shape across all five one-request tools:
 *   - `candle_launch_token`, `candle_get_market`, and `candle_get_feed` hit endpoints that use
 *     the structured `{ success: false, error: { code, message, ... } }` envelope
 *     (apps/api/src/lib/launch-errors.ts); agents branch on `error.code`.
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
 * five are. `candle_trade`'s relayed text wraps the trade endpoint's body verbatim under `api`,
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
import { executeLaunchAndSeed, executeTrade } from "./orchestrate"

export const TOOL_NAMES = [
  "candle_launch_token",
  "candle_get_market",
  "candle_get_feed",
  "candle_report_activity",
  "candle_get_agent_profile",
  "candle_trade",
  "candle_launch_and_seed",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * The tool names that map onto a single request via `buildRequest`. `candle_trade` and
 * `candle_launch_and_seed` are deliberately excluded: both are multi-call orchestrations (see
 * orchestrate.ts's `executeTrade` / `executeLaunchAndSeed`), never built as a single (url, init)
 * pair, so they're kept out of this type rather than added as dead switch cases.
 */
type RestToolName = Exclude<ToolName, "candle_trade" | "candle_launch_and_seed">

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
      return { url: `${base}/api/v1/markets/${chain}/${mint}`, init: { method: "GET", headers: jsonHeaders() } }
    }

    case "candle_get_feed": {
      const { bucket, chain } = args as { bucket: string; chain?: string }
      const query = new URLSearchParams({ bucket, ...(chain ? { chain } : {}) })
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
      return { url: `${base}/api/v1/users/${idOrWallet}/agent`, init: { method: "GET", headers: jsonHeaders() } }
    }
  }
}

/** Fetches the request and hands the raw response text back to the agent, error body included. */
async function callAndRelay(name: RestToolName, args: Record<string, unknown>, cfg: RequestConfig) {
  const { url, init } = buildRequest(name, args, cfg)
  const res = await fetch(url, init)
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
        "are rejected with IMAGE_WRONG_SHAPE",
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

const getFeedShape = {
  bucket: z.enum(["new", "graduated", "onfire", "bluechip"]),
  chain: z.string().optional().describe("Optional chain filter"),
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
    .describe("Sells only: sell this percent (integer 1-100) of the wallet's holding. Solana only."),
  quoteAsset: z
    .string()
    .optional()
    .describe(
      'Quote asset ("sol", "usdc", "cndl") for an arbitrary Solana mint Candle never launched ' +
        "(Pro/Max only); defaults to sol. Ignored for a Candle-launched token, whose quote comes " +
        "from the token itself, so it never changes how a buy amount is interpreted there.",
    ),
  maxSlippageBps: z.number().optional().describe("Max slippage in basis points; API default applies when omitted"),
  clientTradeId: z
    .string()
    .optional()
    .describe(
      "Idempotency key. Auto-generated when omitted and echoed in the result. Retrying with the " +
        "SAME id is safe (idempotent replay); a new id is a SECOND trade.",
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

/**
 * Wires all seven tools onto an McpServer instance. Kept out of index.ts so tests never import a
 * module that constructs a transport-connected server. Config is resolved from the environment
 * once, at registration time (`client.ts`'s `resolveConfig`).
 */
export function registerTools(server: McpServer): void {
  const cfg = resolveConfig()
  server.registerTool(
    "candle_launch_token",
    {
      title: "Launch a token on Candle",
      description:
        "Launch a new token via the Candle headless launch API. Set dryRun: true to validate without spending anything.",
      inputSchema: launchTokenShape,
    },
    async (args) => callAndRelay("candle_launch_token", args, cfg),
  )

  server.registerTool(
    "candle_get_market",
    {
      title: "Get market state",
      description: "Read the current market state for a token: lifecycle, pool address, whether buys are open.",
      inputSchema: getMarketShape,
    },
    async (args) => callAndRelay("candle_get_market", args, cfg),
  )

  server.registerTool(
    "candle_get_feed",
    {
      title: "Get a token feed",
      description: "Read one of the trade page's public feeds: new, graduated, onfire, or bluechip.",
      inputSchema: getFeedShape,
    },
    async (args) => callAndRelay("candle_get_feed", args, cfg),
  )

  server.registerTool(
    "candle_report_activity",
    {
      title: "Report on-chain activity",
      description: "Report a client-executed transaction (transfer, swap, stake) so Candle records and verifies it.",
      inputSchema: reportActivityShape,
    },
    async (args) => callAndRelay("candle_report_activity", args, cfg),
  )

  server.registerTool(
    "candle_get_agent_profile",
    {
      title: "Get an agent profile",
      description: "Read a Candle user's public agent profile: whether agent features are enabled and launch counts.",
      inputSchema: getAgentProfileShape,
    },
    async (args) => callAndRelay("candle_get_agent_profile", args, cfg),
  )

  server.registerTool(
    "candle_trade",
    {
      title: "Buy or sell a token",
      description:
        "Execute a buy or sell through the Candle trade rail. MOVES REAL FUNDS: the payer is the " +
        "account's embedded (main) wallet, executed server-side via delegation. Amounts are " +
        "decimal (never raw base units). Retry a timeout with the SAME clientTradeId from the " +
        "result; a new id is a second trade.",
      inputSchema: tradeShape,
    },
    async (args) => {
      const result = await executeTrade(args as never, cfg, fetch)
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  server.registerTool(
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
}
