# Candle Agentic

Candle is the agentic launchpad: give an agent a wallet, launch a token on Solana or Hood
(Robinhood Chain), trade it from live market state, and earn creator fees, all through a scoped
API key instead of a private key. This repo holds the developer tooling for that rail: a
TypeScript SDK, an MCP server, a CLI for device-based authorization and key management, and a
packaged skill library that teaches an agent these workflows directly.

Full documentation lives at [docs.candle.tv](https://docs.candle.tv). Start with the
[Agent quickstart](https://docs.candle.tv/developers/quickstart).

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

Use the real absolute path to your clone (MCP clients spawn from their own working directory),
and keep `CANDLE_API_URL` on staging until this rail reaches production. Ask an agent to call
`candle_get_feed` with `{ "bucket": "new" }` and it works before signing up for anything. Details:
[Candle MCP server](https://docs.candle.tv/developers/mcp-server).

## Full setup

Once you are ready to launch, trade, or report activity, authorize a device from the browser:

```bash
bunx github:candledottv/agentic candle auth login --api-url https://staging.api.candle.tv
```

Nothing installs permanently: one browser approval later, this machine holds a device token and
an agent API key in your OS keychain, and `--api-url` is remembered. Check the result with
`candle doctor`. The full command surface, credential storage, and headless use are documented on
the [Candle CLI](https://docs.candle.tv/developers/cli) page.

## Install as a skill package

Every platform below installs the same five skills (in `skills/`).

| Platform | Install | Details |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add candledottv/agentic` | [`.claude-plugin/`](.claude-plugin/) |
| Cursor | Follow the install doc | [`.cursor-plugin/INSTALL.md`](.cursor-plugin/INSTALL.md) |
| Codex | Follow the install doc | [`.codex/INSTALL.md`](.codex/INSTALL.md) |
| OpenCode | Follow the install doc | [`.opencode/INSTALL.md`](.opencode/INSTALL.md) |
| Grok Build | Follow the install doc | [`.grok/INSTALL.md`](.grok/INSTALL.md) |

No platform wires the MCP server for you: the skills install on their own, and the server is set
up separately with the clone-and-build config above. Each platform's install doc spells out where
that config goes; the skills-vs-server split is explained under
[Skills for coding agents](https://docs.candle.tv/developers/coding-agents).

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
  Docs: [TypeScript SDK](https://docs.candle.tv/developers/sdk).
- [`packages/mcp`](packages/mcp): the MCP server that wraps the SDK for MCP-compatible agent
  clients. Docs: [Candle MCP server](https://docs.candle.tv/developers/mcp-server).
- [`packages/cli`](packages/cli): the `candle` CLI, device-based authorization plus API key,
  wallet, and setup-health management from the terminal, including `candle wallets import`,
  the safe path for linking a wallet you already own (key via file or hidden prompt, sealed
  locally, signer stored in your OS keychain).
  Docs: [Candle CLI](https://docs.candle.tv/developers/cli).

## Examples

- [`examples/launch-and-seed.ts`](examples/launch-and-seed.ts): launches a token with a dev buy
  bundled into the launch transaction, reads the fresh market, and optionally tops the position up
  with a follow-up trade, all through the account's own server-side embedded wallet.
- [`examples/sell-from-linked-wallet.ts`](examples/sell-from-linked-wallet.ts): sells a
  Candle-launched token from an agent's linked wallet with one call to the SDK's `trade()`,
  signing locally so Candle never sees the wallet's key.

## Documentation

- [Agent quickstart](https://docs.candle.tv/developers/quickstart): keyless reads to first launch.
- [Agent access & API keys](https://docs.candle.tv/developers/agent-access): scopes, tiers,
  device authorization, revocation.
- [Agent trading API](https://docs.candle.tv/developers/agent-trading): the build-and-confirm
  trade flow behind `candle_trade`.
- [Webhooks](https://docs.candle.tv/developers/webhooks): signed events instead of polling.
