#!/usr/bin/env node
/**
 * `candle`: the CLI's dispatch entry. `run(argv, deps)` is exported for tests (see
 * `test-support.ts`'s fakes) and is what the bin entry at the bottom of this file calls with real
 * deps and `process.argv.slice(2)`.
 *
 * Global flags (`--api-url`, `--json`, `--help`, `--version`) are stripped out of `argv` wherever
 * they appear, so `candle keys list --json` and `candle --json keys list` behave identically. One
 * leading `candle` token is dropped too (bunx passes the bin's own name through as argv[0]; see
 * the comment at that line). The remaining tokens are the command path: `auth
 * <login|status|logout>`, `keys <list|create|revoke>`, `wallets`, `doctor`.
 *
 * Exit codes: 0 success, 1 user-facing failure (denied, expired, invalid input, or a routing
 * failure -- no command or subcommand matched, so nothing ran), 2 a malformed invocation of an
 * otherwise-valid command (a recognized command missing a required flag/argument, or given an
 * unknown flag). `doctor` exits 1 on any FAIL row (`doctor.ts`).
 */

import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { pathToFileURL } from "node:url"
import { resolveApiUrl } from "./client"
import { authLogin, authLogout, authStatus } from "./commands/auth"
import { doctor } from "./commands/doctor"
import { keysCreate, keysList, keysRevoke } from "./commands/keys"
import { mcp } from "./commands/mcp"
import { profileAdd, profileList, profileRemove, profileRename, profileUse } from "./commands/profile"
import { setup } from "./commands/setup"
import { wallets, walletsImport, walletsRevoke } from "./commands/wallets"
import type { CliConfig } from "./config"
import { clearConfig, readConfig, updateProfile, writeConfig } from "./config"
import type { CommandContext, Deps } from "./deps"
import { verifyProfileAccount } from "./guard"
import { resolveSecretStore } from "./keychain"
import { migratedConfig, profileSecretRef, resolveProfileName, resolveProfileNameForLogin } from "./profiles"
import { promptHiddenSecret, SECRET_REFS } from "./secret-store"
import { CLI_VERSION } from "./version"

interface GlobalFlags {
  apiUrl?: string
  profile?: string
  json: boolean
  help: boolean
  version: boolean
  noVerifyAccount: boolean
}

function extractGlobalFlags(argv: string[]): { rest: string[]; flags: GlobalFlags } | { error: string } {
  const rest: string[] = []
  const flags: GlobalFlags = { json: false, help: false, version: false, noVerifyAccount: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") flags.json = true
    else if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--version" || arg === "-v") flags.version = true
    else if (arg === "--no-verify-account") flags.noVerifyAccount = true
    else if (arg === "--api-url") {
      const value = argv[++i]
      if (value === undefined) return { error: "--api-url requires a value" }
      flags.apiUrl = value
    } else if (arg?.startsWith("--api-url=")) flags.apiUrl = arg.slice("--api-url=".length)
    else if (arg === "--profile") {
      const value = argv[++i]
      if (value === undefined) return { error: "--profile requires a value" }
      flags.profile = value
    } else if (arg?.startsWith("--profile=")) flags.profile = arg.slice("--profile=".length)
    else if (arg !== undefined) rest.push(arg)
  }
  return { rest, flags }
}

const HELP_TEXT = `candle: manage Candle agent credentials from the terminal

Usage: candle <command> [subcommand] [options]

Commands:
  auth login [--scopes <a,b,c>] [--label <name>] [--no-browser]   Authorize this device
             [--profile <name>]
  auth status                                                     Show credential status
  auth logout [--keep-key]                                        Clear local credentials
  keys list                                                       List API keys
  keys create [--scopes <a,b,c>] [--label <name>]                 Create an API key
              [--expires-in <days>] [--tx-limit <usd> [--reset daily|weekly|monthly|never]]
  keys revoke <prefix>                                            Revoke an API key
  wallets                                                         Show launch and linked wallets
  wallets import --chain <solana|evm> [options]                   Import a wallet you own (key via --key-file or hidden prompt)
  wallets revoke <wallet-id>                                      Revoke a linked wallet
  profile list                                                    Profiles on this machine, with cached accounts
  profile add <name> --api-url <url>                              Create a profile before authenticating it
  profile use <name>                                              Make a profile the active one
  profile rename <old> <new>                                      Rename a profile
  profile remove <name> --yes                                     Delete a profile and its stored credentials
  setup [--no-browser]                                            One wizard: authorize, fund, connect, verify
  mcp [--tools <a,b,c>] [--read-only] [--print-config]            Run the Candle MCP server with stored credentials
  doctor                                                          Diagnose CLI setup

Global options:
  --api-url <url>         Override the API base URL
  --profile <name>        Act as a named profile (see: candle auth login --profile)
  --no-verify-account     Skip the check that the stored key belongs to the profile's account
  --json                  Machine-readable output
  --help, -h              Show this help
  --version, -v           Show the CLI version
`

