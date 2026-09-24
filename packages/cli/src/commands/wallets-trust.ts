/**
 * `candle wallets trust` and `candle wallets untrust` (BE-329): the owner marks linked wallets as
 * theirs, or clears the mark. A trusted wallet is one of the account's own destinations: an agent
 * can move funds into it with no cap, like a wallet linked in a signed-in session. A wallet an API
 * key imported is not trusted until the owner marks it.
 *
 * Both take the device token, the owner's CLI credential (`keysAuth` on the API side). An API key
 * cannot change trust, and a profile holding only one is refused before any request, as
 * `tee rebind` refuses it. Neither opens the vault.
 *
 * Selectors are ids, addresses, exact labels, or `prefix*`. The device token cannot read
 * `GET /wallets`, so the server resolves them in a preview that writes nothing; the screen shows
 * the wallets that will change, the operator types `confirm`, and the commit sends exactly the ids
 * the preview showed, never the selectors. `untrust --yes` skips the confirm, since clearing trust
 * only narrows what an agent may do; `trust` has no such flag.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { printIdentity } from "../profiles"
import { errorEnvelope, renderTable, writeLocalFailure, writeUsageFailure } from "../render"
import { CONFIRM_WORD } from "../vault/promote-support"

const TRUST_PATH = "/api/v1/agent/linked-wallets/trust"

const USAGE_TRUST = "Usage: candle wallets trust <label|address|id|prefix*>... [--json]"
const USAGE_UNTRUST = "Usage: candle wallets untrust <label|address|id|prefix*>... [--yes] [--json]"

const DEVICE_TOKEN_REQUIRED = {
  code: "DEVICE_TOKEN_REQUIRED",
  message: "Marking a wallet trusted needs the device token, the owner's credential; an API key cannot do it.",
  suggestion: "Run: candle auth login",
}

/** One wallet as the trust route reports it, in the preview and in the commit. */
export interface TrustRow {
  id: string
  chain: "solana" | "evm"
  address: string
  label: string | null
  trustedAt: number | null
}

interface TrustResponse {
  success: true
  dryRun?: boolean
  trusted: boolean
  changed: TrustRow[]
  unchanged: TrustRow[]
  /** Present once the API reports session-linked rows. Absent on an older API. */
  sessionLinked?: TrustRow[]
  skipped: Array<{ walletId: string; reason: string }>
  batchId?: string
}

/** A wallet linked while signed in stays own. Revoke is what removes it. */
export function sessionLinkedLine(rows: TrustRow[]): string {
  const n = rows.length
  const it = n === 1 ? "it" : "them"
  const names = rows.map((row) => row.label ?? row.address).join(", ")
  return `${n} linked while signed in (${names}): always yours while linked. Revoke ${it} to remove ${it}.`
}

/** Preview found nothing this command can mark or clear. */
export function nothingToChangeLine(
  shown: Pick<TrustResponse, "unchanged" | "sessionLinked">,
  trusted: boolean,
): string {
  const session = shown.sessionLinked ?? []
  const unchanged = shown.unchanged
  if (session.length > 0 && unchanged.length === 0) {
    const one = session.length === 1
    return `Nothing to change: ${one ? "that wallet is" : `those ${session.length} wallets are`} always yours while linked. Revoke ${one ? "it" : "them"} to remove ${one ? "it" : "them"}.\n`
  }
  const bits: string[] = []
  if (session.length > 0) bits.push(sessionLinkedLine(session).replace(/\.$/, ""))
  if (unchanged.length > 0) {
    bits.push(
      unchanged.length === 1
        ? `that wallet is already ${trusted ? "trusted" : "untrusted"}`
        : `all ${unchanged.length} wallets are already ${trusted ? "trusted" : "untrusted"}`,
    )
  }
  if (bits.length === 0) return "Nothing to change.\n"
  return `Nothing to change: ${bits.join("; ")}.\n`
}

