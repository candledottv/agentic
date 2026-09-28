/** Setup diagnostics for owner and bot machines. Stable ids are emitted with every JSON row. */
import { sortAgentKeyScopes } from "../agent-key-access"
import { isUsageError, parseArgs } from "../args"
import { type CheckRow, runLiveCheck } from "../checks"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { SecretStoreLockedError } from "../keychain"
import { apiKeyPrefix, credentialEnvOverrides, effectiveProfileFields, printIdentity } from "../profiles"
import { compareVersions, detectInstall, fetchLatest, helperAssetName, releaseBaseUrl } from "../release"
import { renderError, renderTable, writeUsageFailure } from "../render"
import { HELPER_ENV, HELPER_NAME, locateFido2Helper } from "../vault/fido2"
import { CONFIG_DIR_ENV, candleConfigDir, defaultVaultPath, fileExists } from "../vault/store"
import { CLI_VERSION } from "../version"
import { keySignerDoctorReport } from "./key-signer"

// Matches packages/mcp's own `engines.node` floor (">=18"); doctor needs an actual number to
// compare against, package.json's engines field alone isn't read at runtime by the built bundle
// (see version.ts's header comment for why the CLI hand-maintains constants like this).
const MIN_NODE_MAJOR = 18

// Human labels may evolve; row ids are the additive machine contract.
export const DOCTOR_ROW_IDS = {
  "Runtime version": "runtime",
  "Keychain backend": "keychain",
  "Config directory": "config_dir",
  Vault: "vault",
  "Credentials present": "credentials",
  "API reachable": "api_reachable",
  "Device token valid": "device_token",
  "API key valid": "api_key",
  Plan: "plan",
  "Launch wallet delegated": "embedded_wallet",
  "Embedded wallet": "embedded_wallet",
  Account: "account",
  Install: "install",
  "Security key helper": "security_key_helper",
  Update: "update",
  "Key signers": "key_signers",
  "Key signer": "key_signers",
  "Signer slot": "signer_slot",
  "Device token beside signer": "device_token",
  "Trade path": "trade_path",
  "TEE limits": "tee_limits",
  "Project .env": "project_env",
  "API URL": "api_url_provenance",
  "API key": "api_key_provenance",
  "Device token": "device_token_provenance",
} as const

const API_KEY_CHECK = "API key valid"

