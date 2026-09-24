/**
 * `candle keys access` (BE-361, spec docs/superpowers/specs/2026-09-24-change-key-access-design.md,
 * section 9): move an existing API key between Read, Read:Write and Read:Write:Transfer in place.
 * Same prefix, same secret, same profile, same wallets, same caps.
 *
 * For a prefix or a label the credential is the device token, the owner's CLI credential
 * (`keysAuth` on `PUT /keys/:prefix/access`), which may widen or narrow. For `self` it is the
 * profile's own API key on `PUT /keys/self/access`, which may only narrow: a key can never widen
 * itself, and the server refuses it (`LOOSEN_REQUIRES_SESSION`) whatever this command does.
 *
 * Every change is a dry run, the screen on stderr, a confirmation, then a commit that sends the
 * scopes the preview showed (`expectScopes`, a compare-and-swap), so a change made elsewhere in
 * between is refused rather than overwritten. The server decides the direction; this command only
 * picks the confirmation it earns. Widening needs the key's prefix typed back at a terminal, with
 * no flag and no environment variable to supply it (the `tee rebind` rule). Narrowing takes a
 * plain yes, or `--yes` (the `wallets untrust --yes` precedent: it only narrows what an agent may
 * do). As with `tee rebind`, the typed prefix is not the security boundary, the API is; it stops a
 * scripted or mistaken widening on an owner's machine.
 */
import { AGENT_KEY_PRESET_LABELS, type AgentKeyPreset, presetForScopes, scopesForPreset } from "../agent-key-access"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { candleEnvironment, effectiveProfileFields, printIdentity } from "../profiles"
import {
  errorEnvelope,
  formatScopesForSummary,
  formatTimestamp,
  renderTable,
  writeLocalFailure,
  writeUsageFailure,
} from "../render"
import { shortAddress } from "../vault/promote-support"
import { ACCESS_LEVELS, accessCell, labelCell, NO_DEVICE_TOKEN } from "./keys"
import { PORTAL_REVOKE_LINE, resolveTargetKey } from "./tee-rebind"

const KEYS_PATH = "/api/v1/agent/keys"

export const USAGE_ACCESS =
  "Usage: candle keys access <prefix|label|self> --access <read|read-write|read-write-transfer> [--yes] [--json]\n" +
  "       candle keys access <prefix|label> --history [--json]"

/** `self` names the acting key; a key prefix is 8 characters, so it is never a real prefix. */
const SELF = "self"

/** The CLI spelling of each preset, the inverse of `ACCESS_LEVELS`, for the suggestions. */
const CLI_SPELLING: Record<AgentKeyPreset, string> = Object.fromEntries(
  Object.entries(ACCESS_LEVELS).map(([spelling, preset]) => [preset, spelling]),
) as Record<AgentKeyPreset, string>

const NO_API_KEY = {
  code: "API_KEY_REQUIRED",
  message: "candle keys access self changes the profile's own API key, and this profile holds none.",
  suggestion: "Select the profile holding the key with --profile, or name the key by prefix to use the device token.",
}

const REQUIRES_TTY = {
  code: "KEY_ACCESS_REQUIRES_TTY",
  message: "Widening a key needs a terminal: the key prefix is typed back, and nothing else supplies it.",
  suggestion: "Run it in an interactive shell; there is no flag and no environment variable to widen a key.",
}

interface AccessSide {
  access: AgentKeyPreset | null
  scopes: string[]
}

export interface AccessResponse {
  success: true
  dryRun: boolean
  keyPrefix: string
  label: string | null
  direction: "unchanged" | "narrow" | "widen"
  from: AccessSide
  to: { access: AgentKeyPreset; scopes: string[] }
  added: string[]
  removed: string[]
  effects: {
    boundTeeWallets?: { count: number; sample: Array<{ id: string; label: string | null; address: string }> }
    walletScope?: string
    linkedTransferReady?: { txLimit: boolean; assets: Record<string, boolean> }
    openSignClaims?: number
    openOrders?: number
    workers?: number
  }
  warnings: Array<{ code: string; message: string }>
  changeId?: string
  at?: number
}

interface AccessChangeRow {
  changeId: string
  at: number
  keyPrefix: string
  direction: "widen" | "narrow"
  from: AccessSide
  to: AccessSide
  actor: "session" | "device" | "agent"
  actorDevicePrefix?: string
  actorKeyPrefix?: string
}

/** A level as words: the preset's label, or the chip words for a custom or legacy set. */
export function levelName(side: AccessSide): string {
  const preset = side.access ?? presetForScopes(side.scopes)
  if (preset) return AGENT_KEY_PRESET_LABELS[preset]
  return `custom (${accessCell(side.scopes)})`
}

