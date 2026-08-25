# @candledottv/cli

The Candle CLI: authorize a device from your browser, then manage API keys, wallets, and setup
health from the terminal. Zero runtime dependencies; the whole thing is one self-contained
`dist/index.js` that runs under plain Node.

## Quick start

```
npx @candledottv/cli auth login
```

This runs `auth login`, which opens your browser to approve this device. Install it permanently
with `npm install -g @candledottv/cli` and the command is just `candle`.

### No-npm fallback

The same CLI can run straight from the public repo:

```
bunx github:candledottv/agentic candle auth login
```

That fetches the `agentic` repo, resolves the `candle` bin at its root (`packages/cli/dist/index.js`,
a committed build), and runs it. If bun's git-dependency handling fails on your machine, clone and
build directly:

```
git clone https://github.com/candledottv/agentic.git
cd agentic
bun install
bun run --cwd packages/cli build
node packages/cli/dist/index.js auth login
```

## Commands

| Command | What it does |
| --- | --- |
| `candle setup [--no-browser]` | The onboarding wizard: authorizes this device (skipped when already authorized), prints the agent wallets as funding destinations plus the paste-into-your-agent brief, shows the skill/MCP install lines, runs the full doctor check (setup's exit code is doctor's), and links the web console. Safe to re-run. |
| `candle auth login [--profile <name>] [--scopes <a,b,c>] [--label <name>] [--no-browser]` | Authorizes this device: prints a code, opens (or prints) an approval URL, polls until approved, then stores the resulting device token and API key. |
| `candle auth status` | Shows which storage backend is in use, both credential prefixes, the config file path, and a live validity check for each credential. |
| `candle auth logout [--keep-key]` | Revokes the stored API key (skipped with `--keep-key`), clears local credentials and config, and prints the portal URL for revoking the device itself. |
| `candle keys list` | Lists this account's API keys: prefix, scopes, environment, timestamps, and which device minted each one. |
| `candle keys create [--scopes <a,b,c>] [--label <name>] [--expires-in <days>] [--tx-limit <usd> [--reset daily\|weekly\|monthly\|never]]` | Creates a new API key and prints the plaintext exactly once, with the same optional name, expiration, and USD transaction limit the portal's create form takes. Stored locally only if the CLI does not already hold a working key. |
| `candle keys revoke <prefix>` | Revokes an API key by prefix. Revoking the CLI's own stored key also clears it locally. |
| `candle wallets` | Shows the account's embedded (launch) wallets and any linked wallets, using the API key. |
| `candle mcp [--tools <a,b,c>] [--read-only] [--print-config]` | Runs the Candle MCP server (`npx @candledottv/mcp`) with this CLI's stored API key and API URL in its environment, so an MCP client config is just `{"command": "candle", "args": ["mcp"]}`. `--read-only` starts it with no key and only the three keyless read tools; `--tools` pins an explicit allowlist; `--print-config` prints the ready-to-paste client block instead of launching. |
| `candle doctor` | Runs a full health check (runtime, backend, credentials, API reachability, credential validity, wallet delegation) as a PASS/FAIL/SKIP table. Exits nonzero on any FAIL. |

Every command accepts these global options:

| Flag | Effect |
| --- | --- |
| `--api-url <url>` | Overrides the API base URL for this invocation, beating `CANDLE_API_URL` and the stored config value. |
| `--profile <name>` | Act as a named profile; see Profiles below. |
| `--json` | Machine-readable output instead of a formatted table or summary, generally the underlying API response. One exception: `auth login`'s JSON output still omits the plaintext device token and API key, matching its human-readable summary, since login never displays either value in any mode. |
| `--help`, `-h` | Prints usage. |
| `--version`, `-v` | Prints the CLI version. |

## The `--json` contract

For agents and scripts, `--json` guarantees: **stdout carries exactly one JSON value** -- the
result on success, or a failure envelope -- and stderr carries diagnostics only. Exit codes:
`0` success, `1` failure (the envelope says why), `2` usage error (the arguments themselves were
wrong; nothing ran).

The failure envelope is stable:

```json
{
  "ok": false,
  "code": "TIER_REQUIRED",
  "status": 403,
  "message": "Pro tier required",
  "suggestion": "Stake CNDL to reach Pro.",
  "docsUrl": "https://docs.candle.tv/developers/agent-access"
}
```

`code` is always present (the API's error code, an RFC 6749 error for the device flow,
`NETWORK_UNREACHABLE` when the server was never reached, `USAGE` for argument errors, or a
local precondition code like `NO_DEVICE_TOKEN`). `suggestion` is the fix as a command or
setting when one is known; `docsUrl` appears when the API names a docs page for this error.
Parse stdout, switch on `code`, run the `suggestion`.

## Credential storage

