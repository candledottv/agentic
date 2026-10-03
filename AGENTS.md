# AGENTS.md

Instructions for an AI agent operating this repository's tooling. Humans want the
[README](README.md); this file is the one to load into context.

## What this rail does

Candle lets an agent hold a **scoped API key instead of a private key**, and with it: read live
market state, launch a token on Solana or Hood, trade it, swap base assets, and report activity.
Signing and funding stay with the key owner's own wallet. Candle never holds it.

## Start here, in this order

1. **Read without credentials.** `candle_get_market`, `candle_get_feed`,
   `candle_get_agent_profile`, `candle_token_forensics`, `candle_resolve_token` and
   `candle_get_plans` need no API key. Use them to confirm the server is wired before asking anyone for a credential.
2. **Get a key** only when you need to write. Install the Candle CLI
   (`curl -fsSL https://candle.tv/install.sh | bash`, or `brew install candledottv/tap/candle`),
   then `candle setup` (or `candle auth login` alone) authorizes a device from the browser and
   stores a device token plus an agent key in the OS keychain. That key is Read:Write; a key that
   must also move funds out of its TEE wallet is Read:Write:Transfer, minted by the owner with
   `candle keys create --access read-write-transfer` (see
   https://docs.candle.tv/developers/agent-access#access-levels). The
   vault, TEE wallets and moving funds are covered in https://docs.candle.tv/developers/cli-custody. From then on `candle mcp` runs this MCP server with those stored
   credentials -- no env block. The npm package `@candledottv/cli` stays published for CI,
   programmatic use, and Windows until `install.ps1` ships; `npx -y @candledottv/cli@latest
   <command>` runs it once without installing.
3. **Check the setup** with `candle doctor` before concluding anything is broken.

## The tool surface

Twenty-nine tools. Six need no key at all, so a client can be pointed at the server and used before
anyone signs up for anything.

**Find out what you can do**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_execution_status` | yes | can this key trade right now: wallets, tier, and this key's own spend limits, in one call |
| `candle_get_wallets` | yes | the embedded wallets this key spends from, one per chain |
| `candle_get_profile_wallets` | yes | which linked wallets this profile may spend from. Read `walletScope` first: an empty list means every wallet under `all`, none under `selected` |
| `candle_set_profile_wallets` | yes | replace that set. Omitting a wallet revokes its access; an empty list assigns none |
| `candle_get_profile_pnl` | yes | this profile's P&L: realized on its own fills, fees charged, and open positions at cost basis MARKED at Candle's current price (`unrealizedUsd`; `pnl.totalUsd` is realized net plus unrealized), with `chain` on each position and a per-chain split in `pnl.byChain`. Deposits and transfers are excluded; check `unvalued` and `truncated` before quoting it |
| `candle_get_profile_trades` | yes | orders, actual fills, fees, timestamps and tx hashes. Includes failed trades, with `errorCode` saying why |
| `candle_get_portfolio` | yes | what the account's embedded and TEE wallets hold on Solana and Hood, with prices. Needs `account:read`. Hood is in `hood`; a Hood price is keyed `hood:native` or `hood:<contract lowercased>`; unpriced is `null`, never zero |

**Find a token**

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_resolve_token` | no | a bare contract address in, the token and its chain out. Start here when a human hands you an address |
| `candle_get_market` | no | live state for one token |
| `candle_get_feed` | no | curated feeds carrying price and market cap |
| `candle_token_forensics` | no | launch forensics for one token |
| `candle_get_agent_profile` | no | public profile and verified activity for an agent |
| `candle_get_plans` | no | every plan's price, agent fee, perps builder fee, limits and capabilities, as the server charges them |

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

**Perps on Hyperliquid** (needs `perps:write` on the key and `CANDLE_KEY_SIGNER_PEM_FILE`; each write is checked before it is signed and submitted to Hyperliquid by the server)

| Tool | Key | What it does |
| --- | --- | --- |
| `candle_perps_setup` | yes | approve Candle's builder fee once, and see the account's mode and balance |
| `candle_perps_open` | yes | open or add to a position; `price` makes it a limit order |
| `candle_perps_close` | yes | close all or part of a position, reduce-only |
| `candle_perps_cancel` | yes | cancel an order Candle built, by cloid |
| `candle_perps_leverage` | yes | set a market's leverage and margin mode |
| `candle_perps_deposit` | yes | deposit onto the Hyperliquid account through Relay from the Solana or Hood TEE wallet (needs `swap:write`) |
| `candle_perps_orders` | yes | open orders and every action Candle built |
| `candle_perps_positions` | yes | positions and account value, read live |

## Which CLI command do I need?

Match the task, not the noun: "make this key use these wallets" is a rebind, not `keys wallets set`.

| I want to | Run |
| --- | --- |
| Give a key TEE wallets, or move them to another key | `candle tee rebind <wallets...> --to-key <key>` (or `--label-prefix <p>` for many) |
| Let a key use a linked wallet you imported | The agent console's Agents tab, signed in (`keys wallets set` from a key can only narrow) |
| Turn a vault key into a TEE wallet | `candle vault promote --in-place <label> --sweep-to <cold key>`, or `--from <cold key>` for a fresh one |
| Send funds out of a TEE wallet as the agent | `candle transfer --to vault --asset <A> --amount <n\|max> --wallet <tee>` (or `--to` a linked or trusted wallet) with a Read:Write:Transfer key |
| Send funds anywhere yourself | `candle vault transfer <address> --amount <n\|max> --asset <A> --from <label>` |
| Mark wallets as yours so agents can send to them | `candle wallets trust <selectors...>` |
| Change a key's access level (after a `SCOPE_MISSING`) | `candle keys access <prefix> --access read\|read-write\|read-write-transfer` (owner, device token; widening is confirmed at a terminal) |
| Stop an agent | `candle tee disable <address>`, then `candle keys revoke <prefix>` |
| Bring everything home | `candle tee disable <address>`, then `candle tee sweep <address>` or `candle vault demote <address>` (see Safety rails in candle-setup for `--emergency`) |

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

**The feed is wider than Candle's markets, and this is the first thing you will hit.**
`candle_get_feed` indexes the whole market -- pump.fun, pons.family and other launchpads, which is
why rows carry a `launchpad`. `candle_get_market` answers for every same-chain indexed token, including external and
non-routable rows. Read the candleLaunched flag, `launchpad`, `venue` and `trade.routable`. General
quotes use `POST /api/v1/trade/agent/quote`; curve-only quotes describe Candle launches. `candle_token_forensics` also answers for Solana tokens the feed already knows, with a
partial report (on-chain developer, went-to-zero record, token safety flags, same-funder insiders and
cluster). Deploy-window stays unavailable without a Candle launch record. Indexed external Hood tokens also answer, with unknown hacc flags. Unknown mints can still
come back `MARKET_NOT_FOUND`.

Forensics refusals are a coverage boundary. Other surfaces still use the legacy
`MARKET_NOT_FOUND`: read `error.routing.reason`, discovery and explicit `retryable`, which
overrides catalog defaults. A curve-only 404 directs callers to the general quote endpoint;
it is not proof a token cannot trade. `hood_market_unavailable` stays non-retryable per address.

It is also **not a clean bill of health.** `MARKET_NOT_FOUND` from forensics means the check could
not run, so report that you could not check the token rather than reporting the token as safe.
The same rule governs the coverage note on every individual forensics measurement: `unavailable`
is not `clean`.

**A key cannot widen its own scopes.** The owner can widen it in place with `candle keys access
<prefix> --access ...` (device token); otherwise ask for the scope when the key is created. A scope
such as `swap:write` is deliberately never granted by omission.

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

**A swap timeout is unknown, not failed.** Pass a `clientSwapId` and retry the same request,
including the same slippage. The replay returns the stored result: the original success, or a
stored error. An indeterminate first leg comes back as `SWAP_FAILED`, retryable false, with the
signature in the message -- verify that on-chain before a new id. A swap that is still running,
with no stored outcome, is a retryable conflict. A different body under the same id is rejected.
Omitting the id never coalesces -- do not retry a timed-out call that had none. If the first leg
already confirmed, the replay keeps that hash, is retryable false, and does not run the first
leg again. `retryable: true` on the first `LEG2_FAILED` means send leg 2 as a new request. A
bridge still takes time, and a confirmed source transaction is not proof the destination was
credited.

**Stay on the configured environment.** `CANDLE_API_URL` decides which environment you are
touching. Production is `https://api.alpha.candle.tv` (the CLI's default) and staging is
`https://staging.api.candle.tv`; a key issued for one environment does not work against the other.

## Errors

Every failure carries a stable machine code. Branch on the code, never on the message text, which
is written for humans and will change.

```json
{ "error": { "code": "SLIPPAGE_EXCEEDED", "message": "..." } }
```

## The CLI's `--json` contract

Under `--json`, the CLI's stdout carries exactly one JSON value per invocation -- the result on
success, or this failure envelope -- and stderr is diagnostics only. Exit codes: `0` success,
`1` failure, `2` usage error, `3` not yet verified (for example a TEE wallet stop still pending):
treat `3` as not done and follow the printed next step.

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
| `CANDLE_AGENT_API_KEY` | the MCP server's key variable (the CLI reads `CANDLE_API_KEY`) |
| `CANDLE_DEVICE_TOKEN` | device token from `candle auth login` |
| `CANDLE_CONFIG_DIR` | override the config location |
| `CANDLE_KEYRING_PASSPHRASE` | unlock the keyring in headless environments |
| `CANDLE_MCP_TOOLS` | comma-separated tool allowlist for the MCP server (`candle mcp --tools` sets it) |
| `CANDLE_SOLANA_RPC_URL` | Solana RPC for every Solana command when `--rpc-url` is not given (then the profile's, then the public endpoint); `vault restore`'s gap scan needs `--rpc-url` |
| `CANDLE_KEY_SIGNER_PEM_FILE` | the key's signer PEM, which the MCP perps tools sign with |

## When you are stuck

Run `candle doctor` and report its output verbatim. It resolves credentials in the same order the
CLI does, so it distinguishes "no key" from "wrong environment" from "key revoked", which the
error alone often cannot.
