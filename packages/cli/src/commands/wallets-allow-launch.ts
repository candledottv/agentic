/**
 * `candle wallets allow-launch` and `candle wallets disallow-launch` (BE-850): the owner lets a TEE
 * wallet pay for a launch, or takes that back. `candle launch` refuses a TEE wallet until its
 * `allowLaunch` is on, and before these commands the only way to turn it on was to hand-build
 * `PUT /api/v1/agent/wallets/<id>/capabilities`.
 *
 * Both take the device token, the owner's CLI credential: an API key cannot grant a wallet the right
 * to launch, its own included. Neither opens the vault.
 *
 * Selectors are the ones `wallets trust` takes: ids, addresses, exact labels, or `prefix*`. The
 * device token cannot read `GET /wallets`, so the server resolves them in a preview that writes
 * nothing and returns each wallet's label, address and bound key; the screen shows them, the
 * operator types `confirm`, and the commit sends exactly the previewed ids to the PUT, one each.
 * `disallow-launch --yes` skips the confirm, since turning it off only narrows what an agent may do;
 * `allow-launch` has no such flag.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { printIdentity } from "../profiles"
import { errorEnvelope, renderTable, writeLocalFailure, writeUsageFailure } from "../render"
import { CONFIRM_WORD } from "../vault/promote-support"

const PREVIEW_PATH = "/api/v1/agent/tee-wallets/allow-launch/preview"
const capabilityPath = (id: string) => `/api/v1/agent/wallets/${encodeURIComponent(id)}/capabilities`

const USAGE_ALLOW = "Usage: candle wallets allow-launch <label|address|id|prefix*>... [--json]"
const USAGE_DISALLOW = "Usage: candle wallets disallow-launch <label|address|id|prefix*>... [--yes] [--json]"

const DEVICE_TOKEN_REQUIRED = {
  code: "DEVICE_TOKEN_REQUIRED",
  message:
    "Changing whether a TEE wallet may launch needs the device token, the owner's credential; an API key cannot do it.",
  suggestion: "Run: candle auth login",
}

/** One wallet as the preview reports it. */
export interface AllowLaunchRow {
  id: string
  chain: "solana" | "evm"
  address: string
  label: string | null
  boundKeyPrefix: string | null
  allowLaunch: boolean
}

interface PreviewResponse {
  success: true
  dryRun: true
  enabled: boolean
  changed: AllowLaunchRow[]
  unchanged: AllowLaunchRow[]
  notTee: AllowLaunchRow[]
}

const nameOf = (row: AllowLaunchRow) => row.label ?? row.address

/** The screen's wallet table: what will change, with the key each wallet is bound to. */
export function allowLaunchTable(rows: AllowLaunchRow[]): string {
  return renderTable(
    ["line", "label", "wallet", "address", "bound key"],
    rows.map((row, i) => [String(i + 1), row.label ?? "-", row.chain, row.address, row.boundKeyPrefix ?? "-"]),
  )
}

/** Preview found nothing this command can change. */
export function nothingToChangeLine(shown: Pick<PreviewResponse, "unchanged" | "notTee">, enabled: boolean): string {
  const bits: string[] = []
  if (shown.unchanged.length === 1) bits.push(`that wallet already has allowLaunch ${enabled ? "on" : "off"}`)
  else if (shown.unchanged.length > 1) {
    bits.push(`all ${shown.unchanged.length} wallets already have allowLaunch ${enabled ? "on" : "off"}`)
  }
  if (shown.notTee.length > 0) {
    bits.push(`${shown.notTee.map(nameOf).join(", ")} ${shown.notTee.length === 1 ? "is" : "are"} not a TEE wallet`)
  }
  if (bits.length === 0) return "Nothing to change.\n"
  return `Nothing to change: ${bits.join("; ")}.\n`
}

