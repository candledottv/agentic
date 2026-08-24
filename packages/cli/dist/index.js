#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { spawn as spawn2 } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

// src/client.ts
var DEFAULT_API_URL = "https://api.alpha.candle.tv";
function trimTrailingSlashes(url) {
  return url.trim().replace(/\/+$/, "");
}
function resolveApiUrl(configuredApiUrl, env = process.env) {
  const fromEnv = env.CANDLE_API_URL?.trim();
  const resolved = fromEnv || configuredApiUrl?.trim() || DEFAULT_API_URL;
  return trimTrailingSlashes(resolved);
}
function buildHeaders(opts) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (opts.auth === "device" && opts.credentials.deviceToken) {
    headers.authorization = `Bearer ${opts.credentials.deviceToken}`;
  } else if (opts.auth === "key" && opts.credentials.apiKey) {
    headers["x-api-key"] = opts.credentials.apiKey;
  }
  return headers;
}
function buildUrl(apiUrl, path) {
  const base = trimTrailingSlashes(apiUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
function parseBody(text) {
  if (text.length === 0)
    return;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function classifyError(status, raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw;
    if (typeof obj.error === "string") {
      const description = typeof obj.error_description === "string" ? obj.error_description : obj.error;
      return { rfcError: obj.error, message: description };
    }
    if (obj.error && typeof obj.error === "object") {
      const errorObj = obj.error;
      const code = typeof errorObj.code === "string" ? errorObj.code : undefined;
      const message = typeof errorObj.message === "string" ? errorObj.message : `Request failed with status ${status}`;
      const uiHint = typeof errorObj.uiHint === "string" ? errorObj.uiHint : undefined;
      const docsPath = typeof errorObj.docsPath === "string" ? errorObj.docsPath : undefined;
      return { code, message, ...uiHint ? { uiHint } : {}, ...docsPath ? { docsPath } : {} };
    }
  }
  return { message: `Request failed with status ${status}` };
}
async function apiRequest(path, opts) {
  const url = buildUrl(opts.apiUrl, path);
  const headers = buildHeaders(opts);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const doFetch = opts.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(url, {
      method: opts.method ?? "GET",
      headers,
      body
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const env = opts.env ?? process.env;
    const envOverride = env.CANDLE_API_URL?.trim();
    return {
      ok: false,
      status: 0,
      message: `Could not reach ${url}: ${reason} (set CANDLE_API_URL to override; ${envOverride ? `currently "${envOverride}"` : "currently unset"})`,
      raw: undefined
    };
  }
  const text = await response.text();
  const raw = parseBody(text);
  if (response.ok) {
    return { ok: true, status: response.status, body: raw };
  }
  const classified = classifyError(response.status, raw);
  return { ok: false, status: response.status, raw, ...classified };
}

// src/commands/auth.ts
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/args.ts
function parseArgs(args, spec) {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const values = {};
  const booleans = new Set;
  const positionals = [];
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined)
      continue;
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        return { error: `${arg} requires a value` };
      values[arg] = value;
    } else if (booleanFlags.has(arg)) {
      booleans.add(arg);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  return { values, booleans, positionals };
}
function parseScopesList(raw) {
  return raw.split(",").map((scope) => scope.trim()).filter(Boolean);
}
function parseUsdToMicros(raw) {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (cleaned.length === 0)
    return { ok: false, message: "--tx-limit requires a dollar amount, for example 100." };
  const usd = Number(cleaned);
  if (!Number.isFinite(usd))
    return { ok: false, message: `--tx-limit is not a dollar amount: ${raw}` };
  const usdMicros = Math.round(usd * 1e6);
  if (usdMicros <= 0)
    return { ok: false, message: "--tx-limit must be greater than $0." };
  return { ok: true, usdMicros };
}
var TX_LIMIT_RESETS = ["daily", "weekly", "monthly", "never"];
function parseExpiresInDays(raw) {
  const days = Number(raw.trim());
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, message: `--expires-in must be a positive whole number of days, got: ${raw}` };
  }
  return { ok: true, days };
}

// src/render.ts
var ALL_AGENT_SCOPES = [
  "launch:write",
  "launch:read",
  "activity:write",
  "swap:write",
  "transfer:write"
];
var DEFAULT_AGENT_SCOPES = ALL_AGENT_SCOPES.filter((scope) => scope !== "swap:write" && scope !== "transfer:write");
var SWAP_WRITE_NOTE = "moves funds -- this key can execute swaps on your behalf";
var TRANSFER_WRITE_NOTE = "moves funds -- this key can transfer assets between your wallets";
function formatScopesForSummary(scopes) {
  return scopes.map((scope) => scope === "swap:write" ? `${scope} (${SWAP_WRITE_NOTE})` : scope === "transfer:write" ? `${scope} (${TRANSFER_WRITE_NOTE})` : scope).join(", ");
}
function renderTable(headers, rows) {
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)));
  const line = (cells) => cells.map((cell, col) => col === cells.length - 1 ? cell ?? "" : (cell ?? "").padEnd(widths[col] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join(`
`);
}
function formatTimestamp(ms, whenAbsent = "never") {
  return ms === undefined ? whenAbsent : new Date(ms).toISOString();
}
function renderError(result, ctx) {
  if (result.code === "DEVICE_TOKEN_INVALID") {
    return "This device was revoked or its token is stale. Run: candle auth login";
  }
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return `${result.message}. Mint one that has it with: candle keys create --scopes <a,b,c>, or check an existing key's scopes with: candle keys list`;
  }
  if (result.status === 401 && ctx.authType === "key") {
    return "API key invalid or revoked. Run: candle keys create";
  }
  if (result.status === 0) {
    return `Could not reach ${ctx.apiUrl}. Set CANDLE_API_URL to override the API endpoint.`;
  }
  return result.message;
}
function suggestionFor(result, ctx) {
  if (result.code === "DEVICE_TOKEN_INVALID")
    return "Run: candle auth login";
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return "Mint a key that has it: candle keys create --scopes <a,b,c>, or check an existing key's scopes: candle keys list";
  }
  if (result.status === 401 && ctx.authType === "key")
    return "Run: candle keys create";
  if (result.status === 0)
    return "Set CANDLE_API_URL to override the API endpoint.";
  return result.uiHint;
}
function errorEnvelope(result, ctx) {
  const code = result.code ?? result.rfcError ?? (result.status === 0 ? "NETWORK_UNREACHABLE" : `HTTP_${result.status}`);
  const message = result.status === 0 ? `Could not reach ${ctx.apiUrl}.` : result.message;
  const suggestion = suggestionFor(result, ctx);
  const docsUrl = result.docsPath ? `https://docs.candle.tv/${result.docsPath}` : undefined;
  return {
    ok: false,
    code,
    status: result.status,
    message,
    ...suggestion ? { suggestion } : {},
    ...docsUrl ? { docsUrl } : {}
  };
}
function writeFailure(deps, result, ctx, json) {
  if (json)
    deps.stdout.write(`${JSON.stringify(errorEnvelope(result, ctx))}
`);
  else
    deps.stderr.write(`${renderError(result, ctx)}
`);
}
function writeLocalFailure(deps, failure, json) {
  if (json)
    deps.stdout.write(`${JSON.stringify({ ok: false, ...failure })}
`);
  else
    deps.stderr.write(`${failure.suggestion ? `${failure.message} ${failure.suggestion}` : failure.message}
`);
}
function writeUsageFailure(deps, message, json) {
  if (json)
    deps.stdout.write(`${JSON.stringify({ ok: false, code: "USAGE", message })}
`);
  else
    deps.stderr.write(`${message}
`);
}
function portalDeviceUrl(apiUrl, portalOrigin) {
  if (portalOrigin) {
    try {
      return `${new URL(portalOrigin).origin}/dev/agent`;
    } catch {}
  }
  try {
    const url = new URL(apiUrl);
    const labels = url.hostname.split(".");
    const apiLabel = labels.indexOf("api");
    if (apiLabel !== -1 && labels.length > 1) {
      labels.splice(apiLabel, 1);
      url.hostname = labels.join(".");
    }
    return `${url.origin}/dev/agent`;
  } catch {
    return `${apiUrl}/dev/agent`;
  }
}

// src/checks.ts
async function runLiveCheck(params) {
  const { deps, apiUrl, path, auth, credential, check, passDetail } = params;
  const result = await apiRequest(path, {
    auth,
    credentials: auth === "device" ? { deviceToken: credential } : { apiKey: credential },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  return result.ok ? { check, state: "PASS", detail: passDetail } : { check, state: "FAIL", detail: renderError(result, { apiUrl, authType: auth }) };
}

// src/secret-store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var SECRET_REFS = {
  deviceToken: "device_token",
  apiKey: "api_key"
};
function walletSignerRef(walletId) {
  return `wallet_signer_${walletId}`;
}
function pemToStoredSigner(pem) {
  return pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
}
function configDir() {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle");
}
function defaultCredentialsPath() {
  return join(configDir(), "credentials.enc");
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
  iterations;
  cachedPassphrase;
  constructor(options = {}) {
    this.path = options.path ?? defaultCredentialsPath();
    this.iterations = options.iterations ?? PBKDF2_ITERATIONS;
  }
  async get(ref) {
    const passphrase = await this.resolvePassphrase();
    const contents = await this.readContents();
    const entry = contents[ref];
    if (!entry)
      return null;
    const salt = fromBase64(entry.salt);
    const key = await deriveKey(passphrase, salt, entry.iterations);
    const iv = fromBase64(entry.iv);
    const ciphertext = fromBase64(entry.ciphertext);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    } catch {
      throw new Error(`Could not decrypt the credential for "${ref}" in ${this.path}. CANDLE_KEYRING_PASSPHRASE is likely wrong for this file.`);
    }
    return new TextDecoder().decode(plaintext);
  }
  async set(ref, value) {
    const passphrase = await this.resolvePassphrase();
    const contents = await this.readContents();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const key = await deriveKey(passphrase, salt, this.iterations);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    contents[ref] = {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      iterations: this.iterations
    };
    await this.writeContents(contents);
  }
  async delete(ref) {
    await this.resolvePassphrase();
    const contents = await this.readContents();
    if (!(ref in contents))
      return;
    delete contents[ref];
    await this.writeContents(contents);
  }
  async resolvePassphrase() {
    if (this.cachedPassphrase !== undefined)
      return this.cachedPassphrase;
    const fromEnv = process.env.CANDLE_KEYRING_PASSPHRASE;
    if (fromEnv) {
      this.cachedPassphrase = fromEnv;
      return fromEnv;
    }
    if (process.stdin.isTTY) {
      const prompted = await promptHiddenPassphrase("Passphrase for Candle credential store: ");
      this.cachedPassphrase = prompted;
      return prompted;
    }
    throw new Error("No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine");
  }
  async readContents() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT")
        return {};
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`The credentials file at ${this.path} is not valid JSON and cannot be read. Delete it and re-run ` + "the command that stores your device token / API key to recreate it.");
    }
  }
  async writeContents(contents) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 448);
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(contents, null, 2), { encoding: "utf8", mode: 384 });
    await chmod(tmpPath, 384);
    await rename(tmpPath, this.path);
  }
}
async function promptHiddenSecret(promptText) {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available for interactive input; pass --key-file instead");
  }
  return promptHiddenPassphrase(promptText);
}
async function promptHiddenPassphrase(promptText) {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlInternals = rl;
    rlInternals._writeToOutput = (text) => {
      if (text === promptText)
        process.stdout.write(text);
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write(`
`);
      resolve(answer);
    });
  });
}
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// src/deps.ts
async function resolveDeviceToken(deps) {
  const fromEnv = deps.env.CANDLE_DEVICE_TOKEN?.trim();
  if (fromEnv)
    return fromEnv;
  const stored = await deps.store.get(SECRET_REFS.deviceToken);
  return stored ?? undefined;
}
async function resolveApiKey(deps) {
  const fromEnv = deps.env.CANDLE_API_KEY?.trim();
  if (fromEnv)
    return fromEnv;
  const stored = await deps.store.get(SECRET_REFS.apiKey);
  return stored ?? undefined;
}

