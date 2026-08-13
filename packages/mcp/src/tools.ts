/**
 * The five agent-rail tools this MCP server exposes, and their mapping onto the Candle REST
 * surface (apps/api/src/routes/{launch-headless,markets,activity,users}.ts).
 *
 * `buildRequest` is pure -- no fetch, no SDK types -- so the mapping from tool name + args to
 * (url, init) is fully unit-tested on its own (tools.test.ts) without spinning up a server or
 * mocking a transport. `registerTools` is the only function that touches the MCP SDK; it wires
 * each tool's zod input schema, calls `buildRequest`, fetches, and hands the response text back
 * verbatim -- this package never reinterprets an error body, it relays exactly what the endpoint
 * sent. That body is NOT one uniform shape across all five tools:
 *   - `candle_launch_token`, `candle_get_market`, and `candle_get_feed` hit endpoints that use
 *     the structured `{ success: false, error: { code, message, ... } }` envelope
 *     (apps/api/src/lib/launch-errors.ts); agents branch on `error.code`.
 *   - `candle_report_activity` relays `activity.ts`'s own plain error shape verbatim:
 *     `{ error: true, payload: string }`.
 *   - `candle_get_agent_profile` relays `users.ts`'s own plain error shape verbatim:
 *     `{ error: string }`.
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

export const TOOL_NAMES = [
  "candle_launch_token",
  "candle_get_market",
  "candle_get_feed",
  "candle_report_activity",
  "candle_get_agent_profile",
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

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
export function buildRequest(name: ToolName, args: Record<string, unknown>, cfg: RequestConfig): BuiltRequest {
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
async function callAndRelay(name: ToolName, args: Record<string, unknown>, cfg: RequestConfig) {
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

/**
 * Wires all five tools onto an McpServer instance. Kept out of index.ts so tests never import a
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
}
