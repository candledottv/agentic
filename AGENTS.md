# AGENTS.md

Instructions for an AI agent operating this repository's tooling. Humans want the
[README](README.md); this file is the one to load into context.

## What this rail does

Candle lets an agent hold a **scoped API key instead of a private key**, and with it: read live
market state, launch a token on Solana or Hood, trade it, swap base assets, and report activity.
Signing and funding stay with the key owner's own wallet. Candle never holds it.

## Start here, in this order

1. **Read without credentials.** `candle_get_market`, `candle_get_feed` and
   `candle_get_agent_profile` need no API key. Use them to confirm the server is wired before
   asking anyone for a credential.
2. **Get a key** only when you need to write. `candle auth login` authorizes a device from the
   browser and stores a device token plus an agent key in the OS keychain.
3. **Check the setup** with `candle doctor` before concluding anything is broken.

## The tool surface

| Tool | Key required | What it does |
| --- | --- | --- |
| `candle_get_market` | no | live state for one token |
| `candle_get_feed` | no | curated feeds carrying price and market cap |
| `candle_get_agent_profile` | no | public profile and verified activity for an agent |
| `candle_launch_token` | yes | launch a token on Solana or Hood |
| `candle_launch_and_seed` | yes | launch and seed with a dev buy in one transaction |
| `candle_trade` | yes | buy or sell a Candle-launched token |
| `candle_swap` | yes | one-shot base-asset swap |
| `candle_report_activity` | yes | report agent activity for verification |

## Machine-readable references

Prefer these over scraping prose:

- **`agents/error-catalog.json`** in this repo: every error code the rail returns, grouped by
  category, each carrying `retryable` and an action. Read it before writing retry logic.
- **OpenAPI**: `https://staging.api.candle.tv/api/v1/openapi.json`. Gated against drift in CI, so
  it describes what actually ships.
- **`https://docs.candle.tv/llms.txt`**: the whole documentation set as one file, sized for a
  context window and freshness-gated.

## Rules that will save you a failed call

**Scopes are fixed at issuance.** A key cannot gain a scope later. If you need `swap:write`, ask
for it when the key is created; it is deliberately never granted by omission.

**Reads are free, writes are not.** Every write is signed and paid for by the key owner's wallet.
Never describe a launch or trade to a user as costless.

**Never invent an amount.** Read the market first, then size the trade. Amounts are raw base
units, not decimals.

**Retry only what is retryable.** `RATE_LIMITED` and `BUILD_TIMEOUT` deserve a backoff.
`VALIDATION_FAILED` and `SCOPE_MISSING` will fail identically forever; surface them instead.

**Honour idempotency.** Launch and trade calls take a client-supplied id. Reuse the same id when
retrying the same intent, or you risk launching twice.

**Stay on the configured environment.** `CANDLE_API_URL` decides which environment you are
touching. The agent rail runs on staging until the production flip, and a key issued for one
environment does not work against the other.

## Errors

Every failure carries a stable machine code. Branch on the code, never on the message text, which
is written for humans and will change.

```json
{ "error": { "code": "SLIPPAGE_EXCEEDED", "message": "..." } }
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CANDLE_API_URL` | which environment to talk to |
| `CANDLE_API_KEY` | agent API key, when not using the keychain |
| `CANDLE_AGENT_API_KEY` | accepted alias for the same key |
| `CANDLE_DEVICE_TOKEN` | device token from `candle auth login` |
| `CANDLE_CONFIG_DIR` | override the config location |
| `CANDLE_KEYRING_PASSPHRASE` | unlock the keyring in headless environments |

## When you are stuck

Run `candle doctor` and report its output verbatim. It resolves credentials in the same order the
CLI does, so it distinguishes "no key" from "wrong environment" from "key revoked", which the
error alone often cannot.
