/**
 * `Deps`: everything a command needs, injected so tests never touch the network, a real keychain,
 * real timers, or the real filesystem outside a `CANDLE_CONFIG_DIR` temp dir. `index.ts`'s bin
 * entry builds the real version of this (real fetch, `resolveSecretStore()`, the real config
 * file, real process.stdout/stderr, a real clock, a real browser-opener, `process.env`); tests
 * build fakes (see `test-support.ts`).
 *
 * `CommandContext` is the smaller, per-invocation slice every command function actually takes:
 * the full `Deps`, whether `--json` was passed, and the API URL already resolved for this run
 * (`--api-url` flag, else `CANDLE_API_URL` env, else the stored config value, else the default --
 * see `client.ts`'s `resolveApiUrl`). `apiUrlFlag` carries the RAW `--api-url` value only when the
 * flag was actually given this invocation, distinct from the already-resolved `apiUrl`: `auth
 * login` needs to know whether to persist an override into config, and "the flag was passed" is
 * not recoverable from the resolved value alone (a flag equal to the default would look identical
 * to no flag at all).
 */

import type { CliConfig, ProfileConfig } from "./config"
import { profileSecretRef } from "./profiles"
import type { SecretStore } from "./secret-store"
import { SECRET_REFS } from "./secret-store"

export interface Writer {
  write(chunk: string): void
}

export interface Deps {
  fetch: typeof fetch
  store: SecretStore
  backend: "keychain" | "secret-tool" | "encrypted-file"
  readConfig: () => Promise<CliConfig>
  writeConfig: (patch: Partial<CliConfig>) => Promise<void>
  clearConfig: () => Promise<void>
  updateProfile: (name: string, patch: Partial<ProfileConfig>) => Promise<void>
  stdout: Writer
  stderr: Writer
  /** Current time in ms. Only ever compared against other `now()` calls and `sleep`-advanced
   * time, never against a wall-clock constant, so a fake clock starting anywhere is safe. */
  now: () => number
  /** Waits `ms` milliseconds. The device-flow poll loop sleeps through this exclusively, so a
   * fake implementation can advance a fake clock and resolve instantly instead of actually
   * waiting. */
  sleep: (ms: number) => Promise<void>
  /** Best-effort browser launch. Real implementation (index.ts) tries open/xdg-open/start and
   * swallows failure; the URL is always printed by the caller regardless, for SSH sessions. */
  openBrowser: (url: string) => void
  env: Record<string, string | undefined>
  /** The running Node version string (e.g. "22.23.2"), for `doctor`'s runtime-version check.
   * Real implementation reads `process.versions.node`; injected here (rather than doctor.ts
   * reading `process.versions.node` directly) so that check's FAIL branch is testable without
   * actually running the CLI under an old Node. */
  nodeVersion: string
  /** This machine's hostname, which `auth login` puts in the default `clientName` shown on the
   * approval screen. Injected for the same reason `nodeVersion` is: the interesting branch is a
   * hostname long enough to push the default name past the API's 64-character cap, and that is
   * not reproducible by running the CLI on the test machine. */
  hostname: string
  /** Reads a UTF-8 file (wallets import's `--key-file`). Injected so tests never touch the real
   * filesystem and a missing-file failure is testable with a plain throwing fake. */
  readFile: (path: string) => Promise<string>
  /** Writes a UTF-8 file with owner-only permissions (wallets import's `--signer-out`). The real
   * implementation writes mode 0600: the content is a signing private key. */
  writeFile: (path: string, content: string) => Promise<void>
  /** Reads a secret interactively with echo disabled (wallets import's prompt path, when no
   * `--key-file` is given). The real implementation needs a TTY and throws without one, which is
   * the signal to use `--key-file` in scripts. */
  promptSecret: (promptText: string) => Promise<string>
  /** Runs a child process to completion with stdio inherited, resolving to its exit code.
   * `candle mcp` launches the MCP server through this exclusively, so a test can assert the
   * exact command, args, and env without spawning anything -- the same seam discipline as
   * `fetch` and `openBrowser`. The real implementation (index.ts) uses child_process.spawn. */
  runChild: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<number>
}

export interface CommandContext {
  deps: Deps
  json: boolean
  apiUrl: string
  /** The raw `--api-url` value for THIS invocation, if the flag was given; undefined otherwise.
   * See this file's header comment for why this is not recoverable from `apiUrl` alone. */
  apiUrlFlag?: string
  /** The resolved profile for this invocation (see profiles.ts resolveProfileName); undefined in
   * the pre-profile mode (no profiles exist). Commands pass this to the credential resolvers and
   * write profile fields under it. */
  profile?: string
  /** The raw --profile value, only when the flag was given. `auth login` names a NEW profile
   * from it, which the resolved `profile` cannot express (that name does not exist yet). */
  profileFlag?: string
  /** False when --no-verify-account was given: the strict account guard (guard.ts) is skipped. */
  verifyAccount: boolean
}

/** Resolves the device token: `CANDLE_DEVICE_TOKEN` env override first, then the named profile's
 * ref, or the legacy ref when no profile is in play. Defined exactly once; every command goes
 * through here. A profile with nothing stored resolves to undefined, never to another identity. */
export async function resolveDeviceToken(deps: Deps, profile?: string): Promise<string | undefined> {
  const fromEnv = deps.env.CANDLE_DEVICE_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const ref = profile ? profileSecretRef(profile, "deviceToken") : SECRET_REFS.deviceToken
  const stored = await deps.store.get(ref)
  return stored ?? undefined
}

/** Resolves the API key: `CANDLE_API_KEY` env override first, then the profile's ref, else legacy. */
export async function resolveApiKey(deps: Deps, profile?: string): Promise<string | undefined> {
  const fromEnv = deps.env.CANDLE_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const ref = profile ? profileSecretRef(profile, "apiKey") : SECRET_REFS.apiKey
  const stored = await deps.store.get(ref)
  return stored ?? undefined
}