// src/version.ts
var CLI_VERSION = "0.5.0";

// src/commands/auth.ts
var DEVICE_CODE_PATH = "/api/v1/agent/device/code";
var DEVICE_TOKEN_PATH = "/api/v1/agent/device/token";
var MAX_CLIENT_NAME_LENGTH = 64;
async function authLogin(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { valueFlags: ["--scopes", "--label"], booleanFlags: ["--no-browser"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const scopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined;
  const label = parsed.values["--label"];
  const noBrowser = parsed.booleans.has("--no-browser");
  if (label !== undefined && label.length > MAX_CLIENT_NAME_LENGTH) {
    deps.stderr.write(`--label must be at most ${MAX_CLIENT_NAME_LENGTH} characters (got ${label.length}). Shorten it and run: candle auth login --label <name>
`);
    return 2;
  }
  const clientName = (label ?? `candle-cli/${CLI_VERSION}@${deps.hostname}`).slice(0, MAX_CLIENT_NAME_LENGTH);
  const codeResult = await apiRequest(DEVICE_CODE_PATH, {
    method: "POST",
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: { clientName, ...scopes ? { scopes } : {} }
  });
  if (!codeResult.ok) {
    writeFailure(deps, codeResult, { apiUrl, authType: "none" }, json);
    return 1;
  }
  const code = codeResult.body;
  const progress = json ? deps.stderr : deps.stdout;
  progress.write(`Your device code: ${code.userCode}
`);
  progress.write(`Open this URL to approve: ${code.verificationUriComplete}
`);
  if (!noBrowser) {
    try {
      deps.openBrowser(code.verificationUriComplete);
    } catch {}
  }
  const expiresAtMs = deps.now() + code.expiresIn * 1000;
  let interval = code.interval;
  while (deps.now() < expiresAtMs) {
    await deps.sleep(interval * 1000);
    const tokenResult = await apiRequest(DEVICE_TOKEN_PATH, {
      method: "POST",
      auth: "none",
      credentials: {},
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
      body: { deviceCode: code.deviceCode }
    });
    if (tokenResult.ok) {
      return finishLogin(tokenResult.body, ctx, { scopes, label, verificationUri: code.verificationUri });
    }
    if (tokenResult.rfcError === "authorization_pending")
      continue;
    if (tokenResult.rfcError === "slow_down") {
      interval += 5;
      continue;
    }
    if (tokenResult.rfcError === "access_denied" || tokenResult.rfcError === "expired_token" || tokenResult.rfcError === "invalid_grant") {
      if (json)
        deps.stderr.write(`${JSON.stringify(tokenResult)}
`);
      else
        deps.stderr.write(`${terminalRfcMessage(tokenResult.rfcError)}
`);
      return 1;
    }
    writeFailure(deps, tokenResult, { apiUrl, authType: "none" }, json);
    return 1;
  }
  if (json)
    deps.stderr.write(`${JSON.stringify({ ok: false, reason: "expired_token" })}
`);
  else
    deps.stderr.write(`${terminalRfcMessage("expired_token")}
`);
  return 1;
}
function terminalRfcMessage(rfcError) {
  if (rfcError === "access_denied")
    return "Authorization was denied.";
  if (rfcError === "expired_token")
    return "The device code expired before it was approved. Run: candle auth login";
  return "This device code is unknown or was already used. Run: candle auth login";
}
function portalOriginFrom(verificationUri) {
  if (!verificationUri)
    return;
  try {
    return new URL(verificationUri).origin;
  } catch {
    return;
  }
}
async function finishLogin(rawBody, ctx, requested) {
  const { deps, json, apiUrlFlag } = ctx;
  const body = rawBody;
  await deps.store.set(SECRET_REFS.deviceToken, body.deviceToken);
  if (body.apiKey) {
    await deps.store.set(SECRET_REFS.apiKey, body.apiKey.key);
  }
  const portalOrigin = portalOriginFrom(requested.verificationUri);
  await deps.writeConfig({
    deviceTokenPrefix: body.tokenPrefix,
    ...body.apiKey ? { keyPrefix: body.apiKey.keyPrefix, scopes: body.apiKey.scopes } : {},
    ...requested.label ? { label: requested.label } : {},
    ...apiUrlFlag ? { apiUrl: apiUrlFlag } : {},
    ...portalOrigin ? { portalOrigin } : {}
  });
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      backend: deps.backend,
      deviceTokenPrefix: body.tokenPrefix,
      apiKeyPrefix: body.apiKey?.keyPrefix,
      scopes: body.apiKey?.scopes,
      apiKeyError: body.apiKeyError
    })}
`);
    return 0;
  }
  deps.stdout.write(`Device authorized. Credentials stored in the ${deps.backend} backend.
`);
  deps.stdout.write(`Device token prefix: ${body.tokenPrefix}
`);
  if (body.apiKey) {
    deps.stdout.write(`API key prefix: ${body.apiKey.keyPrefix}
`);
    deps.stdout.write(`Granted scopes: ${formatScopesForSummary(body.apiKey.scopes)}
`);
  } else if (body.apiKeyError) {
    const authorizedScopes = requested.scopes ?? [...ALL_AGENT_SCOPES];
    deps.stdout.write(`Authorized scopes (no key issued yet): ${formatScopesForSummary(authorizedScopes)}
`);
    deps.stdout.write(`${body.apiKeyError}
`);
    deps.stdout.write(`Run: candle keys create
`);
  }
  return 0;
}
async function authLogout(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { booleanFlags: ["--keep-key"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const keepKey = parsed.booleans.has("--keep-key");
  const config = await deps.readConfig();
  const deviceToken = await resolveDeviceToken(deps);
  let revokedKey;
  if (!keepKey && deviceToken && config.keyPrefix) {
    const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(config.keyPrefix)}`, {
      method: "DELETE",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env
    });
    if (result.ok) {
      revokedKey = config.keyPrefix;
    } else if (!json) {
      deps.stdout.write(`Could not revoke the stored API key remotely (clearing it locally anyway).
`);
    }
  }
  await deps.store.delete(SECRET_REFS.deviceToken);
  await deps.store.delete(SECRET_REFS.apiKey);
  await deps.clearConfig();
  const portalUrl = portalDeviceUrl(apiUrl, config.portalOrigin);
  const liveEnvOverrides = ["CANDLE_DEVICE_TOKEN", "CANDLE_API_KEY"].filter((name) => deps.env[name]?.trim());
  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, revokedKey: revokedKey ?? null, portalUrl, envOverrides: liveEnvOverrides })}
`);
    return 0;
  }
  deps.stdout.write(`Local credentials cleared.
`);
  if (liveEnvOverrides.length > 0) {
    deps.stdout.write(`Still set in this shell: ${liveEnvOverrides.join(", ")}. Those beat the store, so they remain live until you unset them.
`);
  }
  deps.stdout.write(`The device token itself is session-only to revoke -- that is intentional (a stolen token cannot read device metadata or revoke a sibling device). Sign in to the portal to revoke it there.
`);
  deps.stdout.write(`Portal: ${portalUrl}
`);
  return 0;
}
function configFilePathForDisplay(env) {
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join2(homedir2(), ".config", "candle");
  return join2(dir, "config.json");
}
async function authStatus(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const config = await deps.readConfig();
  const deviceToken = await resolveDeviceToken(deps);
  const apiKey = await resolveApiKey(deps);
  const rows = [];
  if (!deviceToken) {
    rows.push({ check: "Device token", state: "SKIP", detail: "not set. Run: candle auth login" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/keys",
      auth: "device",
      credential: deviceToken,
      check: "Device token",
      passDetail: "valid"
    }));
  }
  if (!apiKey) {
    rows.push({ check: "API key", state: "SKIP", detail: "not set. Run: candle keys create" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/tier",
      auth: "key",
      credential: apiKey,
      check: "API key",
      passDetail: "valid"
    }));
  }
  let account;
  if (apiKey) {
    const identity = await apiRequest("/api/v1/agent/wallets/embedded", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env
    });
    if (identity.ok)
      account = identity.body.account;
  }
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  const configPath = configFilePathForDisplay(deps.env);
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      backend: deps.backend,
      deviceTokenPrefix: config.deviceTokenPrefix,
      keyPrefix: config.keyPrefix,
      account,
      apiUrl,
      configPath,
      rows
    })}
`);
    return exitCode;
  }
  deps.stdout.write(`Account: ${account ?? "unknown"} at ${apiUrl}
`);
  deps.stdout.write(`Backend: ${deps.backend}
`);
  deps.stdout.write(`Device token prefix: ${config.deviceTokenPrefix ?? "not set"}
`);
  deps.stdout.write(`API key prefix: ${config.keyPrefix ?? "not set"}
`);
  deps.stdout.write(`Config file: ${configPath}

`);
  deps.stdout.write(`${renderTable(["Check", "Status", "Detail"], rows.map((row) => [row.check, row.state, row.detail]))}
`);
  return exitCode;
}

// src/commands/doctor.ts
var MIN_NODE_MAJOR = 18;
var API_KEY_CHECK = "API key valid (launch:write)";
async function doctor(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const rows = [];
  const nodeMajor = Number(deps.nodeVersion.split(".")[0]);
  rows.push(Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR ? { check: "Runtime version", state: "PASS", detail: `node ${deps.nodeVersion}` } : {
    check: "Runtime version",
    state: "FAIL",
    detail: `node ${deps.nodeVersion} is below the minimum (${MIN_NODE_MAJOR}). Fix: upgrade Node.js to ${MIN_NODE_MAJOR} or later.`
  });
  rows.push({ check: "Keychain backend", state: "PASS", detail: deps.backend });
  const deviceToken = await resolveDeviceToken(deps);
  const apiKey = await resolveApiKey(deps);
  rows.push(deviceToken ? {
    check: "Credentials present",
    state: "PASS",
    detail: apiKey ? "device token and API key" : "device token only (no API key yet)"
  } : { check: "Credentials present", state: "FAIL", detail: "No device token found. Fix: run candle auth login." });
  const statusResult = await apiRequest("/api/v1/status", {
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  rows.push(statusResult.ok ? { check: "API reachable", state: "PASS", detail: apiUrl } : { check: "API reachable", state: "FAIL", detail: renderError(statusResult, { apiUrl, authType: "none" }) });
  if (!deviceToken) {
    rows.push({ check: "Device token valid", state: "SKIP", detail: "no device token to check" });
  } else {
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/keys",
      auth: "device",
      credential: deviceToken,
      check: "Device token valid",
      passDetail: "valid"
    }));
  }
  if (!apiKey) {
    rows.push({ check: API_KEY_CHECK, state: "SKIP", detail: "no API key to check" });
  } else {
    const config = await deps.readConfig();
    const passDetail = config.scopes ? `scopes: ${config.scopes.join(", ")}` : "valid";
    rows.push(await runLiveCheck({
      deps,
      apiUrl,
      path: "/api/v1/agent/tier",
      auth: "key",
      credential: apiKey,
      check: API_KEY_CHECK,
      passDetail
    }));
  }
  let account;
  if (!apiKey) {
    rows.push({ check: "Launch wallet delegated", state: "SKIP", detail: "no API key to check" });
  } else {
    const result = await apiRequest("/api/v1/agent/wallets/embedded", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env
    });
    if (!result.ok) {
      rows.push({
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: renderError(result, { apiUrl, authType: "key" })
      });
    } else {
      const body = result.body;
      account = body.account;
      const delegated = Boolean(body.wallets.solana?.delegated || body.wallets.evm?.delegated);
      rows.push(delegated ? { check: "Launch wallet delegated", state: "PASS", detail: "delegated" } : {
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: "No launch wallet is delegated. Fix: delegate one in the portal."
      });
    }
  }
  rows.push(account !== undefined ? { check: "Account", state: "PASS", detail: account } : { check: "Account", state: "SKIP", detail: "could not resolve which account these credentials act as" });
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  if (json) {
    deps.stdout.write(`${JSON.stringify({ rows, ...account !== undefined ? { account } : {} })}
`);
    return exitCode;
  }
  deps.stdout.write(`${renderTable(["Check", "Status", "Detail"], rows.map((row) => [row.check, row.state, row.detail]))}
`);
  return exitCode;
}