/** Every command word the dispatch chain in `run` routes. The guard's gate reads it so that an
 * unrecognized word prints usage without a network call. It duplicates the chain, so
 * `index.test.ts` asserts it against the Commands: block of HELP_TEXT, which enforces exactly
 * this: a command DOCUMENTED in HELP_TEXT must appear here. A command added to dispatch with no
 * help entry satisfies the test and still runs unguarded; what prevents that is the convention
 * that every command is documented, not the test. */
export const ROUTED_COMMANDS = new Set(["auth", "keys", "wallets", "profile", "doctor", "mcp", "setup"])

/**
 * The commands the account guard never runs for, in one place. The rule is what a command does
 * with the identity: the guard belongs in front of the ones that ACT as it, and nowhere else.
 * `auth` in every form is the repair path (login re-authenticates a profile whose key moved,
 * status only reads, and logout revokes the stored key using that very credential); `doctor` only
 * reads, and is how a mismatch gets seen in the first place; `profile` manages the profiles map
 * rather than acting as an identity. Refusing any of these would leave an operator holding a
 * mismatch with no command left to diagnose or repair it with.
 *
 * `setup` is deliberately NOT here: it skips its login step whenever both credentials are already
 * stored (setup.ts) and then mints keys as whoever those credentials belong to.
 */
export const NEVER_GUARDED = new Set(["auth", "profile", "doctor"])

