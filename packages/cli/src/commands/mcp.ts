/**
 * `candle mcp`: launch the Candle MCP server with the credentials this CLI already manages
 * (CLI P0 plan, Task 2). The server itself lives in `@candledottv/mcp` and reads
 * `CANDLE_AGENT_API_KEY` / `CANDLE_API_URL` from its environment; before this command, wiring
 * it up meant hand-editing those into every MCP client's config. Now the client config is what
 * `candle mcp --print-config` prints, which names this binary by its ABSOLUTE path:
 *
 *   { "mcpServers": { "candle": { "command": "/Users/you/.local/bin/candle", "args": ["mcp"] } } }
 *
 * A bare "candle" is not enough: GUI hosts (Cursor, Claude Desktop) launch servers with the app's
 * own environment, which never sourced a shell rc, so nothing the installer put on PATH is
 * visible there. See `mcpCommandForHost` below for the three install shapes. The key comes from
 * the CLI's secret store at launch time either way, so it never sits in a config file at all.
 *
 * The server is BUNDLED into this binary and started in-process. It used to be launched as
 * `npx --yes @candledottv/mcp`, which resolved it fresh from the registry on every invocation with
 * no version or integrity pin and handed it a fund-moving API key: whatever `latest` happened to
 * be at that moment received the key, and a stable CLI install could change behaviour between runs
 * without an upgrade. Bundling makes the server the exact code tested, signed and released
 * alongside this CLI, and removes the network from startup entirely -- which also means an MCP
 * host no longer needs Node on its PATH.
 *
 * The two constraints that once argued for npx are both handled rather than merely accepted: the
 * CLI's tsconfig no longer pins rootDir (nothing is emitted from it, so it only limited what could
 * be typechecked), and the per-package export to the public agentic repo preserves the same
 * `packages/{cli,mcp}` layout, so the relative import resolves identically in both repos. The
 * package stays zero-RUNTIME-dependency: the server and its deps are inlined at build time, which
 * is what `bun build` already did for every other import here.
 *
 * stdio still belongs to the protocol; it is now this process's own stdin/stdout rather than a
 * child's.
 */

import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { resolveApiKey } from "../deps"
import { credentialEnvOverrides, effectiveProfileFields, identityLine } from "../profiles"
import { detectInstall } from "../release"
import { writeLocalFailure, writeUsageFailure } from "../render"

/** Mirrors `TOOL_NAMES` in packages/mcp/src/tools.ts -- duplicated here since the CLI has zero
 * runtime dependencies and no cross-package import (same convention as ALL_AGENT_SCOPES).
 * `wallets-import.drift.test.ts` shows the pattern for keeping such mirrors honest; mcp.test.ts
 * pins this list against the same names the README documents. */
export const MCP_TOOL_NAMES = [
  "candle_launch_token",
  "candle_launch_and_seed",
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile",
  "candle_report_activity",
  "candle_trade",
  "candle_swap",
  "candle_transfer",
  "candle_sweep",
  "candle_get_wallets",
  "candle_resolve_token",
  "candle_execution_status",
] as const

/**
 * The five tools that authenticate with no API key at all -- what `--read-only` pins the server
 * to. Mirrors the keyless tools in packages/mcp/src/tools.ts's buildRequest.
 *
 * KEYLESS, not merely non-writing: candle_get_wallets and candle_execution_status also move
 * nothing, but they read the account and need a key, so pinning the server to them would hand
 * back a `--read-only` server that fails on every call without one.
 */
export const READ_ONLY_TOOL_NAMES = [
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile",
  "candle_resolve_token",
] as const

/**
 * Every environment variable that carries a Candle credential, plus the tool allowlist, cleared
 * from the MCP child's environment before the launch re-adds what it actually resolved.
 *
 * `CANDLE_API_KEY` and `CANDLE_DEVICE_TOKEN` are the CLI's own env overrides (see `deps.ts`),
 * `CANDLE_AGENT_API_KEY` is what the server itself reads, and `CANDLE_KEYRING_PASSPHRASE` unlocks
 * the encrypted signer store. Deliberately NOT listed: `CANDLE_API_URL`, `CANDLE_PROFILE`,
 * `CANDLE_CONFIG_DIR` and the release/install variables, which carry no secret and which the child
 * (or a wrapper around it) may legitimately need.
 */
export const CREDENTIAL_ENV_NAMES = [
  "CANDLE_API_KEY",
  "CANDLE_AGENT_API_KEY",
  "CANDLE_DEVICE_TOKEN",
  "CANDLE_KEYRING_PASSPHRASE",
  "CANDLE_MCP_TOOLS",
] as const

/** Those names mapped to `undefined`, for spreading over an inherited environment. */
export function clearedCredentialEnv(): Record<string, undefined> {
  return Object.fromEntries(CREDENTIAL_ENV_NAMES.map((name) => [name, undefined]))
}

/**
 * Whether a `candle mcp` invocation would act as the profile's account. `--read-only` launches
 * the server with no key at all (see the launch below), pinned to the four tools that
 * authenticate with nothing, so there is no account for the dispatch-level guard to verify and no
 * way for such a server to act as one. Everything else does act, `--print-config` included: the
 * block it prints is for a server that WILL be launched with the stored key.
 *
 * A membership check, not a second parser: `--read-only` is a boolean flag in this command's own
 * `parseArgs` spec, so it never consumes the token after it and can never be another flag's
 * value. The guard stays at dispatch; this only tells it what the invocation means.
 */
export function mcpActsAsIdentity(args: string[]): boolean {
  return !args.includes("--read-only")
}

