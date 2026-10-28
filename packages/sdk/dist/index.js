import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/client.ts
import { keccak_256 as keccak_2562 } from "@noble/hashes/sha3";
import { base58 as base582 } from "@scure/base";

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
  legs;
  code;
  status;
  retryable;
  field;
  routing;
  discovery;
  coverage;
  uiHint;
  docsPath;
  stage;
  signature;
  mint;
  recorded;
  feeRaw;
  quoteAsset;
  treasury;
  reason;
  retryAfter;
  constructor(args) {
    super(args.message);
    this.name = "CandleApiError";
    this.legs = args.legs;
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
    if (args.stage !== undefined)
      this.stage = args.stage;
    if (args.signature !== undefined)
      this.signature = args.signature;
    if (args.mint !== undefined)
      this.mint = args.mint;
    if (args.recorded !== undefined)
      this.recorded = args.recorded;
    if (args.feeRaw !== undefined)
      this.feeRaw = args.feeRaw;
    if (args.quoteAsset !== undefined)
      this.quoteAsset = args.quoteAsset;
    if (args.treasury !== undefined)
      this.treasury = args.treasury;
    if (args.reason !== undefined)
      this.reason = args.reason;
    if (args.retryAfter !== undefined)
      this.retryAfter = args.retryAfter;
  }
}

class TradeLegOutcomeError extends Error {
  clientTradeId;
  leg;
  outcome;
  txHash;
  landedLegs;
  cause;
  constructor(args) {
    super((args.cause instanceof Error ? args.cause.message + ". " : "") + "A Hood trade leg failed. Inspect txHash and landedLegs on chain; read getTradeJob(clientTradeId) or call trade with the same id and body for Candle's view. Never retry a retryable:false answer.", { cause: args.cause });
    this.name = "TradeLegOutcomeError";
    this.clientTradeId = args.clientTradeId;
    this.leg = args.leg;
    this.outcome = args.outcome;
    this.txHash = args.txHash;
    this.landedLegs = args.landedLegs;
    this.cause = args.cause;
  }
}

class TradeLandedUnconfirmedError extends Error {
  clientTradeId;
  tradeTxHash;
  feeTxHash;
  stage = "executed";
  cause;
  constructor(args) {
    super("The trade is on chain and not booked. Read getTradeJob(clientTradeId) before calling confirmTrade again with these hashes. If the row is failed, this id cannot be recorded with /confirm; retain the hashes and do not retry or rebuild.", { cause: args.cause });
    this.name = "TradeLandedUnconfirmedError";
    this.clientTradeId = args.clientTradeId;
    this.tradeTxHash = args.tradeTxHash;
    this.feeTxHash = args.feeTxHash;
    this.cause = args.cause;
  }
}

class TradeLandedFeeLegError extends Error {
  clientTradeId;
  tradeTxHash;
  feeTxHash;
  feeOutcome;
  stage = "executed";
  constructor(args) {
    const reason = args.cause instanceof Error ? args.cause.message : String(args.cause);
    const recover = args.feeOutcome === "unknown" ? args.feeTxHash ? `Do NOT repeat the trade. Do NOT pay again: the fee may already be pending or mined. Check feeTxHash ` + `${args.feeTxHash} and re-confirm clientTradeId ${args.clientTradeId} with tradeTxHash ` + `${args.tradeTxHash} and that same feeTxHash.` : `Do NOT repeat the trade. Do NOT pay again: the fee broadcast outcome is unknown and it may already ` + `be pending or mined. Check the payer wallet before any new payment, then re-confirm clientTradeId ` + `${args.clientTradeId} with tradeTxHash ${args.tradeTxHash} and the fee hash you find.` : `Do NOT repeat the trade: pay the fee, then call confirmTrade for clientTradeId ${args.clientTradeId} ` + `with tradeTxHash and the fee's feeTxHash.`;
    super(`trade executed; fee/booking incomplete: the trade landed (tradeTxHash ${args.tradeTxHash}) but its fee ` + `transfer ${args.feeOutcome === "unknown" ? "outcome is unknown" : "failed"} (${reason}). The trade is ` + `NOT confirmed or booked. ${recover}`, { cause: args.cause });
    this.name = "TradeLandedFeeLegError";
    this.clientTradeId = args.clientTradeId;
    this.tradeTxHash = args.tradeTxHash;
    this.feeOutcome = args.feeOutcome;
    if (args.feeTxHash !== undefined)
      this.feeTxHash = args.feeTxHash;
  }
}
function selfLaunchOutcomeMessage(args) {
  const reason = args.cause instanceof Error ? args.cause.message : String(args.cause);
  const feeTxHash = "feeTxHash" in args ? args.feeTxHash : undefined;
  const head = `launch executed; ${args.step === "confirm" ? "confirmation" : "fee"} incomplete: the Hood curve is on chain ` + `(createCurveTxHash ${args.createCurveTxHash}, clientLaunchId ${args.clientLaunchId}), and a later step ` + `failed (${reason}). Do NOT call selfLaunch() or buildSelfLaunch() again for this attempt, under this id ` + `or a new one: a rebuild can create a second curve. Keep the id and every hash on this error.`;
  const confirmWith = (fee) => `confirmSelfLaunch({ clientLaunchId, signature: createCurveTxHash${fee} }) for clientLaunchId ${args.clientLaunchId}`;
  if (args.step === "confirm") {
    const fee = args.feeOutcome === "landed" ? `The fee transfer landed (feeTxHash ${feeTxHash}).` : "This build had no fee transfer, so none is owed.";
    return `${head} ${fee} The confirm call was refused or its answer was lost, so Candle may or may not have ` + `recorded the launch: read getLaunchJob(clientLaunchId). If the job is not confirmed and this error's ` + `cause allows it, call ${confirmWith(args.feeOutcome === "landed" ? ", feeTxHash" : "")} with these same ` + `hashes. Nothing needs signing or sending.`;
  }
  if (args.feeOutcome === "unknown") {
    return `${head} The fee transfer MAY have paid: its outcome is unknown. Do NOT pay it again. ` + (feeTxHash ? `Check feeTxHash ${feeTxHash} and the payer wallet's history; a hash alone does not prove payment. ` : "Its hash is not known: reconcile the payer wallet's transactions before any payment decision. ") + `Once that exact fee is verified successful, call ${confirmWith(", feeTxHash")}.`;
  }
  const proof = args.feeOutcome === "reverted" ? `its receipt reverted${feeTxHash ? ` (feeTxHash ${feeTxHash})` : ""}` : `it was not broadcast${feeTxHash ? ` (feeTxHash ${feeTxHash} names the refused transaction, not a payment)` : ""}`;
  return `${head} The fee transfer did NOT pay: ${proof}. The launch is not recorded without it. Pay only the ` + `missing fee, to the original build's treasury in its quote asset and raw amount, then call ` + `${confirmWith(", feeTxHash")} with the successful fee hash.`;
}

