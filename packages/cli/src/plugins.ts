/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-10): git-style plug-ins.
 *
 * An executable `candle-<name>` on `PATH` runs as `candle <name>` when `<name>` is not a built-in
 * command. The plug-in is the user's own code, talking to whatever service the user has a key for,
 * from the user's machine, with the user's own key; Candle is not in that request. What this module
 * decides is the ONE thing the CLI controls about that: the environment the child receives.
 *
 * **The child's environment is an allowlist, built from empty.** It is not the parent's environment
 * with a deny list applied, because a deny list is wrong the day someone adds a variable. The CLI
 * passes through only what a process needs to run and reach the network as this user (`PATH`,
 * `HOME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LC_*`, the proxy variables), plus
 * `CANDLE_PLUGIN_RPC_URL` and `CANDLE_PLUGIN_NETWORK` from the active profile, the external wallet
 * addresses named on the invocation as `CANDLE_PLUGIN_WALLET_<LABEL>`, and the secrets named on the
 * invocation as `CANDLE_SECRET_<NAME>`. Everything else is absent: no parent `CANDLE_*` variable
 * (`CANDLE_API_KEY`, `CANDLE_DEVICE_TOKEN`, `CANDLE_KEYSTORE_PASSPHRASE`, `CANDLE_SOLANA_RPC_URL`,
 * any other), never the Candle API key, the device token, the vault passphrase or a private key.
 *
 * Addresses and secrets are passed on request, not broadcast: a plug-in learns an external wallet's
 * address only when the invocation names it, and a secret only when the invocation names it. The
 * `--secret` and `--wallet` flags are consumed here and stripped from the argv the plug-in gets, so
 * it never sees the names it was granted as arguments, only the values in its environment. Every
 * other argument after the plug-in name is passed through verbatim.
 */
import { spawn } from "node:child_process"
import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

export const PLUGIN_PREFIX = "candle-"

/**
 * The names beside the `candle` binary that are NOT plug-ins: the helpers this CLI ships and
 * spawns itself. Listing them as plug-ins would invite `candle fido2` to run a helper on the
 * terminal it was designed never to see.
 */
export const RESERVED_HELPER_NAMES: readonly string[] = ["fido2", "enclave"]

/** A plug-in name is one path segment of the plainest kind: no slash, no dot, nothing a shell expands. */
export function isPluginName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && !RESERVED_HELPER_NAMES.includes(name)
}

function executableAt(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first `candle-<name>` executable on `PATH`, or undefined. */
export function findPlugin(name: string, pathEnv: string | undefined): string | undefined {
  if (!isPluginName(name)) return undefined
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue
    const candidate = join(dir, `${PLUGIN_PREFIX}${name}`)
    if (executableAt(candidate)) return candidate
  }
  return undefined
}

/** Every plug-in on `PATH`, first directory wins for a name found twice, sorted by name. */
export function listPlugins(pathEnv: string | undefined): Array<{ name: string; path: string }> {
  const found = new Map<string, string>()
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of names) {
      if (!file.startsWith(PLUGIN_PREFIX)) continue
      const name = file.slice(PLUGIN_PREFIX.length)
      if (!isPluginName(name) || found.has(name)) continue
      const path = join(dir, file)
      if (executableAt(path)) found.set(name, path)
    }
  }
  return [...found.entries()].map(([name, path]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The plug-in's own argv: everything after the plug-in name, verbatim, except `--secret <name>`
 * and `--wallet <label>` (and their `=` forms), which the CLI consumes. The names are returned so
 * the caller can resolve them; the plug-in never sees them.
 */
export function splitPluginArgs(
  args: string[],
): { secrets: string[]; wallets: string[]; passthrough: string[] } | { error: string } {
  const secrets: string[] = []
  const wallets: string[] = []
  const passthrough: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--secret" || arg === "--wallet") {
      const value = args[++i]
      if (value === undefined || value === "" || value.startsWith("-")) return { error: `${arg} requires a value` }
      ;(arg === "--secret" ? secrets : wallets).push(value)
    } else if (arg.startsWith("--secret=") || arg.startsWith("--wallet=")) {
      const flag = arg.slice(0, arg.indexOf("="))
      const value = arg.slice(flag.length + 1)
      if (value === "") return { error: `${flag} requires a value` }
      ;(flag === "--secret" ? secrets : wallets).push(value)
    } else {
      passthrough.push(arg)
    }
  }
  return { secrets, wallets, passthrough }
}

