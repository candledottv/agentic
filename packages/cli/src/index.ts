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
import { hostname } from "node:os"
import { pathToFileURL } from "node:url"
import { resolveApiUrl } from "./client"
import { authLogin, authLogout, authStatus } from "./commands/auth"
import { doctor } from "./commands/doctor"
import { keysCreate, keysList, keysRevoke } from "./commands/keys"
import { wallets } from "./commands/wallets"
import { clearConfig, readConfig, writeConfig } from "./config"
import type { CommandContext, Deps } from "./deps"
import { resolveSecretStore } from "./keychain"
import { CLI_VERSION } from "./version"

interface GlobalFlags {
  apiUrl?: string
  json: boolean
  help: boolean
  version: boolean
}

function extractGlobalFlags(argv: string[]): { rest: string[]; flags: GlobalFlags } | { error: string } {
  const rest: string[] = []
  const flags: GlobalFlags = { json: false, help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") flags.json = true
    else if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--version" || arg === "-v") flags.version = true
    else if (arg === "--api-url") {
      const value = argv[++i]
      if (value === undefined) return { error: "--api-url requires a value" }
      flags.apiUrl = value
    } else if (arg?.startsWith("--api-url=")) flags.apiUrl = arg.slice("--api-url=".length)
    else if (arg !== undefined) rest.push(arg)
  }
  return { rest, flags }
}

const HELP_TEXT = `candle: manage Candle agent credentials from the terminal

Usage: candle <command> [subcommand] [options]

Commands:
  auth login [--scopes <a,b,c>] [--label <name>] [--no-browser]   Authorize this device
  auth status                                                     Show credential status
  auth logout [--keep-key]                                        Clear local credentials
  keys list                                                       List API keys
  keys create [--scopes <a,b,c>] [--environment production|test]  Create an API key
  keys revoke <prefix>                                            Revoke an API key
  wallets                                                         Show launch and linked wallets
  doctor                                                          Diagnose CLI setup

Global options:
  --api-url <url>         Override the API base URL
  --json                  Machine-readable output
  --help, -h              Show this help
  --version, -v           Show the CLI version
`

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
  const config = await deps.readConfig()
  const apiUrl = flags.apiUrl ?? resolveApiUrl(config.apiUrl, deps.env)
  const ctx: CommandContext = { deps, json: flags.json, apiUrl, apiUrlFlag: flags.apiUrl }

  if (cmd === "auth") {
    if (sub === "login") return authLogin(cmdArgs, ctx)
    if (sub === "status") return authStatus(cmdArgs, ctx)
    if (sub === "logout") return authLogout(cmdArgs, ctx)
    return unknownCommand(deps, sub === undefined ? undefined : `auth ${sub}`)
  }
  if (cmd === "keys") {
    if (sub === "list") return keysList(cmdArgs, ctx)
    if (sub === "create") return keysCreate(cmdArgs, ctx)
    if (sub === "revoke") return keysRevoke(cmdArgs, ctx)
    return unknownCommand(deps, sub === undefined ? undefined : `keys ${sub}`)
  }
  if (cmd === "wallets") return wallets(tokens.slice(1), ctx)
  if (cmd === "doctor") return doctor(tokens.slice(1), ctx)

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
