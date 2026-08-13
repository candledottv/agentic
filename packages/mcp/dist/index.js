#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools.ts
import { z } from "zod";

// src/client.ts
var DEFAULT_API_URL = "https://api.candle.tv";
function resolveConfig() {
  const apiUrl = process.env.CANDLE_API_URL?.trim() || DEFAULT_API_URL;
  const apiKey = process.env.CANDLE_AGENT_API_KEY?.trim();
  return apiKey ? { apiUrl, apiKey } : { apiUrl };
}

// src/tools.ts
function requireApiKey(cfg) {
  if (!cfg.apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.");
  }
  return cfg.apiKey;
}
function jsonHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey)
    headers["x-api-key"] = apiKey;
  return headers;
}
function buildRequest(name, args, cfg) {
  const base = cfg.apiUrl.replace(/\/$/, "");
  switch (name) {
    case "candle_launch_token": {
      const apiKey = requireApiKey(cfg);
      const { dryRun, ...body } = args;
      const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless";
      return {
        url: `${base}${path}`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) }
      };
    }
    case "candle_get_market": {
      const { chain, mint } = args;
      return { url: `${base}/api/v1/markets/${chain}/${mint}`, init: { method: "GET", headers: jsonHeaders() } };
    }
    case "candle_get_feed": {
      const { bucket, chain } = args;
      const query = new URLSearchParams({ bucket, ...chain ? { chain } : {} });
      return {
        url: `${base}/api/v1/markets/feed?${query.toString()}`,
        init: { method: "GET", headers: jsonHeaders() }
      };
    }
    case "candle_report_activity": {
      const apiKey = requireApiKey(cfg);
      return {
        url: `${base}/api/v1/activity/report`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(args) }
      };
    }
    case "candle_get_agent_profile": {
      const { idOrWallet } = args;
      return { url: `${base}/api/v1/users/${idOrWallet}/agent`, init: { method: "GET", headers: jsonHeaders() } };
    }
  }
}
async function callAndRelay(name, args, cfg) {
  const { url, init } = buildRequest(name, args, cfg);
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    content: [{ type: "text", text }],
    ...res.ok ? {} : { isError: true }
  };
}
var launchTokenShape = {
  clientLaunchId: z.string().describe("Caller-chosen idempotency key, unique per account"),
  name: z.string().describe("Token name"),
  symbol: z.string().describe("Token symbol"),
  imageUrl: z.string().describe("https URL to the token image. Must be roughly SQUARE (aspect ratio at most 1.5:1): it " + "renders as a small circle/square avatar everywhere. Share cards, OG images and banners " + "are rejected with IMAGE_WRONG_SHAPE"),
  chain: z.string().optional().describe('"solana" or "hood"; defaults to solana'),
  quoteAsset: z.string().optional().describe("Quote asset symbol; defaults per chain"),
  mode: z.string().optional().describe('"open" or "exclusive"; defaults to open. "test-open" / "test-exclusive" launch the ' + "low-threshold test curves (~1/80 economics) where the API has ENABLE_TEST_CURVES on"),
  stakerAllocationBps: z.number().optional().describe("Staker allocation in basis points"),
  dexVersion: z.string().nullable().optional().describe('"v3" or "v4"; required for hood launches'),
  buyAmount: z.union([z.string(), z.number()]).optional().describe("Initial buy, in quote base units (string or number)"),
  description: z.string().optional(),
  socials: z.record(z.string()).optional().describe("Social links keyed by platform"),
  visibility: z.string().optional().describe('"production", "test", "local", or "hidden"'),
  dryRun: z.boolean().optional().describe("Validate without executing the launch")
};
var getMarketShape = {
  chain: z.string().describe('"solana" or "hood"'),
  mint: z.string().describe("Token mint (solana) or contract address (hood)")
};
var getFeedShape = {
  bucket: z.enum(["new", "graduated", "onfire", "bluechip"]),
  chain: z.string().optional().describe("Optional chain filter")
};
var reportActivityShape = {
  chain: z.string().describe('"solana" or "hood"'),
  signature: z.string().describe("Transaction signature/hash to verify and record")
};
var getAgentProfileShape = {
  idOrWallet: z.string().describe("Candle username or wallet address")
};
function registerTools(server) {
  const cfg = resolveConfig();
  server.registerTool("candle_launch_token", {
    title: "Launch a token on Candle",
    description: "Launch a new token via the Candle headless launch API. Set dryRun: true to validate without spending anything.",
    inputSchema: launchTokenShape
  }, async (args) => callAndRelay("candle_launch_token", args, cfg));
  server.registerTool("candle_get_market", {
    title: "Get market state",
    description: "Read the current market state for a token: lifecycle, pool address, whether buys are open.",
    inputSchema: getMarketShape
  }, async (args) => callAndRelay("candle_get_market", args, cfg));
  server.registerTool("candle_get_feed", {
    title: "Get a token feed",
    description: "Read one of the trade page's public feeds: new, graduated, onfire, or bluechip.",
    inputSchema: getFeedShape
  }, async (args) => callAndRelay("candle_get_feed", args, cfg));
  server.registerTool("candle_report_activity", {
    title: "Report on-chain activity",
    description: "Report a client-executed transaction (transfer, swap, stake) so Candle records and verifies it.",
    inputSchema: reportActivityShape
  }, async (args) => callAndRelay("candle_report_activity", args, cfg));
  server.registerTool("candle_get_agent_profile", {
    title: "Get an agent profile",
    description: "Read a Candle user's public agent profile: whether agent features are enabled and launch counts.",
    inputSchema: getAgentProfileShape
  }, async (args) => callAndRelay("candle_get_agent_profile", args, cfg));
}

// src/version.ts
var SERVER_VERSION = "0.1.0";

// src/index.ts
var server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION });
registerTools(server);
var transport = new StdioServerTransport;
await server.connect(transport);