class SelfLaunchOutcomeError extends Error {
  name = "SelfLaunchOutcomeError";
  chain = "hood";
  clientLaunchId;
  createCurveTxHash;
  stage = "executed";
  step;
  feeOutcome;
  cause;
  constructor(args) {
    super(selfLaunchOutcomeMessage(args), { cause: args.cause });
    this.clientLaunchId = args.clientLaunchId;
    this.createCurveTxHash = args.createCurveTxHash;
    this.step = args.step;
    this.feeOutcome = args.feeOutcome;
    if ("feeTxHash" in args && args.feeTxHash !== undefined)
      this.feeTxHash = args.feeTxHash;
    this.cause = args.cause;
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
function operationErrorMessage(cause, ids, flow) {
  const original = cause instanceof Error ? cause.message : String(cause);
  const isTrade = ids.clientTradeId !== undefined;
  const idName = isTrade ? "clientTradeId" : "clientLaunchId";
  const noun = isTrade ? "trade" : "launch";
  const read = isTrade ? "getTradeJob()" : "getLaunchJob()";
  const bundle = ids.bundleId !== undefined ? ` (bundleId ${ids.bundleId}, single-use: for logs only, never resubmitted)` : "";
  const head = `${original} -- ${idName} ${ids.clientTradeId ?? ids.clientLaunchId}${bundle}: ` + "the request may or may not have reached Candle.";
  const tail = `A call with a new id, or with none, is a second, independent ${noun}.`;
  if (flow === "server-executed") {
    return `${head} Read the job for this id (${read}), or retry the call with this same ${idName} and the same request. ${tail}`;
  }
  return `${head} This id identifies the job: read the job for this id (${read}), and check the wallet's recent ` + `transactions before sending again, because a call under the same id can sign and broadcast a second ` + `transaction. ${tail}`;
}

class CandleOperationError extends Error {
  constructor(args) {
    super(operationErrorMessage(args.cause, args.ids, args.flow), { cause: args.cause });
    this.name = "CandleOperationError";
    Object.assign(this, definedIds(args.ids));
  }
}
function definedIds(ids) {
  return {
    ...typeof ids.clientTradeId === "string" ? { clientTradeId: ids.clientTradeId } : {},
    ...typeof ids.clientLaunchId === "string" ? { clientLaunchId: ids.clientLaunchId } : {},
    ...typeof ids.bundleId === "string" ? { bundleId: ids.bundleId } : {}
  };
}
function operationIds(error) {
  if (error instanceof CandleApiError || error instanceof JsonRpcError || error instanceof TradeLandedFeeLegError || error instanceof TradeLegOutcomeError || error instanceof TradeLandedUnconfirmedError || error instanceof SelfLaunchOutcomeError || error instanceof CandleOperationError) {
    return definedIds(error);
  }
  return {};
}
function withOperationIds(error, ids, flow) {
  if (error instanceof CandleApiError || error instanceof JsonRpcError)
    return Object.assign(error, definedIds(ids));
  if (error instanceof TradeLandedFeeLegError || error instanceof TradeLegOutcomeError || error instanceof TradeLandedUnconfirmedError || error instanceof SelfLaunchOutcomeError)
    return error;
  if (error instanceof CandleOperationError) {
    return new CandleOperationError({ cause: error.cause, ids: { ...operationIds(error), ...definedIds(ids) }, flow });
  }
  return new CandleOperationError({ cause: error, ids, flow });
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
    ...typeof error.retryable === "boolean" ? { retryable: error.retryable } : {},
    ...Array.isArray(error.legs) ? { legs: error.legs } : {},
    ...typeof error.stage === "string" ? { stage: error.stage } : {},
    ...typeof error.signature === "string" ? { signature: error.signature } : {},
    ...typeof error.mint === "string" ? { mint: error.mint } : {},
    ...typeof error.recorded === "boolean" ? { recorded: error.recorded } : {},
    ...typeof error.feeRaw === "string" ? { feeRaw: error.feeRaw } : {},
    ...typeof error.quoteAsset === "string" ? { quoteAsset: error.quoteAsset } : {},
    ...typeof error.treasury === "string" ? { treasury: error.treasury } : {},
    ...typeof error.reason === "string" ? { reason: error.reason } : {},
    ...typeof error.retryAfter === "number" ? { retryAfter: error.retryAfter } : {}
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
  "updateIsolatedMargin",
  "scheduleCancel"
];
var HYPERLIQUID_EXCHANGE_URLS = {
  mainnet: "https://api.hyperliquid.xyz/exchange",
  testnet: "https://api.hyperliquid-testnet.xyz/exchange"
};
var HYPERLIQUID_INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info"
};
var CANDLE_HYPERLIQUID_BUILDER_ADDRESS = "0xc43ff1f6ad9f93fc94558e07c2071b8458e7470b";
function resolveHyperliquidBuilder(override, releasePin = CANDLE_HYPERLIQUID_BUILDER_ADDRESS) {
  const builder = override === undefined ? releasePin : override;
  if (typeof builder !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(builder) || /^0x0{40}$/.test(builder))
    throw new Error("PERPS_BUILD_REFUSED: no valid nonzero Hyperliquid builder address in the explicit override or release pin.");
  return builder.toLowerCase();
}
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
var HYPERLIQUID_CLOID_RE = /^0x[0-9a-f]{32}$/;
var HYPERLIQUID_STANDARD_ACCOUNT_MODES = ["default", "disabled"];
async function hyperliquidAccountMode(fetcher, network, address) {
  const res = await fetcher(HYPERLIQUID_INFO_URLS[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "userAbstraction", user: address.toLowerCase() })
  });
  if (!res.ok)
    throw new Error("Cannot read the account mode from Hyperliquid");
  let mode;
  try {
    mode = JSON.parse(await res.text());
  } catch {
    throw new Error("Hyperliquid returned an unreadable account mode");
  }
  if (typeof mode !== "string" || mode.length === 0 || mode.length > 64)
    throw new Error("Hyperliquid returned an unreadable account mode");
  return mode;
}
function perpsSetupStatusProblem(status, expect) {
  if (!HYPERLIQUID_STANDARD_ACCOUNT_MODES.includes(expect.mode))
    return `the account is in ${expect.mode} mode on Hyperliquid; Candle trades only a standard account`;
  if (status.network !== expect.network)
    return `the setup answer is for ${String(status.network)}`;
  if (typeof status.address !== "string" || status.address.toLowerCase() !== expect.address.toLowerCase())
    return "the setup answer is for a different wallet";
  if (status.mode !== expect.mode)
    return "the setup answer reports a mode Hyperliquid does not";
  if (status.standardMode !== true)
    return "the setup answer does not report standard mode";
  if (typeof status.builder !== "string" || status.builder.toLowerCase() !== expect.builder.toLowerCase())
    return "the setup answer names a builder that is not Candle's";
  if (status.ready === true && (typeof status.approvedFeeTenthsBps !== "number" || status.approvedFeeTenthsBps < HYPERLIQUID_MAX_BUILDER_FEE_TENTHS_BPS))
    return "the setup answer reports ready without Candle's builder approval";
  return null;
}
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
var ACTION_KEYS = {
  order: { required: ["type", "orders", "grouping"], optional: ["builder"] },
  cancel: { required: ["type", "cancels"], optional: [] },
  modify: { required: ["type", "oid", "order"], optional: [] },
  updateLeverage: { required: ["type", "asset", "isCross", "leverage"], optional: [] },
  updateIsolatedMargin: { required: ["type", "asset", "isBuy", "ntli"], optional: [] },
  scheduleCancel: { required: ["type"], optional: ["time"] }
};
function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
function actionShapeProblem(action) {
  const shape = ACTION_KEYS[String(action.type)];
  if (!shape)
    return null;
  if (!exactKeys(action, shape.required, shape.optional))
    return `the ${String(action.type)} action carries unexpected or missing fields`;
  if (action.type === "order") {
    if (!["na", "normalTpsl", "positionTpsl"].includes(action.grouping))
      return "unexpected order grouping";
    if (action.builder !== undefined && !exactKeys(action.builder, ["b", "f"]))
      return "builder field is not an object";
  }
  const orders = action.type === "order" ? action.orders : action.type === "modify" ? [action.order] : [];
  if (!Array.isArray(orders))
    return "invalid orders";
  for (const raw of orders) {
    if (!exactKeys(raw, ["a", "b", "p", "s", "r", "t"], ["c"]))
      return "an order carries unexpected or missing fields";
    const o = raw;
    const t = o.t;
    const limit = exactKeys(t, ["limit"]) && exactKeys(t.limit, ["tif"]);
    const trigger = exactKeys(t, ["trigger"]) && exactKeys(t.trigger, ["isMarket", "triggerPx", "tpsl"]);
    if (!limit && !trigger)
      return "an order type carries unexpected or missing fields";
    if (o.c !== undefined && (typeof o.c !== "string" || !HYPERLIQUID_CLOID_RE.test(o.c)))
      return "an order carries a malformed client order id";
  }
  if (action.type === "cancel") {
    const cancels = action.cancels;
    if (!Array.isArray(cancels) || cancels.some((c) => !exactKeys(c, ["a", "o"]) || !Number.isSafeInteger(c.o) || c.o < 0))
      return "a cancel carries unexpected or missing fields";
  }
  if (action.type === "modify") {
    const oid = action.oid;
    if (!(Number.isSafeInteger(oid) && oid >= 0) && !(typeof oid === "string" && HYPERLIQUID_CLOID_RE.test(oid)))
      return "the modify names no order";
  }
  if (action.type === "scheduleCancel" && "time" in action && (!Number.isSafeInteger(action.time) || action.time <= 0))
    return "the scheduled cancel carries an invalid time";
  return null;
}
function withinBps(px, reference, isBuy, bps) {
  const bound = BigInt(bps);
  return isBuy ? px * 10000n <= reference * (10000n + bound) : px * 10000n >= reference * (10000n - bound);
}
function checkActionIntent(action, opts) {
  const intent = opts.intent;
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
    if (opts.keyReduceOnly === true && o.r !== true)
      return "this key is reduce-only and the build is not reducing";
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
    margin: "updateIsolatedMargin",
    tpsl: "order",
    scheduleCancel: "scheduleCancel"
  };
  if (action.type !== types[method])
    return "action type does not match the requested method";
  if (opts.keyReduceOnly === true && method === "open")
    return "this key is reduce-only and an open is not reducing";
  if (method === "cancel" && opts.cancelTarget) {
    const target = action.cancels[0];
    if (target?.a !== opts.cancelTarget.asset || target?.o !== opts.cancelTarget.oid)
      return "the cancel does not name the order Hyperliquid shows for this request";
  }
  if (method === "leverage") {
    const wanted = p.leverage ?? opts.leverageTarget?.leverage;
    const deferred = wanted === undefined && opts.awaitingVenue === true && Number.isSafeInteger(action.leverage);
    if (!deferred && (typeof wanted !== "number" || action.leverage !== wanted) || action.isCross !== (p.mode !== "isolated"))
      return "leverage or mode does not match the request";
    const target = opts.leverageTarget;
    if (target) {
      if (action.asset !== target.asset)
        return "leverage asset is not the requested coin's on Hyperliquid";
      const mode = action.isCross ? "cross" : "isolated";
      if (mode !== target.mode && !target.flat)
        return "a margin-mode change needs no position and no resting order in the coin; close and cancel first";
      if (opts.keyReduceOnly === true && (mode !== target.mode || action.leverage > target.leverage))
        return "this key is reduce-only: no leverage increase or margin-mode change";
    }
  }
  if (method === "margin") {
    const amount = decimal(p.amount);
    if (amount === null || amount % 10n ** 12n !== 0n || !Number.isSafeInteger(action.ntli) || BigInt(action.ntli) !== amount / 10n ** 12n || action.isBuy !== true)
      return "isolated margin amount does not match the request";
    if (opts.marginTarget && action.asset !== opts.marginTarget.asset)
      return "margin asset is not the requested coin's on Hyperliquid";
    if (opts.keyReduceOnly === true && action.ntli <= 0)
      return "this key is reduce-only: margin may only be added";
  }
  if (method === "scheduleCancel") {
    if (p.clear === true) {
      if ("time" in action)
        return "a clear must omit the time";
    } else {
      const seconds = p.seconds;
      const time = action.time;
      if (!Number.isSafeInteger(seconds) || seconds < 5)
        return "a scheduled cancel needs at least 5 seconds";
      if (!Number.isSafeInteger(time))
        return "a scheduled cancel without a time";
      if (opts.clock) {
        const lead = time - opts.clock.now;
        if (lead < HYPERLIQUID_SCHEDULE_CANCEL_MIN_LEAD_MS)
          return "the scheduled time is less than 5 seconds ahead; build it again";
        if (Math.abs(time - (opts.clock.now + seconds * 1000)) > HYPERLIQUID_SCHEDULE_CANCEL_DRIFT_MS)
          return "the scheduled time is not the requested delay from now";
      }
    }
  }
  if (method === "tpsl") {
    const list = orderList;
    const leg = list[0];
    if (list.length !== 1 || !leg || action.grouping !== "positionTpsl")
      return "a take-profit / stop-loss attach is one positionTpsl order";
    const trigger = leg.t?.trigger;
    if (!trigger || leg.r !== true || trigger.isMarket !== true || trigger.tpsl !== p.leg || decimal(trigger.triggerPx) !== decimal(p.triggerPx))
      return "trigger leg, reduce-only flag or price does not match the request";
    if (typeof leg.c !== "string" || !HYPERLIQUID_CLOID_RE.test(leg.c))
      return "the trigger leg carries no client order id";
    const triggerPx = decimal(trigger.triggerPx) ?? 0n;
    if (triggerPx <= 0n || !withinBps(decimal(leg.p) ?? 0n, triggerPx, leg.b === true, HYPERLIQUID_TPSL_SLIPPAGE_BPS + HYPERLIQUID_MID_DRIFT_BPS))
      return "trigger order price is outside its slippage of the trigger price";
    const target = opts.tpslTarget;
    if (target) {
      if (leg.a !== target.asset || leg.b !== target.isBuy || decimal(leg.s) !== decimal(target.size))
        return "trigger side, asset or size does not match the position Hyperliquid shows";
      const mark = decimal(target.markPx) ?? 0n;
      const above = triggerPx > mark;
      const ok = p.leg === "tp" === !target.isBuy ? above : triggerPx < mark;
      if (mark <= 0n || !ok)
        return "the trigger is already crossed or on the wrong side of the mark";
    }
  }
  if (method === "open" || method === "close" || method === "modify") {
    const list = orderList;
    const first = list[0];
    if (!first)
      return "missing requested order";
    if ((method === "open" || method === "close") && p.clientId != null) {
      const clientId = typeof p.clientId === "string" ? p.clientId.toLowerCase() : null;
      if (clientId === null || !HYPERLIQUID_CLOID_RE.test(clientId) || first.c !== clientId)
        return "the order does not carry the requested client order id";
      const ids = list.map((o) => o.c);
      if (ids.some((c) => typeof c !== "string" || !HYPERLIQUID_CLOID_RE.test(c)) || new Set(ids).size !== ids.length)
        return "the order legs do not carry distinct client order ids";
    }
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
        const px = decimal(leg.p) ?? 0n;
        const triggerPx = decimal(trigger.triggerPx) ?? 0n;
        if (triggerPx <= 0n || !withinBps(px, triggerPx, leg.b === true, HYPERLIQUID_TPSL_SLIPPAGE_BPS + HYPERLIQUID_MID_DRIFT_BPS))
          return "trigger order price is outside its slippage of the trigger price";
      }
    } else {
      if (list.length !== 1)
        return "unexpected extra orders";
      if (method === "close" && p.pct != null && p.size != null)
        return "a close takes a size or a percentage, not both";
      if (method === "close" && (first.r !== true || typ.limit.tif !== "Ioc" || action.grouping !== "na" || p.size != null && (decimal(first.s) ?? 0n) > (decimal(p.size) ?? 0n)))
        return "close size or reduce-only flag does not match the request";
      if (method === "modify" && p.size != null && decimal(first.s) !== decimal(p.size))
        return "replacement size does not match the request";
    }
    if (p.price != null && decimal(first.p) !== decimal(p.price))
      return "order price does not match the request";
  }
  return null;
}
function hyperliquidClosePct(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/.test(value))
    return null;
  const [whole = "0", frac = ""] = value.split(".");
  const millionths = BigInt(whole) * 10000n + BigInt(frac.padEnd(4, "0"));
  return millionths > 0n && millionths <= 1000000n ? millionths : null;
}
function hyperliquidPctSize(held, pct, szDecimals) {
  const scaled = decimal(held);
  if (scaled === null || scaled < 0n)
    throw new Error("Invalid held size");
  if (pct === 1000000n)
    return held;
  return hyperliquidFloorSize(formatScaled(scaled * pct / 1000000n), szDecimals);
}
function hyperliquidFloorSize(value, szDecimals) {
  const scaled = decimal(value);
  if (scaled === null || scaled < 0n)
    throw new Error("Invalid size");
  const unit = 10n ** BigInt(18 - Math.max(0, Math.min(18, szDecimals)));
  return formatScaled(scaled / unit * unit);
}
function formatScaled(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
async function hyperliquidCloseOrder(fetcher, network, address, params) {
  const read = async (body) => {
    const res = await fetcher(HYPERLIQUID_INFO_URLS[network], {
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
  const universe = meta.universe;
  const asset = universe.findIndex((m) => m.name.toUpperCase() === coin);
  const szi = state.assetPositions.find((p) => p.position.coin.toUpperCase() === coin)?.position.szi;
  const signed = decimal(szi);
  if (asset < 0 || asset >= 1e4 || signed === null || signed === 0n)
    throw new Error("No main-universe position to close");
  const held = signed < 0n ? -signed : signed;
  const heldSz = String(szi).replace(/^-/, "");
  if (params.pct != null) {
    if (params.size != null)
      throw new Error("A close takes a size or a percentage, not both");
    const pct = hyperliquidClosePct(params.pct);
    const szDecimals = universe[asset]?.szDecimals;
    if (pct === null)
      throw new Error("pct must be above 0 and at most 100, with at most 4 decimals");
    if (!Number.isInteger(szDecimals))
      throw new Error("Hyperliquid did not report this market's size precision");
    const size2 = hyperliquidPctSize(heldSz, pct, szDecimals);
    if ((decimal(size2) ?? 0n) <= 0n)
      throw new Error("This percentage of the position rounds to zero at the market's size step");
    return { asset, isBuy: signed < 0n, size: size2 };
  }
  const asked = params.size == null ? held : decimal(params.size);
  if (asked === null || asked <= 0n)
    throw new Error("Invalid close size");
  const size = asked < held ? String(params.size) : heldSz;
  return { asset, isBuy: signed < 0n, size };
}
var HYPERLIQUID_DEFAULT_SLIPPAGE_BPS = 100;
var HYPERLIQUID_MID_DRIFT_BPS = 100;
var HYPERLIQUID_TPSL_SLIPPAGE_BPS = 500;
async function hyperliquidOrderMarket(fetcher, network, address, method, params) {
  const read = async (body) => {
    const res = await fetcher(HYPERLIQUID_INFO_URLS[network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok)
      throw new Error("Cannot read the market from Hyperliquid");
    return JSON.parse(await res.text());
  };
  let coin = String(params.coin ?? "").toUpperCase();
  let order;
  if (method === "modify") {
    const status = await read({ type: "orderStatus", user: address, oid: params.cloid });
    const resting = status?.order?.order ?? null;
    if (!resting || typeof resting.coin !== "string" || decimal(resting.limitPx) === null)
      throw new Error("No resting order with this cloid on Hyperliquid");
    if (resting.isTrigger === true)
      throw new Error("A take-profit or stop-loss leg cannot be modified; cancel it instead");
    coin = resting.coin.toUpperCase();
    const tif = typeof resting.tif === "string" && ["Gtc", "Alo", "Ioc"].includes(resting.tif) ? resting.tif : "Gtc";
    order = {
      isBuy: resting.side === "B",
      limitPx: String(resting.limitPx),
      ...decimal(resting.sz) !== null ? { size: String(resting.sz) } : {},
      reduceOnly: resting.reduceOnly === true,
      tif,
      ...Number.isSafeInteger(resting.oid) ? { oid: resting.oid } : {}
    };
  }
  const [meta, contexts] = await read({ type: "metaAndAssetCtxs" });
  const asset = meta.universe.findIndex((m) => m.name.toUpperCase() === coin);
  if (asset < 0 || asset >= 1e4)
    throw new Error("No main-universe market for this coin on Hyperliquid");
  const context = contexts[asset];
  const midPx = context?.midPx ?? context?.markPx;
  if ((decimal(midPx) ?? 0n) <= 0n)
    throw new Error("No Hyperliquid price for this coin");
  return { asset, midPx: String(midPx), ...order ? { order } : {} };
}
function checkOrderMarket(action, intent, market) {
  const list = action.type === "modify" ? [action.order] : action.orders;
  if (!Array.isArray(list) || list.length === 0)
    return "missing requested order";
  if (list.some((o) => !o || o.a !== market.asset))
    return "order asset is not the requested coin's on Hyperliquid";
  const first = list[0];
  const p = intent.params;
  if (intent.method === "open" && p.price == null) {
    const requested = p.slippageBps;
    const slippage = typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? requested : HYPERLIQUID_DEFAULT_SLIPPAGE_BPS;
    const bound = BigInt(slippage + HYPERLIQUID_MID_DRIFT_BPS);
    const px = decimal(first.p) ?? 0n;
    const mid = decimal(market.midPx) ?? 0n;
    const within = first.b === true ? px * 10000n <= mid * (10000n + bound) : px * 10000n >= mid * (10000n - bound);
    if (mid <= 0n || !within)
      return "market order price is outside its slippage of Hyperliquid's mid";
  }
  if (intent.method === "modify") {
    if (!market.order)
      return "no resting order on Hyperliquid to check the modify against";
    if (first.b !== market.order.isBuy)
      return "modify changes the resting order's side";
    if (p.price == null && decimal(first.p) !== decimal(market.order.limitPx))
      return "modify changes the resting order's price";
    const requested = typeof p.cloid === "string" ? p.cloid.toLowerCase() : null;
    const byOid = market.order.oid !== undefined && action.oid === market.order.oid;
    const byCloid = requested !== null && typeof action.oid === "string" && action.oid.toLowerCase() === requested;
    if (!byOid && !byCloid)
      return "modify does not name the resting order Hyperliquid shows for this cloid";
    if (first.r !== market.order.reduceOnly)
      return "modify changes the resting order's reduce-only flag";
    if (first.t?.limit?.tif !== market.order.tif)
      return "modify changes the resting order's time in force";
    if (p.size == null && (market.order.size === undefined || decimal(first.s) !== decimal(market.order.size)))
      return "modify changes the resting order's size";
  }
  return null;
}
function verifyPerpsBuild(build, opts) {
  try {
    const network = opts.network ?? "mainnet";
    if (!EVM_ADDRESS_RE.test(opts.builder) || opts.builder.toLowerCase() === ZERO_ADDRESS)
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
    const intentRefusal = checkActionIntent(action, opts);
    if (intentRefusal)
      return { ok: false, reason: intentRefusal };
    if (opts.closeOrder) {
      const order = action.orders[0];
      if (!order || order.a !== opts.closeOrder.asset || order.b !== opts.closeOrder.isBuy || decimal(order.s) !== decimal(opts.closeOrder.size) || order.r !== true)
        return { ok: false, reason: "close side, asset or size does not match the requested position" };
    }
    if (opts.market) {
      if (opts.intent?.method !== "open" && opts.intent?.method !== "modify")
        return { ok: false, reason: "a market check needs an open or modify intent" };
      const marketRefusal = checkOrderMarket(action, opts.intent, opts.market);
      if (marketRefusal)
        return { ok: false, reason: marketRefusal };
    }
    if (typed.primary_type === "Agent") {
      const type = action.type;
      if (typeof type !== "string" || !HYPERLIQUID_ALLOWED_ACTION_TYPES.includes(type)) {
        return { ok: false, reason: `action type ${String(type)} is not one Candle builds` };
      }
      const shapeRefusal = actionShapeProblem(action);
      if (shapeRefusal)
        return { ok: false, reason: shapeRefusal };
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
var HYPERLIQUID_SCHEDULE_CANCEL_MIN_LEAD_MS = 5000;
var HYPERLIQUID_SCHEDULE_CANCEL_DRIFT_MS = 60000;
async function infoRead(fetcher, network, body) {
  const res = await fetcher(HYPERLIQUID_INFO_URLS[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok)
    throw new Error(`Hyperliquid ${String(body.type)} answered ${res.status ?? "an error"}`);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error(`Hyperliquid returned an unreadable ${String(body.type)}`);
  }
}
async function hyperliquidWalletSnapshot(fetcher, network, address, now = Date.now) {
  const user = address.toLowerCase();
  const [metaAndCtxs, state, open] = await Promise.all([
    infoRead(fetcher, network, { type: "metaAndAssetCtxs" }),
    infoRead(fetcher, network, { type: "clearinghouseState", user }),
    infoRead(fetcher, network, { type: "frontendOpenOrders", user })
  ]);
  const readAt = now();
  if (!Array.isArray(metaAndCtxs) || metaAndCtxs.length < 2 || !Array.isArray(metaAndCtxs[1]))
    throw new Error("Hyperliquid returned an unreadable market list");
  const rawUniverse = metaAndCtxs[0]?.universe;
  if (!Array.isArray(rawUniverse))
    throw new Error("Hyperliquid returned an unreadable market list");
  const universe = rawUniverse.map((m) => {
    const row = m;
    if (typeof row.name !== "string" || !Number.isInteger(row.szDecimals) || !Number.isInteger(row.maxLeverage))
      throw new Error("Hyperliquid returned an unreadable market");
    return {
      name: row.name,
      szDecimals: row.szDecimals,
      maxLeverage: row.maxLeverage,
      onlyIsolated: row.onlyIsolated === true
    };
  });
  const ctxs = metaAndCtxs[1];
  const marks = universe.map((_, i) => {
    const mark = ctxs[i]?.markPx;
    return typeof mark === "string" && (decimal(mark) ?? 0n) > 0n ? mark : null;
  });
  const assetOf = (coin) => universe.findIndex((m) => m.name === coin);
  const unsupported = [];
  const positionsRaw = state?.assetPositions;
  if (!Array.isArray(positionsRaw))
    throw new Error("Hyperliquid returned an unreadable account state");
  const positions = [];
  for (const entry of positionsRaw) {
    const p = entry?.position;
    const coin = p?.coin;
    const lev = p?.leverage;
    const szi = p?.szi;
    if (typeof coin !== "string" || typeof szi !== "string" || decimal(szi) === null) {
      unsupported.push(`an unreadable position (${JSON.stringify(coin ?? null)})`);
      continue;
    }
    const asset = assetOf(coin);
    if (asset < 0 || asset >= 1e4 || lev?.type !== "cross" && lev?.type !== "isolated" || !Number.isInteger(lev.value)) {
      unsupported.push(`position ${coin}`);
      continue;
    }
    if (decimal(szi) === 0n)
      continue;
    positions.push({ coin, asset, szi, leverage: { type: lev.type, value: lev.value } });
  }
  if (!Array.isArray(open))
    throw new Error("Hyperliquid returned an unreadable order list");
  const orders = [];
  for (const raw of open) {
    const o = raw;
    const coin = o?.coin;
    if (typeof coin !== "string") {
      unsupported.push("an unreadable order");
      continue;
    }
    const asset = assetOf(coin);
    const oid = o.oid;
    if (asset < 0 || asset >= 1e4 || !Number.isSafeInteger(oid) || o.side !== "A" && o.side !== "B" || decimal(o.sz) === null || decimal(o.limitPx) === null) {
      unsupported.push(`order ${coin}${Number.isSafeInteger(oid) ? ` ${oid}` : ""}`);
      continue;
    }
    const orderType = typeof o.orderType === "string" ? o.orderType : "";
    const isTrigger = o.isTrigger === true;
    const tpsl = isTrigger ? orderType.startsWith("Take Profit") ? "tp" : orderType.startsWith("Stop") ? "sl" : null : null;
    if (isTrigger && tpsl === null) {
      unsupported.push(`order ${coin} ${oid} (${orderType || "unknown trigger"})`);
      continue;
    }
    orders.push({
      coin,
      asset,
      oid,
      cloid: typeof o.cloid === "string" ? o.cloid.toLowerCase() : null,
      isBuy: o.side === "B",
      sz: o.sz,
      limitPx: o.limitPx,
      reduceOnly: o.reduceOnly === true,
      isTrigger,
      triggerPx: typeof o.triggerPx === "string" ? o.triggerPx : null,
      tpsl
    });
  }
  orders.sort((a, b) => a.asset - b.asset || a.oid - b.oid);
  positions.sort((a, b) => a.asset - b.asset);
  return { readAt, universe, marks, positions, orders, unsupported };
}
function snapshotPosition(snapshot, coin) {
  const upper = coin.toUpperCase();
  return snapshot.positions.find((p) => p.coin.toUpperCase() === upper) ?? null;
}
function hyperliquidTpslTarget(snapshot, coin) {
  const position = snapshotPosition(snapshot, coin);
  if (!position)
    throw new Error(`No ${coin} position on Hyperliquid to protect`);
  const mark = snapshot.marks[position.asset];
  const szDecimals = snapshot.universe[position.asset]?.szDecimals;
  if (!mark || szDecimals === undefined)
    throw new Error(`No Hyperliquid mark for ${position.coin}`);
  const held = position.szi.replace(/^-/, "");
  const size = hyperliquidFloorSize(held, szDecimals);
  return { asset: position.asset, isBuy: position.szi.startsWith("-"), size, markPx: mark };
}
async function venueEvidence(fetcher, network, address, intent, now) {
  const p = intent.params;
  switch (intent.method) {
    case "open":
    case "modify":
      return { market: await hyperliquidOrderMarket(fetcher, network, address, intent.method, p) };
    case "close":
      return { closeOrder: await hyperliquidCloseOrder(fetcher, network, address, p) };
    case "cancel": {
      if (p.oid !== undefined) {
        const snapshot = await hyperliquidWalletSnapshot(fetcher, network, address, now);
        const order = snapshot.orders.find((o) => o.oid === p.oid && (p.coin === undefined || o.coin.toUpperCase() === String(p.coin).toUpperCase()));
        if (!order)
          throw new Error("Hyperliquid shows no such open order on this wallet");
        return { cancelTarget: { asset: order.asset, oid: order.oid } };
      }
      const status = await infoRead(fetcher, network, {
        type: "orderStatus",
        user: address.toLowerCase(),
        oid: p.cloid
      });
      const resting = status?.order?.order;
      if (!resting || typeof resting.coin !== "string" || !Number.isSafeInteger(resting.oid))
        throw new Error("Hyperliquid shows no order with this cloid on this wallet");
      const meta = await infoRead(fetcher, network, { type: "meta" });
      const asset = (meta.universe ?? []).findIndex((m) => m.name === resting.coin);
      if (asset < 0 || asset >= 1e4)
        throw new Error("The order is not on Hyperliquid's main perp exchange");
      return { cancelTarget: { asset, oid: resting.oid } };
    }
    case "leverage": {
      const snapshot = await hyperliquidWalletSnapshot(fetcher, network, address, now);
      const coin = String(p.coin ?? "").toUpperCase();
      const asset = snapshot.universe.findIndex((m) => m.name.toUpperCase() === coin);
      if (asset < 0)
        throw new Error("No main-universe market for this coin on Hyperliquid");
      const name = snapshot.universe[asset]?.name;
      const data = await infoRead(fetcher, network, {
        type: "activeAssetData",
        user: address.toLowerCase(),
        coin: name
      });
      const lev = data?.leverage;
      if (lev?.type !== "cross" && lev?.type !== "isolated" || !Number.isInteger(lev.value))
        throw new Error("Hyperliquid did not report this market's leverage");
      const flat = !snapshot.positions.some((x) => x.asset === asset) && !snapshot.orders.some((o) => o.asset === asset);
      return { leverageTarget: { asset, leverage: lev.value, mode: lev.type, flat } };
    }
    case "margin": {
      const snapshot = await hyperliquidWalletSnapshot(fetcher, network, address, now);
      const position = snapshotPosition(snapshot, String(p.coin ?? ""));
      if (!position || position.leverage.type !== "isolated")
        throw new Error("Hyperliquid shows no isolated position in this coin");
      return { marginTarget: { asset: position.asset } };
    }
    case "tpsl": {
      const snapshot = await hyperliquidWalletSnapshot(fetcher, network, address, now);
      return { tpslTarget: hyperliquidTpslTarget(snapshot, String(p.coin ?? "")) };
    }
    case "scheduleCancel":
      return { clock: { now: now() } };
    default:
      return {};
  }
}
async function verifyPerpsBuildAgainstVenue(build, opts) {
  const { fetcher, now = Date.now, ...verify } = opts;
  const first = verifyPerpsBuild(build, { ...verify, awaitingVenue: true });
  if (!first.ok)
    return first;
  let evidence;
  try {
    evidence = await venueEvidence(fetcher, verify.network ?? "mainnet", opts.address, opts.intent, now);
  } catch (err) {
    return {
      ok: false,
      reason: `could not check it against Hyperliquid: ${err instanceof Error ? err.message : "read failed"}`
    };
  }
  return verifyPerpsBuild(build, { ...verify, ...evidence });
}
function hyperliquidExchangeOutcome(exchange) {
  if (!exchange || typeof exchange !== "object")
    return { status: "unknown", error: "Hyperliquid returned no answer" };
  const answer = exchange;
  if (answer.status === "err")
    return {
      status: "rejected",
      error: typeof answer.response === "string" ? answer.response : JSON.stringify(answer.response ?? null),
      legs: []
    };
  if (answer.status !== "ok")
    return { status: "unknown", error: "Hyperliquid's answer has no status" };
  const response = answer.response;
  const statuses = response?.data?.statuses;
  if (statuses === undefined) {
    return response?.type === "default" || response?.type === "scheduleCancel" || response?.type === "cancel" ? { status: "confirmed", legs: [] } : { status: "unknown", error: "Hyperliquid's answer is not one this client knows" };
  }
  if (!Array.isArray(statuses))
    return { status: "unknown", error: "Hyperliquid's answer has unreadable statuses" };
  const errors = statuses.filter((s) => s && typeof s === "object" && ("error" in s)).map((s) => String(s.error));
  if (errors.length > 0)
    return { status: "rejected", error: errors.join("; "), legs: statuses };
  return { status: "confirmed", legs: statuses };
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

// src/hyperliquid-manage.ts
var PERPS_FLATTEN_MAX_STEPS = 100;

class PerpsWorkflowError extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function errorCode(err) {
  const code = err?.code;
  return typeof code === "string" ? code : "REQUEST_FAILED";
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
async function runStep(io, step, path, body, intent) {
  let build;
  try {
    build = await io.build(path, { walletId: io.walletId, ...body });
  } catch (err) {
    step.status = "rejected";
    step.detail = `${errorCode(err)}: ${errorText(err)}`;
    return false;
  }
  if (build.replayed === true) {
    step.status = "skipped";
    step.detail = "This client id already names an operation; nothing was signed";
    return false;
  }
  step.perpOrderId = typeof build.perpOrderId === "string" ? build.perpOrderId : null;
  step.nonce = typeof build.nonce === "number" ? build.nonce : null;
  if (typeof build.cloid === "string")
    step.cloid = build.cloid;
  const check = await verifyPerpsBuildAgainstVenue(build, {
    builder: io.builder,
    network: io.network,
    address: io.address,
    intent,
    fetcher: io.fetcher,
    now: io.now,
    keyReduceOnly: io.keyReduceOnly
  });
  if (!check.ok) {
    step.status = "rejected";
    step.detail = `Refused to sign this build: ${check.reason}. Nothing was signed.`;
    return false;
  }
  step.status = "built";
  if (io.mode === "no-submit")
    return false;
  let signature;
  try {
    signature = await io.sign(build.typedData);
  } catch (err) {
    step.status = "rejected";
    step.detail = `The relay did not sign (${errorCode(err)}: ${errorText(err)}). Nothing was submitted.`;
    return false;
  }
  step.signature = signature;
  const exchangeBody = hyperliquidExchangeBody(build.action, build.nonce, signature);
  if (io.mode === "sign-only") {
    step.exchangeBody = exchangeBody;
    return false;
  }
  let exchange;
  try {
    const res = await io.fetcher(HYPERLIQUID_EXCHANGE_URLS[io.network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exchangeBody)
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`HTTP ${res.status ?? "error"}${res.status === 429 ? " (rate limited)" : ""}`);
    exchange = JSON.parse(text);
  } catch (err) {
    step.status = "unknown";
    step.detail = `Signed, but the submit to Hyperliquid did not answer (${errorText(err)}). Reconcile before acting again.`;
    step.exchangeBody = exchangeBody;
    return false;
  }
  step.exchange = exchange;
  const outcome = hyperliquidExchangeOutcome(exchange);
  if (outcome.status === "confirmed") {
    step.status = "confirmed";
    return true;
  }
  step.status = outcome.status;
  step.detail = outcome.error;
  if (outcome.status === "unknown")
    step.exchangeBody = exchangeBody;
  return false;
}
function blankStep(n, kind, coin, extra = {}) {
  return {
    step: n,
    kind,
    coin,
    target: null,
    perpOrderId: null,
    nonce: null,
    cloid: null,
    status: "planned",
    ...extra
  };
}
var DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
var CLOID_RE = /^0x[0-9a-f]{32}$/;
function perpsTpslParamsProblem(p) {
  if (typeof p.coin !== "string" || !/^[A-Za-z0-9]{1,20}$/.test(p.coin))
    return "coin must be a market name";
  for (const [field, value] of [
    ["takeProfit", p.takeProfit],
    ["stopLoss", p.stopLoss]
  ])
    if (value !== undefined && (typeof value !== "string" || !DECIMAL_RE.test(value) || /^0+(\.0+)?$/.test(value)))
      return `${field} must be a positive decimal`;
  if (p.takeProfit !== undefined && p.removeTp)
    return "cannot set and remove the take-profit together";
  if (p.stopLoss !== undefined && p.removeSl)
    return "cannot set and remove the stop-loss together";
  if (p.takeProfit === undefined && p.stopLoss === undefined && !p.removeTp && !p.removeSl)
    return "name at least one change: a take-profit, a stop-loss, or a removal";
  for (const [field, value] of [
    ["targetTp", p.targetTp],
    ["targetSl", p.targetSl]
  ])
    if (value !== undefined && (typeof value !== "string" || !CLOID_RE.test(value.toLowerCase())))
      return `${field} must be 0x followed by 32 hex digits`;
  if (p.targetTp !== undefined && p.takeProfit === undefined && !p.removeTp)
    return "targetTp needs a take-profit change";
  if (p.targetSl !== undefined && p.stopLoss === undefined && !p.removeSl)
    return "targetSl needs a stop-loss change";
  return null;
}
function sameDecimal(a, b) {
  if (typeof a !== "string" || typeof b !== "string")
    return false;
  const norm = (v) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v).replace(/^0+(?=\d)/, "");
  return norm(a) === norm(b);
}
async function runPerpsTpsl(io, params) {
  const problem = perpsTpslParamsProblem(params);
  if (problem)
    throw new PerpsWorkflowError("VALIDATION_FAILED", problem);
  const coinQuery = encodeURIComponent(params.coin);
  const server = await io.read(`/api/v1/agent/perps/tpsl?walletId=${encodeURIComponent(io.walletId)}&coin=${coinQuery}`);
  let snapshot;
  try {
    snapshot = await hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now);
  } catch (err) {
    throw new PerpsWorkflowError("PERPS_UNAVAILABLE", `Cannot read the account from Hyperliquid: ${errorText(err)}`);
  }
  const coin = typeof server.coin === "string" ? server.coin : params.coin.toUpperCase();
  const venueLegs = snapshot.orders.filter((o) => o.coin === coin && o.tpsl !== null);
  const tracked = [];
  for (const raw of Array.isArray(server.tracked) ? server.tracked : []) {
    const seen = venueLegs.find((o) => o.oid === raw.oid && o.tpsl === raw.leg && (o.cloid ?? null) === (raw.cloid ?? null));
    if (seen)
      tracked.push({ leg: raw.leg, oid: seen.oid, cloid: seen.cloid, triggerPx: seen.triggerPx });
  }
  const trackedOids = new Set(tracked.map((l) => l.oid));
  const unowned = venueLegs.filter((o) => !trackedOids.has(o.oid)).map((o) => ({ leg: o.tpsl, oid: o.oid, cloid: o.cloid, triggerPx: o.triggerPx }));
  const position = snapshotPosition(snapshot, coin);
  const warnings = [];
  if (unowned.length > 0)
    warnings.push(`${unowned.length} take-profit / stop-loss leg(s) on ${coin} were not built by Candle; they are left untouched.`);
  const steps = [];
  const plans = [];
  for (const leg of ["tp", "sl"]) {
    const set = leg === "tp" ? params.takeProfit : params.stopLoss;
    const remove = leg === "tp" ? params.removeTp === true : params.removeSl === true;
    if (set === undefined && !remove)
      continue;
    const target = (leg === "tp" ? params.targetTp : params.targetSl)?.toLowerCase();
    let legs = tracked.filter((l) => l.leg === leg);
    if (target !== undefined) {
      legs = legs.filter((l) => l.cloid === target);
      if (legs.length === 0)
        throw new PerpsWorkflowError("PERPS_ORDER_NOT_FOUND", `No open ${coin} ${leg} leg Candle built carries ${target}`);
    }
    if (legs.length > 1)
      throw new PerpsWorkflowError("PERPS_TPSL_CONFLICT", `${legs.length} ${coin} ${leg === "tp" ? "take-profit" : "stop-loss"} legs match; name one with --target-${leg} <cloid>`, { candidates: legs });
    const existing = legs[0] ?? null;
    if (set !== undefined && existing && sameDecimal(existing.triggerPx, set)) {
      steps.push(blankStep(steps.length, "attach", coin, {
        leg,
        target: { oid: existing.oid, cloid: existing.cloid },
        status: "skipped",
        detail: "Already in place at this trigger"
      }));
      continue;
    }
    if (set !== undefined && !position)
      throw new PerpsWorkflowError("PERPS_NO_POSITION", `No ${coin} position on Hyperliquid to protect`);
    if (remove && !existing) {
      steps.push(blankStep(steps.length, "cancel", coin, { leg, status: "skipped", detail: "No tracked leg to remove" }));
      continue;
    }
    const cancel = existing ? blankStep(steps.length, "cancel", coin, { leg, target: { oid: existing.oid, cloid: existing.cloid } }) : null;
    if (cancel)
      steps.push(cancel);
    const attach = set !== undefined ? blankStep(steps.length, "attach", coin, { leg }) : null;
    if (attach)
      steps.push(attach);
    if (cancel && attach)
      warnings.push(`Changing the ${leg === "tp" ? "take-profit" : "stop-loss"} cancels the current leg first: ${coin} is unprotected on that side until the new one is placed.`);
    if (cancel && !attach)
      warnings.push(`Removing the ${leg === "tp" ? "take-profit" : "stop-loss"} leaves ${coin} without it.`);
    plans.push({ leg, cancel, attach, ...set !== undefined ? { triggerPx: set } : {} });
  }
  if (plans.some((p) => p.attach))
    warnings.push("New legs are sized to the position now and do not grow with later additions; triggering does not guarantee a fill.");
  const result = {
    operation: "tpsl",
    walletId: io.walletId,
    address: io.address,
    network: io.network,
    readAt: snapshot.readAt,
    complete: false,
    steps,
    remaining: [],
    warnings,
    unowned
  };
  const active = steps.filter((s) => s.status === "planned");
  if (active.length === 0) {
    result.complete = true;
    return result;
  }
  if (io.mode !== "no-submit" && io.confirm && !await io.confirm({ steps, warnings }))
    throw new PerpsWorkflowError("CANCELLED", "Nothing was signed.");
  const workflowId = `tpsl-${io.cloid().slice(2, 18)}`;
  let stopped = false;
  for (const plan of plans) {
    if (stopped)
      break;
    if (plan.cancel) {
      const step = plan.cancel;
      const ok = await runStep(io, step, "/api/v1/agent/perps/tpsl", {
        coin,
        operation: "cancel",
        leg: plan.leg,
        ...step.target?.cloid ? { targetCloid: step.target.cloid } : {},
        workflowId,
        workflowStep: step.step
      }, { method: "cancel", params: { coin, oid: step.target?.oid } });
      if (!ok) {
        stopped = true;
        break;
      }
      try {
        const after = await hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now);
        result.readAt = after.readAt;
        if (after.orders.some((o) => o.oid === step.target?.oid)) {
          step.status = "unknown";
          step.detail = "Hyperliquid accepted the cancel but still shows the leg open; no replacement was placed";
          stopped = true;
          break;
        }
        if (plan.attach && !snapshotPosition(after, coin)) {
          plan.attach.status = "skipped";
          plan.attach.detail = "The position closed meanwhile; no replacement was placed";
          continue;
        }
      } catch (err) {
        step.detail = `Canceled, but the follow-up read failed (${errorText(err)}); no replacement was placed`;
        stopped = true;
        break;
      }
    }
    if (plan.attach) {
      const ok = await runStep(io, plan.attach, "/api/v1/agent/perps/tpsl", {
        coin,
        operation: "attach",
        leg: plan.leg,
        triggerPx: plan.triggerPx,
        workflowId,
        workflowStep: plan.attach.step
      }, { method: "tpsl", params: { coin, leg: plan.leg, triggerPx: plan.triggerPx } });
      if (!ok)
        stopped = true;
    }
  }
  for (const s of steps) {
    if (s.status === "planned")
      result.remaining.push({ step: s.step, kind: s.kind, leg: s.leg, coin });
    if (s.kind === "cancel" && s.status === "confirmed" && plans.find((p) => p.cancel === s)?.attach?.status !== "confirmed")
      result.remaining.push({ leg: s.leg, coin, state: "old leg canceled, no new leg in place" });
  }
  result.complete = steps.every((s) => s.status === "confirmed" || s.status === "skipped") && !stopped;
  return result;
}
function orderTarget(o) {
  return { oid: o.oid, cloid: o.cloid };
}
function snapshotOrError(io) {
  return hyperliquidWalletSnapshot(io.fetcher, io.network, io.address, io.now);
}
async function runPerpsFlatten(io) {
  let snapshot;
  try {
    snapshot = await snapshotOrError(io);
  } catch (err) {
    throw new PerpsWorkflowError("PERPS_UNAVAILABLE", `Cannot read the account from Hyperliquid: ${errorText(err)}`);
  }
  if (snapshot.unsupported.length > 0)
    throw new PerpsWorkflowError("PERPS_MARKET_REFUSED", `Flatten reaches Hyperliquid's main perp exchange only, and this wallet holds rows it cannot classify there: ${snapshot.unsupported.slice(0, 5).join(", ")}. Nothing was built.`, { unsupported: snapshot.unsupported });
  const warnings = [
    "Scope: Hyperliquid's main perp exchange only. Spot, HIP-3 and vault exposure is not read or closed.",
    "Every open order is canceled first, take-profit and stop-loss protection included.",
    "The final state is an observed snapshot; another client can open exposure afterwards."
  ];
  const steps = [];
  for (const o of snapshot.orders)
    steps.push(blankStep(steps.length, "cancel", o.coin, { target: orderTarget(o) }));
  const closeIds = new Map;
  for (const p of snapshot.positions) {
    const id = io.cloid();
    closeIds.set(p.coin, id);
    steps.push(blankStep(steps.length, "close", p.coin, { cloid: id }));
  }
  const result = {
    operation: "flatten",
    walletId: io.walletId,
    address: io.address,
    network: io.network,
    readAt: snapshot.readAt,
    complete: false,
    steps,
    remaining: [],
    warnings,
    scope: "main-perps"
  };
  if (steps.length === 0) {
    result.complete = true;
    return result;
  }
  if (steps.length > PERPS_FLATTEN_MAX_STEPS)
    warnings.push(`${steps.length} steps planned; this run signs at most ${PERPS_FLATTEN_MAX_STEPS} and reports the rest as remaining. Run flatten again.`);
  if (io.mode !== "no-submit" && io.confirm && !await io.confirm({ steps, warnings }))
    throw new PerpsWorkflowError("CANCELLED", "Nothing was signed.");
  const workflowId = `flat-${io.cloid().slice(2, 18)}`;
  const cancelStep = (step) => runStep(io, step, "/api/v1/agent/perps/flatten/cancel", { coin: step.coin, oid: step.target?.oid, workflowId, workflowStep: step.step }, { method: "cancel", params: { coin: step.coin, oid: step.target?.oid } });
  const closeStep = (step) => {
    const clientId = closeIds.get(step.coin);
    return runStep(io, step, "/api/v1/agent/perps/close", { coin: step.coin, clientId, workflowId, workflowStep: step.step }, { method: "close", params: { coin: step.coin, clientId } });
  };
  if (io.mode !== "submit") {
    const first = steps[0];
    await (first.kind === "cancel" ? cancelStep(first) : closeStep(first));
    for (const s of steps)
      if (s.status === "planned")
        result.remaining.push({ step: s.step, kind: s.kind, coin: s.coin, target: s.target });
    return result;
  }
  let signed = 0;
  let stopped = false;
  const budgetLeft = () => signed < PERPS_FLATTEN_MAX_STEPS;
  for (const step of steps.filter((s) => s.kind === "cancel")) {
    if (stopped || !budgetLeft())
      break;
    signed++;
    if (await cancelStep(step))
      continue;
    if (step.status === "rejected" && step.detail?.startsWith("PERPS_ORDER_NOT_OPEN")) {
      step.status = "skipped";
      continue;
    }
    stopped = true;
  }
  if (!stopped && budgetLeft()) {
    let after = null;
    try {
      after = await snapshotOrError(io);
      result.readAt = after.readAt;
    } catch (err) {
      warnings.push(`The read after the cancels failed (${errorText(err)}); no position was closed.`);
      stopped = true;
    }
    if (after) {
      const fresh = after.orders.filter((o) => !steps.some((s) => s.kind === "cancel" && s.target?.oid === o.oid));
      if (fresh.length > 0)
        warnings.push(`${fresh.length} order(s) appeared during the cancels and were not part of this run's plan.`);
      for (const p of after.positions)
        if (!closeIds.has(p.coin)) {
          const id = io.cloid();
          closeIds.set(p.coin, id);
          steps.push(blankStep(steps.length, "close", p.coin, { cloid: id }));
        }
      for (const step of steps.filter((s) => s.kind === "close")) {
        if (stopped || !budgetLeft())
          break;
        let now;
        try {
          now = await snapshotOrError(io);
          result.readAt = now.readAt;
        } catch (err) {
          step.detail = `The read before this close failed (${errorText(err)})`;
          stopped = true;
          break;
        }
        const held = snapshotPosition(now, step.coin);
        if (!held) {
          step.status = "skipped";
          step.detail = "No position left to close";
          continue;
        }
        signed++;
        if (await closeStep(step)) {
          const leg = step.exchange?.response?.data?.statuses?.[0];
          const filled = typeof leg?.filled?.totalSz === "string" ? leg.filled.totalSz : null;
          const planned = held.szi.replace(/^-/, "");
          if (filled !== null) {
            step.filledSz = filled;
            if (!sameDecimal(filled, planned)) {
              step.remainingSz = `${planned} planned, ${filled} filled`;
              step.detail = "Partly filled; the rest of the position is still open";
            }
          }
          continue;
        }
        if (step.status !== "rejected" || /429|rate limit/i.test(step.detail ?? ""))
          stopped = true;
      }
    }
  }
  let final = null;
  try {
    final = await snapshotOrError(io);
    result.readAt = final.readAt;
  } catch (err) {
    warnings.push(`The final read failed (${errorText(err)}); the outcome is not known.`);
  }
  for (const s of steps)
    if (s.status === "planned")
      result.remaining.push({ step: s.step, kind: s.kind, coin: s.coin, target: s.target });
  if (final) {
    for (const p of final.positions)
      result.remaining.push({ kind: "position", coin: p.coin, szi: p.szi });
    for (const o of final.orders)
      result.remaining.push({ kind: "order", coin: o.coin, oid: o.oid });
  }
  result.complete = final !== null && final.positions.length === 0 && final.orders.length === 0 && final.unsupported.length === 0 && !stopped && steps.every((s) => s.status === "confirmed" || s.status === "skipped");
  return result;
}

// src/hyperliquid-markets.ts
var INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info"
};
var ONE = 10n ** 18n;
var DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

class PerpsMarketError extends Error {
  code;
  retryable;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PerpsMarketError";
    this.retryable = code === "PERPS_UNAVAILABLE";
  }
}
function unavailable() {
  throw new PerpsMarketError("PERPS_UNAVAILABLE", "Hyperliquid market data is unavailable; retry shortly.");
}
function usage(message) {
  throw new PerpsMarketError("PERPS_USAGE", message);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decimal2(value) {
  return typeof value === "string" && value.length <= 100 && DECIMAL.test(value) && (value.split(".")[1]?.length ?? 0) <= 18;
}
function scaled(value) {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole) * ONE + BigInt(fraction.padEnd(18, "0"));
  return negative ? -result : result;
}
function nonnegative(value) {
  return decimal2(value) && !value.startsWith("-") ? scaled(value) : null;
}
function fixed(value, places) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(18 - places);
  const rounded = (abs + divisor / 2n) / divisor;
  const digits = rounded.toString().padStart(places + 1, "0");
  return `${negative && rounded !== 0n ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
function at(values, index) {
  const value = values[index];
  if (value === undefined)
    return unavailable();
  return value;
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseMarkets(value) {
  if (!Array.isArray(value) || value.length !== 2)
    return unavailable();
  const [meta, ctxs] = value;
  if (!object(meta) || !Array.isArray(meta.universe) || !Array.isArray(ctxs) || meta.universe.length !== ctxs.length)
    return unavailable();
  for (const row of meta.universe) {
    if (!object(row) || typeof row.name !== "string" || !integer(row.szDecimals) || row.szDecimals > 6 || !integer(row.maxLeverage))
      return unavailable();
    for (const key of ["isDelisted", "onlyIsolated"])
      if (row[key] !== undefined && typeof row[key] !== "boolean")
        return unavailable();
    if (row.marginTableId !== undefined && !integer(row.marginTableId))
      return unavailable();
  }
  for (const ctx of ctxs) {
    if (!object(ctx))
      return unavailable();
    for (const key of ["markPx", "midPx", "oraclePx", "openInterest", "funding", "dayNtlVlm", "prevDayPx", "premium"]) {
      if (ctx[key] !== undefined && ctx[key] !== null && !decimal2(ctx[key]))
        return unavailable();
    }
    if (ctx.impactPxs != null && (!Array.isArray(ctx.impactPxs) || ctx.impactPxs.length !== 2 || !ctx.impactPxs.every(decimal2)))
      return unavailable();
  }
  const marginTables = new Map;
  if (meta.marginTables !== undefined) {
    if (!Array.isArray(meta.marginTables))
      return unavailable();
    for (const entry of meta.marginTables) {
      if (!Array.isArray(entry) || !integer(entry[0]) || !object(entry[1]) || !Array.isArray(entry[1].marginTiers))
        return unavailable();
      const tiers = [];
      for (const tier of entry[1].marginTiers) {
        if (!object(tier) || nonnegative(tier.lowerBound) === null || !integer(tier.maxLeverage))
          return unavailable();
        tiers.push({ lowerBoundUsd: tier.lowerBound, maxLeverage: tier.maxLeverage });
      }
      marginTables.set(entry[0], tiers);
    }
  }
  return { universe: meta.universe, ctxs, marginTables };
}
async function info(fetcher, network, body) {
  try {
    const response = await fetcher(INFO_URLS[network], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error"
    });
    if (!response.ok)
      return unavailable();
    return JSON.parse(await response.text());
  } catch {
    return unavailable();
  }
}
async function readHyperliquidMarkets(fetcher, network) {
  return parseMarkets(await info(fetcher, network, { type: "metaAndAssetCtxs" }));
}
function perpsMarketGate(meta, ctx, minOpenInterestUsd) {
  if (meta.isDelisted === true)
    return { tradeable: false, reason: "delisted" };
  const mark = nonnegative(ctx.markPx);
  const mid = nonnegative(typeof ctx.midPx === "string" ? ctx.midPx : ctx.markPx);
  const oi = nonnegative(ctx.openInterest);
  if (mark === null || mid === null || oi === null)
    return { tradeable: false, reason: "noPrice" };
  const divisor = 10n ** 30n;
  const micros = (oi * mark + divisor - 1n) / divisor;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    return unavailable();
  if (minOpenInterestUsd > 0 && micros < BigInt(minOpenInterestUsd) * 1000000n)
    return { tradeable: false, reason: "minOpenInterest" };
  return { tradeable: true, reason: null };
}
function resolve(snapshot, coin) {
  if (/^[A-Za-z0-9]{1,20}$/.test(coin)) {
    const exact = snapshot.universe.findIndex((row) => row.name === coin);
    if (exact !== -1)
      return exact;
    const matches = snapshot.universe.map((row, i) => ({ row, i })).filter(({ row }) => row.name.toLowerCase() === coin.toLowerCase());
    if (matches.length === 1)
      return at(matches, 0).i;
  }
  throw new PerpsMarketError("PERPS_MARKET_NOT_FOUND", `${coin} is not a market on Hyperliquid's main perp exchange.`);
}
var PERPS_CANDLE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M"
];
var INTERVAL_MS = [
  60000,
  180000,
  300000,
  900000,
  1800000,
  3600000,
  7200000,
  14400000,
  28800000,
  43200000,
  86400000,
  259200000,
  604800000,
  2678400000
];
function perpsCandleWindow(opts, now) {
  const interval = opts.interval ?? "1h";
  const index = PERPS_CANDLE_INTERVALS.indexOf(interval);
  if (index < 0)
    return usage(`interval must be one of ${PERPS_CANDLE_INTERVALS.join(" ")}.`);
  const count = bounded(opts.count, 100, 1, 5000, "count");
  const raw = opts.end;
  const endTime = raw === undefined ? now : epoch(raw);
  const startTime = endTime - count * at(INTERVAL_MS, index);
  if (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > now || startTime < 0)
    return usage("end must be an ISO 8601 time or epoch milliseconds, no later than now.");
  return { interval, count, startTime, endTime };
}
function epoch(raw) {
  return typeof raw === "number" || /^\d+$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN;
}
var PERPS_FUNDING_HISTORY_MAX_MS = 30 * 86400000;
var PERPS_FUNDING_HISTORY_MAX_ROWS = 500;
function perpsFundingWindow(opts, now) {
  const endTime = opts.end === undefined ? now : epoch(opts.end);
  if (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > now)
    return usage("end must be an ISO 8601 time or epoch milliseconds, no later than now.");
  const startTime = opts.start === undefined ? endTime - 86400000 : epoch(opts.start);
  if (!Number.isSafeInteger(startTime) || startTime < 0 || startTime > endTime)
    return usage("start must be an ISO 8601 time or epoch milliseconds, no later than end.");
  if (endTime - startTime > PERPS_FUNDING_HISTORY_MAX_MS)
    return usage("start must be at most 30 days before end.");
  return { startTime, endTime };
}
function bounded(value, fallback, min, max, name) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    return usage(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}
function parsePerpsFundingHistory(value, coin, window) {
  if (!Array.isArray(value))
    return unavailable();
  const funding = [];
  for (const row of value) {
    if (!object(row) || row.coin !== coin || !integer(row.time) || !decimal2(row.fundingRate) || !decimal2(row.premium))
      return unavailable();
    if (row.time >= window.startTime && row.time <= window.endTime)
      funding.push({
        time: row.time,
        fundingRate: row.fundingRate,
        fundingAprPct: fixed(scaled(row.fundingRate) * 876000n, 2),
        premium: row.premium
      });
  }
  funding.sort((a, b) => a.time - b.time);
  return {
    funding: funding.slice(0, PERPS_FUNDING_HISTORY_MAX_ROWS),
    truncated: funding.length > PERPS_FUNDING_HISTORY_MAX_ROWS
  };
}

class PerpsMarketReader {
  opts;
  configPromise;
  coreCache;
  extrasCache;
  corePending;
  extrasPending;
  now;
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }
  key() {
    if (!this.opts.apiKey?.trim())
      throw new PerpsMarketError("PERPS_KEY_REQUIRED", "Configure a Candle agent key (any scope) to read perps markets.");
  }
  config() {
    this.key();
    this.configPromise ??= (async () => {
      try {
        const value = await this.opts.readConfig();
        if (!object(value) || !object(value.limits) || !integer(value.limits.minOpenInterestUsd) || value.network !== "mainnet" && value.network !== "testnet")
          throw new Error("config shape");
        return {
          minOpenInterestUsd: value.limits.minOpenInterestUsd,
          source: "server",
          network: value.network,
          warnings: []
        };
      } catch {
        return {
          minOpenInterestUsd: 1e6,
          source: "default",
          warnings: ["Candle config unavailable; using the release's default OI floor."]
        };
      }
    })();
    return this.configPromise;
  }
  core() {
    const ttl = this.opts.cacheMs ?? 5000;
    if (this.coreCache && ttl > 0 && this.now() - this.coreCache.at < ttl)
      return Promise.resolve(this.coreCache.value);
    this.corePending ??= readHyperliquidMarkets(this.opts.fetcher, this.opts.network).then((value) => {
      this.coreCache = { value, at: this.now() };
      return value;
    }).finally(() => {
      this.corePending = undefined;
    });
    return this.corePending;
  }
  extras() {
    const ttl = this.opts.cacheMs ?? 5000;
    if (this.extrasCache && ttl > 0 && this.now() - this.extrasCache.at < ttl)
      return Promise.resolve(this.extrasCache.value);
    this.extrasPending ??= (async () => {
      const warnings = [];
      const [predicted, cap] = await Promise.all([
        info(this.opts.fetcher, this.opts.network, { type: "predictedFundings" }).then((value2) => {
          if (!Array.isArray(value2))
            return unavailable();
          const map = new Map;
          for (const entry of value2) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1]))
              return unavailable();
            for (const venue of entry[1]) {
              if (!Array.isArray(venue) || typeof venue[0] !== "string")
                return unavailable();
              if (venue[0] === "HlPerp" && venue[1] !== null) {
                if (!object(venue[1]) || !decimal2(venue[1].fundingRate) || !integer(venue[1].nextFundingTime))
                  return unavailable();
                map.set(entry[0], { fundingRate: venue[1].fundingRate, nextFundingTime: venue[1].nextFundingTime });
              }
            }
          }
          return map;
        }).catch(() => {
          warnings.push("Predicted funding unavailable.");
          return null;
        }),
        info(this.opts.fetcher, this.opts.network, { type: "perpsAtOpenInterestCap" }).then((value2) => {
          if (!Array.isArray(value2) || !value2.every((v) => typeof v === "string"))
            return unavailable();
          return new Set(value2);
        }).catch(() => {
          warnings.push("Open-interest caps unavailable.");
          return null;
        })
      ]);
      const value = { predicted, cap, warnings: warnings.sort() };
      this.extrasCache = { value, at: this.now() };
      return value;
    })().finally(() => {
      this.extrasPending = undefined;
    });
    return this.extrasPending;
  }
  envelope(config, warnings = [], readAt = this.now()) {
    const mismatch = config.network !== undefined && config.network !== this.opts.network;
    return {
      success: true,
      network: this.opts.network,
      readAt,
      gate: { minOpenInterestUsd: config.minOpenInterestUsd, source: config.source },
      warnings: [
        ...config.warnings,
        ...warnings,
        ...mismatch ? ["Candle and client networks differ; tradeability is unknown."] : []
      ]
    };
  }
  row(core, extras, config, asset) {
    const meta = at(core.universe, asset);
    const ctx = at(core.ctxs, asset);
    const mark = ctx.markPx == null ? null : scaled(ctx.markPx);
    const oi = ctx.openInterest == null ? null : scaled(ctx.openInterest);
    const prev = ctx.prevDayPx == null ? null : scaled(ctx.prevDayPx);
    const predicted = extras.predicted?.get(meta.name);
    return {
      coin: meta.name,
      asset,
      markPx: ctx.markPx ?? null,
      oraclePx: ctx.oraclePx ?? null,
      midPx: ctx.midPx ?? null,
      fundingRate: ctx.funding ?? null,
      fundingAprPct: ctx.funding == null ? null : fixed(scaled(ctx.funding) * 876000n, 2),
      predictedFundingRate: predicted?.fundingRate ?? null,
      nextFundingTime: predicted?.nextFundingTime ?? null,
      openInterest: ctx.openInterest ?? null,
      openInterestUsd: oi === null || mark === null ? null : fixed(oi * mark / ONE, 2),
      dayNotionalVolumeUsd: ctx.dayNtlVlm ?? null,
      prevDayPx: ctx.prevDayPx ?? null,
      change24hPct: prev === null || prev === 0n || mark === null ? null : fixed((mark - prev) * 100n * ONE / prev, 1),
      maxLeverage: meta.maxLeverage,
      onlyIsolated: meta.onlyIsolated === true,
      isDelisted: meta.isDelisted === true,
      atOpenInterestCap: extras.cap?.has(meta.name) ?? null,
      candle: config.network !== undefined && config.network !== this.opts.network ? { tradeable: null, reason: "networkMismatch" } : perpsMarketGate(meta, ctx, config.minOpenInterestUsd)
    };
  }
  async markets(opts = {}) {
    this.key();
    const sort = opts.sort ?? "volume";
    if (!["volume", "oi", "funding", "change", "name"].includes(sort))
      return usage("sort must be volume, oi, funding, change or name.");
    const limit = opts.limit === undefined ? undefined : bounded(opts.limit, 500, 1, 500, "limit");
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()]);
    const rows = core.universe.map((_, asset) => this.row(core, extras, config, asset)).filter((row) => opts.all || row.candle.tradeable !== false);
    const field = {
      volume: "dayNotionalVolumeUsd",
      oi: "openInterestUsd",
      funding: "fundingRate",
      change: "change24hPct"
    };
    rows.sort((a, b) => {
      if (sort !== "name") {
        const av = a[field[sort]];
        const bv = b[field[sort]];
        if (av === null && bv !== null)
          return 1;
        if (bv === null && av !== null)
          return -1;
        if (av !== null && bv !== null) {
          const diff = scaled(bv) - scaled(av);
          if (diff !== 0n)
            return diff > 0n ? 1 : -1;
        }
      }
      return a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0;
    });
    return {
      ...this.envelope(config, extras.warnings, Math.max(this.coreCache?.at ?? 0, this.extrasCache?.at ?? 0)),
      markets: limit === undefined ? rows : rows.slice(0, limit)
    };
  }
  async market(coin) {
    this.key();
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()]);
    const asset = resolve(core, coin);
    const meta = at(core.universe, asset);
    const ctx = at(core.ctxs, asset);
    return {
      ...this.envelope(config, extras.warnings, Math.max(this.coreCache?.at ?? 0, this.extrasCache?.at ?? 0)),
      market: {
        ...this.row(core, extras, config, asset),
        szDecimals: meta.szDecimals,
        maxPriceDecimals: 6 - meta.szDecimals,
        priceRule: "at most 5 significant figures",
        minOrderUsd: 10,
        impactBidPx: ctx.impactPxs?.[0] ?? null,
        impactAskPx: ctx.impactPxs?.[1] ?? null,
        premium: ctx.premium ?? null,
        marginTiers: core.marginTables.get(meta.marginTableId ?? -1) ?? [
          { lowerBoundUsd: "0", maxLeverage: meta.maxLeverage }
        ]
      }
    };
  }
  async book(coin, opts = {}) {
    this.key();
    const depth = bounded(opts.depth, 20, 1, 20, "depth");
    if (opts.sigFigs !== undefined)
      bounded(opts.sigFigs, 5, 2, 5, "sigFigs");
    const [config, core] = await Promise.all([this.config(), this.core()]);
    const canonical2 = at(core.universe, resolve(core, coin)).name;
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "l2Book",
      coin: canonical2,
      ...opts.sigFigs === undefined ? {} : { nSigFigs: opts.sigFigs }
    });
    if (!object(value) || value.coin !== canonical2 || !integer(value.time) || !Array.isArray(value.levels) || value.levels.length !== 2)
      return unavailable();
    const sides = [];
    for (const side of value.levels) {
      if (!Array.isArray(side))
        return unavailable();
      const levels = [];
      for (const level of side) {
        if (!object(level) || nonnegative(level.px) === null || nonnegative(level.sz) === null || !integer(level.n))
          return unavailable();
        levels.push({ px: level.px, sz: level.sz, n: level.n });
      }
      sides.push(levels);
    }
    const bids = at(sides, 0).sort((a, b) => scaled(a.px) > scaled(b.px) ? -1 : scaled(a.px) < scaled(b.px) ? 1 : 0).slice(0, depth);
    const asks = at(sides, 1).sort((a, b) => scaled(a.px) < scaled(b.px) ? -1 : scaled(a.px) > scaled(b.px) ? 1 : 0).slice(0, depth);
    const bid = bids[0];
    const ask = asks[0];
    const spread = bid && ask ? scaled(ask.px) - scaled(bid.px) : null;
    const mid = bid && ask ? (scaled(ask.px) + scaled(bid.px)) / 2n : null;
    return {
      ...this.envelope(config),
      coin: canonical2,
      time: value.time,
      bids,
      asks,
      spreadPx: spread === null ? null : fixed(spread, 18).replace(/\.?0+$/, ""),
      midPx: mid === null ? null : fixed(mid, 18).replace(/\.?0+$/, ""),
      spreadBps: spread === null || mid === null || mid === 0n ? null : fixed(spread * 10000n * ONE / mid, 2)
    };
  }
  async candles(coin, opts = {}) {
    this.key();
    const window = perpsCandleWindow(opts, this.now());
    const [config, core] = await Promise.all([this.config(), this.core()]);
    const canonical2 = at(core.universe, resolve(core, coin)).name;
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "candleSnapshot",
      req: { coin: canonical2, interval: window.interval, startTime: window.startTime, endTime: window.endTime }
    });
    if (!Array.isArray(value))
      return unavailable();
    const candles = [];
    for (const c of value) {
      if (!object(c) || !integer(c.t) || !integer(c.T) || !integer(c.n) || ![c.o, c.h, c.l, c.c, c.v].every((v) => nonnegative(v) !== null) || c.s !== canonical2 || c.i !== window.interval)
        return unavailable();
      if (c.t <= window.endTime && c.T >= window.startTime)
        candles.push({
          t: c.t,
          T: c.T,
          o: c.o,
          h: c.h,
          l: c.l,
          c: c.c,
          v: c.v,
          n: c.n
        });
    }
    candles.sort((a, b) => a.t - b.t);
    return {
      ...this.envelope(config),
      coin: canonical2,
      interval: window.interval,
      candles: candles.slice(-window.count)
    };
  }
  async fundingHistory(coin, opts = {}) {
    this.key();
    const window = perpsFundingWindow(opts, this.now());
    const [config, core] = await Promise.all([this.config(), this.core()]);
    const canonical2 = at(core.universe, resolve(core, coin)).name;
    const value = await info(this.opts.fetcher, this.opts.network, {
      type: "fundingHistory",
      coin: canonical2,
      startTime: window.startTime,
      endTime: window.endTime
    });
    return {
      ...this.envelope(config),
      coin: canonical2,
      startTime: window.startTime,
      endTime: window.endTime,
      ...parsePerpsFundingHistory(value, canonical2, window)
    };
  }
  async predictedFunding() {
    this.key();
    const [config, core, extras] = await Promise.all([this.config(), this.core(), this.extras()]);
    if (extras.predicted === null)
      return unavailable();
    const predicted = [];
    for (const meta of core.universe) {
      const row = extras.predicted.get(meta.name);
      if (row)
        predicted.push({
          coin: meta.name,
          fundingRate: row.fundingRate,
          fundingAprPct: fixed(scaled(row.fundingRate) * 876000n, 2),
          nextFundingTime: row.nextFundingTime
        });
    }
    predicted.sort((a, b) => a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0);
    return { ...this.envelope(config, extras.warnings, this.extrasCache?.at ?? this.now()), predicted };
  }
}