// src/commands/keys.ts
var KEYS_PATH = "/api/v1/agent/keys";
var NO_DEVICE_TOKEN = {
  code: "NO_DEVICE_TOKEN",
  message: "No device token available.",
  suggestion: "Run: candle auth login"
};
function mintedByLabel(mintedBy, ownDeviceTokenPrefix) {
  if (!mintedBy)
    return "browser session";
  if (mintedBy === ownDeviceTokenPrefix)
    return "this device";
  return mintedBy;
}
async function keysList(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const deviceToken = await resolveDeviceToken(deps);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(KEYS_PATH, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}
`);
    return 0;
  }
  const body = result.body;
  const config = await deps.readConfig();
  const rows = body.keys.map((key) => [
    key.keyPrefix,
    key.scopes.join(","),
    key.environment,
    formatTimestamp(key.createdAt),
    formatTimestamp(key.lastUsedAt),
    key.revokedAt ? formatTimestamp(key.revokedAt) : "no",
    mintedByLabel(key.mintedByDevicePrefix, config.deviceTokenPrefix)
  ]);
  deps.stdout.write(`${renderTable(["Prefix", "Scopes", "Environment", "Created", "Last used", "Revoked", "Minted by"], rows)}
`);
  return 0;
}
async function keysCreate(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--scopes", "--environment", "--label", "--expires-in", "--tx-limit", "--reset"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const requestedScopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined;
  const environment = parsed.values["--environment"];
  const label = parsed.values["--label"]?.trim();
  if (parsed.values["--label"] !== undefined && (label === undefined || label.length < 1 || label.length > 64)) {
    writeUsageFailure(deps, "--label must be 1 to 64 characters.", json);
    return 2;
  }
  let expiresInDays;
  if (parsed.values["--expires-in"] !== undefined) {
    const parsedDays = parseExpiresInDays(parsed.values["--expires-in"]);
    if (!parsedDays.ok) {
      writeUsageFailure(deps, parsedDays.message, json);
      return 2;
    }
    expiresInDays = parsedDays.days;
  }
  if (parsed.values["--reset"] !== undefined && parsed.values["--tx-limit"] === undefined) {
    writeUsageFailure(deps, "--reset requires --tx-limit.", json);
    return 2;
  }
  let txLimit;
  if (parsed.values["--tx-limit"] !== undefined) {
    const parsedUsd = parseUsdToMicros(parsed.values["--tx-limit"]);
    if (!parsedUsd.ok) {
      writeUsageFailure(deps, parsedUsd.message, json);
      return 2;
    }
    const reset = parsed.values["--reset"] ?? "daily";
    if (!TX_LIMIT_RESETS.includes(reset)) {
      writeUsageFailure(deps, `--reset must be one of: ${TX_LIMIT_RESETS.join(", ")}.`, json);
      return 2;
    }
    txLimit = { usdMicros: parsedUsd.usdMicros, reset };
  }
  const deviceToken = await resolveDeviceToken(deps);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(KEYS_PATH, {
    method: "POST",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: {
      ...requestedScopes ? { scopes: requestedScopes } : {},
      ...environment ? { environment } : {},
      ...label ? { label } : {},
      ...expiresInDays !== undefined ? { expiresInDays } : {},
      ...txLimit ? { txLimit } : {}
    }
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  const body = result.body;
  const existingKey = await deps.store.get(SECRET_REFS.apiKey);
  let stored = false;
  if (!existingKey) {
    await deps.store.set(SECRET_REFS.apiKey, body.key);
    await deps.writeConfig({ keyPrefix: body.keyPrefix, scopes: body.scopes });
    stored = true;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...body, stored })}
`);
    return 0;
  }
  deps.stdout.write(`API key: ${body.key}
`);
  deps.stdout.write(`This is the only time the plaintext key is shown; store it now.
`);
  deps.stdout.write(`Prefix: ${body.keyPrefix}
`);
  deps.stdout.write(`Scopes: ${formatScopesForSummary(body.scopes)}
`);
  if (!requestedScopes) {
    deps.stdout.write(`No --scopes given: the server granted the default scopes (swap:write excluded).
`);
  }
  deps.stdout.write(stored ? `Stored in the ${deps.backend} backend as the CLI's working key.
` : `Not stored: the CLI already manages a different working key. This key belongs to whichever agent it was minted for.
`);
  return 0;
}
async function keysRevoke(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr.write(`Usage: candle keys revoke <prefix>
`);
    return 2;
  }
  const prefix = parsed.positionals[0];
  const deviceToken = await resolveDeviceToken(deps);
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json);
    return 1;
  }
  const result = await apiRequest(`${KEYS_PATH}/${encodeURIComponent(prefix)}`, {
    method: "DELETE",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json);
    return 1;
  }
  const config = await deps.readConfig();
  let clearedLocal = false;
  if (config.keyPrefix === prefix) {
    await deps.store.delete(SECRET_REFS.apiKey);
    await deps.writeConfig({ keyPrefix: undefined });
    clearedLocal = true;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, keyPrefix: prefix, clearedLocal })}
`);
    return 0;
  }
  deps.stdout.write(`Revoked key ${prefix}.
`);
  if (clearedLocal) {
    deps.stdout.write(`This was the CLI's stored working key; also cleared it locally.
`);
  }
  return 0;
}

// src/commands/mcp.ts
var MCP_TOOL_NAMES = [
  "candle_launch_token",
  "candle_launch_and_seed",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile",
  "candle_report_activity",
  "candle_trade",
  "candle_swap",
  "candle_transfer",
  "candle_sweep"
];
var READ_ONLY_TOOL_NAMES = [
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile"
];
function mcpClientConfig(args) {
  return JSON.stringify({ mcpServers: { candle: { command: "candle", args: ["mcp", ...args] } } }, null, 2);
}
async function mcp(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--tools"],
    booleanFlags: ["--read-only", "--print-config"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const readOnly = parsed.booleans.has("--read-only");
  const toolsFlag = parsed.values["--tools"];
  if (readOnly && toolsFlag !== undefined) {
    writeUsageFailure(deps, "--read-only and --tools are mutually exclusive; --read-only IS a tool selection.", json);
    return 2;
  }
  let toolAllowlist;
  if (readOnly) {
    toolAllowlist = READ_ONLY_TOOL_NAMES.join(",");
  } else if (toolsFlag !== undefined) {
    const requested = toolsFlag.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
    const unknown = requested.filter((name) => !MCP_TOOL_NAMES.includes(name));
    if (requested.length === 0 || unknown.length > 0) {
      writeUsageFailure(deps, `--tools must be a comma-separated list of: ${MCP_TOOL_NAMES.join(", ")}${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}`, json);
      return 2;
    }
    toolAllowlist = requested.join(",");
  }
  if (parsed.booleans.has("--print-config")) {
    const launchArgs = [
      ...readOnly ? ["--read-only"] : [],
      ...toolsFlag !== undefined ? ["--tools", toolsFlag] : []
    ];
    deps.stdout.write(`${mcpClientConfig(launchArgs)}
`);
    return 0;
  }
  const apiKey = readOnly ? undefined : await resolveApiKey(deps);
  if (!readOnly && !apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle auth login" }, json);
    return 1;
  }
  const childEnv = {
    ...deps.env,
    CANDLE_API_URL: apiUrl,
    ...apiKey ? { CANDLE_AGENT_API_KEY: apiKey } : {},
    ...toolAllowlist ? { CANDLE_MCP_TOOLS: toolAllowlist } : {}
  };
  deps.stderr.write(`Starting @candledottv/mcp against ${apiUrl}${toolAllowlist ? ` (tools: ${toolAllowlist})` : ""}
`);
  return deps.runChild("npx", ["--yes", "@candledottv/mcp"], childEnv);
}

// src/commands/setup.ts
var SKILLS_CLAUDE_COMMAND = "/plugin marketplace add candledottv/agentic";
var CODING_AGENTS_DOCS = "https://docs.candle.tv/developers/coding-agents";
function section(deps, title) {
  deps.stdout.write(`
== ${title} ==
`);
}
async function setup(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { booleanFlags: ["--no-browser"] });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  if (json) {
    writeUsageFailure(deps, "setup is an interactive wizard; for machine use, compose `auth login --json` and `doctor --json` directly", json);
    return 2;
  }
  deps.stdout.write(`candle setup: this wizard authorizes the device, shows funding, and verifies everything.
`);
  section(deps, "1/4 Authorize this device");
  const deviceToken = await resolveDeviceToken(deps);
  const apiKey = await resolveApiKey(deps);
  if (deviceToken && apiKey) {
    deps.stdout.write(`Already authorized on this machine (device token + API key present). Skipping login.
`);
  } else {
    const loginArgs = parsed.booleans.has("--no-browser") ? ["--no-browser"] : [];
    const loginExit = await authLogin(loginArgs, ctx);
    if (loginExit !== 0) {
      deps.stderr.write(`Setup stopped: device authorization did not complete.
`);
      return loginExit;
    }
  }
  section(deps, "2/4 Fund your agent's wallets");
  const key = await resolveApiKey(deps);
  const walletsResult = key ? await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey: key },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  }) : null;
  if (walletsResult?.ok) {
    const body = walletsResult.body;
    const solana = body.wallets?.solana ?? null;
    const evm = body.wallets?.evm ?? null;
    if (body.account)
      deps.stdout.write(`Account: ${body.account}
`);
    if (solana)
      deps.stdout.write(`Solana (send SOL here):    ${solana.address}
`);
    if (evm)
      deps.stdout.write(`Hood    (send ETH here):    ${evm.address}
`);
    deps.stdout.write(`Launches and trades are paid from these wallets. There is no minimum, and read-only requests work unfunded.
`);
    deps.stdout.write(`
Tell your agent (paste into its context):
`);
    deps.stdout.write(`  You operate a Candle agent account. API base URL: ${apiUrl} (send your API key in the x-api-key header).
`);
    if (solana)
      deps.stdout.write(`  Your Solana wallet: ${solana.address}
`);
    if (evm)
      deps.stdout.write(`  Your Hood Chain (EVM) wallet: ${evm.address}
`);
    deps.stdout.write(`  Check balances before trading, and ask me to fund whichever chain you need.
`);
  } else {
    deps.stdout.write("Could not read the agent wallets right now; `candle wallets` shows them once the API is reachable.\n");
  }
  section(deps, "3/4 Connect your agent");
  deps.stdout.write(`Claude Code skills:  ${SKILLS_CLAUDE_COMMAND}
`);
  deps.stdout.write(`MCP (any client):    candle mcp --print-config
`);
  deps.stdout.write(`Other platforms:     ${CODING_AGENTS_DOCS}
`);
  section(deps, "4/4 Health check");
  const doctorExit = await doctor([], ctx);
  const config = await deps.readConfig();
  deps.stdout.write(`
Console (keys, funding, withdrawal addresses, limits): ${portalDeviceUrl(apiUrl, config.portalOrigin)}
`);
  deps.stdout.write(doctorExit === 0 ? `Setup complete. Your agent can launch, trade, and transfer the moment the wallets are funded.
