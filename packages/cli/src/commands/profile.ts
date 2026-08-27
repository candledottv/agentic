/**
 * `candle profile`: manage the profiles map (docs/superpowers/specs/2026-08-19-cli-profiles-design.md,
 * Phase 2). These commands need no credentials and bypass profile resolution at dispatch, which
 * is what lets `profile use` resolve the "several profiles, none selected" refusal.
 */
import { fetchAccount } from "../account"
import { parseArgs } from "../args"
import { insecureApiUrlFault, resolveApiUrl } from "../client"
import type { CommandContext } from "../deps"
import { identityLine, isValidProfileName, profileSecretRef, profileTable } from "../profiles"
import { renderTable, writeLocalFailure, writeUsageFailure } from "../render"

export async function profileList(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const rows = profileTable(await deps.readConfig(), deps.now())
  if (json) {
    deps.stdout.write(`${JSON.stringify(rows)}\n`)
    return 0
  }
  if (rows.length === 0) {
    deps.stdout.write("No profiles on this machine. Run: candle auth login\n")
    return 0
  }
  deps.stdout.write(
    renderTable(
      ["Profile", "Account", "Cached", "Host", "Key"],
      rows.map((r) => [
        r.active ? `${r.name} (active)` : r.name,
        r.account ?? "unknown",
        r.cachedAge,
        r.apiUrl ?? "-",
        r.keyPrefix ?? "-",
      ]),
    ),
  )
  return 0
}

const NEEDS_SCHEME = (value: string) => `It needs a scheme, such as https://${value}`
const BAD_SCHEME = "The scheme must be http or https."

/**
 * What is wrong with a `--api-url` value, as the sentence to say about it, or `undefined` when the
 * CLI could actually send a request to it. Parsing with `new URL` is not enough on its own: it
 * ACCEPTS "localhost:3000" and "api.candle.tv:443", reading the part before the colon as a SCHEME
 * and leaving the host empty, which is exactly the shape an operator types when they mean to leave
 * the scheme off -- so those get the same advice as a value that does not parse at all.
 *
 * A value that DID parse with a real scheme the client cannot speak gets its own sentence: telling
 * someone who typed "ftp://api.candle.tv" to try "https://ftp://api.candle.tv" is nonsense.
 */
function apiUrlFault(value: string, env: Record<string, string | undefined>): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return NEEDS_SCHEME(value)
  }
  if (url.host === "") return NEEDS_SCHEME(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return BAD_SCHEME
  // Refuse cleartext here too, not only at the call site: writing the profile and failing on its
  // first use would leave a saved profile that can never make a request, and the advice would
  // arrive a command later than the value it is about.
  return insecureApiUrlFault(value, env)
}

export async function profileAdd(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json, apiUrlFlag } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const name = parsed.positionals[0]
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile add <name> --api-url <url>", json)
    return 2
  }
  if (!isValidProfileName(name)) {
    writeUsageFailure(deps, `Invalid profile name: ${name}`, json)
    return 2
  }
  if (!apiUrlFlag) {
    writeUsageFailure(deps, "profile add needs --api-url <url>: the host this profile authenticates against", json)
    return 2
  }
  // Parsed here, where the operator is still looking at what they typed. The value is otherwise
  // written to config unread and only fails much later, inside whatever command first tries to
  // reach it, with the typo sitting in a file nothing prompted them to open.
  const fault = apiUrlFault(apiUrlFlag, deps.env)
  if (fault) {
    writeUsageFailure(deps, `Invalid --api-url: ${apiUrlFlag}. ${fault}`, json)
    return 2
  }
  const config = await deps.readConfig()
  if (config.profiles?.[name]) {
    writeLocalFailure(
      deps,
      {
        code: "PROFILE_EXISTS",
        message: `Profile "${name}" already exists.`,
        suggestion: `Run: candle profile use ${name}`,
      },
      json,
    )
    return 1
  }
  await deps.updateProfile(name, { apiUrl: apiUrlFlag })
  if (!config.activeProfile) await deps.writeConfig({ activeProfile: name })
  if (json) deps.stdout.write(`${JSON.stringify({ name, apiUrl: apiUrlFlag })}\n`)
  else deps.stdout.write(`Created profile ${name} for ${apiUrlFlag}. Run: candle auth login --profile ${name}\n`)
  return 0
}

