#!/usr/bin/env node

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools.ts
import { z as z2 } from "zod";

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
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":"))
    return true;
  if (/\.(local|internal|home\.arpa)$/.test(host))
    return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))
    return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host))
    return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host))
    return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host))
    return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host))
    return true;
  return /^fe[89ab][0-9a-f]:/.test(host);
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
  if (env.CANDLE_ALLOW_INSECURE_HTTP?.trim() && isPrivateHost(parsed.hostname))
    return;
  throw new Error(`Refusing to send credentials in the clear to ${parsed.origin}. Set CANDLE_API_URL to an https:// ` + (isPrivateHost(parsed.hostname) ? "URL, or set CANDLE_ALLOW_INSECURE_HTTP=1 if this really is a trusted local endpoint." : "URL. CANDLE_ALLOW_INSECURE_HTTP does not apply here: it covers private networks only, " + "and this is a public address."));
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

// src/version.ts
var SERVER_VERSION = "0.10.7";

// src/update-notice.ts
var PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
var latestSeen = null;
var warned = false;
function newer(a, b) {
  const [a1 = 0, a2 = 0, a3 = 0] = a.split(".").map(Number);
  const [b1 = 0, b2 = 0, b3 = 0] = b.split(".").map(Number);
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3;
}
function noteVersionHeaders(res) {
  const headers = res?.headers;
  const value = typeof headers?.get === "function" ? headers.get("x-candle-mcp-latest") : null;
  if (!value || !PLAIN_VERSION.test(value))
    return;
  if (latestSeen !== null && !newer(value, latestSeen))
    return;
  latestSeen = value;
  if (!warned && newer(value, SERVER_VERSION) && !process.env.CANDLE_NO_UPDATE_NOTIFIER) {
    warned = true;
    console.error(`@candledottv/mcp ${value} is available (running ${SERVER_VERSION}). Update: npm install -g @candledottv/mcp@latest`);
  }
}
function updateAvailable() {
  if (latestSeen === null || !newer(latestSeen, SERVER_VERSION))
    return null;
  return {
    current: SERVER_VERSION,
    latest: latestSeen,
    command: "npm install -g @candledottv/mcp@latest"
  };
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
  const res = await doFetch(`${base(cfg)}/api/v1/markets/${chainForMint(mint)}/${encodeURIComponent(mint)}`, {
    method: "GET",
    headers: headers()
  });
  const text = await res.text();
  if (!res.ok) {
    let reason;
    try {
      reason = JSON.parse(text)?.error?.routing?.reason;
    } catch {}
    return { status: res.status, err: relayRead(text, extra), reason };
  }
  return { market: JSON.parse(text).market ?? {} };
}
function isPaperFlag(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
function heldPaperPosition(positions, mint) {
  const key = (value) => {
    const trimmed = value.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  };
  return positions.find((p) => key(p.mint) === key(mint) && p.amountRaw !== "0");
}
async function readPaperInventory(cfg, doFetch, extra) {
  const res = await doFetch(`${base(cfg)}/api/v1/trade/agent/paper/inventory`, {
    method: "GET",
    headers: headers(cfg.apiKey)
  });
  const text = await res.text();
  if (!res.ok)
    return { err: relayRead(text, extra) };
  const body = JSON.parse(text);
  return { positions: body.positions ?? [] };
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
  let resolved = {};
  let paper = isPaperFlag(args.paper);
  try {
    if (args.side === "buy") {
      const amount = args.amount;
      const read = await readMarket(args.mint, cfg, doFetch, { clientTradeId });
      let decimals;
      if ("market" in read && (read.market.external === true || read.market.candleLaunched === false)) {
        const q = quoteIdDecimals(args.quoteAsset, chainForMint(args.mint), { clientTradeId });
        if ("err" in q)
          return q.err;
        decimals = q.decimals;
      } else if ("market" in read) {
        const quoteDecimals = read.market.quoteDecimals;
        if (typeof quoteDecimals !== "number") {
          return errText(`could not resolve the quote decimals for mint ${args.mint}; a buy is denominated in that token's own quote asset and this market does not report its scale. Read the market with candle_get_market, then trade a raw amount via the SDK instead`, { clientTradeId });
        }
        decimals = quoteDecimals;
      } else if (read.status === 404 && read.reason !== "chain_mismatch") {
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
      let decimals;
      if ("market" in read) {
        if (typeof read.market.decimals !== "number") {
          return errText(`could not resolve decimals for mint ${args.mint}; pass a raw-ready amount via the SDK instead`, { clientTradeId });
        }
        decimals = read.market.decimals;
      } else if (read.status === 404 && read.reason !== "chain_mismatch") {
        const inventory = await readPaperInventory(cfg, doFetch, { clientTradeId });
        if ("err" in inventory) {
          return paper ? inventory.err : read.err;
        }
        const held = heldPaperPosition(inventory.positions, args.mint);
        if (typeof held?.tokenDecimals !== "number") {
          if (paper) {
            return errText(`could not resolve decimals for mint ${args.mint}; no Candle market and no paper position with a known scale. Buy it in paper first, or pass a raw amount via the SDK`, { clientTradeId });
          }
          return read.err;
        }
        decimals = held.tokenDecimals;
        paper = true;
      } else {
        return read.err;
      }
      const converted = rawOrError(args.amount, decimals, { clientTradeId });
      if ("err" in converted)
        return converted.err;
      amountRaw = converted.raw;
      resolved = { amountDecimal: args.amount, decimals, amountRaw };
    } else if (paper) {
      resolved = { percent: args.percent };
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
      let walletEmpty;
      if (!address) {
        walletEmpty = errText(`percent sells need an embedded ${chain === "hood" ? "EVM" : "Solana"} wallet, and this account has none`, { clientTradeId });
      } else {
        const balRes = await doFetch(`${base(cfg)}/api/v1/tokens/${encodeURIComponent(args.mint)}/balance/${encodeURIComponent(address)}`, {
          method: "GET",
          headers: headers()
        });
        const balText = await balRes.text();
        if (!balRes.ok)
          return relayRead(balText, { clientTradeId });
        const balBody = JSON.parse(balText);
        const balance = balBody.payload?.balance;
        if (balance) {
          amountRaw = percentOfBalance(balance, percent);
          resolved = { percent, balanceRaw: balance, amountRaw };
        } else {
          walletEmpty = errText(`the embedded wallet ${address} holds no ${args.mint}; nothing to sell`, {
            clientTradeId
          });
        }
      }
      if (walletEmpty) {
        const inventory = await readPaperInventory(cfg, doFetch, { clientTradeId });
        if (!("err" in inventory) && heldPaperPosition(inventory.positions, args.mint)) {
          paper = true;
          resolved = { percent };
        } else {
          return walletEmpty;
        }
      }
    }
  } catch (err) {
    return errText(err instanceof Error ? err.message : String(err), { clientTradeId });
  }
  const posted = await postJson(`${base(cfg)}/api/v1/trade/agent/build`, apiKey, {
    clientTradeId,
    mint: args.mint,
    side: args.side,
    ...amountRaw !== undefined ? { amountRaw } : { percent: args.percent },
    payer: { type: "main" },
    ...args.quoteAsset !== undefined ? { quoteAsset: args.quoteAsset } : {},
    ...args.maxSlippageBps !== undefined ? { maxSlippageBps: args.maxSlippageBps } : {},
    ...paper ? { paper: true } : {}
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
    noteVersionHeaders(res);
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
  const tierBody = tier.ok ? tier.body : undefined;
  return {
    text: JSON.stringify({
      success: true,
      ready: unreadable.length === 0 ? true : undefined,
      notice: tierBody?.maxExpired ? tierBody.maxExpiredNotice : undefined,
      updateAvailable: updateAvailable() ?? undefined,
      unreadable: unreadable.length > 0 ? unreadable.map(([name]) => name) : undefined,
      wallets: wallets.body,
      tier: tier.body,
      limits: limits.body
    }, null, 2),
    ...unreadable.length > 0 ? { isError: true } : {}
  };
}

// src/perps.ts
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// src/hyperliquid.ts
import { keccak_256 } from "@noble/hashes/sha3";
var HYPERLIQUID_ALLOWED_ACTION_TYPES = [
  "order",
  "cancel",
  "modify",
  "updateLeverage",
  "updateIsolatedMargin"
];
var HYPERLIQUID_EXCHANGE_URLS = {
  mainnet: "https://api.hyperliquid.xyz/exchange",
  testnet: "https://api.hyperliquid-testnet.xyz/exchange"
};
var CANDLE_HYPERLIQUID_BUILDER_ADDRESS = null;
var HYPERLIQUID_MAX_BUILDER_FEE_TENTHS_BPS = 100;
var HYPERLIQUID_MAX_BUILDER_FEE_RATE = "0.1%";
var HYPERLIQUID_SIGNATURE_CHAIN_ID = "0xa4b1";
var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
var UINT64_MAX = (1n << 64n) - 1n;
var INT64_MIN = -(1n << 63n);
function pushUint(out, value, width) {
  for (let i = width - 1;i >= 0; i--)
    out.push(Number(value >> BigInt(i * 8) & 0xffn));
}
function packInteger(out, value) {
  if (value >= 0n) {
    if (value > UINT64_MAX)
      throw new Error("msgpack: integer above uint64");
    if (value < 0x80n)
      out.push(Number(value));
    else if (value <= 0xffn) {
      out.push(204);
      pushUint(out, value, 1);
    } else if (value <= 0xffffn) {
      out.push(205);
      pushUint(out, value, 2);
    } else if (value <= 0xffffffffn) {
      out.push(206);
      pushUint(out, value, 4);
    } else {
      out.push(207);
      pushUint(out, value, 8);
    }
    return;
  }
  if (value < INT64_MIN)
    throw new Error("msgpack: integer below int64");
  if (value >= -32n)
    out.push(Number(value & 0xffn));
  else if (value >= -128n) {
    out.push(208);
    pushUint(out, value & 0xffn, 1);
  } else if (value >= -32768n) {
    out.push(209);
    pushUint(out, value & 0xffffn, 2);
  } else if (value >= -2147483648n) {
    out.push(210);
    pushUint(out, value & 0xffffffffn, 4);
  } else {
    out.push(211);
    pushUint(out, value & UINT64_MAX, 8);
  }
}
function packHeader(out, length, fixBase, fixMax, codes) {
  if (length <= fixMax) {
    out.push(fixBase | length);
    return;
  }
  const [c8, c16, c32] = codes;
  if (c8 !== undefined && c8 !== 0 && length <= 255) {
    out.push(c8);
    pushUint(out, BigInt(length), 1);
  } else if (length <= 65535) {
    out.push(c16);
    pushUint(out, BigInt(length), 2);
  } else {
    out.push(c32);
    pushUint(out, BigInt(length), 4);
  }
}
function packValue(out, value) {
  if (value === null)
    out.push(192);
  else if (value === false)
    out.push(194);
  else if (value === true)
    out.push(195);
  else if (typeof value === "bigint")
    packInteger(out, value);
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`msgpack: ${value} is not a safe integer`);
    packInteger(out, BigInt(value));
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    packHeader(out, bytes.length, 160, 31, [217, 218, 219]);
    for (const b of bytes)
      out.push(b);
  } else if (Array.isArray(value)) {
    packHeader(out, value.length, 144, 15, [0, 220, 221]);
    for (const item of value)
      packValue(out, item);
  } else if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    for (const [key] of entries) {
      if (/^(0|[1-9][0-9]*)$/.test(key))
        throw new Error(`msgpack: integer-like key "${key}"`);
    }
    packHeader(out, entries.length, 128, 15, [0, 222, 223]);
    for (const [key, item] of entries) {
      packValue(out, key);
      packValue(out, item);
    }
  } else {
    throw new Error(`msgpack: cannot encode a ${typeof value}`);
  }
}
function msgpackEncode(value) {
  const out = [];
  packValue(out, value);
  return Uint8Array.from(out);
}
function toHex(bytes) {
  let out = "";
  for (const b of bytes)
    out += b.toString(16).padStart(2, "0");
  return out;
}
function hyperliquidActionHash(action, nonce) {
  const n = BigInt(nonce);
  if (n < 0n || n > UINT64_MAX)
    throw new Error("hyperliquidActionHash: nonce out of range");
  const out = Array.from(msgpackEncode(action));
  pushUint(out, n, 8);
  out.push(0);
  return `0x${toHex(keccak_256(Uint8Array.from(out)))}`;
}
function hyperliquidL1TypedData(connectionId, network) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" }
      ]
    },
    primary_type: "Agent",
    message: { source: network === "mainnet" ? "a" : "b", connectionId }
  };
}
function hyperliquidApproveBuilderFeeTypedData(builder, nonce) {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO_ADDRESS },
    types: {
      "HyperliquidTransaction:ApproveBuilderFee": [
        { name: "hyperliquidChain", type: "string" },
        { name: "maxFeeRate", type: "string" },
        { name: "builder", type: "address" },
        { name: "nonce", type: "uint64" }
      ]
    },
    primary_type: "HyperliquidTransaction:ApproveBuilderFee",
    message: {
      hyperliquidChain: "Mainnet",
      maxFeeRate: HYPERLIQUID_MAX_BUILDER_FEE_RATE,
      builder: builder.toLowerCase(),
      nonce
    }
  };
}
function hyperliquidCanonicalJson(value) {
  return canonical(value);
}
function canonical(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function sameValue(a, b) {
  return canonical(a) === canonical(b);
}
var EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function checkBuilderField(action, builder) {
  if (!("builder" in action) || action.builder === undefined)
    return null;
  const field = action.builder;
  if (typeof field !== "object" || field === null)
    return "builder field is not an object";
  if (typeof field.b !== "string" || field.b.toLowerCase() !== builder.toLowerCase()) {
    return "the order names a builder that is not Candle's";
  }
  if (typeof field.f !== "number" || !Number.isInteger(field.f) || field.f <= 0 || field.f > HYPERLIQUID_MAX_BUILDER_FEE_TENTHS_BPS) {
    return "the builder fee is outside Candle's 0.1% maximum";
  }
  return null;
}
function decimal(value) {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value))
    return null;
  const negative = value.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? value.slice(1) : value).split(".");
  const n = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
  return negative ? -n : n;
}
function checkActionIntent(action, intent) {
  const mainAsset = (a) => typeof a === "number" && Number.isInteger(a) && a >= 0 && a < 1e4;
  const orderList = action.type === "order" ? action.orders : action.type === "modify" ? [action.order] : [];
  if (!Array.isArray(orderList))
    return "invalid orders";
  for (const raw of orderList) {
    if (!raw || typeof raw !== "object")
      return "invalid order";
    const o = raw;
    if (!mainAsset(o.a))
      return "order asset is outside the main perp universe";
    if (typeof o.b !== "boolean" || typeof o.r !== "boolean" || (decimal(o.s) ?? 0n) <= 0n || (decimal(o.p) ?? 0n) <= 0n)
      return "invalid order side, size, price or reduce-only flag";
  }
  if (action.type === "cancel") {
    if (!Array.isArray(action.cancels) || action.cancels.length !== 1 || !mainAsset(action.cancels[0]?.a))
      return "invalid cancel asset";
  }
  if ((action.type === "updateLeverage" || action.type === "updateIsolatedMargin") && !mainAsset(action.asset))
    return "invalid action asset";
  if (!intent)
    return null;
  const { method, params: p } = intent;
  const types = {
    setup: "approveBuilderFee",
    open: "order",
    close: "order",
    cancel: "cancel",
    modify: "modify",
    leverage: "updateLeverage",
    margin: "updateIsolatedMargin"
  };
  if (action.type !== types[method])
    return "action type does not match the requested method";
  if (method === "leverage") {
    if (action.leverage !== p.leverage || action.isCross !== (p.mode !== "isolated"))
      return "leverage or mode does not match the request";
  }
  if (method === "margin") {
    const amount = decimal(p.amount);
    if (amount === null || amount % 10n ** 12n !== 0n || !Number.isSafeInteger(action.ntli) || BigInt(action.ntli) !== amount / 10n ** 12n || action.isBuy !== true)
      return "isolated margin amount does not match the request";
  }
  if (method === "open" || method === "close" || method === "modify") {
    const list = orderList;
    const first = list[0];
    if (!first)
      return "missing requested order";
    const typ = first.t;
    if (!typ?.limit)
      return "requested order is not a limit/IOC order";
    if (method === "open") {
      const buy = p.side === "long" || p.side === "buy";
      if (first.b !== buy || first.r !== false || decimal(first.s) !== decimal(p.size))
        return "order side, size or reduce-only flag does not match the request";
      const tif = (p.type ?? (p.price === undefined ? "market" : "limit")) === "market" ? "Ioc" : p.tif ?? "Gtc";
      if (typ.limit.tif !== tif)
        return "order time in force does not match the request";
      const triggers = [
        ["takeProfit", "tp"],
        ["stopLoss", "sl"]
      ].filter(([field]) => p[field] != null);
      if (list.length !== 1 + triggers.length || action.grouping !== (triggers.length ? "normalTpsl" : "na"))
        return "unexpected extra orders or grouping";
      for (let i = 0;i < triggers.length; i++) {
        const [field, kind] = triggers[i];
        const leg = list[i + 1];
        if (!leg)
          return "missing trigger order";
        const trigger = leg.t?.trigger;
        if (leg.a !== first.a || leg.b !== !buy || leg.r !== true || decimal(leg.s) !== decimal(p.size) || trigger?.tpsl !== kind || trigger.isMarket !== true || decimal(trigger.triggerPx) !== decimal(p[field]))
          return "trigger side, size, reduce-only flag or price does not match the request";
      }
    } else {
      if (list.length !== 1)
        return "unexpected extra orders";
      if (method === "close" && (first.r !== true || typ.limit.tif !== "Ioc" || p.size != null && (decimal(first.s) ?? 0n) > (decimal(p.size) ?? 0n)))
        return "close size or reduce-only flag does not match the request";
      if (method === "modify" && p.size != null && decimal(first.s) !== decimal(p.size))
        return "replacement size does not match the request";
    }
    if (p.price != null && decimal(first.p) !== decimal(p.price))
      return "order price does not match the request";
  }
  return null;
}
async function hyperliquidCloseOrder(fetcher, network, address, params) {
  const read = async (body) => {
    const res = await fetcher(HYPERLIQUID_EXCHANGE_URLS[network].replace("/exchange", "/info"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok)
      throw new Error("Cannot read the close position from Hyperliquid");
    return JSON.parse(await res.text());
  };
  const [meta, state] = await Promise.all([read({ type: "meta" }), read({ type: "clearinghouseState", user: address })]);
  const coin = String(params.coin).toUpperCase();
  const asset = meta.universe.findIndex((m) => m.name.toUpperCase() === coin);
  const szi = state.assetPositions.find((p) => p.position.coin.toUpperCase() === coin)?.position.szi;
  const signed = decimal(szi);
  if (asset < 0 || asset >= 1e4 || signed === null || signed === 0n)
    throw new Error("No main-universe position to close");
  const held = signed < 0n ? -signed : signed;
  const asked = params.size == null ? held : decimal(params.size);
  if (asked === null || asked <= 0n)
    throw new Error("Invalid close size");
  const size = asked < held ? String(params.size) : String(szi).replace(/^-/, "");
  return { asset, isBuy: signed < 0n, size };
}
function verifyPerpsBuild(build, opts) {
  try {
    const network = opts.network ?? "mainnet";
    if (!EVM_ADDRESS_RE.test(opts.builder))
      return { ok: false, reason: "no valid Candle builder address to check against" };
    if (build.network !== undefined && build.network !== network) {
      return { ok: false, reason: `the build is for ${build.network}, this client trades ${network}` };
    }
    if (opts.address && build.address && build.address.toLowerCase() !== opts.address.toLowerCase()) {
      return { ok: false, reason: "the build is for a different wallet" };
    }
    if (!Number.isSafeInteger(build.nonce) || build.nonce <= 0)
      return { ok: false, reason: "invalid nonce" };
    const typed = build.typedData;
    if (!typed || typeof typed !== "object")
      return { ok: false, reason: "no typed data" };
    const action = build.action;
    if (!action || typeof action !== "object")
      return { ok: false, reason: "no action" };
    const intentRefusal = checkActionIntent(action, opts.intent);
    if (intentRefusal)
      return { ok: false, reason: intentRefusal };
    if (opts.closeOrder) {
      const order = action.orders[0];
      if (!order || order.a !== opts.closeOrder.asset || order.b !== opts.closeOrder.isBuy || decimal(order.s) !== decimal(opts.closeOrder.size) || order.r !== true)
        return { ok: false, reason: "close side, asset or size does not match the requested position" };
    }
    if (typed.primary_type === "Agent") {
      const type = action.type;
      if (typeof type !== "string" || !HYPERLIQUID_ALLOWED_ACTION_TYPES.includes(type)) {
        return { ok: false, reason: `action type ${String(type)} is not one Candle builds` };
      }
      if (type === "order") {
        const refusal = checkBuilderField(action, opts.builder);
        if (refusal)
          return { ok: false, reason: refusal };
      } else if ("builder" in action) {
        return { ok: false, reason: `a ${type} action carries no builder` };
      }
      if ("vaultAddress" in action)
        return { ok: false, reason: "the action names a vault" };
      const expected = hyperliquidL1TypedData(hyperliquidActionHash(action, build.nonce), network);
      if (!sameValue(typed, expected)) {
        return { ok: false, reason: "the typed data does not commit to this action and nonce" };
      }
      return { ok: true, kind: "l1" };
    }
    if (typed.primary_type === "HyperliquidTransaction:ApproveBuilderFee") {
      const expected = hyperliquidApproveBuilderFeeTypedData(opts.builder, build.nonce);
      if (!sameValue(typed, expected)) {
        return { ok: false, reason: "the builder approval is not Candle's builder at 0.1% on Mainnet" };
      }
      const expectedAction = {
        type: "approveBuilderFee",
        hyperliquidChain: "Mainnet",
        signatureChainId: HYPERLIQUID_SIGNATURE_CHAIN_ID,
        maxFeeRate: HYPERLIQUID_MAX_BUILDER_FEE_RATE,
        builder: opts.builder.toLowerCase(),
        nonce: build.nonce
      };
      if (!sameValue(action, expectedAction)) {
        return { ok: false, reason: "the approval action does not match its typed data" };
      }
      return { ok: true, kind: "approveBuilderFee" };
    }
    return { ok: false, reason: `primary type ${String(typed.primary_type)} is not one the relay signs` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unreadable build" };
  }
}
function hyperliquidSplitSignature(signature) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error("Not a 65-byte signature");
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27)
    v += 27;
  return { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v };
}
function hyperliquidExchangeBody(action, nonce, signature) {
  return { action, nonce, signature: hyperliquidSplitSignature(signature), vaultAddress: null, expiresAfter: null };
}
function hyperliquidRelayBody(typedData) {
  return { method: "eth_signTypedData_v4", params: { typed_data: typedData } };
}

