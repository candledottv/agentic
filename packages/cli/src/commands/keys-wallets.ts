/**
 * `keys wallets`: read and set which wallets one agent profile (API key) may spend from.
 *
 * Agent-key authenticated, not device-token: these routes are on the same dual-auth surface as
 * `GET /wallets`, and the wallet ids this command deals in are the ones `candle wallet` already
 * prints, so an operator can pipe one straight into the other.
 *
 * The scope and the assignment list are separate subcommands because they are separate
 * decisions. Both are privileged in the same direction: an API key may only ever REDUCE its own
 * profile's reach. It can drop wallets from its own set and it can scope itself, but granting a
 * wallet, widening back to every wallet, or touching another profile all need a browser session.
 * Those refusals are relayed with the API's own message rather than a locally-invented one, so
 * the CLI cannot drift from the rule it is reporting.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { printIdentity } from "../profiles"
import { renderTable, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"

const NO_API_KEY = {
  code: "NO_API_KEY",
  message: "No API key for this profile.",
  suggestion: "Set CANDLE_API_KEY, or run `candle keys create` and store one.",
}

interface ProfileWalletRow {
  linkedWalletId: string
  assignedAt: number
  chain: string
  address: string
  label?: string
  spendCapable: boolean
}

interface ProfileWalletsResponse {
  keyPrefix: string
  profileId: string | null
  walletScope: "all" | "selected"
  wallets: ProfileWalletRow[]
}

function formatTimestamp(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-"
}

/** `candle keys wallets <prefix>` */
export async function keysWalletsList(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const prefix = parsed.positionals[0]
  if (!prefix) {
    writeUsageFailure(deps, "Usage: candle keys wallets <prefix>", json)
    return 2
  }

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, json)
    return 1
  }

  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(prefix)}/wallets`, {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }

  const body = result.body as ProfileWalletsResponse
  // Stated before the table, not after it, because it changes what the table MEANS: the same
  // empty list is "everything" under `all` and "nothing" under `selected`.
  deps.stdout.write(
    body.walletScope === "selected"
      ? `Scope: selected — this profile can only spend from the wallets below.\n`
      : `Scope: all — this profile can spend from every wallet on the account, listed here or not.\n`,
  )
  if (body.profileId) deps.stdout.write(`Profile: ${body.profileId}\n`)

  if (body.wallets.length === 0) {
    deps.stdout.write("No wallets assigned.\n")
    return 0
  }
  const rows = body.wallets.map((w) => [
    w.linkedWalletId,
    w.chain,
    w.address,
    w.label ?? "-",
    w.spendCapable ? "yes" : "no",
    formatTimestamp(w.assignedAt),
  ])
  deps.stdout.write(`${renderTable(["Id", "Chain", "Address", "Label", "Can sign", "Assigned"], rows)}\n`)
  return 0
}

/** `candle keys wallets set <prefix> --wallets <id,id>` (or `--wallets ""` to clear) */
export async function keysWalletsSet(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--wallets"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const prefix = parsed.positionals[0]
  if (!prefix) {
    writeUsageFailure(deps, "Usage: candle keys wallets set <prefix> --wallets <id,id,...>", json)
    return 2
  }
  const raw = parsed.values["--wallets"]
  if (raw === undefined) {
    writeUsageFailure(deps, 'Missing --wallets. Pass a comma-separated list, or "" to assign none.', json)
    return 2
  }
  // A REPLACE, so an empty value is a meaningful instruction ("assign nothing"), not a mistake.
  const walletIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, json)
    return 1
  }

  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(prefix)}/wallets`, {
    method: "PUT",
    body: { walletIds },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }
  deps.stdout.write(
    walletIds.length === 0
      ? `Cleared every wallet assignment on ${prefix}.\n`
      : `Assigned ${walletIds.length} wallet${walletIds.length === 1 ? "" : "s"} to ${prefix}.\n`,
  )
  return 0
}

/** `candle keys wallets scope <prefix> --scope <all|selected>` */
export async function keysWalletsScope(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--scope"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const prefix = parsed.positionals[0]
  const scope = parsed.values["--scope"]
  if (!prefix || (scope !== "all" && scope !== "selected")) {
    writeUsageFailure(deps, "Usage: candle keys wallets scope <prefix> --scope <all|selected>", json)
    return 2
  }

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, json)
    return 1
  }

  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(prefix)}/wallet-scope`, {
    method: "PUT",
    body: { scope },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    // Widening is session-only, and the API says so in its own words. Reported as-is rather
    // than reworded here, so the CLI cannot drift from the rule it is reporting.
    writeFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }
  deps.stdout.write(
    scope === "selected"
      ? `${prefix} is now limited to its assigned wallets.\n`
      : `${prefix} can now spend from every wallet on the account.\n`,
  )
  return 0
}

/**
 * `candle keys wallets [set|scope] ...`
 *
 * The dispatch table in index.ts routes two words, and this command needs three, so the verb is
 * resolved here rather than by adding a nesting level to a table that nothing else needs it for.
 * A bare `keys wallets <prefix>` reads; `set` and `scope` write.
 */
export async function keysWallets(args: string[], ctx: CommandContext): Promise<number> {
  const [verb, ...rest] = args
  if (verb === "set") return keysWalletsSet(rest, ctx)
  if (verb === "scope") return keysWalletsScope(rest, ctx)
  return keysWalletsList(args, ctx)
}