// src/hyperliquid-risk.ts
var HYPERLIQUID_RISK_INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info"
};
var PERPS_RISK_FIELDS = [
  "warnDistanceBps",
  "criticalDistanceBps",
  "warnMarginRatioBps",
  "criticalMarginRatioBps",
  "clearBandBps"
];
var HYPERLIQUID_RISK_DEFAULTS = {
  warnDistanceBps: 1500,
  criticalDistanceBps: 700,
  warnMarginRatioBps: 6000,
  criticalMarginRatioBps: 8000,
  clearBandBps: 200
};
function effectivePerpsRisk(stored) {
  const out = { ...HYPERLIQUID_RISK_DEFAULTS };
  for (const field of PERPS_RISK_FIELDS) {
    const value = stored?.[field];
    if (typeof value === "number")
      out[field] = value;
  }
  return out;
}
function perpsRiskProblem(t) {
  const ranges = {
    warnDistanceBps: [1, 9900],
    criticalDistanceBps: [1, 9900],
    warnMarginRatioBps: [1, 9999],
    criticalMarginRatioBps: [1, 9999],
    clearBandBps: [0, 1000]
  };
  for (const field of PERPS_RISK_FIELDS) {
    const value = t[field];
    const [min, max] = ranges[field];
    if (!Number.isInteger(value) || value < min || value > max)
      return `${field} must be a whole number of bps from ${min} to ${max}`;
  }
  if (t.criticalDistanceBps >= t.warnDistanceBps)
    return "criticalDistanceBps must be below warnDistanceBps";
  if (t.warnMarginRatioBps >= t.criticalMarginRatioBps)
    return "warnMarginRatioBps must be below criticalMarginRatioBps";
  return null;
}
function perpsRiskFromLimits(body) {
  const record = isRecord(body) ? body : {};
  const reported = "perpsRisk" in record || "perpsRiskEffective" in record;
  const stored = isRecord(record.perpsRisk) ? pickSettings(record.perpsRisk) : null;
  if (!reported)
    return { thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" }, stored };
  const effective = isRecord(record.perpsRiskEffective) ? effectivePerpsRisk(pickSettings(record.perpsRiskEffective)) : effectivePerpsRisk(stored);
  if (perpsRiskProblem(effective) !== null)
    return { thresholds: { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" }, stored };
  const source = stored && Object.keys(stored).length > 0 ? "key" : "defaults";
  return { thresholds: { ...effective, source }, stored };
}
function pickSettings(raw) {
  const out = {};
  for (const field of PERPS_RISK_FIELDS)
    if (typeof raw[field] === "number")
      out[field] = raw[field];
  return out;
}

class HyperliquidReadError extends Error {
  rateLimited;
  code = "PERPS_READ_FAILED";
  constructor(message, rateLimited = false) {
    super(message);
    this.rateLimited = rateLimited;
    this.name = "HyperliquidReadError";
  }
}
var INFO_TIMEOUT_MS = 5000;
var RATE_LIMIT_RETRY_MS = 1000;
async function hyperliquidInfo(fetcher, network, body, opts = {}) {
  const sleep2 = opts.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  for (let attempt = 0;; attempt++) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? INFO_TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await fetcher(HYPERLIQUID_RISK_INFO_URLS[network], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      text = res.ok ? await res.text() : "";
    } catch {
      throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} read failed or timed out`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      if (attempt === 0) {
        await sleep2(RATE_LIMIT_RETRY_MS);
        continue;
      }
      throw new HyperliquidReadError(`Hyperliquid rate-limited the ${String(body.type)} read (HTTP 429)`, true);
    }
    if (!res.ok)
      throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} answered HTTP ${res.status ?? "?"}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new HyperliquidReadError(`Hyperliquid ${String(body.type)} answered with something other than JSON`);
    }
  }
}
async function readHyperliquidMarketSnapshot(fetcher, network, opts = {}) {
  const sleep2 = opts.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  let limited = false;
  const watched = async (url, init) => {
    const res = await fetcher(url, init);
    limited = res.status === 429;
    return res;
  };
  try {
    return await readHyperliquidMarkets(watched, network);
  } catch {
    await sleep2(RATE_LIMIT_RETRY_MS);
  }
  try {
    return await readHyperliquidMarkets(watched, network);
  } catch (error) {
    throw new HyperliquidReadError(`Hyperliquid metaAndAssetCtxs read failed${error instanceof PerpsMarketError ? ` (${error.code})` : ""}`, limited);
  }
}
function hyperliquidMark(markets, coin) {
  const index = markets.universe.findIndex((m) => m.name === coin);
  const mark = index < 0 ? undefined : markets.ctxs[index]?.markPx;
  if (typeof mark !== "string")
    return null;
  const parsed = dec(mark);
  return parsed !== null && parsed > 0n ? mark : null;
}
async function readHyperliquidClearinghouse(fetcher, network, address, opts = {}) {
  return parseClearinghouse(await hyperliquidInfo(fetcher, network, { type: "clearinghouseState", user: address.toLowerCase() }, opts));
}
async function readHyperliquidAccountMode(fetcher, network, address, opts = {}) {
  const body = await hyperliquidInfo(fetcher, network, { type: "userAbstraction", user: address.toLowerCase() }, opts);
  if (typeof body !== "string" || body === "")
    throw new HyperliquidReadError("Unexpected userAbstraction shape");
  return body;
}
var HYPERLIQUID_STANDARD_MODES = ["default", "disabled"];
function parseClearinghouse(body) {
  const bad = (what) => new HyperliquidReadError(`Unexpected clearinghouseState shape (${what})`);
  if (!isRecord(body))
    throw bad("not an object");
  const summary = (value, name) => {
    if (!isRecord(value) || !isDecString(value.accountValue) || !isDecString(value.totalMarginUsed))
      throw bad(name);
    return { accountValue: value.accountValue, totalMarginUsed: value.totalMarginUsed };
  };
  const marginSummary = summary(body.marginSummary, "marginSummary");
  const crossMarginSummary = summary(body.crossMarginSummary, "crossMarginSummary");
  if (!isDecString(body.crossMaintenanceMarginUsed))
    throw bad("crossMaintenanceMarginUsed");
  if (!isDecString(body.withdrawable))
    throw bad("withdrawable");
  if (!Array.isArray(body.assetPositions))
    throw bad("assetPositions");
  const positions = body.assetPositions.map((entry) => {
    const p = isRecord(entry) ? entry.position : undefined;
    if (!isRecord(p) || typeof p.coin !== "string" || p.coin === "")
      throw bad("position");
    for (const field of ["szi", "entryPx", "positionValue", "unrealizedPnl", "returnOnEquity", "marginUsed"])
      if (!isDecString(p[field]))
        throw bad(`position ${field}`);
    const leverage = p.leverage;
    if (!isRecord(leverage) || typeof leverage.type !== "string" || typeof leverage.value !== "number")
      throw bad("position leverage");
    if (p.liquidationPx !== null && p.liquidationPx !== undefined && !isDecString(p.liquidationPx))
      throw bad("position liquidationPx");
    const funding = p.cumFunding;
    if (!isRecord(funding) || !isDecString(funding.sinceOpen))
      throw bad("position cumFunding");
    return {
      coin: p.coin,
      szi: p.szi,
      entryPx: p.entryPx,
      positionValue: p.positionValue,
      unrealizedPnl: p.unrealizedPnl,
      returnOnEquity: p.returnOnEquity,
      leverage: { type: leverage.type, value: leverage.value },
      liquidationPx: p.liquidationPx ?? null,
      marginUsed: p.marginUsed,
      cumFunding: { sinceOpen: funding.sinceOpen }
    };
  });
  return {
    marginSummary,
    crossMarginSummary,
    crossMaintenanceMarginUsed: body.crossMaintenanceMarginUsed,
    withdrawable: body.withdrawable,
    positions
  };
}
var PERPS_RISK_NOTE = "Phase 1 has no server-side monitor: nothing warns you unless you poll this or run candle perps watch.";
var RANK = { ok: 0, warn: 1, critical: 2 };
function worse(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}
function hyperliquidRiskReport(state, market, mode, thresholds, now, identity = { walletId: "", address: "", network: "mainnet" }) {
  const base = {
    schema: "candle.perps.risk/1",
    walletId: identity.walletId,
    address: identity.address,
    network: identity.network,
    mode,
    readAt: new Date(now).toISOString(),
    thresholds,
    note: PERPS_RISK_NOTE
  };
  if (!HYPERLIQUID_STANDARD_MODES.includes(mode)) {
    return {
      ...base,
      level: "unknown",
      reason: "PERPS_ACCOUNT_MODE",
      drivers: [],
      closest: null,
      account: null,
      positions: []
    };
  }
  const ch = isParsedClearinghouse(state) ? state : parseClearinghouse(state);
  if (!market || !Array.isArray(market.universe) || !Array.isArray(market.ctxs))
    throw new HyperliquidReadError("Unexpected metaAndAssetCtxs shape");
  const markets = market;
  const t = thresholds;
  const drivers = [];
  const nearest = [];
  let level = "ok";
  let unrealized = 0n;
  const positions = ch.positions.map((p) => {
    const szi = dec(p.szi);
    unrealized += dec(p.unrealizedPnl);
    const markPx = hyperliquidMark(markets, p.coin);
    const distance = markPx !== null && p.liquidationPx !== null ? distanceParts(markPx, p.liquidationPx) : null;
    let rowLevel = "none";
    if (distance) {
      rowLevel = fracLess(distance.num, distance.den, t.criticalDistanceBps) ? "critical" : fracLess(distance.num, distance.den, t.warnDistanceBps) ? "warn" : "ok";
    }
    const liquidationDistance = distance ? ratioNumber(distance.num, distance.den) : null;
    if (markPx === null) {
      drivers.push({
        kind: "position",
        coin: p.coin,
        level: "warn",
        liquidationDistance: null,
        threshold: null,
        reason: "unmarked"
      });
      level = worse(level, "warn");
    } else if (rowLevel === "warn" || rowLevel === "critical") {
      drivers.push({
        kind: "position",
        coin: p.coin,
        level: rowLevel,
        liquidationDistance,
        threshold: (rowLevel === "critical" ? t.criticalDistanceBps : t.warnDistanceBps) / 1e4
      });
      level = worse(level, rowLevel);
    } else if (rowLevel === "ok" && liquidationDistance !== null) {
      nearest.push({
        driver: {
          kind: "position",
          coin: p.coin,
          level: "ok",
          liquidationDistance,
          threshold: t.warnDistanceBps / 1e4
        },
        headroom: liquidationDistance / (t.warnDistanceBps / 1e4) - 1
      });
    }
    return {
      coin: p.coin,
      side: szi < 0n ? "short" : "long",
      size: p.szi.replace(/^-/, ""),
      entryPx: p.entryPx,
      markPx,
      unrealizedPnlUsd: p.unrealizedPnl,
      returnOnEquity: p.returnOnEquity,
      leverage: { value: p.leverage.value, type: p.leverage.type },
      liquidationPx: p.liquidationPx,
      liquidationDistance,
      fundingSinceOpenUsd: p.cumFunding.sinceOpen,
      marginUsedUsd: p.marginUsed,
      positionValueUsd: p.positionValue,
      level: rowLevel
    };
  });
  const maint = dec(ch.crossMaintenanceMarginUsed);
  const crossValue = dec(ch.crossMarginSummary.accountValue);
  let marginRatio = 0;
  if (positions.length > 0 && maint > 0n) {
    if (crossValue <= 0n) {
      marginRatio = null;
      drivers.push({
        kind: "margin",
        level: "critical",
        marginRatio: null,
        threshold: t.criticalMarginRatioBps / 1e4,
        reason: "no equity"
      });
      level = "critical";
    } else {
      marginRatio = ratioNumber(maint, crossValue);
      const marginLevel = fracGreater(maint, crossValue, t.criticalMarginRatioBps) ? "critical" : fracGreater(maint, crossValue, t.warnMarginRatioBps) ? "warn" : "ok";
      if (marginLevel === "ok") {
        nearest.push({
          driver: { kind: "margin", level: "ok", marginRatio, threshold: t.warnMarginRatioBps / 1e4 },
          headroom: 1 - marginRatio / (t.warnMarginRatioBps / 1e4)
        });
      } else {
        drivers.push({
          kind: "margin",
          level: marginLevel,
          marginRatio,
          threshold: (marginLevel === "critical" ? t.criticalMarginRatioBps : t.warnMarginRatioBps) / 1e4
        });
        level = worse(level, marginLevel);
      }
    }
  }
  drivers.sort((a, b) => RANK[b.level] - RANK[a.level]);
  nearest.sort((a, b) => a.headroom - b.headroom);
  const accountValue = dec(ch.marginSummary.accountValue);
  const marginUsed = dec(ch.marginSummary.totalMarginUsed);
  const free = accountValue - marginUsed;
  const account = {
    accountValueUsd: ch.marginSummary.accountValue,
    marginUsedUsd: ch.marginSummary.totalMarginUsed,
    crossAccountValueUsd: ch.crossMarginSummary.accountValue,
    freeMarginUsd: formatDec(free > 0n ? free : 0n),
    withdrawableUsd: ch.withdrawable,
    crossMaintenanceMarginUsedUsd: ch.crossMaintenanceMarginUsed,
    marginRatio,
    unrealizedPnlUsd: formatDec(unrealized),
    positionCount: positions.length,
    mode,
    level
  };
  return {
    ...base,
    level,
    reason: null,
    drivers,
    closest: level === "ok" ? nearest[0]?.driver ?? null : null,
    account,
    positions
  };
}
function unknownRiskReport(identity, thresholds, reason, now, mode = null) {
  return {
    schema: "candle.perps.risk/1",
    ...identity,
    mode,
    readAt: new Date(now).toISOString(),
    level: "unknown",
    reason,
    drivers: [],
    closest: null,
    thresholds,
    account: null,
    positions: [],
    note: PERPS_RISK_NOTE
  };
}
var PERPS_RISK_STALE_MS = 30000;
async function readPerpsRisk(opts) {
  const identity = { walletId: opts.walletId, address: opts.address, network: opts.network };
  const timed = async (read) => {
    const value = await read;
    return { value, at: opts.now() };
  };
  const [state, market, mode] = await Promise.all([
    timed(readHyperliquidClearinghouse(opts.fetcher, opts.network, opts.address, opts)),
    timed(readHyperliquidMarketSnapshot(opts.fetcher, opts.network, opts)),
    opts.mode !== undefined ? Promise.resolve({ value: opts.mode, at: Number.NaN }) : timed(readHyperliquidAccountMode(opts.fetcher, opts.network, opts.address, opts))
  ]);
  const times = [state.at, market.at, mode.at].filter((at2) => !Number.isNaN(at2));
  const earliest = Math.min(...times);
  if (Math.max(...times) - earliest > PERPS_RISK_STALE_MS)
    return unknownRiskReport(identity, opts.thresholds, "PERPS_READ_STALE", earliest, mode.value);
  return hyperliquidRiskReport(state.value, market.value, mode.value, opts.thresholds, earliest, identity);
}
function perpsRiskExitCode(level) {
  return level === "ok" ? 0 : level === "warn" ? 10 : level === "critical" ? 11 : 1;
}
var PERPS_FILLS_RESPONSE_CAP = 2000;
var PERPS_FUNDING_RESPONSE_CAP = 500;
var PERPS_RECENT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
function isMainPerpCoin(coin) {
  return typeof coin === "string" && coin !== "" && !coin.includes(":") && !coin.includes("/") && !coin.startsWith("@");
}
async function readPerpsRecent(fetcher, network, address, window, opts = {}) {
  const user = address.toLowerCase();
  const [fills, funding] = await Promise.all([
    hyperliquidInfo(fetcher, network, { type: "userFillsByTime", user, startTime: window.startTime, endTime: window.endTime }, opts),
    hyperliquidInfo(fetcher, network, { type: "userFunding", user, startTime: window.startTime, endTime: window.endTime }, opts)
  ]);
  return summarizePerpsRecent(fills, funding, window);
}
function summarizePerpsRecent(fills, funding, window) {
  if (!Array.isArray(fills))
    throw new HyperliquidReadError("Unexpected userFillsByTime shape");
  if (!Array.isArray(funding))
    throw new HyperliquidReadError("Unexpected userFunding shape");
  let realized = 0n;
  let fees = 0n;
  let paid = 0n;
  let fillCount = 0;
  let fundingCount = 0;
  for (const row of fills) {
    if (!isRecord(row))
      throw new HyperliquidReadError("Unexpected fill row");
    if (!isMainPerpCoin(row.coin))
      continue;
    const closed = dec(row.closedPnl);
    const fee = dec(row.fee);
    if (closed === null || fee === null)
      throw new HyperliquidReadError("Unexpected fill amount");
    realized += closed;
    fees += fee;
    fillCount++;
  }
  for (const row of funding) {
    const delta = isRecord(row) ? row.delta : undefined;
    if (!isRecord(delta))
      throw new HyperliquidReadError("Unexpected funding row");
    if (delta.type !== "funding" || !isMainPerpCoin(delta.coin))
      continue;
    const usdc = dec(delta.usdc);
    if (usdc === null)
      throw new HyperliquidReadError("Unexpected funding amount");
    paid += usdc;
    fundingCount++;
  }
  return {
    startTime: window.startTime,
    endTime: window.endTime,
    realizedPnlUsd: formatDec(realized),
    feesUsd: formatDec(fees),
    fundingUsd: formatDec(paid),
    fills: fillCount,
    fundingPayments: fundingCount,
    truncated: fills.length >= PERPS_FILLS_RESPONSE_CAP || funding.length >= PERPS_FUNDING_RESPONSE_CAP
  };
}
function perpsAccountReport(report, recent) {
  const { mode: _mode, level: _level, ...line } = report.account ?? {};
  return {
    schema: "candle.perps.account/1",
    walletId: report.walletId,
    address: report.address,
    network: report.network,
    mode: report.mode,
    readAt: report.readAt,
    ...line,
    recent,
    risk: { level: report.level, reason: report.reason, drivers: report.drivers }
  };
}
function perpsRiskClears(report, leaving) {
  const t = report.thresholds;
  const account = report.account;
  if (!account)
    return false;
  const distanceBps = (leaving === "warn" ? t.warnDistanceBps : t.criticalDistanceBps) + t.clearBandBps;
  const ratioBps = (leaving === "warn" ? t.warnMarginRatioBps : t.criticalMarginRatioBps) - t.clearBandBps;
  for (const p of report.positions) {
    if (p.markPx === null) {
      if (leaving === "warn")
        return false;
      continue;
    }
    if (p.liquidationPx === null)
      continue;
    const d = distanceParts(p.markPx, p.liquidationPx);
    if (d && fracLess(d.num, d.den, distanceBps))
      return false;
  }
  const maint = dec(account.crossMaintenanceMarginUsedUsd);
  if (report.positions.length > 0 && maint > 0n) {
    const crossValue = dec(account.crossAccountValueUsd);
    if (crossValue <= 0n)
      return false;
    if (fracGreater(maint, crossValue, ratioBps))
      return false;
  }
  return true;
}
function perpsRiskStep(previous, report) {
  const rule = report.level;
  if (rule === "unknown" || previous === "unknown")
    return rule;
  if (RANK[rule] >= RANK[previous])
    return rule;
  if (rule === "ok" && perpsRiskClears(report, "warn"))
    return "ok";
  if (previous === "critical" && perpsRiskClears(report, "critical"))
    return "warn";
  return previous;
}
var PERPS_WATCH_DEFAULT_INTERVAL_MS = 1e4;
var PERPS_WATCH_MAX_INTERVAL_MS = 300000;
var PERPS_WATCH_DEFAULT_HEARTBEAT_MS = 60000;
var PERPS_WATCH_REFRESH_MS = 300000;
var HYPERLIQUID_INFO_WEIGHTS = { clearinghouseState: 2, metaAndAssetCtxs: 20, userAbstraction: 20 };
function perpsWatchWeightPerMinute(intervalMs) {
  const polls = 60000 / intervalMs;
  const modeReads = 60000 / PERPS_WATCH_REFRESH_MS;
  return Math.round(polls * (HYPERLIQUID_INFO_WEIGHTS.clearinghouseState + HYPERLIQUID_INFO_WEIGHTS.metaAndAssetCtxs) + modeReads * HYPERLIQUID_INFO_WEIGHTS.userAbstraction);
}
async function watchPerpsRisk(opts) {
  const baseInterval = opts.intervalMs ?? PERPS_WATCH_DEFAULT_INTERVAL_MS;
  const heartbeatMs = opts.heartbeatMs ?? PERPS_WATCH_DEFAULT_HEARTBEAT_MS;
  const identity = { walletId: opts.walletId, address: opts.address, network: opts.network };
  const sleep2 = (ms) => abortableSleep(opts.sleep, ms, opts.signal);
  const info2 = { sleep: opts.sleep };
  let thresholds;
  try {
    thresholds = await opts.thresholds();
  } catch {
    thresholds = { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults (server did not report)" };
  }
  let thresholdsAt = opts.now();
  let mode;
  let modeAt = Number.NEGATIVE_INFINITY;
  let level = "unknown";
  let lastGoodAt = null;
  let staleReported = false;
  let interval = baseInterval;
  let lastHeartbeat = opts.now();
  let established = false;
  await opts.onEvent({
    event: "start",
    ...identity,
    at: new Date(opts.now()).toISOString(),
    intervalSeconds: baseInterval / 1000,
    heartbeatSeconds: heartbeatMs / 1000,
    thresholds,
    weightPerMinute: perpsWatchWeightPerMinute(baseInterval)
  });
  while (!opts.signal?.aborted) {
    if (opts.now() - thresholdsAt >= PERPS_WATCH_REFRESH_MS) {
      thresholdsAt = opts.now();
      try {
        thresholds = await opts.thresholds();
      } catch {}
    }
    let report = null;
    try {
      if (mode === undefined || opts.now() - modeAt >= PERPS_WATCH_REFRESH_MS) {
        mode = await readHyperliquidAccountMode(opts.fetcher, opts.network, opts.address, info2);
        modeAt = opts.now();
      }
      report = await readPerpsRisk({ ...identity, fetcher: opts.fetcher, thresholds, now: opts.now, mode, ...info2 });
      interval = baseInterval;
    } catch (error) {
      const rateLimited = error instanceof HyperliquidReadError && error.rateLimited;
      if (rateLimited)
        interval = Math.min(interval * 2, PERPS_WATCH_MAX_INTERVAL_MS);
      await opts.onEvent({
        event: "error",
        at: new Date(opts.now()).toISOString(),
        code: error instanceof HyperliquidReadError ? error.code : "PERPS_READ_FAILED",
        message: error instanceof Error ? error.message : "Hyperliquid read failed",
        nextPollSeconds: interval / 1000
      });
      if (level !== "unknown" && !staleReported && lastGoodAt !== null && opts.now() - lastGoodAt > PERPS_RISK_STALE_MS) {
        const previous = level;
        level = "unknown";
        staleReported = true;
        const stale = unknownRiskReport(identity, thresholds, "PERPS_READ_STALE", opts.now(), mode ?? null);
        await opts.onEvent({ ...stale, event: "level", level, ruleLevel: "unknown", previous });
        if (opts.onceLevelChange && established)
          return { level };
      }
    }
    if (report) {
      const previous = level;
      const next = perpsRiskStep(previous, report);
      if (report.level !== "unknown") {
        lastGoodAt = opts.now();
        staleReported = false;
      }
      if (next !== previous) {
        level = next;
        const cleared = next === "ok" && (previous === "warn" || previous === "critical");
        await opts.onEvent({
          ...report,
          event: "level",
          level: next,
          ruleLevel: report.level,
          previous,
          ...cleared ? { cleared: true } : {}
        });
        if (opts.onceLevelChange && established)
          return { level };
        if (next !== "unknown")
          established = true;
      } else if (next !== "unknown") {
        established = true;
      }
      if (heartbeatMs > 0 && opts.now() - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = opts.now();
        await opts.onEvent({ ...report, event: "heartbeat", level, ruleLevel: report.level });
      }
    }
    if (opts.signal?.aborted)
      break;
    await sleep2(interval);
  }
  return { level };
}
function abortableSleep(sleep2, ms, signal) {
  if (!signal)
    return sleep2(ms);
  if (signal.aborted)
    return Promise.resolve();
  return new Promise((resolve2) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve2();
    };
    signal.addEventListener("abort", done);
    sleep2(ms).then(done, done);
  });
}
var PERPS_PORTFOLIO_MAX_ACCOUNTS = 100;
var PORTFOLIO_READS_IN_FLIGHT = 8;
async function perpsPortfolioSection(fetcher, network, wallets, opts = {}) {
  const now = opts.now ?? Date.now;
  const considered = wallets.slice(0, PERPS_PORTFOLIO_MAX_ACCOUNTS);
  const unread = wallets.slice(PERPS_PORTFOLIO_MAX_ACCOUNTS).map((w) => ({ ...w, reason: `past the ${PERPS_PORTFOLIO_MAX_ACCOUNTS}-address cap` }));
  let markets = { universe: [], ctxs: [], marginTables: new Map };
  if (considered.length > 0) {
    try {
      markets = await readHyperliquidMarketSnapshot(fetcher, network, opts);
    } catch (error) {
      return { read: false, reason: error instanceof Error ? error.message : "Hyperliquid market read failed" };
    }
  }
  const thresholds = { ...HYPERLIQUID_RISK_DEFAULTS, source: "defaults" };
  const results = new Array(considered.length).fill(null);
  const failures = new Array(considered.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < considered.length) {
      const at2 = next++;
      const wallet = considered[at2];
      try {
        const state = await readHyperliquidClearinghouse(fetcher, network, wallet.address, opts);
        const report = hyperliquidRiskReport(state, markets, "default", thresholds, now());
        results[at2] = {
          address: wallet.address,
          ...wallet.label !== undefined ? { label: wallet.label } : {},
          ...wallet.walletId !== undefined ? { walletId: wallet.walletId } : {},
          accountValueUsd: report.account?.accountValueUsd ?? "0",
          unrealizedPnlUsd: report.account?.unrealizedPnlUsd ?? "0",
          positionCount: report.positions.length,
          level: report.level
        };
      } catch (error) {
        failures[at2] = error instanceof Error ? error.message : "read failed";
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_READS_IN_FLIGHT, considered.length) }, worker));
  const accounts = [];
  let empty = 0;
  let value = 0n;
  let pnl = 0n;
  considered.forEach((wallet, at2) => {
    const result = results[at2];
    if (!result) {
      unread.push({ ...wallet, reason: failures[at2] ?? "read failed" });
      return;
    }
    if (result.positionCount === 0 && dec(result.accountValueUsd) === 0n) {
      empty++;
      return;
    }
    accounts.push(result);
    value += dec(result.accountValueUsd);
    pnl += dec(result.unrealizedPnlUsd);
  });
  return {
    read: true,
    network,
    accounts,
    subtotal: { accountValueUsd: formatDec(value), unrealizedPnlUsd: formatDec(pnl) },
    empty,
    unread,
    thresholds: "defaults"
  };
}
var SCALE = 18;
var ONE2 = 10n ** BigInt(SCALE);
var DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
var LOOSE_DEC_RE = /^-?[0-9]+(\.[0-9]{1,18})?$/;
function isDecString(value) {
  return typeof value === "string" && (DEC_RE.test(value) || LOOSE_DEC_RE.test(value));
}
function dec(value) {
  if (!isDecString(value))
    return null;
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const scaled2 = BigInt(whole) * ONE2 + BigInt(fraction.padEnd(SCALE, "0"));
  return negative ? -scaled2 : scaled2;
}
function formatDec(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE2;
  const fraction = (abs % ONE2).toString().padStart(SCALE, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative && text !== "0" ? `-${text}` : text;
}
function distanceParts(markPx, liquidationPx) {
  const mark = dec(markPx);
  const liq = dec(liquidationPx);
  if (mark === null || liq === null || mark <= 0n)
    return null;
  const diff = mark - liq;
  return { num: diff < 0n ? -diff : diff, den: mark };
}
function fracLess(num, den, bps) {
  return num * 10000n < BigInt(bps) * den;
}
function fracGreater(num, den, bps) {
  return num * 10000n > BigInt(bps) * den;
}
function ratioNumber(num, den) {
  const micro = num * 1000000000000n / den;
  return Number(micro) / 1000000000000;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isParsedClearinghouse(value) {
  return isRecord(value) && Array.isArray(value.positions) && !("assetPositions" in value);
}

// src/hyperliquid-withdraw.ts
var CANDLE_PERPS_WITHDRAW_PINS = {
  token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  destinationDex: "",
  depositories: ["0x66cf0aace1b4e562593bec10ec7868fba9932224"],
  amountForm: "fixed6"
};
var ZERO = "0x0000000000000000000000000000000000000000";
var EVM_ADDRESS_RE2 = /^0x[0-9a-fA-F]{40}$/;
var BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
var RELAY_NONCE_MAPPING_TYPES = {
  NonceMapping: [
    { name: "chainId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "depositor", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "nonce", type: "uint256" }
  ]
};
var HYPERLIQUID_SEND_ASSET_TYPES = {
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" }
  ]
};
var SEND_ASSET_KEYS = HYPERLIQUID_SEND_ASSET_TYPES["HyperliquidTransaction:SendAsset"].map((field) => field.name);
var REQUEST_AMOUNT_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
var CANONICAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]{0,5}[1-9])?$/;
var FIXED6_RE = /^(0|[1-9][0-9]*)\.[0-9]{6}$/;
function parseWithdrawAmount(value) {
  if (!REQUEST_AMOUNT_RE.test(value))
    return null;
  const [whole = "0", frac = ""] = value.split(".");
  const micros = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0"));
  return micros > 0n ? micros : null;
}
function parseSendAssetAmount(value, form) {
  if (typeof value !== "string" || !(form === "canonical" ? CANONICAL_RE : FIXED6_RE).test(value))
    return null;
  const [whole = "0", frac = ""] = value.split(".");
  if (frac.length > 6)
    return null;
  return BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0"));
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys2(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function sameEvm(a, b) {
  return typeof a === "string" && EVM_ADDRESS_RE2.test(a) && a.toLowerCase() === b.toLowerCase();
}
function typesMatch(types, expected) {
  if (!isObject(types) || !exactKeys2(types, Object.keys(expected)))
    return false;
  return Object.entries(expected).every(([key, want]) => {
    const fields = types[key];
    return Array.isArray(fields) && fields.length === want.length && fields.every((field, i) => isObject(field) && exactKeys2(field, ["name", "type"]) && field.name === want[i]?.name && field.type === want[i]?.type);
  });
}
function domainMatches(domain, expected) {
  return isObject(domain) && exactKeys2(domain, ["name", "version", "chainId", "verifyingContract"]) && domain.name === expected.name && domain.version === expected.version && domain.chainId === expected.chainId && typeof domain.verifyingContract === "string" && domain.verifyingContract.toLowerCase() === ZERO;
}
function verifyWithdrawMapping(build, expect) {
  const refuse = (reason) => ({ ok: false, reason });
  if (expect.pins === null)
    return refuse("no withdrawal pins are set");
  if (build.id !== expect.id)
    return refuse("the build names another withdrawal id");
  if (!sameEvm(build.from?.address, expect.account))
    return refuse("the build withdraws from another account");
  if (build.to?.chain !== expect.to)
    return refuse(`the build lands on ${String(build.to?.chain)}, not ${expect.to}`);
  const destination = build.to.address;
  const own = expect.ownDestinations.some((address) => address.startsWith("0x") ? sameEvm(destination, address) : destination === address);
  if (!own)
    return refuse("the build lands on a wallet that is not this key's own");
  if (parseWithdrawAmount(build.amountUsdc) !== expect.amountMicros)
    return refuse("the build is for another amount");
  const typed = build.typedData;
  if (!isObject(typed) || typed.primary_type !== "NonceMapping")
    return refuse("the typed data is not a NonceMapping");
  if (!domainMatches(typed.domain, { name: "RelayNonceMapping", version: "2", chainId: 1 }))
    return refuse("the NonceMapping domain is not Relay's");
  if (!typesMatch(typed.types, RELAY_NONCE_MAPPING_TYPES))
    return refuse("the NonceMapping type list differs");
  const message = typed.message;
  if (!isObject(message) || !exactKeys2(message, ["chainId", "wallet", "depositor", "id", "nonce"]))
    return refuse("the NonceMapping message has other fields");
  if (message.chainId !== "hyperliquid")
    return refuse("the NonceMapping names another chain");
  if (!sameEvm(message.wallet, expect.account))
    return refuse("the NonceMapping wallet is not this key's account");
  if (!sameEvm(message.depositor, expect.account))
    return refuse("the NonceMapping depositor is not this key's account");
  if (typeof build.relayOrderId !== "string" || !BYTES32_RE.test(build.relayOrderId))
    return refuse("the build has no Relay order id");
  if (typeof message.id !== "string" || !BYTES32_RE.test(message.id) || message.id !== build.relayOrderId)
    return refuse("the NonceMapping names another Relay order");
  if (message.nonce !== build.nonce || !Number.isSafeInteger(build.nonce) || build.nonce <= 0)
    return refuse("the NonceMapping nonce is not the build's");
  return { ok: true };
}
function verifyWithdrawSendAsset(authorization, expect) {
  const refuse = (reason) => ({ ok: false, reason });
  const pins = expect.pins;
  if (pins === null)
    return refuse("no withdrawal pins are set");
  const typed = authorization.typedData;
  if (!isObject(typed) || typed.primary_type !== "HyperliquidTransaction:SendAsset")
    return refuse("the typed data is not a SendAsset");
  if (!domainMatches(typed.domain, { name: "HyperliquidSignTransaction", version: "1", chainId: 42161 }))
    return refuse("the SendAsset domain is not Hyperliquid's user-signed domain");
  if (!typesMatch(typed.types, HYPERLIQUID_SEND_ASSET_TYPES))
    return refuse("the SendAsset type list differs");
  const m = typed.message;
  if (!isObject(m) || !exactKeys2(m, SEND_ASSET_KEYS))
    return refuse("the SendAsset message has other fields");
  if (m.hyperliquidChain !== "Mainnet")
    return refuse("the SendAsset is not on Mainnet");
  if (m.nonce !== expect.mappingNonce || authorization.nonce !== expect.mappingNonce)
    return refuse("the SendAsset nonce is not the NonceMapping's");
  if (parseSendAssetAmount(m.amount, pins.amountForm) !== expect.amountMicros)
    return refuse("the SendAsset amount is not the amount asked for");
  if (m.fromSubAccount !== "")
    return refuse("the SendAsset moves from a sub-account");
  if (m.sourceDex !== "")
    return refuse("the SendAsset moves from another dex");
  if (m.token !== pins.token)
    return refuse("the SendAsset moves another token");
  if (m.destinationDex !== pins.destinationDex)
    return refuse("the SendAsset names another destination dex");
  if (typeof m.destination !== "string" || !pins.depositories.includes(m.destination.toLowerCase()))
    return refuse("the SendAsset destination is not a Relay depository on the allow-list");
  const action = authorization.action;
  if (!isObject(action) || !exactKeys2(action, ["type", "signatureChainId", ...SEND_ASSET_KEYS]))
    return refuse("the action has other fields");
  if (action.type !== "sendAsset" || action.signatureChainId !== "0xa4b1")
    return refuse("the action is not a sendAsset");
  for (const key of SEND_ASSET_KEYS) {
    if (action[key] !== m[key])
      return refuse(`the action's ${key} differs from what is signed`);
  }
  return { ok: true };
}

// src/internal/rpc-endpoint.ts
function describeRpcEndpoint(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable rpc endpoint>";
  }
}

// src/launch-definition.ts
var LAUNCH_DEFINITION = {
  version: 1,
  wallet: {
    embeddedNames: [
      "embedded",
      "main"
    ],
    help: "The paying wallet: a TEE wallet name, or embedded (main) for the account's embedded wallet."
  },
  quoteDecimals: {
    sol: 9,
    usdc: 6,
    cndl: 6,
    eth: 18,
    usdg: 6
  },
  quoteChains: {
    sol: "solana",
    usdc: "solana",
    cndl: "solana",
    eth: "hood",
    usdg: "hood"
  },
  defaultQuote: {
    solana: "sol",
    hood: "eth"
  },
  buyLimits: {
    defaults: {
      sol: {
        env: "DEV_BUY_MAX_LAMPORTS",
        raw: "500000000",
        unit: "lamports"
      },
      usdc: {
        env: "DEV_BUY_MAX_USDC_RAW",
        raw: "500000000",
        unit: "USDC raw units"
      },
      cndl: {
        env: "DEV_BUY_MAX_CNDL_RAW",
        raw: "2000000000000",
        unit: "CNDL raw units"
      },
      eth: {
        env: "DEV_BUY_MAX_WEI",
        raw: "20000000000000000",
        unit: "wei"
      }
    },
    thresholdBps: 1000,
    presetThresholds: {
      "exp-a": {
        sol: "5000000000",
        cndl: "330000000000"
      },
      "exp-b": {
        sol: "5000000000",
        cndl: "330000000000"
      },
      "exp-c": {
        sol: "5000000000",
        cndl: "330000000000"
      }
    }
  },
  surfacesIntro: [
    "CLI: scripts and terminals. Agents always pass --json.",
    "MCP: chat agents (Claude, the connector). The same launch fields and results as the CLI's --json.",
    "SDK: code that embeds Candle."
  ],
  fields: [
    {
      key: "wallet",
      type: "string",
      help: "The paying wallet: a TEE wallet name, or embedded (main) for the account's embedded wallet.",
      required: true,
      surfaces: {
        cli: {
          flag: "--wallet",
          value: "<tee>|embedded"
        },
        mcp: {
          key: "wallet"
        },
        sdk: {
          key: "wallet"
        }
      }
    },
    {
      key: "clientLaunchId",
      type: "string",
      help: "An idempotency key of at most 128 characters; reuse it to recover the same launch.",
      range: {
        min: "1",
        max: "128",
        unit: "characters"
      },
      surfaces: {
        cli: {
          flag: "--client-trade-id",
          value: "<id>"
        },
        mcp: {
          key: "clientLaunchId"
        },
        sdk: {
          key: "clientLaunchId"
        }
      }
    },
    {
      key: "name",
      type: "string",
      help: "The token's name, at most 32 UTF-8 bytes.",
      required: true,
      range: {
        min: "1",
        max: "32",
        unit: "UTF-8 bytes"
      },
      surfaces: {
        cli: {
          flag: "--name",
          value: "<name>"
        },
        mcp: {
          key: "name"
        },
        sdk: {
          key: "name"
        }
      }
    },
    {
      key: "symbol",
      type: "string",
      help: "The token's ticker, at most 10 UTF-8 bytes.",
      required: true,
      range: {
        min: "1",
        max: "10",
        unit: "UTF-8 bytes"
      },
      surfaces: {
        cli: {
          flag: "--symbol",
          value: "<symbol>"
        },
        mcp: {
          key: "symbol"
        },
        sdk: {
          key: "symbol"
        }
      }
    },
    {
      key: "imageUrl",
      type: "url",
      help: "The roughly square token image at an https URL; --image <path> uploads a local file instead.",
      required: true,
      surfaces: {
        cli: {
          flag: "--image-url",
          value: "<https-url>"
        },
        mcp: {
          key: "imageUrl"
        },
        sdk: {
          key: "imageUrl"
        }
      }
    },
    {
      key: "bannerUrl",
      type: "url",
      help: "A wide banner at an https URL or a local file; uploads are public and permanent.",
      surfaces: {
        cli: {
          flag: "--banner",
          value: "<file|URL>"
        },
        mcp: {
          key: "bannerUrl"
        },
        sdk: {
          key: "bannerUrl"
        }
      }
    },
    {
      key: "description",
      type: "string",
      help: "The token's description, safe for on-chain JSON.",
      surfaces: {
        cli: {
          flag: "--description",
          value: "<text>"
        },
        mcp: {
          key: "description"
        },
        sdk: {
          key: "description"
        }
      }
    },
    {
      key: "socials.website",
      type: "url",
      help: "The token's website link as an absolute http(s) URL.",
      surfaces: {
        cli: {
          flag: "--website",
          value: "<url>"
        },
        mcp: {
          key: "socials.website"
        },
        sdk: {
          key: "socials.website"
        }
      }
    },
    {
      key: "socials.twitter",
      type: "url",
      help: "The token's X link as an absolute http(s) URL.",
      surfaces: {
        cli: {
          flag: "--x",
          value: "<url>"
        },
        mcp: {
          key: "socials.twitter"
        },
        sdk: {
          key: "socials.twitter"
        }
      }
    },
    {
      key: "socials.telegram",
      type: "url",
      help: "The token's telegram link as an absolute http(s) URL.",
      surfaces: {
        cli: {
          flag: "--telegram",
          value: "<url>"
        },
        mcp: {
          key: "socials.telegram"
        },
        sdk: {
          key: "socials.telegram"
        }
      }
    },
    {
      key: "socials.discord",
      type: "url",
      help: "The token's discord link as an absolute http(s) URL.",
      surfaces: {
        cli: {
          flag: "--discord",
          value: "<url>"
        },
        mcp: {
          key: "socials.discord"
        },
        sdk: {
          key: "socials.discord"
        }
      }
    },
    {
      key: "chain",
      type: "enum",
      values: [
        "solana",
        "hood"
      ],
      default: "solana",
      help: "The launch chain, inferred from the wallet, quote asset and dex version on the CLI.",
      surfaces: {
        cli: {
          derived: "wallet, --quote-asset and --dex-version"
        },
        mcp: {
          key: "chain"
        },
        sdk: {
          key: "chain"
        }
      }
    },
    {
      key: "quoteAsset",
      type: "enum",
      help: "The quote asset: sol, usdc or cndl on Solana; eth or usdg on Hood (defaults sol and eth).",
      values: [
        "sol",
        "usdc",
        "cndl",
        "eth",
        "usdg"
      ],
      surfaces: {
        cli: {
          flag: "--quote-asset",
          value: "sol|usdc|cndl|eth|usdg"
        },
        mcp: {
          key: "quoteAsset"
        },
        sdk: {
          key: "quoteAsset"
        }
      }
    },
    {
      key: "mode",
      type: "enum",
      help: "The curve mode: open or exclusive; test-open or test-exclusive need ENABLE_TEST_CURVES; exp-a, exp-b, exp-c and exp-custom are Solana sol/cndl only.",
      values: [
        "open",
        "exclusive",
        "test-open",
        "test-exclusive",
        "exp-a",
        "exp-b",
        "exp-c",
        "exp-custom"
      ],
      default: "open",
      surfaces: {
        cli: {
          flag: "--mode",
          value: "<mode>"
        },
        mcp: {
          key: "mode"
        },
        sdk: {
          key: "mode"
        }
      }
    },
    {
      key: "curve.virtualQuote",
      type: "decimal",
      help: "exp-custom's virtual quote, in whole quote units: 1 to 100 SOL or 66000 to 6600000 CNDL; requires --curve-g and EXP_CUSTOM_CURVES.",
      modes: [
        "exp-custom"
      ],
      chains: [
        "solana"
      ],
      requires: [
        "curve.threshold"
      ],
      range: {
        unit: "whole quote units",
        byQuote: {
          sol: {
            min: "1",
            max: "100"
          },
          cndl: {
            min: "66000",
            max: "6600000"
          }
        }
      },
      surfaces: {
        cli: {
          flag: "--curve-v",
          value: "<V>"
        },
        mcp: {
          key: "curve.virtualQuote"
        },
        sdk: {
          key: "curve.virtualQuote"
        }
      }
    },
    {
      key: "curve.threshold",
      type: "decimal",
      help: "exp-custom's graduation threshold, in whole quote units: 1 to 250 SOL or 66000 to 16500000 CNDL; requires --curve-v and EXP_CUSTOM_CURVES.",
      modes: [
        "exp-custom"
      ],
      chains: [
        "solana"
      ],
      requires: [
        "curve.virtualQuote"
      ],
      range: {
        unit: "whole quote units",
        byQuote: {
          sol: {
            min: "1",
            max: "250"
          },
          cndl: {
            min: "66000",
            max: "16500000"
          }
        }
      },
      surfaces: {
        cli: {
          flag: "--curve-g",
          value: "<G>"
        },
        mcp: {
          key: "curve.threshold"
        },
        sdk: {
          key: "curve.threshold"
        }
      }
    },
    {
      key: "creatorFeeBps",
      type: "enum",
      help: "An exp- mode's extra creator fee: 0, 100 or 200 bps on the curve and pool, paid to the creator in full.",
      values: [
        0,
        100,
        200
      ],
      default: 0,
      surfaces: {
        cli: {
          flag: "--creator-fee-bps",
          value: "0|100|200"
        },
        mcp: {
          key: "creatorFeeBps"
        },
        sdk: {
          key: "creatorFeeBps"
        }
      }
    },
    {
      key: "stakerAllocationBps",
      type: "integer",
      help: "The staker allocation, 50 to 1000 bps; defaults to 50, or 500 on exp- curves.",
      range: {
        min: "50",
        max: "1000",
        unit: "bps"
      },
      default: 50,
      surfaces: {
        cli: {
          flag: "--staker-allocation-bps",
          value: "<bps>"
        },
        mcp: {
          key: "stakerAllocationBps"
        },
        sdk: {
          key: "stakerAllocationBps"
        }
      }
    },
    {
      key: "poolFee.tier",
      type: "enum",
      help: "Solana's graduated pool fee: 25, 50 or 100 bps (default 50), or the ending rate with --pool-fee-from.",
      values: [
        25,
        50,
        100
      ],
      default: 50,
      chains: [
        "solana"
      ],
      surfaces: {
        cli: {
          flag: "--pool-fee",
          value: "25|50|100"
        },
        mcp: {
          key: "poolFee.tier"
        },
        sdk: {
          key: "poolFee.tier"
        }
      }
    },
    {
      key: "poolFee.startBps",
      type: "integer",
      help: "The falling pool fee's starting rate, at most 2500 bps; requires --pool-fee and --pool-fee-minutes.",
      range: {
        min: "25",
        max: "2500",
        unit: "bps"
      },
      chains: [
        "solana"
      ],
      requires: [
        "poolFee.tier",
        "poolFee.minutes"
      ],
      surfaces: {
        cli: {
          flag: "--pool-fee-from",
          value: "<bps>"
        },
        mcp: {
          key: "poolFee.startBps"
        },
        sdk: {
          key: "poolFee.startBps"
        }
      }
    },
    {
      key: "poolFee.minutes",
      type: "decimal",
      help: "The pool fee's fall time, at most 30 minutes; requires --pool-fee and --pool-fee-from.",
      wireType: "number",
      range: {
        min: "0.006666666666666667",
        max: "30",
        unit: "minutes"
      },
      chains: [
        "solana"
      ],
      requires: [
        "poolFee.tier",
        "poolFee.startBps"
      ],
      surfaces: {
        cli: {
          flag: "--pool-fee-minutes",
          value: "<min>"
        },
        mcp: {
          key: "poolFee.minutes"
        },
        sdk: {
          key: "poolFee.minutes"
        }
      }
    },
    {
      key: "poolFee.endBps",
      type: "enum",
      values: [
        25,
        50,
        100
      ],
      chains: [
        "solana"
      ],
      help: "The falling fee's ending rate, taken from --pool-fee.",
      surfaces: {
        cli: {
          derived: "--pool-fee with --pool-fee-from"
        },
        mcp: {
          key: "poolFee.endBps"
        },
        sdk: {
          key: "poolFee.endBps"
        }
      }
    },
    {
      key: "poolOpen",
      type: "enum",
      help: "Solana preset pools: curve_price opens at the curve's last price and burns the rest; omitted uses curve_price when allocations fit graduation.maxStakerCarveBps, otherwise legacy; explicit curve_price above that limit is refused.",
      values: [
        "legacy",
        "curve_price"
      ],
      chains: [
        "solana"
      ],
      surfaces: {
        cli: {
          flag: "--pool-open",
          value: "legacy|curve_price"
        },
        mcp: {
          key: "poolOpen"
        },
        sdk: {
          key: "poolOpen"
        }
      }
    },
    {
      key: "expPoolShape",
      type: "enum",
      help: "Solana exp- pools: floor by default, or full_range to open across the whole price range.",
      values: [
        "floor",
        "full_range"
      ],
      default: "floor",
      chains: [
        "solana"
      ],
      surfaces: {
        cli: {
          flag: "--exp-pool-shape",
          value: "floor|full_range"
        },
        mcp: {
          key: "expPoolShape"
        },
        sdk: {
          key: "expPoolShape"
        }
      }
    },
    {
      key: "dexVersion",
      type: "enum",
      help: "Hood only, required there: the Uniswap version the curve graduates to.",
      values: [
        "v3",
        "v4"
      ],
      chains: [
        "hood"
      ],
      surfaces: {
        cli: {
          flag: "--dex-version",
          value: "v3|v4"
        },
        mcp: {
          key: "dexVersion"
        },
        sdk: {
          key: "dexVersion"
        }
      }
    },
    {
      key: "visibility",
      type: "enum",
      help: "The token's visibility: production, test, local or hidden; test keys require test or hidden.",
      values: [
        "production",
        "test",
        "local",
        "hidden"
      ],
      default: "production",
      surfaces: {
        cli: {
          flag: "--visibility",
          value: "production|test|local|hidden"
        },
        mcp: {
          key: "visibility"
        },
        sdk: {
          key: "visibility"
        }
      }
    },
    {
      key: "buy",
      type: "decimal",
      help: "An optional first buy in whole quote units; zero or empty means no buy, and the server applies dev-buy ceilings and TEE_LAUNCH_BUYS_ENABLED for TEE buys.",
      default: "0",
      range: {
        min: "0",
        unit: "whole quote units"
      },
      more: "Default raw caps (apps/api/src/lib/headless-validation.ts): DEV_BUY_MAX_LAMPORTS=500000000, DEV_BUY_MAX_USDC_RAW=500000000, DEV_BUY_MAX_CNDL_RAW=2000000000000, DEV_BUY_MAX_WEI=20000000000000000. On exp- curves the lower of the quote cap and 10% of G applies.",
      surfaces: {
        cli: {
          flag: "--buy",
          value: "<amount>"
        },
        mcp: {
          key: "buy"
        },
        sdk: {
          key: "buy"
        }
      }
    },
    {
      key: "dryRun",
      type: "boolean",
      help: "Print the launch preview without building, signing or recording a launch; local image uploads still become public and permanent.",
      default: false,
      surfaces: {
        cli: {
          flag: "--dry-run"
        },
        mcp: {
          key: "dryRun"
        },
        sdk: {
          key: "dryRun"
        }
      }
    }
  ]
};

// src/launch-input.ts
function embeddedLaunchWallet(wallet) {
  return wallet === undefined || typeof wallet === "string" && LAUNCH_DEFINITION.wallet.embeddedNames.includes(wallet);
}
function launchInputError(field, message, code = "VALIDATION_FAILED") {
  return new CandleApiError({ status: 400, code, field, message, retryable: false });
}
function validateLaunchInput(req) {
  if (req.buy !== undefined && req.buyAmount !== undefined)
    throw launchInputError("buy", "Pass buy or the deprecated buyAmount, never both.");
  if (req.wallet !== undefined && "linkedWalletId" in req)
    throw launchInputError("wallet", "Pass wallet without the legacy linkedWalletId field.");
  if (req.wallet !== undefined && typeof req.wallet !== "string" && (!req.wallet || typeof req.wallet.linkedWalletId !== "string" || !req.wallet.linkedWalletId || typeof req.wallet.privyWalletId !== "string" || !req.wallet.privyWalletId))
    throw launchInputError("wallet", "wallet needs linkedWalletId and privyWalletId.");
  if (req.buy !== undefined && (typeof req.buy !== "string" || req.buy.trim() !== "" && !/^\d+(\.\d+)?$/.test(req.buy)))
    throw launchInputError("buy", "buy must be a non-negative decimal string in whole quote units.");
  const keys = LAUNCH_DEFINITION.fields.filter((field) => field.key.startsWith("socials.")).map((field) => field.key.slice(8));
  if (req.socials !== undefined) {
    if (!req.socials || typeof req.socials !== "object" || Array.isArray(req.socials))
      throw launchInputError("socials", `socials accepts only ${keys.join(", ")}.`);
    for (const [key, value] of Object.entries(req.socials)) {
      if (!keys.includes(key))
        throw launchInputError("socials", `socials accepts only ${keys.join(", ")}.`);
      if (value === undefined)
        continue;
      try {
        if (typeof value !== "string")
          throw new Error;
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error;
      } catch {
        throw launchInputError(`socials.${key}`, `${key} must be an http(s) URL.`);
      }
    }
  }
  if (req.quoteAsset !== undefined || req.chain !== undefined || embeddedLaunchWallet(req.wallet))
    launchBody(req);
}
function launchBody(req, chain) {
  const { wallet: _wallet, buy, ...body } = req;
  if (chain !== undefined)
    body.chain = chain;
  const quote = body.quoteAsset ?? LAUNCH_DEFINITION.defaultQuote[body.chain ?? "solana"];
  const quoteChain = LAUNCH_DEFINITION.quoteChains[quote];
  if (!quoteChain)
    throw launchInputError("quoteAsset", "Unsupported launch quote asset.");
  if (body.chain !== undefined && body.chain !== quoteChain)
    throw launchInputError("quoteAsset", "The quote asset disagrees with the launch chain.", "CHAIN_MISMATCH");
  if (buy === undefined || buy.trim() === "" || /^0+(\.0+)?$/.test(buy))
    return body;
  const decimals = LAUNCH_DEFINITION.quoteDecimals[quote];
  const [whole = "0", fraction = ""] = buy.split(".");
  if (fraction.length > decimals)
    throw launchInputError("buy", `buy allows at most ${decimals} decimals for ${quote}.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  if (raw === 0n)
    return body;
  if (quoteChain === "solana" && raw > BigInt(Number.MAX_SAFE_INTEGER))
    throw launchInputError("buy", "buy exceeds the safe integer range for this quote asset.");
  body.buyAmount = quoteChain === "solana" ? Number(raw) : String(raw);
  return body;
}

// src/perps-history.ts
var PERPS_HISTORY_INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info"
};
var PERPS_HISTORY_DEFAULT_LIMIT = 100;
var PERPS_HISTORY_MAX_LIMIT = { fills: 2000, funding: 500 };
var PERPS_HISTORY_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
var PERPS_HISTORY_REQUEST_BUDGET = 10;
var PERPS_HISTORY_FILL_RETENTION = 1e4;
var PERPS_HISTORY_MAX_CURSOR_LENGTH = 200000;
var PERPS_HISTORY_TIMEOUT_MS = 15000;

class PerpsHistoryError extends Error {
  code;
  extra;
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "PerpsHistoryError";
  }
}
var RETENTION_TEXT = "Hyperliquid serves only the 10,000 most recent fills for an account; older fills cannot be read here, and this history is not an all-time total.";
var EVM_ADDRESS_RE3 = /^0x[0-9a-f]{40}$/;
function isTime(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function invalid(field, message) {
  return new PerpsHistoryError("VALIDATION_FAILED", message, { field });
}
function unavailable2(message, retryAfterMs) {
  return new PerpsHistoryError("PERPS_UNAVAILABLE", message, {
    retryable: true,
    ...retryAfterMs !== undefined ? { retryAfterMs } : {}
  });
}
function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes)
    binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new Error("not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function encodeCursor(state) {
  return `ph1.${base64UrlEncode(JSON.stringify(state))}`;
}
function decodeCursor(cursor) {
  if (cursor.length > PERPS_HISTORY_MAX_CURSOR_LENGTH || !cursor.startsWith("ph1."))
    throw invalid("cursor", "cursor is not one this client issued");
  let state;
  try {
    state = JSON.parse(base64UrlDecode(cursor.slice(4)));
  } catch {
    throw invalid("cursor", "cursor is not one this client issued");
  }
  const ok = state !== null && typeof state === "object" && state.v === 1 && (state.k === "fills" || state.k === "funding") && (state.n === "mainnet" || state.n === "testnet") && typeof state.w === "string" && EVM_ADDRESS_RE3.test(state.w) && isTime(state.s) && isTime(state.e) && state.s <= state.e && Number.isSafeInteger(state.l) && state.l >= 1 && state.l <= PERPS_HISTORY_MAX_LIMIT[state.k] && isTime(state.t) && state.t >= state.s && state.t <= state.e && Array.isArray(state.b) && state.b.every((id) => typeof id === "string" && id.length <= 512) && Number.isSafeInteger(state.c) && state.c >= 0;
  if (!ok)
    throw invalid("cursor", "cursor is not one this client issued");
  return state;
}
function canonical2(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonical2).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical2(record[key])}`).join(",")}}`;
}
function isDecimalString(value) {
  return typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value);
}
function asFill(raw) {
  const row = raw;
  if (!row || typeof row !== "object" || typeof row.coin !== "string" || !isTime(row.time) || !Number.isSafeInteger(row.tid) || !Number.isSafeInteger(row.oid) || !isDecimalString(row.px) || !isDecimalString(row.sz) || typeof row.side !== "string" || !isDecimalString(row.closedPnl) || !isDecimalString(row.fee) || row.builderFee !== undefined && !isDecimalString(row.builderFee))
    throw unavailable2("Hyperliquid returned a fill this client cannot read");
  return row;
}
function asFunding(raw) {
  const row = raw;
  const delta = row?.delta;
  if (!row || typeof row !== "object" || !isTime(row.time) || typeof row.hash !== "string" || !delta || typeof delta !== "object" || typeof delta.coin !== "string" || !isDecimalString(delta.usdc) || !isDecimalString(delta.fundingRate) || !isDecimalString(delta.szi))
    throw unavailable2("Hyperliquid returned a funding payment this client cannot read");
  return row;
}
function identity(kind, row) {
  if (kind === "fills") {
    const fill = row;
    return `${fill.coin}|${fill.tid}|${fill.oid}`;
  }
  const funding = row;
  return `${funding.hash}|${funding.time}|${funding.delta.coin}|${canonical2(funding.delta)}`;
}
function rowCoin(kind, row) {
  return kind === "fills" ? row.coin : row.delta.coin;
}
async function postInfo(req, body, what) {
  const controller = typeof AbortController === "function" ? new AbortController : null;
  const timer = controller ? setTimeout(() => controller.abort(), PERPS_HISTORY_TIMEOUT_MS) : null;
  let res;
  try {
    res = await req.fetch(PERPS_HISTORY_INFO_URLS[req.network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...controller ? { signal: controller.signal } : {}
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw unavailable2(aborted ? `Hyperliquid did not answer the ${what} read in time; retry shortly` : `Hyperliquid could not be reached for the ${what} read; retry shortly`);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 429) {
      const header = res.headers?.get("retry-after") ?? null;
      const seconds = header !== null && /^[0-9]{1,6}$/.test(header.trim()) ? Number(header.trim()) : undefined;
      throw unavailable2(`Hyperliquid rate-limited the ${what} read${seconds !== undefined ? `; retry after ${seconds}s` : "; retry shortly"}`, seconds !== undefined ? seconds * 1000 : undefined);
    }
    throw unavailable2(`Hyperliquid answered the ${what} read with HTTP ${res.status}; retry shortly`);
  }
  try {
    return JSON.parse(await res.text());
  } catch {
    throw unavailable2(`Hyperliquid returned an unreadable ${what} response`);
  }
}
async function mainPerpCoins(req) {
  let universe;
  try {
    universe = (await readHyperliquidMarkets(req.fetch, req.network)).universe;
  } catch {
    throw unavailable2("Hyperliquid's market list could not be read; history is not reported without it");
  }
  if (universe.length === 0)
    throw unavailable2("Hyperliquid's market list could not be read; history is not reported without it");
  return new Set(universe.map((market) => market.name));
}
function resolveWindow(req) {
  const options = req.options ?? {};
  const kind = req.kind;
  const address = req.address.toLowerCase();
  if (!EVM_ADDRESS_RE3.test(address))
    throw invalid("wallet", "The wallet's Hyperliquid account is not an EVM address");
  for (const field of ["startTime", "endTime"]) {
    const value = options[field];
    if (value !== undefined && !isTime(value))
      throw invalid(field, `${field} must be a whole, non-negative number of epoch milliseconds`);
  }
  const max = PERPS_HISTORY_MAX_LIMIT[kind];
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > max))
    throw invalid("limit", `limit must be a whole number from 1 to ${max} for ${kind}`);
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || options.cursor.length === 0)
      throw invalid("cursor", "cursor is not one this client issued");
    const state = decodeCursor(options.cursor);
    if (state.k !== kind)
      throw invalid("cursor", `This cursor pages ${state.k}, not ${kind}`);
    if (state.n !== req.network)
      throw invalid("cursor", `This cursor pages ${state.n}, not ${req.network}`);
    if (state.w !== address)
      throw invalid("cursor", "This cursor pages another wallet");
    if (options.startTime !== undefined && options.startTime !== state.s || options.endTime !== undefined && options.endTime !== state.e || options.limit !== undefined && options.limit !== state.l)
      throw invalid("cursor", "The window or page size changed; start again without a cursor");
    return { state };
  }
  const endTime = options.endTime ?? req.now();
  const startTime = options.startTime ?? Math.max(0, endTime - PERPS_HISTORY_DEFAULT_WINDOW_MS);
  if (!isTime(endTime))
    throw invalid("endTime", "endTime must be epoch milliseconds");
  if (startTime > endTime)
    throw invalid("startTime", "startTime must not be after endTime");
  return {
    state: {
      v: 1,
      k: kind,
      n: req.network,
      w: address,
      s: startTime,
      e: endTime,
      l: options.limit ?? PERPS_HISTORY_DEFAULT_LIMIT,
      t: startTime,
      b: [],
      c: 0
    }
  };
}
async function readPerpsHistoryPage(req) {
  const { state } = resolveWindow(req);
  const kind = req.kind;
  const max = PERPS_HISTORY_MAX_LIMIT[kind];
  const readAt = req.now();
  const coins = await mainPerpCoins(req);
  const page = [];
  const warnings = [];
  let t = state.t;
  let boundary = new Set(state.b);
  let consumed = state.c;
  let done = false;
  let truncated = false;
  let requests = 0;
  const stop = (code, message, ends) => {
    warnings.push({ code, message });
    if (ends) {
      done = true;
      truncated = true;
    }
  };
  walk:
    while (page.length < state.l && !done) {
      if (requests >= PERPS_HISTORY_REQUEST_BUDGET) {
        stop("PERPS_HISTORY_PAGE_BUDGET", `Stopped after ${PERPS_HISTORY_REQUEST_BUDGET} Hyperliquid reads; pass nextCursor to continue`, false);
        break;
      }
      const body = kind === "fills" ? { type: "userFillsByTime", user: state.w, startTime: t, endTime: state.e, aggregateByTime: false } : { type: "userFunding", user: state.w, startTime: t, endTime: state.e };
      const raw = await postInfo(req, body, kind === "fills" ? "fills" : "funding");
      requests++;
      if (!Array.isArray(raw))
        throw unavailable2(`Hyperliquid returned an unreadable ${kind} response`);
      const rows = raw.map((r) => kind === "fills" ? asFill(r) : asFunding(r));
      const keyed = rows.map((row) => ({ row, id: identity(kind, row) })).sort((a, b) => a.row.time - b.row.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const full = rows.length >= max;
      const startedAt = t;
      let previousId = null;
      for (const { row, id } of keyed) {
        if (id === previousId)
          continue;
        previousId = id;
        if (row.time < t || row.time > state.e || row.time === t && boundary.has(id))
          continue;
        if (page.length >= state.l)
          break walk;
        if (row.time > t) {
          t = row.time;
          boundary = new Set;
        }
        boundary.add(id);
        consumed++;
        if (coins.has(rowCoin(kind, row)))
          page.push(row);
        if (kind === "fills" && consumed >= PERPS_HISTORY_FILL_RETENTION) {
          stop("PERPS_HISTORY_RETENTION_LIMIT", "Reached Hyperliquid's 10,000-fill retention across this cursor chain; older fills are not available", true);
          break walk;
        }
      }
      if (!full) {
        done = true;
      } else if (t === startedAt) {
        stop("PERPS_HISTORY_BOUNDARY_LIMIT", `More than ${max} ${kind === "fills" ? "fills" : "funding rows"} share one millisecond (${t}); coverage stops there`, true);
      }
    }
  if (kind === "fills" && !warnings.some((w) => w.code === "PERPS_HISTORY_RETENTION_LIMIT"))
    warnings.unshift({ code: "PERPS_HISTORY_RETENTION_LIMIT", message: RETENTION_TEXT });
  const nextCursor = done ? null : encodeCursor({ ...state, t, b: [...boundary], c: consumed });
  const envelope = {
    success: true,
    walletId: req.walletId,
    address: state.w,
    network: state.n,
    source: "hyperliquid",
    readAt,
    startTime: state.s,
    endTime: state.e,
    nextCursor,
    hasMore: nextCursor !== null,
    truncated,
    warnings
  };
  return kind === "fills" ? { ...envelope, fills: page } : { ...envelope, funding: page };
}

// src/token-pages.ts
class TokenPageError extends CandleApiError {
  idempotencyKey;
  latest;
  retryAfterHeader;
  constructor(error, options = {}) {
    super(error);
    this.name = "TokenPageError";
    this.idempotencyKey = options.idempotencyKey;
    this.latest = options.latest;
    this.retryAfterHeader = options.retryAfterHeader ?? null;
  }
}
function createTokenPagesClient(io) {
  function path(token, suffix = "") {
    return `/api/v1/token-pages/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.address)}${suffix}`;
  }
  function query(options = {}) {
    const params = new URLSearchParams;
    if (options.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options.cursor !== undefined)
      params.set("cursor", options.cursor);
    return params.size ? `?${params}` : "";
  }
  async function request(method, url, authenticated, body, idempotencyKey) {
    const headers = io.headers(authenticated);
    if (body !== undefined)
      headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined)
      headers["Idempotency-Key"] = idempotencyKey;
    const init = {
      method,
      headers,
      redirect: "error",
      cache: "no-store",
      ...body !== undefined ? { body: JSON.stringify(body) } : {}
    };
    const attempts = idempotencyKey === undefined ? 1 : 2;
    for (let attempt = 0;attempt < attempts; attempt++) {
      let response;
      let text;
      try {
        response = await io.fetch(`${io.apiUrl()}${url}`, init);
        text = await response.text();
      } catch {
        if (attempt + 1 < attempts)
          continue;
        throw new TokenPageError(new CandleApiError({
          code: idempotencyKey ? "OUTCOME_UNKNOWN" : "NETWORK_ERROR",
          status: 0,
          message: idempotencyKey ? "No complete answer; replay the same body with this idempotency key." : "No complete answer from Candle.",
          retryable: true
        }), { idempotencyKey });
      }
      if (!response.ok) {
        let refusal = {};
        try {
          refusal = JSON.parse(text);
        } catch {}
        const error = refusal?.success === false && typeof refusal.error === "string" ? new CandleApiError({
          code: refusal.error,
          message: `Token page request refused (${refusal.error}).`,
          status: response.status,
          retryable: false
        }) : candleApiErrorFromResponse(response.status, text);
        throw new TokenPageError(error, {
          idempotencyKey,
          latest: refusal?.latest,
          retryAfterHeader: response.headers.get("retry-after")
        });
      }
      try {
        const envelope = JSON.parse(text);
        if (envelope?.success !== true || !("data" in envelope))
          throw new Error;
        return envelope.data;
      } catch {
        throw new TokenPageError(new CandleApiError({
          code: idempotencyKey ? "OUTCOME_UNKNOWN" : "BAD_RESPONSE",
          message: "Candle returned an invalid response.",
          status: response.status,
          retryable: false
        }), { idempotencyKey });
      }
    }
    throw new Error("Unreachable");
  }
  async function write(method, url, body, options = {}) {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    if (!idempotencyKey.length || idempotencyKey.length > 128)
      throw new Error("idempotencyKey must be 1 to 128 characters");
    return { data: await request(method, url, true, body, idempotencyKey), idempotencyKey };
  }
  const sectionPath = (section) => `/sections/${encodeURIComponent(section)}`;
  return {
    about: (token) => request("GET", path(token), false),
    capabilities: (token) => request("GET", path(token, "/capabilities"), true),
    burns: (token, options) => request("GET", path(token, `/burns${query(options)}`), false),
    history: (token, section, options) => request("GET", path(token, `${sectionPath(section)}/history${query(options)}`), false),
    creatorChallenge: (token) => request("POST", path(token, "/creator-challenges"), true, {}),
    claim: (token, body, options) => write("POST", path(token, "/claims"), body, options),
    setSection: (token, section, body, options) => write("PUT", path(token, sectionPath(section)), body, options),
    restoreSection: (token, section, body, options) => write("POST", path(token, `${sectionPath(section)}/restore`), body, options),
    flag: (token, body, options) => write("POST", path(token, "/flags"), body, options)
  };
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
function historyTime(value) {
  return value instanceof Date ? String(value.getTime()) : String(value);
}
async function openPerpsStreamSocket(url, options, injected) {
  if (injected)
    return new injected(url, options);
  const globalWebSocket = globalThis.WebSocket;
  if (globalWebSocket)
    return new globalWebSocket(url, options);
  try {
    const undici = await import("undici");
    return new undici.WebSocket(url, options);
  } catch (error) {
    throw new Error(`perpsStream(): this runtime has no header-capable WebSocket and undici could not be loaded (${error instanceof Error ? error.message : String(error)}). Pass perpsStreamWebSocket in ` + "CandleClientOptions — undici's WebSocket works on Node 18+ (https://undici.nodejs.org/api/WebSocket)");
  }
}
var HYPERLIQUID_RELAY_CHAIN_ID = 1337;
var HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000";
function perpsClientId(clientId) {
  if (clientId === undefined)
    return;
  const lower = typeof clientId === "string" ? clientId.toLowerCase() : "";
  if (!HYPERLIQUID_CLOID_RE.test(lower))
    throw new Error("perps: clientId must be 0x followed by 32 hex digits");
  return lower;
}
function perpsReplayOf(build, walletId, clientId) {
  const answer = build;
  if (answer.replayed === true) {
    if (clientId === undefined || answer.clientId !== clientId || answer.walletId !== walletId)
      throw new Error("perps: refused a replay that does not name this request's client id and wallet");
    return {
      replayed: true,
      replay: build,
      build: null,
      signature: null,
      submitted: false,
      exchange: null
    };
  }
  if (clientId !== undefined && (answer.clientId !== clientId || answer.cloid !== clientId))
    throw new Error("perps: PERPS_CLIENT_ID_UNSUPPORTED: this Candle API did not echo the client order id, so its order could not be deduplicated. Nothing was signed.");
  return null;
}
function perpsDepositProblem(build, params) {
  const same = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (build.walletId !== params.walletId)
    return "the build names another paying wallet";
  if (build.asset !== params.asset || build.amountRaw !== params.amountRaw)
    return "the build is for another amount";
  if (build.destination?.chainId !== HYPERLIQUID_RELAY_CHAIN_ID)
    return "the build does not land on Hyperliquid";
  if (build.destination.currency !== HYPERLIQUID_RELAY_USDC)
    return "the build does not deliver Hyperliquid USDC";
  if (!same(build.destination.address, params.account))
    return "the build lands on another account";
  if (build.fee?.bps !== 0 || build.fee.feeRaw !== "0")
    return "the build carries a Candle fee";
  const hood = params.asset === "ETH" || params.asset === "USDG";
  if (hood !== (build.chain === "hood"))
    return "the build pays from the wrong chain";
  if (hood && !same(build.walletAddress, params.account))
    return "a Hood deposit lands only on the paying wallet's own account";
  if (!hood && build.transactionsBase64?.length !== 1)
    return "the build is not one Solana deposit";
  return null;
}
var BACKOFF_BASE_MS = 250;
var BACKOFF_CAP_MS = 8000;
function retryDelayMs(retry) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_CAP_MS);
  return base / 2 + Math.random() * (base / 2);
}
function isRetryableLaunchFailure(error) {
  if (!(error instanceof CandleApiError))
    return true;
  if (error.stage === "executed" || error.stage === "unconfirmed" || error.mint !== undefined)
    return false;
  if (error.code.startsWith("HTTP_"))
    return error.status >= 500;
  if (!error.retryable)
    return false;
  return error.status >= 500 || error.status === 409;
}
function sleep2(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
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
    message: `${error.message} -- this transaction was rebuilt with a fresh blockhash ${MAX_BLOCKHASH_REBUILDS} times and still failed at broadcast, which usually means the configured Solana RPC is lagging or rate-limited. Point solanaRpcUrl at a fast endpoint (for example Helius).`,
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
  throw new Error(`CandleClient: refusing to send credentials in the clear to ${parsed.origin}. Use https://.` + (isPrivateHost(parsed.hostname) ? " Pass allowInsecureHttp: true if this really is a trusted local endpoint." : " allowInsecureHttp does not apply here: it covers private networks only, and this is a public address."));
}
var REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
var MAX_REDIRECTS = 5;

