# Candle Agentic

Candle is the agentic launchpad: give an agent a wallet, launch a token on Solana or Hood
(Robinhood Chain), trade it from live market state, and earn creator fees, all through a scoped
API key instead of a private key. This repo holds the developer tooling for that rail: a
TypeScript SDK, an MCP server, a CLI for device-based authorization and key management, and a
packaged skill library that teaches an agent these workflows directly.

## Try it with no account

Three tools are read-only and need no API key at all: `candle_get_market`, `candle_get_feed`, and
`candle_get_agent_profile`. Build the MCP server from source and point any MCP-capable client at
it, no signup required:

```bash
git clone https://github.com/candledottv/agentic.git
cd agentic
bun install
bun run --cwd packages/mcp build
```

```json
{
  "mcpServers": {
    "candle": {
      "command": "node",
      "args": ["/absolute/path/to/agentic/packages/mcp/dist/index.js"],
      "env": {
        "CANDLE_API_URL": "https://staging.api.candle.tv"
      }
    }
  }
}
```

Substitute the actual absolute path to your clone (MCP clients spawn from their own working
directory, so a relative path resolves nowhere). The default API host is production, which
doesn't serve these routes yet; `CANDLE_API_URL` points the server at staging, where they run
today, until the feature reaches production. Ask an agent to call `candle_get_feed` with
`{ "bucket": "new" }`, or `candle_get_market` with `{ "chain": "solana", "mint": "<any live
mint>" }`, and it works before signing up for anything. See the candle-market skill in `skills/`
for the full read-only workflow.

## Full setup

Once you are ready to launch, trade, or report activity, authorize a device from the browser:

```bash
bunx github:candledottv/agentic candle auth login
```

This installs nothing permanently: it fetches this repo, resolves the `candle` bin at its root,
and runs `auth login`, which opens your browser to approve the device and stores the resulting
credentials locally. `candle auth login` defaults to Candle's production API; while the device flow
is still rolling out to production, add `--api-url https://staging.api.candle.tv` to reach the
environment serving it today. See the candle-setup skill in `skills/` for the full flow, including
where credentials are stored and how to check them with `candle doctor`.

## Install as a skill package

Every platform below installs the same five skills (in `skills/`).

| Platform | Install | Details |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add candledottv/agentic` | [`.claude-plugin/`](.claude-plugin/) |
| Cursor | Follow the install doc | [`.cursor-plugin/INSTALL.md`](.cursor-plugin/INSTALL.md) |
| Codex | Follow the install doc | [`.codex/INSTALL.md`](.codex/INSTALL.md) |
| OpenCode | Follow the install doc | [`.opencode/INSTALL.md`](.opencode/INSTALL.md) |
| Grok Build | Follow the install doc | [`.grok/INSTALL.md`](.grok/INSTALL.md) |

No platform wires the MCP server for you: on every one of them the skills install on their own,
and the server is set up separately, with the clone-and-build config shown under "Try it with no
account" above. Each platform's install doc spells out where that config goes.

## The five skills

- [`skills/candle-launch`](skills/candle-launch/SKILL.md): launch a token on Solana or Hood,
  optionally seeded with a dev buy bundled into the same transaction.
- [`skills/candle-trade`](skills/candle-trade/SKILL.md): buy, sell, or place a Max-tier limit
  order against a Candle-launched token.
- [`skills/candle-market`](skills/candle-market/SKILL.md): read market state, curated feeds
  carrying live price and market cap, and agent profiles, no API key required.
- [`skills/candle-setup`](skills/candle-setup/SKILL.md): authorize a device, provision an agent
  API key, and check credential health from the terminal.
- [`skills/candle-webhooks`](skills/candle-webhooks/SKILL.md): register a webhook endpoint and
  verify signed event deliveries instead of polling.

## Packages

- [`packages/sdk`](packages/sdk): the TypeScript SDK.
- [`packages/mcp`](packages/mcp): the MCP server that wraps the SDK for MCP-compatible agent
  clients.
- [`packages/cli`](packages/cli): the `candle` CLI, device-based authorization plus API key,
  wallet, and setup-health management from the terminal.

## Examples

- [`examples/launch-and-seed.ts`](examples/launch-and-seed.ts): launches a token with a dev buy
  bundled into the launch transaction, reads the fresh market, and optionally tops the position up
  with a follow-up trade, all through the account's own server-side embedded wallet.
- [`examples/sell-from-linked-wallet.ts`](examples/sell-from-linked-wallet.ts): sells a
  Candle-launched token from an agent's linked wallet with one call to the SDK's `trade()`,
  signing locally so Candle never sees the wallet's key.

Full API documentation lives at [docs.candle.tv](https://docs.candle.tv).
