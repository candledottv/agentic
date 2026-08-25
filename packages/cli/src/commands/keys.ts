/**
 * `keys list` / `keys create` / `keys revoke`. All three authenticate with the device token
 * (`keysAuth` on the API side accepts a Privy session OR a device token; the CLI only ever holds
 * the latter). Credential resolution is env-first, then the store, via `resolveDeviceToken`.
 */

import {
  parseArgs,
  parseExpiresInDays,
  parseScopesList,
  parseUsdToMicros,
  TX_LIMIT_RESETS,
  type TxLimitReset,
} from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { effectiveProfileFields, printIdentity, profileSecretRef } from "../profiles"
import {
  formatScopesForSummary,
  formatTimestamp,
  renderTable,
  writeFailure,
  writeLocalFailure,
  writeUsageFailure,
} from "../render"
import { SECRET_REFS } from "../secret-store"

const KEYS_PATH = "/api/v1/agent/keys"

/** The one precondition all three `keys` subcommands share. Written through `writeLocalFailure`
 * so `--json` gets an object here too: this exit is as much a result of the command as an API
 * error is, and a `--json` caller must never have to fall back to parsing a sentence. */
const NO_DEVICE_TOKEN = {
  code: "NO_DEVICE_TOKEN",
  message: "No device token available.",
  suggestion: "Run: candle auth login",
}

interface KeyRow {
  keyPrefix: string
  scopes: string[]
  environment: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
  mintedByDevicePrefix?: string
}

function mintedByLabel(mintedBy: string | undefined, ownDeviceTokenPrefix: string | undefined): string {
  // Absent provenance is not a mystery: it means the key was created from a signed-in browser
  // session (the portal), or predates provenance stamping entirely. An earlier "unknown" here
  // read as "a device Candle can no longer identify" and got escalated as a possible compromise
  // in a live session; naming the actual origin kills that false alarm.
  if (!mintedBy) return "browser session"
  if (mintedBy === ownDeviceTokenPrefix) return "this device"
  return mintedBy
}

export async function keysList(args: string[], ctx: CommandContext): Promise<number> {
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

  await printIdentity(ctx)

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }

  const result = await apiRequest(KEYS_PATH, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }

  const body = result.body as { keys: KeyRow[] }
  const config = await deps.readConfig()
  // THIS profile's device prefix: reading the legacy top-level one (absent on any profile created
  // since the upgrade) printed this very device's own key as if another machine had minted it.
  const ownDevicePrefix = effectiveProfileFields(config, ctx.profile).deviceTokenPrefix
  const rows = body.keys.map((key) => [
    key.keyPrefix,
    key.scopes.join(","),
    key.environment,
    formatTimestamp(key.createdAt),
    formatTimestamp(key.lastUsedAt),
    key.revokedAt ? formatTimestamp(key.revokedAt) : "no",
    mintedByLabel(key.mintedByDevicePrefix, ownDevicePrefix),
  ])

  deps.stdout.write(
    `${renderTable(["Prefix", "Scopes", "Environment", "Created", "Last used", "Revoked", "Minted by"], rows)}\n`,
  )
  return 0
}

