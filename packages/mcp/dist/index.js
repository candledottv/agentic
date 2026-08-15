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
  const apiKey = process.env.CANDLE_AGENT_API_KEY?.trim() || process.env.CANDLE_API_KEY?.trim();
  return apiKey ? { apiUrl, apiKey } : { apiUrl };
}

// src/orchestrate.ts
import { randomUUID } from "node:crypto";

// src/convert.ts
var QUOTE_DECIMALS = {
  sol: 9,
  usdc: 6,
  cndl: 6,
  eth: 18,
  usdg: 6
};
function defaultQuoteId(chain) {
  return chain === "hood" ? "eth" : "sol";
}
var DECIMAL_RE = /^\d+(\.\d+)?$/;
function decimalToRaw(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
  if (!DECIMAL_RE.test(amount)) {
    throw new Error(`amount must be a plain positive decimal string, got "${amount}"`);
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new Error(`amount "${amount}" has more fraction digits than the asset's ${decimals} decimals`);
  }
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (raw === 0n)
    throw new Error("amount must be greater than zero");
  return raw.toString();
}
function percentOfBalance(balanceRaw, percent) {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error(`percent must be an integer between 1 and 100, got ${percent}`);
  }
  if (!/^\d+$/.test(balanceRaw)) {
    throw new Error(`balanceRaw must be a raw integer string, got "${balanceRaw}"`);
  }
  const result = BigInt(balanceRaw) * BigInt(percent) / 100n;
  if (result === 0n) {
    throw new Error(`${percent}% of the balance ${balanceRaw} floors to zero raw units; nothing to sell`);
  }
  return result.toString();
}

