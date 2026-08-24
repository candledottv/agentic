# @candledottv/mcp

An MCP (Model Context Protocol) server for the Candle agent rail. It exposes Candle's REST API as
eleven tools over stdio, so an MCP-capable agent can launch tokens (optionally seeded with a dev
buy in the same call), trade, convert between base assets (including across chains), read market
and feed data, report on-chain activity, and check an agent profile without hand-rolling HTTP
calls.

## Try it without a key

Three tools are read-only and need nothing but `CANDLE_API_URL` (which already defaults to
production): `candle_get_market`, `candle_get_feed`, `candle_token_forensics`, and
`candle_get_agent_profile`. Install the
server with no `env` block at all and those three work immediately:

```json
{
  "mcpServers": {
    "candle": {
      "command": "npx",
      "args": ["-y", "@candledottv/mcp"]
    }
  }
}
```

Add `CANDLE_AGENT_API_KEY` only once you're ready to launch, trade, or report activity, see
Environment below -- or skip env editing entirely: after `npx @candledottv/cli auth login`,
`candle mcp` launches this server with the stored key and API URL in its environment.

`CANDLE_MCP_TOOLS` (optional) is a comma-separated allowlist of tool names; only those register.
Unset means all eight. An unknown name fails startup with the valid names in the message, rather
than silently registering the wrong surface. `candle mcp --read-only` / `--tools` set this for
you.

Most tools are a thin wrapper: a one-request mapping onto `apps/api`
(`POST /api/v1/launch/headless`, `GET /api/v1/markets/:chain/:mint`, `GET /api/v1/markets/feed`,
`POST /api/v1/activity/report`, `GET /api/v1/users/:idOrWallet/agent`) that hands the response body
straight back to the caller, unchanged, error responses included. `candle_trade` and
`candle_launch_and_seed` are the two exceptions: each is a small orchestration (a decimal-to-raw
conversion, an idempotency key, a follow-up read) on top of the same REST surface, see Errors
below.

Both take decimal amounts, never raw base units, and resolve the scale themselves:

- A `candle_trade` **buy** is denominated in the token's OWN quote asset, whatever it was launched
  against (SOL for a SOL-launched token, USDC or CNDL for those quote pairs). The tool reads the
  market first and converts against its `quoteDecimals`; the `quoteAsset` field applies only to a
  mint Candle never launched, the arbitrary-token path a Pro or Max key trades through Jupiter. A
  **sell** is denominated in tokens and converts against the market's own `decimals`.
- A `candle_launch_and_seed` `devBuy` is denominated in the quote asset that launch selects, since
  there the caller genuinely picks the new token's quote pair: `quoteAsset` if given, otherwise
  SOL on Solana and ETH on Hood.

For a full walkthrough of `candle_launch_and_seed` and `candle_trade`, including the keyless read
tools, getting a key, funding the embedded wallet, and idempotent retries, see
`docs/mcp-launch-and-seed.md` in the `candle-monorepo` repo.

## Environment

- `CANDLE_API_URL` -- base URL of the Candle API. Defaults to `https://api.alpha.candle.tv` (the alpha deployment; production does not serve the agent API yet). Set it to
  `http://localhost:3001` when developing against a local API.
- `CANDLE_AGENT_API_KEY` -- an agent API key (`cndl_live_...` / `cndl_test_...`), issued from a
  Candle account's agent settings page. Only required by `candle_launch_token`,
  `candle_report_activity`, `candle_trade`, `candle_launch_and_seed`, and `candle_swap`; the three
  read-only tools
  work without it, so the server is useful the moment it is installed and only asks for a key when
  you try to write. `candle_trade` additionally needs the key's `swap:write` scope server-side,
  which is opt-in only and never granted by omission, see `docs/mcp-launch-and-seed.md` in the
  `candle-monorepo` repo.
- `CANDLE_API_KEY` -- alias for `CANDLE_AGENT_API_KEY`, the same variable name the Candle CLI uses
  for this credential. Set either one; if both are set, `CANDLE_AGENT_API_KEY` takes precedence.

## Tools