` : "Setup finished with failed checks above; fix them and re-run `candle doctor`.\n");
  return doctorExit;
}

// ../../node_modules/@scure/base/lib/esm/index.js
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new Error("function expected");
  return true;
}
function astr(label, input) {
  if (typeof input !== "string")
    throw new Error(`${label}: string expected`);
  return true;
}
function anumber(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input))
    throw new Error("array expected");
}
function astrArr(label, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label}: array of numbers expected`);
}
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode };
}
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
        return lettersA[i];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i = indexes.get(letter);
        if (i === undefined)
          throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    }
  };
}
function join3(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
function padding(bits, chr = "=") {
  anumber(bits);
  astr("padding", chr);
  return {
    encode(data) {
      astrArr("padding.encode", data);
      while (data.length * bits % 8)
        data.push(chr);
      return data;
    },
    decode(input) {
      astrArr("padding.decode", input);
      let end = input.length;
      if (end * bits % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (;end > 0 && input[end - 1] === chr; end--) {
        const last = end - 1;
        const byte = last * bits;
        if (byte % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      }
      return input.slice(0, end);
    }
  };
}
function normalize(fn) {
  afn(fn);
  return { encode: (from) => from, decode: (to) => fn(to) };
}
function convertRadix(data, from, to) {
  if (from < 2)
    throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);
  if (to < 2)
    throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);
  aArr(data);
  if (!data.length)
    return [];
  let pos = 0;
  const res = [];
  const digits = Array.from(data, (d) => {
    anumber(d);
    if (d < 0 || d >= from)
      throw new Error(`invalid integer: ${d}`);
    return d;
  });
  const dlen = digits.length;
  while (true) {
    let carry = 0;
    let done = true;
    for (let i = pos;i < dlen; i++) {
      const digit = digits[i];
      const fromCarry = from * carry;
      const digitBase = fromCarry + digit;
      if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
        throw new Error("convertRadix: carry overflow");
      }
      const div = digitBase / to;
      carry = digitBase % to;
      const rounded = Math.floor(div);
      digits[i] = rounded;
      if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
        throw new Error("convertRadix: carry overflow");
      if (!done)
        continue;
      else if (!rounded)
        pos = i;
      else
        done = false;
    }
    res.push(carry);
    if (done)
      break;
  }
  for (let i = 0;i < data.length - 1 && data[i] === 0; i++)
    res.push(0);
  return res.reverse();
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0;i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function convertRadix2(data, from, to, padding2) {
  aArr(data);
  if (from <= 0 || from > 32)
    throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32)
    throw new Error(`convertRadix2: wrong to=${to}`);
  if (radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber(n);
    if (n >= max)
      throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32)
      throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (;pos >= to; pos -= to)
      res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === undefined)
      throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding2 && pos >= from)
    throw new Error("Excess padding");
  if (!padding2 && carry > 0)
    throw new Error(`Non-zero padding: ${carry}`);
  if (padding2 && pos > 0)
    res.push(carry >>> 0);
  return res;
}
function radix(num) {
  anumber(num);
  const _256 = 2 ** 8;
  return {
    encode: (bytes) => {
      if (!isBytes(bytes))
        throw new Error("radix.encode input should be Uint8Array");
      return convertRadix(Array.from(bytes), _256, num);
    },
    decode: (digits) => {
      anumArr("radix.decode", digits);
      return Uint8Array.from(convertRadix(digits, num, _256));
    }
  };
}
function radix2(bits, revPadding = false) {
  anumber(bits);
  if (bits <= 0 || bits > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes(bytes))
        throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {}
  };
}
var base16 = chain(radix2(4), alphabet("0123456789ABCDEF"), join3(""));
var base32 = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), padding(5), join3(""));
var base32nopad = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), join3(""));
var base32hex = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), padding(5), join3(""));
var base32hexnopad = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), join3(""));
var base32crockford = chain(radix2(5), alphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZ"), join3(""), normalize((s) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")));
var hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
var decodeBase64Builtin = (s, isUrl) => {
  astr("base64", s);
  const re = isUrl ? /^[A-Za-z0-9=_-]+$/ : /^[A-Za-z0-9=+/]+$/;
  const alphabet2 = isUrl ? "base64url" : "base64";
  if (s.length > 0 && !re.test(s))
    throw new Error("invalid base64");
  return Uint8Array.fromBase64(s, { alphabet: alphabet2, lastChunkHandling: "strict" });
};
var base64 = hasBase64Builtin ? {
  encode(b) {
    abytes(b);
    return b.toBase64();
  },
  decode(s) {
    return decodeBase64Builtin(s, false);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), padding(6), join3(""));
var base64nopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), join3(""));
var base64url = hasBase64Builtin ? {
  encode(b) {
    abytes(b);
    return b.toBase64({ alphabet: "base64url" });
  },
  decode(s) {
    return decodeBase64Builtin(s, true);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), padding(6), join3(""));
var base64urlnopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), join3(""));
var genBase58 = (abc) => chain(radix(58), alphabet(abc), join3(""));
var base58 = genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
var base58flickr = genBase58("123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ");
var base58xrp = genBase58("rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz");
var BECH_ALPHABET = chain(alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), join3(""));
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0;i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0;i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0;i < len; i++)
    chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0;i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix, words, limit = 90) {
    astr("bech32.encode prefix", prefix);
    if (isBytes(words))
      words = Array.from(words);
    anumArr("bech32.encode", words);
    const plen = prefix.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
  }
  function decode(str, limit = 90) {
    astr("bech32.decode input", str);
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix, words };
  }
  const decodeUnsafe = unsafeWrapper(decode);
  function decodeToBytes(str) {
    const { prefix, words } = decode(str, false);
    return { prefix, words, bytes: fromWords(words) };
  }
  function encodeFromBytes(prefix, bytes) {
    return encode(prefix, toWords(bytes));
  }
  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = genBech32("bech32");
var bech32m = genBech32("bech32m");
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexBuiltin = {
  encode(data) {
    abytes(data);
    return data.toHex();
  },
  decode(s) {
    astr("hex", s);
    return Uint8Array.fromHex(s);
  }
};
var hex = hasHexBuiltin ? hexBuiltin : chain(radix2(4), alphabet("0123456789abcdef"), join3(""), normalize((s) => {
  if (typeof s !== "string" || s.length % 2 !== 0)
    throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
  return s.toLowerCase();
}));

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function anumber2(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("positive integer expected, got " + n);
  }
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished) {
    throw new Error("Hash#digest() has already been called");
  }
}
function aoutput(out, instance) {
  abytes2(out, undefined, "output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function checkOpts(defaults, opts) {
  if (opts == null || typeof opts !== "object") {
    throw new Error("options must be defined");
  }
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes2(key, undefined, "key");
    if (!isLE) {
      throw new Error("Non little-endian hardware is not yet supported");
    }
    if (params.nonceLength !== undefined) {
      const nonce = args[0];
      abytes2(nonce, params.varSizeNonce ? undefined : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== undefined)
      abytes2(args[1], undefined, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== undefined) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes2(output, undefined, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called) {
          throw new Error("cannot encrypt() twice with same key + nonce");
        }
        called = true;
        abytes2(data);
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes2(data);
        if (tagl && data.length < tagl) {
          throw new Error('"ciphertext" expected length bigger than tagLength=' + tagl);
        }
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === undefined)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength) {
    throw new Error('"output" expected Uint8Array of length ' + expectedLength + ", got: " + out.length);
  }
  if (onlyAligned && !isAligned32(out)) {
    throw new Error("invalid output, must be aligned");
  }
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  abool(isLE2);
  const num = new Uint8Array(16);
  const view = createView(num);
  view.setBigUint64(0, BigInt(aadLength), isLE2);
  view.setBigUint64(8, BigInt(dataLength), isLE2);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/_arx.js
var _utf8ToBytes = (str) => Uint8Array.from(str.split("").map((c) => c.charCodeAt(0)));
var sigma16 = _utf8ToBytes("expand 16-byte k");
var sigma32 = _utf8ToBytes("expand 32-byte k");
var sigma16_32 = u32(sigma16);
var sigma32_32 = u32(sigma32);
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
function isAligned322(b) {
  return b.byteOffset % 4 === 0;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = 2 ** 32 - 1;
var U32_EMPTY = Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isAligned322(data) && isAligned322(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  for (let pos = 0;pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj;j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj;j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({
    allowShortKeys: false,
    counterLength: 8,
    counterRight: false,
    rounds: 20
  }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber2(counterLength);
  anumber2(rounds);
  abool(counterRight);
  abool(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes2(key, undefined, "key");
    abytes2(nonce, undefined, "nonce");
    abytes2(data, undefined, "data");
    const len = data.length;
    if (output === undefined)
      output = new Uint8Array(len);
    abytes2(output, undefined, "output");
    anumber2(counter);
    if (counter < 0 || counter >= MAX_COUNTER) {
      throw new Error("arx: counter overflow");
    }
    if (output.length < len) {
      throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
    }
    const toClean = [];
    const l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      abytes2(key, 32, "arx key");
      throw new Error("invalid key size");
    }
    if (!isAligned322(nonce))
      toClean.push(nonce = copyBytes(nonce));
    const k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24) {
        throw new Error(`arx: extended nonce must be 24 bytes`);
      }
      extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
      nonce = nonce.subarray(16);
    }
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length) {
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    }
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = u32(nonce);
    runCipher(core, sigma, k32, n32, data, output, counter, rounds);
    clean(...toClean);
    return output;
  };
}

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/_poly1305.js
function u8to16(a, i) {
  return a[i++] & 255 | (a[i++] & 255) << 8;
}

class Poly1305 {
  constructor(key) {
    Object.defineProperty(this, "blockLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "outputLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "buffer", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint8Array(16)
    });
    Object.defineProperty(this, "r", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(10)
    });
    Object.defineProperty(this, "h", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(10)
    });
    Object.defineProperty(this, "pad", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Uint16Array(8)
    });
    Object.defineProperty(this, "pos", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "finished", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    key = copyBytes(abytes2(key, 32, "key"));
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0;i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    const h0 = h[0] + (t0 & 8191);
    const h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    const h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    const h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    const h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    const h5 = h[5] + (t4 >>> 1 & 8191);
    const h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    const h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    const h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    const h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2;i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1;i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0;i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0;i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1;i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean(g);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    data = copyBytes(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    clean(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (;pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0;i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
    return out;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
}
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key).update(msg).digest();
  const tmp = hashCons(new Uint8Array(32));
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key) => hashCons(key);
  return hashC;
}
var poly1305 = /* @__PURE__ */ (() => wrapConstructorWithKey((key) => new Poly1305(key)))();

// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  const y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0;r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const leftover = msg.length % 16;
  if (leftover)
    h.update(ZEROS16.subarray(leftover));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  if (AAD !== undefined)
    abytes2(AAD, undefined, "AAD");
  const authKey = fn(key, nonce, ZEROS32);
  const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, ciphertext);
  h.update(lengths);
  const res = h.digest();
  clean(authKey, lengths);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag))
        throw new Error("invalid tag");
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));

// ../../node_modules/@hpke/common/esm/src/errors.js
class HpkeError extends Error {
  constructor(e) {
    let message;
    if (e instanceof Error) {
      message = e.message;
    } else if (typeof e === "string") {
      message = e;
    } else {
      message = "";
    }
    super(message);
    this.name = this.constructor.name;
  }
}

class InvalidParamError extends HpkeError {
}
class SerializeError extends HpkeError {
}

class DeserializeError extends HpkeError {
}

class EncapError extends HpkeError {
}

class DecapError extends HpkeError {
}

class ExportError extends HpkeError {
}

class SealError extends HpkeError {
}

class OpenError extends HpkeError {
}

class MessageLimitReachedError extends HpkeError {
}

class DeriveKeyPairError extends HpkeError {
}

