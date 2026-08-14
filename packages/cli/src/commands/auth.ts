/**
 * `auth login` / `auth status` / `auth logout`.
 *
 * `auth login`'s binding sequence (task-3-brief.md Step 4):
 *   1. POST /device/code, clientName = label ?? `candle-cli/<version>@<hostname>`, capped at the
 *      server's 64 characters (see MAX_CLIENT_NAME_LENGTH), scopes omitted unless --scopes was
 *      given (omitted = the server's all-four default).
 *   2. Print the user code and verificationUriComplete; unless --no-browser, best-effort open the
 *      browser; the URL is ALWAYS printed too, for SSH sessions. In `--json` mode these two
 *      progress lines go to stderr instead of stdout, so stdout stays exactly one parseable JSON
 *      value (fix round 1, item 1).
 *   3. Poll POST /device/token every `interval` seconds. authorization_pending keeps going;
 *      slow_down bumps the interval by 5s and keeps going; access_denied / expired_token /
 *      invalid_grant each end the flow with a distinct message and exit 1. Stops at expiresIn
 *      regardless of server behavior.
 *   4. On success: store both credentials, write config (including the portal origin taken from
 *      the device-code response's own verificationUri, so `auth logout` can point at the right
 *      portal on any backend), print backend + prefixes + scopes (swap:write called out
 *      explicitly when granted).
 *   5. apiKey:null + apiKeyError is NOT a failure: store the device token, print the reason and
 *      point at `candle keys create` (the API's own best-effort contract for this case). No key
 *      exists yet on this path, so nothing is "Granted": the summary shows what scopes the
 *      DEVICE authorized (informational only), and config.scopes is left unset rather than
 *      persisting a value that describes a key that was never issued (fix round 1, item 4).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs, parseScopesList } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { ALL_AGENT_SCOPES, formatScopesForSummary, portalDeviceUrl, renderTable, writeFailure } from "../render"
import { SECRET_REFS } from "../secret-store"
import { CLI_VERSION } from "../version"

const DEVICE_CODE_PATH = "/api/v1/agent/device/code"
const DEVICE_TOKEN_PATH = "/api/v1/agent/device/token"

/**
 * `POST /device/code` validates `clientName` at 64 characters against the RAW string, BEFORE it
 * sanitizes (agent-device.ts), so the cap has to be honored here or the very first command a user
 * ever runs fails with a validation error that never mentions `--label`. The default name embeds
 * the machine's hostname, which is unbounded in practice, so it is truncated; an explicit
 * `--label` is rejected up front instead, naming both the limit and the flag, because silently
 * truncating a name the user chose would put a different label than they typed on the approval
 * screen and on every `device/tokens` listing afterwards.
 */
const MAX_CLIENT_NAME_LENGTH = 64

interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

interface DeviceTokenSuccessResponse {
  deviceToken: string
  tokenPrefix: string
  apiKey: { key: string; keyPrefix: string; scopes: string[] } | null
  apiKeyError?: string
}

export async function authLogin(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--scopes", "--label"], booleanFlags: ["--no-browser"] })
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }
  const scopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined
  const label = parsed.values["--label"]
  const noBrowser = parsed.booleans.has("--no-browser")

  if (label !== undefined && label.length > MAX_CLIENT_NAME_LENGTH) {
    deps.stderr.write(
      `--label must be at most ${MAX_CLIENT_NAME_LENGTH} characters (got ${label.length}). Shorten it and run: candle auth login --label <name>\n`,
    )
    return 2
  }

  // See MAX_CLIENT_NAME_LENGTH: the default embeds an unbounded hostname, so it is truncated
  // rather than allowed to fail the request. `--label` is already known to fit by this point.
  const clientName = (label ?? `candle-cli/${CLI_VERSION}@${deps.hostname}`).slice(0, MAX_CLIENT_NAME_LENGTH)
  const codeResult = await apiRequest(DEVICE_CODE_PATH, {
    method: "POST",
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: { clientName, ...(scopes ? { scopes } : {}) },
  })

  if (!codeResult.ok) {
    writeFailure(deps.stderr, codeResult, { apiUrl, authType: "none" }, json)
    return 1
  }

  const code = codeResult.body as DeviceCodeResponse

  // These two lines are progress information, not the command's result -- in --json mode they
  // go to stderr so stdout stays exactly one parseable JSON value (fix round 1, item 1).
  const progress = json ? deps.stderr : deps.stdout
  progress.write(`Your device code: ${code.userCode}\n`)
  progress.write(`Open this URL to approve: ${code.verificationUriComplete}\n`)
  if (!noBrowser) {
    try {
      deps.openBrowser(code.verificationUriComplete)
    } catch {
      // Best-effort only: the URL is already printed above for exactly this case (no browser
      // launcher available, e.g. an SSH session).
    }
  }

  const expiresAtMs = deps.now() + code.expiresIn * 1000
  let interval = code.interval

  while (deps.now() < expiresAtMs) {
    await deps.sleep(interval * 1000)

    const tokenResult = await apiRequest(DEVICE_TOKEN_PATH, {
      method: "POST",
      auth: "none",
      credentials: {},
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
      body: { deviceCode: code.deviceCode },
    })

    if (tokenResult.ok) {
      return finishLogin(tokenResult.body, ctx, { scopes, label, verificationUri: code.verificationUri })
    }

    if (tokenResult.rfcError === "authorization_pending") continue
    if (tokenResult.rfcError === "slow_down") {
      interval += 5
      continue
    }
    if (
      tokenResult.rfcError === "access_denied" ||
      tokenResult.rfcError === "expired_token" ||
      tokenResult.rfcError === "invalid_grant"
    ) {
      if (json) deps.stderr.write(`${JSON.stringify(tokenResult)}\n`)
      else deps.stderr.write(`${terminalRfcMessage(tokenResult.rfcError)}\n`)
      return 1
    }

    // Anything else during polling is unexpected (not part of the RFC vocabulary this endpoint
    // uses) -- surface it and stop, rather than looping forever on an error class not named above.
    writeFailure(deps.stderr, tokenResult, { apiUrl, authType: "none" }, json)
    return 1
  }

  if (json) deps.stderr.write(`${JSON.stringify({ ok: false, reason: "expired_token" })}\n`)
  else deps.stderr.write(`${terminalRfcMessage("expired_token")}\n`)
  return 1
}