class CrossOriginRedirectError extends Error {
  from;
  to;
  constructor(from, to) {
    super(`The API at ${from} redirected to ${to}, another origin. Not followed, so the API key was not sent there.`);
    this.from = from;
    this.to = to;
    this.name = "CrossOriginRedirectError";
  }
}
function keyedRedirectGuard(doFetch) {
  const guarded = async (input, init) => {
    if (input instanceof Request || !init?.headers || !new Headers(init.headers).has("x-api-key")) {
      return doFetch(input, init);
    }
    const url = input.toString();
    let current = url;
    let next = { ...init, redirect: "manual" };
    for (let hops = 0;; hops++) {
      const response = await doFetch(current, next);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null;
      if (!location)
        return response;
      const from = new URL(current);
      const target = new URL(location, from);
      if (target.origin !== from.origin)
        throw new CrossOriginRedirectError(from.origin, target.origin);
      if (hops >= MAX_REDIRECTS)
        throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
      const method = (next.method ?? "GET").toUpperCase();
      if (response.status === 303 && method !== "GET" && method !== "HEAD" || (response.status === 301 || response.status === 302) && method === "POST") {
        next = { ...next, method: "GET", body: undefined };
      }
      current = target.href;
    }
  };
  return guarded;
}

class CandleClient {
  tokenPages = createTokenPagesClient({
    fetch: (input, init) => this.fetchImpl(input, init),
    apiUrl: () => this.apiUrl,
    headers: (authenticated) => {
      if (authenticated)
        this.requireKey("tokenPages");
      const headers = this.headers();
      if (!authenticated)
        delete headers["x-api-key"];
      return headers;
    }
  });
  apiUrl;
  apiKey;
  fetchImpl;
  maxRetries;
  privyAppId;
  secretStore;
  solanaRpcUrl;
  evmRpcUrl;
  hyperliquidNetwork;
  perpsMarketReader;
  hyperliquidBuilder;
  perpsWithdrawPins;
  perpsStreamWebSocket;
  perps = {
    withdraw: {
      build: async (request) => {
        this.requireKey("perps.withdraw.build()");
        return this.requestJson("POST", "/api/v1/agent/perps/withdraw", request);
      },
      authorize: async (request) => {
        this.requireKey("perps.withdraw.authorize()");
        return this.requestJson("POST", "/api/v1/agent/perps/withdraw/authorize", request);
      },
      reportSubmitted: async (request) => {
        this.requireKey("perps.withdraw.reportSubmitted()");
        return this.requestJson("POST", "/api/v1/agent/perps/withdraw/submitted", request);
      },
      get: async (clientWithdrawalId) => {
        this.requireKey("perps.withdraw.get()");
        return this.requestJson("GET", `/api/v1/agent/perps/withdraw/${encodeURIComponent(clientWithdrawalId)}`);
      }
    }
  };
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
  fees = {
    list: async (opts = {}) => {
      this.requireKey("fees.list()");
      const params = new URLSearchParams;
      if (opts.cursor !== undefined)
        params.set("cursor", opts.cursor);
      if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
      const query = params.size ? `?${params}` : "";
      return this.requestJson("GET", `/api/v1/agent/fees${query}`);
    },
    claim: async (mint, opts = {}) => {
      this.requireKey("fees.claim()");
      return this.requestJson("POST", `/api/v1/agent/fees/${encodeURIComponent(mint)}/claim`, {
        dryRun: opts.dryRun === true
      });
    }
  };
  staking = {
    positions: async () => {
      this.requireKey("staking.positions()");
      return this.requestJson("GET", "/api/v1/agent/staking");
    },
    stake: async (request) => this.stakingBuild("stake", { ...request, payer: request.payer ?? "main" }),
    unstake: async (request) => this.stakingBuild("unstake", { ...request, payer: request.payer ?? "main" }),
    finish: async (request) => this.stakingBuild("finish", { ...request, payer: request.payer ?? "main" }),
    claimReward: async (rewardId) => {
      this.requireKey("staking.claimReward()");
      return this.requestJson("POST", `/api/v1/agent/staking/rewards/${encodeURIComponent(rewardId)}/claim`, {});
    },
    submit: async (request) => this.stakingBuild("submit", request),
    confirm: async (request) => this.stakingBuild("confirm", request)
  };
  async stakingBuild(action, request) {
    this.requireKey(`staking.${action}()`);
    return this.requestJson("POST", `/api/v1/agent/staking/${action === "submit" || action === "confirm" ? action : `${action}/build`}`, request);
  }
  constructor(opts) {
    assertTransportSecurity(opts.apiUrl, opts.allowInsecureHttp === true);
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    if (opts.apiKey !== undefined)
      this.apiKey = opts.apiKey;
    this.fetchImpl = keyedRedirectGuard(opts.fetch ?? fetch);
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
    this.perpsWithdrawPins = opts.perpsWithdrawPins ?? CANDLE_PERPS_WITHDRAW_PINS;
    if (opts.perpsStreamWebSocket !== undefined)
      this.perpsStreamWebSocket = opts.perpsStreamWebSocket;
    if (opts.hyperliquidBuilder !== undefined)
      this.hyperliquidBuilder = opts.hyperliquidBuilder;
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
  async getTokenEvents(chain, mint, opts = {}) {
    const params = new URLSearchParams;
    if (opts.since !== undefined)
      params.set("since", opts.since);
    if (opts.limit !== undefined)
      params.set("limit", String(opts.limit));
    if (opts.before !== undefined)
      params.set("before", opts.before);
    const query = params.toString();
    const body = await this.requestJson("GET", `/api/v1/tokens/${chain}/${encodeURIComponent(mint)}/events${query ? `?${query}` : ""}`);
    return {
      events: opts.kind === undefined ? body.events : body.events.filter((event) => event.kind === opts.kind),
      nextCursor: body.nextCursor
    };
  }
  async getTokenCard(chain, mint, opts = {}) {
    const query = opts.tag !== undefined ? `?${new URLSearchParams({ cst: opts.tag }).toString()}` : "";
    const body = await this.requestJson("GET", `/api/v1/tokens/${chain}/${encodeURIComponent(mint)}/card${query}`);
    return body.card;
  }
  async verify(chain, mint) {
    return this.requestJson("GET", `/api/v1/verify/${chain}/${encodeURIComponent(mint)}`);
  }
  async getOwnProfile() {
    this.requireKey("getOwnProfile()");
    return this.requestJson("GET", "/api/v1/agent/keys/self/public-profile");
  }
  async updateOwnProfile(patch) {
    this.requireKey("updateOwnProfile()");
    return this.requestJson("PATCH", "/api/v1/agent/keys/self/public-profile", patch);
  }
  async uploadProfileImage(kind, bytes, contentType) {
    this.requireKey("uploadProfileImage()");
    const form = new FormData;
    form.set("kind", kind);
    form.set("image", new Blob([bytes], { type: contentType }), "profile.image");
    const headers = this.headers();
    delete headers["Content-Type"];
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/uploads/agent-profile-image`, {
      method: "POST",
      headers,
      body: form
    });
    return this.parseResponse(res);
  }
  async createPost(req) {
    this.requireKey("createPost()");
    return this.requestJson("POST", "/api/v1/agent/posts", req);
  }
  async deletePost(postId) {
    this.requireKey("deletePost()");
    return this.requestJson("DELETE", `/api/v1/agent/posts/${encodeURIComponent(postId)}`);
  }
  async listAgentPosts(profileId, options = {}) {
    const params = new URLSearchParams;
    if (options.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options.cursor !== undefined)
      params.set("cursor", options.cursor);
    const body = await this.requestJson("GET", `/api/v1/agent/records/${encodeURIComponent(profileId)}/posts${params.size ? `?${params}` : ""}`);
    return { posts: body.posts, cursor: body.cursor ?? null };
  }
  async getAgentProfile(idOrWallet) {
    const body = await this.requestJson("GET", `/api/v1/users/${encodeURIComponent(idOrWallet)}/agent`);
    return body.agent;
  }
  async listAgents(options = {}) {
    const params = new URLSearchParams;
    if (options.sort !== undefined)
      params.set("sort", options.sort);
    if (options.strategy !== undefined)
      params.set("strategy", options.strategy);
    if (options.query !== undefined && options.query.trim() !== "")
      params.set("q", options.query);
    if (options.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options.cursor !== undefined)
      params.set("cursor", options.cursor);
    const body = await this.requestJson("GET", `/api/v1/agent/directory${params.size ? `?${params}` : ""}`);
    return body.directory;
  }
  async getAgentTier() {
    return this.requestJson("GET", "/api/v1/agent/tier");
  }
  async getPlans() {
    return this.requestJson("GET", "/api/v1/agent/plans");
  }
  async dryRunLaunch(req) {
    this.requireKey("dryRunLaunch()");
    const { body, wallet } = await this.prepareLaunch(req);
    return wallet ? this.dryRunSelfLaunch({ ...body, linkedWalletId: wallet.linkedWalletId }) : this.requestJson("POST", "/api/v1/launch/headless/dry-run", body);
  }
  async prepareLaunch(req) {
    validateLaunchInput(req);
    let wallet;
    let chain = req.chain;
    if (typeof req.wallet === "object") {
      wallet = req.wallet;
    } else if (typeof req.wallet === "string" && !embeddedLaunchWallet(req.wallet)) {
      const rows = [];
      const cursors = new Set;
      let cursor;
      while (true) {
        const page = await this.requestJson("GET", `/api/v1/agent/wallets/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        rows.push(...page.page);
        if (page.isDone === true)
          break;
        if (!page.continueCursor || cursors.has(page.continueCursor))
          throw launchInputError("wallet", "Wallet discovery did not complete.");
        cursor = page.continueCursor;
        cursors.add(cursor);
      }
      const matches = rows.filter((row2) => row2.id === req.wallet || row2.label === req.wallet || (row2.chain === "evm" ? row2.address.toLowerCase() === String(req.wallet).toLowerCase() : row2.address === req.wallet));
      if (matches.length !== 1) {
        const choices = (matches.length ? matches : rows).map((row2) => `${row2.label ?? row2.id} (${row2.id}, ${row2.address})`).join("; ");
        throw launchInputError("wallet", `Name one TEE wallet by label, id or address. Matches: ${choices || "none"}.`, "TEE_WALLET_REQUIRED");
      }
      const row = matches[0];
      if (!row.privyWalletId)
        throw launchInputError("wallet", "The wallet has no signing identifier.", "SIGNER_UNAVAILABLE");
      const walletChain = row.chain === "solana" ? "solana" : row.chain === "evm" ? "hood" : undefined;
      if (!walletChain)
        throw launchInputError("wallet", "The wallet chain is unsupported.", "CHAIN_MISMATCH");
      if (chain !== undefined && chain !== walletChain)
        throw launchInputError("chain", "The launch chain disagrees with the named wallet.", "CHAIN_MISMATCH");
      chain = walletChain;
      wallet = { linkedWalletId: row.id, privyWalletId: row.privyWalletId };
    }
    return { body: launchBody(req, chain), wallet };
  }
  async launch(req) {
    this.requireKey("launch()");
    const prepared = await this.prepareLaunch(req);
    if (prepared.wallet)
      return this.selfLaunch({ ...prepared.body, ...prepared.wallet });
    const clientLaunchId = req.clientLaunchId ?? generateClientLaunchId();
    const body = { ...prepared.body, clientLaunchId };
    return this.runOperation({ clientLaunchId }, "server-executed", async (op) => {
      let lastError;
      for (let attempt = 0;attempt <= this.maxRetries; attempt++) {
        if (attempt > 0)
          await sleep2(retryDelayMs(attempt - 1));
        try {
          const result = await this.requestJson("POST", "/api/v1/launch/headless", body, op);
          return { ...result, clientLaunchId };
        } catch (error) {
          if (!isRetryableLaunchFailure(error))
            throw error;
          lastError = error;
        }
      }
      throw lastError;
    });
  }
  async launchAsync(req) {
    this.requireKey("launchAsync()");
    validateLaunchInput(req);
    if (!embeddedLaunchWallet(req.wallet))
      throw launchInputError("wallet", "launchAsync() supports embedded launches; use launch() for a TEE wallet.");
    const clientLaunchId = req.clientLaunchId ?? generateClientLaunchId();
    const body = { ...launchBody(req), clientLaunchId, async: true };
    return this.runOperation({ clientLaunchId }, "server-executed", async (op) => {
      const accepted = await this.requestJson("POST", "/api/v1/launch/headless", body, op);
      return { ...accepted, clientLaunchId: accepted.clientLaunchId ?? clientLaunchId };
    });
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
    const params = new URLSearchParams;
    if (opts.limit !== undefined)
      params.set("limit", String(opts.limit));
    if (opts.since !== undefined)
      params.set("since", historyTime(opts.since));
    if (opts.until !== undefined)
      params.set("until", historyTime(opts.until));
    if (opts.cursor !== undefined)
      params.set("cursor", opts.cursor);
    const query = params.toString() === "" ? "" : `?${params.toString()}`;
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
    const { wallet, ...body } = req;
    return this.requestJson("POST", wallet === undefined ? "/api/v1/agent/wallets/embedded/close-empty/preview" : `/api/v1/agent/wallets/${encodeURIComponent(wallet)}/close-empty/preview`, body);
  }
  async closeEmptyAccounts(req) {
    this.requireKey("closeEmptyAccounts()");
    const { wallet, privyWalletId, ...body } = req;
    if (wallet === undefined)
      return this.requestJson("POST", "/api/v1/agent/wallets/embedded/close-empty", body);
    if (!privyWalletId)
      throw new Error("closeEmptyAccounts() with a TEE wallet requires privyWalletId: the same wallet's Privy wallet id, which signLinkedTransaction() signs for");
    const base = `/api/v1/agent/wallets/${encodeURIComponent(wallet)}/close-empty`;
    const build = await this.requestJson("POST", `${base}/build`, body);
    if (build.status === "nothing_to_close")
      return {
        closed: [],
        signatures: [],
        lamportsRecovered: "0",
        solRecovered: "0",
        feeLamports: "0",
        netLamports: "0",
        netSol: "0",
        failed: [],
        unattempted: [],
        notClosed: [],
        skipped: [],
        remaining: 0,
        ...build
      };
    if (build.submitState !== undefined) {
      const job = await this.getCloseEmptyAccountsJob(req.clientTradeId, { wallet });
      const status = job.httpStatus ?? 200;
      if (status >= 400)
        throw candleApiErrorFromResponse(status, JSON.stringify(job.result ?? {}));
      return job.result;
    }
    const signed = [];
    for (const transaction of build.transactions) {
      const result = await this.signLinkedTransaction({
        chain: "solana",
        linkedWalletId: wallet,
        privyWalletId,
        unsignedTransactionBase64: transaction.unsignedTransaction
      });
      signed.push({ index: transaction.index, signedTransaction: result.signedTransaction });
    }
    return this.requestJson("POST", `${base}/submit`, {
      clientTradeId: req.clientTradeId,
      signed
    });
  }
  async getCloseEmptyAccountsJob(clientTradeId, opts = {}) {
    this.requireKey("getCloseEmptyAccountsJob()");
    const body = await this.requestJson("GET", opts.wallet === undefined ? `/api/v1/agent/wallets/embedded/close-empty/jobs/${encodeURIComponent(clientTradeId)}` : `/api/v1/agent/wallets/${encodeURIComponent(opts.wallet)}/close-empty/jobs/${encodeURIComponent(clientTradeId)}`);
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
  async dryRunSelfLaunch(req) {
    this.requireKey("dryRunSelfLaunch()");
    return this.requestJson("POST", "/api/v1/launch/self/dry-run", req);
  }
  async buildSelfLaunch(req) {
    return this.postSelfLaunchBuild(req);
  }
  async postSelfLaunchBuild(req, op) {
    this.requireKey("buildSelfLaunch()");
    const built = await this.requestJson("POST", "/api/v1/launch/self/build", req, op);
    return { ...built, clientLaunchId: built.clientLaunchId ?? req.clientLaunchId };
  }
  async confirmSelfLaunch(req) {
    this.requireKey("confirmSelfLaunch()");
    const result = await this.requestJson("POST", "/api/v1/launch/self/confirm", req);
    return { ...result, clientLaunchId: req.clientLaunchId };
  }
  async buildTrade(req) {
    return this.postTradeBuild(req);
  }
  async postTradeBuild(req, op) {
    this.requireKey("buildTrade()");
    return this.requestJson("POST", "/api/v1/trade/agent/build", req, op);
  }
  async getTradeJob(clientTradeId) {
    this.requireKey("getTradeJob()");
    const body = await this.requestJson("GET", `/api/v1/trade/agent/jobs/${encodeURIComponent(clientTradeId)}`);
    return body.job;
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
      throw new Error("signLinkedTransaction() requires privyAppId: pass one in CandleClientOptions (new CandleClient({ privyAppId })) -- the same Privy app id the sign relay authenticates under");
    }
    if (!this.secretStore) {
      throw new Error("signLinkedTransaction() requires a secretStore: pass one in CandleClientOptions (new CandleClient({ secretStore }))");
    }
    if (params.chain === "solana" && !params.unsignedTransactionBase64) {
      throw new Error('signLinkedTransaction() for chain "solana" requires unsignedTransactionBase64');
    }
    if (params.chain === "evm" && !params.evmTxParams) {
      throw new Error('signLinkedTransaction() for chain "evm" requires evmTxParams');
    }
    const privateKeyPem = await this.secretStore.get(params.linkedWalletId);
    if (!privateKeyPem) {
      throw new Error(`signLinkedTransaction(): no signer key stored for linked wallet "${params.linkedWalletId}" -- import or set one in the configured secretStore first`);
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
        throw new Error('broadcastSignedTransaction() for chain "solana" requires solanaRpcUrl: pass one in CandleClientOptions (new CandleClient({ solanaRpcUrl }))');
      }
      return this.jsonRpcCall(this.solanaRpcUrl, "sendTransaction", [signedTransaction, { encoding }]);
    }
    if (!this.evmRpcUrl) {
      throw new Error('broadcastSignedTransaction() for chain "evm" requires evmRpcUrl: pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))');
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
    const flow = req.from === "main" ? "server-executed" : "caller-broadcast";
    return this.runOperation({ clientTradeId }, flow, async (op) => {
      const result = await this.tradeSteps(req, buildReq, op);
      return typeof result.clientTradeId === "string" ? result : { ...result, clientTradeId };
    });
  }
  async tradeSteps(req, buildReq, op) {
    if (req.from === "main") {
      const result = await this.postTradeBuild(buildReq, op);
      if (result.status !== "executed") {
        throw new Error(`trade({ from: "main" }) expected an executed result but got status "${result.status}"`);
      }
      return result;
    }
    const { linkedWalletId, privyWalletId } = req.from;
    const built = await this.postTradeBuild(buildReq, op);
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
      throw new Error('trade({ from: <linked> }) on chain "hood" requires evmRpcUrl, because hood is an EVM chain: pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))');
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
    const landedLegs = [];
    let tradeTxHash;
    let feeTxHash;
    for (let i = 0;i < legs.length; i++) {
      const leg = legs[i];
      if (!leg)
        continue;
      let txHash;
      try {
        txHash = await this.signBroadcastAndWaitEvmLeg({
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
        }, { surfaceLegOutcome: true });
      } catch (err) {
        if (leg.kind === "feeTransfer" && tradeTxHash) {
          throw tradeLandedFeeLegError({ clientTradeId: built.clientTradeId, tradeTxHash, err });
        }
        if (err instanceof EvmLegOutcome && err.txHash !== undefined || landedLegs.length > 0) {
          throw new TradeLegOutcomeError({
            clientTradeId: built.clientTradeId,
            leg: leg.kind,
            outcome: err instanceof EvmLegOutcome ? err.kind : "not-broadcast",
            txHash: err instanceof EvmLegOutcome ? err.txHash : undefined,
            landedLegs: [...landedLegs],
            cause: err instanceof EvmLegOutcome ? err.cause : err
          });
        }
        throw err instanceof EvmLegOutcome ? err.cause : err;
      }
      landedLegs.push({ leg: leg.kind, txHash });
      if (leg.kind === "trade")
        tradeTxHash = txHash;
      if (leg.kind === "feeTransfer")
        feeTxHash = txHash;
    }
    if (!tradeTxHash) {
      throw new Error("trade(): Hood leg sequence completed without a trade leg");
    }
    try {
      return await this.confirmTrade({
        clientTradeId: built.clientTradeId,
        tradeTxHash,
        ...feeTxHash ? { feeTxHash } : {}
      });
    } catch (cause) {
      throw new TradeLandedUnconfirmedError({ clientTradeId: built.clientTradeId, tradeTxHash, feeTxHash, cause });
    }
  }
  async selfLaunch(req) {
    const { privyWalletId, ...launchReq } = req;
    const clientLaunchId = launchReq.clientLaunchId ?? generateClientLaunchId();
    const body = { ...launchReq, clientLaunchId };
    const creatorBundle = (body.chain ?? "solana") === "solana" && Number(body.buyAmount ?? 0) > 0;
    return this.runOperation({ clientLaunchId }, creatorBundle ? "server-executed" : "caller-broadcast", (op) => this.selfLaunchSteps(body, privyWalletId, op));
  }
  async selfLaunchSteps(body, privyWalletId, op) {
    const built = await this.postSelfLaunchBuild(body, op);
    if ("bundleId" in built) {
      op.ids.bundleId = built.bundleId;
      const signedTxsBase64 = [];
      for (const leg of built.legs) {
        if (leg.signer !== "client" || !leg.unsignedTxBase64)
          throw new Error("selfLaunch(): invalid creator bundle leg");
        const signed = await this.signLinkedTransaction({
          linkedWalletId: body.linkedWalletId,
          privyWalletId,
          chain: "solana",
          unsignedTransactionBase64: leg.unsignedTxBase64
        });
        signedTxsBase64.push(signed.signedTransaction);
      }
      const outcome = await this.submitAtomicLaunch({ bundleId: built.bundleId, signedTxsBase64 });
      if (outcome.status === "landed" && outcome.launch)
        return { ...outcome.launch, clientLaunchId: built.clientLaunchId };
      throw new CandleApiError({
        status: 502,
        code: outcome.status === "timeout" ? "JITO_BUNDLE_TIMEOUT" : "JITO_BUNDLE_FAILED",
        message: "Creator bundle did not report a completed launch; recover this same clientLaunchId before starting another",
        retryable: false,
        stage: outcome.status === "failed" ? "reverted" : "unconfirmed",
        mint: built.mint
      });
    }
    if ((body.chain ?? "solana") === "solana" && Number(body.buyAmount ?? 0) > 0) {
      throw new Error("selfLaunch(): this API returned a single transaction for a Solana creator buy; bundle support is required before signing");
    }
    if (typeof built.transaction === "string") {
      let unsignedTransactionBase64 = built.transaction;
      let clientLaunchId2 = built.clientLaunchId;
      let signed;
      for (let attempt = 0;attempt <= MAX_BLOCKHASH_REBUILDS; attempt++) {
        if (signed?.forTransaction !== unsignedTransactionBase64) {
          const result = await this.signLinkedTransaction({
            linkedWalletId: body.linkedWalletId,
            privyWalletId,
            chain: "solana",
            unsignedTransactionBase64
          });
          signed = { forTransaction: unsignedTransactionBase64, ...result };
        }
        try {
          const signature = await this.broadcastSignedTransaction("solana", signed.signedTransaction, signed.encoding);
          return this.confirmSelfLaunch({ clientLaunchId: clientLaunchId2, signature });
        } catch (error) {
          if (!isBlockhashExpiry(error))
            throw error;
          if (attempt === MAX_BLOCKHASH_REBUILDS)
            throw withRpcLagHint(error);
          let rebuilt;
          try {
            rebuilt = await this.postSelfLaunchBuild(body, op);
          } catch (buildError) {
            const reason = buildError instanceof CandleApiError ? buildError.reason : undefined;
            if (reason === "prior_attempt_in_flight")
              continue;
            if (reason === "prior_attempt_on_chain") {
              const signature = solanaSignedTxSignature(signed.signedTransaction, signed.encoding);
              if (signature)
                return this.confirmSelfLaunch({ clientLaunchId: clientLaunchId2, signature });
            }
            throw buildError;
          }
          if (typeof rebuilt.transaction !== "string")
            throw error;
          unsignedTransactionBase64 = rebuilt.transaction;
          clientLaunchId2 = rebuilt.clientLaunchId;
        }
      }
      throw new Error("selfLaunch(): blockhash-rebuild loop exited without returning or throwing");
    }
    const hoodBuilt = built;
    if (!this.evmRpcUrl) {
      throw new Error('selfLaunch() on chain "hood" requires evmRpcUrl, because hood is an EVM chain: pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))');
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
    const clientLaunchId = built.clientLaunchId;
    let feeTxHash;
    if (hoodBuilt.feeTransfer) {
      try {
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
        }, { surfaceLegOutcome: true });
      } catch (err) {
        throw selfLaunchFeeLegError({ clientLaunchId, createCurveTxHash, err });
      }
    }
    try {
      return await this.confirmSelfLaunch({
        clientLaunchId,
        signature: createCurveTxHash,
        ...feeTxHash ? { feeTxHash } : {}
      });
    } catch (cause) {
      throw new SelfLaunchOutcomeError({
        clientLaunchId,
        createCurveTxHash,
        step: "confirm",
        ...feeTxHash ? { feeOutcome: "landed", feeTxHash } : { feeOutcome: "not-required" },
        cause
      });
    }
  }
  async buildAtomicLaunch(req) {
    this.requireKey("buildAtomicLaunch()");
    const clientLaunchId = req.clientLaunchId ?? generateClientLaunchId();
    const body = { ...req, clientLaunchId };
    return this.runOperation({ clientLaunchId }, "server-executed", (op) => this.postAtomicBuild(body, clientLaunchId, op));
  }
  async dryRunAtomicLaunch(req) {
    this.requireKey("dryRunAtomicLaunch()");
    return this.requestJson("POST", "/api/v1/launch/atomic/dry-run", req);
  }
  async postAtomicBuild(body, clientLaunchId, op) {
    const built = await this.requestJson("POST", "/api/v1/launch/atomic/build", body, op);
    return { ...built, clientLaunchId };
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
    this.requireKey("buildAtomicLaunch()");
    const { payer, firstBuys, ...launchFields } = req;
    const clientLaunchId = launchFields.clientLaunchId ?? generateClientLaunchId();
    const buildReq = {
      ...launchFields,
      clientLaunchId,
      payer: toAtomicWirePayer(payer),
      firstBuys: firstBuys.map((leg) => ({ payer: toAtomicWirePayer(leg.payer), amountRaw: leg.amountRaw }))
    };
    return this.runOperation({ clientLaunchId }, "server-executed", async (op) => {
      const outcome = await this.launchAtomicSteps(req, buildReq, clientLaunchId, op);
      return { ...outcome, clientLaunchId };
    });
  }
  async launchAtomicSteps(req, buildReq, clientLaunchId, op) {
    const { payer, firstBuys } = req;
    const built = await this.postAtomicBuild(buildReq, clientLaunchId, op);
    op.ids.bundleId = built.bundleId;
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
  async signBroadcastAndWaitEvmLeg(params, opts = {}) {
    try {
      return await this.broadcastAndWaitEvmLeg(params);
    } catch (err) {
      if (opts.surfaceLegOutcome || !(err instanceof EvmLegOutcome))
        throw err;
      throw err.cause;
    }
  }
  async broadcastAndWaitEvmLeg(params) {
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
    const predicted = evmSignedTxHash(signed.signedTransaction, signed.encoding);
    let txHash;
    try {
      txHash = await this.broadcastSignedTransaction("evm", signed.signedTransaction, signed.encoding);
    } catch (err) {
      if (!isDefiniteBroadcastRejection(err)) {
        throw new EvmLegOutcome({ kind: "unknown", txHash: predicted, cause: err });
      }
      throw new EvmLegOutcome({ kind: "not-broadcast", txHash: predicted, cause: err });
    }
    try {
      await waitForReceipt(params.rpc, txHash, evmReceiptWaitForTest ?? {});
    } catch (err) {
      if (isRevertedReceipt(err))
        throw new EvmLegOutcome({ kind: "reverted", txHash, cause: err });
      throw new EvmLegOutcome({ kind: "unknown", txHash, cause: err });
    }
    return txHash;
  }
  marketReader() {
    this.perpsMarketReader ??= new PerpsMarketReader({
      apiKey: this.apiKey,
      network: this.hyperliquidNetwork,
      fetcher: this.fetchImpl,
      readConfig: () => this.perpsConfig()
    });
    return this.perpsMarketReader;
  }
  async perpsMarkets(opts = {}) {
    return this.marketReader().markets(opts);
  }
  async perpsMarket(coin) {
    return this.marketReader().market(coin);
  }
  async perpsBook(coin, opts = {}) {
    return this.marketReader().book(coin, opts);
  }
  async perpsCandles(coin, opts = {}) {
    return this.marketReader().candles(coin, opts);
  }
  async perpsConfig() {
    this.requireKey("perpsConfig()");
    return this.requestJson("GET", "/api/v1/agent/perps/config");
  }
  async perpsSetup(params) {
    this.requireKey("perpsSetup()");
    const builder = this.perpsBuilder();
    const address = await this.perpsWalletAddress(params.walletId);
    const mode = await hyperliquidAccountMode(this.fetchImpl, this.hyperliquidNetwork, address);
    if (!HYPERLIQUID_STANDARD_ACCOUNT_MODES.includes(mode))
      throw new Error(`perps: PERPS_ACCOUNT_MODE: the account is in ${mode} mode on Hyperliquid; Candle trades only a standard account. Nothing was requested or signed.`);
    const res = await this.requestJson("POST", "/api/v1/agent/perps/setup", { walletId: params.walletId });
    const problem = perpsSetupStatusProblem(res, {
      network: this.hyperliquidNetwork,
      address,
      builder,
      mode
    });
    if (problem)
      throw new Error(`perps: refused this setup answer: ${problem}. Nothing was signed.`);
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
      ready: res.ready,
      preview: { builderTrust: this.perpsBuilderTrust() }
    };
    if (res.ready)
      return status;
    return { ...status, action: await this.perpsComplete(res, params, "setup") };
  }
  async perpsOpen(params) {
    this.requireKey("perpsOpen()");
    this.perpsBuilder();
    const { walletId, privyWalletId: _p, submit: _s, ...order } = params;
    const clientId = perpsClientId(params.clientId);
    const build = await this.requestJson("POST", "/api/v1/agent/perps/open", {
      walletId,
      ...order,
      ...clientId !== undefined ? { clientId } : {}
    });
    const replay = perpsReplayOf(build, walletId, clientId);
    if (replay)
      return replay;
    return this.perpsComplete(build, { ...params, ...clientId ? { clientId } : {} }, "open");
  }
  async perpsClose(params) {
    this.requireKey("perpsClose()");
    if (params.pct !== undefined && params.size !== undefined)
      throw new Error("perpsClose(): give a size or a pct, not both");
    this.perpsBuilder();
    const { walletId, privyWalletId: _p, submit: _s, ...close } = params;
    const clientId = perpsClientId(params.clientId);
    const build = await this.requestJson("POST", "/api/v1/agent/perps/close", {
      walletId,
      ...close,
      ...clientId !== undefined ? { clientId } : {}
    });
    const replay = perpsReplayOf(build, walletId, clientId);
    if (replay)
      return replay;
    return this.perpsComplete(build, { ...params, ...clientId ? { clientId } : {} }, "close");
  }
  async perpsCancel(params) {
    this.requireKey("perpsCancel()");
    this.perpsBuilder();
    const build = await this.requestJson("POST", "/api/v1/agent/perps/cancel", {
      walletId: params.walletId,
      cloid: params.cloid
    });
    return this.perpsComplete(build, params, "cancel");
  }
  async perpsModify(params) {
    this.requireKey("perpsModify()");
    this.perpsBuilder();
    const { walletId, privyWalletId: _p, submit: _s, ...modify } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/modify", { walletId, ...modify });
    return this.perpsComplete(build, params, "modify");
  }
  async perpsLeverage(params) {
    this.requireKey("perpsLeverage()");
    if (params.leverage === undefined && params.mode === undefined)
      throw new Error("perpsLeverage(): leverage is required unless mode names the margin mode");
    this.perpsBuilder();
    const { walletId, privyWalletId: _p, submit: _s, ...leverage } = params;
    const build = await this.requestJson("POST", "/api/v1/agent/perps/leverage", { walletId, ...leverage });
    const result = await this.perpsComplete(build, params, "leverage");
    if (params.mode === undefined || result.outcome?.status !== "confirmed")
      return result;
    let confirmedMode = null;
    try {
      const res = await this.fetchImpl(HYPERLIQUID_EXCHANGE_URLS[this.hyperliquidNetwork].replace("/exchange", "/info"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "activeAssetData",
          user: build.address,
          coin: String(build.preview.coin ?? params.coin)
        })
      });
      const type = JSON.parse(await res.text())?.leverage?.type;
      confirmedMode = type === "cross" || type === "isolated" ? type : null;
    } catch {
      confirmedMode = null;
    }
    return { ...result, requestedMode: params.mode, confirmedMode };
  }
  async perpsMargin(params) {
    this.requireKey("perpsMargin()");
    this.perpsBuilder();
    const build = await this.requestJson("POST", "/api/v1/agent/perps/margin", {
      walletId: params.walletId,
      coin: params.coin,
      amount: params.amount
    });
    return this.perpsComplete(build, params, "margin");
  }
  async perpsPositions(walletId) {
    this.requireKey("perpsPositions()");
    const server = await this.requestJson("GET", `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(walletId)}`);
    const { effective } = await this.perpsThresholdsOrDefaults();
    const identity2 = { walletId, address: server.address, network: this.hyperliquidNetwork };
    let report;
    try {
      report = await readPerpsRisk({
        ...identity2,
        fetcher: this.fetchImpl,
        thresholds: effective,
        now: Date.now
      });
    } catch {
      report = unknownRiskReport(identity2, effective, "PERPS_READ_FAILED", Date.now());
    }
    const { positions: rows, ...risk } = report;
    return { ...server, rows, accountLine: report.account, risk };
  }
  async perpsOrders(walletId, opts = {}) {
    this.requireKey("perpsOrders()");
    const params = new URLSearchParams({ walletId });
    if (opts.limit !== undefined)
      params.set("limit", String(opts.limit));
    return this.requestJson("GET", `/api/v1/agent/perps/orders?${params}`);
  }
  async perpsFillsPage(walletId, options = {}) {
    this.requireKey("perpsFillsPage()");
    return await this.perpsHistoryPage("fills", walletId, options);
  }
  async perpsFundingPage(walletId, options = {}) {
    this.requireKey("perpsFundingPage()");
    return await this.perpsHistoryPage("funding", walletId, options);
  }
  async perpsHistoryPage(kind, walletId, options) {
    const address = await this.perpsWalletAddress(walletId);
    return readPerpsHistoryPage({
      kind,
      network: this.hyperliquidNetwork,
      walletId,
      address,
      options,
      fetch: this.fetchImpl,
      now: Date.now
    });
  }
  async perpsWalletAddress(walletId) {
    let cursor = null;
    for (let page = 0;page < 10; page++) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const listed = await this.requestJson("GET", `/api/v1/agent/wallets/trading${query}`);
      const row = (listed.page ?? []).find((r) => r.id === walletId);
      if (row) {
        if (row.chain !== "evm" || !/^0x[0-9a-fA-F]{40}$/.test(row.address))
          throw new Error(`perps: wallet ${walletId} is not an EVM TEE wallet`);
        return row.address.toLowerCase();
      }
      if (listed.isDone !== false || !listed.continueCursor)
        break;
      cursor = listed.continueCursor;
    }
    throw new Error(`perps: wallet ${walletId} is not an EVM TEE wallet bound to this key`);
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
  async getPerpsRisk() {
    this.requireKey("getPerpsRisk()");
    const { thresholds, stored } = perpsRiskFromLimits(await this.requestJson("GET", "/api/v1/agent/keys/self/limits"));
    return { perpsRisk: stored, effective: thresholds };
  }
  async setPerpsRisk(fields) {
    this.requireKey("setPerpsRisk()");
    return this.requestJson("PUT", "/api/v1/agent/keys/self/perps-risk", { perpsRisk: fields });
  }
  async setKeyPerpsRisk(keyPrefix, fields, owner) {
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/perps-risk`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.bearerToken}` },
      body: JSON.stringify({ perpsRisk: fields })
    });
    return this.parseResponse(res);
  }
  async perpsRisk(params) {
    this.requireKey("perpsRisk()");
    const address = params.address ?? await this.perpsWalletAddress(params.walletId);
    const { effective } = await this.perpsThresholdsOrDefaults();
    return readPerpsRisk({
      fetcher: this.fetchImpl,
      network: this.hyperliquidNetwork,
      walletId: params.walletId,
      address,
      thresholds: effective,
      now: Date.now
    });
  }
  async perpsAccount(params) {
    this.requireKey("perpsAccount()");
    const now = Date.now();
    const startTime = params.since ?? now - 86400000;
    if (!Number.isSafeInteger(startTime) || startTime >= now || now - startTime > PERPS_RECENT_MAX_MS)
      throw new Error("perpsAccount(): since must be an epoch-ms time within the last 30 days");
    const address = params.address ?? await this.perpsWalletAddress(params.walletId);
    const { effective } = await this.perpsThresholdsOrDefaults();
    const fetcher = this.fetchImpl;
    const [report, recent] = await Promise.all([
      readPerpsRisk({
        fetcher,
        network: this.hyperliquidNetwork,
        walletId: params.walletId,
        address,
        thresholds: effective,
        now: Date.now
      }),
      readPerpsRecent(fetcher, this.hyperliquidNetwork, address, { startTime, endTime: now })
    ]);
    return perpsAccountReport(report, recent);
  }
  async watchPerpsRisk(params) {
    this.requireKey("watchPerpsRisk()");
    const address = params.address ?? await this.perpsWalletAddress(params.walletId);
    return watchPerpsRisk({
      fetcher: this.fetchImpl,
      network: this.hyperliquidNetwork,
      walletId: params.walletId,
      address,
      thresholds: async () => (await this.getPerpsRisk()).effective,
      ...params.intervalMs !== undefined ? { intervalMs: params.intervalMs } : {},
      ...params.heartbeatMs !== undefined ? { heartbeatMs: params.heartbeatMs } : {},
      ...params.signal ? { signal: params.signal } : {},
      ...params.onceLevelChange ? { onceLevelChange: true } : {},
      now: Date.now,
      sleep: (ms) => new Promise((resolve2) => setTimeout(resolve2, ms)),
      onEvent: params.onEvent
    });
  }
  async perpsPortfolioSection(wallets) {
    return perpsPortfolioSection(this.fetchImpl, this.hyperliquidNetwork, wallets);
  }
  perpsStream(params) {
    this.requireKey("perpsStream()");
    const apiKey = this.apiKey;
    if (!apiKey)
      throw new Error("perpsStream(): an apiKey is required");
    const url = `${this.apiUrl.replace(/^http/, "ws")}/api/v1/agent/perps/stream?walletId=${encodeURIComponent(params.walletId)}`;
    let socket = null;
    let clientClosed = false;
    let finished = false;
    const finish = (code, reason) => {
      if (finished)
        return;
      finished = true;
      params.onClose?.({ code, reason });
    };
    openPerpsStreamSocket(url, { headers: { "x-api-key": apiKey } }, this.perpsStreamWebSocket).then((opened) => {
      socket = opened;
      opened.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (frame && typeof frame === "object")
          params.onMessage(frame);
      };
      opened.onclose = (event) => finish(Number(event.code) || 1006, String(event.reason ?? ""));
      opened.onerror = () => {};
      if (clientClosed)
        opened.close(1000, "client closed");
    }).catch((error) => {
      if (!clientClosed)
        finish(1006, error instanceof Error ? error.message : String(error));
    });
    const closeWith = (reason) => {
      if (clientClosed && !socket)
        return;
      clientClosed = true;
      if (socket && (socket.readyState === 0 || socket.readyState === 1))
        socket.close(1000, reason);
    };
    params.signal?.addEventListener("abort", () => closeWith("aborted"), { once: true });
    return {
      close() {
        closeWith("client closed");
      }
    };
  }
  async perpsThresholdsOrDefaults() {
    try {
      return await this.getPerpsRisk();
    } catch {
      const { thresholds, stored } = perpsRiskFromLimits(null);
      return { perpsRisk: stored, effective: thresholds };
    }
  }
  async perpsDeposit(params) {
    this.requireKey("perpsDeposit()");
    const build = await this.requestJson("POST", "/api/v1/agent/perps/deposit", {
      clientDepositId: params.clientDepositId,
      walletId: params.walletId,
      asset: params.asset,
      amountRaw: params.amountRaw,
      ...params.perpsWalletId !== undefined ? { perpsWalletId: params.perpsWalletId } : {},
      ...params.maxSlippageBps !== undefined ? { maxSlippageBps: params.maxSlippageBps } : {},
      ...params.submit === false ? { preview: true } : {}
    });
    if (build.job !== undefined)
      throw new Error(`perpsDeposit(): ${params.clientDepositId} already names a deposit; read it with perpsDepositStatus()`);
    const problem = perpsDepositProblem(build, params);
    if (problem)
      throw new Error(`perps: refused to sign this deposit: ${problem}`);
    if (params.submit === false)
      return { build, submitted: false, result: null };
    if (build.preview === true || build.depositId === undefined)
      throw new Error("perps: refused to sign this deposit: the API answered a preview, not a build");
    const submitPath = "/api/v1/agent/perps/deposit/submit";
    const ids = { clientDepositId: params.clientDepositId, depositId: build.depositId };
    if (build.chain === "solana") {
      const signed = await this.signLinkedTransaction({
        chain: "solana",
        linkedWalletId: params.walletId,
        privyWalletId: params.privyWalletId,
        unsignedTransactionBase64: build.transactionsBase64[0]
      });
      const result = await this.requestJson("POST", submitPath, {
        ...ids,
        signedTransactionsBase64: [signed.signedTransaction]
      });
      return { build, submitted: true, result };
    }
    const allowed = params.asset === "USDG" ? ["approval", "bridgeDeposit"] : ["bridgeDeposit"];
    const planned = build.plannedLegCount ?? 0;
    const hex = (value) => `0x${BigInt(value).toString(16)}`;
    let body = build;
    const signedKinds = new Set;
    while (body.mode === "sequenced") {
      const leg = body.nextLeg;
      const kind = String(body.legKind);
      if (!leg || body.operationId !== build.operationId || body.plannedLegCount !== planned || planned > allowed.length || !allowed.includes(kind) || signedKinds.has(kind) || leg.chainId !== 4663) {
        throw new Error(`perps: refused to sign deposit leg ${kind}: it is not the plan this deposit was built with`);
      }
      signedKinds.add(kind);
      const signed = await this.signLinkedTransaction({
        chain: "evm",
        linkedWalletId: params.walletId,
        privyWalletId: params.privyWalletId,
        evmTxParams: {
          chain_id: leg.chainId,
          data: leg.data,
          from: build.walletAddress,
          gas_limit: hex(leg.gas),
          max_fee_per_gas: hex(leg.maxFeePerGas),
          max_priority_fee_per_gas: hex(leg.maxPriorityFeePerGas),
          nonce: leg.nonce,
          to: leg.to,
          type: 2,
          value: hex(leg.value)
        }
      });
      body = await this.requestJson("POST", submitPath, {
        ...ids,
        operationId: build.operationId,
        signedTransaction: signed.signedTransaction
      });
    }
    return { build, submitted: true, result: body };
  }
  async perpsDepositStatus(clientDepositId) {
    this.requireKey("perpsDepositStatus()");
    return this.requestJson("GET", `/api/v1/agent/perps/deposit/${encodeURIComponent(clientDepositId)}`);
  }
  perpsBuilder() {
    return resolveHyperliquidBuilder(this.hyperliquidBuilder);
  }
  perpsBuilderTrust() {
    return {
      address: this.perpsBuilder(),
      source: this.hyperliquidBuilder === undefined ? "release" : "override"
    };
  }
  async perpsComplete(build, ref, method) {
    build = { ...build, preview: { ...build.preview, builderTrust: this.perpsBuilderTrust() } };
    const params = ref;
    const opts = {
      builder: this.perpsBuilder(),
      network: this.hyperliquidNetwork,
      intent: { method, params },
      keyReduceOnly: build.perpsReduceOnly === true
    };
    const check = method === "setup" ? verifyPerpsBuild(build, opts) : await verifyPerpsBuildAgainstVenue(build, {
      ...opts,
      address: build.address,
      fetcher: this.fetchImpl,
      now: Date.now
    });
    if (!check.ok)
      throw new Error(`perps: refused to sign this build: ${check.reason}`);
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
      const exchange = JSON.parse(text);
      return { build, signature, submitted: true, exchange, outcome: hyperliquidExchangeOutcome(exchange) };
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
  async perpsScheduleCancel(params) {
    this.requireKey("perpsScheduleCancel()");
    const clear = params.clear === true;
    if (clear === (params.seconds !== undefined))
      throw new Error("perpsScheduleCancel(): give seconds, or clear: true");
    const build = await this.requestJson("POST", "/api/v1/agent/perps/schedule-cancel", {
      walletId: params.walletId,
      ...clear ? { clear: true } : { seconds: params.seconds }
    });
    const result = await this.perpsComplete(build, params, "scheduleCancel");
    if (result.outcome?.status === "rejected")
      return { ...result, submitError: `PERPS_SCHEDULE_CANCEL_REJECTED: ${result.outcome.error}` };
    if (result.outcome?.status !== "confirmed")
      return result;
    let acknowledged = false;
    try {
      const ack = await this.requestJson("POST", "/api/v1/agent/perps/schedule-cancel/ack", {
        walletId: params.walletId,
        perpOrderId: build.perpOrderId,
        exchange: result.exchange
      });
      acknowledged = ack.acknowledged === true;
    } catch {
      acknowledged = false;
    }
    return { ...result, acknowledged };
  }
  async perpsTpsl(params) {
    this.requireKey("perpsTpsl()");
    const { walletId, privyWalletId: _p, submit: _s, ...tpsl } = params;
    return runPerpsTpsl(await this.perpsWorkflowIo(params), tpsl);
  }
  async perpsFlatten(params) {
    this.requireKey("perpsFlatten()");
    return runPerpsFlatten(await this.perpsWorkflowIo(params));
  }
  async perpsWorkflowIo(ref) {
    const address = await this.perpsWalletAddress(ref.walletId);
    const builder = this.perpsBuilder();
    const reduceOnly = await this.getPerpsReduceOnly().catch(() => null);
    return {
      network: this.hyperliquidNetwork,
      walletId: ref.walletId,
      address,
      builder,
      keyReduceOnly: reduceOnly === null ? true : reduceOnly.perpsReduceOnly,
      fetcher: this.fetchImpl,
      now: Date.now,
      build: (path, body) => this.requestJson("POST", path, body),
      read: (path) => this.requestJson("GET", path),
      sign: (typedData) => this.signLinkedTypedData({ linkedWalletId: ref.walletId, privyWalletId: ref.privyWalletId, typedData }),
      mode: ref.submit === false ? "no-submit" : "submit",
      cloid: () => {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      }
    };
  }
  async getPerpsReduceOnly() {
    this.requireKey("getPerpsReduceOnly()");
    return this.requestJson("GET", "/api/v1/agent/keys/self/perps-reduce-only");
  }
  async setPerpsReduceOnly(perpsReduceOnly) {
    this.requireKey("setPerpsReduceOnly()");
    return this.requestJson("PUT", "/api/v1/agent/keys/self/perps-reduce-only", {
      perpsReduceOnly
    });
  }
  async setKeyPerpsReduceOnly(keyPrefix, perpsReduceOnly, owner) {
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/perps-reduce-only`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.bearerToken}` },
      body: JSON.stringify({ perpsReduceOnly })
    });
    return this.parseResponse(res);
  }
  async perpsWithdraw(params) {
    this.requireKey("perpsWithdraw()");
    if (this.hyperliquidNetwork !== "mainnet")
      throw new Error("perpsWithdraw: withdrawals are mainnet only");
    if (this.perpsWithdrawPins === null) {
      throw new Error("perpsWithdraw: no withdrawal pins are set; nothing was built");
    }
    const amountMicros = parseWithdrawAmount(params.amountUsdc);
    if (amountMicros === null)
      throw new Error("perpsWithdraw: amountUsdc must be a positive decimal, at most 6 dp");
    const id = params.clientWithdrawalId ?? `withdraw-${crypto.randomUUID()}`;
    const build = await this.perps.withdraw.build({
      clientWithdrawalId: id,
      amountUsdc: params.amountUsdc,
      to: params.to,
      wallet: params.walletId
    });
    if (build.status !== "quoted") {
      throw new Error(`perpsWithdraw: withdrawal ${id} is already ${build.status}; read it with perps.withdraw.get()`);
    }
    const mapping = verifyWithdrawMapping(build, {
      id,
      account: params.account,
      to: params.to,
      amountMicros,
      ownDestinations: params.ownDestinations,
      pins: this.perpsWithdrawPins
    });
    if (!mapping.ok)
      throw new Error(`perpsWithdraw: refused to sign this withdrawal: ${mapping.reason}`);
    const mappingSignature = await this.signLinkedTypedData({
      linkedWalletId: params.walletId,
      privyWalletId: params.privyWalletId,
      typedData: build.typedData
    });
    const authorization = await this.perps.withdraw.authorize({ clientWithdrawalId: id, signature: mappingSignature });
    const send = verifyWithdrawSendAsset(authorization, {
      mappingNonce: build.nonce,
      amountMicros,
      pins: this.perpsWithdrawPins
    });
    if (!send.ok)
      throw new Error(`perpsWithdraw: refused to sign the transfer: ${send.reason}`);
    const signature = await this.signLinkedTypedData({
      linkedWalletId: params.walletId,
      privyWalletId: params.privyWalletId,
      typedData: authorization.typedData
    });
    let exchange = null;
    let submitError;
    try {
      const res = await this.fetchImpl(HYPERLIQUID_EXCHANGE_URLS.mainnet, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hyperliquidExchangeBody(authorization.action, authorization.nonce, signature))
      });
      const text = await res.text();
      if (res.ok)
        exchange = JSON.parse(text);
      else
        submitError = `HTTP ${res.status}: ${text}`;
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
    }
    if (exchange !== null) {
      await this.perps.withdraw.reportSubmitted({ clientWithdrawalId: id, exchangeResponse: exchange }).catch(() => {});
    }
    return {
      build,
      authorization,
      signature,
      submitted: exchange !== null,
      exchange,
      ...submitError !== undefined ? { submitError } : {}
    };
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
  async runOperation(ids, flow, steps) {
    const op = { sent: false, ids: { ...ids } };
    try {
      return await steps(op);
    } catch (error) {
      if (!op.sent)
        throw error;
      throw withOperationIds(error, op.ids, flow);
    }
  }
  async requestJson(method, path, body, op) {
    const init = {
      method,
      headers: this.headers({ json: body !== undefined }),
      ...body !== undefined ? { body: JSON.stringify(body) } : {}
    };
    if (op)
      op.sent = true;
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, init);
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