export async function run(argv: string[], deps: Deps): Promise<number> {
  const extracted = extractGlobalFlags(argv)
  if ("error" in extracted) {
    deps.stderr.write(`${extracted.error}\n`)
    return 2
  }
  const { rest, flags } = extracted

  if (flags.version) {
    deps.stdout.write(`${CLI_VERSION}\n`)
    return 0
  }
  if (flags.help) {
    deps.stdout.write(HELP_TEXT)
    return 0
  }

  // `bunx github:candledottv/agentic candle auth login` uses "candle" to RESOLVE the bin and then
  // passes that same token through as the CLI's own first argument, so argv here starts with the
  // bin's own name rather than a command. Dropping exactly one leading "candle" makes both
  // invocation forms dispatch identically; a second one (`candle candle auth`) is still an
  // unknown command, as it should be.
  const tokens = rest[0] === "candle" ? rest.slice(1) : rest

  const [cmd, sub, ...cmdArgs] = tokens
  const config = await migrateProfiles(deps)
  // `auth login` resolves LENIENTLY about EXISTENCE (resolveProfileNameForLogin): its `--profile`
  // may name a profile to CREATE, so it must not be gated by resolveProfileName's "does this name
  // already exist" refusal, which exists to protect a command ACTING as an already-selected
  // identity. But it must still SEE the profile that is already selected: skipping resolution
  // entirely made every re-login derive a fresh host-based name, filing the new credentials under
  // `production-2` while every other command went on resolving `production`, and losing the
  // selected profile's own `apiUrl` in the bargain. See
  // docs/superpowers/specs/2026-08-19-cli-profiles-design.md, "auth login creates a profile
  // implicitly" (settled 2026-08-19). An invalid NAME is still refused: `authLogin` validates the
  // flag's shape itself (naming the flag in its message), and resolveProfileNameForLogin refuses
  // an invalid CANDLE_PROFILE the same way, below, as a usage error rather than a silent skip to
  // whatever profile was already active.
  const isAuthLogin = cmd === "auth" && sub === "login"
  // `profile` needs no resolved identity at all: its subcommands manage the profiles map itself
  // (list, add, and -- Tasks 3 and 4 -- use/rename/remove), and `profile use` is the way OUT of
  // resolveProfileName's "several profiles, none selected" refusal, so it cannot be gated by it.
  const isProfileCommand = cmd === "profile"
  const resolution = isAuthLogin
    ? resolveProfileNameForLogin(config, { flag: flags.profile, env: deps.env })
    : isProfileCommand
      ? ({ ok: true, name: undefined } as const)
      : resolveProfileName(config, { flag: flags.profile, env: deps.env })
  if (!resolution.ok) {
    deps.stderr.write(`${resolution.message}\n`)
    // A resolution failure reaching `auth login` is a usage error (an invalid CANDLE_PROFILE,
    // Task 6): exit 2, before any request. Every other command's refusal (an ambiguous or unknown
    // profile selection) stays exit 1, as it always has.
    return isAuthLogin ? 2 : 1
  }
  const profile = resolution.name
  const profileApiUrl = profile ? config.profiles?.[profile]?.apiUrl : config.apiUrl
  const apiUrl = flags.apiUrl ?? resolveApiUrl(profileApiUrl, deps.env)
  const ctx: CommandContext = {
    deps,
    json: flags.json,
    apiUrl,
    apiUrlFlag: flags.apiUrl,
    profile,
    profileFlag: flags.profile,
    verifyAccount: !flags.noVerifyAccount,
  }

  // The strict account guard (guard.ts), run once here rather than inside each command: a command
  // that ACTS as the resolved profile must first be told its stored key still belongs to that
  // profile's account, and that is one decision about the command being dispatched, not six
  // copies of one. NEVER_GUARDED names the commands that only read the identity or repair it,
  // which must keep working precisely when the guard would refuse; ROUTED_COMMANDS keeps an
  // unrecognized word on the help path without a network call.
  const word = cmd ?? ""
  if (ROUTED_COMMANDS.has(word) && !NEVER_GUARDED.has(word)) {
    const verdict = await verifyProfileAccount(ctx, config)
    if (!verdict.ok) {
      deps.stderr.write(`${verdict.message}\n`)
      return 1
    }
    if (verdict.warning) deps.stderr.write(`${verdict.warning}\n`)
  }

  if (cmd === "auth") {
    if (sub === "login") return authLogin(cmdArgs, ctx)
    if (sub === "status") return authStatus(cmdArgs, ctx)
    if (sub === "logout") return authLogout(cmdArgs, ctx)
    return unknownCommand(deps, sub === undefined ? undefined : `auth ${sub}`)
  }
  if (cmd === "profile") {
    if (sub === "list") return profileList(cmdArgs, ctx)
    if (sub === "add") return profileAdd(cmdArgs, ctx)
    if (sub === "use") return profileUse(cmdArgs, ctx)
    if (sub === "rename") return profileRename(cmdArgs, ctx)
    if (sub === "remove") return profileRemove(cmdArgs, ctx)
    return unknownCommand(deps, sub === undefined ? undefined : `profile ${sub}`)
  }
  if (cmd === "keys") {
    if (sub === "list") return keysList(cmdArgs, ctx)
    if (sub === "create") return keysCreate(cmdArgs, ctx)
    if (sub === "revoke") return keysRevoke(cmdArgs, ctx)
    return unknownCommand(deps, sub === undefined ? undefined : `keys ${sub}`)
  }
  if (cmd === "wallets") {
    if (sub === "import") return walletsImport(cmdArgs, ctx)
    if (sub === "revoke") return walletsRevoke(cmdArgs, ctx)
    return wallets(tokens.slice(1), ctx)
  }
  if (cmd === "doctor") return doctor(tokens.slice(1), ctx)
  // tokens.slice(1), not cmdArgs: mcp has no subcommand, so its first flag must not be
  // destructured away as one (same shape as doctor above).
  if (cmd === "mcp") return mcp(tokens.slice(1), ctx)
  if (cmd === "setup") return setup(tokens.slice(1), ctx)

  return unknownCommand(deps, cmd)
}

/** Names the offending token before printing help, so "it printed usage" and "it did not
 * recognize THIS word" are distinguishable -- the runbook's bunx diagnostic reads the token back.
 * `undefined` means nothing was typed to be wrong about (a bare `candle`, or `candle auth` with
 * no subcommand), which gets help alone. Exit 1 either way: a routing failure, nothing ran. */
