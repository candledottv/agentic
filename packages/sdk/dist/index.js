import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/authorization-signature.ts
import canonicalize from "canonicalize";

// src/internal/encoding.ts
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function arrayBufferToBase64(data) {
  return Buffer.from(data).toString("base64");
}
function base64ToArrayBuffer(base64) {
  const buf = Buffer.from(base64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// src/authorization-signature.ts
var PRIVY_API_BASE = "https://api.privy.io";
function canonicalAuthorizationPayload(params) {
  return {
    version: 1,
    method: "POST",
    url: `${PRIVY_API_BASE}/v1/wallets/${params.privyWalletId}/rpc`,
    body: params.body,
    headers: { "privy-app-id": params.appId }
  };
}
function canonicalAuthorizationPayloadBytes(params) {
  const json = canonicalize(canonicalAuthorizationPayload(params));
  if (json === undefined) {
    throw new Error("Failed to canonicalize the Privy authorization payload");
  }
  return new TextEncoder().encode(json);
}
function pemToPkcs8Bytes(pem) {
  const base64 = pem.split(`
`).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("-----")).join("");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}
function derEncodeUnsignedInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0)
    start++;
  const trimmed = bytes.slice(start);
  const needsPad = ((trimmed[0] ?? 0) & 128) !== 0;
  const value = needsPad ? Uint8Array.from([0, ...trimmed]) : trimmed;
  return Uint8Array.from([2, value.length, ...value]);
}
function rawEcdsaSignatureToDer(raw) {
  const half = raw.length / 2;
  const r = derEncodeUnsignedInteger(raw.slice(0, half));
  const s = derEncodeUnsignedInteger(raw.slice(half));
  return Uint8Array.from([48, r.length + s.length, ...r, ...s]);
}
async function importPkcs8SigningKey(privateKeyPem) {
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(pemToPkcs8Bytes(privateKeyPem)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function buildPrivyAuthorizationSignature(params) {
  const payloadBytes = canonicalAuthorizationPayloadBytes(params);
  const key = await importPkcs8SigningKey(params.privateKeyPem);
  const rawSignature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, toArrayBuffer(payloadBytes));
  const derSignature = rawEcdsaSignatureToDer(new Uint8Array(rawSignature));
  return arrayBufferToBase64(toArrayBuffer(derSignature));
}

// src/errors.ts
var BRIDGE_ERROR_CODES = ["BRIDGE_DESTINATION_MISSING", "RELAY_STEP_REFUSED", "BRIDGE_IN_FLIGHT"];

class CandleApiError extends Error {
  code;
  status;
  retryable;
  field;
  routing;
  discovery;
  coverage;
  uiHint;
  docsPath;
  constructor(args) {
    super(args.message);
    this.name = "CandleApiError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable;
    if (args.field !== undefined)
      this.field = args.field;
    this.routing = args.routing;
    this.discovery = args.discovery;
    this.coverage = args.coverage;
    this.uiHint = args.uiHint;
    this.docsPath = args.docsPath;
  }
}
function isSolanaRpcErrorData(data) {
  if (typeof data !== "object" || data === null)
    return false;
  const candidate = data;
  if (!("err" in candidate))
    return false;
  return Array.isArray(candidate.logs) && candidate.logs.every((line) => typeof line === "string");
}

class JsonRpcError extends Error {
  code;
  data;
  constructor(args) {
    super(args.message);
    this.name = "JsonRpcError";
    this.code = args.code;
    this.data = args.data;
  }
}
function envelopeError(body) {
  if (typeof body !== "object" || body === null)
    return null;
  const candidate = body;
  if (candidate.success !== false)
    return null;
  if (typeof candidate.error !== "object" || candidate.error === null)
    return null;
  const error = candidate.error;
  if (typeof error.code !== "string" || typeof error.message !== "string")
    return null;
  return {
    ...typeof error.routing === "object" && error.routing !== null && typeof error.routing.reason === "string" ? { routing: error.routing } : {},
    ...typeof error.discovery === "object" && error.discovery !== null ? { discovery: error.discovery } : {},
    ...error.coverage !== undefined ? { coverage: error.coverage } : {},
    ...typeof error.uiHint === "string" ? { uiHint: error.uiHint } : {},
    ...typeof error.docsPath === "string" ? { docsPath: error.docsPath } : {},
    code: error.code,
    message: error.message,
    ...typeof error.field === "string" ? { field: error.field } : {},
    ...typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}
  };
}
function candleApiErrorFromResponse(status, bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const payload = envelopeError(parsed);
  if (payload) {
    return new CandleApiError({
      ...payload,
      code: payload.code,
      message: payload.message,
      status,
      retryable: payload.retryable === true,
      ...payload.field !== undefined ? { field: payload.field } : {}
    });
  }
  return new CandleApiError({
    code: `HTTP_${status}`,
    message: bodyText || `HTTP ${status}`,
    status,
    retryable: false
  });
}

