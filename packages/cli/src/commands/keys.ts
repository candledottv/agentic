/**
 * `keys list` / `keys create` / `keys revoke`. All three authenticate with the device token
 * (`keysAuth` on the API side accepts a Privy session OR a device token; the CLI only ever holds
 * the latter). Credential resolution is env-first, then the store, via `resolveDeviceToken`.
 */

import {
  type AgentKeyPreset,
  agentKeyAccess,
  agentKeyAccessWords,
  scopesForPreset,
  sortAgentKeyScopes,
} from "../agent-key-access"
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
import { writeSuccess } from "../human-output"
import { bold, fields, heading, notice, success, symbols, terminalStyle } from "../presentation"
import { effectiveProfileFields, printIdentity, profileSecretRef } from "../profiles"
import { formatAgo, formatTime, renderTable, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { SECRET_REFS } from "../secret-store"
import {
  embeddedWalletSummary,
  scopeSummary,
  writeScreenFailure,
  writeScreenLocalFailure,
  writeScreenUsageFailure,
} from "./key-output"
import { confirmCreateAllow, EMBEDDED_WALLET_CHOICES, effectiveEmbeddedWallet } from "./keys-embedded-wallet"

const KEYS_PATH = "/api/v1/agent/keys"

/**
 * `keys create --access <level>`: the web picker's three presets by their CLI spellings (2026-09-24
 * spec, D6 / R17). Each maps to the exact scope list the shared module
 * mints for that preset, so a key created here and one created on the web are the same key.
 */
export const ACCESS_LEVELS: Record<string, AgentKeyPreset> = {
  read: "read",
  write: "readwrite",
  withdraw: "readwritetransfer",
  // Permanent compatibility aliases; help and suggestions use the short names above.
  transfer: "readwritetransfer",
  "read-write": "readwrite",
  "read-write-transfer": "readwritetransfer",
}

/**
 * What `keys create --access` accepts: the levels above plus `trade-perps` (2026-10-17 C spec,
 * section 7), which mints exactly `account:read` and `perps:write`. Not a level `keys access` can
 * move a key to: the API's access change knows only Read, Write and Withdraw.
 */
export const CREATE_ACCESS_LEVELS: Record<string, AgentKeyPreset> = {
  ...ACCESS_LEVELS,
  "trade-perps": "tradeperps",
}

/** The one precondition all three `keys` subcommands share. Written through `writeLocalFailure`
 * so `--json` gets an object here too: this exit is as much a result of the command as an API
 * error is, and a `--json` caller must never have to fall back to parsing a sentence. */
export const NO_DEVICE_TOKEN = {
  code: "NO_DEVICE_TOKEN",
  message: "No device token available.",
  suggestion: "Run: candle auth login",
}

export interface KeyRow {
  keyPrefix: string
  /** The operator's name for the key; absent when it was never named. */
  label?: string
  scopes: string[]
  environment: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
  mintedByDevicePrefix?: string
  /** BE-501: whether the key may spend the embedded wallet. Absent on a row that predates it: allowed. */
  embeddedWallet?: "allowed" | "denied"
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

/**
 * A key's name as one table cell. The API trims a label but does not strip control characters, so
 * a newline would break the fixed-width table and a bidi override could make the row read as
 * something else. Both become a space, runs of whitespace collapse, and the result is trimmed: the
 * same classes `sanitizeClientName` in apps/api's agent-device route names, written as a code-point
 * filter for the same reason (biome's `noControlCharactersInRegex`). Render-only; `--json` carries
 * the stored value.
 */
export function labelCell(label: string | undefined): string {
  if (!label) return ""
  const cleaned = Array.from(label)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f)
      const isBidiOrInvisible =
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0xfeff
      return isControl || isBidiOrInvisible ? " " : ch
    })
    .join("")
  return cleaned.replace(/\s+/g, " ").trim()
}