function unknownCommand(deps: Deps, token: string | undefined): number {
  if (token !== undefined) deps.stderr.write(`Unknown command: ${token}\n`)
  deps.stderr.write(HELP_TEXT)
  return 1
}

/**
 * First run after the upgrade that introduced profiles: a pre-profile install becomes profile
 * "default" (config half in profiles.ts's migratedConfig), and its two secrets are COPIED to the
 * namespaced refs. The old refs and fields are left in place: a rollback to the previous CLI must
 * keep working, and a keychain entry is not ours to delete on someone's behalf. Silent on success.
 */
async function migrateProfiles(deps: Deps): Promise<CliConfig> {
  const before = await deps.readConfig()
  const { config, migrated } = migratedConfig(before)
  if (!migrated) return before
  for (const [legacyRef, kind] of [
    [SECRET_REFS.deviceToken, "deviceToken"],
    [SECRET_REFS.apiKey, "apiKey"],
  ] as const) {
    const value = await deps.store.get(legacyRef)
    if (value) await deps.store.set(profileSecretRef("default", kind), value)
  }
  await deps.writeConfig({ profiles: config.profiles, activeProfile: config.activeProfile })
  return config
}

/** Best-effort browser launch: `open` on macOS, `start` via `cmd` on Windows, `xdg-open`
 * elsewhere. Failure (no launcher on PATH, no display) is swallowed -- the URL is always printed
 * by the caller regardless, which is the actual guarantee for a headless/SSH session. Not unit
 * tested: it spawns a real OS process, the same reason secret-store.ts's
 * `promptHiddenPassphrase` (which needs a real TTY) is left untested; command tests inject their
 * own `openBrowser` fake instead (see `deps.openBrowser`). */
function realOpenBrowser(url: string): void {
  try {
    const platform = process.platform
    const child =
      platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Best-effort only.
  }
}

async function buildRealDeps(): Promise<Deps> {
  const { store, backend } = await resolveSecretStore()
  return {
    fetch: globalThis.fetch,
    store,
    backend,
    readConfig,
    writeConfig,
    clearConfig,
    updateProfile,
    stdout: {
      write: (chunk: string) => {
        process.stdout.write(chunk)
      },
    },
    stderr: {
      write: (chunk: string) => {
        process.stderr.write(chunk)
      },
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: realOpenBrowser,
    env: process.env,
    nodeVersion: process.versions.node,
    hostname: hostname(),
    runChild: (command, args, env) =>
      new Promise((resolve) => {
        // shell on Windows: npx is npx.cmd there, and spawn without a shell cannot resolve it.
        const child = spawn(command, args, {
          stdio: "inherit",
          env: env as NodeJS.ProcessEnv,
          shell: process.platform === "win32",
        })
        child.on("error", () => resolve(1))
        child.on("close", (code) => resolve(code ?? 1))
      }),
    readFile: (path: string) => readFile(path, "utf8"),
    // 0600: the only caller is wallets import's --signer-out, and the content is a signing
    // private key.
    writeFile: (path: string, content: string) => writeFile(path, content, { mode: 0o600 }),
    promptSecret: promptHiddenSecret,
  }
}

async function main(): Promise<void> {
  const deps = await buildRealDeps()
  const code = await run(process.argv.slice(2), deps)
  process.exit(code)
}

// Only run the bin entry when this module is executed directly, not when a test imports `run`.
// `process.argv[1]` is the entry script's path either way (bun test's own runner when imported by
// a test, this file's own path when run directly), so comparing it against `import.meta.url`
// distinguishes the two under both bun and plain node -- unlike `import.meta.main`, which bun
// supports but node does not.
//
// argv[1] must be REALPATH'd before comparing: package managers execute a bin through a symlink
// (node_modules/.bin/candle -> .../packages/cli/dist/index.js), and node resolves import.meta.url
// to the real file while argv[1] keeps the symlink path. Without the realpath, every bunx/npx
// invocation failed this guard and exited 0 having done nothing -- caught live by the P4b-3
// acceptance test, invisible to any test that ran the file by its direct path.
function entryHref(argv1: string): string {
  try {
    return pathToFileURL(realpathSync(argv1)).href
  } catch {
    // argv[1] may not exist as a file at all (some embedders pass synthetic values); fall back to
    // the plain comparison, which is what this guard always did for the direct-path case.
    return pathToFileURL(argv1).href
  }
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === entryHref(process.argv[1])
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
