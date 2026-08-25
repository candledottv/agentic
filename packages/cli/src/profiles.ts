/**
 * profiles: one device, several accounts (docs/superpowers/specs/2026-08-19-cli-profiles-design.md).
 *
 * A profile is the non-secret half of an identity, stored in config.json under `profiles[name]`;
 * its device token and API key live in the SecretStore under the namespaced refs below. This
 * module is pure: resolution, naming, migration of the config shape, and the identity line. The
 * IO around it (reading config, copying secrets on migration) lives in index.ts and the commands.
 */

import type { CliConfig, ProfileConfig } from "./config"
// Type-only: deps.ts imports a value from this module, so a value import back here would form a
// runtime cycle. A type import is erased at compile time and carries no such risk.
import type { CommandContext } from "./deps"

export type { ProfileConfig }

/** `profile:<name>:device_token` / `profile:<name>:api_key`, mirroring walletSignerRef's per-wallet
 * namespacing so the store needs no new concept. */
export function profileSecretRef(name: string, kind: "deviceToken" | "apiKey"): string {
  return `profile:${name}:${kind === "deviceToken" ? "device_token" : "api_key"}`
}

/** A name that is safe as a keychain account attribute, a flag value and a JSON key: no
 * whitespace, quotes or newlines, at most 32 characters, starting with a letter or digit. */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)
}

export type ProfileResolution = { ok: true; name: string | undefined } | { ok: false; message: string }

function listForHumans(profiles: Record<string, ProfileConfig>, active: string | undefined): string {
  return Object.entries(profiles)
    .map(
      ([name, p]) =>
        `  ${name}${name === active ? " (active)" : ""}${p.account ? `  ${p.account}` : ""}${p.apiUrl ? `  ${p.apiUrl}` : ""}`,
    )
    .join("\n")
}

/**
 * Highest wins: the --profile flag, CANDLE_PROFILE, activeProfile, the sole profile. With
 * several profiles and none selected this REFUSES: guessing is how a wallet import landed on the
 * wrong account on 2026-08-19, and a two-line refusal cannot mislead. No profiles at all resolves
 * to `undefined`, the pre-profile mode, so a fresh install and an env-only invocation behave as
 * they always did.
 */
export function resolveProfileName(
  config: CliConfig,
  opts: { flag?: string; env: Record<string, string | undefined> },
): ProfileResolution {
  const profiles = config.profiles ?? {}
  const names = Object.keys(profiles)
  const requested = opts.flag?.trim() || opts.env.CANDLE_PROFILE?.trim() || undefined
  if (requested !== undefined) {
    if (!isValidProfileName(requested)) return { ok: false, message: `Invalid profile name: ${requested}` }
    if (!(requested in profiles)) {
      return {
        ok: false,
        message: `No profile named "${requested}".${names.length ? `\nProfiles on this machine:\n${listForHumans(profiles, config.activeProfile)}` : " Run: candle auth login --profile " + requested}`,
      }
    }
    return { ok: true, name: requested }
  }
  if (config.activeProfile && config.activeProfile in profiles) return { ok: true, name: config.activeProfile }
  if (names.length === 0) return { ok: true, name: undefined }
  if (names.length === 1) return { ok: true, name: names[0] }
  return {
    ok: false,
    message: `Several profiles exist and none is selected. Pick one with --profile <name> or CANDLE_PROFILE=<name>:\n${listForHumans(profiles, config.activeProfile)}`,
  }
}

/**
 * `auth login`'s own resolution, and the only lenient one. Same order as `resolveProfileName` --
 * the flag, CANDLE_PROFILE, activeProfile, the sole profile -- with two deliberate differences:
 * a named profile need NOT already exist (naming one is how login creates it), and nothing here
 * ever refuses. `undefined` means "no profile is in play", which login answers by deriving a name
 * from the host; it is not an error the way it would be for a command acting AS an identity.
 *
 * An unusable name is skipped rather than refused: an invalid `--profile` is rejected by
 * `authLogin` itself (exit 2, naming the flag), and an invalid `CANDLE_PROFILE` must not be able
 * to write a profile entry that `resolveProfileName` could never select afterwards.
 */
export function resolveProfileNameForLogin(
  config: CliConfig,
  opts: { flag?: string; env: Record<string, string | undefined> },
): string | undefined {
  const profiles = config.profiles ?? {}
  const requested = opts.flag?.trim() || opts.env.CANDLE_PROFILE?.trim() || undefined
  if (requested !== undefined && isValidProfileName(requested)) return requested
  if (config.activeProfile && config.activeProfile in profiles) return config.activeProfile
  const names = Object.keys(profiles)
  return names.length === 1 ? names[0] : undefined
}