// src/evm-tx.ts
var GAS_BUFFER_NUMERATOR = 12n;
var GAS_BUFFER_DENOMINATOR = 10n;
var DEFAULT_RECEIPT_TIMEOUT_MS = 120000;
var DEFAULT_RECEIPT_POLL_MS = 2000;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function hexToBigInt(hex) {
  return BigInt(hex);
}
function bigIntToHexQuantity(n) {
  if (n < 0n) {
    throw new Error(`bigIntToHexQuantity(): negative values are not valid hex quantities: ${n}`);
  }
  return `0x${n.toString(16)}`;
}
function decimalToHexQuantity(decimalString) {
  return bigIntToHexQuantity(BigInt(decimalString));
}
async function fetchNonce(rpc, from) {
  const hex = await rpc.call("eth_getTransactionCount", [from, "pending"]);
  return Number(hexToBigInt(hex));
}
async function fetchChainId(rpc) {
  const hex = await rpc.call("eth_chainId", []);
  return Number(hexToBigInt(hex));
}
async function fetchFeeData(rpc) {
  let priorityHex;
  try {
    priorityHex = await rpc.call("eth_maxPriorityFeePerGas", []);
  } catch {
    priorityHex = await rpc.call("eth_gasPrice", []);
  }
  const priority = hexToBigInt(priorityHex);
  const block = await rpc.callRaw("eth_getBlockByNumber", ["latest", false]);
  const baseFeePerGas = block?.baseFeePerGas;
  if (typeof baseFeePerGas !== "string") {
    throw new Error('fetchFeeData(): eth_getBlockByNumber("latest", false) response is missing baseFeePerGas -- ' + "this RPC node may not support EIP-1559");
  }
  const baseFee = hexToBigInt(baseFeePerGas);
  const maxFeePerGas = baseFee * 2n + priority;
  return {
    maxFeePerGasHex: bigIntToHexQuantity(maxFeePerGas),
    maxPriorityFeePerGasHex: bigIntToHexQuantity(priority)
  };
}
async function estimateGas(rpc, params) {
  const callParams = {
    from: params.from,
    to: params.to,
    data: params.data
  };
  if (params.value !== undefined)
    callParams.value = params.value;
  const raw = await rpc.call("eth_estimateGas", [callParams]);
  const buffered = hexToBigInt(raw) * GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR;
  return bigIntToHexQuantity(buffered);
}
function assembleEvmTx(input) {
  return {
    from: input.from,
    to: input.to,
    nonce: input.nonce,
    chain_id: input.chainId,
    data: input.data,
    value: decimalToHexQuantity(input.valueDecimal),
    type: 2,
    gas_limit: input.gasLimitHex,
    max_fee_per_gas: input.feeData.maxFeePerGasHex,
    max_priority_fee_per_gas: input.feeData.maxPriorityFeePerGasHex
  };
}
async function waitForReceipt(rpc, txHash, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_RECEIPT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    const receipt = await rpc.callRaw("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (receipt.status === "0x0") {
        throw new Error(`waitForReceipt("${txHash}"): transaction reverted (receipt status 0x0)`);
      }
      return receipt;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitForReceipt("${txHash}") timed out after ${timeoutMs}ms waiting for a transaction receipt`);
    }
    await sleep(pollMs);
  }
}

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

// src/internal/rpc-endpoint.ts
function describeRpcEndpoint(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable rpc endpoint>";
  }
}

// src/wallet-import.ts
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { base58 } from "@scure/base";
function buildCipherSuite() {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256,
    kdf: new HkdfSha256,
    aead: new Chacha20Poly1305
  });
}
function parseSolanaSecret(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("[")) {
    let decoded;
    try {
      decoded = base58.decode(trimmed);
    } catch {
      throw new Error("Invalid Solana private key: expected a base58 string or an id.json byte array.");
    }
    if (decoded.length !== 64) {
      throw new Error(`Invalid Solana private key: expected 64 bytes, got ${decoded.length}. A 32-byte value is the ` + "SEED, not the keypair; export the full secret key, which is what solana-keygen writes to id.json.");
    }
    return decoded;
  }
  const parsed = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return;
    }
  })();
  const isByteArray = Array.isArray(parsed) && parsed.length === 64 && parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
  if (!isByteArray) {
    throw new Error("This looks like a Solana keyfile (id.json) but is not a 64-byte array. Pass the file's contents, e.g. [12,34,...].");
  }
  return Uint8Array.from(parsed);
}
function decodeWalletPrivateKey(chain, privateKey) {
  if (chain === "evm") {
    const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error("Invalid EVM private key: expected 32 bytes as 64 hex characters " + `(optionally "0x"-prefixed), got ${hex.length} characters`);
    }
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  return parseSolanaSecret(privateKey);
}
async function encryptWalletKeyForImport(params) {
  const plaintext = decodeWalletPrivateKey(params.chain, params.privateKey);
  const suite = buildCipherSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(base64ToArrayBuffer(params.encryptionPublicKey));
  const sender = await suite.createSenderContext({ recipientPublicKey });
  const ciphertext = await sender.seal(toArrayBuffer(plaintext));
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    encapsulatedKey: arrayBufferToBase64(sender.enc)
  };
}
async function generateSignerKeypair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const [publicKeyDer, privateKeyDer] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
  ]);
  return {
    privateKeyPem: derToPem(privateKeyDer, "PRIVATE KEY"),
    publicKeyDerBase64: arrayBufferToBase64(publicKeyDer)
  };
}
function derToPem(der, label) {
  const base64 = arrayBufferToBase64(der);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN ${label}-----
${lines.join(`
`)}
-----END ${label}-----
`;
}

// src/client.ts
var BACKOFF_BASE_MS = 250;
var BACKOFF_CAP_MS = 8000;
function retryDelayMs(retry) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_CAP_MS);
  return base / 2 + Math.random() * (base / 2);
}
function isRetryableLaunchFailure(error) {
  if (!(error instanceof CandleApiError))
    return true;
  if (error.code.startsWith("HTTP_"))
    return error.status >= 500;
  if (!error.retryable)
    return false;
  return error.status >= 500 || error.status === 409;
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var MAX_BLOCKHASH_REBUILDS = 2;
function isBlockhashExpiry(error) {
  if (!(error instanceof JsonRpcError))
    return false;
  const data = error.data;
  if (typeof data === "object" && data !== null && "err" in data && data.err === "BlockhashNotFound") {
    return true;
  }
  return /blockhash not found|block height exceeded/i.test(error.message);
}
function withRpcLagHint(error) {
  return new JsonRpcError({
    code: error.code,
    message: `${error.message} -- this transaction was rebuilt with a fresh blockhash ${MAX_BLOCKHASH_REBUILDS} times ` + "and still failed at broadcast, which usually means the configured Solana RPC is lagging or " + "rate-limited. Point solanaRpcUrl at a fast endpoint (for example Helius).",
    data: error.data
  });
}
function formatJsonRpcErrorMessage(method, url, rpcError) {
  const base = `JSON-RPC ${method} against ${describeRpcEndpoint(url)} was rejected (code ${rpcError.code}): ${rpcError.message}`;
  const data = rpcError.data;
  if (typeof data !== "object" || data === null)
    return base;
  const d = data;
  const parts = [];
  if (d.err !== undefined) {
    parts.push(`err: ${typeof d.err === "string" ? d.err : JSON.stringify(d.err)}`);
  }
  if (Array.isArray(d.logs) && d.logs.length > 0) {
    const logs = d.logs.filter((line) => typeof line === "string");
    parts.push(`logs: ${logs.slice(-3).join(" | ")}`);
  }
  return parts.length > 0 ? `${base} [${parts.join("; ")}]` : base;
}
function toAtomicWirePayer(payer) {
  return payer.type === "main" ? { type: "main" } : { type: "linked", linkedWalletId: payer.linkedWalletId };
}
function isAtomicSubmitOutcome(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  if (typeof v.bundleId !== "string")
    return false;
  if (v.status === "failed" || v.status === "timeout")
    return typeof v.retryable === "boolean";
  if (v.status === "landed") {
    return typeof v.mint === "string" && Array.isArray(v.signatures) && v.signatures.every((s) => typeof s === "string");
  }
  return false;
}
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_POLL_MS = 2000;
var DEFAULT_WAIT_TIMEOUT_MS = 180000;
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
function assertTransportSecurity(apiUrl, allowInsecureHttp) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`CandleClient: apiUrl is not a valid URL: ${JSON.stringify(apiUrl)}`);
  }
  if (parsed.protocol === "https:")
    return;
  if (parsed.protocol !== "http:") {
    throw new Error(`CandleClient: apiUrl must be http or https, got ${parsed.protocol.replace(":", "")}`);
  }
  if (isLoopbackHost(parsed.hostname))
    return;
  if (allowInsecureHttp && isPrivateHost(parsed.hostname))
    return;
  throw new Error(`CandleClient: refusing to send credentials in the clear to ${parsed.origin}. Use https://.` + (isPrivateHost(parsed.hostname) ? " Pass allowInsecureHttp: true if this really is a trusted local endpoint." : " allowInsecureHttp does not apply here: it covers private networks only, and this is a" + " public address."));
}

