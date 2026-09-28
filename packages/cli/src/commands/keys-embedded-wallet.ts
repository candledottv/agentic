/**
 * The per-key embedded-wallet permission from the CLI (BE-503, CLI 0.11.10 remediation spec, R5.9
 * and R5.11): whether an API key may spend, sign for or launch from the account's embedded wallet.
 *
 * - `candle keys update <prefix|label> --embedded-wallet allow|deny` is the owner's control, on the
 *   device token (`keysAuth` on `PUT /keys/:prefix/embedded-wallet`), in both directions.
 * - `candle keys self embedded-wallet deny` is the key reining itself in, on the profile's own API
 *   key (`PUT /keys/self/embedded-wallet`). It can only deny: a key can never allow itself, and the
 *   server refuses it (`LOOSEN_REQUIRES_SESSION`) whatever this command does.
 *
 * `update` is a dry run, the screen on stderr, a confirmation, then a commit that names the value
 * the preview showed (`expect`, a compare-and-swap), exactly as `keys access` works. Allowing needs
 * the key's prefix typed back at a terminal, with no flag and no environment variable to supply it;
 * denying takes a plain yes, or `--yes`. The typed prefix is not the security boundary, the API is.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { candleEnvironment, effectiveProfileFields, printIdentity } from "../profiles"
import { errorEnvelope, writeLocalFailure, writeUsageFailure } from "../render"
import { shortAddress } from "../vault/promote-support"
import { labelCell, NO_DEVICE_TOKEN } from "./keys"
import { resolveTargetKey } from "./tee-rebind"

const KEYS_PATH = "/api/v1/agent/keys"

export type EmbeddedWalletPermission = "allowed" | "denied"

/** The flag's two spellings and the value each one stores. */
export const EMBEDDED_WALLET_CHOICES: Record<string, EmbeddedWalletPermission> = {
  allow: "allowed",
  deny: "denied",
}

export const USAGE_UPDATE = "Usage: candle keys update <prefix|label> --embedded-wallet <allow|deny> [--yes] [--json]"
export const USAGE_SELF = "Usage: candle keys self embedded-wallet deny [--json]"

/** What an absent value on a key row means: the row predates the setting (R5.1). */
export function effectiveEmbeddedWallet(value: unknown): EmbeddedWalletPermission {
  return value === "denied" ? "denied" : "allowed"
}

/** The one-line explanation printed beside a permission, on create and on update. */
export function embeddedWalletLine(permission: EmbeddedWalletPermission, keyPrefix: string): string {
  return permission === "allowed"
    ? "Embedded wallet: allowed. This key may trade, launch and transfer from the account's embedded wallet, with Candle signing."
    : `Embedded wallet: denied. This key cannot spend the account's embedded wallet; the owner can allow it with: candle keys update ${keyPrefix} --embedded-wallet allow`
}

const ALLOW_REQUIRES_TTY = {
  code: "EMBEDDED_WALLET_REQUIRES_TTY",
  message:
    "Allowing a key the embedded wallet needs a terminal: it is confirmed at a prompt, and nothing else supplies it.",
  suggestion:
    "Run it in an interactive shell, or allow it from the web key manager. There is no flag and no environment variable to allow it.",
}

const NO_API_KEY = {
  code: "API_KEY_REQUIRED",
  message: "candle keys self changes the profile's own API key, and this profile holds none.",
  suggestion: "Select the profile holding the key with --profile, or name the key to candle keys update.",
}

const SELF_CANNOT_ALLOW = {
  code: "LOOSEN_REQUIRES_SESSION",
  message: "An API key may deny itself the embedded wallet but never allow it; nothing changed.",
  suggestion:
    "The owner allows it with the device token: candle keys update <prefix> --embedded-wallet allow, or from the web key manager.",
}

/** `PUT .../embedded-wallet`'s 200 body, for a dry run and a commit alike. */
export interface EmbeddedWalletResponse {
  success: true
  dryRun: boolean
  keyPrefix: string
  label: string | null
  direction: "unchanged" | "narrow" | "widen"
  from: EmbeddedWalletPermission
  to: EmbeddedWalletPermission
  changeId?: string
  at?: number
}

function keyName(keyPrefix: string, label: string | null | undefined): string {
  const cleaned = labelCell(label ?? undefined)
  return cleaned ? `${keyPrefix} (${cleaned})` : keyPrefix
}

/**
 * The server's refusal, with the suggestion each code earns. A 404 without an error code is a
 * Candle API that predates the route (the alpha lag), not the "Key not found" refusal, which
 * carries `VALIDATION_FAILED` and stays itself.
 */
