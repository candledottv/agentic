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

/** The MCP server with the agent-rail tools registered, not yet connected to a transport. */
export function createCandleMcpServer(env: Record<string, string | undefined> = process.env): McpServer {
  const server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION })
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
