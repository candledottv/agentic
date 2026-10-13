import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { terminalText, writeFailure, writeUsageFailure } from "../render"
import { tradingKey } from "../trading"
import { tradingFailure } from "./swap"

const USAGE =
  "Usage: candle agent post create --text <text> [--chain <solana|hood> --mint <address>] | delete <post-id> | list [profile-id] [--limit <n>] [--cursor <cursor>]"

/** The flags each action takes. A flag of another action is a usage error, not ignored. */
const ACTION_FLAGS = {
  create: ["--text", "--chain", "--mint"],
  delete: [],
  list: ["--limit", "--cursor"],
} as const
type Action = keyof typeof ACTION_FLAGS

/**
 * `candle agent post`: publish, delete and read the posts on an agent's own public page. `create`
 * and `delete` act as the calling key's profile and need an acting key the owner lets edit its
 * page. `list` is the public read: with no profile id it reads the calling key's own profile.
 */
export async function agentPost(args: string[], ctx: CommandContext): Promise<number> {
  const usage = (message = USAGE) => {
    writeUsageFailure(ctx.deps, message, ctx.json)
    return 2
  }
  const action = args[0] as Action | undefined
  if (action === undefined || !Object.hasOwn(ACTION_FLAGS, action)) return usage()
  const parsed = parseArgs(args.slice(1), { valueFlags: [...ACTION_FLAGS[action]] })
  if ("error" in parsed) return usage(`${parsed.error}\n${USAGE}`)
  const { values, positionals } = parsed

  const request = (path: string, init: { method?: "POST" | "DELETE"; body?: unknown; key?: string }) =>
    apiRequest(path, {
      apiUrl: ctx.apiUrl,
      ...(init.key !== undefined
        ? { credentials: { apiKey: init.key }, auth: "key" as const }
        : { credentials: {}, auth: "none" as const }),
      ...(init.method ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })

  let plan: (key: () => Promise<string>) => Promise<Awaited<ReturnType<typeof apiRequest>>>
  let authType: "key" | "none" = "key"
  if (action === "create") {
    const text = values["--text"]
    const chain = values["--chain"]
    const mint = values["--mint"]
    if (positionals.length || text === undefined) return usage()
    if ((chain === undefined) !== (mint === undefined)) return usage(`--chain and --mint go together\n${USAGE}`)
    if (chain !== undefined && chain !== "solana" && chain !== "hood") {
      return usage(`--chain must be solana or hood\n${USAGE}`)
    }
    const body = { text, ...(chain !== undefined ? { token: { chain, mint } } : {}) }
    plan = async (key) => request("/api/v1/agent/posts", { method: "POST", body, key: await key() })
  } else if (action === "delete") {
    const postId = positionals[0]
    if (positionals.length !== 1 || !postId) return usage()
    plan = async (key) =>
      request(`/api/v1/agent/posts/${encodeURIComponent(postId)}`, { method: "DELETE", key: await key() })
  } else {
    if (positionals.length > 1) return usage()
    const limit = values["--limit"]
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) return usage(`--limit must be a whole number\n${USAGE}`)
    const query = new URLSearchParams({
      ...(limit !== undefined ? { limit } : {}),
      ...(values["--cursor"] !== undefined ? { cursor: values["--cursor"] } : {}),
    })
    const read = (profileId: string) =>
      request(`/api/v1/agent/records/${encodeURIComponent(profileId)}/posts${query.size ? `?${query}` : ""}`, {})
    const named = positionals[0]
    if (named !== undefined) {
      // Public: no key is read or sent for a profile named on the command line.
      authType = "none"
      plan = () => read(named)
    } else {
      plan = async (key) => {
        const own = await request("/api/v1/agent/keys/self/public-profile", { key: await key() })
        if (!own.ok) return own
        authType = "none"
        return read(String((own.body as { profileId?: unknown }).profileId))
      }
    }
  }

  try {
    const result = await plan(() => tradingKey(ctx))
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType }, ctx.json)
      return 1
    }
    const output = JSON.stringify(result.body, null, ctx.json ? undefined : 2)
    ctx.deps.stdout.write(`${ctx.json ? output : terminalText(output)}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