class CandleClient {
  apiUrl;
  apiKey;
  fetchImpl;
  maxRetries;
  privyAppId;
  secretStore;
  solanaRpcUrl;
  evmRpcUrl;
  hyperliquidNetwork;
  hyperliquidBuilder;
  wallets = {
    swapReceipt: async (hash) => {
      this.requireKey("wallets.swapReceipt()");
      const body = await this.requestJson("GET", `/api/v1/agent/swap/receipts/${encodeURIComponent(hash)}`);
      return body.settlement;
    },
    selfBalances: async (opts = {}) => {
      this.requireKey("wallets.selfBalances()");
      const params = new URLSearchParams;
      if (opts.mints?.length)
        params.set("mints", opts.mints.join(","));
      if (opts.cursor !== undefined)
        params.set("cursor", opts.cursor);
      const query = params.size ? `?${params}` : "";
      return this.requestJson("GET", `/api/v1/agent/wallets/self/balances${query}`);
    }
  };
  constructor(opts) {
    assertTransportSecurity(opts.apiUrl, opts.allowInsecureHttp === true);
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    if (opts.apiKey !== undefined)
      this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.maxRetries !== undefined && (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0)) {
      throw new Error(`CandleClient: maxRetries must be a non-negative integer, got ${opts.maxRetries}`);
    }
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (opts.privyAppId !== undefined)
      this.privyAppId = opts.privyAppId;
    if (opts.secretStore !== undefined)
      this.secretStore = opts.secretStore;
    if (opts.solanaRpcUrl !== undefined)
      this.solanaRpcUrl = opts.solanaRpcUrl;
    if (opts.evmRpcUrl !== undefined)
      this.evmRpcUrl = opts.evmRpcUrl;
    this.hyperliquidNetwork = opts.hyperliquidNetwork ?? "mainnet";
    const builder = opts.hyperliquidBuilder ?? CANDLE_HYPERLIQUID_BUILDER_ADDRESS;
    if (builder)
      this.hyperliquidBuilder = builder.toLowerCase();
  }
  async getQuotePairs(chain) {
    const query = chain ? `?chain=${chain}` : "";
    const body = await this.requestJson("GET", `/api/v1/launch/quote-pairs${query}`);
    return body.payload;
  }
  async getPresets() {
    const body = await this.requestJson("GET", "/api/v1/launch/presets");
    return body.payload;
  }
  expandPreset(presets, name, overrides = {}) {
    const preset = presets.presets.find((p) => p.name === name);
    if (!preset) {
      const known = presets.presets.map((p) => p.name).join(", ");
      throw new Error(`Unknown preset "${name}". Known presets: ${known}`);
    }
    return {
      chain: preset.chain,
      quoteAsset: preset.quoteAsset,
      mode: preset.mode,
      stakerAllocationBps: preset.stakerAllocationBps,
      ...preset.dexVersion ? { dexVersion: preset.dexVersion } : {},
      ...overrides
    };
  }
  async getMarket(chain, mint) {
    const body = await this.requestJson("GET", `/api/v1/markets/${chain}/${encodeURIComponent(mint)}`);
    return body.market;
  }
  async getQuote(chain, mint, q) {
    const params = new URLSearchParams({ side: q.side, amountIn: q.amountIn });
    if (q.slippageBps !== undefined)
      params.set("slippageBps", String(q.slippageBps));
    return this.requestJson("GET", `/api/v1/markets/${chain}/${encodeURIComponent(mint)}/quote?${params.toString()}`);
  }
  async getFeed(bucket, chain) {
    const params = new URLSearchParams({ bucket, ...chain ? { chain } : {} });
    return this.requestJson("GET", `/api/v1/markets/feed?${params.toString()}`);
  }
  async verify(chain, mint) {
    return this.requestJson("GET", `/api/v1/verify/${chain}/${encodeURIComponent(mint)}`);
  }
  async getAgentProfile(idOrWallet) {
    const body = await this.requestJson("GET", `/api/v1/users/${encodeURIComponent(idOrWallet)}/agent`);
    return body.agent;
  }
  async getAgentTier() {
    return this.requestJson("GET", "/api/v1/agent/tier");
  }
  async dryRunLaunch(req) {
    this.requireKey("dryRunLaunch()");
    return this.requestJson("POST", "/api/v1/launch/headless/dry-run", req);
  }
  async launch(req) {
    this.requireKey("launch()");
    const body = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId() };
    let lastError;
    for (let attempt = 0;attempt <= this.maxRetries; attempt++) {
      if (attempt > 0)
        await sleep2(retryDelayMs(attempt - 1));
      try {
        return await this.requestJson("POST", "/api/v1/launch/headless", body);
      } catch (error) {
        if (!isRetryableLaunchFailure(error))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  async launchAsync(req) {
    this.requireKey("launchAsync()");
    const body = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId(), async: true };
    return this.requestJson("POST", "/api/v1/launch/headless", body);
  }
  async getLaunchJob(clientLaunchId) {
    this.requireKey("getLaunchJob()");
    const body = await this.requestJson("GET", `/api/v1/launch/headless/jobs/${encodeURIComponent(clientLaunchId)}`);
    return body.job;
  }
  async waitForLaunch(clientLaunchId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    for (;; ) {
      const job = await this.getLaunchJob(clientLaunchId);
      if (job.status === "confirmed" || job.status === "failed")
        return job;
      if (Date.now() >= deadline) {
        throw new Error(`waitForLaunch("${clientLaunchId}") timed out after ${timeoutMs}ms (last status: ${job.status})`);
      }
      await sleep2(pollMs);
    }
  }
  async reportActivity(chain, signature) {
    this.requireKey("reportActivity()");
    return this.requestJson("POST", "/api/v1/activity/report", { chain, signature });
  }
  async uploadImage(bytes, contentType) {
    this.requireKey("uploadImage()");
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/uploads/agent-image`, {
      method: "POST",
      headers: this.headers({ contentType }),
      body: bytes
    });
    const body = await this.parseResponse(res);
    return { imageUrl: body.imageUrl };
  }
  async listWallets(opts = {}) {
    this.requireKey("listWallets()");
    const query = opts.includeRevoked === true ? "?includeRevoked=true" : "";
    return this.requestJson("GET", `/api/v1/agent/wallets${query}`);
  }
  async getProfileWallets(keyPrefix) {
    this.requireKey("getProfileWallets()");
    return this.requestJson("GET", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`);
  }
  async getProfileTrades(keyPrefix, opts = {}) {
    this.requireKey("getProfileTrades()");
    const query = opts.limit !== undefined ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return this.requestJson("GET", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/trades${query}`);
  }
  async getProfilePnl(keyPrefix) {
    this.requireKey("getProfilePnl()");
    return this.requestJson("GET", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/pnl`);
  }
  async getPortfolio() {
    this.requireKey("getPortfolio()");
    return this.requestJson("GET", "/api/v1/agent/portfolio");
  }
  async setProfileWallets(keyPrefix, walletIds) {
    this.requireKey("setProfileWallets()");
    return this.requestJson("PUT", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`, { walletIds });
  }
  async setProfileWalletScope(keyPrefix, scope) {
    this.requireKey("setProfileWalletScope()");
    return this.requestJson("PUT", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallet-scope`, { scope });
  }
  async getSpendLimits() {
    this.requireKey("getSpendLimits()");
    return this.requestJson("GET", "/api/v1/agent/keys/self/limits");
  }
  async swap(req) {
    this.requireKey("swap()");
    const body = await this.requestJson("POST", "/api/v1/agent/swap", req);
    return body.payload;
  }
  async previewCloseEmptyAccounts(req = {}) {
    this.requireKey("previewCloseEmptyAccounts()");
    return this.requestJson("POST", "/api/v1/agent/wallets/embedded/close-empty/preview", req);
  }
  async closeEmptyAccounts(req) {
    this.requireKey("closeEmptyAccounts()");
    return this.requestJson("POST", "/api/v1/agent/wallets/embedded/close-empty", req);
  }
  async getCloseEmptyAccountsJob(clientTradeId) {
    this.requireKey("getCloseEmptyAccountsJob()");
    const body = await this.requestJson("GET", `/api/v1/agent/wallets/embedded/close-empty/jobs/${encodeURIComponent(clientTradeId)}`);
    return body.job;
  }
  async importWallet(params) {
    this.requireKey("importWallet()");
    const init = await this.requestJson("POST", "/api/v1/agent/wallets/import/init", { chain: params.chain, address: params.address });
    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: params.chain,
      privateKey: params.privateKey,
      encryptionPublicKey: init.encryptionPublicKey
    });
    return this.requestJson("POST", "/api/v1/agent/wallets/import/submit", {
      chain: params.chain,
      address: params.address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: params.signerPublicKey,
      ...params.label !== undefined ? { label: params.label } : {}
    });
  }
  async buildSelfLaunch(req) {
    this.requireKey("buildSelfLaunch()");
    return this.requestJson("POST", "/api/v1/launch/self/build", req);
  }
  async confirmSelfLaunch(req) {
    this.requireKey("confirmSelfLaunch()");
    return this.requestJson("POST", "/api/v1/launch/self/confirm", req);
  }
  async buildTrade(req) {
    this.requireKey("buildTrade()");
    return this.requestJson("POST", "/api/v1/trade/agent/build", req);
  }
  async confirmTrade(req) {
    this.requireKey("confirmTrade()");
    return this.requestJson("POST", "/api/v1/trade/agent/confirm", req);
  }
  async submit(req) {
    this.requireKey("submit()");
    return this.requestJson("POST", "/api/v1/trade/agent/submit", req);
  }
  async signLinkedTransaction(params) {
    this.requireKey("signLinkedTransaction()");
    if (!this.privyAppId) {
      throw new Error("signLinkedTransaction() requires privyAppId: pass one in CandleClientOptions " + "(new CandleClient({ privyAppId })) -- the same Privy app id the sign relay authenticates under");
    }
    if (!this.secretStore) {
      throw new Error("signLinkedTransaction() requires a secretStore: pass one in CandleClientOptions " + "(new CandleClient({ secretStore }))");
    }
    if (params.chain === "solana" && !params.unsignedTransactionBase64) {
      throw new Error('signLinkedTransaction() for chain "solana" requires unsignedTransactionBase64');
    }
    if (params.chain === "evm" && !params.evmTxParams) {
      throw new Error('signLinkedTransaction() for chain "evm" requires evmTxParams');
    }
    const privateKeyPem = await this.secretStore.get(params.linkedWalletId);
    if (!privateKeyPem) {
      throw new Error(`signLinkedTransaction(): no signer key stored for linked wallet "${params.linkedWalletId}" -- ` + "import or set one in the configured secretStore first");
    }
    const body = params.chain === "solana" ? { method: "signTransaction", params: { transaction: params.unsignedTransactionBase64, encoding: "base64" } } : { method: "eth_signTransaction", params: { transaction: params.evmTxParams } };
    const authorizationSignature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: params.privyWalletId,
      appId: this.privyAppId,
      body
    });
    const res = await this.requestJson("POST", `/api/v1/agent/wallets/${encodeURIComponent(params.linkedWalletId)}/sign`, { authorizationSignature, body });
    return { signedTransaction: res.signedTransaction, encoding: res.encoding };
  }
  async broadcastSignedTransaction(chain, signedTransaction, encoding) {
    if (chain === "solana") {
      if (!this.solanaRpcUrl) {
        throw new Error('broadcastSignedTransaction() for chain "solana" requires solanaRpcUrl: pass one in ' + "CandleClientOptions (new CandleClient({ solanaRpcUrl }))");
      }
      return this.jsonRpcCall(this.solanaRpcUrl, "sendTransaction", [signedTransaction, { encoding }]);
    }
    if (!this.evmRpcUrl) {
      throw new Error('broadcastSignedTransaction() for chain "evm" requires evmRpcUrl: pass one in CandleClientOptions ' + "(new CandleClient({ evmRpcUrl }))");
    }
    return this.jsonRpcCall(this.evmRpcUrl, "eth_sendRawTransaction", [signedTransaction]);
  }
  async swapFromLinked(req) {
    this.requireKey("swapFromLinked()");
    const build = await this.requestJson("POST", "/api/v1/agent/swap/build", {
      from: req.from,
      to: req.to,
      amountRaw: req.amountRaw,
      ...req.maxSlippageBps !== undefined ? { maxSlippageBps: req.maxSlippageBps } : {},
      payer: { type: "linked", linkedWalletId: req.payer.linkedWalletId },
      ...req.toWalletId !== undefined ? { toWalletId: req.toWalletId } : {},
      ...req.clientTradeId !== undefined ? { clientTradeId: req.clientTradeId } : {}
    });
    const signed = [];
    for (const unsignedTransactionBase64 of build.payload.transactionsBase64) {
      const result = await this.signLinkedTransaction({
        chain: "solana",
        linkedWalletId: req.payer.linkedWalletId,
        privyWalletId: req.payer.privyWalletId,
        unsignedTransactionBase64
      });
      signed.push(result.signedTransaction);
    }
    const submit = await this.requestJson("POST", "/api/v1/agent/swap/submit", {
      swapId: build.payload.swapId,
      signedTransactionsBase64: signed,
      ...req.clientTradeId !== undefined ? { clientTradeId: req.clientTradeId } : {}
    });
    return submit.payload;
  }
  async trade(req) {
    const clientTradeId = req.clientTradeId ?? generateClientTradeId();
    const buildReq = {
      clientTradeId,
      mint: req.mint,
      side: req.side,
      amountRaw: req.amountRaw,
      payer: req.from === "main" ? { type: "main" } : { type: "linked", linkedWalletId: req.from.linkedWalletId },
      ...req.maxSlippageBps !== undefined ? { maxSlippageBps: req.maxSlippageBps } : {},
      ...req.quoteAsset !== undefined ? { quoteAsset: req.quoteAsset } : {}
    };
    if (req.from === "main") {
      const result = await this.buildTrade(buildReq);
      if (result.status !== "executed") {
        throw new Error(`trade({ from: "main" }) expected an executed result but got status "${result.status}"`);
      }
      return result;
    }
    const { linkedWalletId, privyWalletId } = req.from;
    const built = await this.buildTrade(buildReq);
    if (built.status !== "built") {
      return built;
    }
    if (built.chain === "solana") {
      const signed = await this.signLinkedTransaction({
        linkedWalletId,
        privyWalletId,
        chain: "solana",
        unsignedTransactionBase64: built.artifacts.transactionBase64
      });
      return this.submit({ clientTradeId: built.clientTradeId, signedTransactions: [signed.signedTransaction] });
    }
    if (!this.evmRpcUrl) {
      throw new Error('trade({ from: <linked> }) on chain "hood" requires evmRpcUrl, because hood is an EVM chain: ' + "pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))");
    }
    const rpc = this.evmRpc();
    const from = built.walletAddress;
    const chainId = await fetchChainId(rpc);
    const baseNonce = await fetchNonce(rpc, from);
    const feeData = await fetchFeeData(rpc);
    const legs = [];
    if (built.artifacts.approval) {
      legs.push({ kind: "approval", to: built.artifacts.approval.to, data: built.artifacts.approval.data, value: "0" });
    }
    if (built.artifacts.permit2Approval) {
      legs.push({
        kind: "permit2Approval",
        to: built.artifacts.permit2Approval.to,
        data: built.artifacts.permit2Approval.data,
        value: "0"
      });
    }
    legs.push({ kind: "trade", ...built.artifacts.trade });
    if (built.artifacts.feeTransfer) {
      legs.push({ kind: "feeTransfer", ...built.artifacts.feeTransfer });
    }
    let tradeTxHash;
    let feeTxHash;
    for (let i = 0;i < legs.length; i++) {
      const leg = legs[i];
      if (!leg)
        continue;
      const txHash = await this.signBroadcastAndWaitEvmLeg({
        rpc,
        from,
        to: leg.to,
        data: leg.data,
        valueDecimal: leg.value,
        nonce: baseNonce + i,
        chainId,
        feeData,
        linkedWalletId,
        privyWalletId
      });
      if (leg.kind === "trade")
        tradeTxHash = txHash;
      if (leg.kind === "feeTransfer")
        feeTxHash = txHash;
    }
    if (!tradeTxHash) {
      throw new Error("trade(): Hood leg sequence completed without a trade leg");
    }
    return this.confirmTrade({
      clientTradeId: built.clientTradeId,
      tradeTxHash,
      ...feeTxHash ? { feeTxHash } : {}
    });
  }
  async selfLaunch(req) {
    const { privyWalletId, ...launchReq } = req;
    const body = {
      ...launchReq,
      clientLaunchId: launchReq.clientLaunchId ?? generateClientLaunchId()
    };
    const built = await this.buildSelfLaunch(body);
    if (typeof built.transaction === "string") {
      let unsignedTransactionBase64 = built.transaction;
      let clientLaunchId = built.clientLaunchId;
      for (let attempt = 0;attempt <= MAX_BLOCKHASH_REBUILDS; attempt++) {
        const signed = await this.signLinkedTransaction({
          linkedWalletId: body.linkedWalletId,
          privyWalletId,
          chain: "solana",
          unsignedTransactionBase64
        });
        try {
          const signature = await this.broadcastSignedTransaction("solana", signed.signedTransaction, signed.encoding);
          return this.confirmSelfLaunch({ clientLaunchId, signature });
        } catch (error) {
          if (!isBlockhashExpiry(error))
            throw error;
          if (attempt === MAX_BLOCKHASH_REBUILDS)
            throw withRpcLagHint(error);
          const rebuilt = await this.buildSelfLaunch(body);
          if (typeof rebuilt.transaction !== "string")
            throw error;
          unsignedTransactionBase64 = rebuilt.transaction;
          clientLaunchId = rebuilt.clientLaunchId;
        }
      }
      throw new Error("selfLaunch(): blockhash-rebuild loop exited without returning or throwing");
    }
    const hoodBuilt = built;
    if (!this.evmRpcUrl) {
      throw new Error('selfLaunch() on chain "hood" requires evmRpcUrl, because hood is an EVM chain: ' + "pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))");
    }
    const rpc = this.evmRpc();
    const from = hoodBuilt.walletAddress;
    const chainId = await fetchChainId(rpc);
    const baseNonce = await fetchNonce(rpc, from);
    const feeData = await fetchFeeData(rpc);
    const createCurveTxHash = await this.signBroadcastAndWaitEvmLeg({
      rpc,
      from,
      to: built.transaction.to,
      data: built.transaction.data,
      valueDecimal: "0",
      nonce: baseNonce,
      chainId,
      feeData,
      linkedWalletId: body.linkedWalletId,
      privyWalletId
    });
    let feeTxHash;
    if (hoodBuilt.feeTransfer) {
      feeTxHash = await this.signBroadcastAndWaitEvmLeg({
        rpc,
        from,
        to: hoodBuilt.feeTransfer.to,
        data: hoodBuilt.feeTransfer.data,
        valueDecimal: hoodBuilt.feeTransfer.value,
        nonce: baseNonce + 1,
        chainId,
        feeData,
        linkedWalletId: body.linkedWalletId,
        privyWalletId
      });
    }
    return this.confirmSelfLaunch({
      clientLaunchId: built.clientLaunchId,
      signature: createCurveTxHash,
      ...feeTxHash ? { feeTxHash } : {}
    });
  }
  async buildAtomicLaunch(req) {
    this.requireKey("buildAtomicLaunch()");
    const body = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId() };
    return this.requestJson("POST", "/api/v1/launch/atomic/build", body);
  }
  async submitAtomicLaunch(req) {
    this.requireKey("submitAtomicLaunch()");
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/launch/atomic/submit`, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify(req)
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isAtomicSubmitOutcome(parsed))
      return parsed;
    if (!res.ok)
      throw candleApiErrorFromResponse(res.status, text);
    throw new Error(`submitAtomicLaunch(): unexpected 200 response shape: ${text}`);
  }
  async launchAtomic(req) {
    const { payer, firstBuys, ...launchFields } = req;
    const buildReq = {
      ...launchFields,
      clientLaunchId: launchFields.clientLaunchId ?? generateClientLaunchId(),
      payer: toAtomicWirePayer(payer),
      firstBuys: firstBuys.map((leg) => ({ payer: toAtomicWirePayer(leg.payer), amountRaw: leg.amountRaw }))
    };
    const built = await this.buildAtomicLaunch(buildReq);
    const signedTxsBase64 = [];
    for (const leg of built.legs) {
      if (leg.signer !== "client")
        continue;
      if (!leg.unsignedTxBase64) {
        throw new Error(`launchAtomic(): build response's leg ${leg.index} is signer "client" but omitted unsignedTxBase64`);
      }
      const legPayer = leg.index === 0 ? payer : firstBuys[leg.index - 1]?.payer;
      if (!legPayer || legPayer.type !== "linked") {
        throw new Error(`launchAtomic(): build response's leg ${leg.index} is signer "client" but this request's own leg ${leg.index} is not a linked payer`);
      }
      const signed = await this.signLinkedTransaction({
        linkedWalletId: legPayer.linkedWalletId,
        privyWalletId: legPayer.privyWalletId,
        chain: "solana",
        unsignedTransactionBase64: leg.unsignedTxBase64
      });
      signedTxsBase64.push(signed.signedTransaction);
    }
    return this.submitAtomicLaunch({ bundleId: built.bundleId, signedTxsBase64 });
  }
  evmRpc() {
    const url = this.evmRpcUrl;
    if (!url) {
      throw new Error("evmRpc(): evmRpcUrl is unset -- callers must check this first");
    }
    return {
      call: (method, params) => this.jsonRpcCall(url, method, params),
      callRaw: (method, params) => this.jsonRpcCallRaw(url, method, params)
    };
  }
  async signBroadcastAndWaitEvmLeg(params) {
    const gasLimitHex = await estimateGas(params.rpc, {
      from: params.from,
      to: params.to,
      data: params.data,
      value: decimalToHexQuantity(params.valueDecimal)
    });
    const evmTxParams = assembleEvmTx({
      from: params.from,
      to: params.to,
      data: params.data,
      valueDecimal: params.valueDecimal,
      nonce: params.nonce,
      chainId: params.chainId,
      gasLimitHex,
      feeData: params.feeData
    });
    const signed = await this.signLinkedTransaction({
      linkedWalletId: params.linkedWalletId,
      privyWalletId: params.privyWalletId,
      chain: "evm",
      evmTxParams
    });
    const txHash = await this.broadcastSignedTransaction("evm", signed.signedTransaction, signed.encoding);
    await waitForReceipt(params.rpc, txHash);
    return txHash;
  }
  async perpsConfig() {
    this.requireKey("perpsConfig()");
    return this.requestJson("GET", "/api/v1/agent/perps/config");
  }
  async perpsSetup(params) {
    this.requireKey("perpsSetup()");
    const res = await this.requestJson("POST", "/api/v1/agent/perps/setup", { walletId: params.walletId });
    const status = {
      walletId: res.walletId,
      address: res.address,
      network: res.network,
      mode: res.mode,
      standardMode: res.standardMode,
      accountValue: res.accountValue,
      withdrawable: res.withdrawable,
      builder: res.builder,
      approvedFeeTenthsBps: res.approvedFeeTenthsBps,
      ready: res.ready
    };
    if (res.ready)
      return status;
    return { ...status, action: await this.perpsComplete(res, params, "setup") };
  }
  async perpsOpen(params) {
    this.requireKey("perpsOpen()");
    const { walletId, privyWalletId: _p, submit: _s, ...order } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/open", { walletId, ...order });
    return this.perpsComplete(build, params, "open");
  }
  async perpsClose(params) {
    this.requireKey("perpsClose()");
    const { walletId, privyWalletId: _p, submit: _s, ...close } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/close", { walletId, ...close });
    return this.perpsComplete(build, params, "close");
  }
  async perpsCancel(params) {
    this.requireKey("perpsCancel()");
    const build = await this.requestJson("POST", "/api/v1/agent/perps/cancel", {
      walletId: params.walletId,
      cloid: params.cloid
    });
    return this.perpsComplete(build, params, "cancel");
  }
  async perpsModify(params) {
    this.requireKey("perpsModify()");
    const { walletId, privyWalletId: _p, submit: _s, ...modify } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/modify", { walletId, ...modify });
    return this.perpsComplete(build, params, "modify");
  }
  async perpsLeverage(params) {
    this.requireKey("perpsLeverage()");
    const { walletId, privyWalletId: _p, submit: _s, ...leverage } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/leverage", { walletId, ...leverage });
    return this.perpsComplete(build, params, "leverage");
  }
  async perpsMargin(params) {
    this.requireKey("perpsMargin()");
    const build = await this.requestJson("POST", "/api/v1/agent/perps/margin", {
      walletId: params.walletId,
      coin: params.coin,
      amount: params.amount
    });
    return this.perpsComplete(build, params, "margin");
  }
  async perpsPositions(walletId) {
    this.requireKey("perpsPositions()");
    return this.requestJson("GET", `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(walletId)}`);
  }
  async perpsOrders(walletId, opts = {}) {
    this.requireKey("perpsOrders()");
    const params = new URLSearchParams({ walletId });
    if (opts.limit !== undefined)
      params.set("limit", String(opts.limit));
    return this.requestJson("GET", `/api/v1/agent/perps/orders?${params}`);
  }
  async perpsFills(walletId) {
    this.requireKey("perpsFills()");
    return this.requestJson("GET", `/api/v1/agent/perps/fills?walletId=${encodeURIComponent(walletId)}`);
  }
  async perpsFunding(walletId, startTime) {
    this.requireKey("perpsFunding()");
    const params = new URLSearchParams({ walletId });
    if (startTime !== undefined)
      params.set("startTime", String(startTime));
    return this.requestJson("GET", `/api/v1/agent/perps/funding?${params}`);
  }
  async perpsBuilder() {
    if (this.hyperliquidBuilder)
      return this.hyperliquidBuilder;
    const config = await this.perpsConfig();
    if (!config.builder)
      throw new Error("perps: the server reports no Hyperliquid builder address");
    this.hyperliquidBuilder = config.builder.toLowerCase();
    return this.hyperliquidBuilder;
  }
  async perpsComplete(build, ref, method) {
    const check = verifyPerpsBuild(build, {
      builder: await this.perpsBuilder(),
      network: this.hyperliquidNetwork,
      intent: { method, params: ref }
    });
    if (!check.ok)
      throw new Error(`perps: refused to sign this build: ${check.reason}`);
    if (method === "close") {
      const closeOrder = await hyperliquidCloseOrder(this.fetchImpl, this.hyperliquidNetwork, build.address, ref);
      const closeCheck = verifyPerpsBuild(build, {
        builder: await this.perpsBuilder(),
        network: this.hyperliquidNetwork,
        intent: { method, params: ref },
        closeOrder
      });
      if (!closeCheck.ok)
        throw new Error(`perps: refused to sign this build: ${closeCheck.reason}`);
    }
    if (ref.submit === false)
      return { build, signature: null, submitted: false, exchange: null };
    const signature = await this.signLinkedTypedData({
      linkedWalletId: ref.walletId,
      privyWalletId: ref.privyWalletId,
      typedData: build.typedData
    });
    try {
      const res = await this.fetchImpl(HYPERLIQUID_EXCHANGE_URLS[this.hyperliquidNetwork], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hyperliquidExchangeBody(build.action, build.nonce, signature))
      });
      const text = await res.text();
      if (!res.ok) {
        return { build, signature, submitted: false, exchange: null, submitError: `HTTP ${res.status}: ${text}` };
      }
      return { build, signature, submitted: true, exchange: JSON.parse(text) };
    } catch (err) {
      return {
        build,
        signature,
        submitted: false,
        exchange: null,
        submitError: err instanceof Error ? err.message : String(err)
      };
    }
  }
  async signLinkedTypedData(params) {
    if (!this.privyAppId) {
      throw new Error("perps signing requires privyAppId in CandleClientOptions (the relay's Privy app id)");
    }
    if (!this.secretStore)
      throw new Error("perps signing requires a secretStore in CandleClientOptions");
    const privateKeyPem = await this.secretStore.get(params.linkedWalletId);
    if (!privateKeyPem) {
      throw new Error(`perps: no signer key stored for linked wallet "${params.linkedWalletId}"`);
    }
    const body = hyperliquidRelayBody(params.typedData);
    const authorizationSignature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: params.privyWalletId,
      appId: this.privyAppId,
      body
    });
    const res = await this.requestJson("POST", `/api/v1/agent/wallets/${encodeURIComponent(params.linkedWalletId)}/sign`, { authorizationSignature, body });
    if (typeof res.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(res.signature)) {
      throw new Error("perps: the relay returned no signature");
    }
    return res.signature;
  }
  requireKey(method) {
    if (!this.apiKey) {
      throw new Error(`${method} requires an apiKey: pass one in CandleClientOptions (new CandleClient({ apiKey }))`);
    }
  }
  headers(opts = {}) {
    const headers = {};
    if (opts.json)
      headers["content-type"] = "application/json";
    if (opts.contentType)
      headers["content-type"] = opts.contentType;
    if (this.apiKey)
      headers["x-api-key"] = this.apiKey;
    return headers;
  }
  async requestJson(method, path, body) {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers({ json: body !== undefined }),
      ...body !== undefined ? { body: JSON.stringify(body) } : {}
    });
    return this.parseResponse(res);
  }
  async parseResponse(res) {
    noteLatestSdkVersion(res.headers?.get?.("x-candle-sdk-latest") ?? null);
    const text = await res.text();
    if (!res.ok)
      throw candleApiErrorFromResponse(res.status, text);
    return JSON.parse(text);
  }
  async jsonRpcCall(url, method, params) {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`JSON-RPC ${method} against ${describeRpcEndpoint(url)} failed: HTTP ${res.status}: ${text}`);
    }
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new JsonRpcError({
        code: parsed.error.code,
        message: formatJsonRpcErrorMessage(method, url, parsed.error),
        data: parsed.error.data
      });
    }
    if (typeof parsed.result !== "string") {
      throw new Error(`JSON-RPC ${method} against ${describeRpcEndpoint(url)} returned a non-string result: ${JSON.stringify(parsed.result)}`);
    }
    return parsed.result;
  }
  async jsonRpcCallRaw(url, method, params) {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`JSON-RPC ${method} against ${describeRpcEndpoint(url)} failed: HTTP ${res.status}: ${text}`);
    }
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new JsonRpcError({
        code: parsed.error.code,
        message: formatJsonRpcErrorMessage(method, url, parsed.error),
        data: parsed.error.data
      });
    }
    return parsed.result;
  }
}
function generateSdkId() {
  return `sdk-${crypto.randomUUID()}`;
}
function generateClientLaunchId() {
  return generateSdkId();
}
function generateClientTradeId() {
  return generateSdkId();
}
var SDK_VERSION = "0.4.6";
var sdkUpdateWarned = false;
function noteLatestSdkVersion(value) {
  if (sdkUpdateWarned || !value || !/^\d+\.\d+\.\d+$/.test(value))
    return;
  const [a1 = 0, a2 = 0, a3 = 0] = value.split(".").map(Number);
  const [b1 = 0, b2 = 0, b3 = 0] = SDK_VERSION.split(".").map(Number);
  const isNewer = a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3;
  if (!isNewer)
    return;
  if (typeof process !== "undefined" && process.env?.CANDLE_NO_UPDATE_NOTICE)
    return;
  sdkUpdateWarned = true;
  console.warn(`@candledottv/agent-sdk ${value} is available (running ${SDK_VERSION}). Update: npm install @candledottv/agent-sdk@latest (set CANDLE_NO_UPDATE_NOTICE=1 to silence)`);
}
// src/keychain-secret-store.ts
import { spawn, spawnSync } from "node:child_process";
var SERVICE = "tv.candle.cli";
function walletSignerRef(walletRef) {
  return `wallet_signer_${walletRef}`;
}
function pemToStoredSigner(pem) {
  return pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
}
function storedSignerToPem(stored) {
  const lines = stored.match(/.{1,64}/g) ?? [stored];
  return `-----BEGIN PRIVATE KEY-----
${lines.join(`
`)}
-----END PRIVATE KEY-----
`;
}
function assertStorable(value) {
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
    throw new Error("Refusing to store a signer value that is not single-line base64");
  }
}
var UNSAFE_FOR_SECURITY_COMMAND_LINE = /["\\\n\r]/;
function assertSafeRef(ref) {
  if (UNSAFE_FOR_SECURITY_COMMAND_LINE.test(ref)) {
    throw new Error("Refusing to use this wallet reference against the macOS Keychain: it contains a quote, " + "backslash, or newline, which could break out of the quoted argument on security's " + "command-on-stdin line");
  }
}
var RUN_TIMEOUT_MS = 1e4;
var realExec = (binary, args, stdin) => new Promise((resolvePromise, reject) => {
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  let stdout = "";
  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled)
      child.kill("SIGKILL");
  }, RUN_TIMEOUT_MS);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.on("error", (err) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timeout);
    reject(err);
  });
  child.on("close", (status) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timeout);
    resolvePromise({ status: status ?? 1, stdout });
  });
  if (stdin !== undefined)
    child.stdin.write(stdin);
  child.stdin.end();
});