/** The server's refusal, like every other failure: the envelope under `--json`, one line otherwise. */
function writeFailure(ctx: CommandContext, result: Extract<ApiResult, { ok: false }>): number {
  const { deps, apiUrl, json } = ctx
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404) {
    code = "ALLOW_LAUNCH_UNSUPPORTED"
    message =
      "This Candle API does not offer allowLaunch on TEE wallets (an older API, or TEE launch is off); nothing changed."
  } else {
    const error = (result.raw as { error?: { reason?: unknown; matches?: unknown } } | null)?.error
    if (error?.reason === "ambiguous" && Array.isArray(error.matches)) {
      const ids = (error.matches as Array<{ id?: unknown }>).map((m) => String(m.id)).join(", ")
      suggestion = `Name one of them by id or address: ${ids}`
    } else if (error?.reason === "not_found") {
      suggestion = "Run: candle wallets, to see this account's linked wallets and their labels."
    }
  }
  const envelope = errorEnvelope({ ...result, code, message }, { apiUrl, authType: "device" })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...envelope, ...(suggestion ? { suggestion } : {}) })}\n`)
  } else {
    deps.stderr.write(`${code ?? `HTTP ${result.status}`}: ${message}${suggestion ? ` ${suggestion}` : ""}\n`)
  }
  return 1
}

async function setAllowLaunch(args: string[], ctx: CommandContext, enabled: boolean): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const usage = enabled ? USAGE_ALLOW : USAGE_DISALLOW
  const command = enabled ? "wallets allow-launch" : "wallets disallow-launch"
  const parsed = parseArgs(args, enabled ? {} : { booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length === 0) {
    writeUsageFailure(deps, `Name at least one wallet. ${usage}`, json)
    return 2
  }
  const skipConfirm = !enabled && parsed.booleans.has("--yes")

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  if (!skipConfirm && (!deps.isTTY.stdin || !deps.isTTY.stdout)) {
    writeLocalFailure(
      deps,
      {
        code: "ALLOW_LAUNCH_REQUIRES_TTY",
        message: `candle ${command} needs a terminal: the acknowledgement is typed, and nothing else supplies it.`,
        suggestion: enabled
          ? "Run it in an interactive shell; there is no flag and no environment variable for confirm."
          : "Run it in an interactive shell, or pass --yes to turn it off without the prompt.",
      },
      json,
    )
    return 1
  }

  const request = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) =>
    apiRequest(path, {
      method,
      body,
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Preview: the server resolves the selectors against this account's active wallets; nothing is written.
  const preview = await request(PREVIEW_PATH, "POST", { wallets: parsed.positionals, enabled })
  if (!preview.ok) return writeFailure(ctx, preview)
  const shown = preview.body as PreviewResponse
  const changing = shown.changed
  if (changing.length === 0) {
    if (json) deps.stdout.write(`${JSON.stringify({ ...shown, command })}\n`)
    else deps.stdout.write(nothingToChangeLine(shown, enabled))
    // Naming only wallets the capability cannot apply to is a mistake to report, not a no-op.
    return shown.unchanged.length === 0 && shown.notTee.length > 0 ? 1 : 0
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document.
  const n = changing.length
  const screen = [
    allowLaunchTable(changing),
    ...(shown.unchanged.length > 0
      ? [`${shown.unchanged.length} already ${enabled ? "on" : "off"}: ${shown.unchanged.map(nameOf).join(", ")}`]
      : []),
    ...(shown.notTee.length > 0 ? [`Not a TEE wallet, left alone: ${shown.notTee.map(nameOf).join(", ")}`] : []),
    "",
    enabled
      ? `${n === 1 ? "This wallet" : `These ${n} wallets`} will be allowed to pay for a launch: the bound key, with launch:write, can create tokens from ${n === 1 ? "it" : "them"} (candle launch).`
      : `${n === 1 ? "This wallet" : `These ${n} wallets`} will no longer be able to pay for a launch. Trading is unchanged.`,
    "",
  ]
  deps.stderr.write(`${screen.join("\n")}\n`)

  if (!skipConfirm) {
    const typed = await deps.promptLine(
      `Type ${CONFIRM_WORD} to ${enabled ? "allow" : "stop"} launches from ${n === 1 ? "this wallet" : `these ${n} wallets`}: `,
    )
    if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
      writeLocalFailure(
        deps,
        {
          code: "ALLOW_LAUNCH_NOT_ACKNOWLEDGED",
          message: `The acknowledgement is the word ${CONFIRM_WORD}; nothing changed.`,
          suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.`,
        },
        json,
      )
      return 1
    }
  }

  // Commit: exactly the preview's ids, never the selectors, one PUT each. A failure on one does not
  // stop the rest; it is reported by id, and running the command again is safe (the PUT is idempotent).
  const done: AllowLaunchRow[] = []
  const failed: Array<{ id: string; code: string | null; message: string }> = []
  for (const row of changing) {
    const result = await request(capabilityPath(row.id), "PUT", { capability: "allowLaunch", enabled })
    if (result.ok) done.push({ ...row, allowLaunch: enabled })
    else {
      failed.push({
        id: row.id,
        code: result.status === 404 ? "WALLET_NOT_FOUND" : (result.code ?? null),
        message: result.status === 404 ? "no longer an active TEE wallet on this account" : result.message,
      })
    }
  }
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({ success: failed.length === 0, command, enabled, changed: done, unchanged: shown.unchanged, notTee: shown.notTee, failed })}\n`,
    )
    return failed.length > 0 ? 1 : 0
  }
  const verb = enabled ? "Allowed launches from" : "Stopped launches from"
  deps.stdout.write(`${verb} ${done.length} wallet${done.length === 1 ? "" : "s"}.\n`)
  for (const failure of failed) {
    deps.stderr.write(`Not changed: ${failure.id}: ${failure.message}${failure.code ? ` (${failure.code})` : ""}.\n`)
  }
  return failed.length > 0 ? 1 : 0
}

export function walletsAllowLaunch(args: string[], ctx: CommandContext): Promise<number> {
  return setAllowLaunch(args, ctx, true)
}

export function walletsDisallowLaunch(args: string[], ctx: CommandContext): Promise<number> {
  return setAllowLaunch(args, ctx, false)
}
