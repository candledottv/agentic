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
import { writeFields, writeSuccess, writeTable } from "../human-output"
import { notice, symbols, terminalStyle } from "../presentation"
import { printIdentity } from "../profiles"
import { formatTime } from "../render"
import {
  writeScreenFailure as writeFailure,
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"

const NO_API_KEY = {
  code: "NO_API_KEY",
  message: "No API key for this profile.",
  suggestion: "Set CANDLE_API_KEY, or run `candle keys create` and store one.",
}

/**
 * The suggestion on a refused widening of a wallet set. The refusal itself stays the API's own
 * message; what changes is where it points. An agent asked to "make this key use these wallets"
 * reads `keys wallets set`, hits LOOSEN_REQUIRES_SESSION, and never finds `tee rebind`, which is
 * the owner's move for TEE wallets and the command that was wanted (2026-09-24). So the hint names
 * both ways forward, with the rebind spelled out for exactly the wallets and key this call named.
 * BE-362 adds the third case: a wallet already bound to this key but missing from its set, where
 * the rebind answers "Nothing to move" and only a signed-in grant repairs it.
 */
export function widenRefusedHint(prefix: string, walletIds: string[]): string {
  const wallets = walletIds.length > 0 ? walletIds.join(" ") : "<wallet...>"
  return (
    `To move TEE wallets to this key, run: candle tee rebind ${wallets} --to-key ${prefix} ` +
    "(owner, device token; --label-prefix <p> names many at once). To grant a linked wallet to the key " +
    "instead, use the agent console's Agents tab in a signed-in session. If `tee rebind` says the wallets " +
    "are already bound, grant them to the key in the agent console's Agents tab (signed in)."
  )
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
  notice(
    deps,
    "stdout",
    "warning",
    body.walletScope === "selected"
      ? `Scope: selected — this profile can only spend from the wallets below.`
      : `Scope: all — this profile can spend from every wallet on the account, listed here or not.`,
  )
  if (body.profileId) writeFields(deps, "stdout", [["Profile", body.profileId]])

  if (body.wallets.length === 0) {
    notice(deps, "stdout", "note", "No wallets assigned.")
    return 0
  }
  const rows = body.wallets.map((w) => [
    w.linkedWalletId,
    w.chain,
    w.address,
    w.label ?? symbols(terminalStyle(deps, "stdout")).missing,
    w.spendCapable ? "yes" : "no",
    formatTime(w.assignedAt, { now: deps.now(), missing: symbols(terminalStyle(deps, "stdout")).missing }),
  ])
  writeTable(deps, "stdout", ["Id", "Chain", "Address", "Label", "Can sign", "Assigned"], rows, [
    { id: true },
    { priority: 3 },
    { id: true },
    { priority: 2 },
    { priority: 4 },
    { priority: 1, id: true },
  ])
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
    // SCOPE_MISSING here is "this key lacks launch:write". That scope does not grant a linked
    // wallet, and telling the operator to mint one is the wrong repair. A device token is not
    // accepted on this route; granting a linked wallet to another key needs a signed-in session.
    if (result.code === "SCOPE_MISSING") {
      writeScreenLocalFailure(
        deps,
        {
          code: "SCOPE_MISSING",
          message:
            "Granting a linked wallet to another key needs a signed-in agent console. An agent key can only narrow its own wallet set, and a device token is not accepted on this route.",
          suggestion: "Run: candle tee rebind <wallet> --to-key <prefix>",
        },
        json,
      )
      return 1
    }
    if (result.code !== "LOOSEN_REQUIRES_SESSION") {
      writeFailure(deps, result, { apiUrl, authType: "key" }, json)
      return 1
    }
    // The human renderer prints the API's message alone and keeps suggestions for `--json`; this
    // refusal is the one where the next command matters more than the message, so a person (or an
    // agent reading the plain output) gets it on its own line too.
    const hint = widenRefusedHint(prefix, walletIds)
    writeFailure(deps, { ...result, uiHint: hint }, { apiUrl, authType: "key" }, json)
    if (!json) notice(deps, "stderr", "note", hint)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    return 0
  }
  writeSuccess(
    deps,
    "stdout",
    walletIds.length === 0
      ? `Cleared every wallet assignment on ${prefix}.`
      : `Assigned ${walletIds.length} wallet${walletIds.length === 1 ? "" : "s"} to ${prefix}.`,
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
  writeSuccess(
    deps,
    "stdout",
    scope === "selected"
      ? `${prefix} is now limited to its assigned wallets.`
      : `${prefix} can now spend from every wallet on the account.`,
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