class EvmLegOutcome extends Error {
  kind;
  txHash;
  cause;
  constructor(args) {
    super(args.cause instanceof Error ? args.cause.message : String(args.cause), { cause: args.cause });
    this.name = "EvmLegOutcome";
    this.kind = args.kind;
    this.txHash = args.txHash;
    this.cause = args.cause;
  }
}
var evmReceiptWaitForTest = null;
function tradeLandedFeeLegError(args) {
  if (args.err instanceof EvmLegOutcome) {
    return new TradeLandedFeeLegError({
      clientTradeId: args.clientTradeId,
      tradeTxHash: args.tradeTxHash,
      cause: args.err.cause,
      feeOutcome: args.err.kind,
      ...args.err.kind !== "not-broadcast" && args.err.txHash !== undefined ? { feeTxHash: args.err.txHash } : {}
    });
  }
  return new TradeLandedFeeLegError({
    clientTradeId: args.clientTradeId,
    tradeTxHash: args.tradeTxHash,
    cause: args.err,
    feeOutcome: "not-broadcast"
  });
}
function selfLaunchFeeLegError(args) {
  const outcome = args.err instanceof EvmLegOutcome ? args.err : undefined;
  return new SelfLaunchOutcomeError({
    clientLaunchId: args.clientLaunchId,
    createCurveTxHash: args.createCurveTxHash,
    step: "feeTransfer",
    feeOutcome: outcome?.kind ?? "not-broadcast",
    ...outcome?.txHash !== undefined ? { feeTxHash: outcome.txHash } : {},
    cause: outcome ? outcome.cause : args.err
  });
}
function solanaSignedTxSignature(signedTransaction, encoding) {
  const enc = encoding.toLowerCase();
  let bytes;
  try {
    if (enc === "base64")
      bytes = fromBase64(signedTransaction);
    else if (enc === "base58")
      bytes = base582.decode(signedTransaction);
    else
      return;
  } catch {
    return;
  }
  const count = bytes[0];
  if (count === undefined || count === 0 || count >= 128 || bytes.length < 1 + count * 64)
    return;
  const first = bytes.subarray(1, 65);
  if (first.every((byte) => byte === 0))
    return;
  return base582.encode(first);
}
function evmSignedTxHash(signedTransaction, encoding) {
  const enc = encoding.toLowerCase();
  let bytes;
  if (enc === "base64") {
    bytes = fromBase64(signedTransaction);
  } else if (enc === "hex" || enc === "rlp" || signedTransaction.startsWith("0x")) {
    const hex2 = signedTransaction.startsWith("0x") ? signedTransaction.slice(2) : signedTransaction;
    if (!/^[0-9a-fA-F]+$/.test(hex2) || hex2.length % 2 !== 0)
      return;
    bytes = new Uint8Array(hex2.length / 2);
    for (let i = 0;i < bytes.length; i++)
      bytes[i] = Number.parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  }
  if (!bytes || bytes.length === 0)
    return;
  let hex = "";
  for (const b of keccak_2562(bytes))
    hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}