class KeychainSecretStore {
  backend;
  exec;
  constructor(opts = {}) {
    this.backend = opts.backend ?? (process.platform === "darwin" ? "security" : "secret-tool");
    this.exec = opts.exec ?? realExec;
  }
  static detect() {
    const backend = process.platform === "darwin" ? "security" : "secret-tool";
    const found = spawnSync("which", [backend], { env: process.env }).status === 0;
    return found ? new KeychainSecretStore({ backend }) : null;
  }
  async get(walletRef) {
    const ref = walletSignerRef(walletRef);
    const result = this.backend === "security" ? await this.exec("security", ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"]) : await this.exec("secret-tool", ["lookup", "service", SERVICE, "account", ref]);
    if (result.status !== 0)
      return null;
    const value = result.stdout.replace(/\n$/, "");
    if (value.length === 0)
      return null;
    return value.includes("BEGIN PRIVATE KEY") ? value : storedSignerToPem(value);
  }
  async set(walletRef, privateKeyPem) {
    const ref = walletSignerRef(walletRef);
    const value = pemToStoredSigner(privateKeyPem);
    assertStorable(value);
    if (this.backend === "security") {
      assertSafeRef(ref);
      const command = `add-generic-password -U -s "${SERVICE}" -a "${ref}" -w "${value}"
`;
      const result2 = await this.exec("security", ["-i"], command);
      if (result2.status !== 0)
        throw new Error(`Failed to store signer in the macOS Keychain (${result2.status})`);
      return;
    }
    const result = await this.exec("secret-tool", ["store", "--label=Candle CLI", "service", SERVICE, "account", ref], value);
    if (result.status !== 0)
      throw new Error(`Failed to store signer via secret-tool (${result.status})`);
  }
  async delete(walletRef) {
    const ref = walletSignerRef(walletRef);
    if (this.backend === "security") {
      assertSafeRef(ref);
      await this.exec("security", ["-i"], `delete-generic-password -s "${SERVICE}" -a "${ref}"
`);
      return;
    }
    await this.exec("secret-tool", ["clear", "service", SERVICE, "account", ref]);
  }
}
// src/file-lock.ts
var STALE_MS = 30000;
var RETRY_MS = 25;
var TIMEOUT_MS = 1e4;
async function withFileLock(target, fn) {
  const { open, rm, stat } = await import("node:fs/promises");
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + TIMEOUT_MS;
  for (;; ) {
    try {
      await (await open(lockPath, "wx")).close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${lockPath}. Another candle process is writing; if none is running, delete that file.`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

// src/secret-store.ts
class InMemorySecretStore {
  entries = new Map;
  async get(walletRef) {
    return this.entries.get(walletRef) ?? null;
  }
  async set(walletRef, privateKeyPem) {
    this.entries.set(walletRef, privateKeyPem);
  }
  async delete(walletRef) {
    this.entries.delete(walletRef);
  }
}
var PBKDF2_ITERATIONS = 210000;
var SALT_LENGTH_BYTES = 16;
var IV_LENGTH_BYTES = 12;
async function deriveKey(passphrase, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

class EncryptedFileSecretStore {
  path;
  passphrase;
  constructor(path, passphrase) {
    this.path = path;
    this.passphrase = passphrase;
  }
  async get(walletRef) {
    const contents = await this.readFile();
    const entry = contents[walletRef];
    if (!entry)
      return null;
    const salt = fromBase64(entry.salt);
    const key = await deriveKey(this.passphrase, salt, entry.iterations);
    const iv = fromBase64(entry.iv);
    const ciphertext = fromBase64(entry.ciphertext);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  }
  async set(walletRef, privateKeyPem) {
    return withFileLock(this.path, async () => {
      const contents = await this.readFile();
      const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
      const key = await deriveKey(this.passphrase, salt, PBKDF2_ITERATIONS);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(privateKeyPem));
      contents[walletRef] = {
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
        iterations: PBKDF2_ITERATIONS
      };
      await this.writeFile(contents);
    });
  }
  async delete(walletRef) {
    return withFileLock(this.path, async () => {
      const contents = await this.readFile();
      if (!Object.hasOwn(contents, walletRef))
        return;
      delete contents[walletRef];
      await this.writeFile(contents);
    });
  }
  async readFile() {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT")
        return {};
      throw err;
    }
  }
  async writeFile(contents) {
    const { chmod, mkdir, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 448);
    const tmpPath = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(contents, null, 2), { encoding: "utf8", mode: 384 });
    await chmod(tmpPath, 384);
    await rename(tmpPath, this.path);
  }
}
// src/webhooks.ts
import { createHmac, timingSafeEqual } from "node:crypto";
function verifyWebhookSignature(secret, header, body, nowSec, toleranceSec = 300) {
  if (!secret || !header)
    return false;
  let t;
  let v1;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1)
      return false;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t")
      t = value;
    else if (key === "v1")
      v1 = value;
  }
  if (!t || !v1)
    return false;
  if (!/^\d+$/.test(t))
    return false;
  if (!/^[0-9a-fA-F]+$/.test(v1))
    return false;
  const timestamp = Number(t);
  if (!Number.isSafeInteger(timestamp))
    return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec)
    return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const provided = Buffer.from(v1.toLowerCase(), "hex");
  if (provided.length !== expected.length)
    return false;
  return timingSafeEqual(provided, expected);
}
export {
  verifyWebhookSignature,
  verifyPerpsBuild,
  isSolanaRpcErrorData,
  hyperliquidActionHash,
  generateSignerKeypair,
  encryptWalletKeyForImport,
  KeychainSecretStore,
  JsonRpcError,
  InMemorySecretStore,
  HYPERLIQUID_EXCHANGE_URLS,
  HYPERLIQUID_ALLOWED_ACTION_TYPES,
  EncryptedFileSecretStore,
  CandleClient,
  CandleApiError,
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  BRIDGE_ERROR_CODES
};