// src/orchestrate.ts
function requireApiKey(cfg) {
  if (!cfg.apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.");
  }
  return cfg.apiKey;
}
function headers(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey)
    h["x-api-key"] = apiKey;
  return h;
}
function base(cfg) {
  return cfg.apiUrl.replace(/\/$/, "");
}
function errText(message, extra) {
  return {
    text: JSON.stringify({ ...extra, success: false, error: { code: "MCP_VALIDATION", message } }),
    isError: true
  };
}
function relayRead(body, extra) {
  let api;
  try {
    api = JSON.parse(body);
  } catch {
    api = body;
  }
  return { text: JSON.stringify({ ...extra, success: false, api }), isError: true };
}
function transportError(idKey, id, thrown) {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  return {
    text: JSON.stringify({
      [idKey]: id,
      success: false,
      error: {
        code: "MCP_TRANSPORT",
        message: `The request failed in transit (${detail}). It may or may not have reached Candle. ` + `Retry with THIS SAME ${idKey} ("${id}") and the same body: the same id replays the ` + "original result instead of executing a second time, while a NEW id is a second, independent " + "trade or launch.",
        retryable: true
      }
    }),
    isError: true
  };
}
function chainForMint(mint) {
  return mint.startsWith("0x") ? "hood" : "solana";
}
function quoteIdDecimals(quoteAsset, chain, extra) {
  const quote = quoteAsset ?? defaultQuoteId(chain);
  const decimals = QUOTE_DECIMALS[quote];
  if (decimals === undefined) {
    return {
      err: errText(`unknown quoteAsset "${quote}"; expected one of ${Object.keys(QUOTE_DECIMALS).join(", ")}`, extra)
    };
  }
  return { decimals };
}
function rawOrError(amount, decimals, extra) {
  try {
    return { raw: decimalToRaw(amount, decimals) };
  } catch (err) {
    return { err: errText(err instanceof Error ? err.message : String(err), extra) };
  }
}
async function postJson(url, apiKey, payload, doFetch) {
  try {
    const res = await doFetch(url, { method: "POST", headers: headers(apiKey), body: JSON.stringify(payload) });
    return { ok: res.ok, body: JSON.parse(await res.text()) };
  } catch (thrown) {
    return { thrown };
  }
}
async function readMarket(mint, cfg, doFetch, extra) {
  const res = await doFetch(`${base(cfg)}/api/v1/markets/${chainForMint(mint)}/${mint}`, {
    method: "GET",
    headers: headers()
  });
  const text = await res.text();
  if (!res.ok)
    return { status: res.status, err: relayRead(text, extra) };
  return { market: JSON.parse(text).market ?? {} };
}
async function executeTrade(args, cfg, doFetch) {
  const apiKey = requireApiKey(cfg);
  const clientTradeId = args.clientTradeId ?? randomUUID();
  if (args.amount !== undefined && args.percent !== undefined) {
    return errText("pass exactly one of amount or percent, not both", { clientTradeId });
  }
  if (args.amount === undefined && args.percent === undefined) {
    return errText("pass exactly one of amount or percent", { clientTradeId });
  }
  if (args.percent !== undefined && args.side !== "sell") {
    return errText("percent is only valid on sells; buys take a quote-asset amount", { clientTradeId });
  }
  if (args.percent !== undefined && chainForMint(args.mint) === "hood") {
    return errText(`percent sells are Solana-only in v1, and ${args.mint} is a hood (0x) address; pass an explicit amount instead`, { clientTradeId });
  }
  let amountRaw;
  let resolved;
  try {
    if (args.side === "buy") {
      const amount = args.amount;
      const read = await readMarket(args.mint, cfg, doFetch, { clientTradeId });
      let decimals;
      if ("market" in read) {
        const quoteDecimals = read.market.quoteDecimals;
        if (typeof quoteDecimals !== "number") {
          return errText(`could not resolve the quote decimals for mint ${args.mint}; a buy is denominated in that token's own quote asset and this market does not report its scale. Read the market with candle_get_market, then trade a raw amount via the SDK instead`, { clientTradeId });
        }
        decimals = quoteDecimals;
      } else if (read.status === 404) {
        const q = quoteIdDecimals(args.quoteAsset, chainForMint(args.mint), { clientTradeId });
        if ("err" in q)
          return q.err;
        decimals = q.decimals;
      } else {
        return read.err;
      }
      const converted = rawOrError(amount, decimals, { clientTradeId });
      if ("err" in converted)
        return converted.err;
      amountRaw = converted.raw;
      resolved = { amountDecimal: amount, decimals, amountRaw };
    } else if (args.amount !== undefined) {
      const read = await readMarket(args.mint, cfg, doFetch, { clientTradeId });
      if (!("market" in read))
        return read.err;
      const decimals = read.market.decimals;
      if (typeof decimals !== "number") {
        return errText(`could not resolve decimals for mint ${args.mint}; pass a raw-ready amount via the SDK instead`, { clientTradeId });
      }
      const converted = rawOrError(args.amount, decimals, { clientTradeId });
      if ("err" in converted)
        return converted.err;
      amountRaw = converted.raw;
      resolved = { amountDecimal: args.amount, decimals, amountRaw };
    } else {
      const percent = args.percent;
      const walletsRes = await doFetch(`${base(cfg)}/api/v1/agent/wallets/embedded`, {
        method: "GET",
        headers: headers(apiKey)
      });
      const walletsText = await walletsRes.text();
      if (!walletsRes.ok)
        return relayRead(walletsText, { clientTradeId });
      const walletsBody = JSON.parse(walletsText);
      const address = walletsBody.wallets?.solana?.address;
      if (!address) {
        return errText("percent sells need an embedded Solana wallet, and this account has none", { clientTradeId });
      }
      const balRes = await doFetch(`${base(cfg)}/api/v1/tokens/${args.mint}/balance/${address}`, {
        method: "GET",
        headers: headers()
      });
      const balText = await balRes.text();
      if (!balRes.ok)
        return relayRead(balText, { clientTradeId });
      const balBody = JSON.parse(balText);
      const balance = balBody.payload?.balance;
      if (!balance) {
        return errText(`the embedded wallet ${address} holds no ${args.mint}; nothing to sell`, { clientTradeId });
      }
      amountRaw = percentOfBalance(balance, percent);
      resolved = { percent, balanceRaw: balance, amountRaw };
    }
  } catch (err) {
    return errText(err instanceof Error ? err.message : String(err), { clientTradeId });
  }
  const posted = await postJson(`${base(cfg)}/api/v1/trade/agent/build`, apiKey, {
    clientTradeId,
    mint: args.mint,
    side: args.side,
    amountRaw,
    payer: { type: "main" },
    ...args.quoteAsset !== undefined ? { quoteAsset: args.quoteAsset } : {},
    ...args.maxSlippageBps !== undefined ? { maxSlippageBps: args.maxSlippageBps } : {}
  }, doFetch);
  if ("thrown" in posted)
    return transportError("clientTradeId", clientTradeId, posted.thrown);
  const wrapped = JSON.stringify({ clientTradeId, resolved, api: posted.body });
  return posted.ok ? { text: wrapped } : { text: wrapped, isError: true };
}
async function executeLaunchAndSeed(args, cfg, doFetch) {
  const apiKey = requireApiKey(cfg);
  const clientLaunchId = args.clientLaunchId ?? randomUUID();
  const { devBuy, dryRun, buyAmount: _rawBuyAmount, ...launchFields } = args;
  let buyAmount;
  if (devBuy !== undefined) {
    const q = quoteIdDecimals(args.quoteAsset, args.chain, { clientLaunchId });
    if ("err" in q)
      return q.err;
    const converted = rawOrError(devBuy, q.decimals, { clientLaunchId });
    if ("err" in converted)
      return converted.err;
    buyAmount = converted.raw;
  }
  const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless";
  const posted = await postJson(`${base(cfg)}${path}`, apiKey, {
    ...launchFields,
    clientLaunchId,
    ...buyAmount !== undefined ? { buyAmount } : {}
  }, doFetch);
  if ("thrown" in posted)
    return transportError("clientLaunchId", clientLaunchId, posted.thrown);
  if (!posted.ok) {
    return { text: JSON.stringify({ clientLaunchId, api: posted.body }), isError: true };
  }
  if (dryRun) {
    return { text: JSON.stringify({ clientLaunchId, dryRun: true, api: posted.body }) };
  }
  const launch = posted.body;
  let market = null;
  let note;
  try {
    const marketRes = await doFetch(`${base(cfg)}/api/v1/markets/${launch.chain ?? "solana"}/${launch.mint}`, {
      method: "GET",
      headers: headers()
    });
    if (marketRes.ok) {
      market = JSON.parse(await marketRes.text()).market ?? null;
    } else {
      note = "launch confirmed; the follow-up market read failed, read it via candle_get_market";
    }
  } catch {
    note = "launch confirmed; the follow-up market read failed, read it via candle_get_market";
  }
  return {
    text: JSON.stringify({ clientLaunchId, launch, market, ...note ? { note } : {} })
  };
}