class NotSupportedError extends HpkeError {
}
// ../../node_modules/@hpke/common/esm/_dnt.shims.js
var dntGlobals = {};
var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
function createMergeProxy(baseObj, extObj) {
  return new Proxy(baseObj, {
    get(_target, prop, _receiver) {
      if (prop in extObj) {
        return extObj[prop];
      } else {
        return baseObj[prop];
      }
    },
    set(_target, prop, value) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      baseObj[prop] = value;
      return true;
    },
    deleteProperty(_target, prop) {
      let success = false;
      if (prop in extObj) {
        delete extObj[prop];
        success = true;
      }
      if (prop in baseObj) {
        delete baseObj[prop];
        success = true;
      }
      return success;
    },
    ownKeys(_target) {
      const baseKeys = Reflect.ownKeys(baseObj);
      const extKeys = Reflect.ownKeys(extObj);
      const extKeysSet = new Set(extKeys);
      return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
    },
    defineProperty(_target, prop, desc) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      Reflect.defineProperty(baseObj, prop, desc);
      return true;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in extObj) {
        return Reflect.getOwnPropertyDescriptor(extObj, prop);
      } else {
        return Reflect.getOwnPropertyDescriptor(baseObj, prop);
      }
    },
    has(_target, prop) {
      return prop in extObj || prop in baseObj;
    }
  });
}

// ../../node_modules/@hpke/common/esm/src/algorithm.js
async function loadSubtleCrypto() {
  if (dntGlobalThis !== undefined && globalThis.crypto !== undefined) {
    return globalThis.crypto.subtle;
  }
  try {
    const { webcrypto } = await import("crypto");
    return webcrypto.subtle;
  } catch (e) {
    throw new NotSupportedError(e);
  }
}

class NativeAlgorithm {
  constructor() {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
  }
  async _setup() {
    if (this._api !== undefined) {
      return;
    }
    this._api = await loadSubtleCrypto();
  }
}
// ../../node_modules/@hpke/common/esm/src/identifiers.js
var Mode = {
  Base: 0,
  Psk: 1,
  Auth: 2,
  AuthPsk: 3
};
var KemId = {
  NotAssigned: 0,
  DhkemP256HkdfSha256: 16,
  DhkemP384HkdfSha384: 17,
  DhkemP521HkdfSha512: 18,
  DhkemSecp256k1HkdfSha256: 19,
  DhkemX25519HkdfSha256: 32,
  DhkemX448HkdfSha512: 33,
  HybridkemX25519Kyber768: 48,
  MlKem512: 64,
  MlKem768: 65,
  MlKem1024: 66,
  XWing: 25722
};
var KdfId = {
  HkdfSha256: 1,
  HkdfSha384: 2,
  HkdfSha512: 3
};
var AeadId = {
  Aes128Gcm: 1,
  Aes256Gcm: 2,
  Chacha20Poly1305: 3,
  ExportOnly: 65535
};
// ../../node_modules/@hpke/common/esm/src/consts.js
var INPUT_LENGTH_LIMIT = 8192;
var INFO_LENGTH_LIMIT = 65536;
var MINIMUM_PSK_LENGTH = 32;
var EMPTY = new Uint8Array(0);

// ../../node_modules/@hpke/common/esm/src/interfaces/kemInterface.js
var SUITE_ID_HEADER_KEM = new Uint8Array([
  75,
  69,
  77,
  0,
  0
]);

// ../../node_modules/@hpke/common/esm/src/utils/misc.js
var isCryptoKeyPair = (x) => typeof x === "object" && x !== null && typeof x.privateKey === "object" && typeof x.publicKey === "object";
function i2Osp(n, w) {
  if (w <= 0) {
    throw new Error("i2Osp: too small size");
  }
  if (n >= 256 ** w) {
    throw new Error("i2Osp: too large integer");
  }
  const ret = new Uint8Array(w);
  for (let i = 0;i < w && n; i++) {
    ret[w - (i + 1)] = n % 256;
    n = n >> 8;
  }
  return ret;
}
function concat(a, b) {
  const ret = new Uint8Array(a.length + b.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  return ret;
}
function base64UrlToBytes(v) {
  const base642 = v.replace(/-/g, "+").replace(/_/g, "/");
  const byteString = atob(base642);
  const ret = new Uint8Array(byteString.length);
  for (let i = 0;i < byteString.length; i++) {
    ret[i] = byteString.charCodeAt(i);
  }
  return ret;
}
function xor(a, b) {
  if (a.byteLength !== b.byteLength) {
    throw new Error("xor: different length inputs");
  }
  const buf = new Uint8Array(a.byteLength);
  for (let i = 0;i < a.byteLength; i++) {
    buf[i] = a[i] ^ b[i];
  }
  return buf;
}

// ../../node_modules/@hpke/common/esm/src/kems/dhkem.js
var LABEL_EAE_PRK = new Uint8Array([101, 97, 101, 95, 112, 114, 107]);
var LABEL_SHARED_SECRET = new Uint8Array([
  115,
  104,
  97,
  114,
  101,
  100,
  95,
  115,
  101,
  99,
  114,
  101,
  116
]);
function concat3(a, b, c) {
  const ret = new Uint8Array(a.length + b.length + c.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  ret.set(c, a.length + b.length);
  return ret;
}

class Dhkem {
  constructor(id, prim, kdf) {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_prim", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this.id = id;
    this._prim = prim;
    this._kdf = kdf;
    const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
    suiteId.set(i2Osp(this.id, 2), 3);
    this._kdf.init(suiteId);
  }
  async serializePublicKey(key) {
    return await this._prim.serializePublicKey(key);
  }
  async deserializePublicKey(key) {
    return await this._prim.deserializePublicKey(key);
  }
  async serializePrivateKey(key) {
    return await this._prim.serializePrivateKey(key);
  }
  async deserializePrivateKey(key) {
    return await this._prim.deserializePrivateKey(key);
  }
  async importKey(format, key, isPublic = true) {
    return await this._prim.importKey(format, key, isPublic);
  }
  async generateKeyPair() {
    return await this._prim.generateKeyPair();
  }
  async deriveKeyPair(ikm) {
    if (ikm.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long ikm");
    }
    return await this._prim.deriveKeyPair(ikm);
  }
  async encap(params) {
    let ke;
    if (params.ekm === undefined) {
      ke = await this.generateKeyPair();
    } else if (isCryptoKeyPair(params.ekm)) {
      ke = params.ekm;
    } else {
      ke = await this.deriveKeyPair(params.ekm);
    }
    const enc = await this._prim.serializePublicKey(ke.publicKey);
    const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
    try {
      let dh;
      if (params.senderKey === undefined) {
        dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
      } else {
        const sks = isCryptoKeyPair(params.senderKey) ? params.senderKey.privateKey : params.senderKey;
        const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderKey === undefined) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pks = isCryptoKeyPair(params.senderKey) ? params.senderKey.publicKey : await this._prim.derivePublicKey(params.senderKey);
        const pksm = await this._prim.serializePublicKey(pks);
        kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
      }
      const sharedSecret = await this._generateSharedSecret(dh, kemContext);
      return {
        enc,
        sharedSecret
      };
    } catch (e) {
      throw new EncapError(e);
    }
  }
  async decap(params) {
    const pke = await this._prim.deserializePublicKey(params.enc);
    const skr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.privateKey : params.recipientKey;
    const pkr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.publicKey : await this._prim.derivePublicKey(params.recipientKey);
    const pkrm = await this._prim.serializePublicKey(pkr);
    try {
      let dh;
      if (params.senderPublicKey === undefined) {
        dh = new Uint8Array(await this._prim.dh(skr, pke));
      } else {
        const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
        const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderPublicKey === undefined) {
        kemContext = concat(new Uint8Array(params.enc), new Uint8Array(pkrm));
      } else {
        const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
        kemContext = new Uint8Array(params.enc.byteLength + pkrm.byteLength + pksm.byteLength);
        kemContext.set(new Uint8Array(params.enc), 0);
        kemContext.set(new Uint8Array(pkrm), params.enc.byteLength);
        kemContext.set(new Uint8Array(pksm), params.enc.byteLength + pkrm.byteLength);
      }
      return await this._generateSharedSecret(dh, kemContext);
    } catch (e) {
      throw new DecapError(e);
    }
  }
  async _generateSharedSecret(dh, kemContext) {
    const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
    const labeledInfo = this._kdf.buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, this.secretSize);
    return await this._kdf.extractAndExpand(EMPTY.buffer, labeledIkm.buffer, labeledInfo.buffer, this.secretSize);
  }
}
// ../../node_modules/@hpke/common/esm/src/interfaces/dhkemPrimitives.js
var KEM_USAGES = ["deriveBits"];
var LABEL_DKP_PRK = new Uint8Array([
  100,
  107,
  112,
  95,
  112,
  114,
  107
]);
var LABEL_SK = new Uint8Array([115, 107]);

