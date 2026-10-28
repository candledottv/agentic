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
 *   5. `--label` names the minted key as well as the device: after credentials are stored, one
 *      best-effort `PATCH /keys/<prefix> { label }` over the new device token. A failed rename
 *      never fails the login (keys list Access and Name spec, 2026-09-23, D7).
 *   6. apiKey:null + apiKeyError is NOT a failure: store the device token, print the reason and
 *      point at `candle keys create` (the API's own best-effort contract for this case). No key
 *      exists yet on this path, so nothing is "Granted": the summary shows what scopes the
 *      DEVICE authorized (informational only), and config.scopes is left unset rather than
 *      persisting a value that describes a key that was never issued (fix round 1, item 4).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { fetchAccount } from "../account"
import { scopesForPreset } from "../agent-key-access"
import { parseArgs, parseScopesList } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest, insecureApiUrlFault } from "../client"
import { ProfileCoreOwnedError } from "../core/ownership"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { writeFields, writeSuccess } from "../human-output"
import { fields, heading, notice, success, symbols, terminalStyle } from "../presentation"
import {
  credentialEnvOverrides,
  defaultProfileNameFor,
  effectiveProfileFields,
  identityLine,
  identityStyle,
  isValidProfileName,
  PRE_PROFILE_FIELDS,
  printIdentity,
  profileSecretRef,
} from "../profiles"
import { portalDevicesUrl, writeUsageFailure } from "../render"
import { SECRET_REFS } from "../secret-store"
import { CLI_VERSION } from "../version"
import {
  embeddedWalletSummary,
  scopeSummary,
  writeScreenFailure,
  writeScreenMessage,
  writeScreenUsageFailure,
} from "./key-output"
import { accessCell } from "./keys"
import { confirmCreateAllow, EMBEDDED_WALLET_CHOICES, type EmbeddedWalletPermission } from "./keys-embedded-wallet"

const DEVICE_CODE_PATH = "/api/v1/agent/device/code"
const DEVICE_TOKEN_PATH = "/api/v1/agent/device/token"

/**
 * `POST /device/code` validates `clientName` at 64 characters against the RAW string, BEFORE it
 * sanitizes (agent-device.ts), so the cap has to be honored here or the very first command a user
 * ever runs fails with a validation error that never mentions `--label`. The default name embeds
 * the machine's hostname, which is unbounded in practice, so it is truncated; an explicit
 * `--label` is rejected up front instead, because silently truncating a name the user chose would
 * put a different label than they typed on the approval screen and on every `device/tokens`
 * listing afterwards. The key's label shares the same 1..64 rule, so one check covers both names.
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
  apiKey: {
    key: string
    keyPrefix: string
    scopes: string[]
    /** BE-503: what the consent page chose, as stored. An older API omits it. */
    embeddedWallet?: "allowed" | "denied"
  } | null
  apiKeyError?: string
}

function loginApiUrlFault(value: string, env: Record<string, string | undefined>): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `It needs a scheme, such as https://${value}`
  }
  if (url.host === "") return `It needs a scheme, such as https://${value}`
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The scheme must be http or https."
  return insecureApiUrlFault(value, env)
}

/**
 * A profile that does not exist yet must name its API host. `--api-url` and `CANDLE_API_URL`
 * count. A terminal is asked. Anything else, including a leftover top-level `config.apiUrl` and
 * the production default, is not used: that is how a new profile landed on staging.
 * Re-authenticating a profile that already exists keeps that profile's stored host.
 */