// src/perps.ts
var decimal2 = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, "a plain decimal string");
var wallet = z.string().optional().describe("The EVM TEE wallet by id, address or label. Omit when the key has exactly one.");
var submit = z.boolean().optional().describe("false: build and check only, sign and submit nothing. Default true.");
var perpsShapes = {
  candle_perps_setup: { wallet, submit },
  candle_perps_open: {
    coin: z.string().describe("A market on Hyperliquid's main perp exchange, e.g. BTC"),
    side: z.enum(["long", "short"]),
    size: decimal2.describe('Size in the coin, decimal (e.g. "0.01")'),
    price: decimal2.optional().describe("Limit price. Omit for a market order (IOC within slippageBps of the mid)."),
    tif: z.enum(["Gtc", "Alo", "Ioc"]).optional().describe("With price: time in force (default Gtc)"),
    slippageBps: z.number().int().min(1).optional(),
    takeProfit: decimal2.optional().describe("Reduce-only take-profit trigger price"),
    stopLoss: decimal2.optional().describe("Reduce-only stop-loss trigger price"),
    wallet,
    submit
  },
  candle_perps_close: {
    coin: z.string(),
    size: decimal2.optional().describe("Part of the position to close; the whole position when omitted"),
    slippageBps: z.number().int().min(1).optional(),
    wallet,
    submit
  },
  candle_perps_cancel: {
    cloid: z.string().regex(/^0x[0-9a-fA-F]{32}$/).describe("The cloid of an order Candle built (an open, or one of its take-profit / stop-loss legs)"),
    wallet,
    submit
  },
  candle_perps_orders: { wallet, limit: z.number().int().min(1).max(200).optional() },
  candle_perps_positions: { wallet },
  candle_perps_leverage: {
    coin: z.string(),
    leverage: z.number().int().min(1),
    mode: z.enum(["cross", "isolated"]).optional(),
    wallet,
    submit
  }
};
var PATHS = {
  candle_perps_setup: "/api/v1/agent/perps/setup",
  candle_perps_open: "/api/v1/agent/perps/open",
  candle_perps_close: "/api/v1/agent/perps/close",
  candle_perps_cancel: "/api/v1/agent/perps/cancel",
  candle_perps_orders: "/api/v1/agent/perps/orders",
  candle_perps_positions: "/api/v1/agent/perps/positions",
  candle_perps_leverage: "/api/v1/agent/perps/leverage"
};
function fail(code, message, extra = {}) {
  return { text: JSON.stringify({ success: false, error: { code, message }, ...extra }), isError: true };
}