const PRE_PROFILE_FIELDS = ["apiUrl", "keyPrefix", "deviceTokenPrefix", "scopes", "label", "portalOrigin"] as const

/**
 * The config half of migration: a pre-profile install becomes profile "default", active. The old
 * top-level fields are LEFT IN PLACE so a rollback to the previous CLI keeps working. The secret
 * copy (`device_token` -> `profile:default:device_token`, same for the key) is index.ts's job
 * because it needs the store. Idempotent: a config that already has `profiles` is returned as is.
 */
export function migratedConfig(config: CliConfig): { config: CliConfig; migrated: boolean } {
  if (config.profiles !== undefined) return { config, migrated: false }
  const legacy: ProfileConfig = {}
  for (const field of PRE_PROFILE_FIELDS) {
    const value = config[field]
    if (value !== undefined) (legacy as Record<string, unknown>)[field] = value
  }
  if (Object.keys(legacy).length === 0) return { config, migrated: false }
  return { config: { ...config, profiles: { default: legacy }, activeProfile: "default" }, migrated: true }
}

/**
 * The non-secret fields a command should read for THIS invocation: the profile's own when one is
 * in play (an unknown name yields nothing rather than borrowing another identity's), else the
 * pre-profile top-level ones. Defined once because the four places that hand-rolled the ternary
 * each got a piece of it wrong: `auth status` printed "not set" for both prefixes on every
 * login-created profile, `keys list` reported this device's own key as another machine's, and
 * `doctor` dropped the scopes from its agent-key row. A single reader is also what keeps the
 * legacy shape read-only in exactly one place when Phase 2 drops it.
 */
export function effectiveProfileFields(config: CliConfig, profile: string | undefined): ProfileConfig {
  if (profile !== undefined) return config.profiles?.[profile] ?? {}
  const legacy: ProfileConfig = {}
  for (const field of PRE_PROFILE_FIELDS) {
    const value = config[field]
    if (value !== undefined) (legacy as Record<string, unknown>)[field] = value
  }
  return legacy
}

/** "staging" or "production" for Candle's own hosts, else the hostname with dots as dashes,
 * run through `isValidProfileName` (a hostname may legally start with a character a profile name
 * may not, and such an entry could never be selected with `--profile` again) and de-duplicated
 * with a numeric suffix against the profiles that already exist. */
export function defaultProfileNameFor(apiUrl: string, existing: Record<string, ProfileConfig> | undefined): string {
  let host = "profile"
  try {
    host = new URL(apiUrl).hostname
  } catch {
    // keep the fallback
  }
  let base: string
  if (host === "staging.api.candle.tv") base = "staging"
  else if (host === "api.candle.tv" || host === "api.alpha.candle.tv") base = "production"
  else
    base =
      host
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/\./g, "-")
        .slice(0, 28) || "profile"
  if (!isValidProfileName(base)) base = "profile"
  const taken = new Set(Object.keys(existing ?? {}))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The credential env vars that BEAT the store (see deps.ts's resolvers), named where they are
 * acting. Non-blank only: an exported-but-empty variable overrides nothing. */
export function credentialEnvOverrides(env: Record<string, string | undefined>): string[] {
  return ["CANDLE_API_KEY", "CANDLE_DEVICE_TOKEN"].filter((name) => env[name]?.trim())
}

/**
 * The line every authenticated command prints first. Names what it does not know rather than
 * omitting it, because an absent field reads as "fine" and this line exists to be noticed.
 *
 * `overrides`, when non-empty, REPLACES the account: the cached name describes the profile's own
 * stored key, and an env override is a different credential for a possibly different account.
 * Printing the cached name beside a credential nothing checked asserts exactly the identity this
 * line exists to stop being assumed.
 */
export function identityLine(
  profile: string | undefined,
  account: string | undefined,
  apiUrl: string,
  overrides?: string[],
): string {
  const shown = overrides?.length ? `unknown (${overrides.join(", ")} override)` : (account ?? "unknown")
  return `Profile: ${profile ?? "none"}   Account: ${shown} at ${apiUrl}`
}

/** Every authenticated command prints this before its own output, human mode only; --json
 * outputs carry `profile` and `account` fields instead. Cached account, no network: the live
 * comparison is the Phase 2 guard. */
export async function printIdentity(ctx: CommandContext): Promise<void> {
  if (ctx.json) return
  const config = await ctx.deps.readConfig()
  const account = effectiveProfileFields(config, ctx.profile).account
  ctx.deps.stdout.write(`${identityLine(ctx.profile, account, ctx.apiUrl, credentialEnvOverrides(ctx.deps.env))}\n`)
}