// src/tools.ts
function requireApiKey2(cfg) {
  if (!cfg.apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.");
  }
  return cfg.apiKey;
}
function jsonHeaders(apiKey) {
  const headers2 = { "Content-Type": "application/json" };
  if (apiKey)
    headers2["x-api-key"] = apiKey;
  return headers2;
}
function buildRequest(name, args, cfg) {
  const base2 = cfg.apiUrl.replace(/\/$/, "");
  switch (name) {
    case "candle_launch_token": {
      const apiKey = requireApiKey2(cfg);
      const { dryRun, ...body } = args;
      const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless";
      return {
        url: `${base2}${path}`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) }
      };
    }
    case "candle_get_market": {
      const { chain, mint } = args;
      return { url: `${base2}/api/v1/markets/${chain}/${mint}`, init: { method: "GET", headers: jsonHeaders() } };
    }
    case "candle_get_feed": {
      const { bucket, chain } = args;
      const query = new URLSearchParams({ bucket, ...chain ? { chain } : {} });
      return {
        url: `${base2}/api/v1/markets/feed?${query.toString()}`,
        init: { method: "GET", headers: jsonHeaders() }
      };
    }
    case "candle_report_activity": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/activity/report`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(args) }
      };
    }
    case "candle_get_agent_profile": {
      const { idOrWallet } = args;
      return { url: `${base2}/api/v1/users/${idOrWallet}/agent`, init: { method: "GET", headers: jsonHeaders() } };
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
var tradeShape = {
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
  side: z.enum(["buy", "sell"]),
  amount: z.string().optional().describe("Decimal amount. Buys: how much of THIS TOKEN'S OWN quote asset to spend (SOL for a " + 'SOL-launched token, USDC for a USDC-quoted one, and so on: e.g. "0.5"). Sells: how many ' + "TOKENS to sell. Pass exactly one of amount or percent."),
  percent: z.number().optional().describe("Sells only: sell this percent (integer 1-100) of the wallet's holding. Solana only."),
  quoteAsset: z.string().optional().describe('Quote asset ("sol", "usdc", "cndl") for an arbitrary Solana mint Candle never launched ' + "(Pro/Max only); defaults to sol. Ignored for a Candle-launched token, whose quote comes " + "from the token itself, so it never changes how a buy amount is interpreted there."),
  maxSlippageBps: z.number().optional().describe("Max slippage in basis points; API default applies when omitted"),
  clientTradeId: z.string().optional().describe("Idempotency key. Auto-generated when omitted and echoed in the result. Retrying with the " + "SAME id is safe (idempotent replay); a new id is a SECOND trade.")
};
var { buyAmount: _rawBuyAmount, ...seedableLaunchShape } = launchTokenShape;
var launchAndSeedShape = {
  ...seedableLaunchShape,
  clientLaunchId: z.string().optional().describe("Idempotency key. Auto-generated when omitted and echoed in the result."),
  devBuy: z.string().optional().describe('Seed buy in DECIMAL units of the quote asset this launch selects (e.g. "0.25" SOL, or ' + "ETH on hood), bundled into the launch transaction itself. Follows quoteAsset, which " + "defaults to sol on solana and eth on hood. Capped by the platform dev-buy ceiling; for " + "a larger seed, launch then follow with candle_trade.")
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
  server.registerTool("candle_trade", {
    title: "Buy or sell a token",
    description: "Execute a buy or sell through the Candle trade rail. MOVES REAL FUNDS: the payer is the " + "account's embedded (main) wallet, executed server-side via delegation. Amounts are " + "decimal (never raw base units). Retry a timeout with the SAME clientTradeId from the " + "result; a new id is a second trade.",
    inputSchema: tradeShape
  }, async (args) => {
    const result = await executeTrade(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  server.registerTool("candle_launch_and_seed", {
    title: "Launch a token and seed it",
    description: "Launch a new token with an optional dev-buy seed bundled into the launch itself, then " + "return the fresh market state and token links in one result. MOVES REAL FUNDS unless " + "dryRun. Seeds above the platform dev-buy ceiling are rejected (DEV_BUY_TOO_HIGH); " + "launch, then top up with candle_trade.",
    inputSchema: launchAndSeedShape
  }, async (args) => {
    const result = await executeLaunchAndSeed(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
}

// src/version.ts
var SERVER_VERSION = "0.1.0";

// src/index.ts
var server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION });
registerTools(server);
var transport = new StdioServerTransport;
await server.connect(transport);
