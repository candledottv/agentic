# AGENTS.md

Instructions for an AI agent operating this repository's tooling. Humans want the
[README](README.md); this file is the one to load into context.

## What this rail does

Candle lets an agent hold a **scoped API key instead of a private key**, and with it: read live
market state, launch a token on Solana or Hood, trade it, swap base assets, and report activity.
Signing and funding stay with the key owner's own wallet. Candle never holds it.

## Start here, in this order

1. **Read without credentials.** `candle_get_market`, `candle_get_feed`,
   `candle_get_agent_profile`, `candle_token_forensics` and `candle_resolve_token` need no API
   key. Use them to confirm the server is wired before asking anyone for a credential.
2. **Get a key** only when you need to write. Install the Candle CLI
   (`curl -fsSL https://candle.tv/install.sh | bash`, or `brew install candledottv/tap/candle`),
   then `candle auth login` authorizes a device from the browser and stores a device token plus an
   agent key in the OS keychain. From then on `candle mcp` runs this MCP server with those stored
   credentials -- no env block. The npm package `@candledottv/cli` stays published for CI,
   programmatic use, and Windows until `install.ps1` ships; `npx -y @candledottv/cli@latest
   <command>` runs it once without installing.
3. **Check the setup** with `candle doctor` before concluding anything is broken.

## The tool surface

Fifteen tools. Five need no key at all, so a client can be pointed at the server and used before
anyone signs up for anything.

**Find out what you can do**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_execution_status` | yes | can this key trade right now: wallets, tier, and this key's own spend limits, in one call |
| `candle_get_wallets` | yes | the embedded wallets this key spends from, one per chain |

**Find a token**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_resolve_token` | no | a bare contract address in, the token and its chain out. Start here when a human hands you an address |
| `candle_get_market` | no | live state for one token |
| `candle_get_feed` | no | curated feeds carrying price and market cap |
| `candle_token_forensics` | no | launch forensics for one token |
| `candle_get_agent_profile` | no | public profile and verified activity for an agent |

**Move money**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_trade` | yes | buy or sell a token |
| `candle_swap` | yes | convert between base assets; a pair spanning both chains is a bridge |
| `candle_transfer` | yes | move an asset to an own wallet or an owner-approved withdrawal address |
| `candle_sweep` | yes | sweep a wallet's base assets to one destination |
| `candle_launch_token` | yes | launch a token on Solana or Hood |
| `candle_launch_and_seed` | yes | launch and seed with a dev buy in one transaction |
| `candle_report_activity` | yes | report agent activity for verification |

**Find out what happened**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_get_operation` | yes | look up a trade or launch by the id its write used. Call this after a timeout instead of writing again |

## Doing a job end to end

A human says: **"buy 0.2 SOL of 9dXSV8...CNDL"**. That is four calls, and none of them requires
you to know anything Candle-specific in advance.

1. `candle_execution_status {}` -- confirms the key can trade and shows the wallets. If it says a
   read was unreadable, fix that before writing; do not infer readiness from a failed trade.
2. `candle_resolve_token { mint: "9dXSV8...CNDL" }` -- the chain comes from the address's own
   shape, so you do not have to ask which chain it is on.
3. `candle_trade { mint: "9dXSV8...CNDL", side: "buy", amount: "0.2" }` -- `amount` is decimal and
   denominated in the token's OWN quote asset. Keep the `clientTradeId` from the result.
4. Only if step 3 times out or you lose the answer:
   `candle_get_operation { kind: "trade", clientId: "<that id>" }`.

Selling a fraction is the same shape: `{ side: "sell", percent: 50 }`.

## Machine-readable references

Prefer these over scraping prose:

- **`agents/error-catalog.json`** in this repo: every error code the rail returns, grouped by
  category, each carrying `retryable` and an action. Read it before writing retry logic.
- **OpenAPI**: `https://api.alpha.candle.tv/api/v1/openapi.json`. Gated against drift in CI, so
  it describes what actually ships.
- **`https://docs.candle.tv/llms.txt`**: the whole documentation set as one file, sized for a
  context window and freshness-gated.

## Rules that will save you a failed call

**Scopes are fixed at issuance.** A key cannot gain a scope later. If you need `swap:write`, ask
for it when the key is created; it is deliberately never granted by omission.

**Reads are free, writes are not.** Every write is signed and paid for by the key owner's wallet.
Never describe a launch or trade to a user as costless.

**Amounts are DECIMAL, not raw base units.** `candle_trade` takes `amount: "0.2"`, and
`candle_swap` takes the same (its `amountRaw` still works for callers that already compute raw
units). Do not convert to lamports or wei yourself; the tools do it, and doing it twice is how a
trade gets sized by a factor of a billion. A buy's amount is denominated in the token's own quote
asset, a sell's in the token. Still read the market before sizing a trade: knowing the units does
not tell you the price.

**Retry only what is retryable.** `RATE_LIMITED` and `BUILD_TIMEOUT` deserve a backoff.
`VALIDATION_FAILED` and `SCOPE_MISSING` will fail identically forever; surface them instead.

**Honour idempotency, and prefer asking over retrying.** Launch and trade calls take a
client-supplied id; reuse the same id when retrying the same intent, or you risk launching twice.
After a timeout the better move is `candle_get_operation`, which tells you whether the write landed
before you decide. A 404 there means Candle never saw the id, so nothing moved and the original
request is safe to send again unchanged.

**A cross-chain swap is not a retryable call.** `clientSwapId` only coalesces a duplicate that
arrives while the first is still in flight; once it settles, the same id swaps AGAIN. A bridge also
takes time, and a confirmed source transaction is not proof the destination was credited.

**Stay on the configured environment.** `CANDLE_API_URL` decides which environment you are
touching. The agent rail runs on staging until the production flip, and a key issued for one
environment does not work against the other.

## Errors

Every failure carries a stable machine code. Branch on the code, never on the message text, which
is written for humans and will change.

```json
{ "error": { "code": "SLIPPAGE_EXCEEDED", "message": "..." } }
```

## The CLI's `--json` contract

Under `--json`, the CLI's stdout carries exactly one JSON value per invocation -- the result on
success, or this failure envelope -- and stderr is diagnostics only. Exit codes: `0` success,
`1` failure, `2` usage error.

```json
{ "ok": false, "code": "TIER_REQUIRED", "status": 403, "message": "...", "suggestion": "Stake CNDL to reach Pro.", "docsUrl": "https://docs.candle.tv/developers/agent-access" }
```

`code` is always present: the API's own code, an RFC 6749 device-flow error, `NETWORK_UNREACHABLE`
(the server was never reached), `USAGE` (the arguments were wrong; nothing ran), or a local
precondition like `NO_DEVICE_TOKEN`. When `suggestion` is present it is the fix, as a command or a
setting -- run it before asking a human.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CANDLE_API_URL` | which environment to talk to |
| `CANDLE_API_KEY` | agent API key, when not using the keychain |
| `CANDLE_AGENT_API_KEY` | accepted alias for the same key |
| `CANDLE_DEVICE_TOKEN` | device token from `candle auth login` |
| `CANDLE_CONFIG_DIR` | override the config location |
| `CANDLE_KEYRING_PASSPHRASE` | unlock the keyring in headless environments |
| `CANDLE_MCP_TOOLS` | comma-separated tool allowlist for the MCP server (`candle mcp --tools` sets it) |

## When you are stuck

Run `candle doctor` and report its output verbatim. It resolves credentials in the same order the
CLI does, so it distinguishes "no key" from "wrong environment" from "key revoked", which the
error alone often cannot.
