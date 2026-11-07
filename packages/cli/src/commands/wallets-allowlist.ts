/**
 * `candle wallets allowlist` (BE-2672 / R26): the account's withdrawal allowlist, read from
 * `GET /api/v1/agent/withdrawal-addresses` -- the same rows `candle transfer --to <allowlist
 * label>` resolves by. Until now no command printed them; the read existed only inside transfer.
 *
 * Any key may read the list; `?includeRevoked=true` (the `--all` flag, as on `candle wallets`)
 * adds removed rows. Approving an address is the owner's alone, in the agent console's Wallets
 * tab over a signed-in session (`LOOSEN_REQUIRES_SESSION` on the POST). Removing one tightens the
 * boundary, so an acting key may also revoke it (`transferRevokeAuth`); a read-only key cannot.
 * This command is a read and says so rather than offering to manage the list.
 */

import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { writeFields } from "../human-output"
import { heading, notice, symbols, terminalStyle } from "../presentation"
import { printIdentity } from "../profiles"
import { renderTable } from "../render"
import {
  writeScreenFailure as writeFailure,
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"

/** One row of `GET /withdrawal-addresses`, the same shape `transfer.ts` resolves by. */
interface WithdrawalAddressRow {
  id: string
  chain: "solana" | "hood"
  address: string
  label?: string
  createdAt?: number
  revokedAt?: number
}

interface WithdrawalAddressesResponse {
  success: true
  addresses: WithdrawalAddressRow[]
}

const EMPTY_NOTE =
  "No approved withdrawal addresses. An agent can move funds only to the account's own wallets and its vault."

const MANAGED_HINT =
  "Approving an address needs the owner signed in to the agent console's Wallets tab; an API key cannot approve. An acting key can revoke one; a read-only key cannot."

export async function walletsAllowlist(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--all"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      json,
    )
    return 1
  }

  const query = parsed.booleans.has("--all") ? "?includeRevoked=true" : ""
  const result = await apiRequest(`/api/v1/agent/withdrawal-addresses${query}`, {
    method: "GET",
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
  const body = result.body as Partial<WithdrawalAddressesResponse>
  if (!Array.isArray(body.addresses)) {
    writeLocalFailure(
      deps,
      { code: "INVALID_RESPONSE", message: "The withdrawal allowlist read did not return a list." },
      json,
    )
    return 1
  }
  const rows = body.addresses

  if (json) {
    deps.stdout.write(`${JSON.stringify({ success: true, addresses: rows, count: rows.length })}\n`)
    return 0
  }

  const style = terminalStyle(deps, "stdout")
  deps.stdout.write(`${heading(`Withdrawal allowlist (${rows.length})`, style)}\n\n`)
  if (rows.length === 0) {
    notice(deps, "stdout", "note", EMPTY_NOTE)
    notice(deps, "stdout", "note", MANAGED_HINT)
    return 0
  }
  if (style.width < 100) {
    for (const row of rows) {
      writeFields(deps, "stdout", [
        ["Id", row.id],
        ["Address", row.address],
        ["Label", row.label],
        ["Chain", row.chain],
        ["Revoked", row.revokedAt ? "yes" : "no"],
      ])
      deps.stdout.write("\n")
    }
  } else {
    deps.stdout.write(
      `${renderTable(
        ["Id", "Chain", "Address", "Label", "Revoked"],
        rows.map((row) => [
          row.id,
          row.chain,
          row.address,
          row.label ?? symbols(style).missing,
          row.revokedAt ? "yes" : "no",
        ]),
        {
          style,
          width: style.width,
          indent: 2,
          rule: false,
          columns: [{ id: true }, { priority: 3 }, { id: true }, { priority: 2 }, { priority: 1 }],
        },
      )}\n`,
    )
  }
  deps.stdout.write("\n")
  notice(deps, "stdout", "note", MANAGED_HINT)
  return 0
}
