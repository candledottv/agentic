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
import { fetchAccount } from "../account"
import { parseArgs, parseScopesList } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import {
  credentialEnvOverrides,
  defaultProfileNameFor,
  effectiveProfileFields,
  identityLine,
  isValidProfileName,
  printIdentity,
  profileSecretRef,
} from "../profiles"
import {
  ALL_AGENT_SCOPES,
  formatScopesForSummary,
  portalDeviceUrl,
  renderTable,
  writeFailure,
  writeUsageFailure,
} from "../render"
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
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  // `--profile` here names a profile to CREATE (or re-authenticate), not one to select, so it is
  // validated for shape only -- never checked against what already exists (see finishLogin).
  if (ctx.profileFlag !== undefined && !isValidProfileName(ctx.profileFlag)) {
    writeUsageFailure(deps, `Invalid profile name: ${ctx.profileFlag}. Run: candle auth login --profile <name>`, json)
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
    writeFailure(deps, codeResult, { apiUrl, authType: "none" }, json)
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
    writeFailure(deps, tokenResult, { apiUrl, authType: "none" }, json)
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
  const { deps, json } = ctx
  const body = rawBody as DeviceTokenSuccessResponse

  // Every login names a profile: `--profile` when given, else the one this invocation already
  // resolved to (dispatch resolves leniently for login -- see index.ts), else one derived from
  // the host (`defaultProfileNameFor`). Only that last case is a NEW profile; the middle case is
  // a re-authentication, and it updates the existing entry in place, secrets overwritten under
  // the same refs. There is no flat, profile-less write anymore -- the legacy
  // SECRET_REFS/top-level-config shape is read-only from here on, kept only for migration and
  // rollback.
  const config = await deps.readConfig()
  const profileName = ctx.profileFlag ?? ctx.profile ?? defaultProfileNameFor(ctx.apiUrl, config.profiles)
  await deps.store.set(profileSecretRef(profileName, "deviceToken"), body.deviceToken)
  if (body.apiKey) await deps.store.set(profileSecretRef(profileName, "apiKey"), body.apiKey.key)

  // WHICH account this profile acts as, cached for the identity line (and Phase 2's guard). The
  // account's username, when it has one, is cached beside it so the line can name the handle.
  // Best-effort: an unreachable API must not fail a login that already succeeded.
  let account: string | undefined
  let username: string | undefined
  if (body.apiKey) {
    const lookup = await fetchAccount(deps, ctx.apiUrl, body.apiKey.key)
    account = lookup.account
    username = lookup.username
  }

  // `scopes` is only ever persisted (and only ever reported as "Granted") when a key actually
  // exists to describe. On the provisioning-failure path (body.apiKey null) there is no key, so
  // there is nothing scopes could correctly describe -- persisting the device's REQUESTED scopes
  // there would have `doctor` later report them against whatever DIFFERENT key eventually gets
  // created (fix round 1, item 4).
  const portalOrigin = portalOriginFrom(requested.verificationUri)
  await deps.updateProfile(profileName, {
    apiUrl: ctx.apiUrl,
    deviceTokenPrefix: body.tokenPrefix,
    ...(body.apiKey ? { keyPrefix: body.apiKey.keyPrefix, scopes: body.apiKey.scopes } : {}),
    ...(requested.label ? { label: requested.label } : {}),
    ...(portalOrigin ? { portalOrigin } : {}),
    // `username` is written unconditionally inside the account branch, live value and all: when the
    // account has since removed its handle the live value is undefined, and updateProfile's write
    // JSON.stringifies, which drops an undefined key -- so the stale cached handle is cleared rather
    // than kept. Mirrors profileUse's refresh.
    ...(account ? { account, accountCachedAt: deps.now(), username } : {}),
  })
  // The FIRST profile ever created on this machine becomes active; a second `auth login` (a
  // different `--profile`, or re-authenticating the same one) never steals that from the one
  // already selected.
  if (!config.activeProfile) await deps.writeConfig({ activeProfile: profileName })

  if (json) {
    // Deliberately NOT the raw response: it carries the plaintext deviceToken and (when present)
    // the plaintext apiKey.key. Login never displays either plaintext value, in either render
    // mode -- they are stored directly, and the CLI doesn't need the user to see or copy them
    // (unlike `keys create`, which is documented to show a plaintext key exactly once).
    deps.stdout.write(
      `${JSON.stringify({
        backend: deps.backend,
        profile: profileName,
        account,
        deviceTokenPrefix: body.tokenPrefix,
        apiKeyPrefix: body.apiKey?.keyPrefix,
        scopes: body.apiKey?.scopes,
        apiKeyError: body.apiKeyError,
      })}\n`,
    )
    return 0
  }

  deps.stdout.write(`Profile: ${profileName}\n`)
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
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  const keepKey = parsed.booleans.has("--keep-key")

  // Ahead of acting, like every other authenticated command: this one REMOVES an identity, so
  // "which one" is the fact most worth having on screen before the lines describing what is gone.
  await printIdentity(ctx)

  const config = await deps.readConfig()
  // In profile mode these come from the profile's own fields, not the (unused, legacy) top-level
  // ones -- a second profile's key prefix must never leak into a different profile's logout.
  const { keyPrefix, portalOrigin } = effectiveProfileFields(config, ctx.profile)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)

  let revokedKey: string | undefined
  if (!keepKey && deviceToken && keyPrefix) {
    const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}`, {
      method: "DELETE",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (result.ok) {
      revokedKey = keyPrefix
    } else if (!json) {
      deps.stdout.write("Could not revoke the stored API key remotely (clearing it locally anyway).\n")
    }
  }

  if (ctx.profile) {
    // Only THIS profile's two namespaced refs and entry -- a sibling PROFILE is untouched.
    await deps.store.delete(profileSecretRef(ctx.profile, "deviceToken"))
    await deps.store.delete(profileSecretRef(ctx.profile, "apiKey"))
    // The legacy refs and top-level prefixes go too. Migration COPIES the pre-profile secrets
    // rather than moving them, so sparing them here left the device token this logout just
    // revoked its key with sitting in the store, live: with the profile entry gone,
    // `resolveDeviceToken` falls straight back to `SECRET_REFS.deviceToken` and the next command
    // keeps acting as the account the operator believes they signed out of. "Local credentials
    // cleared." has to be true of the whole store, not of one namespace within it.
    await deps.store.delete(SECRET_REFS.deviceToken)
    await deps.store.delete(SECRET_REFS.apiKey)
    const profiles = { ...(config.profiles ?? {}) }
    delete profiles[ctx.profile]
    await deps.writeConfig({
      profiles,
      keyPrefix: undefined,
      deviceTokenPrefix: undefined,
      scopes: undefined,
      ...(config.activeProfile === ctx.profile ? { activeProfile: undefined } : {}),
    })
  } else {
    // Pre-profile mode: today's behavior, unchanged.
    await deps.store.delete(SECRET_REFS.deviceToken)
    await deps.store.delete(SECRET_REFS.apiKey)
    await deps.clearConfig()
  }

  // Read from state captured BEFORE the mutations above: the stored portal origin is exactly
  // what makes this pointer right on a non-default backend, and it is gone by this line.
  const portalUrl = portalDeviceUrl(apiUrl, portalOrigin)

  // Clearing the store does not clear the shell. Either env var still set means a live credential
  // survives this logout, which "Local credentials cleared." on its own would misrepresent. Same
  // set the identity line names, read through the same helper.
  const liveEnvOverrides = credentialEnvOverrides(deps.env)

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
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const config = await deps.readConfig()
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  const apiKey = await resolveApiKey(deps, ctx.profile)

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

  // WHICH account these credentials act as, not just whether they are valid. On 2026-08-19 this
  // command reported both checks PASS while an EVM wallet import had landed on a different
  // account than the operator believed, and resolving it took a database query. A valid
  // credential for the wrong account is the failure this command is reached for, so it has to be
  // on screen. Best-effort: an unreachable API must not turn a credential report into a failure.
  let account: string | undefined
  let username: string | undefined
  if (apiKey) {
    const lookup = await fetchAccount(deps, apiUrl, apiKey)
    account = lookup.account
    username = lookup.username
  }

  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0
  const configPath = configFilePathForDisplay(deps.env)
  // The profile's own recorded prefixes (or the legacy top-level ones pre-profile). Reading the
  // top-level fields unconditionally reported "not set" for both on every profile created since
  // the upgrade, which is precisely the question this command is run to answer.
  const fields = effectiveProfileFields(config, ctx.profile)
  // Both names, whenever they disagree. The live account alone reads as "fine" to an operator who
  // never doubted which account they were on; the mismatch is only visible once the profile's own
  // record is beside it. `cachedAccount` is reported only when a profile is resolved, since
  // without one there is no record to disagree with.
  //
  // NOT under a credential env override, though, and for the reason the guard skips there: the
  // live answer then comes from CANDLE_API_KEY's key, not the profile's stored one, so the two
  // names differing is expected rather than wrong -- and the repair this line offers,
  // `profile use`, re-caches from the stored key that was never acting. The `cachedAccount` field
  // is unconditional; only the sentence and its suggestion are gated.
  const cachedAccount = ctx.profile !== undefined ? fields.account : undefined
  const mismatch =
    ctx.profile !== undefined &&
    account !== undefined &&
    cachedAccount !== undefined &&
    account !== cachedAccount &&
    credentialEnvOverrides(deps.env).length === 0

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        backend: deps.backend,
        profile: ctx.profile,
        deviceTokenPrefix: fields.deviceTokenPrefix,
        keyPrefix: fields.keyPrefix,
        account,
        cachedAccount,
        apiUrl,
        configPath,
        rows,
      })}\n`,
    )
    return exitCode
  }

  // The identity line first: it is the fact most likely to be wrong, and the one nothing else
  // reveals. Falls back to the profile's cached account when the live lookup above didn't run or
  // didn't answer (no API key, or an unreachable API) -- see identityLine's own doc comment for
  // why an absent value is still named rather than omitted.
  // Account and username are paired from the SAME source: when the live lookup named an account,
  // its username (or none) is shown beside it; only when falling back to the cached account is the
  // cached username used. Mixing them -- a live account with a cached handle -- would print a
  // handle that belongs to a DIFFERENT account, in the very command meant to reveal a mismatch.
  const shownAccount = account ?? fields.account
  const shownUsername = account !== undefined ? username : fields.username
  deps.stdout.write(`${identityLine(ctx.profile, shownAccount, apiUrl, undefined, shownUsername)}\n`)
  // `profile use` is the cheapest of the three repairs (it re-caches the account from this very
  // key); the guard's own refusal names the other two, which cost a re-authentication or a skipped
  // check. This line is a report, not a refusal, so it names only the cheap one.
  if (mismatch) {
    deps.stdout.write(
      `Profile ${ctx.profile} recorded ${cachedAccount}; this key belongs to ${account}. Run: candle profile use ${ctx.profile}\n`,
    )
  }
  deps.stdout.write(`Backend: ${deps.backend}\n`)
  deps.stdout.write(`Device token prefix: ${fields.deviceTokenPrefix ?? "not set"}\n`)
  deps.stdout.write(`API key prefix: ${fields.keyPrefix ?? "not set"}\n`)
  deps.stdout.write(`Config file: ${configPath}\n\n`)
  deps.stdout.write(
    `${renderTable(
      ["Check", "Status", "Detail"],
      rows.map((row) => [row.check, row.state, row.detail]),
    )}\n`,
  )
  return exitCode
}
