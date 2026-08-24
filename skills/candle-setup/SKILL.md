---
name: candle-setup
description: "[SETUP] Authorize a device from the browser and provision Candle credentials (a device token plus an agent API key) for the terminal. Use when the user asks to install, log in, authenticate, configure credentials, or connect their Candle account."
---

## What this does

Runs Candle's device-authorization flow: a CLI request turns into a browser approval, and the
approval turns into two local credentials, a device token that manages API keys and an agent API
key carrying the scopes you actually saw and approved. Every other skill that writes (candle-launch,
candle-trade, candle-webhooks) depends on the key this produces.

## Setup

This is the setup skill; there is no prerequisite. The candle-market skill's three read tools
never need any of this: they work with no key at all.

## The workflow

1. Run `npx @candledottv/cli auth login` (or, with no npm,
   `bunx github:candledottv/agentic candle auth login`). The CLI defaults to the alpha API
   (`https://api.alpha.candle.tv`), where the device flow runs today; pass `--api-url` only to
   target a different deployment. Omitting `--scopes` requests all five grants (`launch:write`,
   `launch:read`, `activity:write`, `swap:write`, `transfer:write`); pass your own `--scopes`
   list to mint a narrower key instead. This prints a short code, opens (or prints) a browser
   approval URL, and polls until approved.
2. In the browser, confirm the client name and scopes match what you expect, rendered in plain
   language rather than raw scope strings. `swap:write` is never granted silently: the screen calls
   it out prominently as the grant that moves funds from the account's own wallet, before you can
   approve anything. Click Approve.
3. The CLI's poll then returns two credentials: a device token (`cndl_dvc_...`, scoped only to key
   management) and an agent API key (`cndl_live_...` or `cndl_test_...`) carrying the scopes you
   just approved.
4. Both credentials are stored automatically and never printed again after this run: macOS Keychain
   or Linux Secret Service when available, otherwise an AES-256-GCM encrypted file
   (`~/.config/candle/credentials.enc`), never plaintext. On a headless box with no keyring
   available, set `CANDLE_KEYRING_PASSPHRASE` so the CLI can use the encrypted-file backend without
   a TTY.
5. Run `candle doctor` any time to check runtime, backend reachability, credential validity, and
   wallet delegation as a PASS/FAIL/SKIP table.
6. `candle wallets` shows the account's embedded and linked wallets. `candle keys list`,
   `candle keys create`, and `candle keys revoke` manage API keys directly from the terminal.
   `candle wallets import --chain solana` (or `evm`) links a wallet the user already owns: the
   private key is read from `--key-file` or a hidden prompt, never a command argument, encrypted
   locally, and only ciphertext leaves the machine; the signing key it generates is stored in the
   same keyring as the credentials. `candle wallets revoke <wallet-id>` unlinks one.
7. For CI or headless automation, skip the keyring entirely: set `CANDLE_API_KEY` and
   `CANDLE_DEVICE_TOKEN` in the environment and every command works with no storage backend at all.

## Safety rails

Neither credential is ever written to a config file, logged, or printed, except `candle keys create`
showing a new key's plaintext exactly once, at the moment it is issued. Keys are labeled with the
device that minted them, and revoking a device offers to revoke every key it minted in the same
atomic action, so containing a suspected compromise is one step; audit `candle keys list` afterward
to confirm. Device revocation itself happens on the account portal's Authorized devices screen
under `/dev/agent`, not from the CLI: a device token is deliberately unable to revoke its own
device, so a stolen token cannot erase its own trail.

## Example

"Set up Candle so I can trade."
1. Run `candle auth login` with no `--scopes` flag, so the resulting key already carries
   `swap:write` along with the other grants.
2. Approve in the browser, confirming `swap:write` is one of the grants named on the screen.
3. Run `candle doctor` to confirm credentials and wallet delegation are healthy.
4. Continue with the candle-launch or candle-trade skill.