async function resolveLoginApiUrl(
  ctx: CommandContext,
): Promise<{ ok: true; apiUrl: string } | { ok: false; code: number }> {
  const { deps, json } = ctx
  const config = await deps.readConfig()
  const name = ctx.profile
  const exists = name !== undefined && config.profiles?.[name] !== undefined
  if (exists) return { ok: true, apiUrl: ctx.apiUrl }
  const explicit = ctx.apiUrlFlag?.trim() || deps.env.CANDLE_API_URL?.trim()
  if (explicit) {
    const fault = loginApiUrlFault(explicit, deps.env)
    if (fault !== undefined) {
      writeScreenUsageFailure(deps, `Invalid API host: ${explicit}. ${fault}`, json)
      return { ok: false, code: 2 }
    }
    return { ok: true, apiUrl: explicit }
  }
  const usage = "A new profile needs an API host. Pass --api-url <url> (or set CANDLE_API_URL)."
  if (!deps.isTTY.stdin) {
    writeScreenUsageFailure(deps, usage, json, {
      message: "A new profile needs an API host.",
      fixes: [{ label: "Pass", command: "candle auth login --api-url <url>" }],
    })
    return { ok: false, code: 2 }
  }
  const answer = (await deps.promptLine("API host for this profile (for example https://api.alpha.candle.tv): ")).trim()
  if (!answer) {
    writeScreenUsageFailure(deps, usage, json, {
      message: "A new profile needs an API host.",
      fixes: [{ label: "Pass", command: "candle auth login --api-url <url>" }],
    })
    return { ok: false, code: 2 }
  }
  const fault = loginApiUrlFault(answer, deps.env)
  if (fault !== undefined) {
    writeScreenUsageFailure(deps, `Invalid API host: ${answer}. ${fault}`, json)
    return { ok: false, code: 2 }
  }
  return { ok: true, apiUrl: answer }
}

export async function authLogin(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--scopes", "--label", "--embedded-wallet"],
    booleanFlags: ["--no-browser"],
  })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeScreenUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  // `--profile` here names a profile to CREATE (or re-authenticate), not one to select, so it is
  // validated for shape only -- never checked against what already exists (see finishLogin).
  if (ctx.profileFlag !== undefined && !isValidProfileName(ctx.profileFlag)) {
    writeScreenUsageFailure(
      deps,
      `Invalid profile name: ${ctx.profileFlag}. Run: candle auth login --profile <name>`,
      json,
      {
        message: `Invalid profile name: ${ctx.profileFlag}.`,
        fixes: [{ label: "Run", command: "candle auth login --profile <name>" }],
      },
    )
    return 2
  }
  const scopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined
  // Read:Write:Transfer (2026-09-24 spec, D6): this CLI never puts `transfer:bound` on a device
  // login. The API refuses it on that path anyway (R22) until the approval page that labels it
  // has been in production long enough; refusing here says where the level is minted instead.
  if (scopes?.includes("transfer:bound")) {
    writeScreenUsageFailure(
      deps,
      "transfer:bound is not available on a device login. Mint a Withdraw key with: candle keys create --access withdraw, or widen an existing key with: candle keys access <prefix> --access withdraw",
      json,
      {
        message: "transfer:bound is not available on a device login.",
        fixes: [
          { label: "Mint a Withdraw key", command: "candle keys create --access withdraw" },
          { label: "Widen an existing key", command: "candle keys access <prefix> --access withdraw" },
        ],
      },
    )
    return 2
  }
  // Trimmed, and 1..64 after trimming: the same rule and message as `keys create --label`, because
  // this label now names a key too. Checked before `/code`, so a blank one never starts a flow
  // (it used to reach the server and come back as the device name "Unknown client").
  const label = parsed.values["--label"]?.trim()
  const noBrowser = parsed.booleans.has("--no-browser")
  // Same default as `keys create`: deny, and an allow is confirmed at a terminal before the
  // device flow starts. The approval page's switch is not this default.
  const embeddedFlag = parsed.values["--embedded-wallet"] ?? "deny"
  const embeddedWallet = EMBEDDED_WALLET_CHOICES[embeddedFlag]
  if (embeddedWallet === undefined) {
    writeScreenUsageFailure(deps, "--embedded-wallet must be allow or deny.", json)
    return 2
  }

  if (
    parsed.values["--label"] !== undefined &&
    (label === undefined || label.length < 1 || label.length > MAX_CLIENT_NAME_LENGTH)
  ) {
    writeScreenUsageFailure(deps, `--label must be 1 to ${MAX_CLIENT_NAME_LENGTH} characters.`, json)
    return 2
  }

  // See MAX_CLIENT_NAME_LENGTH: the default embeds an unbounded hostname, so it is truncated
  // rather than allowed to fail the request. `--label` is already known to fit by this point.
  const clientName = (label ?? `candle-cli/${CLI_VERSION}@${deps.hostname}`).slice(0, MAX_CLIENT_NAME_LENGTH)
  const host = await resolveLoginApiUrl(ctx)
  if (!host.ok) return host.code
  const apiUrl = host.apiUrl
  if (embeddedWallet === "allowed") {
    const stop = await confirmCreateAllow(ctx)
    if (stop !== null) return stop
  }
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
    writeScreenFailure(deps, codeResult, { apiUrl, authType: "none" }, json)
    return 1
  }

  const code = codeResult.body as DeviceCodeResponse

  // These two lines are progress information, not the command's result -- in --json mode they
  // go to stderr so stdout stays exactly one parseable JSON value (fix round 1, item 1).
  const progress = json ? deps.stderr : deps.stdout
  if (json) {
    progress.write(`API: ${apiUrl}\n`)
    progress.write(`Your device code: ${code.userCode}\n`)
    progress.write(`Open this URL to approve: ${code.verificationUriComplete}\n`)
  } else {
    const style = terminalStyle(deps, "stdout")
    progress.write(
      `${heading("Authorize this device", style)}\n\n${fields(
        [
          ["API", apiUrl],
          ["Device code", code.userCode],
          ["Approve at", code.verificationUriComplete],
        ],
        style,
      ).join("\n")}\n\n`,
    )
  }
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
      return finishLogin(tokenResult.body, ctx, {
        scopes,
        label,
        verificationUri: code.verificationUri,
        apiUrl,
        embeddedWallet,
      })
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
      else writeLoginFailure(deps, tokenResult.rfcError)
      return 1
    }

    // Anything else during polling is unexpected (not part of the RFC vocabulary this endpoint
    // uses) -- surface it and stop, rather than looping forever on an error class not named above.
    writeScreenFailure(deps, tokenResult, { apiUrl, authType: "none" }, json)
    return 1
  }

  if (json) deps.stderr.write(`${JSON.stringify({ ok: false, reason: "expired_token" })}\n`)
  else writeLoginFailure(deps, "expired_token")
  return 1
}

