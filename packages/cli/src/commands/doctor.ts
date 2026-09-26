/**
 * `doctor`: a PASS/FAIL/SKIP/WARN table, in order (task-3-brief.md, then task-9): runtime version,
 * keychain backend detected, the config directory and whether a vault sits in it (BE-241, D10),
 * credentials present, API reachable, device token valid, agent key valid for launch:write (see
 * API_KEY_CHECK for why the scope is named in the row label), the plan, launch wallet delegated,
 * account, install method, whether the security key helper is beside the binary (BE-275 D9), and
 * whether a newer signed release exists. Exits nonzero on any FAIL. A missing credential SKIPs the
 * checks that need it rather than failing them (matching `auth status`); "credentials present"
 * itself still FAILs when there is no device token at all, since nothing past it can meaningfully
 * run. Install and Update never move the exit code either: an available update is PASS with the
 * fix in its detail, and offline is SKIP (see the rows themselves for why). The helper row does:
 * a binary that cannot add the hardware factor it was told it could add is a broken setup.
 */

import { sortAgentKeyScopes } from "../agent-key-access"
import { isUsageError, parseArgs } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { credentialEnvOverrides, effectiveProfileFields, printIdentity } from "../profiles"
import { compareVersions, detectInstall, fetchLatest, helperAssetName, releaseBaseUrl } from "../release"
import { renderError, renderTable, writeUsageFailure } from "../render"
import { HELPER_ENV, HELPER_NAME, locateFido2Helper } from "../vault/fido2"
import { CONFIG_DIR_ENV, candleConfigDir, defaultVaultPath, fileExists } from "../vault/store"
import { CLI_VERSION } from "../version"
import { keySignerDoctorRows } from "./key-signer"

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

  // D10 (BE-241): the two local-custody facts, before any network row. The operator in BE-235
  // item 4 could not see either one: they passed --keystore to `init` and not to `factor add`, got
  // "no vault" from one command and "already exists" from the next, and had nowhere to ask where
  // each had looked. The recommendation there was NOT to add remembered state, so these two rows
  // and D3's parentheticals are what make the flag-or-variable rule visible instead.
  //
  // Both are pure local reads. A `CANDLE_CONFIG_DIR` that still begins with a literal `~` is the
  // one refusal `candleConfigDir` can raise (D4), and doctor is where that is reported rather than
  // discovered on the next vault command.
  let configDir: string | undefined
  try {
    configDir = candleConfigDir(deps.env, deps.homedir())
    rows.push({
      check: "Config directory",
      state: "PASS",
      detail: deps.env[CONFIG_DIR_ENV]?.trim() ? `${configDir} (from ${CONFIG_DIR_ENV})` : `${configDir} (the default)`,
    })
  } catch (error) {
    rows.push({
      check: "Config directory",
      state: "FAIL",
      detail: isUsageError(error) ? error.message : String(error),
    })
  }
  if (configDir === undefined) {
    rows.push({ check: "Vault", state: "SKIP", detail: `${CONFIG_DIR_ENV} is not usable, so no path to check` })
  } else {
    const vaultPath = defaultVaultPath(deps.env, deps.homedir())
    rows.push(
      (await fileExists(vaultPath))
        ? { check: "Vault", state: "PASS", detail: vaultPath }
        : {
            check: "Vault",
            state: "SKIP",
            detail: `no vault at ${vaultPath}. Create one with candle vault init, or point at an existing one with -k <path> or ${CONFIG_DIR_ENV}.`,
          },
    )
  }

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
    const passDetail = scopes ? `scopes: ${sortAgentKeyScopes(scopes).join(", ")}` : "valid"
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

  // The plan row: the one place the CLI says what tier this account is on, and the ONLY place
  // it can say "your Max expired" -- a state doctor previously rendered as ten green rows,
  // because a lapsed subscription and an account that never subscribed produce identical
  // credentials. WARN, not FAIL: an expired plan is a fact about money, not a broken setup, and
  // doctor's exit code stays a setup verdict.
  if (!apiKey) {
    rows.push({ check: "Plan", state: "SKIP", detail: "no API key to check" })
  } else {
    const tierRes = await apiRequest("/api/v1/agent/tier", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    const tierBody = tierRes.ok
      ? (tierRes.body as { tier?: string; feeBps?: number; maxExpired?: boolean; maxExpiredNotice?: string })
      : undefined
    if (!tierBody || typeof tierBody.tier !== "string") {
      rows.push({ check: "Plan", state: "SKIP", detail: "tier not reported" })
    } else if (tierBody.maxExpired) {
      rows.push({
        check: "Plan",
        state: "WARN",
        detail: tierBody.maxExpiredNotice ?? `Max expired; this account is now on the ${tierBody.tier} plan`,
      })
    } else {
      const fee = typeof tierBody.feeBps === "number" ? ` (${tierBody.feeBps / 100}% trade fee)` : ""
      rows.push({ check: "Plan", state: "PASS", detail: `${tierBody.tier}${fee}` })
    }
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

  // Install and Update: what this binary is and whether a newer signed release exists. doctor
  // already talks to the network, so the one manifest read belongs here; ordinary commands never
  // make it (see update.ts). An available update is not a failure, so the row is PASS with the
  // fix in its detail, and offline is SKIP.
  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  const method = detectInstall(deps.execPath, realExec)
  const installDetail =
    method === "binary"
      ? `binary at ${deps.execPath}`
      : method === "homebrew"
        ? `Homebrew (${realExec})`
        : `script (${deps.execPath}); update with npm`
  rows.push({ check: "Install", state: "PASS", detail: installDetail })
  const latest = await fetchLatest(deps, releaseBaseUrl(deps.env))

  // Security key helper (BE-275 D9): directly after Install, where the reader is already looking
  // at what this install is. One `locateFido2Helper` call and no new network: the manifest read
  // below is what says whether this platform ships a helper at all. PASS with the path; FAIL when a
  // release build should have one and does not. The fix is `--install-helper` (D8) only when
  // `installable` is true: a release binary with nothing beside it. A `CANDLE_FIDO2_HELPER` that
  // names a non-executable is `installable: false` (the flag returns without installing), so the
  // row names correcting or unsetting that variable instead. SKIP when there is nothing to install
  // (npm ships no helper, D10; the release declares none for this platform, D6) or nothing to
  // compare against (offline). It reports; it does not repair.
  const helper = await locateFido2Helper(deps)
  const declaredHelper = latest.ok && deps.platformKey ? latest.manifest.helpers?.[deps.platformKey] : undefined
  if (helper.state === "ready") {
    rows.push({
      check: "Security key helper",
      state: "PASS",
      detail: `${helper.path} (${helper.source === "env" ? `from ${HELPER_ENV}` : "beside the binary"})`,
    })
  } else if (method === "script") {
    rows.push({
      check: "Security key helper",
      state: "SKIP",
      detail: `${helper.reason}; the factor needs a release build`,
    })
  } else if (!latest.ok) {
    rows.push({
      check: "Security key helper",
      state: "SKIP",
      detail: `${helper.reason}; could not read the release manifest to tell whether this platform ships one`,
    })
  } else if (declaredHelper === undefined) {
    rows.push({
      check: "Security key helper",
      state: "SKIP",
      detail: `${helper.reason}; release ${latest.manifest.version} ships no ${deps.platformKey ? helperAssetName(deps.platformKey) : HELPER_NAME} for this platform`,
    })
  } else {
    // `installable` is false when `CANDLE_FIDO2_HELPER` names a non-executable: that path wins
    // over anything beside the binary, so `--install-helper` (and `brew reinstall`) would not be
    // what the next lookup finds. The operator has to correct the variable or unset it.
    const fix = helper.installable
      ? method === "homebrew"
        ? "brew reinstall candle"
        : "candle vault factor add security-key --install-helper"
      : `correct or unset ${HELPER_ENV}`
    rows.push({
      check: "Security key helper",
      state: "FAIL",
      detail: `${helper.reason}. Fix: ${fix}`,
    })
  }

  const updateBody = latest.ok
    ? {
        current: CLI_VERSION,
        latest: latest.manifest.version,
        available: compareVersions(CLI_VERSION, latest.manifest.version) < 0,
      }
    : { current: CLI_VERSION, latest: null, available: null }
  rows.push(
    latest.ok
      ? {
          check: "Update",
          state: "PASS",
          detail: updateBody.available
            ? `${latest.manifest.version} available: ${
                method === "homebrew"
                  ? "brew upgrade candle"
                  : method === "script"
                    ? "npm i -g @candledottv/cli@latest"
                    : "candle update"
              }`
            : `up to date (${CLI_VERSION})`,
        }
      : { check: "Update", state: "SKIP", detail: `could not check: ${latest.message}` },
  )

  // Key signers (spec 2026-09-25-key-signers-design.md, 5.6): the slots this machine holds, and
  // a device token beside one. No row at all when there is nothing to say.
  rows.push(...(await keySignerDoctorRows(ctx, { apiKey, deviceToken })))

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
        install: { method, path: method === "homebrew" ? realExec : deps.execPath },
        update: updateBody,
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