| Tool | Description | REST call | Auth |
| --- | --- | --- | --- |
| `candle_launch_token` | Launch a token on Candle | `POST /api/v1/launch/headless` (or `/dry-run` when `dryRun: true`) | `CANDLE_AGENT_API_KEY` |
| `candle_get_market` | Get market state | `GET /api/v1/markets/:chain/:mint` | none |
| `candle_get_feed` | Get a token feed | `GET /api/v1/markets/feed?bucket=...` | none |
| `candle_token_forensics` | Deployer history, deploy-window buyers, holder concentration, risk tier | `GET /api/v1/markets/:chain/:mint/forensics` | none |
| `candle_report_activity` | Report on-chain activity | `POST /api/v1/activity/report` | `CANDLE_AGENT_API_KEY` |
| `candle_get_agent_profile` | Get an agent profile | `GET /api/v1/users/:idOrWallet/agent` | none |
| `candle_trade` | Buy or sell a token | Reads the market for its decimals (or wallet balance, for a percent sell) then `POST /api/v1/trade/agent/build` | `CANDLE_AGENT_API_KEY` (`swap:write`) |
| `candle_launch_and_seed` | Launch a token and seed it | `POST /api/v1/launch/headless` (or `/dry-run`), then a follow-up `GET /api/v1/markets/:chain/:mint` | `CANDLE_AGENT_API_KEY` |
| `candle_swap` | Swap between base assets | `POST /api/v1/agent/swap` | `CANDLE_AGENT_API_KEY` (`swap:write`) |
| `candle_transfer` | Transfer an asset | `POST /api/v1/agent/transfer` | `CANDLE_AGENT_API_KEY` (`transfer:write`) |
| `candle_sweep` | Sweep a wallet to one destination | One `POST /api/v1/agent/transfer` per asset, `amountRaw: "max"` | `CANDLE_AGENT_API_KEY` (`transfer:write`) |

### Transfers and sweeps

`candle_transfer` moves one asset from the account's embedded wallet: to any of the account's
OWN wallets freely (any asset, `amountRaw` in RAW base units or `"max"` for the spendable
balance), or to an address the OWNER pre-approved as a withdrawal address in the Candle console
(base assets only, bounded by the account's spend caps and the key's transaction limit).
Anything else is refused before signing -- an agent key can never approve its own destination.

`candle_sweep` is the whole-wallet loop: one `"max"` transfer per asset on the chosen chain,
tokens before the native asset (the native asset pays the fees), plus any `mints` named
explicitly. Assets with nothing spendable report `empty`; a failed asset never stops the rest.

## Errors

This package never reinterprets an error body, and that body is not one uniform shape across all
eleven tools:

- `candle_launch_token`, `candle_get_market`, and `candle_get_feed` hit endpoints that use the
  structured envelope `{ success: false, error: { code, message, ... } }`. Branch on `error.code`.
- `candle_report_activity` relays `apps/api/src/routes/activity.ts`'s own plain error shape
  verbatim: `{ error: true, payload: string }`.
- `candle_get_agent_profile` relays `apps/api/src/routes/users.ts`'s own plain error shape
  verbatim: `{ error: string }`.
- `candle_trade` and `candle_launch_and_seed` wrap the underlying REST body instead of relaying it
  bare, in one of two shapes depending on how far the call got:
  - A failure caught before any REST request goes out (e.g. passing both `amount` and `percent`,
    an unrecognized `quoteAsset`, or a devBuy conversion
    error) returns
    `{ clientTradeId | clientLaunchId, success: false, error: { code: "MCP_VALIDATION", message } }`.
  - A pre-request READ that comes back non-ok (an expired key on the wallet read, a 500 on the
    market read) is relayed verbatim instead: `{ clientTradeId | clientLaunchId, success: false,
    api }`, where `api` is that read's own body. The tool never reinterprets it as "you have no
    embedded wallet" or "this token has no decimals".
  - A request that dies in transit, a rejected connection or a body that is not JSON, returns
    `{ clientTradeId | clientLaunchId, success: false, error: { code: "MCP_TRANSPORT", message,
    retryable: true } }`. It means undetermined, not failed: the call may or may not have reached
    Candle. Retry it with the SAME id and the same body, which either replays the original result
    or runs it for the first time. A new id would be a second trade or launch.
  - Once the underlying request is actually sent, the shape is
    `{ clientTradeId | clientLaunchId, resolved?, api | launch, market?, note? }`. `candle_trade`
    always returns `{ clientTradeId, resolved, api }`: `resolved` is the decimal-to-raw (or
    percent-to-raw) conversion this tool computed before calling the trade endpoint, and `api` is
    that endpoint's own response body verbatim, success or error. `candle_launch_and_seed` returns
    `{ clientLaunchId, api }` for a dry run or a failed launch, and
    `{ clientLaunchId, launch, market, note? }` for a confirmed launch: `launch` is the launch
    endpoint's own response body, `market` is a best-effort follow-up market read (`null` when
    that read failed), and `note` is present only alongside a failed follow-up read, pointing at
    `candle_get_market` to fetch it separately.
  - Either way, both tools echo their idempotency id (`clientTradeId` / `clientLaunchId`) at the
    top level, so a caller can always find it to retry safely: retrying with the SAME id is a safe
    replay, a new id is a second trade or launch. See `docs/mcp-launch-and-seed.md` in the
    `candle-monorepo` repo for the full idempotent-retry rule.

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
calls with multi-field zod input shapes coexist in one file, which this package's tools
always will. `1.22.0` predates that rewrite and type-checks cleanly with the exact same tool
code. Re-check this pin when bumping the SDK.