export async function doctor(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--role"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const requestedRole = parsed.values["--role"] ?? "auto"
  if (!["auto", "owner", "bot"].includes(String(requestedRole))) {
    writeUsageFailure(deps, "--role must be owner, bot, or auto", json)
    return 2
  }
  const rows: CheckRow[] = []
  // The acting profile's own non-secret fields (or the legacy top-level ones pre-profile), read
  // once: two rows below want something out of them, and doctor never writes config.
  const config = await deps.readConfig()
  const fields = effectiveProfileFields(config, ctx.profile)

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
  let hasVault = false
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
    hasVault = await fileExists(vaultPath)
    rows.push(
      hasVault
        ? { check: "Vault", state: "PASS", detail: vaultPath }
        : {
            check: "Vault",
            state: "SKIP",
            detail: `no vault at ${vaultPath}. Create one with candle vault init, or point at an existing one with -k <path> or ${CONFIG_DIR_ENV}.`,
          },
    )
  }

  let storeError: unknown
  const readCredential = async (read: () => Promise<string | undefined>) => {
    try {
      return await read()
    } catch (error) {
      if (!(storeError instanceof SecretStoreLockedError)) storeError = error
      return undefined
    }
  }
  const deviceToken = await readCredential(() => resolveDeviceToken(deps, ctx.profile))
  const apiKey = await readCredential(() => resolveApiKey(deps, ctx.profile))
  const role = requestedRole === "auto" ? (apiKey && !deviceToken ? "bot" : "owner") : requestedRole
  rows.push(
    deviceToken || apiKey
      ? {
          check: "Credentials present",
          state: "PASS",
          detail: `${deviceToken && apiKey ? "device token and API key" : apiKey ? "API key only" : "device token only (no API key yet)"}; role: ${role}`,
        }
      : {
          check: "Credentials present",
          state: "FAIL",
          detail: "No credential found. Fix: run candle auth login, or export CANDLE_API_KEY.",
        },
  )

  const source = (value: string | undefined, envName: string) =>
    deps.env[envName]?.trim() ? envName : value ? (ctx.profile ? `profile ${ctx.profile}` : "legacy store") : "none"
  const provenance = {
    apiUrl: {
      value: apiUrl,
      source:
        ctx.apiUrlFlag !== undefined
          ? "--api-url"
          : deps.env.CANDLE_API_URL?.trim()
            ? "CANDLE_API_URL"
            : ctx.profile && config.profiles?.[ctx.profile]?.apiUrl?.trim()
              ? `profile ${ctx.profile}`
              : config.apiUrl?.trim()
                ? "config"
                : "default",
    },
    apiKey: { source: source(apiKey, "CANDLE_API_KEY"), prefix: apiKey ? (apiKeyPrefix(apiKey) ?? null) : null },
    deviceToken: { source: source(deviceToken, "CANDLE_DEVICE_TOKEN") },
  }
  rows.push(
    { check: "API URL", state: "PASS", detail: `${apiUrl} (from ${provenance.apiUrl.source})` },
    {
      check: "API key",
      state: "PASS",
      detail: `from ${provenance.apiKey.source}${apiKey ? `; ${provenance.apiKey.prefix ?? "unrecognized format"}` : ""}`,
    },
    { check: "Device token", state: "PASS", detail: `from ${provenance.deviceToken.source}` },
  )
  // Read names only. Never load project values into the process environment.
  const projectEnv = await deps.readFile(".env").catch(() => "")
  const names = [
    ...new Set(
      projectEnv.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\s*(?:export\s+)?(CANDLE_[A-Za-z0-9_]+)\s*=/)
        return match?.[1] ? [match[1]] : []
      }),
    ),
  ]
  if (names.length)
    rows.push({
      check: "Project .env",
      state: "WARN",
      detail: `${names.join(", ")}: the binary ignores them; export them, or store them in a profile.`,
    })

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
  if (role === "bot" || !deviceToken) {
    rows.push({
      check: "Device token valid",
      state: "SKIP",
      detail: role === "bot" ? "not used on a bot box" : "no device token to check",
    })
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

  type TradingPage = {
    scopes?: string[]
    paused?: boolean
    page?: { id: string; active: boolean }[]
    isDone?: boolean
    continueCursor?: string | null
  }
  let trading: TradingPage | undefined
  let scopes = fields.scopes
  if (!apiKey) {
    rows.push({ check: API_KEY_CHECK, state: "SKIP", detail: "no API key to check" })
  } else {
    const result = await apiRequest("/api/v1/agent/wallets/trading", {
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (result.ok) trading = result.body as TradingPage
    if (trading && Array.isArray(trading.scopes)) {
      scopes = trading.scopes
      rows.push({
        check: API_KEY_CHECK,
        state: "PASS",
        detail: `scopes: ${sortAgentKeyScopes(scopes).join(", ")}${trading.paused === true ? "; profile is paused" : ""}`,
      })
      // Reach must include every page, not just the first 50 wallets.
      const seen = new Set<string>()
      while (trading.isDone === false && trading.continueCursor && !seen.has(trading.continueCursor)) {
        seen.add(trading.continueCursor)
        const next = await apiRequest(
          `/api/v1/agent/wallets/trading?cursor=${encodeURIComponent(trading.continueCursor)}`,
          { auth: "key", credentials: { apiKey }, apiUrl, fetch: deps.fetch, env: deps.env },
        )
        if (!next.ok) break
        const page = next.body as TradingPage
        trading = {
          ...trading,
          page: [...(trading.page ?? []), ...(page.page ?? [])],
          isDone: page.isDone,
          continueCursor: page.continueCursor,
        }
      }
    } else if (result.ok || (!result.ok && result.status === 404)) {
      rows.push(
        await runLiveCheck({
          deps,
          apiUrl,
          path: "/api/v1/agent/tier",
          auth: "key",
          credential: apiKey,
          check: API_KEY_CHECK,
          passDetail: `${scopes ? `scopes (cached): ${sortAgentKeyScopes(scopes).join(", ")}` : "valid"}${trading?.paused === true ? "; profile is paused" : ""}`,
        }),
      )
    } else {
      rows.push({ check: API_KEY_CHECK, state: "FAIL", detail: renderError(result, { apiUrl, authType: "key" }) })
    }
  }
  const signerReport = await keySignerDoctorReport(ctx, { apiKey, deviceToken })
  const wallets = trading?.page ?? []
  const reachable = wallets.filter((w) => w.active && signerReport.reachableWalletIds.includes(w.id)).length
  const activeTee = wallets.some((w) => w.active)
  let embeddedUsable = false

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

  const embeddedLabel = role === "bot" ? "Embedded wallet" : "Launch wallet delegated"
  let account: string | undefined
  if (!apiKey) {
    rows.push({ check: embeddedLabel, state: "SKIP", detail: "no API key to check" })
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
        check: embeddedLabel,
        state: role === "bot" ? (activeTee ? "SKIP" : "WARN") : "FAIL",
        detail: role === "bot" && activeTee ? "not used by this key" : renderError(result, { apiUrl, authType: "key" }),
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
      const delegated = Boolean(body.wallets?.solana?.delegated || body.wallets?.evm?.delegated)
      embeddedUsable = delegated
      rows.push(
        delegated
          ? { check: embeddedLabel, state: "PASS", detail: "delegated" }
          : {
              check: embeddedLabel,
              state: role === "bot" ? (activeTee ? "SKIP" : "WARN") : "FAIL",
              detail:
                role === "bot"
                  ? activeTee
                    ? "not used by this key"
                    : "No usable payer: no delegated embedded wallet or active TEE wallet."
                  : "No launch wallet is delegated. Fix: delegate one in the portal.",
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
      state: hasVault ? "FAIL" : "SKIP",
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
  rows.push(...signerReport.rows)
  if (storeError || signerReport.locked) {
    const row = rows.find((r) => r.check === "Keychain backend")
    if (row) {
      row.state = "FAIL"
      row.detail =
        signerReport.locked || storeError instanceof SecretStoreLockedError
          ? new SecretStoreLockedError().message
          : storeError instanceof Error
            ? storeError.message
            : "Secret store cannot be opened"
    }
  }
  if (role === "bot" || signerReport.hasSigners || trading?.paused === true) {
    const canTrade = scopes?.includes("swap:write") && (reachable > 0 || embeddedUsable)
    rows.push({
      check: "Trade path",
      state: trading?.paused === true ? "FAIL" : canTrade ? "PASS" : "WARN",
      detail:
        trading?.paused === true
          ? "The owner paused this profile; every trade is refused with PROFILE_PAUSED."
          : `${reachable} of ${wallets.length} wallets on this key trade from this machine${embeddedUsable ? "; embedded wallet delegated" : ""}${!scopes?.includes("swap:write") ? "; missing swap:write" : ""}${reachable === 0 && !embeddedUsable ? "; no reachable payer" : ""}`,
    })
  }
  const identifiedRows = rows.map((row) => ({ ...row, id: DOCTOR_ROW_IDS[row.check as keyof typeof DOCTOR_ROW_IDS] }))

  const exitCode = rows.some((row) => row.state === "FAIL") ? 1 : 0

  // The identity line is doctor's own first line of output, ahead of the table -- a header for
  // the whole report, distinct from the table's own live "Account" row below (which is what these
  // credentials actually resolve to, versus this line's cached record of the profile).
  await printIdentity(ctx)

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        rows: identifiedRows,
        role,
        provenance,
        ...(account !== undefined ? { account } : {}),
        ...(cachedAccount !== undefined ? { cachedAccount } : {}),
        install: { method, path: method === "homebrew" ? realExec : deps.execPath },
        update: updateBody,
      })}\n`,
    )
    return exitCode
  }

  deps.stdout.write(`Role: ${role}\n`)
  deps.stdout.write(
    `${renderTable(
      ["Check", "Status", "Detail"],
      rows.map((row) => [row.check, row.state, row.detail]),
    )}\n`,
  )
  return exitCode
}
