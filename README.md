# Candle Agentic

Candle is the agentic terminal: give an agent a wallet, launch a token on Solana or Hood
(Robinhood Chain), trade it from live market state, and earn creator fees, all through a scoped
API key instead of a private key. This repo holds the developer tooling for that rail: a
TypeScript SDK, an MCP server, a CLI for device-based authorization and key management, and a
packaged skill library that teaches an agent these workflows directly.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.candle.tv-black.svg)](https://docs.candle.tv)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://docs.candle.tv/developers/mcp-server)

Full documentation lives at [docs.candle.tv](https://docs.candle.tv). Start with the
[Agent quickstart](https://docs.candle.tv/developers/quickstart).

**Building an agent against this?** Load [AGENTS.md](AGENTS.md) into its context. It is the same
material written for a machine rather than a reader, with the retry rules and the tool surface in
one place.

## Contents

- [Try it with no account](#try-it-with-no-account)
- [The tool surface](#the-tool-surface)
- [The CLI](#the-cli)
- [Full setup](#full-setup)
- [Install as a skill package](#install-as-a-skill-package)
- [The skills](#the-skills)
- [Packages](#packages)
- [Examples](#examples)
- [For agents: machine-readable references](#for-agents-machine-readable-references)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing and license](#contributing-and-license)

## Try it with no account

Five tools are read-only and need no API key at all: `candle_get_market`, `candle_get_feed`,
`candle_token_forensics`, `candle_get_agent_profile`, and `candle_resolve_token`. Point any
MCP-capable client at the published server, no signup required:

```json
{
  "mcpServers": {
    "candle": {
      "command": "npx",
      "args": ["--yes", "@candledottv/mcp"],
      "env": {
        "CANDLE_API_URL": "https://api.alpha.candle.tv"
      }
    }
  }
}
```

If you have the [Candle CLI](#the-cli) installed, `candle mcp` is the shorter path: the server is
built into the binary, so there is nothing to download at launch and no Node runtime needed on the
host. `candle mcp --print-config` prints the client block filled in for your install, and the key
comes from the CLI's own store rather than sitting in a config file.

(Building from a clone still works -- `bun run --cwd packages/mcp build`, then point the client at
`packages/mcp/dist/index.js` with `node`.)

This repository also ships that configuration as [`.mcp.json`](.mcp.json) at the root, so a client
that reads a project-scoped MCP file (Claude Code, and others that follow the same convention)
picks the server up from a clone with no JSON to write by hand.

**One thing to know before the first call.** `candle_get_feed` indexes the wider market, not just
Candle's own launches. `candle_get_market` answers for every same-chain indexed token, including
external and non-routable rows. `candle_token_forensics` also answers for Solana tokens the feed
already knows (partial report: on-chain developer, went-to-zero record, token safety flags,
same-funder insiders and cluster). Deploy-window stays unavailable without a Candle launch record.
Indexed external Hood tokens also answer, with unknown hacc flags. Unknown mints can still come
back `MARKET_NOT_FOUND`. That is a coverage boundary rather than a fault -- it is not a reason to
retry, and from forensics it is not a clean bill of health either. It is the single most common
reason an agent decides the integration is broken when it is working.

Use the real absolute path to your clone (MCP clients spawn from their own working directory).
Ask an agent to call
`candle_get_feed` with `{ "bucket": "new" }` and it works before signing up for anything. Details:
[Candle MCP server](https://docs.candle.tv/developers/mcp-server).

## The tool surface

Nineteen tools. Five need no key, so a client can be pointed at the server and used before anyone
signs up.

| | Tool | Key | What it does |
| --- | --- | --- | --- |
| **Can I trade?** | `candle_execution_status` | yes | wallets, tier and this key's spend limits, in one call |
| | `candle_get_wallets` | yes | the embedded wallets this key spends from |
| | `candle_get_profile_wallets` | yes | which linked wallets this profile may spend from, and whether it is scoped |
| | `candle_set_profile_wallets` | yes | replace the linked wallets this profile may spend from |
| | `candle_get_profile_pnl` | yes | this profile's realized P&L, fees, and what it still holds at cost |
| | `candle_get_profile_trades` | yes | this profile's orders, fills, fees and transaction hashes |
| **Find a token** | `candle_resolve_token` | no | an address in, the token and its chain out |
| | `candle_get_market` | no | live state for one token |
| | `candle_get_feed` | no | curated feeds with price and market cap |
| | `candle_token_forensics` | no | launch forensics for one token |
| | `candle_get_agent_profile` | no | public profile and verified activity for an agent |
| **Move money** | `candle_trade` | yes | buy or sell a token |
| | `candle_swap` | yes | convert base assets; a pair spanning both chains is a bridge |
| | `candle_transfer` | yes | move an asset to an own or owner-approved address |
| | `candle_sweep` | yes | sweep a wallet's base assets to one destination |
| | `candle_launch_token` | yes | launch a token on Solana or Hood |
| | `candle_launch_and_seed` | yes | launch and seed with a dev buy in one transaction |
| | `candle_report_activity` | yes | report agent activity for verification |
| **What happened?** | `candle_get_operation` | yes | look up a trade or launch by the id its write used |

### A whole job

"Buy 0.2 SOL of `9dXSV8...CNDL`" is four calls, and none of them needs Candle-specific knowledge
up front:

1. `candle_execution_status {}` -- can this key trade, and from which wallets.
2. `candle_resolve_token { "mint": "9dXSV8...CNDL" }` -- the chain comes from the address's own
   shape, so you never have to ask which chain it is on.
3. `candle_trade { "mint": "9dXSV8...CNDL", "side": "buy", "amount": "0.2" }` -- `amount` is
   **decimal**. Never convert to lamports or wei yourself. Keep the `clientTradeId` from the result.
4. Only if step 3 times out: `candle_get_operation { "kind": "trade", "clientId": "<that id>" }`.
   A 404 means Candle never saw the id, so nothing moved and the request is safe to send again.

Selling a fraction is the same shape with `{ "side": "sell", "percent": 50 }`.

## The CLI

`candle` (current version 0.11.8) is the terminal half of all of this: it authorizes a device,
holds your API key in the OS keychain, runs the MCP server with no config file, keeps your own keys
in a local encrypted vault, and hands an agent a TEE wallet it can trade.

```
Install (macOS 13 or later, or Linux):

    curl -fsSL https://candle.tv/install.sh | bash

or with Homebrew:

    brew install candledottv/tap/candle

Then: candle setup
```

On macOS 12 or earlier the release binaries will not run; `npm i -g @candledottv/cli` works there
on Node 18 or later.

If you want keys of your own on the machine rather than only an API key, the vault is five
commands:

```
candle vault init                                  # prints 8 words: your passphrase, shown once
candle vault phrase show                           # prints 24 words: your recovery phrase, on paper
candle vault new-key --chain solana --label main   # derives your first key
candle vault backup --to /Volumes/<drive>/candle-vault.enc
candle vault status --unlock
```

The two word lists are different things, and it is the one idea worth getting right on day one:
**the eight words open the file on this machine, and the 24 words are the keys themselves.** The
phrase rebuilds your keys anywhere, with or without that file, which is why it belongs on paper
rather than on the disk it protects.

### Two custody tiers

The CLI keeps keys at two custody tiers (not the account plans Free, Believer, Pro and Max):

- **Tier 1: the vault.** Self-custody on your machine. It opens with a passphrase or a FIDO2
  security key (`candle vault factor add security-key`; two keys make a recoverable pair). Touch ID
  and passkey factors are built and arrive once Apple approves the signed helper. No API, relay or
  server ever sees a vault key.
- **Tier 2: TEE wallets.** Agent access. `candle vault promote` turns a vault key into a Solana
  wallet whose key is also held in Privy's TEE and bound to one API key, so an agent can trade it
  without the vault being unlocked. `--in-place <label> --sweep-to <cold label>` keeps the key's own
  address and funds, `--from <cold label>` derives a fresh one, `candle vault promote-batch` does
  many under one unlock, and `--to-key` binds the result to another of your keys. Each TEE wallet
  has one pinned vault key its funds go home to.

Funds leave a TEE wallet three ways: `candle transfer` through a Read:Write:Transfer key (to the
pinned vault or to wallets you linked while signed in or marked trusted with `candle wallets
trust`), `candle vault transfer` signed locally by the vault, or `candle tee sweep` /
`candle vault demote` back to the pinned vault. For a misbehaving agent or a leaked key, follow
[In an emergency](https://docs.candle.tv/developers/cli-custody#in-an-emergency).
`candle tee rebind` moves wallets between your keys without moving funds.

API keys come in three access levels, minted with `candle keys create --access
read|read-write|read-write-transfer`; see
[Access levels](https://docs.candle.tv/developers/agent-access#access-levels).

[**CLI custody**](https://docs.candle.tv/developers/cli-custody) is the full guide to the vault,
factors, promoting, the pinned vault, moving funds and emergencies.
[**Candle CLI**](https://docs.candle.tv/developers/cli) is the full command reference, and
[CLI quick start and FAQ](https://docs.candle.tv/developers/cli-quickstart) answers what the
passphrase and the 24 words are, whether anything syncs to iCloud, what a recovery phrase does and
does not restore, and the errors people hit on a first run.

## Full setup

Once you are ready to launch, trade, or report activity, install the Candle CLI and authorize a
device from the browser:

```
Install the Candle CLI (macOS 13 or later, or Linux):

    curl -fsSL https://candle.tv/install.sh | bash

or with Homebrew:

    brew install candledottv/tap/candle

Then: candle setup
```

(or, with no npm and no install.sh: `bunx github:candledottv/agentic candle auth login`). The npm
package `@candledottv/cli` stays published for CI, programmatic use, and Windows until
`install.ps1` ships; `npx -y @candledottv/cli@latest <command>` runs it once without installing.
It is also the way in on macOS 12 or earlier, which the release binaries are not built for.
The CLI already defaults to the alpha API (`https://api.alpha.candle.tv`); pass `--api-url` only
to point at a different deployment, and it is remembered. Nothing installs permanently beyond the
binary itself: one browser approval later, this machine holds a device token and an agent API key
in your OS keychain. Check the result with `candle doctor` -- and
from here the MCP server needs no env block at all:

```json
{
  "mcpServers": {
    "candle": {
      "command": "/Users/<you>/.local/bin/candle",
      "args": ["mcp"]
    }
  }
}
```

The absolute path, because GUI hosts launch servers with the app's environment and never see your
PATH. `candle mcp` runs the server built into the binary, with the key and API URL this device
just stored, so the credential never sits in a config file and the host needs nothing else
installed.
`--read-only` pins it to the five keyless read tools; `--tools` takes an explicit allowlist;
`--print-config` prints the block above filled in for this install. The full command surface,
credential storage, and headless use are documented on the
[Candle CLI](https://docs.candle.tv/developers/cli) page.

## Install as a skill package

Every platform below installs the same nine skills (in `skills/`).

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

## The skills

Five cover the surface: what you can call, and how to call it.

- [`skills/candle-launch`](skills/candle-launch/SKILL.md): launch a token on Solana or Hood,
  optionally seeded with a dev buy bundled into the same transaction.
- [`skills/candle-trade`](skills/candle-trade/SKILL.md): buy, sell, or place a Max-tier limit
  order against a Candle-launched token.
- [`skills/candle-market`](skills/candle-market/SKILL.md): read market state, curated feeds
  carrying live price and market cap, and agent profiles, no API key required.
- [`skills/candle-setup`](skills/candle-setup/SKILL.md): authorize a device, set up the vault and
  a TEE wallet, provision an agent API key at the right access level, and check setup health from
  the terminal.
- [`skills/candle-webhooks`](skills/candle-webhooks/SKILL.md): register a webhook endpoint and
  verify signed event deliveries instead of polling.

Four more cover what the surface will not tell you: when to refuse a trade, how automated trading
on it actually goes wrong, and how to decide whether a strategy is worth running at all. All four
are written from production failures rather than from the API shape, which is why they read
differently.

- [`skills/candle-risk-gate`](skills/candle-risk-gate/SKILL.md): the three refusals a real buy
  meets. Gate the token on forensics AND on its coverage, because a check that could not run is
  not a check that passed. Decide the exit before the entry and attach it to the entry, since the
  gap between a fill and a hand-placed stop is where a position is naked. Judge a trader on
  whether you can capture their edge, not on whether they made money: a wallet that is out in nine
  seconds is profitable and uncopyable at once.

- [`skills/candle-trade-execution`](skills/candle-trade-execution/SKILL.md): position accounting,
  sells that fail forever, retry loops on a live wallet, and reading an error's structure instead
  of its prose. Every rule in it cost real money before it was a rule. The headline one: a quote
  is not a fill, and booking `expectedOutRaw` as a quantity drifts your ledger from the wallet by
  the buy's realised slippage.
- [`skills/candle-trading-discipline`](skills/candle-trading-discipline/SKILL.md): how much to bet,
  when to stop, and the arithmetic that decides whether a strategy can be profitable at all. Work
  out what a round trip costs before trading, because on a Free tier through a thin pool you can be
  down 8% the instant you are in and out, having been right about the direction. Also says what to
  do when told to trade until it profits, which is the instruction in the history of every blown
  account.
- [`skills/onchain-strategy-research`](skills/onchain-strategy-research/SKILL.md): turning an
  observation into an experiment that can be rejected. Decision-time information only, fills that
  are actually executable, and net portfolio outcomes rather than win rates. A valid result is to
  reject every candidate and keep the capital.

## Packages

- [`packages/sdk`](packages/sdk): the TypeScript SDK.
  Docs: [TypeScript SDK](https://docs.candle.tv/developers/sdk).
- [`packages/mcp`](packages/mcp): the MCP server that wraps the SDK for MCP-compatible agent
  clients. Docs: [Candle MCP server](https://docs.candle.tv/developers/mcp-server).
- [`packages/cli`](packages/cli): the `candle` CLI, device-based authorization plus API key,
  vault, TEE wallet, linked wallet and setup-health management from the terminal, including
  `candle wallets import`, the safe path for linking a wallet you already own (key via file or
  hidden prompt, sealed locally, signer stored in your OS keychain).
  Docs: [Candle CLI](https://docs.candle.tv/developers/cli).

## Examples

- [`examples/launch-and-seed.ts`](examples/launch-and-seed.ts): launches a token with a dev buy
  bundled into the launch transaction, reads the fresh market, and optionally tops the position up
  with a follow-up trade, all through the account's own server-side embedded wallet.
- [`examples/sell-from-linked-wallet.ts`](examples/sell-from-linked-wallet.ts): sells a
  Candle-launched token from an agent's linked wallet with one call to the SDK's `trade()`,
  signing locally so Candle never sees the wallet's key.

## For agents: machine-readable references

Three artifacts exist so an agent does not have to scrape prose:

| Artifact | What it answers |
| --- | --- |
| [`agents/error-catalog.json`](agents/error-catalog.json) | every error code the rail returns, grouped, each carrying `retryable` and an action |
| [`openapi.json`](https://api.alpha.candle.tv/api/v1/openapi.json) | the exact request and response shape of every endpoint, gated against drift in CI |
| [`llms.txt`](https://docs.candle.tv/llms.txt) | the whole documentation set as one context-sized file, freshness-gated |

The error catalog is the one worth reading before writing retry logic. Retrying a
`VALIDATION_FAILED` forever is the most common way an agent burns its rate limit and reaches
nothing.

## Troubleshooting

**The MCP client shows no Candle tools.** With `npx @candledottv/mcp` or `candle mcp` there is
nothing to build, so check the command resolves at all: MCP clients spawn from their own working
directory and with their own environment, which is why `candle mcp --print-config` prints an
absolute path. If you are pointing at a clone instead, the server has to be built first
(`bun run --cwd packages/mcp build`) and the path in your config must be absolute.

**Everything returns `UNAUTHORIZED`.** Run `candle doctor`. It resolves credentials in the same
order the CLI does, so it separates "no key" from "key for the other environment" from "revoked",
which the error alone cannot.

**Writes fail but reads work.** Reads need no key at all, so this is almost always a missing scope
or an undelegated wallet. Scopes are fixed when a key is issued and cannot be added later; check
the code against `agents/error-catalog.json` and issue a new key if the scope is absent.

**Calls hit the wrong environment.** `CANDLE_API_URL` decides which one you are on, and production is
`https://api.alpha.candle.tv` (the CLI's default) and staging is `https://staging.api.candle.tv`. A key issued for one environment does not work
against the other.

## Documentation

- [Agent quickstart](https://docs.candle.tv/developers/quickstart): keyless reads to first launch.
- [Agent access & API keys](https://docs.candle.tv/developers/agent-access): scopes, tiers,
  device authorization, revocation.
- [Agent trading API](https://docs.candle.tv/developers/agent-trading): the build-and-confirm
  trade flow behind `candle_trade`.
- [Webhooks](https://docs.candle.tv/developers/webhooks): signed events instead of polling.

## Contributing and license

This repository is a read-only mirror generated from Candle's monorepo, so a pull request opened
here cannot be merged. Issues are read and welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
where each kind of change actually goes.

MIT, see [LICENSE](LICENSE).
