/**
 * `candle tee rebind` and `candle tee rebinds` (BE-303, spec
 * docs/superpowers/specs/2026-09-23-tee-wallet-rebind-design.md, D7 and D10): move promoted TEE
 * wallets to another API key on this account, and read the account's rebind history.
 *
 * Both take the device token, the owner's CLI credential for key management (`keysAuth` on the
 * API side). Neither opens the vault (D9): a rebind needs no custody, and requiring an unlock
 * would make the operator produce a factor to change a server-side authorization. The server
 * resolves every selector against the caller's own TEE rows, so no API key is needed either.
 *
 * `tee rebind` is preview, screen, `confirm`, commit. The commit sends exactly the ids and
 * bindings the preview showed (`expect`, a compare-and-swap on the server), never the selectors,
 * so a label edited after the preview cannot change what is committed. The typed `confirm` is
 * the same rule as `vault promote` (trimmed, case-insensitive, one attempt); it is not a security
 * boundary, the API is, but it stops a scripted or mistaken run on an owner's machine.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { apiKeyPrefix, candleEnvironment, effectiveProfileFields, printIdentity } from "../profiles"
import { errorEnvelope, formatTimestamp, renderTable, writeLocalFailure, writeUsageFailure } from "../render"
import { CONFIRM_WORD, shortAddress } from "../vault/promote-support"
import { type KeyRow, labelCell } from "./keys"
import { refuseEnvPassphrase } from "./tee"

const REBIND_PATH = "/api/v1/agent/tee-wallets/rebind"
const REBINDS_PATH = "/api/v1/agent/tee-wallets/rebinds"
const KEYS_PATH = "/api/v1/agent/keys"

const USAGE_REBIND = "Usage: candle tee rebind <wallet...> --to-key <prefix|label> [--label-prefix <p>] [--json]"
const USAGE_REBINDS = "Usage: candle tee rebinds [wallet] [--json]"

/** The one precondition both commands share: the device token, not an API key. */
const DEVICE_TOKEN_REQUIRED = {
  code: "DEVICE_TOKEN_REQUIRED",
  message: "Moving a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
  suggestion: "Run: candle auth login",
}

/** A key's 8-character prefix, as `keys list` prints it and as the server names it. */
const KEY_PREFIX_RE = /^[A-Za-z0-9_-]{8}$/

interface RebindPreviewRow {
  id: string
  address: string
  label: string | null
  fromKeyPrefix: string
  allowLaunch: boolean
  auditId?: string
}

interface RebindResponse {
  success: true
  dryRun: boolean
  toKey: {
    keyPrefix: string
    label: string | null
    paused: boolean
    walletScope: "all" | "selected"
    tradeReady: { sol: boolean; usdc: boolean }
    missingCaps: string[]
    launchScope: boolean
  }
  rebound: RebindPreviewRow[]
  unchanged: Array<{ id: string; address: string; label: string | null }>
}

/** The screen's wording for each cap gap, one line per asset that is not ready (D7). */
export function capWarnings(keyPrefix: string, toKey: RebindResponse["toKey"]): string[] {
  const { tradeReady, missingCaps } = toKey
  if (missingCaps.includes("txLimit")) {
    return [
      `Warning: key ${keyPrefix} has no txLimit; it cannot trade SOL-quoted or USDC-quoted swaps until one is set.`,
    ]
  }
  const lines: string[] = []
  if (!tradeReady.sol) {
    lines.push(
      `Warning: key ${keyPrefix} can trade USDC-quoted swaps; it cannot trade SOL-quoted swaps until a SOL cap is set.`,
    )
  }
  if (!tradeReady.usdc) {
    lines.push(
      `Warning: key ${keyPrefix} can trade SOL-quoted swaps; it cannot trade USDC-quoted swaps until a USDC cap is set.`,
    )
  }
  return lines
}

