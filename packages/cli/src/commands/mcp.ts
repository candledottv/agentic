/**
 * `candle mcp`: launch the Candle MCP server with the credentials this CLI already manages
 * (CLI P0 plan, Task 2). The server itself lives in `@candledottv/mcp` and reads
 * `CANDLE_AGENT_API_KEY` / `CANDLE_API_URL` from its environment; before this command, wiring
 * it up meant hand-editing those into every MCP client's config. Now the client config is just
 *
 *   { "command": "candle", "args": ["mcp"] }
 *
 * and the key comes from the CLI's secret store at launch time, so it never sits in a config
 * file at all.
 *
 * Launches `npx --yes @candledottv/mcp` rather than importing the server across packages: the
 * CLI is a standalone zero-dependency package (its tsconfig pins rootDir to src, and its export
 * to the public agentic repo is per-package), so the published server is the one artifact both
 * install paths agree on. stdio is inherited -- the MCP client owns this process's stdin/stdout
 * exactly as it would the server's own.
 */

import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { credentialEnvOverrides, effectiveProfileFields, identityLine } from "../profiles"
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
] as const

/** The four tools that authenticate with no API key at all -- what `--read-only` pins the
 * server to. Mirrors the keyless tools in packages/mcp/src/tools.ts's buildRequest. */
export const READ_ONLY_TOOL_NAMES = [
  "candle_get_market",
  "candle_get_feed",
  "candle_token_forensics",
  "candle_get_agent_profile",
] as const

/** What `--print-config` emits: a ready-to-paste MCP client block. */
export function mcpClientConfig(args: string[]): string {
  return JSON.stringify({ mcpServers: { candle: { command: "candle", args: ["mcp", ...args] } } }, null, 2)
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
  const identityAccount = effectiveProfileFields(identityConfig, ctx.profile).account
  deps.stderr.write(`${identityLine(ctx.profile, identityAccount, apiUrl, credentialEnvOverrides(deps.env))}\n`)

  if (parsed.booleans.has("--print-config")) {
    // Reconstruct the launch args minus --print-config itself, so what is printed is exactly
    // what the client should run.
    const launchArgs = [
      ...(readOnly ? ["--read-only"] : []),
      ...(toolsFlag !== undefined ? ["--tools", toolsFlag] : []),
    ]
    deps.stdout.write(`${mcpClientConfig(launchArgs)}\n`)
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

  const childEnv: Record<string, string | undefined> = {
    ...deps.env,
    CANDLE_API_URL: apiUrl,
    ...(apiKey ? { CANDLE_AGENT_API_KEY: apiKey } : {}),
    ...(toolAllowlist ? { CANDLE_MCP_TOOLS: toolAllowlist } : {}),
  }
  // stderr, not stdout: under MCP the child owns stdout for the protocol stream.
  deps.stderr.write(`Starting @candledottv/mcp against ${apiUrl}${toolAllowlist ? ` (tools: ${toolAllowlist})` : ""}\n`)
  return deps.runChild("npx", ["--yes", "@candledottv/mcp"], childEnv)
}