function terminalRfcMessage(rfcError: "access_denied" | "expired_token" | "invalid_grant"): string {
  if (rfcError === "access_denied") return "Authorization was denied."
  if (rfcError === "expired_token") return "The device code expired before it was approved. Run: candle auth login"
  return "This device code is unknown or was already used. Run: candle auth login"
}

function writeLoginFailure(
  deps: CommandContext["deps"],
  reason: "access_denied" | "expired_token" | "invalid_grant",
): void {
  const [message, suggestion] = terminalRfcMessage(reason).split(" Run: ")
  writeScreenMessage(deps, message ?? "", suggestion ? `Run: ${suggestion}` : undefined)
}

/** The portal origin to persist, taken from the device-code response's own `verificationUri` (the
 * API computes it from its `FRONTEND_URL`, so it names the real portal for whatever backend was
 * just used). Origin only: the path is the API's device-approval screen, not the device-management
 * screen `auth logout` points at. Unparseable means the server sent something unexpected, which is
 * not worth failing a successful login over -- storing nothing just leaves logout on its fallback
 * derivation. */
/**
 * The approval page chooses the embedded wallet. This login's flag is the value the key must
 * end on: deny unless `--embedded-wallet allow` was confirmed. A mismatch is corrected with the
 * device token just issued (`PUT /keys/:prefix/embedded-wallet`). A requested deny that cannot be
 * confirmed revokes the key and fails the login (see `finishLogin`).
 */
async function alignEmbeddedWallet(
  deps: CommandContext["deps"],
  apiUrl: string,
  deviceToken: string,
  keyPrefix: string,
  permission: EmbeddedWalletPermission,
  shown: EmbeddedWalletPermission | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const path = `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/embedded-wallet`
  const call = (body: Record<string, unknown>) =>
    apiRequest(path, {
      method: "PUT",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
      body,
    })
  const preview = await call({ permission, dryRun: true })
  if (!preview.ok) return { ok: false, message: preview.message }
  const from = (preview.body as { from?: EmbeddedWalletPermission } | null)?.from ?? shown
  if (from === undefined) return { ok: false, message: "the current permission could not be read" }
  const commit = await call({ permission, expect: from })
  if (!commit.ok) return { ok: false, message: commit.message }
  return { ok: true }
}

