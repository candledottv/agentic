/**
 * `doctor`: a PASS/FAIL/SKIP table over seven checks, in order (task-3-brief.md): runtime
 * version, keychain backend detected, credentials present, API reachable, device token valid,
 * agent key valid for launch:write (see API_KEY_CHECK for why the scope is named in the row
 * label), launch wallet delegated. Exits nonzero on any FAIL. A missing credential SKIPs
 * the checks that need it rather than failing them (matching `auth status`); "credentials
 * present" itself still FAILs when there is no device token at all, since nothing past it can
 * meaningfully run.
 */

import { parseArgs } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { renderError, renderTable, writeUsageFailure } from "../render"

// Matches packages/mcp's own `engines.node` floor (">=18"); doctor needs an actual number to
// compare against, package.json's engines field alone isn't read at runtime by the built bundle
// (see version.ts's header comment for why the CLI hand-maintains constants like this).
const MIN_NODE_MAJOR = 18

/**
 * The agent-key row names the scope it actually proves, not just "valid". The probe endpoint is
 * `GET /agent/tier` (the spec's choice), which sits behind `requireAgentKey("launch:write")` --
 * so a perfectly valid activity-only key FAILs this row. Labeling it "API key valid" flat told
 * that user their key was broken; naming the scope makes the row's real claim visible, and
 * `renderError`'s SCOPE_MISSING mapping supplies the fix line for the 403 itself.
 */
const API_KEY_CHECK = "API key valid (launch:write)"

export async function doctor(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const rows: CheckRow[] = []

  // `deps.nodeVersion` (not `process.versions.node` read directly) so this branch is testable
  // without actually running the CLI under an old Node.
  const nodeMajor = Number(deps.nodeVersion.split(".")[0])
  rows.push(
    Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
      ? { check: "Runtime version", state: "PASS", detail: `node ${deps.nodeVersion}` }
      : {
          check: "Runtime version",
          state: "FAIL",
          detail: `node ${deps.nodeVersion} is below the minimum (${MIN_NODE_MAJOR}). Fix: upgrade Node.js to ${MIN_NODE_MAJOR} or later.`,
        },
  )

  rows.push({ check: "Keychain backend", state: "PASS", detail: deps.backend })

  const deviceToken = await resolveDeviceToken(deps)
  const apiKey = await resolveApiKey(deps)
  rows.push(
    deviceToken
      ? {
          check: "Credentials present",
          state: "PASS",
          detail: apiKey ? "device token and API key" : "device token only (no API key yet)",
        }
      : { check: "Credentials present", state: "FAIL", detail: "No device token found. Fix: run candle auth login." },
  )

  const statusResult = await apiRequest("/api/v1/status", {
    auth: "none",
    credentials: {},
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  rows.push(
    statusResult.ok
      ? { check: "API reachable", state: "PASS", detail: apiUrl }
      : { check: "API reachable", state: "FAIL", detail: renderError(statusResult, { apiUrl, authType: "none" }) },
  )

  // Sequential, not concurrent (task-3-brief.md's design decisions): the live checks run one
  // after the other, same as auth status. Rows 5-6 share `runLiveCheck` with `auth status`'s own
  // two rows (fix round 1, item 11): same request-and-classify logic, same row shape.
  if (!deviceToken) {
    rows.push({ check: "Device token valid", state: "SKIP", detail: "no device token to check" })
  } else {
    rows.push(
      await runLiveCheck({
        deps,
        apiUrl,
        path: "/api/v1/agent/keys",
        auth: "device",
        credential: deviceToken,
        check: "Device token valid",
        passDetail: "valid",
      }),
    )
  }

  if (!apiKey) {
    rows.push({ check: API_KEY_CHECK, state: "SKIP", detail: "no API key to check" })
  } else {
    // GET /agent/tier never returns scopes (apps/api/src/routes/agent.ts's GET /tier reports
    // tier/balance/fee data, not the key's grants), so "valid + scopes listed" reads the scopes
    // recorded in local config from whenever the key was minted (`auth login` or `keys create`)
    // instead. That is stale or simply absent when the key actually in use came from
    // CANDLE_API_KEY (an env override never recorded in config at all) -- the row still reports
    // PASS correctly (the key IS valid), just without a scopes list for a key the CLI never
    // minted itself.
    const config = await deps.readConfig()
    const passDetail = config.scopes ? `scopes: ${config.scopes.join(", ")}` : "valid"
    rows.push(
      await runLiveCheck({
        deps,
        apiUrl,
        path: "/api/v1/agent/tier",
        auth: "key",
        credential: apiKey,
        check: API_KEY_CHECK,
        passDetail,
      }),
    )
  }

  let account: string | undefined
  if (!apiKey) {
    rows.push({ check: "Launch wallet delegated", state: "SKIP", detail: "no API key to check" })
  } else {
    const result = await apiRequest("/api/v1/agent/wallets/embedded", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (!result.ok) {
      rows.push({
        check: "Launch wallet delegated",
        state: "FAIL",
        detail: renderError(result, { apiUrl, authType: "key" }),
      })
    } else {
      const body = result.body as {
        account?: string
        wallets: { solana: { delegated: boolean } | null; evm: { delegated: boolean } | null }
      }
      // Which account these credentials act as. Valid-but-wrong-account is the failure this
      // command exists to make visible: on 2026-08-19 both credential checks passed while an
      // import had landed on a different account entirely, and nothing here would have said so.
      account = body.account
      const delegated = Boolean(body.wallets.solana?.delegated || body.wallets.evm?.delegated)
      rows.push(
        delegated
          ? { check: "Launch wallet delegated", state: "PASS", detail: "delegated" }
          : {
              check: "Launch wallet delegated",
              state: "FAIL",
              detail: "No launch wallet is delegated. Fix: delegate one in the portal.",
            },
      )
    }
  }

  rows.push(
    account !== undefined
      ? { check: "Account", state: "PASS", detail: account }
      : { check: "Account", state: "SKIP", detail: "could not resolve which account these credentials act as" },
  )

  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0

  if (json) {
    deps.stdout.write(`${JSON.stringify({ rows, ...(account !== undefined ? { account } : {}) })}\n`)
    return exitCode
  }

  deps.stdout.write(
    `${renderTable(
      ["Check", "Status", "Detail"],
      rows.map((row) => [row.check, row.state, row.detail]),
    )}\n`,
  )
  return exitCode
}
