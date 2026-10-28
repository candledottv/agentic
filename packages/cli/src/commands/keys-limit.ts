/**
 * `candle keys limit <prefix|label>` sets or clears the USD transaction cap on a key that
 * already exists. `keys create --tx-limit` is the only other path; the API already accepts
 * `PATCH /keys/:prefix` with exactly `{ txLimit }` or `{ clearTxLimit: true }`.
 */

import { parseArgs, parseUsdToMicros, TX_LIMIT_RESETS, type TxLimitReset } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { fields, heading, success, terminalStyle } from "../presentation"
import { printIdentity } from "../profiles"
import { writeScreenFailure, writeScreenLocalFailure, writeScreenUsageFailure } from "./key-output"
import { NO_DEVICE_TOKEN } from "./keys"
import { resolveTargetKey } from "./tee-rebind"

const USAGE =
  "Usage: candle keys limit <prefix|label> (--tx-limit <usd> [--reset daily|weekly|monthly|never] | --clear)"

export async function keysLimit(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--tx-limit", "--reset"], booleanFlags: ["--clear"] })
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  const target = parsed.positionals[0]
  if (!target || parsed.positionals.length !== 1) {
    writeScreenUsageFailure(deps, USAGE, json)
    return 2
  }
  const clear = parsed.booleans.has("--clear")
  const usd = parsed.values["--tx-limit"]
  const resetFlag = parsed.values["--reset"]
  if (clear === (usd !== undefined)) {
    writeScreenUsageFailure(deps, clear ? "Pass --tx-limit or --clear, not both." : USAGE, json)
    return 2
  }
  if (resetFlag !== undefined && usd === undefined) {
    writeScreenUsageFailure(deps, "--reset requires --tx-limit.", json)
    return 2
  }
  let txLimit: { usdMicros: number; reset: TxLimitReset } | undefined
  if (usd !== undefined) {
    const parsedUsd = parseUsdToMicros(usd)
    if (!parsedUsd.ok) {
      writeScreenUsageFailure(deps, parsedUsd.message, json)
      return 2
    }
    const reset = (resetFlag ?? "daily") as TxLimitReset
    if (!TX_LIMIT_RESETS.includes(reset)) {
      writeScreenUsageFailure(deps, `--reset must be one of: ${TX_LIMIT_RESETS.join(", ")}.`, json)
      return 2
    }
    txLimit = { usdMicros: parsedUsd.usdMicros, reset }
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeScreenLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }
  const resolved = await resolveTargetKey(ctx, deviceToken, target, { codePrefix: "KEY_LIMIT" })
  if (!resolved.ok) return resolved.code

  const body = clear ? { clearTxLimit: true } : { txLimit }
  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(resolved.keyPrefix)}`, {
    method: "PATCH",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body,
  })
  if (!result.ok) {
    writeScreenFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: true, keyPrefix: resolved.keyPrefix, ...body })}\n`)
    return 0
  }
  const style = terminalStyle(deps, "stdout")
  const rows: [string, string][] = clear
    ? [["Key", resolved.keyPrefix]]
    : [
        ["Key", resolved.keyPrefix],
        ["USD limit", usd ?? ""],
        ["Resets", txLimit?.reset ?? "daily"],
      ]
  deps.stdout.write(
    `${success(clear ? "Transaction limit cleared" : "Transaction limit updated", style)}\n\n${heading("Limit", style)}\n${fields(rows, style).join("\n")}\n`,
  )
  return 0
}
