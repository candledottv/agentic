/**
 * `candle launch status <mint-or-client-launch-id> [--wait]` (BE-2573, W8).
 *
 * Reads GET /api/v1/launch/status/:id. One state: build, signed, confirmed, trading,
 * bonded, migrated. `--wait` polls until the token is trading (or further along), the
 * launch has failed, or ten minutes pass. It never sends a transaction.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { type Json, request, safeText, tradingKey } from "../trading"
import { printTradingResult, tradingFailure, validClientId } from "./swap"

const USAGE = "Usage: candle launch status <mint-or-client-launch-id> [--wait]"

/** Same bound as `candle swap status --wait`. */
const LAUNCH_WAIT_MS = 10 * 60 * 1000
const LAUNCH_WAIT_POLL_MS = 10_000

const LIVE = new Set(["trading", "bonded", "migrated"])

function statusOf(body: Json): Json | null {
  const status = body.status
  return status !== null && typeof status === "object" && !Array.isArray(status) ? (status as Json) : null
}

function isFinal(status: Json | null): boolean {
  if (!status) return false
  if (status.failed === true) return true
  return typeof status.state === "string" && LIVE.has(status.state)
}

function humanLines(status: Json): string[] {
  const lines = [`state: ${safeText(String(status.state ?? ""))}`]
  if (status.failed === true) lines.push("failed: true")
  if (typeof status.errorCode === "string") lines.push(`error: ${safeText(status.errorCode)}`)
  if (typeof status.chain === "string") lines.push(`chain: ${safeText(status.chain)}`)
  if (typeof status.mint === "string") lines.push(`mint: ${safeText(status.mint)}`)
  if (typeof status.clientLaunchId === "string") lines.push(`clientLaunchId: ${safeText(status.clientLaunchId)}`)
  if (typeof status.lifecycle === "string") lines.push(`lifecycle: ${safeText(status.lifecycle)}`)
  const migration = status.migration
  if (migration !== null && typeof migration === "object" && !Array.isArray(migration)) {
    const block = migration as Json
    const progress = typeof block.progressBps === "number" ? ` ${String(block.progressBps)} bps` : ""
    if (typeof block.status === "string") lines.push(`migration: ${safeText(block.status)}${progress}`)
  }
  if (typeof status.signature === "string") lines.push(`signature: ${safeText(status.signature)}`)
  return lines
}

async function readStatus(ctx: CommandContext, key: string, id: string): Promise<Json> {
  return request(ctx, key, `/api/v1/launch/status/${encodeURIComponent(id)}`)
}

export async function launchStatus(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { booleanFlags: ["--wait"] })
  if ("error" in parsed || parsed.positionals.length !== 1 || !validClientId(parsed.positionals[0] ?? "")) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  const id = parsed.positionals[0] as string
  const wait = parsed.booleans.has("--wait")
  try {
    const key = await tradingKey(ctx)
    let body = await readStatus(ctx, key, id)
    if (wait) {
      const deadline = ctx.deps.now() + LAUNCH_WAIT_MS
      while (!isFinal(statusOf(body)) && ctx.deps.now() < deadline) {
        await ctx.deps.sleep(LAUNCH_WAIT_POLL_MS)
        body = await readStatus(ctx, key, id)
      }
      const final = isFinal(statusOf(body))
      if (!final) {
        notice(
          ctx.deps,
          "stderr",
          "note",
          `Still not trading after ten minutes. Re-check with candle launch status ${safeText(id)} --wait.`,
        )
      }
      body = { ...body, waited: { final } }
    }
    if (ctx.json) return printTradingResult(ctx, body)
    const status = statusOf(body)
    if (!status) return printTradingResult(ctx, body)
    ctx.deps.stdout.write(`${humanLines(status).join("\n")}\n`)
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