export function embeddedWalletFailureDetails(
  result: Extract<ApiResult, { ok: false }>,
  context: { self: boolean },
): { code: string; message: string; suggestion?: string } {
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404 && result.code === undefined) {
    code = "EMBEDDED_WALLET_UNSUPPORTED"
    message = "This Candle API cannot change a key's embedded-wallet permission yet; nothing changed."
  } else if (result.code === "LOOSEN_REQUIRES_SESSION" && context.self) {
    suggestion = SELF_CANNOT_ALLOW.suggestion
  } else if (result.code === "KEY_ACCESS_STALE") {
    suggestion = "Run the command again; the preview will show the key's current permission."
  } else if (result.status === 404 && result.code === "VALIDATION_FAILED") {
    suggestion = "Run: candle keys list, to see this account's keys and their prefixes."
  }
  return { code: code ?? `HTTP ${result.status}`, message, ...(suggestion !== undefined ? { suggestion } : {}) }
}

function writeEmbeddedWalletFailure(
  ctx: CommandContext,
  result: Extract<ApiResult, { ok: false }>,
  context: { self: boolean },
): number {
  const { deps, apiUrl, json } = ctx
  const { code, message, suggestion } = embeddedWalletFailureDetails(result, context)
  const envelope = errorEnvelope({ ...result, code, message }, { apiUrl, authType: context.self ? "key" : "device" })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...envelope, ...(suggestion ? { suggestion } : {}) })}\n`)
  } else {
    deps.stderr.write(`${code}: ${message}${suggestion ? ` ${suggestion}` : ""}\n`)
  }
  return 1
}

/**
 * `keys create --embedded-wallet allow`'s confirmation (R5.11): a plain yes at a terminal, on
 * stderr so `--json` stdout carries one document. Returns an exit code to stop on, or null to go on.
 */
export async function confirmCreateAllow(ctx: CommandContext): Promise<number | null> {
  const { deps, json } = ctx
  if (!(deps.isTTY.stdin && deps.isTTY.stdout)) {
    writeLocalFailure(deps, ALLOW_REQUIRES_TTY, json)
    return 1
  }
  deps.stderr.write(
    "This key will be allowed to trade, launch and transfer from the account's embedded wallet, with Candle signing.\n" +
      "A key that only trades its own TEE wallets does not need it.\n",
  )
  const answer = await deps.promptLine("Create the key with the embedded wallet allowed? [y/N] ")
  if (["y", "yes"].includes(answer.trim().toLowerCase())) return null
  writeLocalFailure(
    deps,
    {
      code: "EMBEDDED_WALLET_NOT_ACKNOWLEDGED",
      message: "Not confirmed; no key was created.",
      suggestion: "Run the command again and answer y, or create it with --embedded-wallet deny.",
    },
    json,
  )
  return 1
}

/** `candle keys update <prefix|label> --embedded-wallet allow|deny [--yes]`. Device token only. */
export async function keysUpdate(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--embedded-wallet"], booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [target, extra] = parsed.positionals
  if (target === undefined || extra !== undefined) {
    writeUsageFailure(
      deps,
      `${extra !== undefined ? `Unexpected argument: ${extra}. ` : "Name one key. "}${USAGE_UPDATE}`,
      json,
    )
    return 2
  }
  if (target === "self") {
    writeUsageFailure(
      deps,
      `A key changes its own permission with: candle keys self embedded-wallet deny. ${USAGE_UPDATE}`,
      json,
    )
    return 2
  }
  const flag = parsed.values["--embedded-wallet"]
  if (flag === undefined) {
    writeUsageFailure(deps, `Pass --embedded-wallet allow or deny. ${USAGE_UPDATE}`, json)
    return 2
  }
  const permission = EMBEDDED_WALLET_CHOICES[flag]
  if (permission === undefined) {
    writeUsageFailure(deps, "--embedded-wallet must be allow or deny.", json)
    return 2
  }
  const yes = parsed.booleans.has("--yes")

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }
  const resolved = await resolveTargetKey(ctx, deviceToken, target, {
    codePrefix: "KEY_ACCESS",
    writeListFailure: (result) => writeEmbeddedWalletFailure(ctx, result, { self: false }),
  })
  if (!resolved.ok) return resolved.code
  const path = `${KEYS_PATH}/${encodeURIComponent(resolved.keyPrefix)}/embedded-wallet`
  const call = (body: Record<string, unknown>) =>
    apiRequest(path, {
      method: "PUT",
      body,
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Preview: nothing written. The server decides the direction from the stored value.
  const preview = await call({ permission, dryRun: true })
  if (!preview.ok) return writeEmbeddedWalletFailure(ctx, preview, { self: false })
  const shown = preview.body as EmbeddedWalletResponse
  const name = keyName(shown.keyPrefix, shown.label)
  if (shown.direction === "unchanged") {
    if (json) deps.stdout.write(`${JSON.stringify({ ...shown, command: "keys update" })}\n`)
    else deps.stdout.write(`${name}'s embedded wallet is already ${shown.to}. Nothing changed.\n`)
    return 0
  }

  const widen = shown.direction === "widen"
  const interactive = deps.isTTY.stdin && deps.isTTY.stdout
  if (widen && yes) {
    writeUsageFailure(deps, "--yes only skips the prompt when denying; nothing changed.", json)
    return 2
  }
  if (widen && !interactive) {
    writeLocalFailure(deps, ALLOW_REQUIRES_TTY, json)
    return 1
  }
  if (!widen && !yes && !interactive) {
    writeUsageFailure(
      deps,
      "Denying without a terminal needs --yes; nothing changed. Run it in an interactive shell, or pass --yes.",
      json,
    )
    return 2
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document.
  const fields = effectiveProfileFields(await deps.readConfig(), ctx.profile)
  const account = fields.account ? shortAddress(fields.account) : "unknown"
  const label = labelCell(shown.label ?? undefined)
  deps.stderr.write(
    [
      `Key             ${shown.keyPrefix}${label ? `  ${label}` : ""}`,
      `Candle account  ${fields.username ? `${fields.username}  (${account})` : account}`,
      `API             ${apiUrl}  (${candleEnvironment(apiUrl) ?? "not a Candle host"})`,
      "",
      `Embedded wallet ${shown.from}  ->  ${shown.to}   (${shown.direction})`,
      widen
        ? "It can trade, launch and transfer from the account's embedded wallet as soon as you confirm."
        : "It stops spending the account's embedded wallet from its next request.",
      "",
      "",
    ].join("\n"),
  )

  if (widen) {
    const typed = await deps.promptLine(`Type the key prefix ${shown.keyPrefix} to allow it: `)
    if (typed.trim() !== shown.keyPrefix) {
      writeLocalFailure(
        deps,
        {
          code: "EMBEDDED_WALLET_NOT_ACKNOWLEDGED",
          message: `The acknowledgement is the key prefix ${shown.keyPrefix}; nothing changed.`,
          suggestion: `Run the command again and type ${shown.keyPrefix} at the prompt.`,
        },
        json,
      )
      return 1
    }
  } else if (!yes) {
    const answer = await deps.promptLine(`Deny ${name} the embedded wallet? [y/N] `)
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      writeLocalFailure(
        deps,
        {
          code: "EMBEDDED_WALLET_NOT_ACKNOWLEDGED",
          message: "Not confirmed; nothing changed.",
          suggestion: "Run the command again and answer y, or pass --yes.",
        },
        json,
      )
      return 1
    }
  }

  // Commit: the value the preview showed, compared on the server.
  const committed = await call({ permission, expect: shown.from })
  if (!committed.ok) return writeEmbeddedWalletFailure(ctx, committed, { self: false })
  return writeChanged(ctx, committed.body as EmbeddedWalletResponse, "keys update")
}

