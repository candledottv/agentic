/**
 * The Candle MCP server as a CALLABLE, so it can be started by something other than this
 * package's own bin.
 *
 * `index.ts` used to hold these lines directly, which made importing it a side effect: the module
 * constructed a transport and connected on load. That was fine while `npx @candledottv/mcp` was
 * the only way to start the server, and it is exactly what stopped `candle mcp` from running the
 * server in-process -- so it launched a fresh registry copy per invocation instead, handing a
 * fund-moving key to whatever `latest` happened to resolve to that minute.
 *
 * Splitting the construction out changes nothing about how the published bin behaves (index.ts
 * still calls `runStdioServer()` on load, shebang and all); it just gives the CLI the same entry
 * point without the download.
 *
 * `env` is threaded rather than read from `process.env` inside so an in-process caller can hand
 * the server the exact environment it means: the CLI builds one with every inherited credential
 * stripped, and reading the ambient environment here would quietly undo that.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { registerTools } from "./tools"
import { SERVER_VERSION } from "./version"

/**
 * Orientation handed to the client at initialize, and through it to the model.
 *
 * MCP's `instructions` is the one place a server gets to explain ITSELF. Without it a model
 * receives fifteen tool names and fifteen descriptions and no answer to the questions it
 * actually has first: which of these can I call right now, what needs a credential, and what
 * order do I do things in. A user reported exactly that failure — their agent "had a hard time
 * understanding how the integration works" — and the tool descriptions were never the gap.
 * There was simply nothing telling it where to start.
 *
 * Deliberately short. This text is prepended to the model's context on every session that
 * connects the server, so it earns its length in tokens; anything that is reference rather than
 * orientation stays in AGENTS.md and is fetched only when needed.
 *
 * Kept in sync by hand with distribution/agentic/AGENTS.md ("Start here, in this order"). If
 * the no-key set changes, it changes in both places.
 */
const INSTRUCTIONS = `Candle is a trading and token-launch rail for agents. You hold a scoped API key, never a private key; signing and funding stay with the key owner's wallet.

START HERE — five tools need NO credential. Call these first to confirm the server is wired before asking anyone for anything:
  candle_get_market       price, market cap, volume, curve state for one token
  candle_get_feed         the roster: hot streak, new pairs, graduated, blue chip
  candle_resolve_token    a ticker or partial name -> mint address + chain
  candle_token_forensics  call this before quoting or buying, whenever the token has a Candle market. Returns deployer history, who bought in the deploy window (strangers in the same slot are the bundle signal), holder concentration, and a risk tier LOW/MODERATE/HIGH/CRITICAL with per-factor reasons
  candle_get_agent_profile  your own tier, caps and verified activity

COVERAGE — read this before you treat an error as a broken server.
candle_get_feed indexes the wider market (pump.fun, pons.family and other external launchpads).
candle_get_market and candle_token_forensics answer for tokens that have a CANDLE market. So a
mint that candle_get_feed just returned can still come back MARKET_NOT_FOUND from those two, and
that is a coverage boundary, not a fault and not a reason to retry, re-auth, or tell the human the
integration is down. Report it as "Candle has no market for this token, so I could not run
forensics on it" and let the human decide.

Never let a MARKET_NOT_FOUND stand in for a clean bill of health. The same rule governs the
coverage note on every forensics measurement: "unavailable" is NOT "clean" — say so rather than
reporting a token as safe.

WRITING (trade, launch, transfer, sweep, swap) needs a key. If a call returns an auth error, the fix is on the human's side: they run \`candle auth login\`, which authorizes a device in the browser and stores the credentials. Do not ask them to paste a key into a config file, and do not retry the call until they confirm.

Two chains: solana and hood. Most tools take an explicit chain — resolve it with candle_resolve_token rather than guessing.

Writes are idempotent by client token and may be asynchronous: poll candle_execution_status or candle_get_operation rather than re-issuing a call. Re-issuing is how you double-spend.

Full reference, error catalogue and end-to-end recipes: https://docs.candle.tv — and AGENTS.md in github.com/candledottv/agentic.`

/** The MCP server with the agent-rail tools registered, not yet connected to a transport. */
export function createCandleMcpServer(env: Record<string, string | undefined> = process.env): McpServer {
  const server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  registerTools(server, env)
  return server
}

/**
 * Start the server on the stdio transport and resolve only once that transport CLOSES, which is
 * when the client hangs up its end of stdin.
 *
 * Resolving at `connect()` instead is a real bug and was caught by an end-to-end smoke test rather
 * than by any unit test: `connect()` returns as soon as the transport is wired up, so an
 * in-process caller that awaited it would fall straight through to its own exit and kill the
 * server before it answered a single request. As this package's own bin that went unnoticed,
 * because a top-level await in an ES module keeps the process alive on its own; `candle mcp` has a
 * command to return to, so it does not.
 *
 * The SDK installs its own `onclose` during `connect`, so that handler is preserved and called
 * rather than replaced -- dropping it would skip the server's own cleanup.
 */
export async function runStdioServer(
  env: Record<string, string | undefined> = process.env,
  // Injectable only so a test can assert the resolve-on-close property above without owning this
  // process's real stdin. Every caller uses the default.
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  const server = createCandleMcpServer(env)
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    const sdkOnClose = transport.onclose
    transport.onclose = () => {
      sdkOnClose?.()
      resolve()
    }
  })
}
