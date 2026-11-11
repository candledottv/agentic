/**
 * `candle keys rotate <prefix|label>` gives an existing key a new secret (BE-2648). The API keeps
 * the key's prefix and row, so its label, scopes, limits, wallets, TEE binds, signer and history
 * stay; only the secret changes. The old secret keeps working through a grace window (`--grace`,
 * default 1h, at most 24h), or stops at once with `--now`. `--finish` ends an open window early.
 *
 *   POST /api/v1/agent/keys/:prefix/rotate         { graceSeconds, force? }
 *   POST /api/v1/agent/keys/:prefix/rotate/finish
 *
 * When the target is this profile's own stored key, the new secret replaces it in the keychain slot,
 * the way `auth login` stores one. A copy anywhere else (`CANDLE_API_KEY`, a VPS env file, an MCP
 * client config) is out of reach: the command says to update it before the window ends.
 */

import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken, resolveExternalApiCredential } from "../deps"
import { bold, fields, notice, success, terminalStyle } from "../presentation"
import { apiKeyPrefix, effectiveProfileFields, printIdentity, profileSecretRef } from "../profiles"
import { formatTime } from "../render"
import { SECRET_REFS } from "../secret-store"
import { writeScreenFailure, writeScreenLocalFailure, writeScreenUsageFailure } from "./key-output"
import { NO_DEVICE_TOKEN } from "./keys"
import { resolveTargetKey } from "./tee-rebind"
import { EXIT_OUTCOME_UNKNOWN } from "./token-pages"

const USAGE =
  "Usage: candle keys rotate <prefix|label> [--grace <duration> | --now] [--force] [--yes] [--idempotency-key <key>]\n       candle keys rotate <prefix|label> --finish"

/** The API's bound on a grace window: one day. */
export const MAX_GRACE_SECONDS = 86_400
const DEFAULT_GRACE_SECONDS = 3_600

/**
 * A grace window: `0`, a bare number of seconds, or a number with `s`, `m` or `h` (`90s`, `30m`,
 * `24h`). Whole seconds from 0 to 24h.
 */
export function parseGrace(raw: string): { ok: true; seconds: number } | { ok: false; message: string } {
  const match = raw.trim().match(/^(\d+)(s|m|h)?$/)
  const bad = { ok: false as const, message: "--grace must be a duration such as 0, 90s, 30m or 24h (at most 24h)." }
  if (!match) return bad
  const unit = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1
  const seconds = Number(match[1]) * unit
  if (!Number.isSafeInteger(seconds) || seconds > MAX_GRACE_SECONDS) return bad
  return { ok: true, seconds }
}

interface RotateBody {
  key: string
  keyPrefix: string
  rotatedAt: number
  previousValidUntil: number | null
}

