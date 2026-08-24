# Installing Candle for OpenCode

Candle ships two things OpenCode can use directly: an MCP server (seven tools: launch, seed,
trade, read markets and feeds, report activity, read an agent profile) and a `skills/` directory
of `SKILL.md` files, which OpenCode's own skill tool loads natively from a set of recognized
locations, no MCP call involved.

## Prerequisites

- Git and [Bun](https://bun.sh)
- Optional: a Candle agent API key, for `candle_launch_token`, `candle_launch_and_seed`,
  `candle_trade`, and `candle_report_activity`. Not required for market reads. See the
  candle-setup skill (below) for how to provision one.

## 1. Build the MCP server

`@candledottv/mcp` is not published to npm yet (publish is gated on Candle reaching production),
so the working install today is a clone and a local build, not a package install:

```bash
git clone https://github.com/candledottv/agentic.git
cd agentic
bun install
bun run --cwd packages/mcp build
```

This produces `packages/mcp/dist/index.js`. Once npm publish lands, this whole step is replaced by
a plain `npx -y @candledottv/mcp` reference in the config below, no clone required.

## 2. Register the server in opencode.json

Add an `mcp` block to your project's `opencode.json` (project root) or the global
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "candle": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agentic/packages/mcp/dist/index.js"],
      "environment": {
        "CANDLE_API_URL": "https://api.alpha.candle.tv"
      },
      "enabled": true
    }
  }
}
```

Substitute the actual absolute path to your clone from step 1 (OpenCode spawns the server from its
own working directory, so a relative path will not resolve). The server already defaults to the
alpha API host (`https://api.alpha.candle.tv`), where these routes run today; the explicit
`CANDLE_API_URL` below just pins that, and is where you point elsewhere (e.g. production, once
the feature reaches it). This works as written for the four read-only tools,
`candle_get_market`, `candle_get_feed`, and `candle_get_agent_profile`, no key needed.

To launch, trade, or report activity, add your agent API key alongside it in `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "candle": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agentic/packages/mcp/dist/index.js"],
      "environment": {
        "CANDLE_API_URL": "https://api.alpha.candle.tv",
        "CANDLE_AGENT_API_KEY": "cndl_live_..."
      },
      "enabled": true
    }
  }
}
```

`CANDLE_API_KEY` is accepted as an alias for `CANDLE_AGENT_API_KEY` if you set either one; if both
are set, `CANDLE_AGENT_API_KEY` wins.

## 3. The skills

OpenCode's `skill` tool loads any `SKILL.md` it finds under a fixed set of locations, including
`~/.claude/skills/<name>/SKILL.md` and `~/.agents/skills/<name>/SKILL.md`, both cross-tool
locations shared with Claude Code and other agent CLIs, exactly the layout `skills/` here already
uses. Symlink each of the five skill directories from your clone into one of them, for example:

```bash
mkdir -p ~/.agents/skills
for skill in candle-launch candle-trade candle-market candle-setup candle-webhooks; do
  ln -s /absolute/path/to/agentic/skills/$skill ~/.agents/skills/$skill
done
```

Restart OpenCode and candle-launch, candle-trade, candle-market, candle-setup, and
candle-webhooks appear in the `skill` tool's listing alongside any other skills you have
installed. Every `SKILL.md` file is also plain markdown you can read and follow by hand if you
would rather not symlink anything.

## Try it with no account

With the server registered per step 2's first block (`CANDLE_API_URL` only, no key), ask OpenCode
to call `candle_get_feed` with `{"bucket": "new"}` or `candle_get_market` with `{"chain": "solana",
"mint": "<any live mint>"}`. Both return live results before you sign up for anything. See the
candle-market skill for the full read-only workflow.

## Full setup

See the candle-setup skill for `candle auth login`, provisioning an agent API key, and checking
credential health with `candle doctor`.
