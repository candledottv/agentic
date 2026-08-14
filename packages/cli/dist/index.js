#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { spawn as spawn2 } from "node:child_process";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

// src/client.ts
var DEFAULT_API_URL = "https://api.candle.tv";
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
      return { code, message };
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

// src/render.ts
var ALL_AGENT_SCOPES = ["launch:write", "launch:read", "activity:write", "swap:write"];
var DEFAULT_AGENT_SCOPES = ALL_AGENT_SCOPES.filter((scope) => scope !== "swap:write");
var SWAP_WRITE_NOTE = "moves funds -- this key can execute swaps on your behalf";
function formatScopesForSummary(scopes) {
  return scopes.map((scope) => scope === "swap:write" ? `${scope} (${SWAP_WRITE_NOTE})` : scope).join(", ");
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
function writeFailure(writer, result, ctx, json) {
  writer.write(json ? `${JSON.stringify(result)}
` : `${renderError(result, ctx)}
`);
}
function writeLocalFailure(writer, failure, json) {
  writer.write(json ? `${JSON.stringify({ ok: false, ...failure })}
` : `${failure.message}
`);
}
function portalDeviceUrl(apiUrl, portalOrigin) {
  if (portalOrigin) {
    try {
      return `${new URL(portalOrigin).origin}/dev/agent`;
    } catch {}
  }
  if (apiUrl === DEFAULT_API_URL)
    return "https://candle.tv/dev/agent";
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
var CLI_VERSION = "0.1.0";

// src/commands/auth.ts
var DEVICE_CODE_PATH = "/api/v1/agent/device/code";
var DEVICE_TOKEN_PATH = "/api/v1/agent/device/token";
var MAX_CLIENT_NAME_LENGTH = 64;
async function authLogin(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, { valueFlags: ["--scopes", "--label"], booleanFlags: ["--no-browser"] });
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
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
    writeFailure(deps.stderr, codeResult, { apiUrl, authType: "none" }, json);
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
    writeFailure(deps.stderr, tokenResult, { apiUrl, authType: "none" }, json);
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
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
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
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
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
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  const configPath = configFilePathForDisplay(deps.env);
  if (json) {
    deps.stdout.write(`${JSON.stringify({
      backend: deps.backend,
      deviceTokenPrefix: config.deviceTokenPrefix,
      keyPrefix: config.keyPrefix,
      configPath,
      rows
    })}
`);
    return exitCode;
  }
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
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
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
      const delegated = Boolean(body.wallets.solana?.delegated || body.wallets.evm?.delegated);
      rows.push(delegated ? { check: "Launch wallet delegated", state: "PASS", detail: "delegated" } : {
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: "No launch wallet is delegated. Fix: delegate one in the portal."
      });
    }
  }
  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0;
  if (json) {
    deps.stdout.write(`${JSON.stringify({ rows })}
`);
    return exitCode;
  }
  deps.stdout.write(`${renderTable(["Check", "Status", "Detail"], rows.map((row) => [row.check, row.state, row.detail]))}
`);
  return exitCode;
}

// src/commands/keys.ts
var KEYS_PATH = "/api/v1/agent/keys";
var NO_DEVICE_TOKEN = { code: "NO_DEVICE_TOKEN", message: "No device token available. Run: candle auth login" };
function mintedByLabel(mintedBy, ownDeviceTokenPrefix) {
  if (!mintedBy)
    return "unknown";
  if (mintedBy === ownDeviceTokenPrefix)
    return "this device";
  return mintedBy;
}
async function keysList(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
    return 2;
  }
  const deviceToken = await resolveDeviceToken(deps);
  if (!deviceToken) {
    writeLocalFailure(deps.stderr, NO_DEVICE_TOKEN, json);
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
    writeFailure(deps.stderr, result, { apiUrl, authType: "device" }, json);
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
  const parsed = parseArgs(args, { valueFlags: ["--scopes", "--environment"] });
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
    return 2;
  }
  const requestedScopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined;
  const environment = parsed.values["--environment"];
  const deviceToken = await resolveDeviceToken(deps);
  if (!deviceToken) {
    writeLocalFailure(deps.stderr, NO_DEVICE_TOKEN, json);
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
      ...environment ? { environment } : {}
    }
  });
  if (!result.ok) {
    writeFailure(deps.stderr, result, { apiUrl, authType: "device" }, json);
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
    deps.stderr.write(`${parsed.error}
`);
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
    writeLocalFailure(deps.stderr, NO_DEVICE_TOKEN, json);
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
    writeFailure(deps.stderr, result, { apiUrl, authType: "device" }, json);
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

// src/commands/wallets.ts
async function wallets(args, ctx) {
  const { deps, apiUrl, json } = ctx;
  const parsed = parseArgs(args, {});
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}
`);
    return 2;
  }
  const apiKey = await resolveApiKey(deps);
  if (!apiKey) {
    writeLocalFailure(deps.stderr, { code: "NO_API_KEY", message: "No API key available. Run: candle keys create" }, json);
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
    writeFailure(deps.stderr, embedded, { apiUrl, authType: "key" }, json);
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
    writeFailure(deps.stderr, linked, { apiUrl, authType: "key" }, json);
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
  deps.stdout.write(`${renderTable(["Chain", "Address", "Delegated"], [
    [
      "solana",
      embeddedBody.wallets.solana?.address ?? "none",
      embeddedBody.wallets.solana?.delegated ? "yes" : "no"
    ],
    ["evm", embeddedBody.wallets.evm?.address ?? "none", embeddedBody.wallets.evm?.delegated ? "yes" : "no"]
  ])}
`);
  deps.stdout.write(`
Linked wallets:
`);
  if (linkedBody.page.length === 0) {
    deps.stdout.write(`(none)
`);
  } else {
    deps.stdout.write(`${renderTable(["Chain", "Address", "Label", "Revoked"], linkedBody.page.map((wallet) => [
      wallet.chain,
      wallet.address,
      wallet.label ?? "-",
      wallet.revokedAt ? "yes" : "no"
    ]))}
`);
  }
  return 0;
}

// src/config.ts
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rm, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
function configDir2() {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join3(homedir3(), ".config", "candle");
}
function configFilePath() {
  return join3(configDir2(), "config.json");
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
  keys create [--scopes <a,b,c>] [--environment production|test]  Create an API key
  keys revoke <prefix>                                            Revoke an API key
  wallets                                                         Show launch and linked wallets
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
  if (cmd === "wallets")
    return wallets(tokens.slice(1), ctx);
  if (cmd === "doctor")
    return doctor(tokens.slice(1), ctx);
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
    hostname: hostname()
  };
}
async function main() {
  const deps = await buildRealDeps();
  const code = await run2(process.argv.slice(2), deps);
  process.exit(code);
}
var isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
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