// ../../node_modules/@hpke/common/esm/src/utils/bignum.js
class Bignum {
  constructor(size) {
    Object.defineProperty(this, "_num", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._num = new Uint8Array(size);
  }
  val() {
    return this._num;
  }
  reset() {
    this._num.fill(0);
  }
  set(src) {
    if (src.length !== this._num.length) {
      throw new Error("Bignum.set: invalid argument");
    }
    this._num.set(src);
  }
  isZero() {
    for (let i = 0;i < this._num.length; i++) {
      if (this._num[i] !== 0) {
        return false;
      }
    }
    return true;
  }
  lessThan(v) {
    if (v.length !== this._num.length) {
      throw new Error("Bignum.lessThan: invalid argument");
    }
    for (let i = 0;i < this._num.length; i++) {
      if (this._num[i] < v[i]) {
        return true;
      }
      if (this._num[i] > v[i]) {
        return false;
      }
    }
    return false;
  }
}

// ../../node_modules/@hpke/common/esm/src/kems/dhkemPrimitives/ec.js
var LABEL_CANDIDATE = new Uint8Array([
  99,
  97,
  110,
  100,
  105,
  100,
  97,
  116,
  101
]);
var ORDER_P_256 = new Uint8Array([
  255,
  255,
  255,
  255,
  0,
  0,
  0,
  0,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  188,
  230,
  250,
  173,
  167,
  23,
  158,
  132,
  243,
  185,
  202,
  194,
  252,
  99,
  37,
  81
]);
var ORDER_P_384 = new Uint8Array([
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  199,
  99,
  77,
  129,
  244,
  55,
  45,
  223,
  88,
  26,
  13,
  178,
  72,
  176,
  167,
  122,
  236,
  236,
  25,
  106,
  204,
  197,
  41,
  115
]);
var ORDER_P_521 = new Uint8Array([
  1,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  250,
  81,
  134,
  135,
  131,
  191,
  47,
  150,
  107,
  127,
  204,
  1,
  72,
  247,
  9,
  165,
  208,
  59,
  181,
  201,
  184,
  137,
  156,
  71,
  174,
  187,
  111,
  183,
  30,
  145,
  56,
  100,
  9
]);
var PKCS8_ALG_ID_P_256 = new Uint8Array([
  48,
  65,
  2,
  1,
  0,
  48,
  19,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  8,
  42,
  134,
  72,
  206,
  61,
  3,
  1,
  7,
  4,
  39,
  48,
  37,
  2,
  1,
  1,
  4,
  32
]);
var PKCS8_ALG_ID_P_384 = new Uint8Array([
  48,
  78,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  34,
  4,
  55,
  48,
  53,
  2,
  1,
  1,
  4,
  48
]);
var PKCS8_ALG_ID_P_521 = new Uint8Array([
  48,
  96,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  35,
  4,
  73,
  48,
  71,
  2,
  1,
  1,
  4,
  66
]);

class Ec extends NativeAlgorithm {
  constructor(kem, hkdf) {
    super();
    Object.defineProperty(this, "_hkdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_alg", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nPk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nSk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nDh", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_order", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_bitmask", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_pkcs8AlgId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._hkdf = hkdf;
    switch (kem) {
      case KemId.DhkemP256HkdfSha256:
        this._alg = { name: "ECDH", namedCurve: "P-256" };
        this._nPk = 65;
        this._nSk = 32;
        this._nDh = 32;
        this._order = ORDER_P_256;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_256;
        break;
      case KemId.DhkemP384HkdfSha384:
        this._alg = { name: "ECDH", namedCurve: "P-384" };
        this._nPk = 97;
        this._nSk = 48;
        this._nDh = 48;
        this._order = ORDER_P_384;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_384;
        break;
      default:
        this._alg = { name: "ECDH", namedCurve: "P-521" };
        this._nPk = 133;
        this._nSk = 66;
        this._nDh = 66;
        this._order = ORDER_P_521;
        this._bitmask = 1;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_521;
        break;
    }
  }
  async serializePublicKey(key) {
    await this._setup();
    try {
      return await this._api.exportKey("raw", key);
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePublicKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(key, true);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async serializePrivateKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      if (!("d" in jwk)) {
        throw new Error("Not private key");
      }
      return base64UrlToBytes(jwk["d"]).buffer;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePrivateKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(key, false);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async importKey(format, key, isPublic) {
    await this._setup();
    try {
      if (format === "raw") {
        return await this._importRawKey(key, isPublic);
      }
      if (key instanceof ArrayBuffer) {
        throw new Error("Invalid jwk key format");
      }
      return await this._importJWK(key, isPublic);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async generateKeyPair() {
    await this._setup();
    try {
      return await this._api.generateKey(this._alg, true, KEM_USAGES);
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  async deriveKeyPair(ikm) {
    await this._setup();
    try {
      const dkpPrk = await this._hkdf.labeledExtract(EMPTY.buffer, LABEL_DKP_PRK, new Uint8Array(ikm));
      const bn = new Bignum(this._nSk);
      for (let counter = 0;bn.isZero() || !bn.lessThan(this._order); counter++) {
        if (counter > 255) {
          throw new Error("Faild to derive a key pair");
        }
        const bytes = new Uint8Array(await this._hkdf.labeledExpand(dkpPrk, LABEL_CANDIDATE, i2Osp(counter, 1), this._nSk));
        bytes[0] = bytes[0] & this._bitmask;
        bn.set(bytes);
      }
      const sk = await this._deserializePkcs8Key(bn.val());
      bn.reset();
      return {
        privateKey: sk,
        publicKey: await this.derivePublicKey(sk)
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
  async derivePublicKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      delete jwk["d"];
      delete jwk["key_ops"];
      return await this._api.importKey("jwk", jwk, this._alg, true, []);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async dh(sk, pk) {
    try {
      await this._setup();
      const bits = await this._api.deriveBits({
        name: "ECDH",
        public: pk
      }, sk, this._nDh * 8);
      return bits;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async _importRawKey(key, isPublic) {
    if (isPublic && key.byteLength !== this._nPk) {
      throw new Error("Invalid public key for the ciphersuite");
    }
    if (!isPublic && key.byteLength !== this._nSk) {
      throw new Error("Invalid private key for the ciphersuite");
    }
    if (isPublic) {
      return await this._api.importKey("raw", key, this._alg, true, []);
    }
    return await this._deserializePkcs8Key(new Uint8Array(key));
  }
  async _importJWK(key, isPublic) {
    if (typeof key.crv === "undefined" || key.crv !== this._alg.namedCurve) {
      throw new Error(`Invalid crv: ${key.crv}`);
    }
    if (isPublic) {
      if (typeof key.d !== "undefined") {
        throw new Error("Invalid key: `d` should not be set");
      }
      return await this._api.importKey("jwk", key, this._alg, true, []);
    }
    if (typeof key.d === "undefined") {
      throw new Error("Invalid key: `d` not found");
    }
    return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
  }
  async _deserializePkcs8Key(k) {
    const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
    pkcs8Key.set(this._pkcs8AlgId, 0);
    pkcs8Key.set(k, this._pkcs8AlgId.length);
    return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
  }
}
// ../../node_modules/@hpke/common/esm/src/kdfs/hkdf.js
var HPKE_VERSION = new Uint8Array([72, 80, 75, 69, 45, 118, 49]);

class HkdfNative extends NativeAlgorithm {
  constructor() {
    super();
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: EMPTY
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
  init(suiteId) {
    this._suiteId = suiteId;
  }
  buildLabeledIkm(label, ikm) {
    this._checkInit();
    const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
    ret.set(HPKE_VERSION, 0);
    ret.set(this._suiteId, 7);
    ret.set(label, 7 + this._suiteId.byteLength);
    ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  buildLabeledInfo(label, info, len) {
    this._checkInit();
    const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
    ret.set(new Uint8Array([0, len]), 0);
    ret.set(HPKE_VERSION, 2);
    ret.set(this._suiteId, 9);
    ret.set(label, 9 + this._suiteId.byteLength);
    ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  async extract(salt, ikm) {
    await this._setup();
    if (salt.byteLength === 0) {
      salt = new ArrayBuffer(this.hashSize);
    }
    if (salt.byteLength !== this.hashSize) {
      throw new InvalidParamError("The salt length must be the same as the hashSize");
    }
    const key = await this._api.importKey("raw", salt, this.algHash, false, [
      "sign"
    ]);
    return await this._api.sign("HMAC", key, ikm);
  }
  async expand(prk, info, len) {
    await this._setup();
    const key = await this._api.importKey("raw", prk, this.algHash, false, [
      "sign"
    ]);
    const okm = new ArrayBuffer(len);
    const p = new Uint8Array(okm);
    let prev = EMPTY;
    const mid = new Uint8Array(info);
    const tail = new Uint8Array(1);
    if (len > 255 * this.hashSize) {
      throw new Error("Entropy limit reached");
    }
    const tmp = new Uint8Array(this.hashSize + mid.length + 1);
    for (let i = 1, cur = 0;cur < p.length; i++) {
      tail[0] = i;
      tmp.set(prev, 0);
      tmp.set(mid, prev.length);
      tmp.set(tail, prev.length + mid.length);
      prev = new Uint8Array(await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)));
      if (p.length - cur >= prev.length) {
        p.set(prev, cur);
        cur += prev.length;
      } else {
        p.set(prev.slice(0, p.length - cur), cur);
        cur += p.length - cur;
      }
    }
    return okm;
  }
  async extractAndExpand(salt, ikm, info, len) {
    await this._setup();
    const baseKey = await this._api.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return await this._api.deriveBits({
      name: "HKDF",
      hash: this.algHash.hash,
      salt,
      info
    }, baseKey, len * 8);
  }
  async labeledExtract(salt, label, ikm) {
    return await this.extract(salt, this.buildLabeledIkm(label, ikm).buffer);
  }
  async labeledExpand(prk, label, info, len) {
    return await this.expand(prk, this.buildLabeledInfo(label, info, len).buffer, len);
  }
  _checkInit() {
    if (this._suiteId === EMPTY) {
      throw new Error("Not initialized. Call init()");
    }
  }
}

class HkdfSha256Native extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
}
// ../../node_modules/@hpke/chacha20poly1305/esm/src/chacha20Poly1305.js
class Chacha20Poly1305Context {
  constructor(key) {
    Object.defineProperty(this, "_key", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._key = new Uint8Array(key);
  }
  async seal(iv, data, aad) {
    return await this._seal(iv, data, aad);
  }
  async open(iv, data, aad) {
    return await this._open(iv, data, aad);
  }
  _seal(iv, data, aad) {
    return new Promise((resolve) => {
      const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).encrypt(new Uint8Array(data));
      resolve(ret.buffer);
    });
  }
  _open(iv, data, aad) {
    return new Promise((resolve) => {
      const ret = chacha20poly1305(this._key, new Uint8Array(iv), new Uint8Array(aad)).decrypt(new Uint8Array(data));
      resolve(ret.buffer);
    });
  }
}

class Chacha20Poly1305 {
  constructor() {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: AeadId.Chacha20Poly1305
    });
    Object.defineProperty(this, "keySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "nonceSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 12
    });
    Object.defineProperty(this, "tagSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
  }
  createEncryptionContext(key) {
    return new Chacha20Poly1305Context(key);
  }
}
// ../../node_modules/@hpke/core/esm/src/utils/emitNotSupported.js
function emitNotSupported() {
  return new Promise((_resolve, reject) => {
    reject(new NotSupportedError("Not supported"));
  });
}

// ../../node_modules/@hpke/core/esm/src/exporterContext.js
var LABEL_SEC = new Uint8Array([115, 101, 99]);

class ExporterContextImpl {
  constructor(api, kdf, exporterSecret) {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "exporterSecret", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this._api = api;
    this._kdf = kdf;
    this.exporterSecret = exporterSecret;
  }
  async seal(_data, _aad) {
    return await emitNotSupported();
  }
  async open(_data, _aad) {
    return await emitNotSupported();
  }
  async export(exporterContext, len) {
    if (exporterContext.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long exporter context");
    }
    try {
      return await this._kdf.labeledExpand(this.exporterSecret, LABEL_SEC, new Uint8Array(exporterContext), len);
    } catch (e) {
      throw new ExportError(e);
    }
  }
}

class RecipientExporterContextImpl extends ExporterContextImpl {
}

class SenderExporterContextImpl extends ExporterContextImpl {
  constructor(api, kdf, exporterSecret, enc) {
    super(api, kdf, exporterSecret);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    this.enc = enc;
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/encryptionContext.js
class EncryptionContextImpl extends ExporterContextImpl {
  constructor(api, kdf, params) {
    super(api, kdf, params.exporterSecret);
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nK", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nN", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_nT", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_ctx", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    if (params.key === undefined || params.baseNonce === undefined || params.seq === undefined) {
      throw new Error("Required parameters are missing");
    }
    this._aead = params.aead;
    this._nK = this._aead.keySize;
    this._nN = this._aead.nonceSize;
    this._nT = this._aead.tagSize;
    const key = this._aead.createEncryptionContext(params.key);
    this._ctx = {
      key,
      baseNonce: params.baseNonce,
      seq: params.seq
    };
  }
  computeNonce(k) {
    const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
    return xor(k.baseNonce, seqBytes).buffer;
  }
  incrementSeq(k) {
    if (k.seq > Number.MAX_SAFE_INTEGER) {
      throw new MessageLimitReachedError("Message limit reached");
    }
    k.seq += 1;
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/mutex.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _Mutex_locked;

class Mutex {
  constructor() {
    _Mutex_locked.set(this, Promise.resolve());
  }
  async lock() {
    let releaseLock;
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
    __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
    await previousLock;
    return releaseLock;
  }
}
_Mutex_locked = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/recipientContext.js
var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _RecipientContextImpl_mutex;

class RecipientContextImpl extends EncryptionContextImpl {
  constructor() {
    super(...arguments);
    _RecipientContextImpl_mutex.set(this, undefined);
  }
  async open(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet2(this, _RecipientContextImpl_mutex, __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex, "f");
    const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
    let pt;
    try {
      pt = await this._ctx.key.open(this.computeNonce(this._ctx), data, aad);
    } catch (e) {
      throw new OpenError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return pt;
  }
}
_RecipientContextImpl_mutex = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/senderContext.js
var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _SenderContextImpl_mutex;

class SenderContextImpl extends EncryptionContextImpl {
  constructor(api, kdf, params, enc) {
    super(api, kdf, params);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    _SenderContextImpl_mutex.set(this, undefined);
    this.enc = enc;
  }
  async seal(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet3(this, _SenderContextImpl_mutex, __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex, "f");
    const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
    let ct;
    try {
      ct = await this._ctx.key.seal(this.computeNonce(this._ctx), data, aad);
    } catch (e) {
      throw new SealError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return ct;
  }
}
_SenderContextImpl_mutex = new WeakMap;

// ../../node_modules/@hpke/core/esm/src/cipherSuiteNative.js
var LABEL_BASE_NONCE = new Uint8Array([
  98,
  97,
  115,
  101,
  95,
  110,
  111,
  110,
  99,
  101
]);
var LABEL_EXP = new Uint8Array([101, 120, 112]);
var LABEL_INFO_HASH = new Uint8Array([
  105,
  110,
  102,
  111,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_KEY = new Uint8Array([107, 101, 121]);
var LABEL_PSK_ID_HASH = new Uint8Array([
  112,
  115,
  107,
  95,
  105,
  100,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
var SUITE_ID_HEADER_HPKE = new Uint8Array([
  72,
  80,
  75,
  69,
  0,
  0,
  0,
  0,
  0,
  0
]);

class CipherSuiteNative extends NativeAlgorithm {
  constructor(params) {
    super();
    Object.defineProperty(this, "_kem", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined
    });
    if (typeof params.kem === "number") {
      throw new InvalidParamError("KemId cannot be used");
    }
    this._kem = params.kem;
    if (typeof params.kdf === "number") {
      throw new InvalidParamError("KdfId cannot be used");
    }
    this._kdf = params.kdf;
    if (typeof params.aead === "number") {
      throw new InvalidParamError("AeadId cannot be used");
    }
    this._aead = params.aead;
    this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
    this._suiteId.set(i2Osp(this._kem.id, 2), 4);
    this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
    this._suiteId.set(i2Osp(this._aead.id, 2), 8);
    this._kdf.init(this._suiteId);
  }
  get kem() {
    return this._kem;
  }
  get kdf() {
    return this._kdf;
  }
  get aead() {
    return this._aead;
  }
  async createSenderContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const dh = await this._kem.encap(params);
    let mode;
    if (params.psk !== undefined) {
      mode = params.senderKey !== undefined ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderKey !== undefined ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
  }
  async createRecipientContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const sharedSecret = await this._kem.decap(params);
    let mode;
    if (params.psk !== undefined) {
      mode = params.senderPublicKey !== undefined ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderPublicKey !== undefined ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleR(mode, sharedSecret, params);
  }
  async seal(params, pt, aad = EMPTY.buffer) {
    const ctx = await this.createSenderContext(params);
    return {
      ct: await ctx.seal(pt, aad),
      enc: ctx.enc
    };
  }
  async open(params, ct, aad = EMPTY.buffer) {
    const ctx = await this.createRecipientContext(params);
    return await ctx.open(ct, aad);
  }
  async _keySchedule(mode, sharedSecret, params) {
    const pskId = params.psk === undefined ? EMPTY : new Uint8Array(params.psk.id);
    const pskIdHash = await this._kdf.labeledExtract(EMPTY.buffer, LABEL_PSK_ID_HASH, pskId);
    const info = params.info === undefined ? EMPTY : new Uint8Array(params.info);
    const infoHash = await this._kdf.labeledExtract(EMPTY.buffer, LABEL_INFO_HASH, info);
    const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
    keyScheduleContext.set(new Uint8Array([mode]), 0);
    keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
    keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
    const psk = params.psk === undefined ? EMPTY : new Uint8Array(params.psk.key);
    const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk).buffer;
    const exporterSecretInfo = this._kdf.buildLabeledInfo(LABEL_EXP, keyScheduleContext, this._kdf.hashSize).buffer;
    const exporterSecret = await this._kdf.extractAndExpand(sharedSecret, ikm, exporterSecretInfo, this._kdf.hashSize);
    if (this._aead.id === AeadId.ExportOnly) {
      return { aead: this._aead, exporterSecret };
    }
    const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize).buffer;
    const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
    const baseNonceInfo = this._kdf.buildLabeledInfo(LABEL_BASE_NONCE, keyScheduleContext, this._aead.nonceSize).buffer;
    const baseNonce = await this._kdf.extractAndExpand(sharedSecret, ikm, baseNonceInfo, this._aead.nonceSize);
    return {
      aead: this._aead,
      exporterSecret,
      key,
      baseNonce: new Uint8Array(baseNonce),
      seq: 0
    };
  }
  async _keyScheduleS(mode, sharedSecret, enc, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === undefined) {
      return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
    }
    return new SenderContextImpl(this._api, this._kdf, res, enc);
  }
  async _keyScheduleR(mode, sharedSecret, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === undefined) {
      return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
    }
    return new RecipientContextImpl(this._api, this._kdf, res);
  }
  _validateInputLength(params) {
    if (params.info !== undefined && params.info.byteLength > INFO_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long info");
    }
    if (params.psk !== undefined) {
      if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
        throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
      }
      if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.key");
      }
      if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.id");
      }
    }
    return;
  }
}

// ../../node_modules/@hpke/core/esm/src/kems/dhkemNative.js
class DhkemP256HkdfSha256Native extends Dhkem {
  constructor() {
    const kdf = new HkdfSha256Native;
    const prim = new Ec(KemId.DhkemP256HkdfSha256, kdf);
    super(KemId.DhkemP256HkdfSha256, prim, kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemP256HkdfSha256
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
  }
}

// ../../node_modules/@hpke/core/esm/src/native.js
class CipherSuite extends CipherSuiteNative {
}

class DhkemP256HkdfSha256 extends DhkemP256HkdfSha256Native {
}
class HkdfSha256 extends HkdfSha256Native {
}
// src/internal/encoding.ts
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function arrayBufferToBase64(data) {
  return Buffer.from(data).toString("base64");
}
function base64ToArrayBuffer(base642) {
  const buf = Buffer.from(base642, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// src/wallet-import.ts
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
function decodeWalletPrivateKey(chain2, privateKey) {
  if (chain2 === "evm") {
    const hex2 = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (hex2.length === 0 || hex2.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex2)) {
      throw new Error('Invalid EVM private key: expected a hex string (optionally "0x"-prefixed)');
    }
    return Uint8Array.from(Buffer.from(hex2, "hex"));
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
  const base642 = arrayBufferToBase64(der);
  const lines = base642.match(/.{1,64}/g) ?? [base642];
  return `-----BEGIN ${label}-----
${lines.join(`
`)}
-----END ${label}-----
`;
}

// src/commands/wallets.ts
async function wallets(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const apiKey = await resolveApiKey(deps);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const embedded = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!embedded.ok) {
    writeFailure(deps, embedded, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const linked = await apiRequest("/api/v1/agent/wallets", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!linked.ok) {
    writeFailure(deps, linked, { apiUrl, authType: "key" }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ embedded: embedded.body, linked: linked.body })}
`);
    return 0;
  }
  const embeddedBody = embedded.body;
  const linkedBody = linked.body;
  deps.stdout.write(`Embedded (launch) wallets:
`);
  deps.stdout.write(`${renderTable(["Wallet", "Address", "Delegated", "Launches on"], [
    [
      "solana",
      embeddedBody.wallets.solana?.address ?? "none",
      embeddedBody.wallets.solana?.delegated ? "yes" : "no",
      "solana"
    ],
    [
      "evm",
      embeddedBody.wallets.evm?.address ?? "none",
      embeddedBody.wallets.evm?.delegated ? "yes" : "no",
      "hood"
    ]
  ])}
`);
  deps.stdout.write(`
Linked wallets:
`);
  if (linkedBody.page.length === 0) {
    deps.stdout.write(`(none)
`);
  } else {
    deps.stdout.write(`${renderTable(["Id", "Wallet", "Address", "Label", "Revoked"], linkedBody.page.map((wallet) => [
      wallet._id,
      wallet.chain,
      wallet.address,
      wallet.label ?? "-",
      wallet.revokedAt ? "yes" : "no"
    ]))}
`);
  }
  return 0;
}
async function resolveKeyMaterial(keyFile, chain2, ctx) {
  if (keyFile !== undefined) {
    try {
      return { ok: true, privateKey: (await ctx.deps.readFile(keyFile)).trim() };
    } catch (error) {
      return { ok: false, message: `Could not read --key-file: ${error instanceof Error ? error.message : error}` };
    }
  }
  try {
    const promptText = chain2 === "solana" ? "Solana private key (base58 or id.json contents; input hidden): " : "EVM private key (hex; input hidden): ";
    const entered = (await ctx.deps.promptSecret(promptText)).trim();
    if (entered.length === 0)
      return { ok: false, message: "No private key entered" };
    return { ok: true, privateKey: entered };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function resolveImportAddress(chain2, privateKey, addressFlag) {
  if (chain2 === "evm") {
    if (!addressFlag)
      return { ok: false, message: "--address is required for --chain evm" };
    return { ok: true, address: addressFlag };
  }
  let secret;
  try {
    secret = parseSolanaSecret(privateKey);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (secret.length !== 64) {
    return { ok: false, message: `Invalid Solana private key: expected 64 bytes, got ${secret.length}` };
  }
  const derived = base58.encode(secret.slice(32));
  if (addressFlag !== undefined && addressFlag !== derived) {
    return {
      ok: false,
      message: `--address does not match this private key (the key derives ${derived}). Refusing to import a mismatched pair.`
    };
  }
  return { ok: true, address: derived };
}
async function walletsImport(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {
    valueFlags: ["--chain", "--address", "--label", "--key-file", "--signer-out"]
  });
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json);
    return 2;
  }
  const chainFlag = parsed.values["--chain"];
  const chainValid = chainFlag === "solana" || chainFlag === "evm";
  const missing = [];
  if (!chainValid)
    missing.push("--chain <solana|evm>");
  if (chainFlag === "evm" && parsed.values["--address"] === undefined)
    missing.push("--address <0x...>");
  if (missing.length > 0) {
    deps.stderr.write(`Missing required: ${missing.join(", ")}
`);
    deps.stderr.write(`Example: candle wallets import --chain evm --address 0xYourWallet --api-url ${apiUrl}
`);
    return 2;
  }
  const chain2 = chainFlag;
  const material = await resolveKeyMaterial(parsed.values["--key-file"], chain2, ctx);
  if (!material.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: material.message }, json);
    return 1;
  }
  const resolvedAddress = resolveImportAddress(chain2, material.privateKey, parsed.values["--address"]);
  if (!resolvedAddress.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: resolvedAddress.message }, json);
    return 1;
  }
  const address = resolvedAddress.address;
  const apiKey = await resolveApiKey(deps);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const init = await apiRequest("/api/v1/agent/wallets/import/init", {
    method: "POST",
    body: { chain: chain2, address },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!init.ok) {
    writeFailure(deps, init, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const { encryptionPublicKey } = init.body;
  const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
    chain: chain2,
    privateKey: material.privateKey,
    encryptionPublicKey
  });
  const signer = await generateSignerKeypair();
  const submit = await apiRequest("/api/v1/agent/wallets/import/submit", {
    method: "POST",
    body: {
      chain: chain2,
      address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: signer.publicKeyDerBase64,
      ...parsed.values["--label"] !== undefined ? { label: parsed.values["--label"] } : {}
    },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!submit.ok) {
    writeFailure(deps, submit, { apiUrl, authType: "key" }, json);
    return 1;
  }
  const result = submit.body;
  await deps.store.set(walletSignerRef(result.id), pemToStoredSigner(signer.privateKeyPem));
  const signerOut = parsed.values["--signer-out"];
  if (signerOut !== undefined) {
    try {
      await deps.writeFile(signerOut, signer.privateKeyPem);
    } catch (error) {
      deps.stderr.write(`Warning: could not write --signer-out (${error instanceof Error ? error.message : error}); the signer is stored in the ${deps.backend} store
`);
    }
  }
  const verification = await verifyImportLanded({ id: result.id, apiKey, apiUrl, ctx });
  if (verification.status === "missing") {
    writeLocalFailure(deps, {
      code: "IMPORT_NOT_VISIBLE",
      message: `The server accepted the import (wallet id ${result.id}) but it is not on the account these ` + `credentials belong to${verification.account !== undefined ? ` (${verification.account})` : ""}. ` + `That usually means the CLI is logged in as a different Candle account than you expect. ` + `Run: candle doctor --api-url ${apiUrl}`
    }, json);
    return 1;
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      id: result.id,
      address: result.address,
      chain: result.chain,
      privyWalletId: result.privyWalletId,
      account: verification.account,
      apiUrl,
      signerStore: deps.backend,
      verified: verification.status === "verified",
      ...signerOut !== undefined ? { signerOut } : {}
    })}
`);
    return 0;
  }
  deps.stdout.write(`Imported ${result.chain} wallet ${result.address}
`);
  deps.stdout.write(`  Account:         ${verification.account ?? "unknown"} at ${apiUrl}
`);
  deps.stdout.write(`  Wallet id:       ${result.id}
`);
  deps.stdout.write(`  Privy wallet id: ${result.privyWalletId}
`);
  if (signerOut !== undefined) {
    deps.stdout.write(`  Signer key:      exported to ${signerOut} (and in the ${deps.backend} store)
`);
    deps.stdout.write(`Back up ${signerOut}: trades from this wallet sign with it, and it cannot be re-downloaded.
`);
  } else {
    deps.stdout.write(`  Signer key:      stored in your ${deps.backend} store; nothing to save by hand
`);
  }
  if (verification.status === "unchecked") {
    deps.stdout.write(`Note: could not read the wallet back to confirm which account it landed on. Run: candle wallets --api-url ${apiUrl}
`);
  }
  return 0;
}
async function verifyImportLanded(args) {
  const { deps } = args.ctx;
  const listed = await apiRequest("/api/v1/agent/wallets", {
    method: "GET",
    auth: "key",
    credentials: { apiKey: args.apiKey },
    apiUrl: args.apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!listed.ok)
    return { status: "unchecked" };
  const page = listed.body.page;
  if (!Array.isArray(page))
    return { status: "unchecked" };
  const account = page.find((row) => typeof row.userAddress === "string")?.userAddress;
  const found = page.some((row) => row._id === args.id);
  return { status: found ? "verified" : "missing", ...account !== undefined ? { account } : {} };
}
async function walletsRevoke(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json);
    return 2;
  }
  const [walletId, extra] = parsed.positionals;
  if (!walletId || extra !== undefined) {
    deps.stderr.write(`Usage: candle wallets revoke <wallet-id>
`);
    return 2;
  }
  const apiKey = await resolveApiKey(deps);
  if (!apiKey) {
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }, json);
    return 1;
  }
  const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(walletId)}`, {
    method: "DELETE",
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env
  });
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "key" }, json);
    return 1;
  }
  try {
    await deps.store.delete(walletSignerRef(walletId));
  } catch {}
  if (json) {
    deps.stdout.write(`${JSON.stringify({ revoked: walletId, ...result.body })}
`);
    return 0;
  }
  deps.stdout.write(`Revoked linked wallet ${walletId}
`);
  return 0;
}

// src/config.ts
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rm, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
function configDir2() {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join4(homedir3(), ".config", "candle");
}
function configFilePath() {
  return join4(configDir2(), "config.json");
}
async function readConfig() {
  try {
    const raw = await readFile2(configFilePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    throw err;
  }
}
async function writeConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  const dir = configDir2();
  await mkdir2(dir, { recursive: true });
  await chmod2(dir, 448);
  await writeFile2(configFilePath(), JSON.stringify(next, null, 2), "utf8");
}
async function clearConfig() {
  try {
    await rm(configFilePath());
  } catch (err) {
    if (err.code !== "ENOENT")
      throw err;
  }
}

// src/keychain.ts
import { spawn, spawnSync } from "node:child_process";
var SERVICE = "tv.candle.cli";
var PROBE_ACCOUNT = "tv.candle.cli.probe";
var UNSAFE_FOR_SECURITY_COMMAND_LINE = /["\\\n\r]/;
var RUN_TIMEOUT_MS = 1e4;
function run(bin, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled)
        return;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined)
      child.stdin.write(stdin);
    child.stdin.end();
  });
}
function binaryResolvable(bin) {
  return spawnSync("which", [bin], { env: process.env }).status === 0;
}

class KeychainSecretStore {
  binary;
  constructor(binary = "security") {
    this.binary = binary;
  }
  async get(ref) {
    const result = await run(this.binary, ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"]);
    if (result.status !== 0)
      return null;
    return result.stdout.replace(/\n$/, "");
  }
  async set(ref, value) {
    if (UNSAFE_FOR_SECURITY_COMMAND_LINE.test(value)) {
      throw new Error("Refusing to store this secret in the macOS Keychain: it contains a quote, backslash, or " + "newline, which could break out of the quoted argument on security's command-on-stdin line");
    }
    const command = `add-generic-password -U -s "${SERVICE}" -a "${ref}" -w "${value}"
`;
    const result = await run(this.binary, ["-i"], command);
    if (result.status !== 0) {
      throw new Error(`Failed to store credential in the macOS Keychain (security exited ${result.status})`);
    }
  }
  async delete(ref) {
    const command = `delete-generic-password -s "${SERVICE}" -a "${ref}"
`;
    await run(this.binary, ["-i"], command);
  }
}

class SecretToolSecretStore {
  binary;
  constructor(binary = "secret-tool") {
    this.binary = binary;
  }
  async get(ref) {
    const result = await run(this.binary, ["lookup", "service", SERVICE, "account", ref]);
    if (result.status !== 0)
      return null;
    const value = result.stdout.replace(/\n$/, "");
    return value.length > 0 ? value : null;
  }
  async set(ref, value) {
    const result = await run(this.binary, ["store", "--label=Candle CLI", "service", SERVICE, "account", ref], value);
    if (result.status !== 0) {
      throw new Error(`Failed to store credential via secret-tool (exited ${result.status})`);
    }
  }
  async delete(ref) {
    await run(this.binary, ["clear", "service", SERVICE, "account", ref]);
  }
}
async function probeSecretTool(store) {
  const probeValue = crypto.randomUUID();
  try {
    await store.set(PROBE_ACCOUNT, probeValue);
    const got = await store.get(PROBE_ACCOUNT);
    return got === probeValue;
  } catch {
    return false;
  } finally {
    try {
      await store.delete(PROBE_ACCOUNT);
    } catch {}
  }
}
async function resolveSecretStore(platform = process.platform) {
  if (platform === "darwin" && binaryResolvable("security")) {
    return { store: new KeychainSecretStore, backend: "keychain" };
  }
  if (platform === "linux" && binaryResolvable("secret-tool")) {
    const candidate = new SecretToolSecretStore;
    if (await probeSecretTool(candidate)) {
      return { store: candidate, backend: "secret-tool" };
    }
  }
  return { store: new EncryptedFileSecretStore, backend: "encrypted-file" };
}

// src/index.ts
function extractGlobalFlags(argv) {
  const rest = [];
  const flags = { json: false, help: false, version: false };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json")
      flags.json = true;
    else if (arg === "--help" || arg === "-h")
      flags.help = true;
    else if (arg === "--version" || arg === "-v")
      flags.version = true;
    else if (arg === "--api-url") {
      const value = argv[++i];
      if (value === undefined)
        return { error: "--api-url requires a value" };
      flags.apiUrl = value;
    } else if (arg?.startsWith("--api-url="))
      flags.apiUrl = arg.slice("--api-url=".length);
    else if (arg !== undefined)
      rest.push(arg);
  }
  return { rest, flags };
}
var HELP_TEXT = `candle: manage Candle agent credentials from the terminal

Usage: candle <command> [subcommand] [options]

Commands:
  auth login [--scopes <a,b,c>] [--label <name>] [--no-browser]   Authorize this device
  auth status                                                     Show credential status
  auth logout [--keep-key]                                        Clear local credentials
  keys list                                                       List API keys
  keys create [--scopes <a,b,c>] [--label <name>]                 Create an API key
              [--expires-in <days>] [--tx-limit <usd> [--reset daily|weekly|monthly|never]]
  keys revoke <prefix>                                            Revoke an API key
  wallets                                                         Show launch and linked wallets
  wallets import --chain <solana|evm> [options]                   Import a wallet you own (key via --key-file or hidden prompt)
  wallets revoke <wallet-id>                                      Revoke a linked wallet
  setup [--no-browser]                                            One wizard: authorize, fund, connect, verify
  mcp [--tools <a,b,c>] [--read-only] [--print-config]            Run the Candle MCP server with stored credentials
  doctor                                                          Diagnose CLI setup

Global options:
  --api-url <url>         Override the API base URL
  --json                  Machine-readable output
  --help, -h              Show this help
  --version, -v           Show the CLI version
`;
async function run2(argv, deps) {
  const extracted = extractGlobalFlags(argv);
  if ("error" in extracted) {
    deps.stderr.write(`${extracted.error}
`);
    return 2;
  }
  const { rest, flags } = extracted;
  if (flags.version) {
    deps.stdout.write(`${CLI_VERSION}
`);
    return 0;
  }
  if (flags.help) {
    deps.stdout.write(HELP_TEXT);
    return 0;
  }
  const tokens = rest[0] === "candle" ? rest.slice(1) : rest;
  const [cmd, sub, ...cmdArgs] = tokens;
  const config = await deps.readConfig();
  const apiUrl = flags.apiUrl ?? resolveApiUrl(config.apiUrl, deps.env);
  const ctx = { deps, json: flags.json, apiUrl, apiUrlFlag: flags.apiUrl };
  if (cmd === "auth") {
    if (sub === "login")
      return authLogin(cmdArgs, ctx);
    if (sub === "status")
      return authStatus(cmdArgs, ctx);
    if (sub === "logout")
      return authLogout(cmdArgs, ctx);
    return unknownCommand(deps, sub === undefined ? undefined : `auth ${sub}`);
  }
  if (cmd === "keys") {
    if (sub === "list")
      return keysList(cmdArgs, ctx);
    if (sub === "create")
      return keysCreate(cmdArgs, ctx);
    if (sub === "revoke")
      return keysRevoke(cmdArgs, ctx);
    return unknownCommand(deps, sub === undefined ? undefined : `keys ${sub}`);
  }
  if (cmd === "wallets") {
    if (sub === "import")
      return walletsImport(cmdArgs, ctx);
    if (sub === "revoke")
      return walletsRevoke(cmdArgs, ctx);
    return wallets(tokens.slice(1), ctx);
  }
  if (cmd === "doctor")
    return doctor(tokens.slice(1), ctx);
  if (cmd === "mcp")
    return mcp(tokens.slice(1), ctx);
  if (cmd === "setup")
    return setup(tokens.slice(1), ctx);
  return unknownCommand(deps, cmd);
}
function unknownCommand(deps, token) {
  if (token !== undefined)
    deps.stderr.write(`Unknown command: ${token}
`);
  deps.stderr.write(HELP_TEXT);
  return 1;
}
function realOpenBrowser(url) {
  try {
    const platform = process.platform;
    const child = platform === "darwin" ? spawn2("open", [url], { stdio: "ignore", detached: true }) : platform === "win32" ? spawn2("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }) : spawn2("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
async function buildRealDeps() {
  const { store, backend } = await resolveSecretStore();
  return {
    fetch: globalThis.fetch,
    store,
    backend,
    readConfig,
    writeConfig,
    clearConfig,
    stdout: {
      write: (chunk) => {
        process.stdout.write(chunk);
      }
    },
    stderr: {
      write: (chunk) => {
        process.stderr.write(chunk);
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: realOpenBrowser,
    env: process.env,
    nodeVersion: process.versions.node,
    hostname: hostname(),
    runChild: (command, args, env) => new Promise((resolve) => {
      const child = spawn2(command, args, {
        stdio: "inherit",
        env,
        shell: process.platform === "win32"
      });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    }),
    readFile: (path) => readFile3(path, "utf8"),
    writeFile: (path, content) => writeFile3(path, content, { mode: 384 }),
    promptSecret: promptHiddenSecret
  };
}
async function main() {
  const deps = await buildRealDeps();
  const code = await run2(process.argv.slice(2), deps);
  process.exit(code);
}
function entryHref(argv1) {
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
}
var isMainModule = process.argv[1] !== undefined && import.meta.url === entryHref(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  });
}
export {
  run2 as run
};