/** The environment variables a process needs to run and reach the network as this user. */
const PASSTHROUGH_NAMES: readonly string[] = ["PATH", "HOME", "TMPDIR", "TERM", "TZ", "LANG"]
const PROXY_NAMES: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]

/** `CANDLE_PLUGIN_WALLET_<LABEL>` and `CANDLE_SECRET_<NAME>`: uppercase, non-alphanumerics folded to `_`. */
export function envSuffix(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export interface PluginEnvironmentInput {
  parentEnv: Record<string, string | undefined>
  /** The active profile's RPC URL, when it has one. */
  rpcUrl?: string
  network: string
  /** Label to address, for the external wallets named on the invocation only. */
  wallets: Record<string, string>
  /** Name to value, for the secrets named on the invocation only. */
  secrets: Record<string, string>
}

/**
 * The allowlist. Built from an empty object, so a variable reaches the child only by being named
 * here; `CANDLE_*` from the parent is never consulted at all, which is what makes "drop every
 * inherited `CANDLE_*`, then set ours" the whole rule (the plug-in variables are deliberately
 * named `CANDLE_PLUGIN_*` and `CANDLE_SECRET_*`).
 */
export function pluginEnvironment(input: PluginEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PASSTHROUGH_NAMES) {
    const value = input.parentEnv[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value
  }
  for (const name of PROXY_NAMES) {
    const value = input.parentEnv[name]
    if (value !== undefined) env[name] = value
  }
  if (input.rpcUrl !== undefined) env.CANDLE_PLUGIN_RPC_URL = input.rpcUrl
  env.CANDLE_PLUGIN_NETWORK = input.network
  for (const [label, address] of Object.entries(input.wallets)) {
    env[`CANDLE_PLUGIN_WALLET_${envSuffix(label)}`] = address
  }
  for (const [name, value] of Object.entries(input.secrets)) {
    env[`CANDLE_SECRET_${envSuffix(name)}`] = value
  }
  return env
}

/**
 * The real runner: the plug-in on this terminal (stdio inherited, so its prompts and output are the
 * operator's), with EXACTLY `env`. Resolves with its exit code; a signal or a spawn failure is 1.
 */
export function realRunPlugin(path: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, args, { stdio: "inherit", env })
    } catch {
      resolve(1)
      return
    }
    child.on("error", () => resolve(1))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/** A plug-in invocation: the executable's name and everything after it on the command line. */
interface PluginInvocation {
  name: string
  args: string[]
}

/**
 * Whether `argv` invokes a plug-in (R6): the first command word, read past the global flags exactly
 * as `index.ts`'s `extractGlobalFlags` reads them, is not a built-in command and a `candle-<word>` executable is
 * on PATH. Everything AFTER that word on the original command line belongs to the plug-in, global
 * flags included, which is why this looks at `argv` and not at the stripped token list.
 */
export function pluginInvocation(
  argv: string[],
  env: Record<string, string | undefined>,
  isBuiltIn: (word: string) => boolean,
): PluginInvocation | undefined {
  const valued = new Set(["--api-url", "--profile", "--factor", "--device"])
  const bare = new Set(["--json", "--help", "-h", "--version", "-v", "--no-verify-account"])
  let droppedBin = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (valued.has(arg)) {
      i++
      continue
    }
    if (bare.has(arg) || [...valued].some((flag) => arg.startsWith(`${flag}=`))) continue
    if (arg === "candle" && !droppedBin) {
      droppedBin = true
      continue
    }
    if (isBuiltIn(arg) || !isPluginName(arg)) return undefined
    if (findPlugin(arg, env.PATH) === undefined) return undefined
    return { name: arg, args: argv.slice(i + 1) }
  }
  return undefined
}