/** The server's refusal, like every other failure: the envelope under `--json`, one line otherwise. */
function writeTrustFailure(ctx: CommandContext, result: Extract<ApiResult, { ok: false }>): number {
  const { deps, apiUrl, json } = ctx
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404) {
    code = "TRUST_UNSUPPORTED"
    message = "This Candle API does not support trusting wallets yet; nothing changed."
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

/** The screen's wallet table: what will change, one line each. */
export function trustTable(rows: TrustRow[]): string {
  return renderTable(
    ["line", "label", "wallet", "address"],
    rows.map((row, i) => [String(i + 1), row.label ?? "-", row.chain, row.address]),
  )
}

async function setTrust(args: string[], ctx: CommandContext, trusted: boolean): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const usage = trusted ? USAGE_TRUST : USAGE_UNTRUST
  const command = trusted ? "wallets trust" : "wallets untrust"
  const parsed = parseArgs(args, trusted ? {} : { booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length === 0) {
    writeUsageFailure(deps, `Name at least one wallet. ${usage}`, json)
    return 2
  }
  const skipConfirm = !trusted && parsed.booleans.has("--yes")

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
        code: "TRUST_REQUIRES_TTY",
        message: `candle ${command} needs a terminal: the acknowledgement is typed, and nothing else supplies it.`,
        suggestion: trusted
          ? "Run it in an interactive shell; there is no flag and no environment variable for confirm."
          : "Run it in an interactive shell, or pass --yes to untrust without the prompt.",
      },
      json,
    )
    return 1
  }

  const call = (body: Record<string, unknown>) =>
    apiRequest(TRUST_PATH, {
      method: "POST",
      body,
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Preview: the server resolves the selectors against this account's active wallets; nothing is written.
  const preview = await call({ dryRun: true, wallets: parsed.positionals, trusted })
  if (!preview.ok) return writeTrustFailure(ctx, preview)
  const shown = preview.body as TrustResponse
  const changing = shown.changed
  if (changing.length === 0) {
    if (json) {
      deps.stdout.write(`${JSON.stringify({ ...shown, command })}\n`)
    } else {
      deps.stdout.write(nothingToChangeLine(shown, trusted))
    }
    return 0
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document.
  const n = changing.length
  const screen = [
    trustTable(changing),
    ...(shown.unchanged.length > 0
      ? [
          `${shown.unchanged.length} already ${trusted ? "trusted" : "untrusted"}: ${shown.unchanged
            .map((row) => row.label ?? row.address)
            .join(", ")}`,
        ]
      : []),
    ...((shown.sessionLinked?.length ?? 0) > 0 ? [sessionLinkedLine(shown.sessionLinked ?? [])] : []),
    "",
    trusted
      ? `${n === 1 ? "This wallet" : `These ${n} wallets`} will be trusted: your agents can move funds into ${n === 1 ? "it" : "them"} with no cap, like a wallet you linked while signed in.`
      : `${n === 1 ? "This wallet" : `These ${n} wallets`} will no longer be trusted: moving funds into ${n === 1 ? "it" : "them"} will need the withdrawal allowlist again.`,
    "",
  ]
  deps.stderr.write(`${screen.join("\n")}\n`)

  if (!skipConfirm) {
    const typed = await deps.promptLine(
      `Type ${CONFIRM_WORD} to ${trusted ? "trust" : "untrust"} ${n === 1 ? "this wallet" : `these ${n} wallets`}: `,
    )
    if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
      writeLocalFailure(
        deps,
        {
          code: "TRUST_NOT_ACKNOWLEDGED",
          message: `The acknowledgement is the word ${CONFIRM_WORD}; nothing changed.`,
          suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.`,
        },
        json,
      )
      return 1
    }
  }

  // Commit: exactly the preview's ids, never the selectors.
  const committed = await call({ walletIds: changing.map((row) => row.id), trusted })
  if (!committed.ok) return writeTrustFailure(ctx, committed)
  const result = committed.body as TrustResponse
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...result, command })}\n`)
    return result.skipped.length > 0 ? 1 : 0
  }
  const done = result.changed.length
  deps.stdout.write(`${trusted ? "Trusted" : "Untrusted"} ${done} wallet${done === 1 ? "" : "s"}.\n`)
  // A wallet revoked between the preview and the commit is skipped by the server, and said so.
  for (const skip of result.skipped) {
    deps.stderr.write(`Skipped ${skip.walletId}: ${skip.reason === "revoked" ? "revoked" : "not on this account"}.\n`)
  }
  return result.skipped.length > 0 ? 1 : 0
}

export function walletsTrust(args: string[], ctx: CommandContext): Promise<number> {
  return setTrust(args, ctx, true)
}

export function walletsUntrust(args: string[], ctx: CommandContext): Promise<number> {
  return setTrust(args, ctx, false)
}
