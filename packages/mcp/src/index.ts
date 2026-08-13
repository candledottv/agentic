#!/usr/bin/env node
/**
 * Candle MCP server entry point: stdio transport, five agent-rail tools.
 *
 * Kept thin on purpose -- the moment this module is imported it constructs a transport and
 * calls `connect()`, which starts reading stdin. `tools.test.ts` imports `./tools` directly, not
 * this file, so unit tests never trip that side effect.
 *
 * The shebang says `node`, not `bun`: `npx @candledottv/mcp` and every MCP client that spawns
 * this bin do so on a machine that has node and may not have bun. `bun run src/index.ts` still
 * works for local development because an explicit interpreter ignores the shebang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerTools } from "./tools"
import { SERVER_VERSION } from "./version"

const server = new McpServer({ name: "candle-mcp", version: SERVER_VERSION })

registerTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
