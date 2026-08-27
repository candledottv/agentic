/**
 * `candle setup`: zero to armed in one command (CLI P1, from the 2026-08-23 Kraken/Stripe
 * onboarding comparison -- Kraken ships `kraken setup` as its wizard). Nothing here is new
 * machinery: the wizard SEQUENCES the pieces that already exist, in the order a new operator
 * actually needs them, and stops being clever there.
 *
 *   1. Authorize this device (skipped when both credentials are already stored and working --
 *      re-running setup is safe and idempotent).
 *   2. Show the agent wallets as funding destinations, plus the copyable agent brief.
 *   3. Show the skill / MCP install lines for coding agents.
 *   4. Run the full doctor health check; setup's exit code is doctor's, so scripting
 *      `candle setup && ...` means "everything verified".
 *   5. Point at the web console for keys, funding, withdrawal addresses, and limits.
 *
 * Deliberately human-only: `--json` is refused with guidance to use the composable commands
 * (`auth login`, `doctor`) that already speak the machine contract -- a wizard that half-speaks
 * JSON would violate the one-value-on-stdout rule mid-flow.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { effectiveProfileFields, identityLine, printIdentity, resolveProfileName } from "../profiles"
import { portalDeviceUrl, writeUsageFailure } from "../render"
import { authLogin } from "./auth"
import { doctor } from "./doctor"
import { mcpClientConfig } from "./mcp"

/** Mirrors distribution/agentic's install table and the console's connect tab -- the same three
 * lines the CLI P0 work put everywhere else. Hardcoded (no cross-package import), the
 * ALL_AGENT_SCOPES convention. */
const SKILLS_CLAUDE_COMMAND = "/plugin marketplace add candledottv/agentic"
const CODING_AGENTS_DOCS = "https://docs.candle.tv/developers/coding-agents"

interface EmbeddedWalletsResponse {
  account?: string
  username?: string
  wallets?: {
    solana?: { address: string; delegated: boolean } | null
    evm?: { address: string; delegated: boolean } | null
  }
}

function section(deps: CommandContext["deps"], title: string): void {
  deps.stdout.write(`\n== ${title} ==\n`)
}