export async function profileUse(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const name = parsed.positionals[0]
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile use <name>", json)
    return 2
  }
  const config = await deps.readConfig()
  const profile = config.profiles?.[name]
  if (!profile) {
    const names = Object.keys(config.profiles ?? {}).join(", ") || "(none)"
    writeLocalFailure(
      deps,
      {
        code: "NO_SUCH_PROFILE",
        message: `No profile named "${name}".`,
        suggestion: `Profiles on this machine: ${names}`,
      },
      json,
    )
    return 1
  }
  await deps.writeConfig({ activeProfile: name })

  // CANDLE_PROFILE beats `activeProfile` (resolveProfileName's order), so a shell that exports it
  // makes this command look like it did nothing: the switch happened, and every later command in
  // that shell goes on reading the env var instead. Said once, here, where it is still a surprise
  // that can be acted on.
  const envProfile = deps.env.CANDLE_PROFILE?.trim()
  if (envProfile && envProfile !== name) {
    deps.stderr.write(`CANDLE_PROFILE=${envProfile} is set and takes precedence over the active profile.\n`)
  }

  // Refresh the cached account from the profile's OWN stored key (not an env override, which
  // belongs to whoever exported it). Best-effort: the switch already happened.
  const apiUrl = ctx.apiUrlFlag ?? resolveApiUrl(profile.apiUrl, deps.env)
  const apiKey = await deps.store.get(profileSecretRef(name, "apiKey"))
  let account = profile.account
  let username = profile.username
  if (apiKey) {
    const { account: live, username: liveUsername, failure } = await fetchAccount(deps, apiUrl, apiKey)
    if (live) {
      account = live
      // Re-cache the username from the very key this refresh read: `undefined` when the account has
      // none clears any stale value (updateProfile drops an undefined field on write), so the cache
      // never keeps a handle the account has since removed.
      username = liveUsername
      await deps.updateProfile(name, { account: live, username: liveUsername, accountCachedAt: deps.now() })
    } else {
      deps.stderr.write(`Could not refresh the account for ${name} (${failure}); keeping the cached value.\n`)
    }
  } else {
    // A profile with no stored key switches fine, and prints an identity line indistinguishable
    // from a working one. Without this the operator learns it holds no credentials from the next
    // authenticated command, one message removed from the cause. Still exit 0: the switch is what
    // was asked for, and it happened.
    deps.stderr.write(`No stored credentials for ${name}. Run: candle auth login --profile ${name}\n`)
  }
  if (json) deps.stdout.write(`${JSON.stringify({ name, account, apiUrl })}\n`)
  else deps.stdout.write(`${identityLine(name, account, apiUrl, undefined, username)}\n`)
  return 0
}

const SECRET_KINDS = ["deviceToken", "apiKey"] as const

export async function profileRename(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [from, to] = parsed.positionals
  if (!from || !to || parsed.positionals.length !== 2) {
    writeUsageFailure(deps, "Usage: candle profile rename <old> <new>", json)
    return 2
  }
  if (!isValidProfileName(to)) {
    writeUsageFailure(deps, `Invalid profile name: ${to}`, json)
    return 2
  }
  const config = await deps.readConfig()
  const profiles = { ...(config.profiles ?? {}) }
  if (!profiles[from]) {
    writeLocalFailure(deps, { code: "NO_SUCH_PROFILE", message: `No profile named "${from}".` }, json)
    return 1
  }
  if (profiles[to]) {
    writeLocalFailure(deps, { code: "PROFILE_EXISTS", message: `Profile "${to}" already exists.` }, json)
    return 1
  }
  // Secrets first, then the entry: a crash between the two leaves a profile whose refs exist
  // under both names, which the next rename or remove can still reason about; the reverse order
  // would leave an entry with no secrets.
  for (const kind of SECRET_KINDS) {
    const value = await deps.store.get(profileSecretRef(from, kind))
    if (value) {
      await deps.store.set(profileSecretRef(to, kind), value)
      await deps.store.delete(profileSecretRef(from, kind))
    }
  }
  profiles[to] = profiles[from]
  delete profiles[from]
  await deps.writeConfig({ profiles, ...(config.activeProfile === from ? { activeProfile: to } : {}) })
  if (json) deps.stdout.write(`${JSON.stringify({ from, to })}\n`)
  else deps.stdout.write(`Renamed profile ${from} to ${to}.\n`)
  return 0
}

export async function profileRemove(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const name = parsed.positionals[0]
  if (!name || parsed.positionals.length !== 1) {
    writeUsageFailure(deps, "Usage: candle profile remove <name> --yes", json)
    return 2
  }
  const config = await deps.readConfig()
  const profiles = { ...(config.profiles ?? {}) }
  const profile = profiles[name]
  if (!profile) {
    writeLocalFailure(deps, { code: "NO_SUCH_PROFILE", message: `No profile named "${name}".` }, json)
    return 1
  }
  if (!parsed.booleans.has("--yes")) {
    // The invocation was incomplete, which is a usage failure like any other: stderr in human
    // mode, an envelope on stdout under --json. Printing the sentence on stdout put it on the
    // stream a --json caller parses, where it is not JSON, while stdout stayed empty for the
    // failure it actually needed to read.
    writeUsageFailure(
      deps,
      `Would delete profile ${name} (${profile.account ?? "unknown"} at ${profile.apiUrl ?? "default host"}) and its stored credentials. Re-run with --yes to confirm.`,
      json,
    )
    return 2
  }
  // Only this profile's two refs. Wallet signer refs are keyed by wallet id and belong to the
  // wallet, not to the credential that imported it (spec: "Wallet signers do NOT move").
  for (const kind of SECRET_KINDS) await deps.store.delete(profileSecretRef(name, kind))
  delete profiles[name]
  const wasActive = config.activeProfile === name
  await deps.writeConfig({ profiles, ...(wasActive ? { activeProfile: undefined } : {}) })
  if (json) deps.stdout.write(`${JSON.stringify({ removed: name })}\n`)
  else {
    // Removing the active profile leaves nothing selected. With one profile left, resolution
    // falls back to it and there is nothing to say; with several, the very next authenticated
    // command refuses with "several profiles exist and none is selected", so the way out is
    // named here instead of being discovered there.
    const needsPick = wasActive && Object.keys(profiles).length > 1
    deps.stdout.write(
      `Deleted profile ${name} and its stored credentials.${needsPick ? " Run: candle profile use <name>" : ""}\n`,
    )
  }
  return 0
}
