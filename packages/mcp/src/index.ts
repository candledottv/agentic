#!/usr/bin/env node
/**
 * Candle MCP server entry point: stdio transport, the agent-rail tools.
 *
 * Kept thin on purpose -- the moment this module is imported it starts the server, which begins
 * reading stdin. The construction itself lives in `./server`, so `candle mcp` can start the same
 * server in-process without triggering that on import; unit tests import `./tools` or `./server`
 * directly and never trip it either.
 *
 * The shebang says `node`, not `bun`: `npx @candledottv/mcp` and every MCP client that spawns
 * this bin do so on a machine that has node and may not have bun. `bun run src/index.ts` still
 * works for local development because an explicit interpreter ignores the shebang.
 */
import { ApiKeyFileError } from "./api-key-file"
import { runStdioServer } from "./server"

try {
  await runStdioServer()
} catch (error) {
  if (!(error instanceof ApiKeyFileError)) throw error
  process.stderr.write(`${error.code}: ${error.message}\n`)
  process.exitCode = 1
}