class Refusal extends Error {
  tool;
  constructor(tool) {
    super("refused");
    this.tool = tool;
  }
}
async function call(cfg, fetch2, method, path, body) {
  const res = await fetch2(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...cfg.apiKey ? { "x-api-key": cfg.apiKey } : {} },
    ...body !== undefined ? { body: JSON.stringify(body) } : {}
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    if (res.status === 404 && (typeof parsed !== "object" || parsed === null))
      throw new Refusal(fail("PERPS_NOT_ENABLED", "This Candle deployment does not serve perps routes."));
    throw new Refusal({ text: typeof parsed === "string" ? parsed : JSON.stringify(parsed), isError: true });
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Refusal(fail("INVALID_RESPONSE", "Not a JSON object"));
  return parsed;
}
async function walletFor(cfg, fetch2, name, scope) {
  const listed = await call(cfg, fetch2, "GET", "/api/v1/agent/wallets/trading");
  if (scope && !(Array.isArray(listed.scopes) && listed.scopes.includes(scope)))
    throw new Refusal(fail("SCOPE_MISSING", `The key needs ${scope}.`));
  const rows = Array.isArray(listed.page) ? listed.page : [];
  const evm = rows.filter((row) => row.chain === "evm");
  const matches = name === undefined ? evm : evm.filter((row) => row.id === name || row.label === name || row.address.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1)
    throw new Refusal(fail("TEE_WALLET_REQUIRED", evm.length === 0 ? "This key has no EVM TEE wallet bound to it." : `Name exactly one EVM TEE wallet: ${evm.map((row) => row.label ?? row.id).join(", ")}`));
  return { row: matches[0], appId: typeof listed.privyAppId === "string" ? listed.privyAppId : "" };
}
async function builderPin(cfg, fetch2, env) {
  const pinned = env.CANDLE_HYPERLIQUID_BUILDER?.trim() || CANDLE_HYPERLIQUID_BUILDER_ADDRESS;
  if (pinned)
    return pinned.toLowerCase();
  const config = await call(cfg, fetch2, "GET", "/api/v1/agent/perps/config");
  if (typeof config.builder !== "string")
    throw new Refusal(fail("PERPS_NOT_CONFIGURED", "The server reports no Hyperliquid builder address."));
  return config.builder.toLowerCase();
}
async function executePerps(tool, args, cfg, env, fetch2) {
  if (!cfg.apiKey)
    return fail("MCP_VALIDATION", "CANDLE_AGENT_API_KEY is required for this tool.");
  const network = env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet";
  const name = typeof args.wallet === "string" ? args.wallet : undefined;
  try {
    if (tool === "candle_perps_orders" || tool === "candle_perps_positions") {
      const { row: row2 } = await walletFor(cfg, fetch2, name);
      const query = new URLSearchParams({ walletId: row2.id });
      if (typeof args.limit === "number")
        query.set("limit", String(args.limit));
      return { text: JSON.stringify(await call(cfg, fetch2, "GET", `${PATHS[tool]}?${query}`)) };
    }
    const willSubmit = args.submit !== false;
    const pemFile = env.CANDLE_KEY_SIGNER_PEM_FILE?.trim();
    let signerPem = null;
    if (willSubmit) {
      if (!pemFile)
        return fail("SIGNER_UNAVAILABLE", "Set CANDLE_KEY_SIGNER_PEM_FILE to the key signer PEM (candle tee signer new --out <pem>) to sign perps actions.");
      try {
        signerPem = await readFile(pemFile, "utf8");
        createPrivateKey(signerPem);
      } catch {
        return fail("SIGNER_UNAVAILABLE", "CANDLE_KEY_SIGNER_PEM_FILE does not hold a readable private key PEM.");
      }
    }
    const { row, appId } = await walletFor(cfg, fetch2, name, "perps:write");
    const builder = await builderPin(cfg, fetch2, env);
    const { wallet: _w, submit: _s, ...fields } = args;
    const build = await call(cfg, fetch2, "POST", PATHS[tool], {
      walletId: row.id,
      ...fields,
      ...tool === "candle_perps_open" ? { type: fields.price === undefined ? "market" : "limit" } : {}
    });
    if (build.ready === true)
      return { text: JSON.stringify(build) };
    const method = PATHS[tool].split("/").at(-1);
    const check = verifyPerpsBuild(build, {
      builder,
      network,
      address: row.address,
      intent: { method, params: fields }
    });
    if (!check.ok)
      return fail("PERPS_BUILD_REFUSED", `Refused to sign this build: ${check.reason}. Nothing was signed.`);
    if (method === "close") {
      const closeOrder = await hyperliquidCloseOrder(fetch2, network, row.address, fields);
      const closeCheck = verifyPerpsBuild(build, {
        builder,
        network,
        address: row.address,
        intent: { method, params: fields },
        closeOrder
      });
      if (!closeCheck.ok)
        return fail("PERPS_BUILD_REFUSED", `Refused to sign this build: ${closeCheck.reason}. Nothing was signed.`);
    }
    if (!willSubmit || signerPem === null)
      return { text: JSON.stringify({ ...build, signed: false, submitted: false }) };
    if (!appId || !row.privyWalletId)
      return fail("SIGNER_UNAVAILABLE", "The server did not return its relay identifiers.");
    const body = hyperliquidRelayBody(build.typedData);
    const payload = hyperliquidCanonicalJson({
      body,
      headers: { "privy-app-id": appId },
      method: "POST",
      url: `https://api.privy.io/v1/wallets/${row.privyWalletId}/rpc`,
      version: 1
    });
    const authorizationSignature = sign("sha256", Buffer.from(payload), signerPem).toString("base64");
    const relay = await call(cfg, fetch2, "POST", `/api/v1/agent/wallets/${encodeURIComponent(row.id)}/sign`, {
      authorizationSignature,
      body
    });
    const signature = relay.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
      return fail("INVALID_RESPONSE", "The relay did not return a signature.");
    const exchangeBody = hyperliquidExchangeBody(build.action, build.nonce, signature);
    let exchange;
    try {
      const res = await fetch2(HYPERLIQUID_EXCHANGE_URLS[network], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exchangeBody)
      });
      const text = await res.text();
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      exchange = JSON.parse(text);
    } catch (error) {
      return fail("PERPS_SUBMIT_FAILED", `Signed, but the submit to Hyperliquid failed (${error instanceof Error ? error.message : "unknown"}). POST exchangeBody to Hyperliquid's /exchange to resubmit.`, { perpOrderId: build.perpOrderId, exchangeBody });
    }
    const accepted = typeof exchange === "object" && exchange !== null && exchange.status === "ok" && !(exchange.response?.data?.statuses ?? []).some((status) => typeof status === "object" && status !== null && ("error" in status));
    return {
      text: JSON.stringify({
        success: accepted,
        perpOrderId: build.perpOrderId,
        kind: build.kind,
        network: build.network,
        address: row.address,
        ...build.cloid ? { cloid: build.cloid } : {},
        ...build.childCloids ? { childCloids: build.childCloids } : {},
        nonce: build.nonce,
        signature,
        exchange
      }),
      ...accepted ? {} : { isError: true }
    };
  } catch (error) {
    if (error instanceof Refusal)
      return error.tool;
    return fail("MCP_TRANSPORT", error instanceof Error ? error.message : "The perps call failed.");
  }
}
var HYPERLIQUID_RELAY_CHAIN_ID = 1337;
var HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000";
var DEPOSIT_ASSETS = {
  SOL: { chain: "solana", decimals: 9 },
  USDC: { chain: "solana", decimals: 6 },
  ETH: { chain: "evm", decimals: 18 },
  USDG: { chain: "evm", decimals: 6 }
};
var perpsDepositShape = {
  asset: z.enum(["SOL", "USDC", "ETH", "USDG"]).describe("What to deposit. SOL or USDC pay from the key's Solana TEE wallet; ETH or USDG from its Hood one."),
  amount: decimal2.describe('Amount of the asset, decimal (e.g. "25")'),
  wallet: z.string().optional().describe("The paying TEE wallet by id, address or label. Omit when the key has exactly one on that chain."),
  perpsWallet: z.string().optional().describe("From Solana only: the EVM TEE wallet whose Hyperliquid account receives it. Omit when the key has one."),
  clientDepositId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional().describe("Idempotency id; the same id answers the deposit it already built. Default: a new one."),
  maxSlippageBps: z.number().int().min(1).max(1000).optional().describe("Relay slippage (default 100)"),
  submit
};
function rawUnits(amount, decimals) {
  const [whole = "", fraction = ""] = amount.split(".");
  if (fraction.length > decimals)
    return null;
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"));
  return raw > 0n ? raw.toString() : null;
}
function pickWallet(rows, chain, name, what) {
  const onChain = rows.filter((row) => row.chain === chain);
  const matches = name === undefined ? onChain : onChain.filter((row) => row.id === name || row.label === name || row.address.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1)
    throw new Refusal(fail("TEE_WALLET_REQUIRED", onChain.length === 0 ? `This key has no ${what} bound to it.` : `Name exactly one ${what}: ${onChain.map((row) => row.label ?? row.id).join(", ")}`));
  return matches[0];
}
function depositProblem(build, expect) {
  const destination = build.destination ?? {};
  const fee = build.fee ?? {};
  const same = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (build.walletId !== expect.walletId)
    return "the build names another paying wallet";
  if (build.asset !== expect.asset || build.amountRaw !== expect.amountRaw)
    return "the build is for another amount";
  if (destination.chainId !== HYPERLIQUID_RELAY_CHAIN_ID)
    return "the build does not land on Hyperliquid";
  if (destination.currency !== HYPERLIQUID_RELAY_USDC)
    return "the build does not deliver Hyperliquid USDC";
  if (!same(destination.address, expect.account))
    return "the build lands on another account";
  if (fee.bps !== 0 || fee.feeRaw !== "0")
    return "the build carries a Candle fee";
  if (expect.hood !== (build.chain === "hood"))
    return "the build pays from the wrong chain";
  if (!expect.hood && !(Array.isArray(build.transactionsBase64) && build.transactionsBase64.length === 1))
    return "the build is not one Solana deposit";
  return null;
}
async function executePerpsDeposit(args, cfg, env, fetch2) {
  if (!cfg.apiKey)
    return fail("MCP_VALIDATION", "CANDLE_AGENT_API_KEY is required for this tool.");
  const asset = args.asset;
  const spec = DEPOSIT_ASSETS[asset];
  if (!spec)
    return fail("MCP_VALIDATION", "asset must be SOL, USDC, ETH or USDG.");
  const amountRaw = typeof args.amount === "string" ? rawUnits(args.amount, spec.decimals) : null;
  if (!amountRaw)
    return fail("MCP_VALIDATION", `amount must be a positive ${asset} amount with at most ${spec.decimals} decimals.`);
  const hood = spec.chain === "evm";
  const clientDepositId = typeof args.clientDepositId === "string" ? args.clientDepositId : `deposit-${crypto.randomUUID()}`;
  const willSubmit = args.submit !== false;
  let signerPem = null;
  if (willSubmit) {
    const pemFile = env.CANDLE_KEY_SIGNER_PEM_FILE?.trim();
    if (!pemFile)
      return fail("SIGNER_UNAVAILABLE", "Set CANDLE_KEY_SIGNER_PEM_FILE to the key signer PEM (candle tee signer new --out <pem>) to sign a deposit.");
    try {
      signerPem = await readFile(pemFile, "utf8");
      createPrivateKey(signerPem);
    } catch {
      return fail("SIGNER_UNAVAILABLE", "CANDLE_KEY_SIGNER_PEM_FILE does not hold a readable private key PEM.");
    }
  }
  try {
    const listed = await call(cfg, fetch2, "GET", "/api/v1/agent/wallets/trading");
    if (!(Array.isArray(listed.scopes) && listed.scopes.includes("swap:write")))
      throw new Refusal(fail("SCOPE_MISSING", "A deposit needs swap:write on the key."));
    const rows = Array.isArray(listed.page) ? listed.page : [];
    const appId = typeof listed.privyAppId === "string" ? listed.privyAppId : "";
    const name = typeof args.wallet === "string" ? args.wallet : undefined;
    const source = pickWallet(rows, spec.chain, name, `${hood ? "Hood" : "Solana"} TEE wallet`);
    if (hood && args.perpsWallet !== undefined)
      return fail("MCP_VALIDATION", "From a Hood TEE wallet the deposit lands on that wallet's own account; omit perpsWallet.");
    const account = hood ? source : pickWallet(rows, "evm", typeof args.perpsWallet === "string" ? args.perpsWallet : undefined, "EVM TEE wallet");
    const build = await call(cfg, fetch2, "POST", "/api/v1/agent/perps/deposit", {
      clientDepositId,
      walletId: source.id,
      asset,
      amountRaw,
      ...typeof args.maxSlippageBps === "number" ? { maxSlippageBps: args.maxSlippageBps } : {},
      ...hood ? {} : { perpsWalletId: account.id }
    });
    if (build.job !== undefined)
      return { text: JSON.stringify(build) };
    const problem = depositProblem(build, { walletId: source.id, asset, amountRaw, account: account.address, hood });
    if (problem)
      return fail("PERPS_BUILD_REFUSED", `Refused to sign this deposit: ${problem}. Nothing was signed.`);
    if (!willSubmit || signerPem === null)
      return { text: JSON.stringify({ ...build, signed: false, submitted: false }) };
    if (!appId || !source.privyWalletId)
      return fail("SIGNER_UNAVAILABLE", "The server did not return its relay identifiers.");
    const pem = signerPem;
    const relaySign = async (body2) => {
      const payload = hyperliquidCanonicalJson({
        body: body2,
        headers: { "privy-app-id": appId },
        method: "POST",
        url: `https://api.privy.io/v1/wallets/${source.privyWalletId}/rpc`,
        version: 1
      });
      const authorizationSignature = sign("sha256", Buffer.from(payload), pem).toString("base64");
      const relay = await call(cfg, fetch2, "POST", `/api/v1/agent/wallets/${encodeURIComponent(source.id)}/sign`, {
        authorizationSignature,
        body: body2
      });
      if (typeof relay.signedTransaction !== "string")
        throw new Refusal(fail("INVALID_RESPONSE", "The relay did not return a signed transaction."));
      return relay.signedTransaction;
    };
    const ids = { clientDepositId, depositId: build.depositId };
    const submitPath = "/api/v1/agent/perps/deposit/submit";
    if (!hood) {
      const transaction = build.transactionsBase64[0];
      const signed = await relaySign({ method: "signTransaction", params: { encoding: "base64", transaction } });
      return {
        text: JSON.stringify(await call(cfg, fetch2, "POST", submitPath, { ...ids, signedTransactionsBase64: [signed] }))
      };
    }
    const allowed = asset === "USDG" ? ["approval", "bridgeDeposit"] : ["bridgeDeposit"];
    const planned = build.plannedLegCount;
    const hex = (value) => `0x${BigInt(String(value)).toString(16)}`;
    const signedKinds = new Set;
    let body = build;
    while (body.mode === "sequenced") {
      const leg = body.nextLeg;
      const kind = String(body.legKind);
      if (!leg || body.operationId !== build.operationId || body.plannedLegCount !== planned || typeof planned !== "number" || planned > allowed.length || !allowed.includes(kind) || signedKinds.has(kind) || leg.chainId !== 4663)
        return fail("PERPS_BUILD_REFUSED", `Refused to sign deposit leg ${kind}: it is not the plan this deposit was built with.`, { clientDepositId, operationId: build.operationId });
      signedKinds.add(kind);
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
            value: hex(leg.value)
          }
        }
      });
      body = await call(cfg, fetch2, "POST", submitPath, {
        ...ids,
        operationId: build.operationId,
        signedTransaction: signed
      });
    }
    return { text: JSON.stringify({ ...body, clientDepositId }) };
  } catch (error) {
    if (error instanceof Refusal)
      return error.tool;
    return fail("MCP_TRANSPORT", error instanceof Error ? error.message : "The deposit call failed.");
  }
}

