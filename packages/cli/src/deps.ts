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
import type { VerifyResult } from "./release-verify"
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
  /** Reads a file as raw bytes (`verify`'s asset, and the binary `update` downloads). Separate
   * from `readFile` rather than an option on it: what a signature covers is the byte sequence,
   * and a UTF-8 decode of a binary does not round trip, so the two must not share a path. */
  readBytes: (path: string) => Promise<Uint8Array>
  /** Writes a UTF-8 file with owner-only permissions (wallets import's `--signer-out`). The real
   * implementation writes mode 0600: the content is a signing private key. */
  writeFile: (path: string, content: string) => Promise<void>
  /** Reads a secret interactively with echo disabled (wallets import's prompt path, when no
   * `--key-file` is given). The real implementation needs a TTY and throws without one, which is
   * the signal to use `--key-file` in scripts. */
  promptSecret: (promptText: string) => Promise<string>
  /** This process's executable. A compiled binary reports itself; node or bun report the runtime.
   * Injected so update's install-method detection is testable without running a real binary. */
  execPath: string
  /** The script path when a runtime is running the CLI; `process.argv[1]`. Unused for a compiled
   * binary. `mcp --print-config`'s script-install branch needs both: `execPath` alone (node or
   * bun) is not a runnable MCP server command, so a GUI host needs the script path too. */
  argv1: string
  /** The release target this machine maps to (release.ts platformKey), or null off the four. */
  platformKey: string | null
  /** Resolves symlinks; Homebrew installs a symlink in bin/ pointing into the Cellar. */
  realpath: (path: string) => Promise<string>
  /** Writes bytes with mode 0755: the only writer of a new binary. */
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>
  /** Atomic replace on one filesystem; update writes next to the binary and renames over it. */
  rename: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  /** Injected so update's tests can stub the Sigstore verifier; the real deps leave it undefined
   * and update uses release-verify.ts. */
  verify?: (bytes: Uint8Array, bundle: unknown, identityUri: string, issuer: string) => VerifyResult
  /**
   * Starts the Candle MCP server IN THIS PROCESS on the stdio transport, with exactly the
   * environment given, resolving once the transport is connected.
   *
   * This replaced a `runChild("npx", ["--yes", "@candledottv/mcp"], env)` seam. That launch
   * resolved the server fresh from the registry on every invocation with no version or integrity
   * pin, and handed it a fund-moving API key: whatever `latest` happened to be at that moment got
   * the key, and a stable CLI install could change behaviour between runs without an upgrade. The
   * server is now bundled into this binary at build time, so it is the exact code that was tested,
   * signed and released alongside the CLI, and starting it needs no network at all.
   *
   * Still a dep seam for the reason the old one was: a test asserts the environment the server
   * would receive without starting a real server on this process's stdio.
   */
  runMcpServer: (env: Record<string, string | undefined>) => Promise<void>
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