/** `Ab3dEf9h (cndl)`, or the bare prefix when the key has no name. */
function keyName(keyPrefix: string, label: string | null | undefined): string {
  const cleaned = labelCell(label ?? undefined)
  return cleaned ? `${keyPrefix} (${cleaned})` : keyPrefix
}

/** `SOL`, `SOL and USDC`, `SOL, USDC and CNDL`. */
function listWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

/**
 * The linked-transfer readiness line (spec section 9's screen): what a widened key still needs
 * before it can send to a linked wallet. A vault transfer needs none of it.
 */
export function linkedTransferLine(
  ready: NonNullable<AccessResponse["effects"]["linkedTransferReady"]>,
): string | null {
  const assets = Object.entries(ready.assets)
  const missing = assets.filter(([, ok]) => !ok).map(([asset]) => asset.toUpperCase())
  const readyAssets = assets.filter(([, ok]) => ok).map(([asset]) => asset.toUpperCase())
  const needs: string[] = []
  if (!ready.txLimit) needs.push("a USD transaction limit")
  if (missing.length > 0) {
    needs.push(`${missing.map((asset) => `a ${asset}`).join(" and ")} spend cap`)
  }
  if (needs.length === 0) return null
  const readyPart =
    readyAssets.length > 0 ? `; ${listWords(readyAssets)} ${readyAssets.length === 1 ? "is" : "are"} ready` : ""
  return [
    `Warning: to send to linked wallets it also needs ${needs.join(" and ")}${readyPart}.`,
    "         Set them in the web key manager: Agents, Keys, this key, Spend limits.",
  ].join("\n")
}

/** Warnings this command renders itself, from `effects`, rather than as the server's sentence. */
const LOCALLY_RENDERED = new Set(["MOVES_FUNDS", "VAULT_TRANSFER_READY", "LINKED_TRANSFER_NEEDS_LIMITS"])

/** The screen (stderr): which key, which account, which API, what changes, and what it costs. */
export function accessScreen(shown: AccessResponse, identity: { account: string; apiUrl: string }): string {
  const environment = candleEnvironment(identity.apiUrl) ?? "not a Candle host"
  const label = labelCell(shown.label ?? undefined)
  const lines = [
    `Key             ${shown.keyPrefix}${label ? `  ${label}` : ""}`,
    `Candle account  ${identity.account}`,
    `API             ${identity.apiUrl}  (${environment})`,
    "",
    `Access          ${levelName(shown.from)}  ->  ${levelName(shown.to)}   (${shown.direction})`,
    `Adds            ${shown.added.length > 0 ? formatScopesForSummary(shown.added) : "nothing"}`,
    `Removes         ${shown.removed.length > 0 ? shown.removed.join(", ") : "nothing"}`,
    "",
  ]
  const bound = shown.effects.boundTeeWallets
  if (bound && bound.count > 0) {
    const names = bound.sample.map((w) => labelCell(w.label ?? undefined) || shortAddress(w.address))
    const more = bound.count > names.length ? `, and ${bound.count - names.length} more` : ""
    lines.push(`TEE wallets on this key: ${bound.count}  (${names.join(", ")}${more})`)
    if (shown.direction === "widen" && shown.added.includes("transfer:bound")) {
      lines.push("It can move these wallets' funds to their vaults as soon as you confirm.")
    }
  }
  const ready = shown.effects.linkedTransferReady
  if (shown.direction === "widen" && ready) {
    const line = linkedTransferLine(ready)
    if (line) lines.push(line)
  }
  for (const warning of shown.warnings) {
    if (!LOCALLY_RENDERED.has(warning.code)) lines.push(`Warning: ${warning.message}`)
  }
  if (lines[lines.length - 1] !== "") lines.push("")
  return lines.join("\n")
}

/**
 * The server's refusal, with the suggestion each code earns (spec section 9). A 404 that carries
 * no error code is a route this API does not have yet (the alpha lag); a 404 with
 * `VALIDATION_FAILED` "Key not found" is the key refusal and stays itself.
 */
