#!/usr/bin/env node

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools.ts
import { z } from "zod";

// src/client.ts
var DEFAULT_API_URL = "https://api.alpha.candle.tv";
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost"))
    return true;
  if (host === "::1" || host === "[::1]")
    return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
function assertTransportSecurity(apiUrl, env) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`CANDLE_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`);
  }
  if (parsed.protocol === "https:")
    return;
  if (parsed.protocol !== "http:") {
    throw new Error(`CANDLE_API_URL must be http or https, got ${parsed.protocol.replace(":", "")}`);
  }
  if (isLoopbackHost(parsed.hostname))
    return;
  if (env.CANDLE_ALLOW_INSECURE_HTTP?.trim())
    return;
  throw new Error(`Refusing to send credentials in the clear to ${parsed.origin}. Set CANDLE_API_URL to an https:// ` + "URL, or set CANDLE_ALLOW_INSECURE_HTTP=1 if this really is a trusted local endpoint.");
}
function resolveConfig(env = process.env) {
  const apiUrl = env.CANDLE_API_URL?.trim() || DEFAULT_API_URL;
  assertTransportSecurity(apiUrl, env);
  const apiKey = env.CANDLE_AGENT_API_KEY?.trim() || env.CANDLE_API_KEY?.trim();
  return apiKey ? { apiUrl, apiKey } : { apiUrl };
}

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
import { randomUUID } from "node:crypto";
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
  const res = await doFetch(`${base(cfg)}/api/v1/markets/${chainForMint(mint)}/${encodeURIComponent(mint)}`, {
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
      const chain = chainForMint(args.mint);
      const address = chain === "hood" ? walletsBody.wallets?.evm?.address : walletsBody.wallets?.solana?.address;
      if (!address) {
        return errText(`percent sells need an embedded ${chain === "hood" ? "EVM" : "Solana"} wallet, and this account has none`, { clientTradeId });
      }
      const balRes = await doFetch(`${base(cfg)}/api/v1/tokens/${encodeURIComponent(args.mint)}/balance/${encodeURIComponent(address)}`, {
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
    if (launch.mint === undefined)
      throw new Error("the launch response carried no mint");
    const marketRes = await doFetch(`${base(cfg)}/api/v1/markets/${encodeURIComponent(launch.chain ?? "solana")}/${encodeURIComponent(launch.mint)}`, {
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
var SWEEP_BASE_ASSETS = {
  solana: ["USDC", "CNDL", "SOL"],
  hood: ["USDG", "ETH"]
};
async function executeSweep(args, cfg, doFetch) {
  const apiKey = cfg.apiKey;
  if (!apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.");
  }
  const base2 = cfg.apiUrl.replace(/\/$/, "");
  const baseAssets = SWEEP_BASE_ASSETS[args.chain];
  const targets = [
    ...baseAssets.slice(0, -1).map((value) => ({ field: "asset", value })),
    ...(args.mints ?? []).map((value) => ({ field: "mint", value })),
    { field: "asset", value: baseAssets[baseAssets.length - 1] }
  ];
  const results = [];
  for (const target of targets) {
    let body;
    let ok = false;
    try {
      const res = await doFetch(`${base2}/api/v1/agent/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          chain: args.chain,
          [target.field]: target.value,
          amountRaw: "max",
          to: args.to
        })
      });
      ok = res.ok;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } catch (err) {
      results.push({ asset: target.value, status: "error", error: String(err) });
      continue;
    }
    if (ok) {
      const payload = body;
      results.push({
        asset: target.value,
        status: "transferred",
        amountRaw: payload.amountRaw,
        signature: payload.signature
      });
      continue;
    }
    const code = body?.error?.code ?? "";
    if (code === "TRANSFER_AMOUNT_UNAVAILABLE") {
      results.push({ asset: target.value, status: "empty" });
    } else {
      results.push({ asset: target.value, status: "error", error: body });
    }
  }
  const transferred = results.filter((r) => r.status === "transferred").length;
  const failed = results.filter((r) => r.status === "error").length;
  return {
    text: JSON.stringify({ chain: args.chain, to: args.to, transferred, failed, results }),
    ...transferred === 0 && failed > 0 ? { isError: true } : {}
  };
}
async function resolveToken(args, cfg, doFetch) {
  const chain = chainForMint(args.mint);
  const read = await readMarket(args.mint, cfg, doFetch, { mint: args.mint, chain });
  if ("err" in read)
    return read.err;
  return { text: JSON.stringify({ success: true, chain, mint: args.mint, market: read.market }, null, 2) };
}
async function executionStatus(cfg, doFetch) {
  const apiKey = requireApiKey(cfg);
  const get = async (path) => {
    const res = await doFetch(`${base(cfg)}${path}`, { method: "GET", headers: headers(apiKey) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  };
  const [wallets, tier, limits] = await Promise.all([
    get("/api/v1/agent/wallets/embedded"),
    get("/api/v1/agent/tier"),
    get("/api/v1/agent/keys/self/limits")
  ]);
  const unreadable = [
    ["wallets", wallets],
    ["tier", tier],
    ["limits", limits]
  ].filter(([, r]) => !r.ok);
  return {
    text: JSON.stringify({
      success: true,
      ready: unreadable.length === 0 ? true : undefined,
      unreadable: unreadable.length > 0 ? unreadable.map(([name]) => name) : undefined,
      wallets: wallets.body,
      tier: tier.body,
      limits: limits.body
    }, null, 2),
    ...unreadable.length > 0 ? { isError: true } : {}
  };
}

// src/tools.ts
var TOOL_NAMES = [
  "candle_launch_token",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_report_activity",
  "candle_get_agent_profile",
  "candle_trade",
  "candle_launch_and_seed",
  "candle_swap",
  "candle_transfer",
  "candle_sweep",
  "candle_get_wallets",
  "candle_resolve_token",
  "candle_execution_status"
];
function resolveToolAllowlist(env) {
  const raw = env.CANDLE_MCP_TOOLS?.trim();
  if (!raw)
    return new Set(TOOL_NAMES);
  const requested = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  const unknown = requested.filter((name) => !TOOL_NAMES.includes(name));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`CANDLE_MCP_TOOLS contains unknown tool name(s): ${unknown.join(", ") || "(none given)"}. Valid names: ${TOOL_NAMES.join(", ")}`);
  }
  return new Set(requested);
}
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
function swapBody(args) {
  const { amount, amountRaw, ...rest } = args;
  const hasAmount = typeof amount === "string" && amount.length > 0;
  const hasRaw = typeof amountRaw === "string" && amountRaw.length > 0;
  if (hasAmount && hasRaw) {
    throw new Error("Pass exactly one of amount or amountRaw, not both.");
  }
  if (!hasAmount && !hasRaw) {
    throw new Error('Pass an amount, e.g. amount: "0.5".');
  }
  if (hasRaw)
    return { ...rest, amountRaw };
  const from = String(rest.from ?? "").toLowerCase();
  const decimals = QUOTE_DECIMALS[from];
  if (decimals === undefined) {
    throw new Error(`Unknown decimals for base asset "${from}". Pass amountRaw instead.`);
  }
  return { ...rest, amountRaw: decimalToRaw(amount, decimals) };
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
      return {
        url: `${base2}/api/v1/markets/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}`,
        init: { method: "GET", headers: jsonHeaders() }
      };
    }
    case "candle_token_forensics": {
      const { chain, mint } = args;
      return {
        url: `${base2}/api/v1/markets/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}/forensics`,
        init: { method: "GET", headers: jsonHeaders() }
      };
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
      return {
        url: `${base2}/api/v1/users/${encodeURIComponent(idOrWallet)}/agent`,
        init: { method: "GET", headers: jsonHeaders() }
      };
    }
    case "candle_swap": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/swap`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(swapBody(args)) }
      };
    }
    case "candle_get_wallets": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/wallets/embedded`,
        init: { method: "GET", headers: jsonHeaders(apiKey) }
      };
    }
    case "candle_transfer": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/transfer`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(args) }
      };
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
  imageUrl: z.string().describe("https URL to the token image. Must be roughly SQUARE (aspect ratio at most 1.5:1): it " + "renders as a small circle/square avatar everywhere. Share cards, OG images and banners " + "are rejected with IMAGE_WRONG_SHAPE -- pass those as bannerUrl instead"),
  bannerUrl: z.string().optional().describe("Optional https URL to WIDE artwork for the token page's banner strip (wider than 1.5:1, " + "e.g. 1200x630). This is where a share card or OG image belongs. A square image here is " + "rejected with BANNER_WRONG_SHAPE. Omit it and the strip falls back to imageUrl"),
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
var tokenForensicsShape = {
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
var resolveTokenShape = {
  mint: z.string().describe("Token mint (Solana, base58) or contract address (Hood, 0x-prefixed)")
};
var swapShape = {
  from: z.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to spend"),
  to: z.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to receive; must differ from `from`"),
  amount: z.string().optional().describe('Decimal amount of `from` to spend, e.g. "0.5". Preferred. Pass exactly one of amount or amountRaw.'),
  amountRaw: z.string().optional().describe("Raw base units of `from`, as a positive integer string. Kept for callers that already " + "compute raw units; new callers should use `amount`."),
  maxSlippageBps: z.number().optional().describe("Slippage bound in bps, 0-10000. Server defaults to 100 (1%)"),
  clientSwapId: z.string().optional().describe("Optional dedup key. Only coalesces a duplicate that arrives while the first call is still " + "in flight; one arriving after it settled will swap again")
};
var tradeShape = {
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
  side: z.enum(["buy", "sell"]),
  amount: z.string().optional().describe("Decimal amount. Buys: how much of THIS TOKEN'S OWN quote asset to spend (SOL for a " + 'SOL-launched token, USDC for a USDC-quoted one, and so on: e.g. "0.5"). Sells: how many ' + "TOKENS to sell. Pass exactly one of amount or percent."),
  percent: z.number().optional().describe("Sells only: sell this percent (integer 1-100) of the wallet's holding, on either chain."),
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
var transferShape = {
  chain: z.enum(["solana", "hood"]).describe("Which chain the transfer executes on"),
  asset: z.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).optional().describe("A base asset key. Pass exactly one of asset or mint."),
  mint: z.string().optional().describe("An arbitrary token: SPL mint (Solana) or ERC-20 contract (Hood). Own-wallet destinations only; withdrawals to approved addresses are base-assets-only."),
  amountRaw: z.string().describe('RAW base units as a decimal string (lamports, wei, token raw units), or "max" to sweep the spendable balance. NOT a human decimal: 1 SOL is "1000000000".'),
  to: z.string().describe("Destination address. Must be one of the account's own wallets, or an address the OWNER pre-approved as a withdrawal address in the Candle console -- anything else is refused before signing."),
  clientTransferId: z.string().optional().describe("Caller-chosen idempotency key for safe retries")
};
var sweepShape = {
  chain: z.enum(["solana", "hood"]).describe("Which chain to sweep"),
  to: z.string().describe("Destination address, same rules as candle_transfer's `to`"),
  mints: z.array(z.string()).optional().describe("Extra token mints/contracts to sweep besides the chain's base assets (own-wallet destinations only).")
};
function registerTools(server, env = process.env) {
  const cfg = resolveConfig(env);
  const allowed = resolveToolAllowlist(env);
  const register = (name, ...rest) => {
    if (!allowed.has(name))
      return;
    return server.registerTool(name, ...rest);
  };
  register("candle_launch_token", {
    title: "Launch a token on Candle",
    description: "Launch a new token via the Candle headless launch API. Set dryRun: true to validate without spending anything.",
    inputSchema: launchTokenShape
  }, async (args) => callAndRelay("candle_launch_token", args, cfg));
  register("candle_get_market", {
    title: "Get market state",
    description: "Read the current market state for a token: lifecycle, pool address, whether buys are open.",
    inputSchema: getMarketShape
  }, async (args) => callAndRelay("candle_get_market", args, cfg));
  register("candle_token_forensics", {
    title: "Token forensics",
    description: "Gate a buy before making it: deployer history, who bought in the deploy window (the creator's own wallets are marked disclosed; strangers in the same slot are the bundle signal), holder concentration, and a risk tier (LOW/MODERATE/HIGH/CRITICAL) with per-factor reasons. Every measurement carries a coverage note -- 'unavailable' is not 'clean'. No key needed.",
    inputSchema: tokenForensicsShape
  }, async (args) => callAndRelay("candle_token_forensics", args, cfg));
  register("candle_get_feed", {
    title: "Get a token feed",
    description: "Read one of the trade page's public feeds: new, graduated, onfire, or bluechip.",
    inputSchema: getFeedShape
  }, async (args) => callAndRelay("candle_get_feed", args, cfg));
  register("candle_report_activity", {
    title: "Report on-chain activity",
    description: "Report a client-executed transaction (transfer, swap, stake) so Candle records and verifies it.",
    inputSchema: reportActivityShape
  }, async (args) => callAndRelay("candle_report_activity", args, cfg));
  register("candle_get_agent_profile", {
    title: "Get an agent profile",
    description: "Read a Candle user's public agent profile: whether agent features are enabled and launch counts.",
    inputSchema: getAgentProfileShape
  }, async (args) => callAndRelay("candle_get_agent_profile", args, cfg));
  register("candle_get_wallets", {
    title: "List the wallets Candle executes with",
    description: "The account's EMBEDDED wallets, one per chain, with their delegation state. These are " + "the wallets candle_trade, candle_swap and candle_transfer spend from, so this is how an " + "agent finds its own funding addresses. Reads only; moves nothing. Not the same as the " + "account's LINKED wallets, which are the owner's own wallets and are not spent from here. " + "Balances are not included: read a specific one with the market and balance endpoints.",
    inputSchema: {}
  }, async () => callAndRelay("candle_get_wallets", {}, cfg));
  register("candle_resolve_token", {
    title: "Resolve a contract address to a token",
    description: "Turn a bare contract address or mint into Candle's market for it: chain, symbol, " + "decimals, quote asset, and whether Candle can trade it. Start here when a human gives " + "you an address and nothing else. The chain is read off the address's own shape and is " + "not guessed, so it does not need to be supplied. Reads only; moves nothing. A 404 means " + "Candle has no market for that address, which is an answer, not a failure to retry.",
    inputSchema: resolveTokenShape
  }, async (args) => {
    const result = await resolveToken(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  register("candle_execution_status", {
    title: "Can this key execute right now",
    description: "One call before trading: the embedded wallets to spend from, the tier that decides what " + "may be traded, and this key's own spend limits. Reads only; moves nothing. Call it when " + "a run starts, or after an authorization error, rather than inferring readiness from a " + "failed trade. If a read could not be completed the tool says which one and does NOT " + "claim the account is unready: an unreachable endpoint and a missing tier are different " + "problems with different fixes.",
    inputSchema: {}
  }, async () => {
    const result = await executionStatus(cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  register("candle_swap", {
    title: "Convert between base assets",
    description: "Convert one base asset into another through the account's own embedded wallets. MOVES " + "REAL FUNDS. A pair spanning the Solana side (SOL/USDC/CNDL) and the Hood side (ETH/USDG) " + "routes through the bridge, so this is how a Hood wallet gets funded before launching or " + "trading on hood, and that leg settles across two chains rather than instantly. Amounts " + 'are decimal (`amount`, e.g. "0.5"); `amountRaw` still accepts raw base units for callers ' + "that already compute them. Test-environment keys are refused: every leg settles on a " + "live venue.",
    inputSchema: swapShape
  }, async (args) => callAndRelay("candle_swap", args, cfg));
  register("candle_transfer", {
    title: "Transfer an asset",
    description: "Move an asset from the account's embedded wallet to one of the account's own wallets, or to an owner-approved withdrawal address. amountRaw 'max' sweeps the spendable balance of that asset.",
    inputSchema: transferShape
  }, async (args) => callAndRelay("candle_transfer", args, cfg));
  register("candle_sweep", {
    title: "Sweep a wallet",
    description: "Sweep the embedded wallet on one chain to a destination: every base asset (plus any explicitly named mints), one transfer per asset with amountRaw 'max'. Assets with nothing spendable are reported as empty, not errors.",
    inputSchema: sweepShape
  }, async (args) => {
    const result = await executeSweep(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  register("candle_trade", {
    title: "Buy or sell a token",
    description: "Execute a buy or sell through the Candle trade rail. MOVES REAL FUNDS: the payer is the " + "account's embedded (main) wallet, executed server-side via delegation. Amounts are " + "decimal (never raw base units). Retry a timeout with the SAME clientTradeId from the " + "result; a new id is a second trade.",
    inputSchema: tradeShape
  }, async (args) => {
    const result = await executeTrade(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  register("candle_launch_and_seed", {
    title: "Launch a token and seed it",
    description: "Launch a new token with an optional dev-buy seed bundled into the launch itself, then " + "return the fresh market state and token links in one result. MOVES REAL FUNDS unless " + "dryRun. Seeds above the platform dev-buy ceiling are rejected (DEV_BUY_TOO_HIGH); " + "launch, then top up with candle_trade.",
    inputSchema: launchAndSeedShape
  }, async (args) => {
    const result = await executeLaunchAndSeed(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
}

// src/version.ts
var SERVER_VERSION = "0.5.0";

// src/server.ts
function createCandleMcpServer(env = process.env) {
  const server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION });
  registerTools(server, env);
  return server;
}
async function runStdioServer(env = process.env, transport = new StdioServerTransport) {
  const server = createCandleMcpServer(env);
  await server.connect(transport);
  await new Promise((resolve) => {
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      sdkOnClose?.();
      resolve();
    };
  });
}

// src/index.ts
await runStdioServer();
