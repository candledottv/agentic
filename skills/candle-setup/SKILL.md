---
name: candle-setup
description: "[SETUP] Install the Candle CLI, authorize a device from the browser, set up the self-custody vault and a TEE wallet for an agent, and provision an agent API key at the right access level. Use when the user asks to install, log in, authenticate, configure credentials, set up a wallet for an agent, or connect their Candle account."
---

## What this does

Runs Candle's device-authorization flow: a CLI request turns into a browser approval, and the
approval turns into two local credentials, a device token that manages API keys and an agent API
key carrying the scopes you actually saw and approved. Every other skill that writes (candle-launch,
candle-trade, candle-webhooks) depends on the key this produces. For an agent that trades from the
terminal, it also sets up the two custody tiers: the vault (Tier 1, self-custody on this machine)
and a TEE wallet (Tier 2, agent access) promoted out of it. Custody tiers are not the account plans
(Free, Pro, Max).

## Setup

This is the setup skill; there is no prerequisite. The candle-market skill's read tools never need
any of this: they work with no key at all.

## The workflow

1. Install the Candle CLI (macOS 13 or later, or Linux):
   `curl -fsSL https://candle.tv/install.sh | bash`, or with Homebrew:
   `brew install candledottv/tap/candle`. On macOS 12 or earlier use the npm package, which runs on
   Node: `npm i -g @candledottv/cli`. With no npm and no install.sh:
   `bunx github:candledottv/agentic candle auth login`.
2. Run `candle setup`. It is the onboarding wizard and safe to re-run: it authorizes this device
   when it is not already authorized, prints the agent wallets as funding destinations, shows the
   skill and MCP install lines, and finishes with the full `candle doctor` check. `candle auth login`
   does only the authorization step. The CLI defaults to the alpha API
   (`https://api.alpha.candle.tv`); pass `--api-url` only to target a different deployment.
   Omitting `--scopes` mints a Read:Write key: `launch:write`, `launch:read`, `account:read`,
   `activity:write`, `swap:write` and `transfer:write`. Pass your own `--scopes` list to mint a
   narrower key instead. A device login cannot request `transfer:bound` (see step 7).
3. In the browser, confirm the client name and scopes match what you expect, rendered in plain
   language rather than raw scope strings. `swap:write` is never granted silently: the screen calls
   it out prominently as the grant that moves funds from the account's own wallet, before you can
   approve anything. Click Approve. The CLI's poll then returns a device token (`cndl_dvc_...`,
   scoped only to key management) and an agent API key (`cndl_live_...` or `cndl_test_...`).
4. Both credentials are stored automatically and never printed again after this run: macOS Keychain
   or Linux Secret Service when available, otherwise an AES-256-GCM encrypted file
   (`~/.config/candle/credentials.enc`), never plaintext. On a headless box with no keyring
   available, set `CANDLE_KEYRING_PASSPHRASE` so the CLI can use the encrypted-file backend without
   a TTY.
5. Create the vault (Tier 1) if the user wants keys of their own on this machine:
   `candle vault init` creates it with one passphrase factor (eight generated words, shown once;
   `--own-passphrase` to type your own) and a 24-word recovery phrase, and no key yet.
   `candle vault phrase show` displays the 24 words on the terminal for paper backup, and
   `candle vault new-key --chain solana --label treasury` derives a key. Add a FIDO2 security key
   with `candle vault factor add security-key` (two keys make a recoverable pair), then prove a copy
   with `candle vault backup --to <path>`. Touch ID and passkey factors are built but not released
   yet: they wait on Apple's approval of the signed helper, and the CLI refuses them until then.
   The vault is the user's to open; an agent never gets its passphrase or security key.
6. Give the agent a TEE wallet (Tier 2) by promoting a vault key. `candle vault promote --from
   <cold label>` derives a fresh wallet pinned to that cold key; `candle vault promote --in-place
   <label> --sweep-to <cold label> --rpc-url <url>` promotes an existing key at its own address;
   `candle vault promote-batch --pairs-from <file> --rpc-url <url>` does many at once. Each
   promote shows what is being handed over and asks the user for a typed confirmation. `--to-key
   <prefix|label>` binds the wallet to another of the user's keys. The pinned vault key is where
   `candle tee sweep` and `candle vault demote` send funds home. Trade the wallet from the machine
   that promoted it, because its relay signer stays there. Vault and TEE reads need `--rpc-url` or
   `CANDLE_SOLANA_RPC_URL`.
