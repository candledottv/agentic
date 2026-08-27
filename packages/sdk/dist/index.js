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
class CandleApiError extends Error {
  code;
  status;
  retryable;
  field;
  constructor(args) {
    super(args.message);
    this.name = "CandleApiError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable;
    if (args.field !== undefined)
      this.field = args.field;
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
    try {
      return base58.decode(trimmed);
    } catch {
      throw new Error("Invalid Solana private key: expected a base58 string or an id.json byte array.");
    }
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
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('Invalid EVM private key: expected a hex string (optionally "0x"-prefixed)');
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

class CandleClient {
  apiUrl;
  apiKey;
  fetchImpl;
  maxRetries;
  privyAppId;
  secretStore;
  solanaRpcUrl;
  evmRpcUrl;
  constructor(opts) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    if (opts.apiKey !== undefined)
      this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (opts.privyAppId !== undefined)
      this.privyAppId = opts.privyAppId;
    if (opts.secretStore !== undefined)
      this.secretStore = opts.secretStore;
    if (opts.solanaRpcUrl !== undefined)
      this.solanaRpcUrl = opts.solanaRpcUrl;
    if (opts.evmRpcUrl !== undefined)
      this.evmRpcUrl = opts.evmRpcUrl;
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
  async getSpendLimits() {
    this.requireKey("getSpendLimits()");
    return this.requestJson("GET", "/api/v1/agent/keys/self/limits");
  }
  async swap(req) {
    this.requireKey("swap()");
    const body = await this.requestJson("POST", "/api/v1/agent/swap", req);
    return body.payload;
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
      ...req.toWalletId !== undefined ? { toWalletId: req.toWalletId } : {}
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
    const submit = await this.requestJson("POST", "/api/v1/agent/swap/submit", { swapId: build.payload.swapId, signedTransactionsBase64: signed });
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
  }
  async delete(walletRef) {
    const contents = await this.readFile();
    if (!(walletRef in contents))
      return;
    delete contents[walletRef];
    await this.writeFile(contents);
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
    const tmpPath = `${this.path}.tmp`;
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
  isSolanaRpcErrorData,
  generateSignerKeypair,
  encryptWalletKeyForImport,
  KeychainSecretStore,
  JsonRpcError,
  InMemorySecretStore,
  EncryptedFileSecretStore,
  CandleClient,
  CandleApiError
};