export async function keysCreate(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--scopes", "--environment", "--label", "--expires-in", "--tx-limit", "--reset"],
  })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  const requestedScopes = parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined
  const environment = parsed.values["--environment"]

  // Key-manager parity (CLI P0 plan, Task 4): the same optional name / expiry / spend cap the
  // portal's create form takes, validated with the API's own rules BEFORE the round trip so a
  // malformed value fails in milliseconds with a usage error, not an HTTP 400.
  const label = parsed.values["--label"]?.trim()
  if (parsed.values["--label"] !== undefined && (label === undefined || label.length < 1 || label.length > 64)) {
    writeUsageFailure(deps, "--label must be 1 to 64 characters.", json)
    return 2
  }

  let expiresInDays: number | undefined
  if (parsed.values["--expires-in"] !== undefined) {
    const parsedDays = parseExpiresInDays(parsed.values["--expires-in"])
    if (!parsedDays.ok) {
      writeUsageFailure(deps, parsedDays.message, json)
      return 2
    }
    expiresInDays = parsedDays.days
  }

  // --reset only means something with --tx-limit; a bare --reset is a usage error rather than a
  // silently ignored flag (same posture parseArgs takes toward unknown flags).
  if (parsed.values["--reset"] !== undefined && parsed.values["--tx-limit"] === undefined) {
    writeUsageFailure(deps, "--reset requires --tx-limit.", json)
    return 2
  }
  let txLimit: { usdMicros: number; reset: TxLimitReset } | undefined
  if (parsed.values["--tx-limit"] !== undefined) {
    const parsedUsd = parseUsdToMicros(parsed.values["--tx-limit"])
    if (!parsedUsd.ok) {
      writeUsageFailure(deps, parsedUsd.message, json)
      return 2
    }
    const reset = (parsed.values["--reset"] ?? "daily") as TxLimitReset
    if (!TX_LIMIT_RESETS.includes(reset)) {
      writeUsageFailure(deps, `--reset must be one of: ${TX_LIMIT_RESETS.join(", ")}.`, json)
      return 2
    }
    txLimit = { usdMicros: parsedUsd.usdMicros, reset }
  }

  await printIdentity(ctx)

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }

  const result = await apiRequest(KEYS_PATH, {
    method: "POST",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: {
      ...(requestedScopes ? { scopes: requestedScopes } : {}),
      ...(environment ? { environment } : {}),
      // Omit-when-blank, matching the portal's createKeyRequestBody: the API validates label as
      // 1..64 characters the moment the key is present at all.
      ...(label ? { label } : {}),
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      ...(txLimit ? { txLimit } : {}),
    },
  })

  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }

  const body = result.body as { key: string; keyPrefix: string; scopes: string[]; environment: string }

  // Store only when the CLI holds no working key yet -- it manages exactly one, and any other
  // key belongs to whichever agent it was minted for. Under a profile the ref and the recorded
  // prefix/scopes are namespaced to it; the legacy top-level fields are used only pre-profile.
  const apiKeyRef = ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey
  const existingKey = await deps.store.get(apiKeyRef)
  let stored = false
  if (!existingKey) {
    await deps.store.set(apiKeyRef, body.key)
    if (ctx.profile) {
      await deps.updateProfile(ctx.profile, { keyPrefix: body.keyPrefix, scopes: body.scopes })
    } else {
      await deps.writeConfig({ keyPrefix: body.keyPrefix, scopes: body.scopes })
    }
    stored = true
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...body, stored })}\n`)
    return 0
  }

  // The plaintext key is printed exactly once, right here -- the API's own one-time issuance
  // display. Nothing else in this command (or `auth login`) ever prints it again.
  deps.stdout.write(`API key: ${body.key}\n`)
  deps.stdout.write("This is the only time the plaintext key is shown; store it now.\n")
  deps.stdout.write(`Prefix: ${body.keyPrefix}\n`)
  // This is the moment a fund-moving key is actually minted, so swap:write (if granted) is
  // called out here the same way the login summary calls it out (fix round 1, item 16).
  deps.stdout.write(`Scopes: ${formatScopesForSummary(body.scopes)}\n`)
  if (!requestedScopes) {
    deps.stdout.write("No --scopes given: the server granted the default scopes (swap:write excluded).\n")
  }
  deps.stdout.write(
    stored
      ? `Stored in the ${deps.backend} backend as the CLI's working key.\n`
      : "Not stored: the CLI already manages a different working key. This key belongs to whichever agent it was minted for.\n",
  )
  return 0
}

export async function keysRevoke(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr.write("Usage: candle keys revoke <prefix>\n")
    return 2
  }
  const prefix = parsed.positionals[0] as string

  await printIdentity(ctx)

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }

  const result = await apiRequest(`${KEYS_PATH}/${encodeURIComponent(prefix)}`, {
    method: "DELETE",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })

  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }

  const config = await deps.readConfig()
  const storedPrefix = effectiveProfileFields(config, ctx.profile).keyPrefix
  let clearedLocal = false
  if (storedPrefix === prefix) {
    const apiKeyRef = ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey
    await deps.store.delete(apiKeyRef)
    if (ctx.profile) {
      await deps.updateProfile(ctx.profile, { keyPrefix: undefined })
    } else {
      await deps.writeConfig({ keyPrefix: undefined })
    }
    clearedLocal = true
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, keyPrefix: prefix, clearedLocal })}\n`)
    return 0
  }

  deps.stdout.write(`Revoked key ${prefix}.\n`)
  if (clearedLocal) {
    deps.stdout.write("This was the CLI's stored working key; also cleared it locally.\n")
  }
  return 0
}