function isDefiniteBroadcastRejection(err) {
  if (!(err instanceof JsonRpcError))
    return false;
  const rpcMessage = err.message.match(/\(code -?\d+\): (.*)$/)?.[1]?.toLowerCase();
  return rpcMessage === "insufficient funds for gas * price + value" || rpcMessage === "intrinsic gas too low" || rpcMessage === "invalid sender";
}
function isRevertedReceipt(err) {
  return err instanceof Error && err.message.includes("transaction reverted (receipt status 0x0)");
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
var SDK_VERSION = "0.6.10";
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
  quant: "Quant deep analyses (Max)"
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
  const { headers, rows } = planTableRows(table);
  const line = (cells) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join(`
`);
}
// src/quant.ts
var QUANT_AGENT_PATH = "/api/v1/agent/quant";
var QUANT_CALL_TIMEOUT_MS = 5000;
var QUANT_POLL_TIMEOUT_MS = 35000;
var QUANT_DEFAULT_MAX_TEXT_CHARS = 4000;
function quantCodePoints(text) {
  let n = 0;
  for (const _ of text)
    n++;
  return n;
}
function newClientTurnId() {
  return crypto.randomUUID();
}
function quantRefusalCode(body) {
  const record = asRecord(body);
  if (typeof record?.code === "string")
    return record.code;
  const inner = asRecord(record?.error);
  return typeof inner?.code === "string" ? inner.code : undefined;
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function refusalOf(status, body) {
  const record = asRecord(body) ?? {};
  const relayCode = typeof record.code === "string" ? record.code : undefined;
  const code = quantRefusalCode(body) ?? `HTTP_${status}`;
  const refusal = { code, status, shape: relayCode !== undefined ? "relay" : "envelope" };
  if (typeof record.retryable === "boolean")
    refusal.retryable = record.retryable;
  if (typeof record.resetsAt === "string" || typeof record.resetsAt === "number")
    refusal.resetsAt = record.resetsAt;
  if (typeof record.turnId === "string")
    refusal.turnId = record.turnId;
  if (typeof record.limit === "number")
    refusal.limit = record.limit;
  return refusal;
}
function parseStatus(body) {
  const b = asRecord(body);
  if (typeof b?.enabled !== "boolean")
    return;
  const status = { enabled: b.enabled };
  if (typeof b.allowed === "boolean")
    status.allowed = b.allowed;
  if (typeof b.tier === "string" || b.tier === null)
    status.tier = b.tier;
  if (typeof b.marketAccess === "boolean")
    status.marketAccess = b.marketAccess;
  if (typeof b.linked === "boolean")
    status.linked = b.linked;
  if (typeof b.remaining === "number" || b.remaining === null)
    status.remaining = b.remaining;
  if (typeof b.maxTextChars === "number" || b.maxTextChars === null)
    status.maxTextChars = b.maxTextChars;
  if (typeof b.activeTurnId === "string" || b.activeTurnId === null)
    status.activeTurnId = b.activeTurnId;
  return status;
}
function parseTurn(body) {
  const b = asRecord(body);
  if (typeof b?.turnId !== "string" || b.turnId.length === 0)
    return;
  return { turnId: b.turnId, ...typeof b.cursor === "number" ? { cursor: b.cursor } : {} };
}
function parseEvents(body) {
  const b = asRecord(body);
  if (!b || !Array.isArray(b.events) || typeof b.next !== "number" || typeof b.status !== "string")
    return;
  const events = [];
  for (const raw of b.events) {
    const e = asRecord(raw);
    if (typeof e?.seq !== "number" || typeof e.kind !== "string")
      continue;
    events.push({
      seq: e.seq,
      kind: e.kind,
      data: asRecord(e.data) ?? {},
      ...typeof e.createdAt === "string" ? { createdAt: e.createdAt } : {}
    });
  }
  return { events, next: b.next, status: b.status };
}
function parseHistory(body) {
  const b = asRecord(body);
  if (!b || !Array.isArray(b.items))
    return;
  const items = [];
  for (const raw of b.items) {
    const item = asRecord(raw);
    if (typeof item?.id !== "string" || typeof item.text !== "string")
      continue;
    if (item.role !== "user" && item.role !== "assistant")
      continue;
    items.push({
      id: item.id,
      role: item.role,
      text: item.text,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : ""
    });
  }
  return { items, next: typeof b.next === "string" ? b.next : null };
}
function createQuantKeyClient(options) {
  const base = new URL(options.apiUrl);
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    throw new Error("Quant needs an https API URL: the key would otherwise travel in clear.");
  }
  const root = base.toString().replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const callMs = options.callTimeoutMs ?? QUANT_CALL_TIMEOUT_MS;
  const pollMs = options.pollTimeoutMs ?? QUANT_POLL_TIMEOUT_MS;
  async function call(method, path, parse, opts) {
    const controller = new AbortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await doFetch(`${root}${QUANT_AGENT_PATH}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          "x-api-key": options.apiKey,
          accept: "application/json",
          ...opts.body !== undefined ? { "content-type": "application/json" } : {}
        },
        ...opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok)
        return { ok: false, refusal: refusalOf(response.status, body) };
      const parsed = parse(body);
      if (parsed === undefined) {
        return { ok: false, refusal: { code: "BAD_RESPONSE", status: response.status, shape: "transport" } };
      }
      return { ok: true, status: response.status, body: parsed };
    } catch {
      return {
        ok: false,
        refusal: { code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", status: 0, shape: "transport", retryable: true }
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  const turnPath = (turnId) => `/turns/${encodeURIComponent(turnId)}`;
  return {
    status: () => call("GET", "/status", parseStatus, { timeoutMs: callMs }),
    sendTurn: (input) => call("POST", "/turns", parseTurn, {
      body: { text: input.text, clientTurnId: input.clientTurnId },
      timeoutMs: callMs
    }),
    events: (turnId, after, opts) => call("GET", `${turnPath(turnId)}/events?after=${Math.max(0, Math.floor(after))}`, parseEvents, {
      timeoutMs: pollMs,
      ...opts?.signal ? { signal: opts.signal } : {}
    }),
    cancel: (turnId) => call("POST", `${turnPath(turnId)}/cancel`, (body) => asRecord(body) ?? {}, { timeoutMs: callMs }),
    history: (input = {}) => {
      const query = new URLSearchParams;
      if (input.before !== undefined)
        query.set("before", input.before);
      if (input.limit !== undefined)
        query.set("limit", String(input.limit));
      const encoded = query.toString();
      const suffix = encoded ? `?${encoded}` : "";
      return call("GET", `/history${suffix}`, parseHistory, { timeoutMs: callMs });
    }
  };
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
      await new Promise((resolve2) => setTimeout(resolve2, RETRY_MS));
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
  watchPerpsRisk,
  verifyWithdrawSendAsset,
  verifyWithdrawMapping,
  verifyWebhookSignature,
  verifyPerpsBuildAgainstVenue,
  verifyPerpsBuild,
  readPerpsRisk,
  readPerpsHistoryPage,
  readHyperliquidMarkets,
  quantRefusalCode,
  quantCodePoints,
  planTableRows,
  planTableMarkdown,
  planPromotionLine,
  planLabel,
  perpsSetupStatusProblem,
  perpsRiskStep,
  perpsRiskExitCode,
  perpsPortfolioSection,
  perpsMarketGate,
  perpsFundingWindow,
  perpsDepositProblem,
  perpsCandleWindow,
  parseWithdrawAmount,
  parseSendAssetAmount,
  parsePerpsFundingHistory,
  operationIds,
  newClientTurnId,
  isSolanaRpcErrorData,
  hyperliquidWalletSnapshot,
  hyperliquidRiskReport,
  hyperliquidOrderMarket,
  hyperliquidExchangeOutcome,
  hyperliquidActionHash,
  hyperliquidAccountMode,
  generateSignerKeypair,
  formatPlanBps,
  encryptWalletKeyForImport,
  effectivePerpsRisk,
  createQuantKeyClient,
  TradeLegOutcomeError,
  TradeLandedUnconfirmedError,
  TradeLandedFeeLegError,
  TokenPageError,
  SelfLaunchOutcomeError,
  QUANT_POLL_TIMEOUT_MS,
  QUANT_DEFAULT_MAX_TEXT_CHARS,
  QUANT_CALL_TIMEOUT_MS,
  QUANT_AGENT_PATH,
  PerpsWorkflowError,
  PerpsMarketReader,
  PerpsMarketError,
  PerpsHistoryError,
  PLAN_CAPABILITY_NOTE,
  PLAN_CAPABILITY_LABELS,
  PERPS_HISTORY_MAX_LIMIT,
  PERPS_HISTORY_DEFAULT_LIMIT,
  PERPS_FUNDING_HISTORY_MAX_ROWS,
  PERPS_FUNDING_HISTORY_MAX_MS,
  PERPS_FLATTEN_MAX_STEPS,
  PERPS_CANDLE_INTERVALS,
  KeychainSecretStore,
  JsonRpcError,
  InMemorySecretStore,
  HyperliquidReadError,
  HYPERLIQUID_STANDARD_ACCOUNT_MODES,
  HYPERLIQUID_RISK_DEFAULTS,
  HYPERLIQUID_EXCHANGE_URLS,
  HYPERLIQUID_ALLOWED_ACTION_TYPES,
  EncryptedFileSecretStore,
  CrossOriginRedirectError,
  CandleOperationError,
  CandleClient,
  CandleApiError,
  CANDLE_PERPS_WITHDRAW_PINS,
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  BRIDGE_ERROR_CODES
};
