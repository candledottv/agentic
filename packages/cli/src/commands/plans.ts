/**
 * `candle plans [--json]` (BE-723, Plans v2 P6): the plan table in force on the API this profile
 * points at, from `GET /api/v1/agent/plans`.
 *
 * Every price, fee and limit here is the server's: the CLI bundles none of them, so it cannot
 * quote a number the server is not charging (PL-ED-1). One row per capability (PL-ED-14), rendered
 * by `plans.ts`, the SDK's own module, so the CLI, the MCP server and the docs say it in the same
 * words. A capability a newer server adds is shown under its own key.
 *
 * It reads no credential and sends none: the route is public, and the table holds nothing about
 * any account. Which plan this account is on is `candle doctor`'s Plan row. So it is in
 * `NEVER_GUARDED`, like `verify`, and answers before any account check.
 *
 * `--json` is the server's body unchanged. A server that predates the table answers 404, which is
 * reported as such rather than as an empty table.
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { type AgentPlansResult, PLAN_CAPABILITY_NOTE, planPromotionLine, planTableRows } from "../plans"
import { renderTable, terminalText, writeFailure, writeUsageFailure } from "../render"

const USAGE = "Usage: candle plans"

export async function plans(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed || parsed.positionals.length > 0) {
    writeUsageFailure(ctx.deps, "error" in parsed ? `${parsed.error}\n${USAGE}` : USAGE, ctx.json)
    return 2
  }
  const result = await apiRequest("/api/v1/agent/plans", {
    auth: "none",
    credentials: {},
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    if (result.status === 404 && !ctx.json) {
      ctx.deps.stderr.write(`${ctx.apiUrl} does not serve the plan table yet (GET /api/v1/agent/plans answered 404).\n`)
      return 1
    }
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
    return 1
  }
  const body = result.body as AgentPlansResult
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify(body)}\n`)
    return 0
  }
  const { headers, rows } = planTableRows(body)
  const out = ctx.deps.stdout
  out.write(`Plans served by ${ctx.apiUrl}\n\n`)
  out.write(
    `${renderTable(
      headers.map(terminalText),
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
  const promotion = planPromotionLine(body)
  if (promotion) out.write(`\n${promotion}\n`)
  out.write(`\n${PLAN_CAPABILITY_NOTE}\n`)
  out.write(
    "\nThe agent trade fee is charged on top of each trade or dev buy the API builds. Your account's plan: candle doctor.\n",
  )
  return 0
}
