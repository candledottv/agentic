/**
 * `candle keys limits <prefix> <asset>=<raw> [<asset>=<raw> ...]` (BE-2691, R54) sets the per-asset
 * spend caps (`maxPerTxRaw`) of a key that already exists, with the profile's own API key.
 *
 * It calls `PUT /api/v1/agent/keys/:prefix/limits`, which takes an agent key or a live session and
 * structurally rejects a device token. So this command can only TIGHTEN: a cap that lowers a stored
 * one, or a first cap where none was set. Raising a cap, dropping one, or clearing them all is
 * LOOSEN_REQUIRES_SESSION from the server, and the owner does that in the web key manager.
 * `keys limit` (singular) is the USD transaction cap, a different control, over the device token.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { fields, heading, success, terminalStyle } from "../presentation"
import { printIdentity } from "../profiles"
import { writeScreenFailure, writeScreenLocalFailure, writeScreenUsageFailure } from "./key-output"

const USAGE = "Usage: candle keys limits <prefix> <asset>=<raw-amount> [<asset>=<raw-amount> ...]"

/** The assets the API recognizes (`SOLANA_ASSETS`, `EVM_ASSETS`), with their base-unit exponents. */
export const KEY_LIMIT_ASSETS: Record<string, number> = { sol: 9, usdc: 6, cndl: 6, eth: 18, usdg: 6 }

const RAW_AMOUNT = /^[1-9][0-9]*$/

const NO_API_KEY = {
  code: "API_KEY_REQUIRED",
  message: "candle keys limits changes caps with an API key, and this profile holds none.",
  suggestion: "Select the profile holding the key with --profile. A device token cannot set per-asset caps.",
}

const LOOSEN_HINT =
  "This command can only lower a cap. Raising or removing one needs the owner's session: use the web key manager."

export async function keysLimits(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { keyPrefixPositional: true })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  const target = parsed.positionals[0]
  const caps = parsed.positionals.slice(1)
  if (!target || caps.length === 0) {
    writeScreenUsageFailure(deps, USAGE, json)
    return 2
  }
  const limits: { asset: string; maxPerTxRaw: string }[] = []
  for (const cap of caps) {
    const eq = cap.indexOf("=")
    const asset = (eq < 0 ? cap : cap.slice(0, eq)).toLowerCase()
    const raw = eq < 0 ? "" : cap.slice(eq + 1)
    if (!(asset in KEY_LIMIT_ASSETS)) {
      writeScreenUsageFailure(deps, `The asset must be one of: ${Object.keys(KEY_LIMIT_ASSETS).join(", ")}.`, json)
      return 2
    }
    if (!RAW_AMOUNT.test(raw)) {
      writeScreenUsageFailure(
        deps,
        `${asset}=<raw> takes a positive whole number of base units (${asset} has ${KEY_LIMIT_ASSETS[asset]} decimals), with no sign, decimal point or leading zero.`,
        json,
      )
      return 2
    }
    if (limits.some((limit) => limit.asset === asset)) {
      writeScreenUsageFailure(deps, `${asset} is named twice.`, json)
      return 2
    }
    limits.push({ asset, maxPerTxRaw: raw })
  }

  await printIdentity(ctx)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeScreenLocalFailure(deps, NO_API_KEY, json)
    return 1
  }
  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(target)}/limits`, {
    method: "PUT",
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: { limits },
  })
  if (!result.ok) {
    if (!json && result.code === "LOOSEN_REQUIRES_SESSION")
      writeScreenLocalFailure(
        deps,
        {
          code: "LOOSEN_REQUIRES_SESSION",
          message: "That would raise or remove a cap; nothing changed.",
          suggestion: LOOSEN_HINT,
        },
        json,
      )
    else writeScreenFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }
  const stored = (result.body as { limits?: { asset: string; maxPerTxRaw: string }[] | null }).limits ?? limits
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: true, keyPrefix: target, limits: stored })}\n`)
    return 0
  }
  const style = terminalStyle(deps, "stdout")
  const rows: [string, string][] = [
    ["Key", target],
    ...stored.map((limit): [string, string] => [limit.asset, `${limit.maxPerTxRaw} base units per transaction`]),
  ]
  deps.stdout.write(
    `${success("Per-asset caps updated", style)}\n\n${heading("Caps", style)}\n${fields(rows, style).join("\n")}\n`,
  )
  return 0
}