/**
 * The command a GUI MCP host should run. Cursor, Claude Desktop and their kind launch servers
 * with the app's own environment, which never sourced a shell rc, so a bare "candle" fails there
 * no matter what the installer put on PATH. A compiled binary names its own absolute path (for a
 * Homebrew install the opt link, which survives brew upgrade; the Cellar path does not). A script
 * install names the runtime and the script, which needs no PATH at all.
 */
export async function mcpCommandForHost(deps: Deps): Promise<{ command: string; prefixArgs: string[] }> {
  const real = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  const method = detectInstall(deps.execPath, real)
  if (method === "script") return { command: deps.execPath, prefixArgs: [deps.argv1] }
  if (method === "homebrew") {
    const opt = real.replace(/\/Cellar\/candle\/[^/]+\/bin\/candle$/, "/opt/candle/bin/candle")
    return { command: opt, prefixArgs: [] }
  }
  return { command: real, prefixArgs: [] }
}

/** What `--print-config` emits: a ready-to-paste MCP client block with an absolute command. */
export async function mcpClientConfig(args: string[], deps: Deps): Promise<string> {
  const { command, prefixArgs } = await mcpCommandForHost(deps)
  return JSON.stringify({ mcpServers: { candle: { command, args: [...prefixArgs, "mcp", ...args] } } }, null, 2)
}

export async function mcp(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--tools"],
    booleanFlags: ["--read-only", "--print-config"],
  })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const readOnly = parsed.booleans.has("--read-only")
  const toolsFlag = parsed.values["--tools"]
  if (readOnly && toolsFlag !== undefined) {
    writeUsageFailure(deps, "--read-only and --tools are mutually exclusive; --read-only IS a tool selection.", json)
    return 2
  }

  let toolAllowlist: string | undefined
  if (readOnly) {
    toolAllowlist = READ_ONLY_TOOL_NAMES.join(",")
  } else if (toolsFlag !== undefined) {
    const requested = toolsFlag
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    const unknown = requested.filter((name) => !(MCP_TOOL_NAMES as readonly string[]).includes(name))
    if (requested.length === 0 || unknown.length > 0) {
      writeUsageFailure(
        deps,
        `--tools must be a comma-separated list of: ${MCP_TOOL_NAMES.join(", ")}${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}`,
        json,
      )
      return 2
    }
    toolAllowlist = requested.join(",")
  }

  // stderr, not stdout, and unconditionally on --json: stdout belongs to the server (or, under
  // --print-config, to the printed JSON client block) either way, so this is the only place the
  // identity line can go without corrupting a machine-readable stream. Unlike printIdentity, it
  // is never skipped for --json -- there is no other output here that carries the same fields.
  const identityConfig = await deps.readConfig()
  const identityFields = effectiveProfileFields(identityConfig, ctx.profile)
  deps.stderr.write(
    `${identityLine(ctx.profile, identityFields.account, apiUrl, credentialEnvOverrides(deps.env), identityFields.username)}\n`,
  )

  if (parsed.booleans.has("--print-config")) {
    // Reconstruct the launch args minus --print-config itself, so what is printed is exactly
    // what the client should run.
    const launchArgs = [
      ...(readOnly ? ["--read-only"] : []),
      ...(toolsFlag !== undefined ? ["--tools", toolsFlag] : []),
    ]
    deps.stdout.write(`${await mcpClientConfig(launchArgs, deps)}\n`)
    return 0
  }

  // --read-only launches with no key at all: the four read tools authenticate with nothing,
  // and a server that HAS no key cannot be talked into moving funds. Otherwise the key is
  // required -- an MCP server that starts keyless and fails on first real tool call is a worse
  // failure mode than not starting.
  const apiKey = readOnly ? undefined : await resolveApiKey(deps, ctx.profile)
  if (!readOnly && !apiKey) {
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle auth login" },
      json,
    )
    return 1
  }

  const serverEnv: Record<string, string | undefined> = {
    ...deps.env,
    // Clear every inherited Candle credential BEFORE re-adding the one this launch resolved. The
    // spread above is what carries PATH, HOME and the rest, and it used to carry these along with
    // it: under --read-only that handed a server advertised as keyless a fund-moving key and the
    // encrypted-store passphrase anyway, and on a normal launch it let a stale ambient key outrank
    // the profile whose identity line was just printed. Clearing first makes the key set below the
    // only one the server can see. CANDLE_MCP_TOOLS is cleared for the same reason: an inherited
    // allowlist must not widen what --read-only or --tools pinned.
    //
    // Still built as an explicit environment even though the server now runs IN THIS PROCESS: it
    // is passed to the server rather than applied to process.env, so the reduction is a value the
    // server reads, not a mutation of this process that other code could observe or undo.
    ...clearedCredentialEnv(),
    CANDLE_API_URL: apiUrl,
    ...(apiKey ? { CANDLE_AGENT_API_KEY: apiKey } : {}),
    ...(toolAllowlist ? { CANDLE_MCP_TOOLS: toolAllowlist } : {}),
  }
  // stderr, not stdout: under MCP the protocol owns stdout, and that is now THIS process's stdout.
  deps.stderr.write(
    `Starting the Candle MCP server against ${apiUrl}${toolAllowlist ? ` (tools: ${toolAllowlist})` : ""}\n`,
  )
  // Resolves when the transport is connected; the transport then holds stdin open, which is what
  // keeps the process alive. Exit code 0 because there is nothing left to fail: a server that
  // failed to start threw instead, and is reported below.
  try {
    await deps.runMcpServer(serverEnv)
    return 0
  } catch (error) {
    writeLocalFailure(
      deps,
      {
        code: "MCP_SERVER_FAILED",
        message: `The MCP server could not start: ${error instanceof Error ? error.message : error}`,
      },
      json,
    )
    return 1
  }
}