/** `candle keys self embedded-wallet deny`: the acting key gives the embedded wallet up. No prompt. */
export async function keysSelf(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [setting, value, extra] = parsed.positionals
  if (setting !== "embedded-wallet" || value === undefined || extra !== undefined) {
    writeUsageFailure(deps, USAGE_SELF, json)
    return 2
  }
  if (value === "allow") {
    // Refused here before any request, and again on the server: a key can never allow itself.
    writeLocalFailure(deps, SELF_CANNOT_ALLOW, json)
    return 1
  }
  if (value !== "deny") {
    writeUsageFailure(deps, `The setting is deny. ${USAGE_SELF}`, json)
    return 2
  }

  await printIdentity(ctx)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, json)
    return 1
  }
  // A rein-in: no preview and no prompt, so a bot box without a terminal can always run it.
  const result = await apiRequest(`${KEYS_PATH}/self/embedded-wallet`, {
    method: "PUT",
    body: { permission: "denied" },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) return writeEmbeddedWalletFailure(ctx, result, { self: true })
  return writeChanged(ctx, result.body as EmbeddedWalletResponse, "keys self")
}

function writeChanged(ctx: CommandContext, result: EmbeddedWalletResponse, command: string): number {
  const { deps, json } = ctx
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...result, command })}\n`)
    return 0
  }
  const name = keyName(result.keyPrefix, result.label)
  if (result.direction === "unchanged") {
    deps.stdout.write(`${name}'s embedded wallet is already ${result.to}. Nothing changed.\n`)
    return 0
  }
  deps.stdout.write(
    `${name}'s embedded wallet is now ${result.to}.${result.changeId ? ` Change id ${result.changeId}` : ""}\n`,
  )
  return 0
}