function terminalRfcMessage(rfcError: "access_denied" | "expired_token" | "invalid_grant"): string {
  if (rfcError === "access_denied") return "Authorization was denied."
  if (rfcError === "expired_token") return "The device code expired before it was approved. Run: candle auth login"
  return "This device code is unknown or was already used. Run: candle auth login"
}

/** The portal origin to persist, taken from the device-code response's own `verificationUri` (the
 * API computes it from its `FRONTEND_URL`, so it names the real portal for whatever backend was
 * just used). Origin only: the path is the API's device-approval screen, not the device-management
 * screen `auth logout` points at. Unparseable means the server sent something unexpected, which is
 * not worth failing a successful login over -- storing nothing just leaves logout on its fallback
 * derivation. */
function portalOriginFrom(verificationUri: string | undefined): string | undefined {
  if (!verificationUri) return undefined
  try {
    return new URL(verificationUri).origin
  } catch {
    return undefined
  }
}

async function finishLogin(
  rawBody: unknown,
  ctx: CommandContext,
  requested: { scopes?: string[]; label?: string; verificationUri?: string },
): Promise<number> {
  const { deps, json, apiUrlFlag } = ctx
  const body = rawBody as DeviceTokenSuccessResponse

  await deps.store.set(SECRET_REFS.deviceToken, body.deviceToken)
  if (body.apiKey) {
    await deps.store.set(SECRET_REFS.apiKey, body.apiKey.key)
  }

  // `scopes` is only ever persisted (and only ever reported as "Granted") when a key actually
  // exists to describe. On the provisioning-failure path (body.apiKey null) there is no key, so
  // there is nothing scopes could correctly describe -- persisting the device's REQUESTED scopes
  // there would have `doctor` later report them against whatever DIFFERENT key eventually gets
  // created (fix round 1, item 4).
  const portalOrigin = portalOriginFrom(requested.verificationUri)
  await deps.writeConfig({
    deviceTokenPrefix: body.tokenPrefix,
    ...(body.apiKey ? { keyPrefix: body.apiKey.keyPrefix, scopes: body.apiKey.scopes } : {}),
    ...(requested.label ? { label: requested.label } : {}),
    ...(apiUrlFlag ? { apiUrl: apiUrlFlag } : {}),
    ...(portalOrigin ? { portalOrigin } : {}),
  })

  if (json) {
    // Deliberately NOT the raw response: it carries the plaintext deviceToken and (when present)
    // the plaintext apiKey.key. Login never displays either plaintext value, in either render
    // mode -- they are stored directly, and the CLI doesn't need the user to see or copy them
    // (unlike `keys create`, which is documented to show a plaintext key exactly once).
    deps.stdout.write(
      `${JSON.stringify({
        backend: deps.backend,
        deviceTokenPrefix: body.tokenPrefix,
        apiKeyPrefix: body.apiKey?.keyPrefix,
        scopes: body.apiKey?.scopes,
        apiKeyError: body.apiKeyError,
      })}\n`,
    )
    return 0
  }

  deps.stdout.write(`Device authorized. Credentials stored in the ${deps.backend} backend.\n`)
  deps.stdout.write(`Device token prefix: ${body.tokenPrefix}\n`)
  if (body.apiKey) {
    deps.stdout.write(`API key prefix: ${body.apiKey.keyPrefix}\n`)
    deps.stdout.write(`Granted scopes: ${formatScopesForSummary(body.apiKey.scopes)}\n`)
  } else if (body.apiKeyError) {
    const authorizedScopes = requested.scopes ?? [...ALL_AGENT_SCOPES]
    deps.stdout.write(`Authorized scopes (no key issued yet): ${formatScopesForSummary(authorizedScopes)}\n`)
    deps.stdout.write(`${body.apiKeyError}\n`)
    deps.stdout.write("Run: candle keys create\n")
  }
  return 0
}