/** Revokes a key minted by this login, over the device token that minted it. */
async function revokeMintedKey(
  deps: CommandContext["deps"],
  apiUrl: string,
  deviceToken: string,
  keyPrefix: string,
): Promise<boolean> {
  try {
    const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}`, {
      method: "DELETE",
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    return result.ok
  } catch {
    return false
  }
}

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
  requested: {
    scopes?: string[]
    label?: string
    verificationUri?: string
    apiUrl: string
    embeddedWallet: EmbeddedWalletPermission
  },
): Promise<number> {
  const { deps, json } = ctx
  const body = rawBody as DeviceTokenSuccessResponse
  const apiUrl = requested.apiUrl

  // Every login names a profile: `--profile` when given, else the one this invocation already
  // resolved to (dispatch resolves leniently for login -- see index.ts), else one derived from
  // the host (`defaultProfileNameFor`). Only that last case is a NEW profile; the middle case is
  // a re-authentication, and it updates the existing entry in place, secrets overwritten under
  // the same refs. There is no flat, profile-less write anymore -- the legacy
  // SECRET_REFS/top-level-config shape is read-only from here on, kept only for migration and
  // rollback.
  const config = await deps.readConfig()
  const profileName = ctx.profileFlag ?? ctx.profile ?? defaultProfileNameFor(apiUrl, config.profiles)

  // Settle the embedded wallet before anything is stored. The approval page starts its switch on,
  // so a key may be minted allowed. Deny is a security condition, not a preference: when it is
  // requested and the key is not confirmed denied (the report omitted it and the correction
  // failed, or the correction failed outright), the key is revoked and the login fails with
  // nothing stored. Only a requested allow that could not be applied is kept (it is the narrower
  // key) and reported.
  let reportedEmbedded = body.apiKey?.embeddedWallet
  let embeddedCorrectError: string | undefined
  if (body.apiKey && reportedEmbedded !== requested.embeddedWallet) {
    const aligned = await alignEmbeddedWallet(
      deps,
      apiUrl,
      body.deviceToken,
      body.apiKey.keyPrefix,
      requested.embeddedWallet,
      reportedEmbedded,
    )
    if (aligned.ok) reportedEmbedded = requested.embeddedWallet
    else embeddedCorrectError = aligned.message
  }
  if (body.apiKey && requested.embeddedWallet === "denied" && reportedEmbedded !== "denied") {
    const revoked = await revokeMintedKey(deps, apiUrl, body.deviceToken, body.apiKey.keyPrefix)
    const message = `Could not confirm the embedded wallet is denied for key ${body.apiKey.keyPrefix}${embeddedCorrectError ? ` (${embeddedCorrectError})` : ""}. Nothing was stored.`
    const fix = revoked
      ? "The key was revoked. Run: candle auth login"
      : `The key could NOT be revoked. Deny or revoke it: candle keys update ${body.apiKey.keyPrefix} --embedded-wallet deny`
    if (json) {
      deps.stderr.write(
        `${JSON.stringify({ ok: false, reason: "embedded_wallet_not_denied", keyPrefix: body.apiKey.keyPrefix, keyRevoked: revoked, message })}\n`,
      )
    } else {
      writeScreenMessage(deps, message, fix)
    }
    return 1
  }
  await deps.store.set(profileSecretRef(profileName, "deviceToken"), body.deviceToken)
  if (body.apiKey) await deps.store.set(profileSecretRef(profileName, "apiKey"), body.apiKey.key)

  // WHICH account this profile acts as, cached for the identity line (and Phase 2's guard). The
  // account's username, when it has one, is cached beside it so the line can name the handle.
  // Best-effort: an unreachable API must not fail a login that already succeeded.
  let account: string | undefined
  let username: string | undefined
  if (body.apiKey) {
    const lookup = await fetchAccount(deps, apiUrl, body.apiKey.key)
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
    apiUrl,
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

  // `--label` names the key as well as the device. The exchange mints the key unnamed (the API's
  // `issueAgentKey` takes no label there), so it is named here with the key manager's own rename,
  // over the device token just issued. After everything above is stored, so nothing about the
  // rename can lose the credentials; and best-effort, because an unnamed key is cosmetic and
  // recoverable while a failed login is neither.
  let apiKeyLabel: string | undefined
  let apiKeyLabelError: string | undefined
  if (requested.label && body.apiKey) {
    try {
      const renamed = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(body.apiKey.keyPrefix)}`, {
        method: "PATCH",
        auth: "device",
        credentials: { deviceToken: body.deviceToken },
        apiUrl,
        fetch: deps.fetch,
        env: deps.env,
        body: { label: requested.label },
      })
      if (renamed.ok) apiKeyLabel = requested.label
      else apiKeyLabelError = renamed.message
    } catch (error) {
      apiKeyLabelError = error instanceof Error ? error.message : String(error)
    }
  }

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
        // Both optional and additive: present only when `--label` asked for a rename.
        ...(apiKeyLabel !== undefined ? { apiKeyLabel } : {}),
        ...(apiKeyLabelError !== undefined ? { apiKeyLabelError } : {}),
        scopes: body.apiKey?.scopes,
        // Additive (BE-503): present only when the API reported it.
        ...(reportedEmbedded !== undefined ? { embeddedWallet: reportedEmbedded } : {}),
        ...(embeddedCorrectError !== undefined ? { embeddedWalletError: embeddedCorrectError } : {}),
        apiKeyError: body.apiKeyError,
      })}\n`,
    )
    return 0
  }

  const style = terminalStyle(deps, "stdout")
  deps.stdout.write(
    `${success("Device authorized", style)}\n\n${fields(
      [
        ["Profile", profileName],
        ["Stored", `${deps.backend} backend`],
        ["Device token prefix", body.tokenPrefix],
        ...(body.apiKey
          ? [
              ["API key prefix", body.apiKey.keyPrefix] as const,
              ...(apiKeyLabel !== undefined ? [["API key name", apiKeyLabel] as const] : []),
              ["Access", accessCell(body.apiKey.scopes, symbols(style).missing)] as const,
              ...(reportedEmbedded === "allowed" || reportedEmbedded === "denied"
                ? [["Embedded wallet", embeddedWalletSummary(reportedEmbedded)] as const]
                : []),
            ]
          : []),
      ],
      style,
    ).join("\n")}\n`,
  )
  if (body.apiKey) {
    deps.stdout.write(scopeSummary(body.apiKey.scopes, style, "Granted scopes"))
    if (reportedEmbedded === "denied") {
      notice(
        deps,
        "stdout",
        "note",
        `The owner can allow the embedded wallet with:\ncandle keys update ${body.apiKey.keyPrefix} --embedded-wallet allow`,
      )
    }
    if (embeddedCorrectError !== undefined && reportedEmbedded !== undefined) {
      notice(
        deps,
        "stdout",
        "warning",
        `The key was minted ${reportedEmbedded}. Setting the embedded wallet to ${requested.embeddedWallet} failed: ${embeddedCorrectError}\nRun: candle keys update ${body.apiKey.keyPrefix} --embedded-wallet ${requested.embeddedWallet === "allowed" ? "allow" : "deny"}`,
      )
    }
    if (apiKeyLabelError !== undefined) {
      notice(
        deps,
        "stdout",
        "warning",
        `Could not name the key: ${apiKeyLabelError}.${portalOrigin ? `\nName it in the key manager: ${portalOrigin}/dev/agent` : ""}`,
      )
    }
  } else if (body.apiKeyError) {
    const authorizedScopes = requested.scopes ?? scopesForPreset("readwrite")
    deps.stdout.write(scopeSummary(authorizedScopes, style, "Authorized scopes (no key issued yet)"))
    notice(deps, "stdout", "warning", `${body.apiKeyError}\nRun: candle keys create`)
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
  const { keyPrefix, portalOrigin, deviceTokenPrefix, label } = effectiveProfileFields(config, ctx.profile)
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
      notice(deps, "stdout", "warning", "Could not revoke the stored API key remotely (clearing it locally anyway).")
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
    // Authentication fields are profile state; machine signer and notice metadata survive.
    await deps.store.delete(SECRET_REFS.deviceToken)
    await deps.store.delete(SECRET_REFS.apiKey)
    const patch = Object.fromEntries(PRE_PROFILE_FIELDS.map((field) => [field, undefined]))
    const remaining = { ...config, ...patch }
    if (Object.values(remaining).some((value) => value !== undefined)) await deps.writeConfig(patch)
    else await deps.clearConfig()
  }

  // Read from state captured BEFORE the mutations above: the stored portal origin is exactly
  // what makes this pointer right on a non-default backend, and it is gone by this line.
  const portalUrl = portalDevicesUrl(apiUrl, portalOrigin)
  const device = deviceTokenPrefix ? { prefix: deviceTokenPrefix, label: label ?? null } : null

  // Clearing the store does not clear the shell. Either env var still set means a live credential
  // survives this logout, which "Local credentials cleared." on its own would misrepresent. Same
  // set the identity line names, read through the same helper.
  const liveEnvOverrides = credentialEnvOverrides(deps.env)

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({ success: true, revokedKey: revokedKey ?? null, portalUrl, device, envOverrides: liveEnvOverrides })}\n`,
    )
    return 0
  }

  writeSuccess(deps, "stdout", "Local credentials cleared.")
  if (liveEnvOverrides.length > 0) {
    notice(
      deps,
      "stdout",
      "warning",
      `Still set in this shell: ${liveEnvOverrides.join(", ")}. Those beat the store, so they remain live until you unset them.`,
    )
  }
  notice(
    deps,
    "stdout",
    "note",
    "The device token itself is session-only to revoke -- that is intentional (a stolen token cannot read device metadata or revoke a sibling device). Sign in to the portal to revoke it there.",
  )
  if (device)
    notice(
      deps,
      "stdout",
      "warning",
      `Device ${device.prefix}${device.label ? ` (${device.label})` : ""} is still live on the server. Revoke it under Connected devices:\n${portalUrl}`,
    )
  else writeFields(deps, "stdout", [["Connected devices", portalUrl]])
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
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeScreenUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const config = await deps.readConfig()
  // BE-1665 (K-11): on a core-owned profile the device token is in the core-only slot, which this
  // command cannot read. That is a fact to report, not a failure of the status command.
  let coreOwned = false
  const deviceToken = await resolveDeviceToken(deps, ctx.profile).catch((error: unknown) => {
    if (!(error instanceof ProfileCoreOwnedError)) throw error
    coreOwned = true
    return undefined
  })
  const apiKey = await resolveApiKey(deps, ctx.profile)

  const rows: CheckRow[] = []

  // Sequential, not concurrent (task-3-brief.md's design decisions): the two live checks run one
  // after the other.
  if (coreOwned) {
    rows.push({
      check: "Device token",
      state: "SKIP",
      detail: "held by the Candle core (trading is on in the Candle TUI)",
    })
  } else if (!deviceToken) {
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
  const profileFields = effectiveProfileFields(config, ctx.profile)
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
  const cachedAccount = ctx.profile !== undefined ? profileFields.account : undefined
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
        deviceTokenPrefix: profileFields.deviceTokenPrefix,
        keyPrefix: profileFields.keyPrefix,
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
  const shownAccount = account ?? profileFields.account
  const shownUsername = account !== undefined ? username : profileFields.username
  deps.stdout.write(
    `${identityLine(ctx.profile, shownAccount, apiUrl, undefined, shownUsername, identityStyle(deps, "stdout"))}\n`,
  )
  // `profile use` is the cheapest of the three repairs (it re-caches the account from this very
  // key); the guard's own refusal names the other two, which cost a re-authentication or a skipped
  // check. This line is a report, not a refusal, so it names only the cheap one.
  const style = terminalStyle(deps, "stdout")
  if (mismatch) {
    notice(
      deps,
      "stdout",
      "warning",
      `Profile ${ctx.profile} recorded ${cachedAccount}; this key belongs to ${account}.\nRun: candle profile use ${ctx.profile}`,
    )
  }
  deps.stdout.write(
    `\n${heading("Credentials", style)}\n\n${fields(
      [
        ["Backend", deps.backend],
        ["Device token prefix", profileFields.deviceTokenPrefix],
        ["API key prefix", profileFields.keyPrefix],
        ["Config file", configPath],
      ],
      style,
    ).join("\n")}\n\n${heading("Checks", style)}\n\n`,
  )
  // Details are prose: wrap them as fields instead of squeezing them into a table cell.
  deps.stdout.write(
    `${fields(
      rows.map((row) => [row.check, `${row.state}  ${row.detail}`]),
      style,
    ).join("\n")}\n`,
  )
  return exitCode
}