/**
 * What a key IS, in one cell: `Read`, `Write` or `Withdraw` when its stored scopes are exactly one of the
 * web's three presets, otherwise the web key manager's chip words for what it holds followed by any
 * scope no chip names, or `–` (the web's own "cannot" glyph) when it holds nothing. The same shared
 * classification the web reads, so the two surfaces describe a key the same way (keys list Access
 * and Name spec, 2026-09-23, D3).
 */
export function accessCell(scopes: readonly string[], missing = "–"): string {
  const access = agentKeyAccess(scopes)
  if (access.kind === "preset") return access.label
  const words = agentKeyAccessWords(access)
  return words.length > 0 ? words.join(", ") : missing
}

export async function keysList(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--scopes", "--all"] })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeScreenUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  await printIdentity(ctx)

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeScreenLocalFailure(deps, NO_DEVICE_TOKEN, json)
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
    writeScreenFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }

  // `--scopes` changes the human table only. The JSON payload already carries every field, raw
  // scopes in stored order included, and it is a frozen contract.
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }

  const withScopes = parsed.booleans.has("--scopes")
  const body = result.body as { keys: KeyRow[] }
  const config = await deps.readConfig()
  // THIS profile's device prefix: reading the legacy top-level one (absent on any profile created
  // since the upgrade) printed this very device's own key as if another machine had minted it.
  const ownDevicePrefix = effectiveProfileFields(config, ctx.profile).deviceTokenPrefix
  const style = terminalStyle(deps, "stdout")
  const missing = symbols(style).missing
  const all = parsed.booleans.has("--all")
  const live = body.keys.filter((key) => !key.revokedAt)
  const revoked = body.keys.length - live.length
  const shown = all ? body.keys : live
  const now = deps.now()
  const rows = shown.map((key) => [
    key.keyPrefix,
    labelCell(key.label) || missing,
    accessCell(key.scopes, missing),
    ...(withScopes ? [sortAgentKeyScopes(key.scopes).join(",") || missing] : []),
    effectiveEmbeddedWallet(key.embeddedWallet),
    formatAgo(key.lastUsedAt, now, missing),
    formatTime(key.createdAt, { now, date: true, missing }),
    ...(all ? [formatTime(key.revokedAt, { now, missing })] : []),
    key.environment,
    mintedByLabel(key.mintedByDevicePrefix, ownDevicePrefix),
  ])
  const headers = [
    "Prefix",
    "Name",
    "Access",
    ...(withScopes ? ["Scopes"] : []),
    "Wallet",
    "Last used",
    "Created",
    ...(all ? ["Revoked"] : []),
    "Environment",
    "Minted by",
  ]
  deps.stdout.write(`${heading("API keys", style)}\n\n`)
  deps.stdout.write(
    `${renderTable(headers, rows, {
      style,
      width: style.width,
      indent: 2,
      rule: false,
      // Prefix is what the next command pastes, so it is never cut or dropped. Every other
      // column can drop, lowest priority first. Revoked and Scopes outrank Name and Access:
      // `--all` and `--scopes` exist to add those columns, and a 40-column terminal cannot
      // keep Prefix, Name, Access, Scopes and Revoked together (audit 3.3).
      columns: [
        { id: true },
        { priority: 7 },
        { priority: 6 },
        ...(withScopes ? [{ priority: 8 }] : []),
        { priority: 4 },
        { priority: 3 },
        { priority: 2 },
        ...(all ? [{ priority: 9 }] : []),
        { priority: 1 },
        { priority: 0, id: true },
      ],
    })}\n`,
  )
  notice(
    deps,
    "stdout",
    "note",
    `${live.length} live ${symbols(style).note} ${revoked} revoked${!all && revoked ? " (--all to show)" : ""}`,
  )
  return 0
}

