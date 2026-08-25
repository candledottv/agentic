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
import { credentialEnvOverrides, effectiveProfileFields, printIdentity } from "../profiles"
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
  // The acting profile's own non-secret fields (or the legacy top-level ones pre-profile), read
  // once: two rows below want something out of them, and doctor never writes config.
  const fields = effectiveProfileFields(await deps.readConfig(), ctx.profile)

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

  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  const apiKey = await resolveApiKey(deps, ctx.profile)
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
    const scopes = fields.scopes
    const passDetail = scopes ? `scopes: ${scopes.join(", ")}` : "valid"
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

  // What the profile RECORDED, beside what the key answers. Doctor is where a mismatch is meant
  // to be seen, and the identity line above already prints the cached value: leaving the two to be
  // compared by eye, one at the top of the report and one at the bottom, is how a mismatch reads
  // as a typo. Reported as a note on the row rather than a FAIL: doctor's exit code is what
  // `setup` branches on, and this wave does not move it.
  //
  // Silent under a credential env override, the condition the guard itself skips on: the live
  // account then belongs to CANDLE_API_KEY's key rather than the profile's stored one, so the
  // disagreement is expected, and `profile use` would re-cache from the key that was not acting.
  // `cachedAccount` still goes into the --json body; only the note is gated.
  const cachedAccount = ctx.profile !== undefined ? fields.account : undefined
  const mismatch =
    account !== undefined &&
    cachedAccount !== undefined &&
    account !== cachedAccount &&
    credentialEnvOverrides(deps.env).length === 0
  rows.push(
    account === undefined
      ? { check: "Account", state: "SKIP", detail: "could not resolve which account these credentials act as" }
      : {
          check: "Account",
          state: "PASS",
          detail: mismatch
            ? `${account} (profile ${ctx.profile} recorded ${cachedAccount}. Fix: run candle profile use ${ctx.profile})`
            : account,
        },
  )

  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0

  // The identity line is doctor's own first line of output, ahead of the table -- a header for
  // the whole report, distinct from the table's own live "Account" row below (which is what these
  // credentials actually resolve to, versus this line's cached record of the profile).
  await printIdentity(ctx)

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        rows,
        ...(account !== undefined ? { account } : {}),
        ...(cachedAccount !== undefined ? { cachedAccount } : {}),
      })}\n`,
    )
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
