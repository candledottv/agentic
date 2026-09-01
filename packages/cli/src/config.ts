/**
 * config: the CLI's non-secret settings file, `~/.config/candle/config.json` (or
 * `$CANDLE_CONFIG_DIR/config.json` in tests -- see the comment in secret-store.ts, mirrored here so
 * this file's path resolution stays self-contained).
 *
 * Credentials -- the device token and API key values themselves -- never land in this file. They
 * live in whichever `SecretStore` `resolveSecretStore()` picked (OS keychain, or the separate
 * encrypted `credentials.enc`). `CliConfig` only ever holds plain, non-secret CLI state: it is
 * written and read as ordinary JSON and is safe to `cat`, back up, or commit to a dotfiles repo.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The non-secret half of one identity. The two secrets that belong to it live in the
 * SecretStore under `profileSecretRef(name, kind)` (profiles.ts). `account` is cached at
 * login for display and, in Phase 2, the mismatch guard; it is never a credential.
 */
export interface ProfileConfig {
  apiUrl?: string
  account?: string
  /** The account's Candle username (optional; not everyone sets one), cached beside `account` for
   * the identity line to render `Account: <username> (<address>)`. Display only, never a credential. */
  username?: string
  /** Unix ms when `account` was last read from the API (auth login, profile use). Display only. */
  accountCachedAt?: number
  keyPrefix?: string
  deviceTokenPrefix?: string
  scopes?: string[]
  label?: string
  portalOrigin?: string
}

/** Plain, non-secret CLI state. See this file's header comment: no credential fields belong here. */
export interface CliConfig {
  /** One entry per identity on this machine. See profiles.ts. */
  profiles?: Record<string, ProfileConfig>
  /** The profile a command acts as when neither --profile nor CANDLE_PROFILE names one. */
  activeProfile?: string
  // The fields below are the PRE-PROFILE shape. They stay readable for migration and are left in
  // place afterwards (a rollback to the previous CLI must keep working); nothing writes them
  // once `profiles` exists.
  /** The API base URL to use when `CANDLE_API_URL` is not set. See client.ts's `resolveApiUrl`. */
  apiUrl?: string
  /** The stored API key's display prefix (e.g. `ck_live_ab12`), for `candle key list`-style output. */
  keyPrefix?: string
  /** The stored device token's display prefix, for the same reason. */
  deviceTokenPrefix?: string
  /**
   * When the update-available notice last printed, and for which version (update-notice.ts).
   * Throttle state only: the notice shows at most once per day per newer version, so a daily
   * driver sees it without every command nagging.
   */
  updateNotice?: { version: string; shownAt: number }
  /** The scopes this device/key was authorized with. */
  scopes?: string[]
  /** A human-readable label for this device, as shown during authorization. */
  label?: string
  /**
   * The portal's origin (scheme + host + port, no path), recorded at login from the origin of the
   * device-code response's `verificationUri` -- which the API builds from its own `FRONTEND_URL`.
   * That makes it authoritative rather than guessed: `auth logout` points at the portal screen
   * that can actually revoke this device, and on a non-default backend (staging, a local API) no
   * rule derived from the API URL can be relied on to name it. Optional: absent in any config
   * written before this field existed, and in env-only usage that never ran `auth login` here,
   * both of which fall back to `portalDeviceUrl`'s derivation.
   */
  portalOrigin?: string
}

function configDir(): string {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle")
}

function configFilePath(): string {
  return join(configDir(), "config.json")
}

/** Reads the config file, returning `{}` if it does not exist yet. */
export async function readConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(configFilePath(), "utf8")
    return JSON.parse(raw) as CliConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

/** Shallow-merges `patch` into the existing config (or `{}` if none exists yet) and writes it back. */
export async function writeConfig(patch: Partial<CliConfig>): Promise<void> {
  const current = await readConfig()
  const next: CliConfig = { ...current, ...patch }
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  // Same directory `credentials.enc` lives in by default (see secret-store.ts), so this is
  // consistent with -- and, in normal use, redundant with -- the 0700 that file's writes already
  // enforce on it. Setting it here too means `writeConfig` alone (before any credential is ever
  // stored) still leaves `~/.config/candle` non-world-readable.
  await chmod(dir, 0o700)
  await writeFile(configFilePath(), JSON.stringify(next, null, 2), "utf8")
}

/** Merges `patch` into `profiles[name]` (creating the profile) and writes the file. Sibling
 * profiles and the top-level fields are untouched. An undefined field clears, like writeConfig. */
export async function updateProfile(name: string, patch: Partial<ProfileConfig>): Promise<void> {
  const current = await readConfig()
  const profiles = { ...(current.profiles ?? {}) }
  profiles[name] = { ...(profiles[name] ?? {}), ...patch }
  await writeConfig({ profiles })
}

/** Deletes the config file. A no-op if it does not exist. */
export async function clearConfig(): Promise<void> {
  try {
    await rm(configFilePath())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}
