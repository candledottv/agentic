import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { success, terminalStyle } from "../presentation"
import { printIdentity } from "../profiles"
import { writeScreenFailure, writeScreenLocalFailure, writeScreenUsageFailure } from "./key-output"
import { NO_DEVICE_TOKEN } from "./keys"

export function keysStop(args: string[], ctx: CommandContext): Promise<number> {
  return setKeyPaused(args, ctx, true)
}

export function keysResume(args: string[], ctx: CommandContext): Promise<number> {
  return setKeyPaused(args, ctx, false)
}

async function setKeyPaused(args: string[], ctx: CommandContext, paused: boolean): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeScreenUsageFailure(deps, parsed.error, json)
    return 2
  }
  const prefix = parsed.positionals[0]
  if (!prefix?.trim() || parsed.positionals.length !== 1) {
    writeScreenUsageFailure(deps, `Usage: candle keys ${paused ? "stop" : "resume"} <prefix>`, json)
    return 2
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeScreenLocalFailure(deps, NO_DEVICE_TOKEN, json)
    return 1
  }

  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(prefix)}/stop`, {
    method: "POST",
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
    body: { paused },
  })
  if (!result.ok) {
    writeScreenFailure(deps, result, { apiUrl, authType: "device" }, json)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }

  const body = result.body as { paused: boolean; changed: boolean }
  const state = body.paused ? "stopped" : "resumed"
  deps.stdout.write(
    `${success(`Key ${prefix} ${body.changed ? "" : "already "}${state}.`, terminalStyle(deps, "stdout"))}\n`,
  )
  return 0
}