7. Mint the agent's key at the access level it needs with `candle keys create --access
   read|read-write|read-write-transfer`. Read sees the account and changes nothing; Read:Write
   trades, launches and moves funds between the account's own wallets; Read:Write:Transfer can also
   move funds out of the TEE wallet it is bound to (`candle transfer`), to its pinned vault or to
   wallets marked yours with `candle wallets trust`. An account holds at most 12 active keys.
   `candle keys list` and `candle keys revoke <prefix>` manage them, and `candle keys wallets
   <prefix>` shows which wallets a key's profile may use.
8. Run `candle doctor` any time: one PASS/FAIL/SKIP table over the runtime, the storage backend,
   both credentials, API reachability, wallet delegation, the install method and whether the
   security key helper is installed.
9. `candle wallets` shows the account's embedded and linked wallets, with Signer and Trusted
   columns. `candle wallets import --chain solana` (or `evm`) links a wallet the user already owns:
   the private key is read from `--key-file` or a hidden prompt, never a command argument, and is
   sealed before it leaves the machine. `candle wallets revoke <wallet-id>` unlinks one.
10. For CI or headless automation, skip the keyring entirely: set `CANDLE_API_KEY` and
    `CANDLE_DEVICE_TOKEN` in the environment and every command works with no storage backend at
    all.

The full custody guide is https://docs.candle.tv/developers/cli-custody, and every command and flag
is in https://docs.candle.tv/developers/cli.

## Which command do I need?

Match the task, not the noun: "make this key use these wallets" is a rebind, not `keys wallets set`.

| I want to | Run |
| --- | --- |
| Give a key TEE wallets, or move them to another key | `candle tee rebind <wallets...> --to-key <key>` (or `--label-prefix <p>` for many) |
| Let a key use a linked wallet you imported | The agent console's Agents tab, signed in (`keys wallets set` from a key can only narrow) |
| Turn a vault key into a TEE wallet | `candle vault promote --in-place <label> --sweep-to <cold key>`, or `--from <cold key>` for a fresh one |
| Send funds out of a TEE wallet as the agent | `candle transfer --to vault` (or to a trusted wallet) with a Read:Write:Transfer key |
| Send funds anywhere yourself | `candle vault transfer <address> --from <label>` |
| Mark wallets as yours so agents can send to them | `candle wallets trust <selectors...>` |
| Stop an agent | `candle tee disable <address>`, then `candle keys revoke <prefix>` |
| Bring everything home | `candle tee sweep <address>` or `candle vault demote <address>` (`--emergency` with no API) |

## Safety rails

Neither credential is ever written to a config file, logged, or printed, except `candle keys create`
showing a new key's plaintext exactly once, at the moment it is issued. Keys are labeled with the
device that minted them, and revoking a device offers to revoke every key it minted in the same
atomic action, so containing a suspected compromise is one step; audit `candle keys list` afterward
to confirm. Device revocation itself happens on the Authorized devices screen of the agents
console (`/agents`), not from the CLI: a device token is deliberately unable to revoke its own
device, so a stolen token cannot erase its own trail.

Never run a promote, a `confirm` prompt, or a vault unlock on the user's behalf: those are the
owner's decisions, typed by the owner. If an agent's key or wallet may be compromised, the path is
stop, sweep, new wallet: `candle tee disable <address>`, then `candle tee sweep <address> --rpc-url
<url>` (add `--emergency` to sweep with no API call), and revoke the key.

## Example

"Set up Candle so my agent can trade."
1. Run `candle setup` and approve in the browser, confirming `swap:write` is one of the grants
   named on the screen.
2. Have the user run `candle vault init`, write down the 24 words from `candle vault phrase show`,
   and derive a cold key with `candle vault new-key --chain solana --label treasury`.
3. Have the user run `candle vault promote --from treasury` to create the agent's TEE wallet, then
   fund it.
4. Run `candle doctor` to confirm credentials and wallet delegation are healthy.
5. Continue with the candle-launch or candle-trade skill.
