import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { terminalText, writeFailure, writeUsageFailure } from "../render"
import { tradingKey } from "../trading"
import { tradingFailure } from "./swap"

const FLAGS = {
  "--bio": "publicThesis",
  "--strategy": "publicStrategy",
  "--strategy-note": "publicStrategyNote",
  "--avatar": "publicAvatar",
  "--banner": "publicBanner",
  "--models": "publicModels",
  "--links": "publicLinks",
} as const
const USAGE =
  "Usage: candle agent profile show | set [--bio <text>] [--strategy <tag>] [--strategy-note <text>] [--models <comma-separated>] [--links <JSON>] [--avatar <URL>] [--banner <URL>]"

export async function agentProfile(args: string[], ctx: CommandContext): Promise<number> {
  const action = args[0]
  const parsed = parseArgs(args.slice(1), { valueFlags: Object.keys(FLAGS) })
  if (
    "error" in parsed ||
    (action !== "show" && action !== "set") ||
    parsed.positionals.length ||
    (action === "show" && Object.keys(parsed.values).length) ||
    (action === "set" && !Object.keys(parsed.values).length)
  ) {
    writeUsageFailure(ctx.deps, "error" in parsed ? `${parsed.error}\n${USAGE}` : USAGE, ctx.json)
    return 2
  }
  const patch: Record<string, unknown> = {}
  for (const [flag, value] of Object.entries(parsed.values)) {
    const field = FLAGS[flag as keyof typeof FLAGS]
    if (field === "publicModels") patch[field] = value === "" ? null : value?.split(",").map((item) => item.trim())
    else if (field === "publicLinks") {
      try {
        patch[field] = JSON.parse(value ?? "")
      } catch {
        writeUsageFailure(ctx.deps, "--links must be JSON (website and x, or null)", ctx.json)
        return 2
      }
    } else patch[field] = value
  }
  try {
    const key = await tradingKey(ctx)
    const result = await apiRequest("/api/v1/agent/keys/self/public-profile", {
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key",
      method: action === "show" ? "GET" : "PATCH",
      ...(action === "set" ? { body: patch } : {}),
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
      return 1
    }
    const output = JSON.stringify(result.body, null, ctx.json ? undefined : 2)
    ctx.deps.stdout.write(`${ctx.json ? output : terminalText(output)}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