/** The launch warning: the target lacks `launch:write`, and a moved wallet carries `allowLaunch` (D7). */
export function launchWarning(
  keyPrefix: string,
  toKey: RebindResponse["toKey"],
  rows: RebindPreviewRow[],
): string | null {
  if (toKey.launchScope) return null
  const launchers = rows.filter((row) => row.allowLaunch).map((row) => row.label ?? shortAddress(row.address))
  if (launchers.length === 0) return null
  return `Warning: key ${keyPrefix} lacks launch:write; ${launchers.join(", ")} ${launchers.length === 1 ? "has" : "have"} allowLaunch but cannot launch under it.`
}

export const RELAY_SIGNER_LINE =
  "The relay signer does not move: trade these wallets from the machine that promoted them."

/**
 * The server's refusal, with the suggestion the spec gives each code (D7). Written like every
 * other failure: the envelope on stdout under `--json`, one line on stderr otherwise. Exit 1.
 */
function writeRebindFailure(
  ctx: CommandContext,
  result: Extract<ApiResult, { ok: false }>,
  context: { fromKeyPrefixes?: string[] },
): number {
  const { deps, apiUrl, json } = ctx
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404 && result.code !== "REBIND_WALLET_INVALID") {
    code = "REBIND_UNSUPPORTED"
    message = "This Candle API does not support rebinding yet; nothing changed."
  } else if (result.code === "REBIND_BUILD_OPEN") {
    const retryAfter = (result.raw as { error?: { retryAfter?: unknown } } | null)?.error?.retryAfter
    const when = typeof retryAfter === "number" ? new Date(retryAfter).toLocaleString() : "the build window closes"
    const keys = context.fromKeyPrefixes ?? []
    const stop =
      keys.length === 1
        ? `Stop the agent on key ${keys[0]} (candle keys stop ${keys[0]})`
        : keys.length > 1
          ? `Stop the agents on keys ${keys.join(", ")} (candle keys stop <prefix>)`
          : "Stop the agent on the wallet's current key (candle keys stop <prefix>)"
    suggestion = `${stop}, then run this again after ${when}.`
  } else if (result.code === "REBIND_FORWARD_OPEN") {
    message = "A sign for these wallets is still in flight or not yet expired; nothing changed."
  } else if (result.code === "REBIND_RECONCILE_INCOMPLETE") {
    suggestion = "Run the same command again; nothing changed."
  } else if (result.code === "REBIND_STALE") {
    suggestion = "Run the command again; the preview will show the current binding."
  }
  const envelope = errorEnvelope({ ...result, code, message }, { apiUrl, authType: "device" })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...envelope, ...(suggestion ? { suggestion } : {}) })}\n`)
  } else {
    deps.stderr.write(`${code ?? `HTTP ${result.status}`}: ${message}${suggestion ? ` ${suggestion}` : ""}\n`)
  }
  return 1
}

/**
 * `--to-key`: an 8-character prefix is used as is. Anything else is matched as an exact label
 * against the non-revoked keys from `GET /keys` (the same device-token read `keys list` makes).
 * No match lists the labelled keys; more than one match is refused with the prefixes listed. The
 * server only ever receives a prefix.
 */
async function resolveTargetKey(
  ctx: CommandContext,
  deviceToken: string,
  raw: string,
): Promise<{ ok: true; keyPrefix: string } | { ok: false; code: number }> {
  const { deps, apiUrl, json } = ctx
  if (KEY_PREFIX_RE.test(raw)) return { ok: true, keyPrefix: raw }
  const result = await apiRequest(KEYS_PATH, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    return { ok: false, code: writeRebindFailure(ctx, result, {}) }
  }
  const keys = ((result.body as { keys?: KeyRow[] } | null)?.keys ?? []).filter((key) => !key.revokedAt)
  const matches = keys.filter((key) => key.label === raw)
  if (matches.length === 1) return { ok: true, keyPrefix: (matches[0] as KeyRow).keyPrefix }
  if (matches.length === 0) {
    const labelled = keys.filter((key) => key.label).map((key) => `${key.keyPrefix} ${labelCell(key.label)}`)
    writeLocalFailure(
      deps,
      {
        code: "REBIND_KEY_NOT_FOUND",
        message: `No active key on this account is named ${JSON.stringify(raw)}.`,
        suggestion:
          labelled.length > 0
            ? `Named keys on this account:\n${labelled.map((line) => `  ${line}`).join("\n")}`
            : "No key on this account has a name; pass the key's 8-character prefix from: candle keys list",
      },
      json,
    )
    return { ok: false, code: 1 }
  }
  writeLocalFailure(
    deps,
    {
      code: "REBIND_KEY_AMBIGUOUS",
      message: `${matches.length} active keys are named ${JSON.stringify(raw)}; pass a prefix instead.`,
      suggestion: `Matching prefixes: ${matches.map((key) => key.keyPrefix).join(", ")}`,
    },
    json,
  )
  return { ok: false, code: 1 }
}

export async function teeRebind(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--to-key", "--label-prefix"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const toKey = parsed.values["--to-key"]
  const labelPrefix = parsed.values["--label-prefix"]
  if (!toKey) {
    writeUsageFailure(deps, `--to-key is required. ${USAGE_REBIND}`, json)
    return 2
  }
  if (parsed.positionals.length === 0 && labelPrefix === undefined) {
    writeUsageFailure(deps, `Name at least one wallet, or pass --label-prefix. ${USAGE_REBIND}`, json)
    return 2
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  // D7: a TTY, before the preview. No flag and no environment variable supplies `confirm`.
  if (!deps.isTTY.stdin || !deps.isTTY.stdout) {
    writeLocalFailure(
      deps,
      {
        code: "REBIND_REQUIRES_TTY",
        message: "candle tee rebind needs a terminal: the acknowledgement is typed, and nothing else supplies it.",
        suggestion: "Run it in an interactive shell; there is no flag and no environment variable for confirm.",
      },
      json,
    )
    return 1
  }

  const target = await resolveTargetKey(ctx, deviceToken, toKey)
  if (!target.ok) return target.code

  const call = (body: Record<string, unknown>) =>
    apiRequest(REBIND_PATH, {
      method: "POST",
      body,
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Preview: every check the commit makes, nothing written.
  const preview = await call({
    dryRun: true,
    toKeyPrefix: target.keyPrefix,
    wallets: parsed.positionals,
    ...(labelPrefix !== undefined ? { labelPrefix } : {}),
  })
  if (!preview.ok) return writeRebindFailure(ctx, preview, {})
  const shown = preview.body as RebindResponse
  const moving = shown.rebound
  if (moving.length === 0) {
    if (json) {
      deps.stdout.write(`${JSON.stringify({ ...shown, command: "tee rebind" })}\n`)
    } else {
      deps.stdout.write(`Nothing to move: every named wallet is already bound to ${shown.toKey.keyPrefix}.\n`)
    }
    return 0
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document (D7).
  const table = renderTable(
    ["line", "label", "address", "from", "allowLaunch"],
    moving.map((row, i) => [
      String(i + 1),
      labelCell(row.label ?? undefined),
      row.address,
      row.fromKeyPrefix,
      row.allowLaunch ? "yes" : "no",
    ]),
  )
  const config = await deps.readConfig()
  const fields = effectiveProfileFields(config, ctx.profile)
  const account = fields.account ? shortAddress(fields.account) : "unknown"
  const accountLine = fields.username ? `${fields.username}  (${account})` : account
  const environment = candleEnvironment(apiUrl) ?? "not a Candle host"
  const keyLabel = shown.toKey.label ? `  ${labelCell(shown.toKey.label)}` : ""
  const n = moving.length
  const screen = [
    table,
    ...(shown.unchanged.length > 0
      ? [
          `${shown.unchanged.length} already bound to this key: ${shown.unchanged
            .map((row) => row.label ?? shortAddress(row.address))
            .join(", ")}`,
        ]
      : []),
    "",
    `${n === 1 ? "This wallet" : `These ${n} wallets`} will move to:`,
    `  API key         ${shown.toKey.keyPrefix}${keyLabel}${shown.toKey.paused ? "  (paused)" : ""}`,
    `  Candle account  ${accountLine}`,
    `  API             ${apiUrl}  (${environment})`,
    "",
    ...capWarnings(shown.toKey.keyPrefix, shown.toKey),
    ...(launchWarning(shown.toKey.keyPrefix, shown.toKey, moving)
      ? [launchWarning(shown.toKey.keyPrefix, shown.toKey, moving) as string]
      : []),
    RELAY_SIGNER_LINE,
    "",
  ]
  deps.stderr.write(`${screen.join("\n")}\n`)

  const typed = await deps.promptLine(
    `Type ${CONFIRM_WORD} to move ${n === 1 ? "this wallet" : `these ${n} wallets`}: `,
  )
  if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
    writeLocalFailure(
      deps,
      {
        code: "REBIND_NOT_ACKNOWLEDGED",
        message: `The acknowledgement is the word ${CONFIRM_WORD}; nothing was moved.`,
        suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.`,
      },
      json,
    )
    return 1
  }

  // Commit: exactly the preview's ids and bindings, no selectors (D6, L4).
  const committed = await call({
    toKeyPrefix: shown.toKey.keyPrefix,
    walletIds: moving.map((row) => row.id),
    expect: Object.fromEntries(moving.map((row) => [row.id, row.fromKeyPrefix])),
  })
  if (!committed.ok) {
    return writeRebindFailure(ctx, committed, {
      fromKeyPrefixes: Array.from(new Set(moving.map((row) => row.fromKeyPrefix))),
    })
  }
  const result = committed.body as RebindResponse
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...result, command: "tee rebind" })}\n`)
    return 0
  }
  const auditIds = result.rebound.map((row) => row.auditId).filter((id): id is string => typeof id === "string")
  deps.stdout.write(
    `Moved ${result.rebound.length} wallet${result.rebound.length === 1 ? "" : "s"} to ${result.toKey.keyPrefix}.` +
      `${auditIds.length > 0 ? ` Audit ids: ${auditIds.join(", ")}` : ""}\n`,
  )
  return 0
}

interface RebindHistoryRow {
  id: string
  at: number
  linkedWalletId: string
  address: string
  fromKeyPrefix: string
  toKeyPrefix: string
  actor: "session" | "device"
  actorDevicePrefix?: string
  batchId: string
}

export const PORTAL_REVOKE_LINE =
  "A device token cannot revoke devices: revoke a device you do not recognise from the portal, with a signed-in session."

/** `candle tee rebinds [wallet]`: the account's rebind history (D10). Device token; no TTY; no vault. */
export async function teeRebinds(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [walletId, extra] = parsed.positionals
  if (extra !== undefined) {
    writeUsageFailure(deps, `Unexpected argument: ${extra}. ${USAGE_REBINDS}`, json)
    return 2
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  const query = walletId ? `?walletId=${encodeURIComponent(walletId)}` : ""
  const result = await apiRequest(`${REBINDS_PATH}${query}`, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) return writeRebindFailure(ctx, result, {})
  const body = result.body as { rebinds?: RebindHistoryRow[] }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...(result.body as object), command: "tee rebinds" })}\n`)
    return 0
  }
  const rows = body.rebinds ?? []
  if (rows.length === 0) {
    deps.stdout.write(`No rebinds on this account${walletId ? ` for ${walletId}` : ""}.\n`)
    return 0
  }
  deps.stdout.write(
    `${renderTable(
      ["Time", "Wallet", "From", "To", "Actor", "Device"],
      rows.map((row) => [
        formatTimestamp(row.at),
        row.address,
        row.fromKeyPrefix,
        row.toKeyPrefix,
        row.actor,
        row.actorDevicePrefix ?? "",
      ]),
    )}\n`,
  )
  if (rows.some((row) => row.actor === "device")) deps.stdout.write(`${PORTAL_REVOKE_LINE}\n`)
  return 0
}

/** Exposed for the help drift test: `--to-key` accepts what `apiKeyPrefix` would print, or a label. */
export function isKeyPrefix(value: string): boolean {
  return KEY_PREFIX_RE.test(value) || apiKeyPrefix(value) !== undefined
}
