# @candledottv/cli

The Candle CLI: authorize a device from your browser, then manage API keys, wallets, and setup
health from the terminal. Zero runtime dependencies; the whole thing is one self-contained
`dist/index.js` that runs under plain Node.

## Quick start

```
Install the Candle CLI (macOS 13 or later, or Linux):

    curl -fsSL https://candle.tv/install.sh | bash

or with Homebrew:

    brew install candledottv/tap/candle

Then: candle setup
```

`candle setup` authorizes this device from your browser, shows the agent wallets as funding
destinations, prints the skill and MCP install lines, and runs a full health check. `candle auth
login` on its own does just the authorization step.

The npm package `@candledottv/cli` stays published for CI, programmatic use, and Windows until
`install.ps1` ships; `npx -y @candledottv/cli@latest <command>` runs it once without installing.
It is also the way in on macOS 12 or earlier: the release binaries need macOS 13, and `install.sh`
and Homebrew refuse an older Mac rather than install a binary not built for it.

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
| `candle auth login [--profile <name>] [--scopes <a,b,c>] [--label <name>] [--no-browser]` | Authorizes this device: prints a code, opens (or prints) an approval URL, polls until approved, then stores the resulting device token and API key. `--label` names both the device and the key. |
| `candle auth status` | Shows which storage backend is in use, both credential prefixes, the config file path, and a live validity check for each credential. |
| `candle auth logout [--keep-key]` | Revokes the stored API key (skipped with `--keep-key`), clears local credentials and config, and prints the portal URL for revoking the device itself. |
| `candle keys list [--scopes]` | Lists this account's API keys: prefix, name, Read or Read:Write access, environment, timestamps, and which device minted each one. `--scopes` adds the raw scopes, sorted. |
| `candle keys create [--scopes <a,b,c>] [--label <name>] [--expires-in <days>] [--tx-limit <usd> [--reset daily\|weekly\|monthly\|never]]` | Creates a new API key and prints the plaintext exactly once, with the same optional name, expiration, and USD transaction limit the portal's create form takes. Stored locally only if the CLI does not already hold a working key. |
| `candle keys revoke <prefix>` | Revokes an API key by prefix. Revoking the CLI's own stored key also clears it locally. |
| `candle wallets` | Shows the account's embedded (launch) wallets and any linked wallets, using the API key, with a `Signer` column saying whether this machine holds each linked wallet's signing key. |
| `candle vault init\|status\|new-key\|phrase show\|restore` | The encrypted local vault, `vault.enc`. `init` creates it with a passphrase factor and a 24-word recovery phrase, `new-key` derives a key inside it, `phrase show` displays the phrase on a terminal (never in `--json`, a log or a pipe), and `restore --phrase` rebuilds the derived keys on another machine (`--count`, `--tee-count`, `--external-count`, or a gap scan with `--rpc-url`). No key ever leaves the vault to reach Candle. See [The vault](https://docs.candle.tv/developers/cli#the-vault). |
| `candle vault factor list\|add passphrase\|add security-key\|add touch-id\|add passkey\|remove`, `vault backup --to <path>`, `vault verify-backup <path>` | What can open the vault, and proving a copy of it works: `backup` verifies the copy in full before reporting (a copy is sealed to the passphrase envelope unless it goes to a recognised local disk or removable drive, so a cloud folder and any path the CLI cannot place are both sealed unless `--accept-shared-domain` is passed), and `verify-backup` re-checks an existing one against this vault's key and address set. `add security-key` enrolls a FIDO2 security key (CTAP2 `hmac-secret`, user-verified with the key's PIN or biometric) through the bundled `candle-fido2` helper; one key is not a recoverable factor, two keys are a pair, and the passphrase stays the recovery floor. Every vault command then takes `--factor <id\|passphrase\|security-key>` to say which envelope opens it and `--device <id>` to name the key when several are attached. |
| `candle vault transfer\|promote\|fund\|demote\|export-key` | Moving value and authority. `transfer` and `fund` sign locally from a vault key after showing the decoded transaction (`fund` reaches a TEE wallet from its pinned vault key, or an external wallet, and confirms the destination's last six characters with no `--yes`); `promote` turns a vault key into a delegated TEE wallet (fresh, or the key's own address after a typed warning) and `demote` sweeps it back; `export-key` is the one ceremony that writes a single private key to a file you name. |
| `candle external new\|list\|sweep` | External wallets for outside tools: keys on the vault's third branch (`m/44'/501'/n'/2'`), never delegated to Privy and never registered with Candle. `new` allocates one (and moves the vault to format version 3; refused in a restored vault), `list` shows them, and `sweep <external> --to <vault>` sends everything back to a named vault key, signed locally, confirming the vault key's last six characters. See [Bring your own services](https://docs.candle.tv/developers/cli#bring-your-own-services). |
| `candle sign [--file <path>] --wallet <external>... [--broadcast] [--yes]`, `candle sign message --wallet <external> [--file <path>] [--yes]` | The generic signer: a base64 transaction any tool built, legacy or v0, decoded (lookup tables resolved) and simulated over your own RPC before it is displayed and signed with an external wallet only. A vault key, a TEE wallet or an unnamed signer is refused; a failing simulation is refused with no override; `--yes` skips the confirmation prompt and nothing else. `sign message` signs the exact bytes of a file or of stdin. |
| `candle secrets set\|list\|remove <name>` | Your own third-party API keys, in a keychain namespace separate from Candle's credentials (`tv.candle.cli.secrets`, or `secrets.enc` on the encrypted-file fallback). Typed on a hidden prompt, never sent to Candle, never printed after `set`; `list` shows names only. A plug-in receives one as `CANDLE_SECRET_<NAME>` only when named with `--secret`. |
| `candle plugins`, `candle <name> [--secret <name>]... [--wallet <label>]... [args]` | Git-style plug-ins: an executable `candle-<name>` on your `PATH` runs as `candle <name>` with an allowlist environment built from empty (`PATH`, `HOME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LC_*`, the proxy variables, `CANDLE_PLUGIN_NETWORK`, `CANDLE_PLUGIN_RPC_URL`, the named wallets as `CANDLE_PLUGIN_WALLET_<LABEL>` and the named secrets as `CANDLE_SECRET_<NAME>`). No parent `CANDLE_*` variable, no Candle credential, no passphrase and no private key ever reach it; `--secret` and `--wallet` are stripped from its argv and everything else passes through verbatim. `plugins` lists what is on `PATH`. |
| `candle vault import-legacy --tee`, `candle vault retire-legacy` | Moves an existing `tee-wallets.enc` into the vault without deleting it, then retires the old file once the vault holds everything and a backup has been verified. |
| `candle tee new\|enable\|fund\|status\|disable\|sweep` | A dedicated, capped TEE wallet for one agent: the CLI generates the key and seals it locally in `tee-wallets.enc`, `enable` delegates it to this profile's API key with a pinned sweep vault, `fund` prints what your vault signs, and `disable` then `sweep` stop the agent and move everything back to the vault, signed locally. Solana only. See [TEE wallets](https://docs.candle.tv/developers/cli#tee-wallets). |
| `candle swap <from> <to> --amount <n>\|--percent <n> --wallet <tee>` | Quote, confirm and swap on Solana through the TEE wallet's bound key; first buy after a launch is this command. |
| `candle swap status <id> [--kind trade\|swap\|launch]` | Read an operation without resending it. |
| `candle launch --name <name> --symbol <symbol> --image-url <url> --wallet <tee>` | Create a Solana token with no first buy; needs `launch:write` and operator-enabled `allowLaunch`. |
| `candle profile list` | Lists profiles on this machine, with cached accounts. |
| `candle profile add <name> --api-url <url>` | Creates a profile before authenticating it. |
| `candle profile use <name>` | Makes a profile the active one. |
| `candle profile rename <old> <new>` | Renames a profile. |
| `candle profile remove <name> --yes` | Deletes a profile and its stored credentials. |
| `candle mcp [--tools <a,b,c>] [--read-only] [--print-config]` | Runs the Candle MCP server (built into this binary) with this CLI's stored API key and API URL in its environment, so an MCP client config is just `{"mcpServers": {"candle": {"command": "/Users/you/.local/bin/candle", "args": ["mcp"]}}}` -- the absolute path, because GUI hosts launch servers with the app's environment and never see your PATH. Run `--print-config` to print that block filled in for this install. `--read-only` starts it with no key and only the four keyless read tools; `--tools` pins an explicit allowlist. The server is bundled into the binary, so the host needs nothing else installed. |
| `candle doctor` | Runs a full health check (runtime, backend, credentials, API reachability, credential validity, wallet delegation) as a PASS/FAIL/SKIP table. Exits nonzero on any FAIL. |
| `candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]` | Verifies a release asset's Sigstore bundle against the trusted root compiled into this binary. No network, no credentials, and nothing else installed: the bundle carries the certificate and the transparency-log entry. `--identity` defaults to the release identity for the version in a `latest.json` sitting beside the bundle; `--issuer` defaults to GitHub Actions'. Prints `verified: <identity>` and exits 0, or the reason on stderr and exits 1. |
| `candle update [--check] [--to <tag>]` | Replaces this binary with the latest signed release. The download is renamed over the running binary only after its SHA-256 matches both SHA256SUMS and `latest.json` AND its Sigstore bundle verifies in process against that exact version's release workflow. `--check` reports what is available and installs nothing; `--to <tag>` pins a release (an older one installs, with a warning). A Homebrew or npm install is left alone, with the command that owns it printed instead. |
| `candle completion <zsh\|bash\|fish>` | Prints a shell completion script to stdout, generated from the same data `candle help` prints, so it offers exactly the commands, subcommands and flags the help documents. Install it by redirecting: `candle completion zsh > "${fpath[1]}/_candle"`, `candle completion bash > ~/.local/share/bash-completion/completions/candle`, `candle completion fish > ~/.config/fish/completions/candle.fish`. Static: profile names, key labels and factor ids are not completed, because that would mean reading config or opening the vault at tab time. Regenerate after every `candle update`. |
| `candle help [<command>]` | The top-level screen (six groups of command words, the global flags, and every environment variable the CLI reads), or one command's own: its subcommands, the flags they share, examples, and the environment it reads. `candle <command> --help` is the same screen. Reads no config and makes no request, so it answers before any profile is selected. |

Every command accepts these global options:

| Flag | Effect |
| --- | --- |
| `--api-url <url>` | Overrides the API base URL for this invocation, beating `CANDLE_API_URL` and the stored config value. |
| `--profile <name>` | Act as a named profile; see Profiles below. |
| `--no-verify-account` | Skips the check that the stored key belongs to the profile's account. |
| `--json` | Machine-readable output instead of a formatted table or summary, generally the underlying API response. One exception: `auth login`'s JSON output still omits the plaintext device token and API key, matching its human-readable summary, since login never displays either value in any mode. |
| `--help`, `-h` | Prints usage. |
| `--version`, `-v` | Prints the CLI version. |

## Verify a release

Every release on https://github.com/candledottv/agentic/releases is built and signed by that
repository's `release.yaml` workflow, and `install.sh` and `candle update` already check this for
you. To check a download by hand, three commands, in increasing strength:

```
curl -fsSLO https://github.com/candledottv/agentic/releases/download/cli-v0.6.1/SHA256SUMS
curl -fsSLO https://github.com/candledottv/agentic/releases/download/cli-v0.6.1/candle-darwin-arm64
grep candle-darwin-arm64 SHA256SUMS | shasum -a 256 -c
```

```
gh attestation verify candle-darwin-arm64 --repo candledottv/agentic \
  --cert-identity https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v0.6.1
```

`--cert-identity` is the signing certificate's subject, the workflow file and the release tag in
one string, so it pins both: an attestation minted by the same workflow for a different tag does
not verify. Pass it on its own: `gh` treats its identity flags (`--cert-identity`, its regex form
and the two signer flags) as mutually exclusive, and the signer-workflow flag alone would accept
any tag's attestation.

```
curl -fsSLO https://github.com/candledottv/agentic/releases/download/cli-v0.6.1/candle-darwin-arm64.sigstore.json
cosign verify-blob --new-bundle-format --bundle candle-darwin-arm64.sigstore.json \
  --certificate-identity-regexp '^https://github.com/candledottv/agentic/\.github/workflows/release\.yaml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  candle-darwin-arm64
```

`--new-bundle-format` (cosign 2.2 or newer) says "expect a Sigstore bundle", which is what releases
from 0.6.1 onward are signed as; without it cosign also accepts an older bundle format of its own,
which `candle verify` cannot read.

No cosign or gh installed? `candle verify <file> --bundle <path>` (this CLI's own command, see the
table above) runs the same check against the trusted root compiled into the binary, no network
call required. Full walkthrough, including the installer script's own signature and the
transparency log: [Verify a Candle release](https://docs.candle.tv/developers/verify-a-candle-release).

## The `--json` contract

For agents and scripts, `--json` guarantees: **stdout carries exactly one JSON value** -- the
result on success, or a failure envelope -- and stderr carries diagnostics only. Exit codes:
`0` success, `1` failure (the envelope says why), `2` usage error (the arguments themselves were
wrong; nothing ran), `3` not yet verified (the command did its part, but the outcome it exists to
guarantee is unconfirmed: a wallet stop whose remote enforcement is still pending, a TEE wallet
enabled without verified signing authority, or a sweep that left a residual). Treat `3` as not
done: follow the printed next step, usually re-running the same command.

The value is complete when the process exits, whatever stdout is connected to: a file, a pipe
into `jq`, a subprocess, or an MCP host. The CLI exits only after stdout has drained, and a
reader that closes the pipe early (`| head`) ends the output without an error.

A failure envelope is `{ ok: false, code, message }`, with an optional one-line `suggestion` and,
where a refusal carries facts worth acting on, an optional nested `details`. A vault that is not
where the command looked answers with `details: { path, pathSource: "flag" | "env" | "default" }`,
so an agent can retry against the right file without parsing the message. Keys are added, never
removed, and `code` values never change; `message` and `suggestion` are prose and may.

A generated vault passphrase is shown once on the terminal and never inside a JSON value, so
`vault init` and `vault factor add passphrase` under `--json` take `--own-passphrase` (typed at a
hidden prompt, nothing shown) and refuse the generated form with exit `2`. Prompts themselves are
rendered on stderr, so a command that unlocks a vault on a terminal still leaves stdout as one
JSON value. A security key's PIN is read the same way, by the CLI on its own hidden prompt, and
reaches the `candle-fido2` helper only inside a request piped to it; the helper never reads the
terminal and the PIN never appears in any output.

The security key factor needs the `candle-fido2` helper beside the `candle` binary, which the
installer script and Homebrew put there (Homebrew also installs `libfido2`, which the helper loads
at run time; the installer names the package to add), and it needs libfido2's udev rule on Linux.
The npm package ships no native helper: there the factor is refused with `VAULT_HELPER_MISSING`
until a release build's `candle-fido2` is installed and `CANDLE_FIDO2_HELPER` points at it. No
other factor is ever substituted for one that is refused.

The Touch ID factor (`candle vault factor add touch-id`; not yet released) needs
the signed `candle-enclave.app` helper, which the darwin tarball, the installer script and Homebrew
place beside `candle` once a release ships it; a release cut before Apple's approval ships no
helper and the CLI refuses the factor with a typed code that says so. The CLI verifies the
helper's code signature with `/usr/bin/codesign` before trusting it, and `CANDLE_ENCLAVE_HELPER`
points at a bundle elsewhere. The factor opens the vault on one Mac only and is never a recovery
factor; the passphrase remains the recovery floor.

The synced passkey factor (`candle vault factor add passkey`; not yet released)
runs through the same signed helper on macOS 15 or later, and needs the helper's
associated-domains entitlement for `webcredentials:cli.candle.tv` with an embedded provisioning
profile, plus an `apple-app-site-association` served at
`https://cli.candle.tv/.well-known/apple-app-site-association` (status 200, no redirect,
`Content-Type: application/json`, `{"webcredentials":{"apps":["<TEAM ID>.tv.candle.cli.enclave"]}}`).
Each missing piece is a typed refusal before any passkey sheet, and the refusal names what must be
served. The passkey follows the Apple account, so it is a recoverable factor; two are one factor,
and a copy of the vault is sealed to the passphrase envelope by default unless it goes to a
recognised local disk or removable drive, so that one account never holds
both the blob and a factor that opens it. iCloud Drive and other cloud folders are sealed for that
reason, and so is any path the CLI cannot place, since it cannot tell whether that path syncs to an
account; `--accept-shared-domain` writes the full copy and the acceptance is recorded.

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
`activeProfile` when it pointed there. `candle profile list` shows every profile with its cached
account and how old that cache is (no network call); `profile use <name>` makes one active and
refreshes its account from the API; `profile add <name> --api-url <url>` creates one before
authenticating it; `profile rename` and `profile remove <name> --yes` do what they say. Removing a
profile deletes its two stored credentials and nothing else; imported wallet signers belong to the
wallet, not the profile. `candle wallets` marks, per linked wallet, whether this machine holds its
signer (`stored`, `none`, or `stale` for a revoked wallet whose signer is still here).

Every authenticated command prints `Profile: <name>   Account: <account> at <api url>` before its
own output (`--json` output is unchanged except `auth status`, `auth login` and `doctor`, which
carry `profile` and `account`; `auth status` and `doctor` also carry `cachedAccount`, the account
the profile recorded, whenever a profile is resolved; scripts get identity from
`auth status --json`). The account is cached
at login from the API. Where the line is printed from that cache and `CANDLE_API_KEY` or
`CANDLE_DEVICE_TOKEN` is overriding the stored credential, it reads
`Account: unknown (CANDLE_API_KEY override)` rather than naming an account that credential was
never checked against; `auth status` and `setup` look the account up live and print what they
get, and `auth status` and `doctor` name the account the profile recorded beside it when the two
differ (not under an env credential override, where the live answer is not the profile's key's).
Before an authenticated command acts, the CLI asks the profile's stored key which account it
belongs to and **refuses** if the answer differs from the account the profile recorded, naming
both and the repairs in order of cost. A key that was legitimately re-issued is repaired with
`candle profile use <name>`, which re-caches the account; `candle auth login --profile <name>`
re-authenticates instead; `--no-verify-account` skips the check for one invocation without
repairing anything. An unreachable API turns the check into a warning, never a failure. The
check is skipped when
`CANDLE_API_KEY` or `CANDLE_DEVICE_TOKEN` is overriding the stored credential, when a profile has
no cached account or no stored key, and for the commands that only read the identity or repair it:
`auth login`, `auth status`, `auth logout`, `doctor`, `verify` (which acts as no identity at all:
two files and a signature) and the `profile` commands. `setup` is guarded, because it skips its
login step whenever credentials are already stored.

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
| `CANDLE_ALLOW_INSECURE_HTTP` | Allows an `http://` API URL pointing at a non-loopback host. The CLI attaches a device token or API key to nearly every request, so it refuses cleartext by default. Loopback (`localhost`, `127.0.0.0/8`, `::1`) is always allowed and needs no opt-in; set this only for a trusted local endpoint that is not loopback, such as a devcontainer reaching its host. |

`CANDLE_DEVICE_TOKEN` and `CANDLE_API_KEY` together mean CI needs no storage backend at all: set
both and every command works without ever touching a keychain or the encrypted file.

## What this CLI deliberately does not do

**A built-in integration with any third-party exchange or privacy service.** Candle is never a
party to a transaction you make elsewhere: no Candle API key for the service, no Candle server in
the request path, no fee, and no `--private` flag. Bring your own keys (`candle secrets`), your own
tools (`candle <plugin>`), and sign with an external wallet (`candle sign`); the request goes from
your machine to the service with your key, and nothing goes to Candle.

**Launch, trade, and order commands.** `candle swap`, `candle launch`, and `candle swap status`
execute same-chain Solana swaps and token launches for a TEE wallet. They never open a vault or
locally sign with a TEE private key; Candle builds the transaction and Privy signs it through the
relay. See TEE swaps and launches below. Order-book commands stay with the SDK and MCP, not this
CLI.

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

### TEE swaps and launches (Phase 3)

Use the profile holding the TEE wallet's bound API key and the machine that holds its
relay authorization key. `--wallet` accepts its id, address or unique label. These commands
never open or locally sign with a vault or TEE private key. Candle builds the transaction,
and Privy signs it through Candle's relay. The server's scopes, raw/USD caps and atomic
budget reservation apply to the human and the agent alike. Wide routes require the server's
`TEE_WIDE_ROUTES_ENABLED=1`; it remains off by default.

```sh
candle swap SOL USDC --amount 0.1 --wallet trading --client-trade-id lunch-1
candle swap <mint> SOL --percent 25 --wallet trading --rpc-url https://your-solana-rpc --yes --json
candle launch --name Example --symbol EX --image-url https://example.com/token.png \
  --wallet trading --rpc-url https://your-solana-rpc --client-trade-id example-launch
candle swap status lunch-1
candle swap status example-launch --kind launch --json
```

A same-chain SOL/USDC/CNDL pair uses the base-swap rail. A Solana mint paired with one
of those assets uses the token rail, whether on Candle's curve or graduated to Jupiter/DFlow.
Cross-chain and EVM pairs are refused. Token-to-token pairs without a supported quote asset
are not available. Mint precision and percentage balances use `--rpc-url` or
`CANDLE_SOLANA_RPC_URL`; balances include both classic SPL and Token-2022 accounts.
Amounts use exact decimal arithmetic. `--slippage-bps` defaults to 50.

Before signing, the command displays venue, price impact, tier fee, minimum received and
all returned token warnings. Missing price impact is explicitly **unavailable**, never zero.
`--yes` skips the ordinary prompt but still prints warnings. With `--json`, stdout is one
JSON result containing the quote; the preview and operation id go to stderr. Launch creation
has no price impact or token receipt, shows its maximum SOL debit, and makes no first buy.
Use a separate swap for that buy.

Swaps require `swap:write`. Launch requires `launch:write` **and** operator-enabled
`allowLaunch` on the wallet. The operator sets or clears it through the shipped
`PUT /api/v1/agent/wallets/<id>/capabilities` endpoint with device/session authentication and
`{"capability":"allowLaunch","enabled":true}`. An agent key cannot grant itself this permission.

For scripts, always supply a stable `--client-trade-id` for each intention. Otherwise the CLI
generates and prints one. Reusing an existing id reads its status instead of rebuilding.
The local operation marker survives restarts and prevents concurrent CLI invocations from
starting the same id twice. Base swaps additionally claim build and submission atomically in
Convex and keep the payer signature before broadcast, surviving an API restart. A timeout
or an unconfirmed signature is **not** permission to create a replacement transaction.
`swap status` never resends writes. Use `--kind trade|swap|launch` when an id exists on
multiple rails or when querying from another machine with limited scopes.

For a launch whose broadcast/confirm response was lost, rerunning the same launch id on the
original machine retries **confirmation only** using its saved signature. It never rebuilds
or rebroadcasts. A failed or abandoned build needs a new id after checking the old operation.
Keep the CLI's `operations` directory with its configuration; deleting it removes the local
record of an attempt whose request may not have reached the server.