export function accessFailureDetails(
  result: Extract<ApiResult, { ok: false }>,
  context: { self: boolean; history?: boolean; preset?: AgentKeyPreset },
): { code: string; message: string; suggestion?: string } {
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404 && result.code === undefined) {
    code = "KEY_ACCESS_UNSUPPORTED"
    message = context.history
      ? "This Candle API has no key access history yet."
      : "This Candle API cannot change a key's access yet; nothing changed."
  } else if (result.code === "LOOSEN_REQUIRES_SESSION" && context.self) {
    const level = context.preset ? CLI_SPELLING[context.preset] : "<level>"
    suggestion = `Widen it from a signed-in session or with the device token: candle keys access <prefix> --access ${level}`
  } else if (result.code === "KEY_ACCESS_STALE") {
    suggestion = "Run the command again; the preview will show the key's current access."
  } else if (result.code === "KEY_ACCESS_PARTNER_KEY") {
    suggestion = "Partner keys are managed by Candle; ask your Candle contact to change one."
  } else if (result.status === 404 && result.code === "VALIDATION_FAILED") {
    suggestion = "Run: candle keys list, to see this account's keys and their prefixes."
  }
  return { code: code ?? `HTTP ${result.status}`, message, ...(suggestion !== undefined ? { suggestion } : {}) }
}

function writeAccessFailure(
  ctx: CommandContext,
  result: Extract<ApiResult, { ok: false }>,
  context: { self: boolean; history?: boolean; preset?: AgentKeyPreset },
): number {
  const { deps, apiUrl, json } = ctx
  const { code, message, suggestion } = accessFailureDetails(result, context)
  const envelope = errorEnvelope({ ...result, code, message }, { apiUrl, authType: context.self ? "key" : "device" })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...envelope, ...(suggestion ? { suggestion } : {}) })}\n`)
  } else {
    deps.stderr.write(`${code}: ${message}${suggestion ? ` ${suggestion}` : ""}\n`)
  }
  return 1
}

export async function keysAccess(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--access"], booleanFlags: ["--yes", "--history"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [target, extra] = parsed.positionals
  if (target === undefined || extra !== undefined) {
    writeUsageFailure(
      deps,
      `${extra !== undefined ? `Unexpected argument: ${extra}. ` : "Name one key. "}${USAGE_ACCESS}`,
      json,
    )
    return 2
  }
  const accessFlag = parsed.values["--access"]
  const history = parsed.booleans.has("--history")
  const yes = parsed.booleans.has("--yes")
  if ((accessFlag === undefined) === !history) {
    writeUsageFailure(deps, `Pass exactly one of --access and --history. ${USAGE_ACCESS}`, json)
    return 2
  }
  if (history) {
    if (yes) {
      writeUsageFailure(deps, "--yes only applies to a change, not to --history.", json)
      return 2
    }
    if (target === SELF) {
      writeUsageFailure(deps, "--history needs the device token: name the key by prefix or label, not self.", json)
      return 2
    }
    return keysAccessHistory(target, ctx)
  }
  const preset = ACCESS_LEVELS[accessFlag as string]
  if (preset === undefined) {
    writeUsageFailure(deps, `--access must be one of: ${Object.keys(ACCESS_LEVELS).join(", ")}.`, json)
    return 2
  }

  await printIdentity(ctx)

  // The credential and the route: the owner's device token on `:prefix`, or the key itself on `self`.
  const self = target === SELF
  let path: string
  let auth: "device" | "key"
  let credentials: { deviceToken?: string; apiKey?: string }
  if (self) {
    const apiKey = await resolveApiKey(deps, ctx.profile)
    if (!apiKey) {
      writeLocalFailure(deps, NO_API_KEY, json)
      return 1
    }
    path = `${KEYS_PATH}/self/access`
    auth = "key"
    credentials = { apiKey }
  } else {
    const deviceToken = await resolveDeviceToken(deps, ctx.profile)
    if (!deviceToken) {
      writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
      return 1
    }
    const resolved = await resolveTargetKey(ctx, deviceToken, target, {
      codePrefix: "KEY_ACCESS",
      writeListFailure: (result) => writeAccessFailure(ctx, result, { self: false }),
    })
    if (!resolved.ok) return resolved.code
    path = `${KEYS_PATH}/${encodeURIComponent(resolved.keyPrefix)}/access`
    auth = "device"
    credentials = { deviceToken }
  }
  const failureContext = { self, preset }
  const call = (body: Record<string, unknown>) =>
    apiRequest(path, { method: "PUT", body, auth, credentials, apiUrl, fetch: deps.fetch, env: deps.env })

  // Preview: every check the commit makes, nothing written. The server decides the direction.
  const preview = await call({ access: preset, dryRun: true })
  if (!preview.ok) return writeAccessFailure(ctx, preview, failureContext)
  const shown = preview.body as AccessResponse
  const name = keyName(shown.keyPrefix, shown.label)

  if (shown.direction === "unchanged") {
    if (json) deps.stdout.write(`${JSON.stringify({ ...shown, command: "keys access" })}\n`)
    else deps.stdout.write(`${name} is already ${levelName(shown.to)}. Nothing changed.\n`)
    return 0
  }

  const widen = shown.direction === "widen"
  const interactive = deps.isTTY.stdin && deps.isTTY.stdout
  if (widen && yes) {
    writeUsageFailure(deps, "--yes only skips the prompt when narrowing; nothing changed.", json)
    return 2
  }
  if (widen && !interactive) {
    writeLocalFailure(deps, REQUIRES_TTY, json)
    return 1
  }
  if (!widen && !yes && !interactive) {
    writeUsageFailure(
      deps,
      "Narrowing a key without a terminal needs --yes; nothing changed. Run it in an interactive shell, or pass --yes.",
      json,
    )
    return 2
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document.
  const config = await deps.readConfig()
  const fields = effectiveProfileFields(config, ctx.profile)
  const account = fields.account ? shortAddress(fields.account) : "unknown"
  deps.stderr.write(
    `${accessScreen(shown, { account: fields.username ? `${fields.username}  (${account})` : account, apiUrl })}\n`,
  )

  if (widen) {
    const typed = await deps.promptLine(`Type the key prefix ${shown.keyPrefix} to widen it: `)
    if (typed.trim() !== shown.keyPrefix) {
      writeLocalFailure(
        deps,
        {
          code: "KEY_ACCESS_NOT_ACKNOWLEDGED",
          message: `The acknowledgement is the key prefix ${shown.keyPrefix}; nothing changed.`,
          suggestion: `Run the command again and type ${shown.keyPrefix} at the prompt.`,
        },
        json,
      )
      return 1
    }
  } else if (!yes) {
    const answer = await deps.promptLine(
      `Change ${name} from ${levelName(shown.from)} to ${levelName(shown.to)}? [y/N] `,
    )
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      writeLocalFailure(
        deps,
        {
          code: "KEY_ACCESS_NOT_ACKNOWLEDGED",
          message: "Not confirmed; nothing changed.",
          suggestion: "Run the command again and answer y, or pass --yes.",
        },
        json,
      )
      return 1
    }
  }

  // Commit: the scopes the preview showed, compared as a set on the server.
  const committed = await call({ access: preset, expectScopes: shown.from.scopes })
  if (!committed.ok) return writeAccessFailure(ctx, committed, failureContext)
  const result = committed.body as AccessResponse

  // The profile records its own key's scopes (`keys create` writes them); keep them true, so
  // `candle doctor` and the help do not describe the old level.
  if (fields.keyPrefix !== undefined && fields.keyPrefix === result.keyPrefix && result.direction !== "unchanged") {
    const scopes = scopesForPreset(result.to.access)
    if (ctx.profile) await deps.updateProfile(ctx.profile, { scopes })
    else await deps.writeConfig({ scopes })
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...result, command: "keys access" })}\n`)
    return 0
  }
  if (result.direction === "unchanged") {
    deps.stdout.write(
      `${keyName(result.keyPrefix, result.label)} is already ${levelName(result.to)}. Nothing changed.\n`,
    )
    return 0
  }
  deps.stdout.write(
    `Changed ${keyName(result.keyPrefix, result.label)} to ${levelName(result.to)}.` +
      `${result.changeId ? ` Change id ${result.changeId}` : ""}\n`,
  )
  return 0
}

