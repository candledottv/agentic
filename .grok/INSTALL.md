# Installing Candle for Grok Build

Candle ships two things Grok Build can use directly: an MCP server (twenty-nine tools: launch, seed,
trade, read markets and feeds, report activity, read an agent profile, and more) and a `skills/` directory
of `SKILL.md` files in Claude Code's own frontmatter shape (`name` plus `description`), which Grok
Build reads natively.

## Prerequisites

- Node 18 or later (for `npx`), or the Candle CLI
- Git, to clone this repository for the skills (and [Bun](https://bun.sh) only to build the server from that clone)
- The `grok` CLI, already installed and authenticated
- Optional: a Candle agent API key, for `candle_launch_token`, `candle_launch_and_seed`,
  `candle_trade`, and `candle_report_activity`. Not required for market reads. See the
  candle-setup skill (below) for how to provision one.

## 1. Get the MCP server

Nothing to build: the server is published to npm as `@candledottv/mcp`, and the config below runs it
with `npx -y @candledottv/mcp`. If you have the Candle CLI installed, `candle mcp` runs the same
server from the binary instead, with the key the CLI already stores; `candle mcp --print-config`
prints the block for your install.

To build from a clone instead (for example to run unreleased changes):

```bash
git clone https://github.com/candledottv/agentic.git
cd agentic
bun install
bun run --cwd packages/mcp build
```

That produces `packages/mcp/dist/index.js`; use `node` and its absolute path in place of `npx` below.

## 2. Register the server with grok mcp add

```bash
grok mcp add candle -- npx -y @candledottv/mcp
```

If you built from a clone, use `node` and the absolute path to `packages/mcp/dist/index.js`
instead (Grok Build spawns the server from its own working directory, so a relative path will not
resolve). `grok mcp add` defaults to user
scope (`~/.grok/config.toml`); add `--scope project` to write it to the current project's
`.grok/config.toml` instead, so the server definition ships with the repo. Confirm the server is
registered with `grok mcp list`; remove it later with `grok mcp remove candle`.

`grok mcp add` has no flag for environment variables on a stdio server, so any `env` table is
added by hand to the entry it just wrote (in `~/.grok/config.toml`, or `.grok/config.toml` if you
used `--scope project`). The table is optional for the six keyless read tools,
`candle_get_market`, `candle_get_feed`, `candle_token_forensics`, `candle_get_agent_profile`,
`candle_resolve_token` and `candle_get_plans`: the server already defaults to
`https://api.alpha.candle.tv`.

```toml
[mcp_servers.candle]
command = "npx"
args = ["-y", "@candledottv/mcp"]
env = { CANDLE_API_URL = "https://api.alpha.candle.tv" }
```

`CANDLE_API_URL` points the server at production (`https://api.alpha.candle.tv`, also the default
when it is unset). To also launch, trade, or report activity, add your agent API key to the same
table:

```toml
[mcp_servers.candle]
command = "npx"
args = ["-y", "@candledottv/mcp"]
env = { CANDLE_API_URL = "https://api.alpha.candle.tv", CANDLE_AGENT_API_KEY = "cndl_live_..." }
```

`CANDLE_API_KEY` is accepted as an alias for `CANDLE_AGENT_API_KEY` if you set either one; if both
are set, `CANDLE_AGENT_API_KEY` wins.

## 3. The skills

Every `SKILL.md` here uses only the `name` and `description` frontmatter fields, both of which
Grok Build's own `SKILL.md` format reads directly (Grok ignores frontmatter keys it does not
recognize, and neither `name` nor `description` needs converting to a Grok-specific `skill.json`).
Grok Build is also documented as fully Claude Code compatible, reading Claude Code marketplaces,
plugins, and skills automatically with no extra setup, so a `.claude-plugin/`-based install (see
the Claude Code platform's own instructions) may surface these same twenty-two skills with nothing
further to do. To point Grok Build at the clone directly instead, add its `skills/` directory to
`~/.grok/config.toml`:

```toml
[skills]
paths = ["/absolute/path/to/agentic/skills"]
```

Restart `grok` and every skill in `skills/` appears as a slash command (`/candle-launch`, and so
on) alongside the built-in ones. Either way,
every `SKILL.md` file is also plain markdown you can read and follow by hand.

## Try it with no account

With the server registered per step 2's first `env` table (`CANDLE_API_URL` only, no key), ask
Grok Build to call `candle_get_feed` with `{"bucket": "new"}` or `candle_get_market` with
`{"chain": "solana", "mint": "<any live mint>"}`. Both return live results before you sign up for
anything. See the candle-market skill for the full read-only workflow.

## Full setup

See the candle-setup skill for `candle auth login`, provisioning an agent API key, and checking
credential health with `candle doctor`.
