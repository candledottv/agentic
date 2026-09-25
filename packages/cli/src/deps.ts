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
import type { ReleasePolicy } from "./vault/enclave"

export interface Writer {
  write(chunk: string): void
}

export interface Deps {
  fetch: typeof fetch
  store: SecretStore
  backend: "keychain" | "secret-tool" | "encrypted-file"
  /**
   * Ember Phase 3 PR F (BE-226, R6): where `candle secrets` keeps the user's OWN third-party keys.
   * A separate keychain service (or, on the encrypted-file fallback, a separate file) from `store`,
   * which holds Candle's credentials: a keychain grant or an approved prompt for one namespace
   * never reaches the other, and a plug-in process reads neither.
   */
  secretsStore: SecretStore
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
  /**
   * This machine's home directory, for the ONE question that reads it: where the config directory
   * is when `CANDLE_CONFIG_DIR` is unset. `index.ts` binds `node:os`'s `homedir`, beside `hostname`
   * and `nodeVersion`, which are injected for the same reason.
   *
   * The vault's default path is built from this (BE-274, D1), so a test that resolved it read the
   * DEVELOPER's home: the "no vault here" branch passed on CI, where nothing has run `vault init`,
   * and failed on every machine that had. `createTestDeps` defaults it to a path that cannot exist,
   * so that branch is the same branch everywhere.
   */
  homedir: () => string
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
  /**
   * Reads standard input to its end, as raw bytes (R6: `candle sign` and `candle sign message`
   * without `--file`). Bytes rather than text for the same reason as `readBytes`: a signed message
   * is the exact byte stream, and a decode that dropped or replaced a byte would sign something
   * other than what was piped in.
   */
  readStdin: () => Promise<Uint8Array>
  /**
   * Runs a plug-in (R6): `path` with `args`, on THIS terminal (stdio inherited), with exactly
   * `env` and nothing the parent process holds. Resolves with the exit code. Injected so the
   * allowlist can be asserted against a real child in one test and left out of every other.
   */
  runPlugin: (path: string, args: string[], env: Record<string, string>) => Promise<number>
  /** Writes a UTF-8 file with owner-only permissions (wallets import's `--signer-out`). The real
   * implementation writes mode 0600: the content is a signing private key. */
  writeFile: (path: string, content: string) => Promise<void>
  /** Reads a secret interactively with echo disabled (wallets import's prompt path, when no
   * `--key-file` is given). The real implementation needs a TTY and throws without one, which is
   * the signal to use `--key-file` in scripts. */
  promptSecret: (promptText: string) => Promise<string>
  /**
   * Reads a VISIBLE line (Ember Phase 2, BE-136). The vault's ceremonies ask the operator to type
   * things back that are not secrets and must be readable as they are typed: a destination's last
   * six characters, an acknowledgement word, three words of a phrase already on the screen. Echoing
   * those is the point -- a hidden prompt for a value the operator is copying off their own screen
   * is how a confirmation becomes a coin flip.
   *
   * Separate from `promptSecret` rather than a flag on it so that "is this input echoed?" is
   * decided by which function a command calls, and a test's fake for one is never silently reused
   * for the other.
   */
  promptLine: (promptText: string) => Promise<string>
  /**
   * Whether stdin, stdout and stderr are terminals (Ember Phase 2, BE-136). Injected rather than
   * read from `process` at the call site because the refusals that depend on it are the point of
   * two tests: the phrase ceremony must refuse BEFORE it renders anything when either end is not a
   * TTY (T54), and every vault command that collects a secret refuses without one rather than
   * falling back.
   *
   * `stderr` is here because the prompt writes THERE, not to stdout (`prompt-streams.ts`'s
   * `realPromptStreams` names `output: process.stderr`). `requireTty` demands stdin and stdout and
   * is unchanged; `requirePromptStreams` (BE-274, D7) demands the two streams the prompt actually
   * uses, so a listing whose whole output is a document can be redirected to a file.
   */
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean }
  /** This process's executable. A compiled binary reports itself; node or bun report the runtime.
   * Injected so update's install-method detection is testable without running a real binary. */
  execPath: string
  /** The script path when a runtime is running the CLI; `process.argv[1]`. Unused for a compiled
   * binary. `mcp --print-config`'s script-install branch needs both: `execPath` alone (node or
   * bun) is not a runnable MCP server command, so a GUI host needs the script path too. */
  argv1: string
  /** The release target this machine maps to (release.ts platformKey), or null off the four. */
  platformKey: string | null
  /**
   * `process.platform` and `process.arch`, injected (Ember Phase 2, BE-140, CC-12). The platform
   * seam reads these rather than `process` so T58 can drive every row of the refusal table on one
   * host, including the Windows row this CLI ships no binary for.
   */
  platform: string
  arch: string
  /**
   * Runs the `candle-fido2` helper once (Ember Phase 2, BE-140, helper protocols): spawns `path`
   * with a pipe on stdin and stdout, writes `requestLine` followed by a newline, closes stdin, and
   * resolves with everything the process printed and how it ended. `args` is for the two other
   * things the vault spawns the same way (BE-141): the Secure Enclave helper's executable takes
   * none, and `/usr/bin/codesign` takes its verification flags there and reads nothing. Past `timeoutMs` the process is
   * terminated and the result reports the signal. The real implementation never gives the helper
   * the terminal; a test's fake answers from a script, and the subprocess test spawns a scripted
   * helper over a real pipe so the plumbing itself is exercised.
   */
  spawnHelper: (
    path: string,
    requestLine: string,
    opts: { timeoutMs: number; args?: string[] },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; spawnError?: string }>
  /**
   * The checked-in release policy (Ember Phase 2, BE-141): whether this build ships the signed
   * Secure Enclave helper, and the team id and bundle id its code signature must carry. The real
   * deps read `packages/cli/release-policy.json`, the same file the release job reads; tests
   * inject either state, so the `omit` refusal and the `signed` path are both exercised on any
   * host.
   */
  releasePolicy: ReleasePolicy
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
  /**
   * Phase 4b (spec 2026-09-24-ember-phase-4b-hood-tee-wallets-design.md, D1): append one entry to
   * the sealed EVM record beside this machine's vault, without unlocking it. The trading leg loop
   * (BE-392) calls it after each Hood TEE leg lands; the writer itself (header read, sealing, the
   * record lock, torn-tail repair) is the custody slice's (BE-391). Optional so the call site can
   * land first: absent, the append is skipped with a notice, which is what a landed leg does for
   * any append that cannot run. It never throws for a skip; a throw is treated as a skip too.
   */
  appendEvmRecord?: (ctx: CommandContext, entry: EvmRecordTokenEntry) => Promise<EvmRecordAppendOutcome>
}

/** A `token` line of the sealed EVM record (D1): a token a landed leg on `wallet` traded. */
export interface EvmRecordTokenEntry {
  kind: "token"
  wallet: string
  token: string
}

/** What an append did. A skip carries the notice the CLI prints; a landed leg never fails on it. */
export type EvmRecordAppendOutcome = { appended: true; notice?: string } | { appended: false; notice: string }

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
  /**
   * `--factor <envelope id | passphrase | security-key>` (Ember Phase 2, BE-140, CC-12): which
   * envelope a vault command unlocks with. Global, so every command that opens the vault honours
   * it the same way. Absent, the CLI asks when more than one kind can open the vault here, and
   * never picks a different envelope on the operator's behalf.
   */
  vaultFactor?: string
  /** `--device <id>` (BE-140): the security key an operation names, from `candle vault factor list`'s ids. */
  vaultDevice?: string
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