/** `candle keys access <key> --history`: one key's access changes, newest first. Device token only. */
async function keysAccessHistory(target: string, ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }
  const resolved = await resolveTargetKey(ctx, deviceToken, target, {
    codePrefix: "KEY_ACCESS",
    writeListFailure: (result) => writeAccessFailure(ctx, result, { self: false, history: true }),
  })
  if (!resolved.ok) return resolved.code
  const result = await apiRequest(`${KEYS_PATH}/${encodeURIComponent(resolved.keyPrefix)}/access-changes`, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) return writeAccessFailure(ctx, result, { self: false, history: true })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...(result.body as object), command: "keys access" })}\n`)
    return 0
  }
  const rows = (result.body as { changes?: AccessChangeRow[] }).changes ?? []
  if (rows.length === 0) {
    deps.stdout.write(`No access changes on key ${resolved.keyPrefix}.\n`)
    return 0
  }
  deps.stdout.write(
    `${renderTable(
      ["Time", "From", "To", "Actor", "Device or key"],
      rows.map((row) => [
        formatTimestamp(row.at),
        levelName(row.from),
        levelName(row.to),
        row.actor,
        row.actorDevicePrefix ?? row.actorKeyPrefix ?? "",
      ]),
    )}\n`,
  )
  if (rows.some((row) => row.actor === "device")) deps.stdout.write(`${PORTAL_REVOKE_LINE}\n`)
  return 0
}