export async function keysRotate(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--grace", "--idempotency-key"],
    booleanFlags: ["--now", "--finish", "--force", "--yes"],
    keyPrefixPositional: true,
  })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  const target = parsed.positionals[0]
  if (!target || parsed.positionals.length !== 1) {
    writeScreenUsageFailure(deps, USAGE, json)
    return 2
  }
  const finish = parsed.booleans.has("--finish")
  const now = parsed.booleans.has("--now")
  const force = parsed.booleans.has("--force")
  const graceFlag = parsed.values["--grace"]
  const keyFlag = parsed.values["--idempotency-key"]
  if (finish && (now || force || graceFlag !== undefined || keyFlag !== undefined)) {
    writeScreenUsageFailure(deps, "--finish takes no other rotation flag.", json)
    return 2
  }
  if (now && graceFlag !== undefined) {
    writeScreenUsageFailure(deps, "Pass --grace or --now, not both.", json)
    return 2
  }
  if (keyFlag !== undefined && (keyFlag.length < 1 || keyFlag.length > 128)) {
    writeScreenUsageFailure(deps, "--idempotency-key must be 1 to 128 characters.", json)
    return 2
  }
  const idempotencyKey = keyFlag ?? randomUUID()
  let graceSeconds = now ? 0 : DEFAULT_GRACE_SECONDS
  if (graceFlag !== undefined) {
    const grace = parseGrace(graceFlag)
    if (!grace.ok) {
      writeScreenUsageFailure(deps, grace.message, json)
      return 2
    }
    graceSeconds = grace.seconds
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeScreenLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }
  // One owner-authenticated POST. A connection failure (status 0, no answer, or a body cut off
  // after the headers) is retried once with the same body and key; a second one is "unknown".
  const send = async (url: string, body: unknown, key?: string): Promise<ApiResult | "unknown"> => {
    const attempt = async (): Promise<ApiResult> => {
      try {
        return await apiRequest(url, {
          method: "POST",
          auth: "device",
          credentials: { deviceToken },
          apiUrl,
          fetch: deps.fetch,
          env: deps.env,
          body,
          ...(key ? { headers: { "Idempotency-Key": key } } : {}),
        })
      } catch {
        return { ok: false, status: 0, message: "The response was cut off before it finished.", raw: undefined }
      }
    }
    const first = await attempt()
    if (first.ok || first.status !== 0 || first.code) return first
    const second = await attempt()
    return second.ok || second.status !== 0 || second.code ? second : "unknown"
  }
  // A 503 here is the identity service not ready (`rotation_verifier_not_ready`): nothing changed.
  const writeRefusal = (result: Extract<ApiResult, { ok: false }>): number => {
    if (result.status === 503) {
      writeScreenLocalFailure(
        deps,
        {
          code: "IDENTITY_UNAVAILABLE",
          message: "Candle could not rotate keys right now. The old secret is unchanged.",
          suggestion: `Retry in about 30 seconds: candle keys rotate ${keyPrefix}${finish ? " --finish" : ""}`,
        },
        json,
      )
      return 1
    }
    writeScreenFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }
  const resolved = await resolveTargetKey(ctx, deviceToken, target, { codePrefix: "KEY_ROTATE" })
  if (!resolved.ok) return resolved.code
  const keyPrefix = resolved.keyPrefix
  const path = `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/rotate`

  if (finish) {
    // Finishing is idempotent, so a retry needs no key.
    const result = await send(`${path}/finish`, {})
    if (result === "unknown") {
      writeScreenLocalFailure(
        deps,
        {
          code: "OUTCOME_UNKNOWN",
          message: "Candle did not answer, twice, so whether the rotation was finished is not known.",
          suggestion: `Rerun: candle keys rotate ${keyPrefix} --finish`,
        },
        json,
      )
      return EXIT_OUTCOME_UNKNOWN
    }
    if (!result.ok) return writeRefusal(result)
    const changed = (result.body as { changed?: boolean } | null)?.changed === true
    if (json) {
      deps.stdout.write(`${JSON.stringify({ ok: true, keyPrefix, changed })}\n`)
      return 0
    }
    const style = terminalStyle(deps, "stdout")
    deps.stdout.write(
      `${success(changed ? "Rotation finished: the old secret has stopped working" : "No rotation was open", style)}\n`,
    )
    return 0
  }

  // A rotation cannot be undone, and it ends every copy of the old secret when its window does.
  if (!parsed.booleans.has("--yes")) {
    if (!deps.isTTY.stdin) {
      writeScreenUsageFailure(deps, "Rotating a key needs confirmation. Run it at a terminal, or pass --yes.", json)
      return 2
    }
    const window = graceSeconds === 0 ? "at once" : `in ${graceLabel(graceSeconds)}`
    const answer = await deps.promptLine(
      `Rotate ${keyPrefix}? The old secret stops working ${window}. Type the prefix to confirm: `,
    )
    if (answer.trim() !== keyPrefix) {
      writeScreenLocalFailure(deps, { code: "KEY_ROTATE_CANCELLED", message: "Not rotated." }, json)
      return 1
    }
  }

  const result = await send(path, { graceSeconds, ...(force ? { force: true } : {}) }, idempotencyKey)
  if (result === "unknown") {
    // The first attempt may have landed. The same key returns that result instead of rotating again;
    // a plain rerun would hit the open window, and --force would end the secret that was never seen.
    writeScreenLocalFailure(
      deps,
      {
        code: "OUTCOME_UNKNOWN",
        message: "Candle did not answer, twice, so whether the key was rotated is not known.",
        suggestion: `Rerun the same command with --idempotency-key ${idempotencyKey}: Candle returns the first secret instead of rotating again.`,
        details: { idempotencyKey },
      },
      json,
    )
    return EXIT_OUTCOME_UNKNOWN
  }
  if (!result.ok) return writeRefusal(result)
  const body = result.body as RotateBody

  // The profile's own key: write the new secret into its slot. Captured, not thrown, as `keys create`
  // does, so a failed store still prints the one copy of the secret.
  const config = await deps.readConfig()
  const ownKey = effectiveProfileFields(config, ctx.profile).keyPrefix === keyPrefix
  let stored = false
  let storeError: string | undefined
  if (ownKey) {
    try {
      await deps.store.set(ctx.profile ? profileSecretRef(ctx.profile, "apiKey") : SECRET_REFS.apiKey, body.key)
      stored = true
    } catch (error) {
      storeError = error instanceof Error ? error.message : String(error)
    }
  }
  // Stale-warning provenance only; the replacement secret is already issued, so nothing here may throw.
  let credential: Awaited<ReturnType<typeof resolveExternalApiCredential>>
  try {
    credential = await resolveExternalApiCredential(deps)
  } catch {
    credential = undefined
  }
  const namesKey = credential?.key !== undefined && apiKeyPrefix(credential.key) === keyPrefix
  const envNamesKey = credential?.source === "env" && namesKey
  const fileNamesKey = credential?.source === "file" && namesKey
  const until = body.previousValidUntil

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        ...body,
        stored,
        ...(storeError ? { storeError } : {}),
        ...(envNamesKey ? { candleApiKeyStale: true } : {}),
        ...(fileNamesKey ? { candleApiKeyFileStale: true } : {}),
      })}\n`,
    )
    return storeError ? 1 : 0
  }

  const style = terminalStyle(deps, "stdout")
  deps.stdout.write(`${success("API key rotated", style)}\n\n  ${bold(body.key, style)}\n`)
  notice(deps, "stdout", "warning", "Shown once. Store it now.")
  deps.stdout.write(
    `${fields(
      [
        ["Prefix", keyPrefix],
        ["Old secret", until === null ? "stopped" : `works until ${formatTime(until)}`],
        [
          "Stored",
          storeError !== undefined
            ? "no (store failed)"
            : stored
              ? `${deps.backend}, replacing this CLI's working key`
              : "no (not this CLI's working key)",
        ],
      ],
      style,
    ).join("\n")}\n`,
  )
  const deadline = until === null ? "now" : `before ${formatTime(until)}`
  if (fileNamesKey) {
    notice(
      deps,
      "stderr",
      "warning",
      `CANDLE_API_KEY_FILE still holds the old secret. The file was not updated. Replace it ${deadline} and restart MCP.`,
    )
  }
  if (envNamesKey) {
    notice(
      deps,
      "stderr",
      "warning",
      `CANDLE_API_KEY holds the old secret, and this CLI cannot change it. Update CANDLE_API_KEY where this key is deployed ${deadline}.`,
    )
  }
  if (!stored) {
    notice(
      deps,
      "stdout",
      "note",
      `Update every other place this key is stored (env files, MCP client configs) ${deadline}.${until === null ? "" : `\nEnd the old secret early with: candle keys rotate ${keyPrefix} --finish`}`,
    )
  }
  if (storeError !== undefined) {
    notice(
      deps,
      "stderr",
      "warning",
      `The new secret was NOT stored in the ${deps.backend} store: ${storeError}\nSave it now: the key is rotated on your account.`,
    )
  }
  return storeError === undefined ? 0 : 1
}

function graceLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds}s`
}