// src/plans.ts
var PLAN_CAPABILITY_NOTE = "A capability marked yes is what the plan allows. It is subject to the deployment's own switches (perps and own-wallet bridges each have one) and to the wallet, scopes and setup the feature needs. Every plan can launch a token from its embedded wallet, with an optional dev buy (same transaction on Solana; best-effort follow-up on Hood), through the headless launch; the two launch rows are additional routes, not the only ones.";
var PLAN_CAPABILITY_LABELS = {
  tradeCandleTokens: "Trade Candle-launched tokens",
  tradeBaseAssets: "Trade base assets",
  freeBaseTransfers: "Base-pair swaps and own-wallet bridges (when enabled), no Candle fee",
  sellExternalTokens: "Sell tokens not launched on Candle",
  buyExternalTokens: "Buy tokens not launched on Candle",
  hyperliquidPerps: "Hyperliquid perps (when enabled)",
  selfLaunch: "Launch from a linked or TEE wallet (self-signed)",
  atomicLaunch: "Atomic launch: launch + 1–4 first buys in one bundle",
  createLinkedWallets: "Create linked wallets",
  importLinkedWallets: "Import linked wallets",
  limitOrders: "Limit orders",
  quant: "Quant on Telegram"
};
var PLAN_LABELS = { free: "Free", believer: "Believer", pro: "Pro", max: "Max" };
function planLabel(plan) {
  return Object.hasOwn(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : plan;
}
function formatPlanBps(bps) {
  return bps === 0 ? "none" : `${Number((bps / 100).toFixed(4))}%`;
}
function count(n) {
  return n.toLocaleString("en-US");
}
function priceCell(entry) {
  if (entry.price)
    return `$${count(entry.price.pricePerMonthUsd)} a month`;
  return entry.plan === "free" ? "free" : "not sold";
}
function planTableRows(table) {
  const plans = table.plans;
  const row = (label, cell) => [label, ...plans.map(cell)];
  const rows = [
    row("Price", priceCell),
    row("Agent trade fee", (e) => formatPlanBps(e.feeBps)),
    row("Perps builder fee", (e) => formatPlanBps(e.perpFeeBps)),
    row("Requests per minute", (e) => count(e.limits.rateLimitPerMin)),
    row("Launches per day", (e) => count(e.limits.dailyLaunchCap)),
    row("Uploads per minute", (e) => count(e.limits.uploadsPerMin)),
    row("Linked wallets", (e) => count(e.limits.linkedWallets))
  ];
  const known = Object.keys(PLAN_CAPABILITY_LABELS);
  const served = new Set;
  for (const entry of plans)
    for (const key of Object.keys(entry.capabilities ?? {}))
      served.add(key);
  const keys = [
    ...known.filter((k) => served.has(k)),
    ...[...served].filter((k) => !Object.hasOwn(PLAN_CAPABILITY_LABELS, k))
  ];
  for (const key of keys) {
    const label = Object.hasOwn(PLAN_CAPABILITY_LABELS, key) ? PLAN_CAPABILITY_LABELS[key] : key;
    rows.push(row(label, (e) => {
      const value = e.capabilities?.[key];
      return value === true ? "yes" : value === false ? "no" : "-";
    }));
  }
  return { headers: ["", ...plans.map((e) => planLabel(e.plan))], rows };
}
function planPromotionLine(table) {
  if (!(table.promoMaxDays > 0))
    return null;
  const days = table.promoMaxDays === 1 ? "1 day" : `${table.promoMaxDays} days`;
  return `A first Pro purchase includes Max for its first ${days}, then continues on Pro.`;
}
function planTableMarkdown(table) {
  const { headers: headers2, rows } = planTableRows(table);
  const line = (cells) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(headers2), line(headers2.map(() => "---")), ...rows.map(line)].join(`
`);
}

