# @candledottv/mcp

An MCP (Model Context Protocol) server for the Candle agent rail. It exposes Candle's REST API as
five tools over stdio, so an MCP-capable agent can launch tokens, read market and feed data,
report on-chain activity, and check an agent profile without hand-rolling HTTP calls.

This package is a thin wrapper: every tool call maps to one REST request against
`apps/api` (`POST /api/v1/launch/headless`, `GET /api/v1/markets/:chain/:mint`,
`GET /api/v1/markets/feed`, `POST /api/v1/activity/report`, `GET /api/v1/users/:idOrWallet/agent`)
and hands the response body straight back to the caller, unchanged, error responses included.
This package never reinterprets an error body, and that body is not one uniform shape across all
five tools:

- `candle_launch_token`, `candle_get_market`, and `candle_get_feed` hit endpoints that use the
  structured envelope `{ success: false, error: { code, message, ... } }`. Branch on `error.code`.
- `candle_report_activity` relays `apps/api/src/routes/activity.ts`'s own plain error shape
  verbatim: `{ error: true, payload: string }`.
- `candle_get_agent_profile` relays `apps/api/src/routes/users.ts`'s own plain error shape
  verbatim: `{ error: string }`.

## Environment

- `CANDLE_API_URL` -- base URL of the Candle API. Defaults to `https://api.candle.tv`. Set it to
  `http://localhost:3001` when developing against a local API.
- `CANDLE_AGENT_API_KEY` -- an agent API key (`cndl_live_...` / `cndl_test_...`), issued from a
  Candle account's agent settings page. Only required by `candle_launch_token` and
  `candle_report_activity`; the three read-only tools work without it, so the server is useful
  the moment it is installed and only asks for a key when you try to write.

## Tools

| Tool | REST call | Auth |
| --- | --- | --- |
| `candle_launch_token` | `POST /api/v1/launch/headless` (or `/dry-run` when `dryRun: true`) | `CANDLE_AGENT_API_KEY` |
| `candle_get_market` | `GET /api/v1/markets/:chain/:mint` | none |
| `candle_get_feed` | `GET /api/v1/markets/feed?bucket=...` | none |
| `candle_report_activity` | `POST /api/v1/activity/report` | `CANDLE_AGENT_API_KEY` |
| `candle_get_agent_profile` | `GET /api/v1/users/:idOrWallet/agent` | none |

## MCP client config

Add this to your MCP client (Claude Desktop, Claude Code, Cursor, or anything else that speaks
stdio MCP). No checkout and no build required:

```json
{
  "mcpServers": {
    "candle": {
      "command": "npx",
      "args": ["-y", "@candledottv/mcp"],
      "env": {
        "CANDLE_AGENT_API_KEY": "cndl_live_..."
      }
    }
  }
}
```

`CANDLE_API_URL` is omitted on purpose: it already defaults to production. Drop the `env` block
entirely if you only want the read-only tools.

## Running it directly

```bash
npx -y @candledottv/mcp
```

The server speaks JSON-RPC over stdio, so running it in a terminal is only useful for smoke
testing. It is meant to be spawned by an MCP client.

## Development

From a monorepo checkout:

```bash
bun run src/index.ts   # run from source against CANDLE_API_URL
bun test               # request-building, version parity, and config-default guards
bun run typecheck      # tsc --noEmit
bun run build          # bundle to dist/index.js for publishing
```

`bun run build` targets node and leaves `@modelcontextprotocol/sdk` and `zod` as external
dependencies, so npm installs and dedupes them normally. The published `bin` is the built
`dist/index.js` with a `#!/usr/bin/env node` shebang, not the TypeScript source: MCP clients spawn
this on machines that have node and may not have bun.

`@modelcontextprotocol/sdk` is pinned to `1.22.0` rather than the newest 1.x release: starting at
`1.23.0`, the SDK's zod v3/v4 compatibility types (`server/zod-compat.ts`) trip a TypeScript
`TS2589` ("Type instantiation is excessively deep") once more than a couple of `registerTool`
calls with multi-field zod input shapes coexist in one file, which this package's five tools
always will. `1.22.0` predates that rewrite and type-checks cleanly with the exact same tool
code. Re-check this pin when bumping the SDK.