export async function keysCreate(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: [
      "--scopes",
      "--access",
      "--environment",
      "--label",
      "--expires-in",
      "--tx-limit",
      "--reset",
      "--embedded-wallet",
    ],
  })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeScreenUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  // `--access` names a preset, `--scopes` names raw scopes. Both at once is a contradiction to
  // refuse, not a merge to guess at (spec D6: mutually exclusive, exit 2).
  if (parsed.values["--access"] !== undefined && parsed.values["--scopes"] !== undefined) {
    writeScreenUsageFailure(deps, "--access and --scopes are mutually exclusive; pass one of them.", json)
    return 2
  }
  let accessScopes: string[] | undefined
  if (parsed.values["--access"] !== undefined) {
    const preset = CREATE_ACCESS_LEVELS[parsed.values["--access"]]
    if (preset === undefined) {
      writeScreenUsageFailure(deps, "--access must be one of: read, write, withdraw, trade-perps.", json)
      return 2
    }
    accessScopes = scopesForPreset(preset)
  }
  const requestedScopes =
    accessScopes ?? (parsed.values["--scopes"] ? parseScopesList(parsed.values["--scopes"]) : undefined)
  const environment = parsed.values["--environment"]

  // Key-manager parity (CLI P0 plan, Task 4): the same optional name / expiry / spend cap the
  // portal's create form takes, validated with the API's own rules BEFORE the round trip so a
  // malformed value fails in milliseconds with a usage error, not an HTTP 400.
  const label = parsed.values["--label"]?.trim()
  if (parsed.values["--label"] !== undefined && (label === undefined || label.length < 1 || label.length > 64)) {
    writeScreenUsageFailure(deps, "--label must be 1 to 64 characters.", json)
    return 2
  }

  let expiresInDays: number | undefined
  if (parsed.values["--expires-in"] !== undefined) {
    const parsedDays = parseExpiresInDays(parsed.values["--expires-in"])
    if (!parsedDays.ok) {
      writeScreenUsageFailure(deps, parsedDays.message, json)
      return 2
    }
    expiresInDays = parsedDays.days
  }

  // --reset only means something with --tx-limit; a bare --reset is a usage error rather than a
  // silently ignored flag (same posture parseArgs takes toward unknown flags).
  if (parsed.values["--reset"] !== undefined && parsed.values["--tx-limit"] === undefined) {
    writeScreenUsageFailure(deps, "--reset requires --tx-limit.", json)
    return 2
  }
  let txLimit: { usdMicros: number; reset: TxLimitReset } | undefined
  if (parsed.values["--tx-limit"] !== undefined) {
    const parsedUsd = parseUsdToMicros(parsed.values["--tx-limit"])
    if (!parsedUsd.ok) {
      writeScreenUsageFailure(deps, parsedUsd.message, json)
      return 2
    }
    const reset = (parsed.values["--reset"] ?? "daily") as TxLimitReset
    if (!TX_LIMIT_RESETS.includes(reset)) {
      writeScreenUsageFailure(deps, `--reset must be one of: ${TX_LIMIT_RESETS.join(", ")}.`, json)
      return 2
    }
    txLimit = { usdMicros: parsedUsd.usdMicros, reset }
  }

  // BE-503 (R5.11): whether the new key may spend the account's embedded wallet. The flag defaults
  // to deny, the same default the server now writes for a request that omits it (R5.2, B2), and
  // the CLI always sends the value so the key is exactly what this command printed.
  const embeddedFlag = parsed.values["--embedded-wallet"] ?? "deny"
  const embeddedWallet = EMBEDDED_WALLET_CHOICES[embeddedFlag]
  if (embeddedWallet === undefined) {
    writeScreenUsageFailure(deps, "--embedded-wallet must be allow or deny.", json)
    return 2
  }

  await printIdentity(ctx)

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeScreenLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }

  // Allowing is confirmed at a terminal before anything is minted; denying needs no prompt.
  if (embeddedWallet === "allowed") {
    const stop = await confirmCreateAllow(ctx)
    if (stop !== null) return stop
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
      embeddedWallet,
    },
  })

  if (!result.ok) {
    writeScreenFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }

  const body = result.body as {
    key: string
    keyPrefix: string
    scopes: string[]
    environment: string
    embeddedWallet?: "allowed" | "denied"
  }

  // Store only when the CLI holds no working key yet -- it manages exactly one, and any other
  // key belongs to whichever agent it was minted for. Under a profile the ref and the recorded
  // prefix/scopes are namespaced to it; the legacy top-level fields are used only pre-profile.
  const apiKeyRef = ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey

  // Storing must never stop the key being shown.
  //
  // The API issues the plaintext exactly once. Before this, a throw anywhere in the block below (a
  // locked keychain, a cancelled passphrase prompt, a full disk) skipped the display entirely and
  // left an ACTIVE key on the account that nobody had ever seen: unusable, and revocable only by
  // first noticing an orphaned prefix in `keys list`. An UNSTORED key the operator can read is
  // strictly better than a key they cannot, so the outcome is captured rather than thrown, and
  // reported alongside the key instead of in place of it.
  let stored = false
  let storeError: string | undefined
  try {
    if (!(await deps.store.get(apiKeyRef))) {
      await deps.store.set(apiKeyRef, body.key)
      if (ctx.profile) {
        await deps.updateProfile(ctx.profile, { keyPrefix: body.keyPrefix, scopes: body.scopes })
      } else {
        await deps.writeConfig({ keyPrefix: body.keyPrefix, scopes: body.scopes })
      }
      stored = true
    }
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error)
  }

  if (json) {
    // One object, key included, whether or not storage worked: a `--json` caller parsing this is
    // the case least able to recover a key that was never emitted.
    deps.stdout.write(`${JSON.stringify({ ...body, stored, ...(storeError ? { storeError } : {}) })}\n`)
    return storeError ? 1 : 0
  }

  const style = terminalStyle(deps, "stdout")
  // The full key appears once, even when the credential store failed.
  deps.stdout.write(`${success("API key created", style)}\n\n  ${bold(body.key, style)}\n`)
  notice(deps, "stdout", "warning", "Shown once. Store it now.")
  deps.stdout.write(
    `${fields(
      [
        ["Label", label],
        ["Prefix", body.keyPrefix],
        ["Access", accessCell(body.scopes, symbols(style).missing)],
        ...(body.embeddedWallet === "allowed" || body.embeddedWallet === "denied"
          ? [["Embedded wallet", embeddedWalletSummary(body.embeddedWallet)] as const]
          : []),
        [
          "Stored",
          storeError !== undefined
            ? "no (store failed)"
            : stored
              ? `${deps.backend}, as this CLI's working key`
              : "no (the CLI already manages a different working key)",
        ],
      ],
      style,
    ).join("\n")}\n`,
  )
  deps.stdout.write(scopeSummary(body.scopes, style))
  if (body.embeddedWallet === "denied") {
    notice(
      deps,
      "stdout",
      "note",
      `The owner can allow the embedded wallet with:\ncandle keys update ${body.keyPrefix} --embedded-wallet allow`,
    )
  } else if (body.embeddedWallet !== "allowed") {
    notice(
      deps,
      "stderr",
      "warning",
      "This Candle API does not set a per-key embedded-wallet permission yet. This key may use the account's embedded wallet whatever --embedded-wallet said.",
    )
  }
  if (storeError !== undefined) {
    notice(
      deps,
      "stderr",
      "warning",
      `The key above was NOT stored in the ${deps.backend} store: ${storeError}\nIt is live on your account. Save it now, or revoke it with:\ncandle keys revoke ${body.keyPrefix}`,
    )
  }
  if (!requestedScopes) {
    notice(deps, "stdout", "note", "Default scopes: no --access or --scopes given (swap:write excluded).")
  }
  if (!stored && storeError === undefined) {
    notice(deps, "stdout", "note", "This key belongs to whichever agent it was minted for.")
  }
  // Non-zero when storage failed, so a script notices what a human would read in the warning
  // above. The key was still printed, which is the part that cannot be recovered.
  return storeError === undefined ? 0 : 1
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

  writeSuccess(deps, "stdout", `Revoked key ${prefix}.`)
  if (clearedLocal) {
    notice(deps, "stdout", "note", "This was the CLI's stored working key; also cleared it locally.")
  }
  return 0
}