// src/tools.ts
var TOOL_NAMES = [
  "candle_launch_token",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_report_activity",
  "candle_get_agent_profile",
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
  "candle_perps_setup",
  "candle_perps_open",
  "candle_perps_close",
  "candle_perps_cancel",
  "candle_perps_orders",
  "candle_perps_positions",
  "candle_perps_leverage",
  "candle_perps_deposit"
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
      const { bucket, chain, where, sort, fields, limit } = args;
      const query = new URLSearchParams({
        bucket,
        ...chain ? { chain } : {},
        ...where ? { where } : {},
        ...sort ? { sort } : {},
        ...fields ? { fields } : {},
        ...limit ? { limit } : {}
      });
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
    case "candle_get_plans": {
      return { url: `${base2}/api/v1/agent/plans`, init: { method: "GET", headers: jsonHeaders() } };
    }
    case "candle_swap": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/swap`,
        init: { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(swapBody(args)) }
      };
    }
    case "candle_get_operation": {
      const apiKey = requireApiKey2(cfg);
      const { clientId, kind } = args;
      const path = kind === "launch" ? `/api/v1/launch/headless/jobs/${encodeURIComponent(clientId)}` : `/api/v1/trade/agent/jobs/${encodeURIComponent(clientId)}`;
      return { url: `${base2}${path}`, init: { method: "GET", headers: jsonHeaders(apiKey) } };
    }
    case "candle_get_wallets": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/wallets/embedded`,
        init: { method: "GET", headers: jsonHeaders(apiKey) }
      };
    }
    case "candle_get_profile_wallets": {
      const apiKey = requireApiKey2(cfg);
      const { keyPrefix } = args;
      return {
        url: `${base2}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`,
        init: { method: "GET", headers: jsonHeaders(apiKey) }
      };
    }
    case "candle_set_profile_wallets": {
      const apiKey = requireApiKey2(cfg);
      const { keyPrefix, walletIds } = args;
      return {
        url: `${base2}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`,
        init: { method: "PUT", headers: jsonHeaders(apiKey), body: JSON.stringify({ walletIds }) }
      };
    }
    case "candle_get_profile_pnl": {
      const apiKey = requireApiKey2(cfg);
      const { keyPrefix } = args;
      return {
        url: `${base2}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/pnl`,
        init: { method: "GET", headers: jsonHeaders(apiKey) }
      };
    }
    case "candle_get_portfolio": {
      const apiKey = requireApiKey2(cfg);
      return {
        url: `${base2}/api/v1/agent/portfolio`,
        init: { method: "GET", headers: jsonHeaders(apiKey) }
      };
    }
    case "candle_get_profile_trades": {
      const apiKey = requireApiKey2(cfg);
      const { keyPrefix, limit } = args;
      const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
      return {
        url: `${base2}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/trades${query}`,
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
function plansMarkdown(body) {
  try {
    const table = JSON.parse(body);
    if (!Array.isArray(table.plans))
      return "";
    const promotion = planPromotionLine(table);
    const markdown = `${planTableMarkdown(table)}

${PLAN_CAPABILITY_NOTE}`;
    return promotion ? `${markdown}

${promotion}` : markdown;
  } catch {
    return "";
  }
}
async function callAndRelay(name, args, cfg) {
  const { url, init } = buildRequest(name, args, cfg);
  const res = await fetch(url, init);
  noteVersionHeaders(res);
  const text = await res.text();
  return {
    content: [{ type: "text", text }],
    ...res.ok ? {} : { isError: true }
  };
}
var launchTokenShape = {
  clientLaunchId: z2.string().describe("Caller-chosen idempotency key, unique per account"),
  name: z2.string().describe("Token name"),
  symbol: z2.string().describe("Token symbol"),
  imageUrl: z2.string().describe("https URL to the token image. Must be roughly SQUARE (aspect ratio at most 1.5:1): it " + "renders as a small circle/square avatar everywhere. Share cards, OG images and banners " + "are rejected with IMAGE_WRONG_SHAPE -- pass those as bannerUrl instead"),
  bannerUrl: z2.string().optional().describe("Optional https URL to WIDE artwork for the token page's banner strip (wider than 1.5:1, " + "e.g. 1200x630). This is where a share card or OG image belongs. A square image here is " + "rejected with BANNER_WRONG_SHAPE. Omit it and the strip falls back to imageUrl"),
  chain: z2.string().optional().describe('"solana" or "hood"; defaults to solana'),
  quoteAsset: z2.string().optional().describe("Quote asset symbol; defaults per chain"),
  mode: z2.string().optional().describe('"open" or "exclusive"; defaults to open. "test-open" / "test-exclusive" launch the ' + "low-threshold test curves (~1/80 economics) where the API has ENABLE_TEST_CURVES on"),
  stakerAllocationBps: z2.number().optional().describe("Staker allocation in basis points"),
  dexVersion: z2.string().nullable().optional().describe('"v3" or "v4"; required for hood launches'),
  buyAmount: z2.union([z2.string(), z2.number()]).optional().describe("Initial buy, in quote base units (string or number)"),
  description: z2.string().optional(),
  socials: z2.record(z2.string()).optional().describe("Social links keyed by platform"),
  visibility: z2.string().optional().describe('"production", "test", "local", or "hidden"'),
  dryRun: z2.boolean().optional().describe("Validate without executing the launch")
};
var getMarketShape = {
  chain: z2.string().describe('"solana" or "hood"'),
  mint: z2.string().describe("Token mint (solana) or contract address (hood)")
};
var tokenForensicsShape = {
  chain: z2.string().describe('"solana" or "hood"'),
  mint: z2.string().describe("Token mint (solana) or contract address (hood)")
};
var getFeedShape = {
  bucket: z2.enum(["new", "graduated", "onfire", "bluechip"]),
  chain: z2.string().optional().describe("Optional chain filter"),
  where: z2.string().optional().describe('JSON filter, e.g. {"marketCap":{"lt":150000},"liquidityUsd":{"gte":25000},"mintAuthorityDisabled":{"eq":true}}. ' + "Comparators: eq, ne, lt, lte, gt, gte, present. An ABSENT field satisfies none of them except " + "present:false, so a filter for mintAuthorityDisabled eq true returns only tokens that actually say " + "true, never ones where the flag is simply missing. Use present:false to find the tokens with no data."),
  sort: z2.string().optional().describe('Sort as "field" or "field:asc" / "field:desc". A bare field means desc.'),
  fields: z2.string().optional().describe("Comma-separated fields to return, e.g. symbol,marketCap,liquidityUsd. chain, address and symbol always " + "ride along. Cuts a 135KB response to a couple of KB."),
  limit: z2.string().optional().describe("Max rows to return, 1-200.")
};
var reportActivityShape = {
  chain: z2.string().describe('"solana" or "hood"'),
  signature: z2.string().describe("Transaction signature/hash to verify and record")
};
var getAgentProfileShape = {
  idOrWallet: z2.string().describe("Candle username or wallet address")
};
var getOperationShape = {
  clientId: z2.string().describe("The clientTradeId or clientLaunchId the write used, or that the tool echoed back to you"),
  kind: z2.enum(["trade", "launch"]).describe("Which rail the id belongs to. Required: ids are caller-chosen strings with no shape to dispatch on")
};
var resolveTokenShape = {
  mint: z2.string().describe("Token mint (Solana, base58) or contract address (Hood, 0x-prefixed)")
};
var profileWalletsShape = {
  keyPrefix: z2.string().describe("The profile's API key prefix, as listed by candle keys list or in the dashboard")
};
var profilePnlShape = {
  keyPrefix: z2.string().describe("The profile's API key prefix")
};
var profileTradesShape = {
  keyPrefix: z2.string().describe("The profile's API key prefix"),
  limit: z2.number().optional().describe("How many of the most recent trades to return. Default 200, max 1000.")
};
var setProfileWalletsShape = {
  keyPrefix: z2.string().describe("The profile's API key prefix"),
  walletIds: z2.array(z2.string()).describe("The linked-wallet ids the profile may spend from -- ids, not addresses. This REPLACES the " + "whole set: any wallet omitted loses access. An empty array assigns none.")
};
var swapShape = {
  from: z2.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to spend"),
  to: z2.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).describe("Base asset to receive; must differ from `from`"),
  amount: z2.string().optional().describe('Decimal amount of `from` to spend, e.g. "0.5". Preferred. Pass exactly one of amount or amountRaw.'),
  amountRaw: z2.string().optional().describe("Raw base units of `from`, as a positive integer string. Kept for callers that already " + "compute raw units; new callers should use `amount`."),
  maxSlippageBps: z2.number().optional().describe("Slippage bound in bps, 0-10000. Server defaults to 100 (1%)"),
  clientSwapId: z2.string().optional().describe("Durable idempotency key. Same id + same from/to/amountRaw/effective slippage (omitted means " + "100 bps) replays the stored result, including an indeterminate SWAP_FAILED with the " + "signature in the message. A different body is rejected. Omit it and nothing is coalesced. " + "Pass one so a timeout retry returns that stored result.")
};
var tradeShape = {
  mint: z2.string().describe("Token mint (solana) or contract address (hood)"),
  side: z2.enum(["buy", "sell"]),
  amount: z2.string().optional().describe("Decimal amount. Buys: how much of THIS TOKEN'S OWN quote asset to spend (SOL for a " + 'SOL-launched token, USDC for a USDC-quoted one, and so on: e.g. "0.5"). Sells: how many ' + "TOKENS to sell. Pass exactly one of amount or percent."),
  percent: z2.number().optional().describe("Sells only: sell this percent (integer 1-100) of the holding. Live trades size against the " + "embedded wallet. Paper trades (`paper: true`) size against this key's paper inventory -- " + "the position a previous paper buy credited -- because paper never moves the live wallet."),
  quoteAsset: z2.string().optional().describe('What the wallet spends on a buy or receives on a sell: "sol", "usdc" or "cndl" on Solana, ' + '"eth" or "usdg" on Hood. Echoing the `quoteAsset` a quote (POST /api/v1/trade/agent/quote) returned is safe. On Solana it applies only ' + "to an arbitrary mint Candle never launched (a buy needs Pro or Max; a sell works on any plan) and is ignored for a Candle token, " + "whose quote comes from the token itself. On Hood it is the settlement asset of a DEX " + "trade; a USDG buy adds an approval transaction an ETH buy does not. It is not the route: " + "the cheapest path to the asset is chosen separately. Defaults to sol / ETH settlement."),
  maxSlippageBps: z2.number().optional().describe("Max slippage in basis points; API default applies when omitted"),
  clientTradeId: z2.string().optional().describe("Idempotency key. Auto-generated when omitted and echoed in the result. Retrying with the " + "SAME id is safe (idempotent replay); a new id is a SECOND trade."),
  paper: z2.preprocess((value) => value === "true" || value === 1 || value === "1" ? true : value === "false" || value === 0 || value === "0" ? false : value, z2.boolean().optional().describe("Rehearse instead of trading. The request passes every admission rule a live trade passes " + "-- the same planner, spend gate, key cap and loss limits -- and records the quote, but " + "nothing is ever broadcast and no funds move. Use it to check that a strategy is admitted " + "before risking anything on it. A paper fill is optimistic by construction: it books the " + "quoted price, so the gap between a paper arm and a live one IS the execution cost. " + "A sell of a mint this key already paper-bought also closes that paper book when the " + "live wallet is empty, even if this flag is omitted."))
};
var { buyAmount: _rawBuyAmount, ...seedableLaunchShape } = launchTokenShape;
var launchAndSeedShape = {
  ...seedableLaunchShape,
  clientLaunchId: z2.string().optional().describe("Idempotency key. Auto-generated when omitted and echoed in the result."),
  devBuy: z2.string().optional().describe('Seed buy in DECIMAL units of the quote asset this launch selects (e.g. "0.25" SOL, or ' + "ETH on hood), bundled into the launch transaction itself on solana and sent as a follow-up " + "transaction on hood. Paid from the account's embedded wallet. Follows quoteAsset, which " + "defaults to sol on solana and eth on hood. Capped by the platform dev-buy ceiling; for " + "a larger seed, launch then follow with candle_trade.")
};
var transferShape = {
  chain: z2.enum(["solana", "hood"]).describe("Which chain the transfer executes on"),
  asset: z2.enum(["SOL", "USDC", "CNDL", "ETH", "USDG"]).optional().describe("A base asset key. Pass exactly one of asset or mint."),
  mint: z2.string().optional().describe("An arbitrary token: SPL mint (Solana) or ERC-20 contract (Hood). Own-wallet destinations only; withdrawals to approved addresses are base-assets-only."),
  amountRaw: z2.string().describe('RAW base units as a decimal string (lamports, wei, token raw units), or "max" to sweep the spendable balance. NOT a human decimal: 1 SOL is "1000000000".'),
  to: z2.string().describe("Destination address. Must be one of the account's own wallets, or an address the OWNER pre-approved as a withdrawal address in the Candle console -- anything else is refused before signing."),
  clientTransferId: z2.string().optional().describe("Caller-chosen idempotency key for safe retries")
};
var sweepShape = {
  chain: z2.enum(["solana", "hood"]).describe("Which chain to sweep"),
  to: z2.string().describe("Destination address, same rules as candle_transfer's `to`"),
  mints: z2.array(z2.string()).optional().describe("Extra token mints/contracts to sweep besides the chain's base assets (own-wallet destinations only).")
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
    description: "Launch a new token via the Candle headless launch API, from the account's embedded wallet. Works on every plan, Free included. Set dryRun: true to validate without spending anything.",
    inputSchema: launchTokenShape
  }, async (args) => callAndRelay("candle_launch_token", args, cfg));
  register("candle_get_market", {
    title: "Get market state",
    description: "Read Candle and indexed external markets, including indexed-but-not-routable tokens. No key needed. " + "Read candleLaunched, launchpad, venue and trade.routable; jupiterOk and discovery flags are distinct. " + "Routability is stored eligibility, not a quote or permission. General quotes use POST /api/v1/trade/agent/quote. " + "Curve quotes and lifecycle describe Candle launches. MARKET_NOT_FOUND is a legacy code: read " + "error.routing.reason, error.discovery and sibling error.retryable. A curve-only 404 does not mean untradeable.",
    inputSchema: getMarketShape
  }, async (args) => callAndRelay("candle_get_market", args, cfg));
  register("candle_token_forensics", {
    title: "Token forensics",
    description: `Gate a buy before making it: who launched it (resolved on-chain; pump.fun's shared updateAuthority is never the developer; when no developer is on chain, deployer.attribution names the launchpad or issuer instead, e.g. launched via stonk.fun or issued by xStocks), their went-to-zero rate and last coins, who bought in the deploy window (the creator's own wallets are marked disclosed; strangers in the same slot are the bundle signal), same-funder insider share, same-funder deployer cluster, and safety.summary with six sourced flags (mintAuthority, freezeAuthority, tokenExtensions, lpLock, sellability, liquidityDrain). Refuse an unprompted buy when flagged; incomplete or unknown is not clearance. launch.deployerLaunches is an inclusive informational count, never a warning. Every measurement carries a coverage note -- 'unavailable' is not 'clean'. No key needed.

MARKET_NOT_FOUND means Candle has no market for that token and this could not run. That is also not 'clean': report that you could not check it, rather than reporting the token as safe. That refusal now carries error.coverage -- covered:false, a reason ('external_launchpad' when the token launched somewhere else, 'unknown_mint' when nobody has indexed it), the launchpad when known, and every check that consequently did not run. Read it instead of guessing. Most of the feed, and any Solana mint Jupiter's index knows, now answers with a partial report instead. On Hood, a token Candle did not launch names its launch account (deployer.method cvc_launch_account) for pons.family and pools.trade launches, with no record of earlier coins; other Hood launchpads return no developer.`,
    inputSchema: tokenForensicsShape
  }, async (args) => callAndRelay("candle_token_forensics", args, cfg));
  register("candle_get_feed", {
    title: "Get a token feed",
    description: "Read one of the trade page's public feeds: new, graduated, onfire, or bluechip. Reads " + `only; moves nothing. No key needed. Start here when nobody has named a token.

` + "This indexes the WIDER market, not just Candle's own launches. Rows carry launchpad and " + "discovery flags (jupiterOk, externalTradeable, paperDiscoveryOk, organic0LiveOk). " + "candle_get_market resolves Jupiter-indexed rows; do not hard-skip organicScore=0 on live " + "when organic0LiveOk is true. liquidityDrawdownBps is a signal only — nothing here blocks " + `resolve or trade on drain; filter with where if you want to avoid draining pools.

` + "Filter, sort and pick fields SERVER-SIDE rather than reading the whole feed: an " + "unfiltered response is around 135KB and will not fit in a tool result. See `where`, " + "`sort` and `fields`.\n\n" + "One rule to know before screening on safety: a missing field is NOT a false one. " + "mintAuthorityDisabled and freezeAuthorityDisabled are absent on a real share of rows, " + "and absent means nobody checked, not that the authority is disabled. `where` never lets " + 'an absent field satisfy a comparison, so {"mintAuthorityDisabled":{"eq":true}} returns ' + "only tokens that actually say so.",
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
  register("candle_get_plans", {
    title: "Plans: prices, fees, limits and what each can do",
    description: "The plan table this Candle deployment serves (GET /api/v1/agent/plans). No key needed. Reads only. For " + "each plan: price (null when not sold), feeBps (the agent fee charged on top of every trade or dev buy the " + "API builds), perpFeeBps (the Hyperliquid builder fee), limits for a new key (requests per minute, launches " + "per day, uploads per minute, linked wallets) and capabilities: buyExternalTokens, sellExternalTokens, " + "tradeBaseAssets, tradeCandleTokens, selfLaunch, atomicLaunch, createLinkedWallets, importLinkedWallets, " + "hyperliquidPerps, limitOrders, quant, freeBaseTransfers. promoMaxDays is the days of Max a first Pro " + "purchase includes (0: no promotion). Quote prices and fees from here, never from memory: they differ by " + "deployment and change at the three-plan launch (Free, Pro, Max). The account's own plan and fee are in " + "candle_execution_status's tier. A TIER_REQUIRED refusal names a capability this table shows the account's " + "plan lacks. A capability true here is plan eligibility, not deployment availability: perps and own-wallet bridges " + "are each behind a deployment switch and need their wallet, scopes and setup. Returns the server's JSON, then the same table as Markdown.",
    inputSchema: {}
  }, async () => {
    const { url, init } = buildRequest("candle_get_plans", {}, cfg);
    const res = await fetch(url, init);
    noteVersionHeaders(res);
    const text = await res.text();
    if (!res.ok)
      return { content: [{ type: "text", text }], isError: true };
    return {
      content: [
        { type: "text", text },
        { type: "text", text: plansMarkdown(text) }
      ]
    };
  });
  register("candle_get_operation", {
    title: "What happened to a write",
    description: "Look up a trade or launch by the id its write used, and find out whether it landed. " + `Reads only; moves nothing.

` + "Call this after a timeout, after a restart, or any time you hold an id and do not know " + `the outcome. Do NOT re-send the write to find out.

` + `Four answers, four different next moves:
` + "- `confirmed`/`failed`: it is over. `signature` proves the first, `errorCode` explains " + `the second.
` + "- `built`/`submitted`: still in flight. Wait and ask again.\n" + "- 404 (`JOB_NOT_FOUND`): Candle never saw this id, so the write never reached the rail " + "and nothing moved. The original request is safe to send again exactly as it was. This " + `is a definite answer, not a failure to retry.

` + "Amounts come back RAW, deliberately: the answer you need after a timeout is the outcome, " + "and you already know what you asked for.",
    inputSchema: getOperationShape
  }, async (args) => callAndRelay("candle_get_operation", args, cfg));
  register("candle_get_wallets", {
    title: "List the wallets Candle executes with",
    description: "The account's EMBEDDED wallets, one per chain, with their delegation state. These are " + "the wallets candle_trade, candle_swap and candle_transfer spend from, so this is how an " + "agent finds its own funding addresses. Reads only; moves nothing. Not the same as the " + "account's LINKED wallets, which are the owner's own wallets and are not spent from here. " + "Balances are not included: read a specific one with the market and balance endpoints.",
    inputSchema: {}
  }, async () => callAndRelay("candle_get_wallets", {}, cfg));
  register("candle_get_profile_wallets", {
    title: "Read which wallets an agent profile can spend from",
    description: "An agent profile (API key) either spends from EVERY wallet on its account or only from " + "the ones assigned to it. Read walletScope before drawing any conclusion from the list: " + "an empty list means 'every wallet' under scope 'all' and 'none at all' under 'selected'. " + "Reads only; moves nothing.",
    inputSchema: profileWalletsShape
  }, async (args) => callAndRelay("candle_get_profile_wallets", args, cfg));
  register("candle_set_profile_wallets", {
    title: "Set which wallets an agent profile can spend from",
    description: "REPLACES the profile's whole wallet set with the ids given, so a wallet left out of the " + "list loses access; pass an empty list to leave the profile with no wallets. NARROWING " + "ONLY: an API key can remove wallets from its OWN profile, but naming one it does not " + "already hold is a grant and needs a human in the dashboard, as does editing any other " + "profile. Takes effect only while the profile's scope is 'selected'. Wallet ids are the " + "linked-wallet ids, not addresses.",
    inputSchema: setProfileWalletsShape
  }, async (args) => callAndRelay("candle_set_profile_wallets", args, cfg));
  register("candle_get_profile_pnl", {
    title: "Read an agent profile's P&L",
    description: "This profile's share of the account's P&L: realized profit on the sales it made, the Candle fees " + "charged against it, and the positions that belong to it (the wallet's bound key, else the key " + "whose buy opened them) with their cost basis, each MARKED at Candle's current price where one " + "exists: `markPriceUsd`, `marketValueUsd` and `unrealizedUsd` per position, and `unrealizedUsd` " + "overall. A position with no price is counted in `unmarkedPositions` and left out of unrealized, " + "never valued at zero; `oldestMarkAt` says how old the marks are. Deposits and withdrawals are " + "excluded: funding a wallet is not profit. Check `unvalued` and `truncated` before quoting the " + "number; they mean the total is partial. The figures come from the account's one P&L read, the " + "same as the console's, to the cent: `pnl.totalUsd` (realized net plus unrealized) is the " + "console's P&L. Positions live in wallets: each wallet is its own average-cost pool, the total " + "is the sum of `pnl.byWallet` (one row per wallet, main or linked, with the linked wallet's " + "label; `unknown:solana` or `unknown:hood` is the row for fills no record places in a wallet), " + "and one token held in two wallets is two positions, each with its `wallet`. A recorded move " + "between the account's wallets carries its cost and realizes nothing. Moved-in positions and " + "`closedPositions` carry additive `transferredIn`, `basisSource` and `basisComplete`; " + "`basisSource` says whether cost comes from Candle history, on-chain trades or the arrival price. " + "Public totals keep `realizedFromTransfersUsd` and `unrealizedFromTransfersUsd` beside ranked " + "own-trade P&L; moved-in P&L does not change rank. Each position carries " + "`agent` (the key it belongs to) and `dust` when it is worth under one cent; dust stays listed " + "and counted, and `openPositionsExDust` leaves it out. `closed` gives the closed positions as " + "`madeUsd` + `lostUsd` + `partialSellsUsd` = `realizedNetUsd`, with `wins` and `losses`. " + "`lookback` and `truncated` are the account's activity bound, and `tradesConsidered` counts this " + "key's ledger fills. Since 2026-10-02 the total is the sum of wallets rather than one pool across " + "them, so realized figures can differ from earlier reads; a server that predates it omits " + "`totalUsd`, `closed`, `openPositionsExDust`, `wallet`, `agent` and `dust`. " + "Every open position and every `byWallet` row (and its positions) carries `chain` ('solana' or " + "'hood'), and `pnl.byChain` has the total's figures over each chain's fills alone, both chains " + "always present, with `openPositions` there a count (the positions are in `pnl.openPositions`, by " + "`chain`). The two chains sum to the total. A " + "server that predates per-chain P&L omits `chain` and `byChain`. While Hyperliquid is enabled, " + "`hyperliquid` separately reports main-perp realized gross, signed funding, fees (inclusive of builder fees), " + "and net = gross + funding - fees, for currently bound EVM TEE wallets since the current TEE binding. " + "Check `read` and `truncated`; historical bindings and unrealized perps are excluded. Reads only.",
    inputSchema: profilePnlShape
  }, async (args) => callAndRelay("candle_get_profile_pnl", args, cfg));
  register("candle_get_profile_trades", {
    title: "Read an agent profile's trade history",
    description: "Orders, actual fills, fees, timestamps and transaction hashes for this profile. Includes FAILED " + "trades, with an errorCode saying why each did not go through, so this answers 'what happened to " + "my order' as well as 'what did I trade'. Reads only; moves nothing.",
    inputSchema: profileTradesShape
  }, async (args) => callAndRelay("candle_get_profile_trades", args, cfg));
  register("candle_get_portfolio", {
    title: "Read what the account holds, on Solana and Hood",
    description: "Balances and prices for the wallets Candle already knows on this account, on both chains: the " + "embedded wallet and every TEE wallet. Solana wallets are in `embedded` and `tee` (SOL as raw " + "`lamports`, tokens as raw `amountRaw` with `decimals`). Hood wallets are in `hood.embedded` and " + "`hood.tee` (ETH as raw `wei`, ERC-20s including USDG), never in the top-level arrays. Every " + "wallet and holding carries `chain`. Prices are in `prices`: a Solana mint under its own " + "address, Hood ETH under `hood:native`, and a Hood token under `hood:<contract lowercased>`, so " + "lowercase the address before looking it up. An unpriced entry is `priceUsd: null`, never zero; " + "a Hood one says why in `unpricedReason` (no-market-row, unusable-price, stale-mark, " + "source-unavailable), and `hood.unpriced` / `hood.unpricedByReason` count them. A Hood token " + "mark older than six hours is not used, so many Hood tokens read unpriced. A wallet whose read " + "failed has null balances, never zero, and is listed in `unavailable` (Solana) or " + "`hood.unavailable`; check `complete` before quoting a total. `walletsComplete` is false only " + "when the wallet list itself was cut off, and is absent on a server that predates it: then " + "`complete: false` may be a cut-off list or a failed read. Vault and external wallets are " + "not included: Candle does not know their addresses (the Candle CLI's `candle portfolio` reads " + "them over your own RPC). Needs a key with the account:read scope; without it the answer is " + "SCOPE_MISSING. A server that predates Hood in the portfolio omits `hood` and `chain`. Reads " + "only; moves nothing.",
    inputSchema: {}
  }, async () => callAndRelay("candle_get_portfolio", {}, cfg));
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
    description: "Convert one base asset into another through the account's own embedded wallets. MOVES " + `REAL FUNDS.

` + "SOL, USDC and CNDL are on Solana. ETH and USDG are on Hood. A pair drawn from ONE of " + "those groups settles on that chain in a single transaction. A pair spanning both is a " + `BRIDGE, and this is how a Hood wallet gets funded before launching or trading there.

` + `A bridge behaves differently and the difference matters:
` + `- It is several transactions, not one, and it takes time rather than settling on the call.
` + "- A confirmed source transaction is NOT proof the destination was credited. Read the " + "returned status before treating the funds as arrived; the response carries the venue's " + `own status URLs for the cross-chain fill.
` + "- A timeout is unknown, not failed. Pass a `clientSwapId` and retry the SAME request, " + "including the same slippage. The replay returns the stored result: the original success, " + "or a stored error. An indeterminate first leg comes back as SWAP_FAILED, retryable false, " + "with the signature in the message -- verify that on-chain before a new id. A swap that is " + "still running, with no stored outcome, is a retryable conflict. A different body under the " + "same id is rejected. A confirmed first leg is replayed with its hash, retryable false, and " + "is not run again. retryable true on the first LEG2_FAILED means send leg 2 as a new request. " + `Omitting the id never coalesces -- do not retry a timed-out call that had no id.
` + "- If a bridge times out, check the returned status URLs rather than treating the funds " + `as arrived or lost.

` + 'Amounts are decimal (`amount`, e.g. "0.5"); `amountRaw` still accepts raw base units for ' + "callers that already compute them. Test-environment keys are refused: every leg settles " + `on a live venue.

` + "This tool spends the embedded wallets. A TEE wallet also bridges, from SOL or USDC to ETH " + "or USDG or back, but only into the same key's TEE wallet on the other chain, with no Candle " + "fee: that runs through `candle swap` with the wallet's bound key, not this tool.",
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
    description: "Buy or sell a token. MOVES REAL FUNDS: the payer is the account's embedded (main) " + `wallet, executed server-side via delegation.

` + `Before the first trade of a run, once:
` + "1. candle_execution_status  -- confirms the wallets, the tier and this key's spend " + "limits. Call it at the start, or after an auth error; do not infer readiness from a " + `failed trade.
` + "2. candle_resolve_token  -- if a human handed you a bare address. It returns the chain, " + `so you never have to guess it.
` + "3. candle_token_forensics  -- before you quote or buy anything. It returns safety.summary and sourced flags " + "with timestamps and details. Unknown is not clean. MARKET_NOT_FOUND there means Candle has no market for the " + `token, NOT that the token is clean.

` + "Arguments: `mint` and `side` are required. Amounts are DECIMAL, never raw base units " + '(amount: "0.5", not lamports). Omitting the amount on a sell sells the whole ' + `position.

` + "Plans: every plan can buy and sell Candle-launched tokens and base assets, and SELL a token it holds that " + "Candle did not launch. BUYING such a token needs Pro or Max (TIER_REQUIRED otherwise). Each trade pays the " + `plan's agent fee on top (feeBps in candle_get_plans).

` + "Pass `paper: true` to rehearse: every admission rule runs and the quote is recorded, but " + "nothing broadcasts and no funds move. A paper buy credits this key's paper inventory, " + "including for external Solana mints routed through Jupiter. A later sell by amount or " + "percent closes that book without reading the live wallet and without MARKET_NOT_FOUND " + "-- including when `paper` is omitted on the exit, as long as the paper position exists. " + "Do this before the first live trade of a new strategy, and whenever you are unsure a " + `trade would be admitted at all.

` + `After the call:
` + "- A timeout is not a failure. Retry with the SAME clientTradeId from the result -- it " + `coalesces the duplicate. A NEW id is a SECOND trade, and that is how you double-spend.
` + "- If you no longer hold the result, do not re-send to find out what happened. Ask " + "candle_get_operation with the clientTradeId; a 404 there means the trade never reached " + "the rail and nothing moved.",
    inputSchema: tradeShape
  }, async (args) => {
    const result = await executeTrade(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  register("candle_launch_and_seed", {
    title: "Launch a token and seed it",
    description: "Launch a new token from the account's embedded wallet, with an optional dev-buy seed (in the " + "launch transaction on solana, a best-effort follow-up on hood). Works on every plan, Free included (this is not the atomic launch). Then " + "return the fresh market state and token links in one result. MOVES REAL FUNDS unless " + "dryRun. Seeds above the platform dev-buy ceiling are rejected (DEV_BUY_TOO_HIGH); " + "launch, then top up with candle_trade.",
    inputSchema: launchAndSeedShape
  }, async (args) => {
    const result = await executeLaunchAndSeed(args, cfg, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
  const perpsTool = (tool) => async (args) => {
    const result = await executePerps(tool, args, cfg, env, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  };
  const perpsWrite = " MOVES REAL FUNDS on Hyperliquid unless submit is false. Candle builds the action within this key's limits " + "(USD window, maximum leverage, maximum position, slippage and price bands, main-exchange markets only); this " + "server recomputes its hash and checks the action type and Candle's builder before signing, then submits it to " + "Hyperliquid itself. Needs perps:write on the key and CANDLE_KEY_SIGNER_PEM_FILE. A refusal names the limit " + "that refused it (error.limit).";
  register("candle_perps_setup", {
    title: "Set up Hyperliquid perps",
    description: "Approve Candle's Hyperliquid builder fee (0.1%) once for the key's EVM TEE wallet, and report the " + "account's mode and balance. Idempotent: nothing is signed when the approval is already on Hyperliquid." + perpsWrite,
    inputSchema: perpsShapes.candle_perps_setup
  }, perpsTool("candle_perps_setup"));
  register("candle_perps_open", {
    title: "Open a perps position",
    description: "Open or add to a perpetual position on Hyperliquid's main perp exchange: a market order (IOC within " + "slippageBps of the mid) without `price`, a limit order with it, and optional reduce-only takeProfit and " + "stopLoss triggers. Every plan except Max pays Candle a builder fee on each order (0.1% today; perpFeeBps in " + "candle_get_plans); Max pays none." + perpsWrite,
    inputSchema: perpsShapes.candle_perps_open
  }, perpsTool("candle_perps_open"));
  register("candle_perps_close", {
    title: "Close a perps position",
    description: "Close all or part of a position with a reduce-only IOC order. It reserves nothing, so a key at its USD " + "cap can still close." + perpsWrite,
    inputSchema: perpsShapes.candle_perps_close
  }, perpsTool("candle_perps_close"));
  register("candle_perps_cancel", {
    title: "Cancel a perps order",
    description: "Cancel an order Candle built, by its cloid (from candle_perps_open or candle_perps_orders)." + perpsWrite,
    inputSchema: perpsShapes.candle_perps_cancel
  }, perpsTool("candle_perps_cancel"));
  register("candle_perps_orders", {
    title: "Perps orders",
    description: "Open orders on Hyperliquid for the key's EVM TEE wallet, and every action Candle built for it with what " + "the venue shows. Reads only; moves nothing.",
    inputSchema: perpsShapes.candle_perps_orders
  }, perpsTool("candle_perps_orders"));
  register("candle_perps_positions", {
    title: "Perps positions",
    description: "Positions, account value and withdrawable balance on Hyperliquid for the key's EVM TEE wallet, read " + "live by its address. Reads only; moves nothing.",
    inputSchema: perpsShapes.candle_perps_positions
  }, perpsTool("candle_perps_positions"));
  register("candle_perps_leverage", {
    title: "Set perps leverage",
    description: "Set a market's leverage and margin mode (cross or isolated) on the account, within the key's maximum leverage." + perpsWrite,
    inputSchema: perpsShapes.candle_perps_leverage
  }, perpsTool("candle_perps_leverage"));
  register("candle_perps_deposit", {
    title: "Deposit to Hyperliquid",
    description: "MOVES REAL FUNDS unless submit is false. Deposit onto the key's Hyperliquid account through Relay: SOL or " + "USDC from its Solana TEE wallet, or ETH or USDG from its Hood TEE wallet, credited as Hyperliquid perps " + "USDC at the key's EVM TEE wallet's own address (Candle resolves it; no recipient is taken). Refused below a " + "floor that covers Hyperliquid's 1 USDC first-deposit charge. No Candle fee. Needs swap:write and a raw cap " + "on the asset, and CANDLE_KEY_SIGNER_PEM_FILE to sign. There is no withdrawal from Hyperliquid yet.",
    inputSchema: perpsDepositShape
  }, async (args) => {
    const result = await executePerpsDeposit(args, cfg, env, fetch);
    return { content: [{ type: "text", text: result.text }], ...result.isError ? { isError: true } : {} };
  });
}

// src/server.ts
var INSTRUCTIONS = `Candle is a trading and token-launch rail for agents. You hold a scoped API key, never a private key; signing and funding stay with the key owner's wallet.

START HERE — six tools need NO credential. Call these first to confirm the server is wired before asking anyone for anything:
  candle_get_market       price, market cap, volume, curve state for one token
  candle_get_feed         the roster: hot streak, new pairs, graduated, blue chip
  candle_resolve_token    a ticker or partial name -> mint address + chain
  candle_token_forensics  call this before quoting or buying. Returns the on-chain developer (never a launchpad shared authority; deployer.attribution names the launchpad or issuer when no developer is on chain), their went-to-zero rate and last coins, who bought in the deploy window (strangers in the same slot are the bundle signal), same-funder insider share, same-funder cluster, and safety.summary with six sourced flags. Refuse an unprompted buy when flagged; incomplete or unknown is not clearance. launch.deployerLaunches is an inclusive informational count, never a warning
  candle_get_agent_profile  your own tier, caps and verified activity
  candle_get_plans        every plan's price, fees, limits and what it can do; quote these, never from memory

COVERAGE — read this before you treat an error as a broken server.
candle_get_feed indexes the wider market (pump.fun, pons.family and other external launchpads).
Feed rows carry jupiterOk / externalTradeable / paperDiscoveryOk / organic0LiveOk on external
Solana mints. Use discovery=paper on candle_get_feed when rehearsing; on live screens do NOT
hard-skip organicScore=0 when organic0LiveOk is true (visible m5 momentum). Hard-skip organic0
only when organic0LiveOk is false.
candle_get_market and candle_resolve_token answer for same-chain indexed external mints even
when trade.routable is false. Read candleLaunched, launchpad, venue and trade; jupiterOk and
paperDiscoveryOk are separate signals. Identity-only Solana reads have route_unverified.
General quotes use POST /api/v1/trade/agent/quote; curve quotes/lifecycle describe Candle launches.
Stored eligibility is not a successful quote or permission. MARKET_NOT_FOUND remains a legacy
code: read error.routing.reason, error.discovery and sibling error.retryable. A curve-only
404 is endpoint guidance, not a verdict that Candle cannot trade external tokens.
candle_token_forensics also answers for Solana tokens the feed or Jupiter's index knows, with a partial
report: on-chain developer (never a launchpad shared authority), went-to-zero record, token
safety flags, same-funder insiders and cluster. Deploy-window stays unavailable without a
Candle launch record. Indexed external Hood tokens also answer, with unknown hacc flags.
Unknown mints can still come back MARKET_NOT_FOUND. That remaining gap is a coverage boundary,
not a fault and not a reason to retry, re-auth, or tell the human the integration is down.
Report MARKET_NOT_FOUND as "Candle has no market for this token, so I could not run forensics
on it" and let the human decide.

Never let a MARKET_NOT_FOUND stand in for a clean bill of health. The same rule governs the
coverage note on every forensics measurement: "unavailable" is NOT "clean" — say so rather than
reporting a token as safe.

WRITING (trade, launch, transfer, sweep, swap) needs a key. If a call returns an auth error, the fix is on the human's side: they run \`candle auth login\`, which authorizes a device in the browser and stores the credentials. Do not ask them to paste a key into a config file, and do not retry the call until they confirm.

Two chains: solana and hood. Most tools take an explicit chain — resolve it with candle_resolve_token rather than guessing.

Writes are idempotent by client token and may be asynchronous: poll candle_execution_status or candle_get_operation rather than re-issuing a call. Re-issuing is how you double-spend.

Full reference, error catalogue and end-to-end recipes: https://docs.candle.tv — and AGENTS.md in github.com/candledottv/agentic.`;
function createCandleMcpServer(env = process.env) {
  const server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
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