export async function authLogout(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--keep-key"] })
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }
  const keepKey = parsed.booleans.has("--keep-key")

  const config = await deps.readConfig()
  const deviceToken = await resolveDeviceToken(deps)

  let revokedKey: string | undefined
  if (!keepKey && deviceToken && config.keyPrefix) {
    const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(config.keyPrefix)}`, {
      method: "DELETE",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (result.ok) {
      revokedKey = config.keyPrefix
    } else if (!json) {
      deps.stdout.write("Could not revoke the stored API key remotely (clearing it locally anyway).\n")
    }
  }

  await deps.store.delete(SECRET_REFS.deviceToken)
  await deps.store.delete(SECRET_REFS.apiKey)
  await deps.clearConfig()

  // Read from the config captured BEFORE the clear above: the stored portal origin is exactly
  // what makes this pointer right on a non-default backend, and it is gone by this line.
  const portalUrl = portalDeviceUrl(apiUrl, config.portalOrigin)

  // Clearing the store does not clear the shell. Either env var still set means a live credential
  // survives this logout, which "Local credentials cleared." on its own would misrepresent.
  const liveEnvOverrides = ["CANDLE_DEVICE_TOKEN", "CANDLE_API_KEY"].filter((name) => deps.env[name]?.trim())

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({ success: true, revokedKey: revokedKey ?? null, portalUrl, envOverrides: liveEnvOverrides })}\n`,
    )
    return 0
  }

  deps.stdout.write("Local credentials cleared.\n")
  if (liveEnvOverrides.length > 0) {
    deps.stdout.write(
      `Still set in this shell: ${liveEnvOverrides.join(", ")}. Those beat the store, so they remain live until you unset them.\n`,
    )
  }
  deps.stdout.write(
    "The device token itself is session-only to revoke -- that is intentional (a stolen token cannot read device metadata or revoke a sibling device). Sign in to the portal to revoke it there.\n",
  )
  deps.stdout.write(`Portal: ${portalUrl}\n`)
  return 0
}

/** Mirrors `config.ts`'s own `configDir()`/`configFilePath()` resolution (see that file's header
 * comment for why each module keeps this self-contained rather than importing it) -- sourced from
 * `deps.env` rather than `process.env` directly so it stays fully injectable in tests. */
function configFilePathForDisplay(env: Record<string, string | undefined>): string {
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle")
  return join(dir, "config.json")
}

export async function authStatus(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }

  const config = await deps.readConfig()
  const deviceToken = await resolveDeviceToken(deps)
  const apiKey = await resolveApiKey(deps)

  const rows: CheckRow[] = []

  // Sequential, not concurrent (task-3-brief.md's design decisions): the two live checks run one
  // after the other.
  if (!deviceToken) {
    rows.push({ check: "Device token", state: "SKIP", detail: "not set. Run: candle auth login" })
  } else {
    rows.push(
      await runLiveCheck({
        deps,
        apiUrl,
        path: "/api/v1/agent/keys",
        auth: "device",
        credential: deviceToken,
        check: "Device token",
        passDetail: "valid",
      }),
    )
  }

  if (!apiKey) {
    rows.push({ check: "API key", state: "SKIP", detail: "not set. Run: candle keys create" })
  } else {
    rows.push(
      await runLiveCheck({
        deps,
        apiUrl,
        path: "/api/v1/agent/tier",
        auth: "key",
        credential: apiKey,
        check: "API key",
        passDetail: "valid",
      }),
    )
  }

  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0
  const configPath = configFilePathForDisplay(deps.env)

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        backend: deps.backend,
        deviceTokenPrefix: config.deviceTokenPrefix,
        keyPrefix: config.keyPrefix,
        configPath,
        rows,
      })}\n`,
    )
    return exitCode
  }

  deps.stdout.write(`Backend: ${deps.backend}\n`)
  deps.stdout.write(`Device token prefix: ${config.deviceTokenPrefix ?? "not set"}\n`)
  deps.stdout.write(`API key prefix: ${config.keyPrefix ?? "not set"}\n`)
  deps.stdout.write(`Config file: ${configPath}\n\n`)
  deps.stdout.write(
    `${renderTable(
      ["Check", "Status", "Detail"],
      rows.map((row) => [row.check, row.state, row.detail]),
    )}\n`,
  )
  return exitCode
}
