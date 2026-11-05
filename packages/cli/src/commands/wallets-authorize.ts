/**
 * `candle wallets authorize` (BE-2698, R63): grant agent access to the account's embedded wallets
 * from a terminal.
 *
 * Neither the CLI nor the API can do the grant itself. Each embedded wallet's owner quorum is the
 * member's, so Candle's signer is attached by Privy in the member's own browser. What a terminal
 * can do is open the one page that grants and does nothing else: the Agents console's
 * `?authorize=1` step. Before it, a new account's only first grant was "Create key and authorize",
 * which also mints a key, and a refused `candle auth login` approval pointed at a tab with no
 * grant control on it at all.
 *
 * With an API key on this profile the command then reads `GET /wallets/embedded` until every
 * embedded wallet is delegated, so the terminal says when the grant has landed. Without one (a new
 * account, before `candle auth login` has worked) there is nothing to confirm with: it opens the
 * page and says what to run next. An account already delegated is told so, and no page opens.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { writeSuccess } from "../human-output"
import { fields, heading, notice, terminalStyle } from "../presentation"
import { effectiveProfileFields, printIdentity } from "../profiles"
import { portalDeviceUrl } from "../render"
import {
  writeScreenFailure as writeFailure,
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"

const USAGE = "Usage: candle wallets authorize [--no-browser] [--no-wait] [--timeout <seconds>] [--json]"

/** Long enough to sign in, read the consent screen and approve two Privy prompts. */
export const AUTHORIZE_WAIT_DEFAULT_SECONDS = 600
/** How often the delegation read repeats while the page is open. */
export const AUTHORIZE_POLL_MS = 3_000

interface EmbeddedWallet {
  address: string
  delegated: boolean
}

interface EmbeddedWalletsResponse {
  wallets: { solana: EmbeddedWallet | null; evm: EmbeddedWallet | null }
}

/** The grant-only step's address on the portal this profile signs in to. */
export function authorizeUrl(apiUrl: string, portalOrigin?: string): string {
  return `${portalDeviceUrl(apiUrl, portalOrigin)}?authorize=1`
}

/**
 * Every embedded wallet the account has carries Candle's signer. False for an account with none:
 * there is nothing authorized, and the page says so in words this command cannot.
 */
export function allDelegated(body: EmbeddedWalletsResponse): boolean {
  const present = [body.wallets?.solana, body.wallets?.evm].filter((w): w is EmbeddedWallet => w != null)
  return present.length > 0 && present.every((w) => w.delegated)
}

function walletRows(body: EmbeddedWalletsResponse): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (body.wallets?.solana) rows.push(["Solana", body.wallets.solana.address])
  if (body.wallets?.evm) rows.push(["Hood", body.wallets.evm.address])
  return rows
}

export async function walletsAuthorize(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--no-browser", "--no-wait"], valueFlags: ["--timeout"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}\n${USAGE}`, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\n${USAGE}`, json)
    return 2
  }
  let timeoutSeconds = AUTHORIZE_WAIT_DEFAULT_SECONDS
  const rawTimeout = parsed.values["--timeout"]
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout)
    if (!Number.isInteger(n) || n <= 0) {
      writeUsageFailure(deps, `--timeout must be a whole number of seconds above 0, got ${rawTimeout}\n${USAGE}`, json)
      return 2
    }
    timeoutSeconds = n
  }

  await printIdentity(ctx)

  const config = await deps.readConfig()
  const url = authorizeUrl(apiUrl, effectiveProfileFields(config, ctx.profile).portalOrigin)
  const apiKey = await resolveApiKey(deps, ctx.profile)

  const readWallets = () =>
    apiRequest("/api/v1/agent/wallets/embedded", {
      auth: "key",
      credentials: { apiKey: apiKey ?? "" },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Already granted: nothing to open. Only knowable with a key.
  if (apiKey) {
    const before = await readWallets()
    if (!before.ok) {
      writeFailure(deps, before, { apiUrl, authType: "key" }, json)
      return 1
    }
    const body = before.body as EmbeddedWalletsResponse
    if (allDelegated(body)) {
      if (json) {
        deps.stdout.write(`${JSON.stringify({ success: true, status: "already_authorized", wallets: body.wallets })}\n`)
      } else {
        writeSuccess(deps, "stdout", "Agent access is already on for this account's embedded wallets.")
        deps.stdout.write(`${fields(walletRows(body), terminalStyle(deps, "stdout")).join("\n")}\n`)
      }
      return 0
    }
  }

  const progress = json ? deps.stderr : deps.stdout
  if (json) {
    progress.write(`Open this URL to authorize: ${url}\n`)
  } else {
    const style = terminalStyle(deps, "stdout")
    progress.write(`${heading("Authorize agent access", style)}\n\n${fields([["Open", url]], style).join("\n")}\n\n`)
    notice(
      deps,
      "stdout",
      "note",
      "Sign in as this account, press Authorize, and approve in Privy. No API key is created.",
    )
  }
  if (!parsed.booleans.has("--no-browser")) {
    try {
      deps.openBrowser(url)
    } catch {
      // Best-effort: the URL is printed above for a terminal with no browser (SSH).
    }
  }

  if (!apiKey || parsed.booleans.has("--no-wait")) {
    const next = apiKey
      ? "When the page says Agent access is on, run: candle wallets"
      : "When the page says Agent access is on, run: candle auth login"
    if (json) deps.stdout.write(`${JSON.stringify({ success: true, status: "opened", url, confirmed: false })}\n`)
    else deps.stdout.write(`${next}\n`)
    return 0
  }

  if (!json) deps.stdout.write("Waiting for the grant... (Ctrl-C to stop; the page keeps working)\n")
  const deadline = deps.now() + timeoutSeconds * 1000
  while (deps.now() < deadline) {
    await deps.sleep(AUTHORIZE_POLL_MS)
    const after = await readWallets()
    if (!after.ok) {
      writeFailure(deps, after, { apiUrl, authType: "key" }, json)
      return 1
    }
    const body = after.body as EmbeddedWalletsResponse
    if (allDelegated(body)) {
      if (json) {
        deps.stdout.write(`${JSON.stringify({ success: true, status: "authorized", url, wallets: body.wallets })}\n`)
      } else {
        writeSuccess(deps, "stdout", "Agent access is on.")
        deps.stdout.write(`${fields(walletRows(body), terminalStyle(deps, "stdout")).join("\n")}\n`)
      }
      return 0
    }
  }

  writeLocalFailure(
    deps,
    {
      code: "AUTHORIZE_TIMEOUT",
      message: `The embedded wallets were not authorized within ${timeoutSeconds} seconds. Nothing changed on this machine.`,
      suggestion: `Open ${url} and press Authorize, then run: candle wallets`,
    },
    json,
  )
  return 1
}