Two credentials are stored: a device token (`cndl_dvc_...`, scoped to key management) and an API
key (`cndl_live_...` or `cndl_test_...`, scoped to whatever your device authorized). Neither is ever
written to the config file, logged, or printed, with one exception: `keys create` shows the
plaintext API key exactly once, at the moment it's issued. `auth login` never prints either
plaintext value, in any mode (including `--json`) -- both credentials go straight into storage,
since the whole point of the CLI managing them is that you never have to see or copy them.

The CLI picks the best available backend for your machine, in this order:

1. **macOS Keychain**, via the `security` CLI, when available.
2. **Linux Secret Service**, via `secret-tool`, when the binary is present and a real store/lookup
   round trip succeeds (a headless box can have the binary installed with no Secret Service
   actually running; the CLI checks for that rather than trusting the binary's presence alone).
3. **An encrypted file** (`~/.config/candle/credentials.enc`, AES-256-GCM, PBKDF2-derived key),
   everywhere else, Windows included. This is a first-class fallback, not an error: headless Linux
   agents are exactly where this matters most.

`candle auth status` and `candle doctor` both report which backend is active.

## Profiles

One machine can hold credentials for several accounts and hosts. `auth login` creates a profile
implicitly when none is already selected, named from `--profile <name>` or derived from the API
host (`staging`, `production`, or the hostname, de-duplicated with a numeric suffix). Which profile a command acts as, highest
wins: `--profile`, `CANDLE_PROFILE`, the `activeProfile` in `config.json`, the sole profile. With
several profiles and none selected the CLI refuses and lists them; guessing is how a wallet
import once landed on the wrong account.

Re-running `auth login` refreshes the profile you are already on, in place: the same name, the
same refs, a new device token and key. Use `--profile <new name>` to add another instead.
`auth logout` removes the acting profile's entry and its stored credentials, and clears
`activeProfile` when it pointed there. Switching which profile is active is Phase 2's
`profile use`; until then, select one per command with `--profile`, per shell with
`CANDLE_PROFILE`, or edit `activeProfile` in `config.json`.

Every authenticated command prints `Profile: <name>   Account: <account> at <api url>` before its
own output (`--json` output is unchanged except `auth status` and `auth login`, which carry
`profile` and `account`; scripts get identity from `auth status --json`). The account is cached
at login from the API. Where the line is printed from that cache and `CANDLE_API_KEY` or
`CANDLE_DEVICE_TOKEN` is overriding the stored credential, it reads
`Account: unknown (CANDLE_API_KEY override)` rather than naming an account that credential was
never checked against; `auth status` and `setup` look the account up live and print what they
get. Phase 2 adds `candle profile list|add|use|rename|remove` and a strict mismatch guard.

A pre-profile install is migrated on first run: profile `default` is created from the existing
settings and the two credentials are copied to `profile:default:*` refs. The old refs and fields
are left in place so an older CLI keeps working, until an `auth logout` clears them along with
the profile they were migrated into.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CANDLE_DEVICE_TOKEN` | Overrides the stored device token for this process. Every command that needs the device token checks this first, before the store. |
| `CANDLE_API_KEY` | Overrides the stored API key for this process, same precedence as above. |
| `CANDLE_API_URL` | Overrides the API base URL, beating the stored config value (but not an explicit `--api-url` flag). |
| `CANDLE_PROFILE` | Selects the profile when `--profile` is not given. |
| `CANDLE_KEYRING_PASSPHRASE` | The passphrase for the encrypted-file backend. Without it, a non-interactive process (no TTY) fails with a clear error rather than falling back to writing plaintext; an interactive session is prompted instead. |
| `CANDLE_CONFIG_DIR` | Overrides where the CLI keeps its config and encrypted-file credentials (default `~/.config/candle`). Mainly a testing seam. |

`CANDLE_DEVICE_TOKEN` and `CANDLE_API_KEY` together mean CI needs no storage backend at all: set
both and every command works without ever touching a keychain or the encrypted file.

## What this CLI deliberately does not do

**Launch, trade, and order commands.** Executing trades and launches belongs to the SDK and MCP
server, not this CLI. This CLI's whole job is credential management plus a handful of read-only or
administrative operations; anything that moves an agent's actual workload stays with the packages
built to run one.

**`keys limits`.** There is no command for setting per-key spend limits, because the API route
that sets them (`PUT /keys/:prefix/limits`) structurally rejects a device token. It only accepts
an agent key or a live session, since a spend limit is fund-movement authority, and this CLI's
device token is scoped narrowly to key management. Manage limits from the portal.

**`devices list` / `devices revoke`.** The device-token endpoints (`GET`/`DELETE
/device/tokens`) are session-only by design: this is the self-renewal guard that keeps a stolen
device token from reading your device metadata (labels, timestamps, revocation state) or revoking
a sibling device. A device token cannot list or revoke devices, including itself, which is why
`auth logout` can revoke the API key it manages but has to send you to the portal to revoke the
device token. Sibling device prefixes are not themselves secret: they appear in `keys list`'s
"minted by" column, which is attribution and grants no capability. Device management is the
portal's job, not this CLI's.
