/**
 * `wallets`: `GET /wallets/embedded` (the account's launch wallets, per chain, with delegation
 * state) and `GET /wallets` (linked wallets), both with the agent key -- these routes reject a
 * device token, so unlike the `keys` commands this one needs `CANDLE_API_KEY` or a stored key.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { renderTable, writeFailure, writeLocalFailure } from "../render"

interface EmbeddedWalletsResponse {
  wallets: {
    solana: { address: string; delegated: boolean } | null
    evm: { address: string; delegated: boolean } | null
  }
}

interface LinkedWalletRow {
  address: string
  chain: string
  label?: string
  revokedAt?: number
}

interface LinkedWalletsResponse {
  page: LinkedWalletRow[]
}

export async function wallets(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }

  const apiKey = await resolveApiKey(deps)
  if (!apiKey) {
    // Through the json-aware path, same as every API failure below: a `--json` caller gets an
    // object for this exit too, not a sentence it would have to parse.
    writeLocalFailure(
      deps.stderr,
      { code: "NO_API_KEY", message: "No API key available. Run: candle keys create" },
      json,
    )
    return 1
  }

  const embedded = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!embedded.ok) {
    writeFailure(deps.stderr, embedded, { apiUrl, authType: "key" }, json)
    return 1
  }

  const linked = await apiRequest("/api/v1/agent/wallets", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!linked.ok) {
    writeFailure(deps.stderr, linked, { apiUrl, authType: "key" }, json)
    return 1
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ embedded: embedded.body, linked: linked.body })}\n`)
    return 0
  }

  const embeddedBody = embedded.body as EmbeddedWalletsResponse
  const linkedBody = linked.body as LinkedWalletsResponse

  deps.stdout.write("Embedded (launch) wallets:\n")
  deps.stdout.write(
    `${renderTable(
      ["Chain", "Address", "Delegated"],
      [
        [
          "solana",
          embeddedBody.wallets.solana?.address ?? "none",
          embeddedBody.wallets.solana?.delegated ? "yes" : "no",
        ],
        ["evm", embeddedBody.wallets.evm?.address ?? "none", embeddedBody.wallets.evm?.delegated ? "yes" : "no"],
      ],
    )}\n`,
  )

  deps.stdout.write("\nLinked wallets:\n")
  if (linkedBody.page.length === 0) {
    deps.stdout.write("(none)\n")
  } else {
    deps.stdout.write(
      `${renderTable(
        ["Chain", "Address", "Label", "Revoked"],
        linkedBody.page.map((wallet) => [
          wallet.chain,
          wallet.address,
          wallet.label ?? "-",
          wallet.revokedAt ? "yes" : "no",
        ]),
      )}\n`,
    )
  }
  return 0
}