export async function setup(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--no-browser"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  if (json) {
    writeUsageFailure(
      deps,
      "setup is an interactive wizard; for machine use, compose `auth login --json` and `doctor --json` directly",
      json,
    )
    return 2
  }

  await printIdentity(ctx)

  deps.stdout.write(`candle setup: this wizard authorizes the device, shows funding, and verifies everything.\n`)

  // 1. Authorization -- idempotent: skip when both credentials are already stored.
  section(deps, "1/4 Authorize this device")
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  // The context the rest of the wizard reads from. On the fresh-install path (no profile
  // resolved at dispatch) the nested login below mints one, so this starts as `ctx` and is
  // replaced once that login succeeds -- every later resolver call and the nested `doctor` call
  // go through `nextCtx`, never the stale `ctx`.
  let nextCtx = ctx
  if (deviceToken && apiKey) {
    deps.stdout.write("Already authorized on this machine (device token + API key present). Skipping login.\n")
  } else {
    const loginArgs = parsed.booleans.has("--no-browser") ? ["--no-browser"] : []
    const loginExit = await authLogin(loginArgs, ctx)
    if (loginExit !== 0) {
      deps.stderr.write("Setup stopped: device authorization did not complete.\n")
      return loginExit
    }
    // `finishLogin` (auth.ts) just filed the device token and key under a profile it derived
    // (or reused) and may have set `activeProfile` for the first time. Re-resolve so the rest of
    // this wizard reads that profile instead of the still-undefined `ctx.profile` -- otherwise
    // step 2 reads the legacy flat ref, finds nothing the nested login just wrote, and degrades
    // to "Could not read the agent wallets right now" on a perfectly healthy fresh install.
    const loginConfig = await deps.readConfig()
    const resolution = resolveProfileName(loginConfig, { flag: ctx.profileFlag, env: deps.env })
    if (!resolution.ok) {
      deps.stderr.write(`${resolution.message}\n`)
      return 1
    }
    nextCtx = { ...ctx, profile: resolution.name }
  }

  // 2. Funding -- the agent wallets as deposit addresses, plus the brief the operator pastes
  // into their agent (mirrors the console funding panel's own copy).
  section(deps, "2/4 Fund your agent's wallets")
  const key = await resolveApiKey(deps, nextCtx.profile)
  const walletsResult = key
    ? await apiRequest("/api/v1/agent/wallets/embedded", {
        auth: "key",
        credentials: { apiKey: key },
        apiUrl,
        fetch: deps.fetch,
        env: deps.env,
      })
    : null
  if (walletsResult?.ok) {
    const body = walletsResult.body as EmbeddedWalletsResponse
    const solana = body.wallets?.solana ?? null
    const evm = body.wallets?.evm ?? null
    if (body.account)
      deps.stdout.write(`${identityLine(nextCtx.profile, body.account, apiUrl, undefined, body.username)}\n`)
    if (solana) deps.stdout.write(`Solana (send SOL here):    ${solana.address}\n`)
    if (evm) deps.stdout.write(`Hood    (send ETH here):    ${evm.address}\n`)
    deps.stdout.write(
      "Launches and trades are paid from these wallets. There is no minimum, and read-only requests work unfunded.\n",
    )
    deps.stdout.write("\nTell your agent (paste into its context):\n")
    deps.stdout.write(`  Install the Candle CLI: curl -fsSL https://candle.tv/install.sh | bash\n`)
    deps.stdout.write(
      `  You operate a Candle agent account. API base URL: ${apiUrl} (send your API key in the x-api-key header).\n`,
    )
    if (solana) deps.stdout.write(`  Your Solana wallet: ${solana.address}\n`)
    if (evm) deps.stdout.write(`  Your Hood Chain (EVM) wallet: ${evm.address}\n`)
    deps.stdout.write("  Check balances before trading, and ask me to fund whichever chain you need.\n")
  } else {
    deps.stdout.write(
      "Could not read the agent wallets right now; `candle wallets` shows them once the API is reachable.\n",
    )
  }

  // 3. Connect a coding agent.
  section(deps, "3/4 Connect your agent")
  deps.stdout.write(`Claude Code skills:  ${SKILLS_CLAUDE_COMMAND}\n`)
  deps.stdout.write("MCP (any client), paste into the host's MCP config:\n")
  deps.stdout.write(`${await mcpClientConfig([], deps)}\n`)
  // No runtime prerequisite to mention any more: the server is bundled into this binary, so
  // `candle mcp` starts it in-process. This line used to say MCP hosts needed Node 18+ on their
  // own PATH, which was true only while the server was fetched with npx at every launch.
  deps.stdout.write("The MCP server is built into this binary; the host needs nothing else installed.\n")
  deps.stdout.write(`Other platforms:     ${CODING_AGENTS_DOCS}\n`)

  // 4. Verify everything end to end. Setup's exit code IS doctor's: `candle setup && ...`
  // means the whole rail checked out.
  section(deps, "4/4 Health check")
  const doctorExit = await doctor([], nextCtx)

  // Read AFTER the login above, and from the profile in play: the portal origin the device flow
  // recorded is what points this at the right console on a non-default backend.
  const config = await deps.readConfig()
  const { portalOrigin } = effectiveProfileFields(config, nextCtx.profile)
  deps.stdout.write(
    `\nConsole (keys, funding, withdrawal addresses, limits): ${portalDeviceUrl(apiUrl, portalOrigin)}\n`,
  )
  deps.stdout.write(
    doctorExit === 0
      ? "Setup complete. Your agent can launch, trade, and transfer the moment the wallets are funded.\n"
      : "Setup finished with failed checks above; fix them and re-run `candle doctor`.\n",
  )
  return doctorExit
}
