# @candledottv/cli

The Candle CLI (current version 0.13.23): authorize a device from your browser, keep your own keys
in an encrypted vault on this machine, hand an agent a TEE wallet it can trade, and manage API
keys, wallets, and setup health from the terminal. Zero runtime dependencies; the whole thing is
one self-contained `dist/index.js` that runs under plain Node.

The full custody guide is [CLI custody](https://docs.candle.tv/developers/cli-custody), and every
command and flag is in the [Candle CLI reference](https://docs.candle.tv/developers/cli).
Not sure this is the right tool? [How to choose: SDK, MCP or CLI](https://docs.candle.tv/developers/choose-a-surface).

`candle vault rename --pairs-from <file> [--dry-run]` renames 1–256 vault or external keys under
one unlock and one commit. Use `<label|address|id> <new-label>` lines or CSV columns `from,to`
(picked by name; quote names with spaces or commas). Blank lines and `#` comments are skipped.
Every finding refuses the whole file before any write; swaps within the batch work. `--dry-run`
unlocks and prints the plan without writing; `--json` returns
`{ ok, renamed: [{ id, address, role, from, to }] }` (plus `dryRun: true` for a dry run).
Single and batch rename require new labels of at most 64 characters, without edge whitespace,
control characters or a leading `-`; names are never trimmed. Existing longer labels still
resolve as targets. A terminal is required. TEE wallets are refused by `vault rename`; use
`candle tee rename`. A retired TEE wallet (demoted and swept) is the exception: it renames here,
since Candle no longer holds it. `candle vault list` hides retired TEE wallets unless `--all`; `vault fund` and `vault transfer` refuse one as a destination (`TEE_WALLET_STOPPED`).

`candle tee rename <label|address|id> <new-label>` renames a TEE wallet on both sides: the label
Candle holds and, when the wallet's key is in this vault, the vault entry.
`candle tee rename --pairs-from <file> [--dry-run]` does 1–256 of them from the same file shape
(lines, or CSV columns `from,to`) under the same label rule (at most 64 characters, never
trimmed). It is owner only (the device token; an API key cannot rename a wallet). One server
call renames every row, all or nothing, then one vault commit; the vault is unlocked once, and
only when a named TEE wallet may be in it. A new name a vault key outside the rename already has
refuses before the server is called. `--json` returns
`{ ok, renamed: [{ id, chain, address, from, to, server, vault }] }`. If the vault write fails
after the server accepted, the command prints address-keyed rows (`<address> <new-label>`, `rerun`
under `--json`) to run again: the old label no longer resolves on the server, and a re-run leaves
the server label alone and finishes the vault.

`candle tui [--profile <name>]` opens Candle Harness in an interactive terminal. Install it
from the [Candle Harness releases](https://github.com/candledottv/harness/releases) and add
`candle-harness` to PATH. The CLI looks for `candle-harness` first, then falls back to
`candle-tui` for older installs; if neither is found, it prints the release link.

## Quick start

```
Install the Candle CLI (macOS 13 or later, or Linux):

    curl -fsSL https://candle.tv/install.sh | bash

or with Homebrew:

    brew install candledottv/tap/candle

Then: candle setup
```

The installer checks the download's SHA-256 and its Sigstore signature before it writes anything,
and needs nothing beyond `curl` and `sha256sum` or `shasum`. It checks the signature with `cosign` or
a signed-in `gh` when one is installed, and otherwise with Candle's own `candle verify`, offline, from
a CLI release whose SHA-256 the script carries (it downloads that `candle` and checks it against the
SHA-256 before running it). If no check can run, it installs nothing.

`candle setup` authorizes this device from your browser, shows the agent wallets as funding
destinations, prints the skill and MCP install lines, and runs a full health check. `candle auth
login` on its own does just the authorization step.

The npm package `@candledottv/cli` stays published for CI, programmatic use, and Windows until
`install.ps1` ships; `npx -y @candledottv/cli@latest <command>` runs it once without installing.
It is also the way in on macOS 12 or earlier: the release binaries need macOS 13, and `install.sh`
and Homebrew refuse an older Mac rather than install a binary not built for it.

### No-npm fallback

The same CLI builds from its public source repository:

```
git clone https://github.com/candledottv/cli.git
cd cli
bun install
bun run --cwd packages/cli build
node packages/cli/dist/index.js auth login
```

## Custody tiers

The CLI keeps keys at two custody tiers, which are not the account plans (`candle plans` lists the ones in force).
**Tier 1, the vault**, is `vault.enc` on your machine: keys derived from a 24-word recovery phrase,
opened only by a factor you present (a passphrase or a FIDO2 security key), never by an environment
variable or `--yes`. **Tier 2, a TEE wallet**, is a vault key promoted with `candle vault promote`
so that one API key can trade it without the vault being unlocked; its funds go home to one pinned
vault key with `candle tee sweep` or `candle vault demote`. Promoting, moving funds out, the
emergency procedure, rebinding, trusted wallets and API key access levels are all in
[Custody tiers: the vault and TEE wallets](https://docs.candle.tv/developers/cli-custody).

The recovery phrase ceremony (`vault init`'s offer or `vault phrase show`) waits for you to save
all 24 words offline and press Enter, then clears the screen before asking for three randomly
chosen words from your saved copy. Clear your terminal's scrollback too: the CLI cannot erase it.

## Commands

| Command | What it does |
| --- | --- |
| `candle setup [--no-browser]` | The onboarding wizard: authorizes this device (skipped when already authorized), prints the agent wallets as funding destinations plus the paste-into-your-agent brief, shows the skill/MCP install lines, runs the full doctor check (setup's exit code is doctor's), and links the web console. Safe to re-run. |
| `candle auth login [--api-url <url>] [--profile <name>] [--scopes <a,b,c>] [--label <name>] [--embedded-wallet deny\|allow] [--no-browser]` | Authorizes this device: prints the API host, a code and its expiry, opens (or prints) an approval URL, polls until approved, then stores the resulting device token and API key. A new profile needs `--api-url` or a prompt. `--label` names both the device and the key. `--embedded-wallet` defaults to deny. `transfer:bound` is refused here and granted afterwards with `keys access <prefix> --access withdraw`. |
| `candle auth status` | Shows which storage backend is in use, both credential prefixes, the config file path, and a live validity check for each credential. |
| `candle auth logout [--keep-key]` | Revokes the stored API key (skipped with `--keep-key`), clears local credentials and config, and prints the portal URL for revoking the device itself. |
| `candle keys list [--scopes]` | Lists this account's API keys: prefix, name, Read, Write or Withdraw access, environment, timestamps, and which device minted each one. `--scopes` adds the raw scopes, sorted. |
| `candle keys create [--access read\|write\|withdraw \| --scopes <a,b,c>] [--label <name>] [--expires-in <days>] [--tx-limit <usd> [--reset daily\|weekly\|monthly\|never]] [--embedded-wallet deny\|allow] [--no-store]` | Creates a new API key and prints the plaintext exactly once, with the same optional name, expiration, and USD transaction limit the portal's create form takes. `--access` mints one of the portal's three levels (`write` trades and launches and cannot move funds; `withdraw` is Write plus `transfer:write` and `transfer:bound`: the key can move funds between your own wallets and to addresses you approved, and out of the wallet it runs to wallets you linked while signed in or marked trusted and to that wallet's vault); `--scopes` names raw scopes instead, never both. `--embedded-wallet` defaults to `deny`; `allow` lets the key spend the account's embedded wallet and is confirmed at a terminal. Stored locally only if the CLI does not already hold a working key. `--no-store` prints the new key without saving it or changing the profile's working key or metadata; `--json` reports `stored: false`. An account holds at most 25 active keys. |
| `candle keys access <prefix\|label\|self> (--access read\|write\|withdraw [--yes] \| --history)` | Changes an existing key's level in place (same key, wallets and caps). Widening needs the device token and the prefix typed back at a terminal; `--yes` skips the prompt when narrowing; `self` narrows the profile's own key and can never widen it. `--history` lists the key's changes and who made them. |
| `candle keys limits <prefix> <asset>=<raw> [<asset>=<raw> ...]` | Sets a key's per-asset caps (`sol`, `usdc`, `cndl`, `eth`, `usdg`, in base units per transaction) with the profile's own API key. It can only tighten; raising or removing a cap is `LOOSEN_REQUIRES_SESSION`, and the owner does that in the web key manager. A device token cannot set these caps. |
| `candle keys update <prefix\|label> --embedded-wallet allow\|deny [--yes]`, `candle keys self embedded-wallet deny` | Allow or deny a key the account's embedded wallet, with the device token (allowing needs the prefix typed back at a terminal). `self embedded-wallet deny` lets the profile's own key give it up with no prompt; a key can never allow itself. |
| `candle keys signer approve <code> --key <prefix\|label> [--reject]`, `candle keys signer move <prefix\|label> [--to-key <prefix\|label>]` | Key signers for bots on a different machine from the vault. `approve` accepts (or rejects) a key's signer request with the device token, after you type the full fingerprint the trading machine printed. `move`, on the machine holding a wallet's current signer, moves every wallet on the key onto its active signer; `--to-key` moves a revoked key's wallets to a live key. |
| `candle keys stop <prefix\|label>` | Pause one key using the device token. Its requests are refused with `PROFILE_PAUSED` until the owner resumes it in the signed-in console; the key and its local credential are kept. Repeating the command succeeds. |
| `candle keys resume <prefix\|label>` | A device token cannot resume a stopped key: the server answers `LOOSEN_REQUIRES_SESSION` and the key stays stopped. The owner resumes it in the signed-in console. An API key cannot stop or resume itself; a revoked key cannot be resumed. |
| `candle keys rotate <prefix\|label> ([--grace <duration> \| --now] [--force] [--yes] [--idempotency-key <key>] \| --finish)` | Gives a key a new secret and keeps its prefix, label, access, limits, wallets and history. The old secret keeps working through `--grace` (default `1h`, at most `24h`) or stops at once with `--now`; `--finish` ends an open window early. When the key is the CLI's own, the new secret replaces it in the keychain. A copy in `CANDLE_API_KEY_FILE`, `CANDLE_API_KEY` or anywhere else must be updated by hand before the window ends; `candle doctor` warns while the old secret is in use. Each run sends an `Idempotency-Key` and retries a dropped connection once; if there is still no answer, rerun with the printed `--idempotency-key` to recover the first secret. |
| `candle keys revoke <prefix\|label>` | Revokes an API key by prefix or label. A label resolves to its prefix the way `keys access` does; two live keys with the same label refuse and list their prefixes. Revoking the CLI's own stored key also clears it locally. A prefix can start with `-`; the key commands accept it as typed, and `--` (`candle keys revoke -- -QVeHyie`) ends the options on any command. |
| `candle keys wallets <prefix>`, `keys wallets set <prefix> --wallets <id,id>`, `keys wallets scope <prefix> --scope all\|selected` | Each key is an agent profile with its own wallet set: list it, replace it, or limit the profile to its assigned wallets. |
| `candle wallets` (alias `candle wallet`) | Shows the account's embedded (launch) wallets and any linked wallets, using the API key, with a `Signer` column saying whether this machine holds each linked wallet's signing key and a `Trusted` column saying whether it is yours (linked while signed in, or marked with `trust`). It links and revokes; it never generates or prints a key, which the vault now derives. |
| `candle wallets import --chain solana\|evm`, `wallets revoke <wallet-id>` | Link a wallet you own (key from `--key-file` or a hidden prompt, sealed to Privy before it leaves the machine), or unlink one. |
| `candle wallets allowlist [--all]` | Print the account's withdrawal allowlist: each approved address's id, chain, address and label, the same rows `candle transfer --to <allowlist label>` resolves by. `--all` adds removed rows. Approving an address is the owner's, in the agent console's Wallets tab; an API key cannot approve. An acting key can revoke an address; a read-only key cannot. |
| `candle wallets authorize` | Gives agents access to the account's embedded wallets. The grant is yours to make in a browser (each wallet's owner is you, so neither the CLI nor the API can attach Candle's signer): this opens the Agents page's grant-only step, creates no key, and with an API key waits until the wallets show as delegated. On a new account, run it before `candle auth login`. |
| `candle wallets trust\|untrust <label\|address\|id\|prefix*>...` | Mark linked wallets as yours so an agent's Withdraw key can move funds into them, or clear the mark. Owner only, over the device token, with a typed confirm; a trailing `*`, as in `'tr-*'`, selects by prefix. |
| `candle wallets allow-launch\|disallow-launch <label\|address\|id\|prefix*>...` | Deprecated. Where the server has `TEE_LAUNCH_BY_SCOPE_ENABLED` on, a key's `launch:write` decides TEE launches: `allow-launch` saves the value and exits 0, and `disallow-launch` saves it, prints the server's `ALLOW_LAUNCH_NOT_ENFORCED` message and exits 1, because no launch is stopped. A server with the switch off still lets TEE wallets pay for a launch (`candle launch`) only after `allow-launch`. Owner only, over the device token; the screen shows each wallet's label, address and bound key before a typed confirm. `disallow-launch --yes` skips the confirm. |
| `candle wallets close-empty [--wallet embedded\|<tee address\|label>] [--keep <mint>]... [--client-trade-id <id>] [--preview] [--yes]` | Closes a wallet's empty token accounts and returns their rent to it, after a preview: the embedded wallet (`swap:write` or `transfer:write`), or a Solana TEE wallet bound to the key (`swap:write`), whose close transactions Candle builds, this machine checks and the key signer approves. `--preview` prints what would close — the whole preview as one JSON document on stdout under `--json` — and closes, signs and prompts nothing; headless without `--yes`, the `CONFIRMATION_REQUIRED` refusal carries that same preview under `details`. |
| `candle vault init\|status\|list\|new-key\|rename\|phrase show\|restore\|reconcile-exposure` | The encrypted local vault, `vault.enc` (Tier 1). `init` creates it with a passphrase factor and a 24-word recovery phrase (and no key), labels its read-back derivation as verification, and leaves security-key enrollment to the separate optional `candle vault enroll security-key` command; `new-key` derives a key inside it (`--count`, `--labels-from <file>` for many under one unlock), `list [filter] [--balances]` shows one line per key, `rename` changes a label only, `phrase show` displays the phrase on a terminal (never in `--json`, a log or a pipe), and `restore --phrase` rebuilds the derived keys on another machine with a new passphrase (`--count`, `--tee-count`, `--external-count`, `--evm-count` and `--evm-tee-count` for EVM keys and Hood TEE wallets, or a Solana gap scan with `--rpc-url`); a restored vault never allocates new keys. `reconcile-exposure` re-reads the account and adds exposure records, clearing nothing. No key ever leaves the vault to reach Candle. See [CLI custody](https://docs.candle.tv/developers/cli-custody). |
| `candle vault factor list\|add passphrase\|add security-key\|add touch-id\|add passkey\|remove` (or `vault enroll <kind>`), `vault backup --to <path>\|icloud`, `vault verify-backup <path>` | What can open the vault, and proving a copy of it works: `backup` verifies the copy in full before reporting (a copy is sealed, keeping only the passphrase and security-key envelopes, unless it goes to a recognised local disk or removable drive, so a cloud folder and any path the CLI cannot place are both sealed unless `--accept-shared-domain` is passed), and `verify-backup` re-checks an existing one against this vault's key and address set. `add security-key` enrolls a FIDO2 security key (CTAP2 `hmac-secret`, user-verified with the key's PIN or biometric) through the bundled `candle-fido2` helper (`--install-helper` fetches and verifies this release's helper first); one key is not a recoverable factor, two keys are a pair, an enrolled key can authorize adding another, and the passphrase stays the recovery floor. `add touch-id` is available in 0.13.23 on supported Macs with the signed `candle-enclave.app`; npm ships no native helper. `add passkey` remains unavailable (`VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM`): the shipped helper lacks the associated-domain entitlement. Every vault command then takes `--factor <id\|passphrase\|security-key\|touch-id>` to say which envelope opens it and `--device <id>` to name the key when several are attached. |
| `candle vault transfer\|promote\|promote-batch\|fund\|demote\|export-key` | Moving value and authority. `transfer` and `fund` sign locally after showing the decoded transaction (`transfer` from a vault key or a promoted TEE wallet, which warns when an agent may be trading it and reports the finalized transfer to Candle's history; `fund` reaches a TEE wallet from its pinned vault key, or an external wallet, with no `--yes`; both verify once, at the unlock, which names the send, then show the destination grouped in fours and take a typed `confirm`); `promote --from <cold label>` derives a fresh TEE wallet pinned to that key (an EVM vault key becomes a Hood TEE wallet), shows the pinned vault address and asks you to type `confirm` to promote the new wallet (promotion moves no funds), `promote --in-place <label> --sweep-to <cold label>` promotes a key at its own address after a typed warning, `promote-batch --pairs-from <file>` does many in place under one unlock, `--to-key` binds the result to another of your keys, and `demote` (disable then sweep; `--emergency` sweeps even when the stop request fails) sends it back to its pinned vault; `export-key` is the one ceremony that writes a single private key to a file you name. `demote` takes several addresses, or `--all --empty` for every Solana TEE wallet with nothing left to sweep, under one unlock and one typed `confirm` (`--yes` skips it), with a result line per wallet and one `--json` document. |
| `candle external new\|list\|sweep` | External wallets for outside tools: keys on the vault's third branch (`m/44'/501'/n'/2'`), never delegated to Privy and never registered with Candle. `new` allocates one (and moves the vault to format version 3; refused in a restored vault), `list` shows them, and `sweep <external> --to <vault>` sends everything back to a named vault key, signed locally, confirmed by a typed `confirm` after the vault key's address is shown. See [Bring your own services](https://docs.candle.tv/developers/cli#bring-your-own-services). |
| `candle sign [--file <path>] --wallet <external>... [--broadcast] [--yes]`, `candle sign message --wallet <external> [--file <path>] [--yes]` | The generic signer: a base64 transaction any tool built, legacy or v0, decoded (lookup tables resolved) and simulated over your own RPC before it is displayed and signed with an external wallet only. A vault key, a TEE wallet or an unnamed signer is refused; a failing simulation is refused with no override; `--yes` skips the confirmation prompt and nothing else. `sign message` signs the exact bytes of a file or of stdin. |
| `candle secrets set\|list\|remove <name>` | Your own third-party API keys, in a keychain namespace separate from Candle's credentials (`tv.candle.cli.secrets`, or `secrets.enc` on the encrypted-file fallback). Typed on a hidden prompt, never sent to Candle, never printed after `set`; `list` shows names only. A plug-in receives one as `CANDLE_SECRET_<NAME>` only when named with `--secret`. |
| `candle plugins`, `candle <name> [--secret <name>]... [--wallet <label>]... [args]` | Git-style plug-ins: an executable `candle-<name>` on your `PATH` runs as `candle <name>` with an allowlist environment built from empty (`PATH`, `HOME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LC_*`, the proxy variables, `CANDLE_PLUGIN_NETWORK`, `CANDLE_PLUGIN_RPC_URL`, the named wallets as `CANDLE_PLUGIN_WALLET_<LABEL>` and the named secrets as `CANDLE_SECRET_<NAME>`). No parent `CANDLE_*` variable, no Candle credential, no passphrase and no private key ever reach it; `--secret` and `--wallet` are stripped from its argv and everything else passes through verbatim. `plugins` lists what is on `PATH`. |
| `candle vault import-legacy --tee`, `candle vault retire-legacy` | Copies the wallets in an existing `tee-wallets.enc` into the vault as imported keys (the recovery phrase does not restore them), then retires the old file once the vault holds everything and a backup has been verified. |
| `candle tee status\|disable\|sweep\|fund` | Operate a TEE wallet (Tier 2): `status` shows its server state and on-chain balances, `disable` stops the agent (exit 0 only on a verified stop, 3 while pending), `sweep --rpc-url <url>` moves everything to the pinned vault, signed locally (closing DAMM v2 positions after verifying each server-built close; `--emergency` sweeps when the API cannot be read and moves the position NFT instead), and `fund` prints what your vault signs. On a Hood wallet (0x), `status` shows ETH, USDG and the gas reserve, and `sweep` moves USDG, WETH, every `--token` and then ETH last. See [CLI custody](https://docs.candle.tv/developers/cli-custody). |
| `candle tee signer new --key <prefix\|label> [--out <pem>] [--force] [--no-wait]` | On the trading machine, with that key's API key: generates the key's signer here and waits for the owner to approve it with `keys signer approve`. The key's wallets then trade from this machine. `--out` also writes a plaintext P-256 authorization key for Privy wallet RPC; it cannot sign Solana transactions (the TEE signs them). `--no-wait` exits 0 once the request exists. With `--json`, stdout is newline-delimited JSON: a pending event (`state`, `userCode`, `verificationUriComplete`, `expiresAt`, `fingerprint`) immediately, then an active result or error when waiting. A retry re-attaches to the same live request without changing its code or deadline. |
| `candle tee signer status --key <prefix\|label> [--json]` | Read the current server signer state without generating a key, requesting a code or waiting. On the requesting machine, also shows the cached approval URL and code while the same request is live. |
| `candle tee signer remove --key <prefix\|label>` | Removes this machine's key signer once it owns no wallets, and tells the server the signer is gone. Refuses while a wallet is still owned by it. Uses the device token, or the key's own API key. |
| `candle tee rebind <wallet...> --to-key <prefix\|label>`, `candle tee rebinds [wallet]` | Move TEE wallets to another key on the same account (owner only, preview then `confirm`; funds and the relay signer do not move), and list the rebind history, filtered to one wallet by its id, address or exact label. |
| `candle tee rename <label\|address\|id> <new-label>`, `candle tee rename --pairs-from <file> [--dry-run]` | Rename one TEE wallet, or 1–256 from a pairs file: the label Candle holds and the vault entry when there is one (owner only; one server call, all or nothing, then one vault commit). |
| `candle tee check <address\|id\|label>... [--label-prefix <p>] [--sign] [--max <n>] [--rpc-url <url>]` | Check, without spending, that each named TEE wallet can really trade: payable membership, wallet record parity against the swap's own listing, and this machine's signer. `--label-prefix` selects wallets by label, `--json` prints one object per run with each wallet's `checks` and a `summary`, and the exit code is 1 when any check fails. `--sign` also builds a tiny SOL/USDC quote, checks its spend, requests a relay signature, verifies it locally and simulates; it never broadcasts, is capped at `--max` wallets (default 10) and needs `swap:write` |
| `candle tee new\|enable` | `new` adds a key to an existing `tee-wallets.enc` and refuses when that store is absent (`vault new-key --chain solana`, then `vault promote --from <label> --to-key <prefix>`). `--factor` does not apply. `enable <address> --vault <address>` delegates an existing key with a pinned sweep vault. `vault import-legacy --tee` migrates an existing store. |
| `candle swap <from> <to> --amount <n>\|--percent <n> --wallet <tee> [--to <tee>] [--wait] [--dry-run]` | Quote, confirm and swap through the TEE wallet's bound key; the first buy after a launch is this command, unless `candle launch --buy` made it. The assets decide the chain (ETH, USDG or a 0x token is Hood; SOL, USDC, CNDL or a mint is Solana). SOL or USDC to ETH or USDG, or back, is a bridge through Relay into this key's own TEE wallet on the other chain (`--to` names it when there are several); `--wait` follows it for up to ten minutes. With `--json`, stdout is exactly one JSON value for swaps, token trades, replays and `swap status`: `kind`, `status`, `clientTradeId`, `signature` (the primary transaction, or `null`), `signatures` (a list) and `raw` (the original response). Every human line is on stderr. The keys older versions printed stay beside them. `--dry-run` (Solana TEE payer only) checks the wallet, builds the quote and checks its spend, then stops: it never signs, sends, prompts or saves an operation, refuses `--yes`, `--percent` and `--client-trade-id`, and refuses embedded, Hood and bridge payers. With `--json` stdout is the per-check results and the quote. |
| `candle swap status <id> [--kind trade\|swap\|launch] [--wait]` | Read an operation without resending it; `--wait` follows a bridge until it ends. |
| `candle swap receipt <hash>` / `candle swap receipt --client-swap-id <id>` | Re-read a one-shot swap's settlement from chain (a swap this key made through MCP or the SDK, not a `candle swap`); reads only, never resends. The `--client-swap-id` form reads the swap's row first and its receipt only when the row is `confirmed`. With `--json`, stdout is the hash form's `{ success, settlement }` or the id form's object with `receipt` (`read`, `no_hash`, `not_written`, `not_found`) and `next`. A human line on stderr says `settled <amount> <asset>` (the hash form prints raw units), or `Settlement: <state>` with `(refunded)`, `(refunded, Relay fallback)` or `(Relay failure)` when Relay failed the bridge. Exit 0 on any read answer, 1 on an API error (a hash this key did not broadcast is `RECEIPT_NOT_FOUND`), 2 on usage. Poll no faster than every 15 seconds. |
| `candle transfer --to <address\|wallet name\|allowlist label\|vault> --asset <SOL\|USDC\|CNDL\|ETH\|USDG>\|--mint <mint>\|--token <0x...> --amount <decimal\|max> [--wallet <tee>] [--client-id <id>] [--rpc-url <url>] [--yes]` | Move funds out of a TEE wallet through its bound Withdraw key, to the wallet's own pinned vault (`--to vault`, any token, `max` allowed, one SOL transfer at most the server's backstop ceiling, 50 SOL by default) or to another of the account's wallets you linked while signed in or marked trusted (a base asset, counted against the key's caps, which must include a per-asset cap and a USD `--tx-limit`). Where the server has `TEE_WITHDRAWALS_ENABLED` on (it ships off), also to an address on the account's withdrawal allowlist, named by its label, id or address, with the same base-asset rule. The asset decides the chain: ETH, USDG or `--token` moves from a Hood TEE wallet. The destination and its kind are shown before you confirm; Candle builds, the relay signs, Candle broadcasts. `--client-id <id>` (1 to 128 of letters, digits, `.` `_` `:` `-`) names the transfer yourself: reusing an id for a transfer already built or sent is `IDEMPOTENCY_CONFLICT` naming that transfer, so a retry never sends twice. |
| `candle transfer status <transfer id\|client id> [--json]` | Where a transfer stands, by the id the build returned or the `--client-id` it was sent under: `built` (signable until `expiresAt`), `expired`, `submitted` with its `signature`, `unconfirmed` (may still land; check the chain or `candle activity` before using a new client id), or `failed`. Candle keeps the answer for 24 hours; an older transfer is in `candle activity`. An unknown id is `JOB_NOT_FOUND`. |
| `candle launch --name <name> --symbol <symbol> --image <path>\|--image-url <url> --wallet <tee>\|embedded [--banner <file\|URL>] [--description <text>] [--website <url>] [--x <url>] [--telegram <url>] [--discord <url>] [--buy <amount>] [--quote-asset <asset>] [--dex-version v3\|v4] [--mode <mode>] [--curve-v <V> --curve-g <G>] [--creator-fee-bps 0\|100\|200] [--staker-allocation-bps <bps>] [--visibility production\|test\|local\|hidden] [--pool-fee 25\|50\|100] [--pool-fee-from <bps> --pool-fee-minutes <min>] [--pool-open legacy\|curve_price] [--exp-pool-shape floor\|full_range] [--fee-wallet <address>\|--fee-wallet-multisig <address> [--fee-wallet-multisig-vault-index <n>]] [--require-fee-wallet] [--open-in <duration>] [--max-buy-per-wallet <amount> --cap-window <duration>] [--allowlist <path> --allowlist-window <duration>] [--dev-buy-max <amount>] [--dry-run] [--check] [--client-trade-id <id>] [--yes]` | Create a token from the named wallet, with an optional first buy. `--wallet embedded` (or `main`) uses `/launch/headless` on Solana or Hood, with or without `--buy`; every plan can use it with `launch:write` and the key's embedded-wallet allowance, without `swap:write`. It previews through `/launch/headless/dry-run`, shows the quote for confirmation, then sends one headless request. A Solana buy is a creator bundle signed by Candle, preserving `bundleId` in the result; a Hood buy is best effort after creation. The server's slippage floor applies; there is no separate CLI build-floor comparison. TEE wallets use `/launch/self` and need Pro or Max, `launch:write`, the bound key and verified signing authority; a server with `TEE_LAUNCH_BY_SCOPE_ENABLED` off also asks for the owner's `allowLaunch` (deprecated). A TEE first buy needs `TEE_LAUNCH_BUYS_ENABLED` (off by default), and with `TEE_LAUNCH_BY_SCOPE_ENABLED` on it also needs `swap:write` (a key without it gets `SCOPE_MISSING`); Solana creator buys also need `AGENT_TRADING_ENABLED` and a configured Jito engine. No gate or plan default changes. `--buy` is a decimal in whole quote units (SOL/USDC/CNDL on Solana, ETH on Hood; USDG has no first buy); zero or empty means no buy. A Hood launch needs `--dex-version v3\|v4`. `--description` and the four absolute http(s) socials flags travel with every preview/build: `--x` maps to `socials.twitter`. `--staker-allocation-bps` accepts 50–1000; `--visibility` is production, test, local or hidden (test keys need test or hidden). `--mode exp-custom` needs `--curve-v` and `--curve-g` in whole quote units; ranges and common help come from the shared launch definition and appear in `candle launch --help`. `--pool-fee` sets the Solana graduated pool fee (default 50 bps); `--pool-fee-from` and `--pool-fee-minutes` add a fall to that rate. Preset `--pool-open curve_price` opens at the curve's last price and burns the rest; omitted it applies when allocations fit `graduation.maxStakerCarveBps`, otherwise falls back to legacy. Exp `--exp-pool-shape` is floor or full_range. `--image-url` is https; `--image` uploads a local PNG/JPEG/GIF/WebP up to 10MB. `--banner` takes a wide local file or https URL. Uploads are public and permanent before confirmation, even on a dry run or decline. `--dry-run` stops at the preview without claiming the launch id. Reuse `--client-trade-id` for recovery, and always pass `--json` in scripts. `--check` answers which launch path works before any of it, in one call (`GET /api/v1/launch/preflight`): the key's tier and embedded-wallet allowance, each bound TEE wallet's allowLaunch (served `true` where the server has `TEE_LAUNCH_BY_SCOPE_ENABLED` on) and verified-active state, and the server's `TEE_LAUNCH_BY_SCOPE_ENABLED`, `TEE_LAUNCH_BUYS_ENABLED` and `AGENT_TRADING_ENABLED` switches. No name, symbol or image is needed, nothing is uploaded or sent, `--wallet <name>` narrows the answer to one wallet, and it exits 1 when no launch path works. On Solana, where the server has `CURVE_LAUNCH_RULES_ENABLED` on, launch rules are fixed at launch and enforced by the curve program: `--open-in` delays the open (until then only the launching wallet may buy, up to `--dev-buy-max`, which defaults to `--buy`), `--max-buy-per-wallet` with `--cap-window` caps what each wallet spends on the curve after the open, and `--allowlist <path>` (one address per line, or comma separated, at most 4,096) with `--allowlist-window` lets only the listed wallets buy. Durations are seconds or `90m`, `6h`, `2d` (the open at most 7 days away, each window at most 24 hours); amounts are whole quote units. The CLI checks each value before any request with the API's bounds, sends the request's nested `launchRules` in raw units, and the preview prints a Launch rules block from the API's answer. Nobody can change the rules after the launch. |
| `candle launch status <mint-or-client-launch-id> [--wait]` | One launch state, `build`, `signed`, `confirmed`, `trading`, `bonded` or `migrated`, for a mint or a `clientLaunchId`. Reads `GET /api/v1/launch/status/{id}` (`launch:read`) and reports the market's own `lifecycle` and `migration` fields. `--wait` follows it until the token is trading, the launch has failed, or ten minutes pass. Nothing is sent. |
| `candle image upload <path>` | Uploads a PNG, JPEG, GIF or WebP file, at most 10MB, and prints the `https://` URL Candle hosts it at, ready to be a launch's `imageUrl`. The type is read from the file's first bytes. The file becomes public and permanent. Needs `launch:write`; spends nothing and does not count against the launch cap. `--json` adds the content type and the size. |
| `candle pnl [--profile <name>]` | P&L: realized net, fees, unrealized and total, then open positions, the same figures the console shows. Without `--profile`, the account's books (every profile, the web app and the CLI, one ledger; needs the Read scope), with a By agent table (each key, then Manual, then the account total). With `--profile <name>`, that profile's key's share of the same P&L: realized on its sales and the open positions that belong to it, with a row per wallet that sums to the total. Each wallet is its own average-cost pool, and a recorded move between the account's wallets carries its cost. Both show a Solana block, a Hood block, then the combined figure, the closed positions as money made, minus money lost, plus partial sells, and a `CHAIN` column (and `WALLET`, where the API names it) on positions. Unpriced positions are never valued at zero; dust (worth under one cent) is marked and still counted. A bridge between Solana and Hood is not a trade, and bridge and Relay costs are not netted. DAMM v2 LP positions are included: realized (withdrawals against the cost basis at the add, plus claimed fees), unrealized (open positions at their share of the pool plus unclaimed fees, against that basis) and vs holding (what the deposited tokens would be worth held); `Total` stays the console's token figure and `Total with LP` covers tokens and LP. |
| `candle portfolio [<filter>] [--chain solana\|hood] [--rpc-url <url>] [--evm-rpc-url <url>] [--no-perps] [--no-vault]` | Vault, TEE and embedded wallets on Solana and Hood in one table with chain, amount, price and value, subtotals per group and per chain, and a total. Solana vault and external balances are read over your own Solana RPC; Candle is sent only the mints, for prices. EVM vault keys are read over your own Hood RPC (`--evm-rpc-url`, else `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC) for ETH and USDG only, priced by asset, never by address; an RPC on another chain is refused. An unpriced Hood token shows why (`no-market-row`, `stale-mark`, ...). `--chain` shows one chain. Each TEE wallet's DAMM v2 LP positions follow the tokens, valued by Candle at the same marks, and count in the total; one whose pool could not be read is shown as not read and the total says it is partial. A Hyperliquid section follows (each EVM TEE wallet's account, read from Hyperliquid directly, never in the total); `--no-perps` skips it. It needs no terminal: without one, `--factor touch-id` or `passkey` still unlocks the vault, and otherwise the vault row says not read and the rest is shown, but the total is partial (exit 3); `--no-vault` leaves the vault out on purpose and may exit 0. |
| `candle scan <contract address> [--chain solana\|hood]` | The token card for one contract, as a Quant group gets it: market, all-time high since launch, bundles, snipers, insiders, fresh wallets, wallet age, tracked wallets in the last hour, the same-name leader, forensics coverage and the Candle page, with the source of each figure. Facts only; a field with no source prints a dash. The chain is read from the address unless `--chain` names it. No key needed and none sent. Served only where `TOKEN_CARD_ENABLED` is on, and `TOKEN_CARD_DISABLED` elsewhere. |
| `candle signals scorecard [--date YYYY-MM-DD]`, `candle signals records [--source pattern\|quant_call\|holder_band\|launch_read] [--before <id>] [--limit <n>]`, `candle signals record <source> <source-id>` | hacc's public signal records, read-only (three GETs to `https://api.hacc.fun/v1/public/...`, or `CANDLE_HACC_URL`, HTTPS only), with this profile's production agent key (`cndl_live_`; a test key or device token is refused before anything is sent). `scorecard` is the daily scorecard, latest or `--date`: signal lift against the matched baseline, and per source, rule and horizon the count, coverage, conservative and priced mean net returns, baseline, lift, 2x/5x/20x tails and delay, with shadow and backfilled rows marked. `records` is a page of per-signal records, newest first; `--before` takes the previous page's `next_before`, `--limit` is 1 to 100. `record` is one signal's record (`pattern` takes the signal id, `launch_read` takes `chain:mint`): entry and per-horizon statuses, conservative and priced net returns, the 24 h path and the matched baseline. Returns are shown as percents of the fractions hacc serves; `--json` keeps hacc's body. Every output ends with the fixed line "Measured record, not a forecast." (on stderr for a refusal), and every `--json` value, a failure envelope included, carries it as `measure`: success, empty page, 404, auth or server error, usage error. A record is a fact about the past, never a forecast or advice. |
| `candle token forensics <mint> [--chain solana\|hood] [--wallet <vault key>] [--yes]` | The pre-buy forensics report: deployer history, deploy-window buyers, `coverage` and `safety`. No key needed; a configured API key is sent. On Hood that key also lets the report carry hacc's EVM contract safety (`safety.evm`), read and charged on the key's own hacc research plan; with only a device token a Hood report reads `no_key`. Past the free rate with x402 per-use on, Candle's per-use price is drawn from the key's account credit or paid from the vault, separately from hacc's research credits. |
| `candle token clusters <mint> [--chain solana\|hood]` | Optional third-party Solana cluster estimates, with fetched time and a linked-wallet caveat. Unavailable analysis prints a reason and exits 0; `--json` emits the availability union. No key. |
| `candle token edit <mint> [--chain solana\|hood] [--description <text>] [--website <url>] [--x <url>] [--telegram <url>] [--discord <url>] [--clear <field>]...` | As the token's creator, set Candle's copy of its description and links; `--clear` removes one. Name, symbol and image cannot be changed, and nothing is written on chain. Needs a `launch:write` key from the launching account. Served only where `TOKEN_METADATA_EDIT_ENABLED` is on, and `METADATA_EDIT_DISABLED` elsewhere. |
| `candle token history <mint> [--chain solana\|hood]` | The token's metadata edits, newest first. Public; no key sent. |
| `candle token events <mint> [--chain solana\|hood] [--kind trade\|signal\|callout] [--since <iso-8601>] [--limit <n>] [--before <cursor>]` | One token's signals, callouts and tracked-wallet trades, one event per line: time, kind, name or short address (with the wallet's kind), action and size, sells with `W` or `L` when known. `--kind` filters the fetched page locally; `--before` continues the page. No key needed; a configured key is sent so group names follow its tier. Served only where `TOKEN_EVENTS_ENABLED` is on, and `TOKEN_EVENTS_DISABLED` elsewhere. |
| `candle token about\|claim\|section set\|section restore\|history\|flag\|comment\|comments <address>` | The token's About page: `about`, `history` and `comments` are public reads with no key, `about --capabilities` is this account's own eligibility (`token-pages:read`), and `claim`, `section set\|restore`, `comment` and `flag` act as the key's account (`token-pages:write`, granted only through `keys create --scopes`). Every write needs the account's own current 0.5% of supply (any positive balance to flag), checked by Candle. The creator proof is a message the creator signs on their own machine (`claim --creator --challenge`, then `--challenge-id` and `--signature`), never a transaction. Section text comes from `--file`; a revision conflict exits 4 and leaves the file untouched; no answer exits 3 with the `--idempotency-key` to rerun with. |
| `candle plans` | The plans the API serves (`GET /api/v1/agent/plans`): each plan's monthly price, agent trade fee, Hyperliquid perps builder fee, the limits a new key gets, and one row per capability (buying and selling tokens not launched on Candle, self-launch, atomic launch, linked wallets, perps, limit orders). Every number is the server's; the CLI bundles none. Needs no key and sends none. `--json` is the server's body. Your own plan is `candle doctor`'s Plan row. |
| `candle lp pools\|add\|positions\|remove\|claim` | Meteora DAMM v2 liquidity from a TEE wallet through its bound key (`lp:write`, opt-in). `pools <token>` lists pools with liquidity, fee, volume and an estimated yield; `add <pool> --amount <n> <token> --wallet <tee>` opens or grows a position at the pool's ratio after showing both tokens' Token-2022 warnings; `positions` lists every position across your TEE wallets; `remove <position> --percent <n>` withdraws (100% also claims fees and closes the position); `claim <position>` claims fees and rewards. No Candle fee. A `tee sweep` closes open positions itself; see TEE wallets. |
| `candle perps setup\|deposit\|open\|close\|cancel\|orders\|positions\|leverage` | Hyperliquid perpetuals from the EVM TEE wallet bound to the key (`perps:write`, opt-in). `setup` approves Candle's builder fee (0.1%, none on Max) once; `deposit <amount> <SOL\|USDC\|ETH\|USDG>` moves funds onto the Hyperliquid account through Relay from the key's Solana or Hood TEE wallet (`swap:write`; `--to` names the EVM TEE wallet from Solana; `deposit status <id>` reads it; no withdrawal yet); `open <coin> <long\|short> <size>` trades at market, or as a limit with `--price`, with optional `--tp` and `--sl`; `close <coin>` closes reduce-only; `cancel <cloid>`; `leverage <coin> <x> [--isolated]`; `orders` and `positions` read live. Candle builds each action within the key's limits; the CLI recomputes its hash and checks the action type and Candle's builder before anything is signed, then submits the signed action to Hyperliquid itself. `CANDLE_HYPERLIQUID_BUILDER` deliberately replaces the release builder pin; its use is shown in the preview. |
| `candle profile list` | Lists profiles on this machine, with cached accounts. |
| `candle profile add <name> --api-url <url>` | Creates a profile before authenticating it. |
| `candle profile use <name>` | Makes a profile the active one. |
| `candle profile rename <old> <new>` | Renames a profile. |
| `candle profile remove <name> --yes` | Deletes a profile and its stored credentials. |
| `candle profile set <name> --rpc-url <url>\|--clear-rpc-url` | Sets or clears this profile's Solana RPC, used when `--rpc-url` and `CANDLE_SOLANA_RPC_URL` are not given. Only its host is ever shown. |
| `candle mcp [--tools <a,b,c>] [--read-only] [--print-config]` | Runs the Candle MCP server (built into this binary) with this CLI's resolved API key and API URL in a private in-process configuration, so an MCP client config is just `{"mcpServers": {"candle": {"command": "/Users/you/.local/bin/candle", "args": ["mcp"]}}}` -- the absolute path, because GUI hosts launch servers with the app's environment and never see your PATH. Run `--print-config` to print that block filled in for this install. `--read-only` starts it with no key and only the seven keyless read tools; `--tools` pins an explicit allowlist. The server is bundled into the binary, so the host needs nothing else installed. With `CANDLE_IMAGE_DIR` set to an absolute directory path in its environment, the two launch tools accept `imagePath` for an image file inside that directory; the upload is public and permanent, on a dry run too. |
| `candle doctor` | Runs a full health check (runtime, backend, credentials, API reachability, credential validity, wallet delegation, the install method, the account's plan and its trade fee, and whether the `candle-fido2` security key helper is beside the binary) as a PASS/FAIL/SKIP table meant for pasting into a bug report. Exits nonzero on any FAIL. |
| `candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]` | Verifies a release asset's Sigstore bundle against the trusted root compiled into this binary. No network, no credentials, and nothing else installed: the bundle carries the certificate and the transparency-log entry. `--identity` defaults to the release identity for the version in a `latest.json` sitting beside the bundle; `--issuer` defaults to GitHub Actions'. Prints `Release signature verified` with the full file, identity, provenance and issuer fields and exits 0, or the reason on stderr and exits 1. |
| `candle update [--check] [--to <tag>]` | Replaces this binary, and the `candle-fido2` helper beside it, with the latest signed release. Nothing is renamed until both downloads pass; the binary is renamed over the running binary only after its SHA-256 matches both SHA256SUMS and `latest.json` AND its Sigstore bundle verifies in process against that exact version's release workflow. `--check` reports what is available and installs nothing; `--to <tag>` pins a release (an older one installs, with a warning). A Homebrew or npm install is left alone, with the command that owns it printed instead. |
| `candle completion <zsh\|bash\|fish>` | Prints a shell completion script to stdout, generated from the same data `candle help` prints, so it offers exactly the commands, subcommands and flags the help documents. Install it by redirecting: `candle completion zsh > "${fpath[1]}/_candle"`, `candle completion bash > ~/.local/share/bash-completion/completions/candle`, `candle completion fish > ~/.config/fish/completions/candle.fish`. Static: profile names, key labels and factor ids are not completed, because that would mean reading config or opening the vault at tab time. Regenerate after every `candle update`. |
| `candle help [<command>] [--more]` | The top-level screen lists command words in one column, grouped under six headings, followed by global flags and the shared Environment section. Topic help has a short intro, wrapped usage, subcommands, flags and examples. `candle help <command> --more` includes the full rules and row descriptions locally. `candle <command> --help [--more]` is the same screen. Reads no config and makes no request, so it answers before any profile is selected. |

`candle vault transfer <to> --amount max --asset SOL --from <label>` sends the source wallet’s SOL balance minus the exact quoted transaction fee. The plain system wallet is emptied, so its source rent reserve is zero. The balance and fee are refreshed after confirmation; a changed amount or fee is displayed and must be confirmed again (at most three confirmations). An unavailable or unstable fee quote, or a balance that cannot cover the fee and a positive send, refuses before signing. Nonce and program accounts cannot use this plain transfer shape. SPL and Token-2022 `max` send the source associated token account’s full raw balance (mint fees may reduce what arrives); SOL must still cover fees and any destination token account rent. Hood native `max` deducts the fee cap; ERC-20 `max` sends the whole token balance.

### Retrying a transfer safely

Pass `--client-id <id>` and a retry cannot send twice. The id rides the build as `clientTransferId`, and the receipt carries it back. If the first attempt died before you saw the result, run `candle transfer status <id>` (the transfer id or your client id): `submitted` shows the `signature`, `built` means nothing was sent yet, and `expired` means the build lapsed unsent. `unconfirmed` keeps the signature and the client id bound even after the build expires: it may still land, so check the chain or `candle activity` before doing anything else or using a new client id. `failed` means a definite revert or a refusal before broadcast. Running the same `candle transfer --client-id <id>` again while the earlier one is pending, built, sent or unconfirmed is refused with `IDEMPOTENCY_CONFLICT`, naming the transfer. Status is kept for 24 hours; older transfers are in `candle activity`.

`candle transfer --asset SOL --amount max` (including `--to vault` from a TEE wallet) sends the balance minus 10,000 lamports of fee headroom and the RPC-reported rent-exempt minimum for a zero-byte system account. It keeps the payer rent-exempt. If no positive amount remains, Candle refuses before signing with `TRANSFER_AMOUNT_UNAVAILABLE`; the message reports the spendable lamports, fee headroom and rent minimum. The returned `amountRaw` is the amount the transaction moves.

The documented `--access` values are `read`, `write` and `withdraw`. The older `read-write`, `transfer` and `read-write-transfer` values remain accepted as silent, permanent aliases.

Every command accepts these global options:

| Flag | Effect |
| --- | --- |
| `--api-url <url>` | Overrides the API base URL for this invocation, beating `CANDLE_API_URL` and the stored config value. |
| `--profile <name>` | Act as a named profile; see Profiles below. |
| `--factor <id\|kind>` | Vault commands: unlock with this envelope. |
| `--device <id>` | Vault commands: the security key to use, by id. |
| `--no-verify-account` | Skips the check that the stored key belongs to the profile's account. |
| `--full` | Prints ids in full where a table would shorten them (`9EAq…9Hd7`). |
| `--json` | Machine-readable output instead of a formatted table or summary, generally the underlying API response. Two exceptions: `auth login`'s JSON result still omits the plaintext device token and API key, matching its human-readable summary, since login never displays either value in any mode; and its device-code progress (code, approval URL, expiry) is printed to stderr as one JSON object with `"stage":"device_code"`, keeping stdout a single parseable JSON value. |
| `--help`, `-h` | Prints usage. |
| `--version`, `-v` | Prints the CLI version. |

## Verify a release

Every release on https://github.com/candledottv/cli/releases is built and signed by that
repository's `release.yaml` workflow, and `install.sh` and `candle update` already check this for
you. Releases up to 0.12.0 were published from https://github.com/candledottv/agentic/releases; check
one of those against that repository's name in the commands below. To check a download by hand,
three commands, in increasing strength:

```
curl -fsSLO https://github.com/candledottv/cli/releases/download/cli-v0.13.5/SHA256SUMS
curl -fsSLO https://github.com/candledottv/cli/releases/download/cli-v0.13.5/candle-darwin-arm64
grep candle-darwin-arm64 SHA256SUMS | shasum -a 256 -c
```

```
gh attestation verify candle-darwin-arm64 --repo candledottv/cli \
  --cert-identity https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v0.13.5
```

`--cert-identity` is the signing certificate's subject, the workflow file and the release tag in
one string, so it pins both: an attestation minted by the same workflow for a different tag does
not verify. Pass it on its own: `gh` treats its identity flags (`--cert-identity`, its regex form
and the two signer flags) as mutually exclusive, and the signer-workflow flag alone would accept
any tag's attestation.

```
curl -fsSLO https://github.com/candledottv/cli/releases/download/cli-v0.13.5/candle-darwin-arm64.sigstore.json
cosign verify-blob --new-bundle-format --bundle candle-darwin-arm64.sigstore.json \
  --certificate-identity-regexp '^https://github.com/candledottv/cli/\.github/workflows/release\.yaml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  candle-darwin-arm64
```

`--new-bundle-format` (cosign 2.2 or newer) says "expect a Sigstore bundle", which is what releases
from 0.6.1 onward are signed as; without it cosign also accepts an older bundle format of its own,
which `candle verify` cannot read.

No cosign or gh installed? `candle verify <file> --bundle <path>` (this CLI's own command, see the
table above) runs the same check against the trusted root compiled into the binary, no network
call required. It is also what `install.sh` uses on a machine with neither. Full walkthrough, including the installer script's own signature and the
transparency log: [Verify a Candle release](https://docs.candle.tv/developers/verify-a-candle-release).

## Browser confirm for owner steps

Where the API has `OWNER_CONFIRM_ENABLED` on, an owner step made with the device token that widens what the account's keys can do also needs one approval in your browser, signed in as the account owner. The API answers `403 OWNER_CONFIRM_REQUIRED` and changes nothing; the CLI then:

1. Prints what you are approving (a summary the server built), `Open <url>` and `Code: XXXX-XXXX` on stderr, with "Only approve if you just ran this command." When the API names the account the request was made as (0.13.24+), the first line reads `This needs your approval in the browser as <display name> (<short wallet>): <summary>` and a following line says the browser must be signed in as that account — so a wrong-account browser is obvious before it answers "Request not found". It opens the browser only with `--open`. Under `--json` it writes one line to stderr instead, `{"ok":false,"pending":true,"code":"OWNER_CONFIRM_REQUIRED","ownerConfirm":{"userCode","verificationUriComplete","expiresIn","step","summary","account":{"wallet","displayName"}}}`, and keeps stdout for the final result.
2. Waits, polling every few seconds. The code expires 5 minutes after it was issued.
3. When you approve at `/dev/agent/confirm`, sends the identical request again and prints its result. Deny it and the command exits 1 with `Denied in the browser; nothing changed.`; let it expire and it exits 1 with `The confirmation expired; nothing changed. Run the command again.`
4. With `--no-wait` it prints the code and exits 7 without waiting. The command does not resume later: run it again without `--no-wait`, or make the change in the console.

One approval covers exactly one request, from this device, for this account. The steps that ask for it: `keys create` (every key, a read-only one included), `keys rotate`, `keys access` when it widens, `keys update --embedded-wallet allow`, `auth login --embedded-wallet allow` when it allows the new key the embedded wallet, `keys signer approve` (not `--reject`), `tee rebind` (not the preview), `wallets allow-launch`, `vault promote --to-key` (one approval per wallet), `keys limit` when it raises, clears or changes the window of a transaction limit, `perps thresholds set` and `clear` when they loosen, and `perps reduce-only off`. The Candle Harness shows the same summary, URL and code when its core mints a key. Narrowing steps never ask: revoking or stopping a key, narrowing access, `rotate --finish`, tightening a limit, `reduce-only on`. An older CLI prints the server's message, which carries the URL and code, but cannot finish the step: update the CLI before this is on. A signed-in console session never sees the confirm.

## The `--json` contract

For agents and scripts, `--json` guarantees: **stdout carries exactly one JSON value** -- the
result on success, or a failure envelope -- and stderr carries diagnostics only. Exit codes:
`0` success, `1` failure (the envelope says why), `2` usage error (the arguments themselves were
wrong; nothing ran), `3` not yet verified (the command did its part, but the outcome it exists to
guarantee is unconfirmed: a wallet stop whose remote enforcement is still pending, a TEE wallet
enabled without verified signing authority, or a sweep that left a residual). Treat `3` as not
done: follow the printed next step, usually re-running the same command. `5` cancelled: you
declined a confirmation prompt, or typed the wrong word at a typed confirm, so nothing was
signed, sent or written (BE-2674). Under `--json` the document still says what happened --
`status: "cancelled"` for a result, or the `CANCELLED` / `DESTINATION_NOT_CONFIRMED` envelope --
and a script can now tell a user decline from a refusal by the exit code alone.

A swap or token trade also exits `3` when it may be on chain: the server answered
`stage: "unconfirmed"` (sent, outcome not seen) or, for a token trade, `stage: "executed"` (the
trade landed and a later step failed). The envelope's `details` keep `stage` and `signature`.
Never retry under a new id; read `candle swap status <id>` first.

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
JSON value. A vault command run without a terminal to prompt at — stdin and stdout for the
ceremony commands, stdin and stderr for the prompt itself — refuses with `VAULT_TERMINAL_REQUIRED`
before anything is asked; it is not an unlock failure, and no flag or environment variable
supplies a passphrase or PIN. A security key's PIN is read the same way, by the CLI on its own hidden prompt, and
reaches the `candle-fido2` helper only inside a request piped to it; the helper never reads the
terminal and the PIN never appears in any output.

The security key factor needs the `candle-fido2` helper beside the `candle` binary, which the
installer script and Homebrew put there (Homebrew also installs `libfido2`, which the helper loads
at run time; the installer names the package to add), and it needs libfido2's udev rule on Linux.
The npm package ships no native helper: there the factor is refused with `VAULT_HELPER_MISSING`
until a release build's `candle-fido2` is installed and `CANDLE_FIDO2_HELPER` points at it. No
other factor is ever substituted for one that is refused.

The Touch ID factor (`candle vault factor add touch-id`) is available in
[0.13.23](https://github.com/candledottv/cli/releases/tag/cli-v0.13.23) on Apple silicon Macs and Intel
Macs with a T2 chip. It needs the signed `candle-enclave.app` helper, which the darwin tarball,
the installer script and Homebrew place beside `candle`. The npm package ships no native helper:
install the matching signed bundle and set `CANDLE_ENCLAVE_HELPER`, or the command refuses with
`VAULT_HELPER_MISSING`. An untrusted helper is `VAULT_HELPER_UNTRUSTED`; Linux and a Mac without
a Secure Enclave are `VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM`. The CLI verifies the
helper's code signature with `/usr/bin/codesign` before trusting it, and `CANDLE_ENCLAVE_HELPER`
points at a bundle elsewhere. The factor opens the vault on one Mac only and is never a recovery
factor; the passphrase remains the recovery floor.

The synced passkey factor (`candle vault factor add passkey`) remains unavailable in 0.13.23:
the shipped helper deliberately omits `webcredentials:cli.candle.tv`, so it refuses with
`VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM` and explains the missing entitlement. Passkey enrollment
has not yet been checked on real Macs. A future release needs macOS 15 or later and the helper's
associated-domains entitlement for `webcredentials:cli.candle.tv` with an embedded provisioning
profile, plus an `apple-app-site-association` served at
`https://cli.candle.tv/.well-known/apple-app-site-association` (status 200, no redirect,
`Content-Type: application/json`, `{"webcredentials":{"apps":["<TEAM ID>.tv.candle.cli.enclave"]}}`).
A missing association refuses with `VAULT_FACTOR_UNAVAILABLE` before any passkey sheet and names
what must be served; serving it allows real enrollment when the local requirements are met.
The passkey follows the Apple account, so it is a recoverable factor; two are one factor,
and a copy of the vault is sealed (passphrase and security-key envelopes only) by default unless it goes to a
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
when none is already selected, named from `--profile <name>` or derived from the API
host (`staging`, `production`, or the hostname, de-duplicated with a numeric suffix). Creating one
requires `--api-url`, `CANDLE_API_URL`, or a prompt; it does not inherit another host. Which profile a command acts as, highest
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

Every authenticated command prints `Profile <name> · Account <account> · <api host>`, then a
blank line, before its own output. Plain mode, a pipe and CI use `-` in place of `·`. The
address is shortened (`FfU8…8pPD`; `--full` prints it whole) and an `https://` scheme is dropped. `--json` output is unchanged except `auth status`,
`auth login` and `doctor`, which carry `profile` and `account`; `auth status` and `doctor` also
carry `cachedAccount`, the account the profile recorded, whenever a profile is resolved; scripts
get identity from `auth status --json`. The account is cached
at login from the API. Where the line is printed and `CANDLE_API_KEY_FILE`, `CANDLE_API_KEY` or `CANDLE_DEVICE_TOKEN` is
overriding the stored credential, it reads `Account <address> (CANDLE_API_KEY override)` when the
overriding key could be asked which account it belongs to, and
`Account unknown (CANDLE_API_KEY override)` when it could not (offline, revoked, or a
device-token-only override), rather than naming an account that credential was
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
`CANDLE_API_KEY_FILE`, `CANDLE_API_KEY` or `CANDLE_DEVICE_TOKEN` is overriding the stored credential, when a profile has
no cached account or no stored key, and for the commands that only read the identity or repair it:
`auth login`, `auth status`, `auth logout`, `doctor`, `verify` (which acts as no identity at all:
two files and a signature), `plans` (a public read that sends no credential) and the `profile`
commands. `setup` is guarded, because it skips its
login step whenever credentials are already stored.

A pre-profile install is migrated on first run: profile `default` is created from the existing
settings and the two credentials are copied to `profile:default:*` refs. The old refs and fields
are left in place so an older CLI keeps working, until an `auth logout` clears them along with
the profile they were migrated into.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CANDLE_DEVICE_TOKEN` | Overrides the stored device token for this process. Every command that needs the device token checks this first, before the store. |
| `CANDLE_API_KEY_FILE` | Exclusive external API-key source; Linux/macOS regular file owned by the effective UID, mode exactly 0400 or 0600. Conflicts with either raw key variable; no stored-key fallback. |
| `CANDLE_API_KEY` | Overrides the stored API key for this process, same precedence as above. |
| `CANDLE_API_URL` | Overrides the API base URL, beating the stored config value (but not an explicit `--api-url` flag). |
| `CANDLE_PROFILE` | Selects the profile when `--profile` is not given. |
| `CANDLE_KEYRING_PASSPHRASE` | The passphrase for the encrypted-file backend. Without it, a non-interactive process (no TTY) fails with a clear error rather than falling back to writing plaintext; an interactive session is prompted instead. |
| `CANDLE_CONFIG_DIR` | Where `vault.enc`, `tee-wallets.enc`, credentials and config live (default `~/.config/candle`). Set it once instead of passing `--keystore`. |
| `CANDLE_SOLANA_RPC_URL` | Solana RPC endpoint when `--rpc-url` is not given. Beats the profile's (`candle profile set <name> --rpc-url`); the public endpoint when none is set. |
| `CANDLE_EVM_RPC_URL` | EVM RPC endpoint for an EVM vault key when `--rpc-url` (transfer) or `--evm-rpc-url` (list) is not given; without it the built-in Hood RPC is used. |
| `CANDLE_FIDO2_HELPER` | Path to the `candle-fido2` helper, when it is not beside the binary. |
| `CANDLE_ENCLAVE_HELPER` | Path to the signed `candle-enclave.app` helper (macOS). |
| `CANDLE_HYPERLIQUID_BUILDER` | `candle perps`: deliberately replace this release's builder trust anchor with a nonzero EVM address, shown in the preview. Unset uses the release pin, never the API's builder. |
| `CANDLE_HYPERLIQUID_NETWORK` | `candle perps`: set to `testnet` to trade Hyperliquid testnet. |
| `CANDLE_NO_UPDATE_NOTIFIER` | Set to `1` to silence the update notice. |
| `CANDLE_KEYSTORE_PASSPHRASE` | Refused: no command reads it, and vault and tee commands stop while it is set. |
| `CANDLE_ALLOW_INSECURE_HTTP` | Allows an `http://` API URL pointing at a non-loopback host. The CLI attaches a device token or API key to nearly every request, so it refuses cleartext by default. Loopback (`localhost`, `127.0.0.0/8`, `::1`) is always allowed and needs no opt-in; set this only for a trusted local endpoint that is not loopback, such as a devcontainer reaching its host. |

`CANDLE_DEVICE_TOKEN` and `CANDLE_API_KEY` together mean CI needs no storage backend at all: set
both and every command works without ever touching a keychain or the encrypted file.

### External key files (CLI 0.13.22 and later)

A host may supply an absolute path with both raw key variables absent:

```sh
CANDLE_API_KEY_FILE=/run/user/1000/candle/agent.key candle wallets
CANDLE_API_KEY_FILE=/run/user/1000/candle/agent.key candle mcp
```

The file is read once per invocation, including identity, doctor and requests. It is never
imported into a profile or credential store. File identity replaces the cached profile account;
logout clears stored credentials but the external source remains active until unset. Rotation
never rewrites this file: replace the old secret before the grace deadline (immediately for
`--now`) and restart MCP. JSON rotation reports `candleApiKeyFileStale: true` when applicable.

A nonblank file setting conflicts with either nonblank `CANDLE_API_KEY` or
`CANDLE_AGENT_API_KEY`, even for equal values, before any file/store read. Without a file,
the CLI uses `CANDLE_API_KEY`, then the selected profile slot (or legacy slot without a profile);
the standalone MCP alias `CANDLE_AGENT_API_KEY` does not supply a CLI credential.
Blank inputs select no file. Relative paths use the invocation's initial working directory;
spaces in a nonblank path are preserved, with no shell or tilde expansion.

Use a trusted directory. Final symlinks, other owners, modes other than 0400/0600, nonregular
files, more than 4096 bytes, and changes during reading are refused. The file must contain one
nonempty printable ASCII token without spaces, optionally followed by one LF or CRLF. Windows
and hosts lacking the required POSIX primitives refuse file input. Errors use
`API_KEY_SOURCE_CONFLICT`, `API_KEY_FILE_UNSUPPORTED`, `API_KEY_FILE_UNREADABLE` or
`API_KEY_FILE_INVALID` and omit paths and key bytes; repair the file locally rather than relying
on a fallback. Help/version/completion stay local. `mcp --read-only` ignores every key source
and does not load the file, including with `--print-config`.

The key stays in private memory; it is never inserted into environment variables, argv, launch
config or saved files. Ordinary browser/helper/hook/keychain children retain the nonsecret path;
plugins keep their environment allowlist and receive neither the path nor key. This reduces
environment exposure, not access by root or another process with the same UID. Extended ACLs
are not audited. This is available in `candle` and the bundled `candle mcp` from CLI 0.13.22.
For standalone `candle-mcp` (`@candledottv/mcp`), this remains unreleased source support:
version 0.10.32 does not include it and needs its own next release.

## What this CLI deliberately does not do

**A built-in integration with any third-party exchange or privacy service.** Candle is never a
party to a transaction you make elsewhere: no Candle API key for the service, no Candle server in
the request path, no fee, and no `--private` flag. Bring your own keys (`candle secrets`), your own
tools (`candle <plugin>`), and sign with an external wallet (`candle sign`); the request goes from
your machine to the service with your key, and nothing goes to Candle.

**Limit orders.** `candle swap`, `candle launch`, and `candle swap status` execute swaps, bridges
and token launches for a TEE wallet. They never open a vault or locally sign with a TEE private
key; Candle builds the transaction and Privy signs it through the relay. See TEE swaps and launches
below. Limit orders are a REST surface only (`/api/v1/trade/agent/orders`), not in this CLI, the
SDK or the MCP server.

**`keys limits`.** The API route that sets per-key spend limits (`PUT /keys/:prefix/limits`)
structurally rejects a device token: a spend limit is fund-movement authority, and this CLI's
device token is scoped narrowly to key management. So `candle keys limits` sends the profile's own
API key, and an agent key may only tighten (lower a cap, or add one where none was set). Raising
or removing a cap is refused with `LOOSEN_REQUIRES_SESSION`; the owner does that from the portal.

**`devices list` / `devices revoke`.** The device-token endpoints (`GET`/`DELETE
/device/tokens`) are session-only by design: this is the self-renewal guard that keeps a stolen
device token from reading your device metadata (labels, timestamps, revocation state) or revoking
a sibling device. A device token cannot list or revoke devices, including itself, which is why
`auth logout` can revoke the API key it manages but has to send you to the portal to revoke the
device token. Sibling device prefixes are not themselves secret: they appear in `keys list`'s
"minted by" column, which is attribution and grants no capability. Device management is the
portal's job, not this CLI's.

### Sweeping TEE wallets home

A Solana sweep keeps its reads and send preflight at or after the newest finalized slot it has observed, including retained receipts. If the RPC cannot meet that context, signing stops; choose another RPC with `--rpc-url`. A transaction refused at simulation is reported as **rejected (not broadcast)** with its program error and up to 20 sanitized log lines. Once its local pending record is cleared, re-run the sweep immediately. A failed local cleanup instead requires waiting for blockhash expiry, normally within two minutes. Later independent accounts continue after a cleared rejection, up to three rejections per run; skipped accounts and SOL are listed as `not-attempted`. Connection failures after a send remain uncertain, and the CLI never re-sends automatically. `--json` adds `signature`, `broadcast`, `rejection` and `diagnostics` to rejection residuals, and `contextFloorSlot` (or `null`) at the top level. Exit codes are unchanged.

### TEE swaps and launches

Use the profile holding the TEE wallet's bound API key and the machine that holds its
relay authorization key. `--wallet` accepts its id, address or unique label. These commands
never open or locally sign with a vault or TEE private key. Candle builds the transaction,
and Privy signs it through Candle's relay. The server's scopes, raw/USD caps and atomic
budget reservation apply to the human and the agent alike.

```sh
candle swap SOL USDC --amount 0.1 --wallet trading --client-trade-id lunch-1
candle swap <mint> SOL --percent 25 --wallet trading --rpc-url https://your-solana-rpc --yes --json
candle launch --name Example --symbol EX --image-url https://example.com/token.png \
  --wallet trading --rpc-url https://your-solana-rpc --client-trade-id example-launch
candle launch --name Example --symbol EX --image ./token.png --wallet trading
candle image upload ./token.png
candle swap status lunch-1
candle swap status example-launch --kind launch --json
```

`--image <path>` launches with an image file on this machine: the CLI checks it (a PNG, JPEG,
GIF or WebP by its first bytes, at most 10MB) before any request, uploads it to Candle, and
builds the launch with the URL that comes back. The upload happens once, before the confirm
prompt and before the launch id is claimed, and it is a publication: the file is pinned to public
storage and stays there, with whatever metadata it carries, even if you decline or the launch
fails. A failed upload leaves the launch id unused, and re-running a started launch uploads
nothing. `candle image upload <path>` does the upload alone and prints the URL, for a launch made
somewhere else. `--image-url` takes only an `https://` URL.

`candle lp` (Meteora DAMM v2) follows the same shape: the server builds and quotes, you confirm,
the relay signs, and this machine broadcasts over `--rpc-url` before `/confirm` writes the ledger.
The bound key needs the opt-in `lp:write` scope. An open
position is swept by `candle tee sweep`: the CLI discovers the position NFT locally (Token-2022,
amount 1, decimals 0), fetches one unsigned close per position, verifies every close (ordered
keys, program allowlist, simulation, writable-account classification) before signing any, and
`--emergency` moves the NFT to the vault instead of fetching a server-built close.

A same-chain SOL/USDC/CNDL pair uses the base-swap rail. A Solana mint paired with one
of those assets uses the token rail, whether on Candle's curve or graduated to Jupiter/DFlow.
A Hood pair (ETH, USDG or a 0x token) swaps on Hood; SOL or USDC to ETH or USDG, or back, is a
bridge between the key's own TEE wallets. Token-to-token pairs without a supported quote asset
are not available. Mint precision and percentage balances use `--rpc-url` or
`CANDLE_SOLANA_RPC_URL`; balances include both classic SPL and Token-2022 accounts.
Amounts use exact decimal arithmetic. `--slippage-bps` defaults to 50.

Before signing, the command displays venue, price impact, tier fee, minimum received and
all returned token warnings. Missing price impact is explicitly **unavailable**, never zero.
`--yes` skips the ordinary prompt but still prints warnings. With `--json`, stdout is one
JSON result containing the quote; the preview and operation id go to stderr. Launch creation
has no price impact or token receipt and shows its maximum SOL debit. Without `--buy` it makes
no first buy; use a separate swap for that buy. With `--buy <amount>` (whole units of the quote
asset, as `--amount` is for a swap) the same wallet buys at launch: as its own leg in one Jito bundle with the launch on
Solana, as a last leg after the curve and the fee on Hood. Candle reserves the buy against the
key's spend window before anything is signed. A TEE `--buy` needs the server's
`TEE_LAUNCH_BUYS_ENABLED=1`, which is off by default; while it is off Candle refuses the buy
(`VALIDATION_FAILED` on `buyAmount`) and nothing is built or signed.

Swaps require `swap:write`. A TEE launch requires `launch:write` on the key the wallet is bound to;
where the server has `TEE_LAUNCH_BY_SCOPE_ENABLED` on, that is all it asks of the key, and a TEE first buy
also needs `swap:write`. `allowLaunch` is deprecated and served `true` on TEE wallets there. A server with
the switch off still asks the account owner (not Candle, and not the agent) to set it with
`candle wallets allow-launch <wallet>` (and clears it with `candle wallets disallow-launch <wallet>`), over the device token from `candle auth login` (`PUT /api/v1/agent/wallets/<id>/capabilities`
takes a device token or a web session); an agent key cannot grant itself this permission. To keep a key
from launching, pause it (`candle keys stop <prefix>`), move it to Read, or rebind the wallet to a key
without `launch:write`.

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

### Hyperliquid per-key PnL

`candle pnl --profile <name>` / SDK `getProfilePnl(keyPrefix)` / MCP `candle_get_profile_pnl`
read the existing `GET /api/v1/agent/keys/{prefix}/pnl`. The answer adds an optional
`hyperliquid` section, and the CLI prints it under **Hyperliquid**. The existing read
authentication applies; on an older API the section is simply absent. No additional signing, deposit or setup is needed for this read.

The section reports main-exchange perps for **every EVM TEE wallet bound to the key's profile,
per binding period** (`coverage: "profile"`; revoked, swept and rebound wallets included for the
time they were the profile's). `realizedGrossUsd` is the venue `closedPnl`, `fundingUsd` is
signed (received positive, paid negative), `feesUsd` is venue fees including builder fees
(rebates are negative), and `realizedNetUsd = realizedGrossUsd + fundingUsd - feesUsd`. Builder
fees are already included in the venue fee and are not subtracted again. `unrealizedUsd` is the
open positions' unrealized at each wallet's cutoff, `netUsd = realizedNetUsd + unrealizedUsd`
(both USD decimal strings), and `positions` lists the open positions, each with
`fundingNetUsd` positive when earned. Deposits and withdrawals are not P&L.

Facts and unrealized stop at the same cutoff per wallet. For a wallet still bound to the
profile, the cutoff is Hyperliquid's position time at this read: the fills and funding since the
wallet's last stored snapshot are read through that time and must reconcile with the positions
(each fill continues the previous position, the positions match, and every open hour has its
funding row). That wallet's `byWallet` entries say `reconciliation: "live"`, and the CLI prints
"(live, not yet settled)". A wallet whose binding to the profile ended before its last stored
snapshot is `settled`. `markedAt` is the oldest wallet cutoff, `completeThroughMs` the lowest
completeness watermark, and `perpsSnapshotId` identifies the cutoff vector. "Reconciled" is not
"complete": a round opened and closed between two fills Hyperliquid never returned cannot be
seen.

The net is **also counted in the total**: when `read` is true, `pnl.totalUsd` includes `netUsd`
and the answer's `perpsInTotal` is `true`; the CLI's `Total` line says it includes Hyperliquid.
When the section cannot be read or reconciled within the request's Hyperliquid budget, it is
`{ read: false, code, reason }` without amounts, `pnl.totalUsd` is the spot total,
`perpsInTotal` is `false`, and the CLI says the total excludes perps and why. Never a zero.
`historyPartial` (and `partialReasons`) flags history the stored record does not cover;
`truncated` repeats it for older CLIs. At most 20 wallets are read. `--json` preserves the
section and its coverage fields. Agent boards are outside this slice.


## CNDL staking

Solana staking is available through the agent rail while the deployment enables it (off by
default). There is no instant unstake. Read the pool wait and wallet eligibility notes first:
pending withdrawal CNDL counts toward nothing for Pro; sCNDL in any eligible account wallet
counts toward Pro and earns the account's Hood reward, except a wallet another account also
claims, wallets past the 200-wallet cap, and an account with no EVM wallet.

Commands: `candle stake`, `candle stake add <amount>`, `candle stake remove <amount>`,
`candle stake finish [<withdrawal>]`, `candle stake claim <rewardId>` or `candle stake claim --all`.
Use `--wallet main` (default for builds) or a TEE wallet with a local relay signer,
`--client-stake-id <id>` for replay-safe retries, `--yes` to approve the displayed wallet/costs,
and `--json` for the result. Add/remove amounts are decimal CNDL/sCNDL respectively. Writes
MOVE REAL FUNDS. A rerun posts the saved signed TEE transaction to submit again without
re-signing; the server reads the chain first, so it lands once. The signed transaction is kept
in the CLI operations directory for that retry. An embedded rerun replays the saved build.

## Licence

MIT, see [LICENSE](LICENSE). Third-party material, including the EFF long wordlist used for
generated vault passphrases (CC BY 3.0 US), is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Immutable token updates

`candle token update <address> --file ./update.txt --chain solana --idempotency-key <saved-key>`
posts 1–1000 characters with the account's `token-pages:write` key and fresh 0.5% eligibility.
The file is validated locally and stays untouched. A lost answer retries identical bytes once;
exit 3 retains the key for an explicit retry. The post cannot be edited.
`candle token post delete <address> <post-id> --chain solana --idempotency-key <saved-key>`
soft-deletes a post owned by that key's account, including posts from its agents, after selling too.
Both commands support `--json` and default-off server refusals. Package release remains a separate
human-owned step.

### Token comments

`candle token comment <address> --file ./comment.txt --chain solana --idempotency-key <saved-key>`
posts 1–500 characters under the same `token-pages:write` key and fresh 0.5% eligibility as a
section edit. The file is validated locally and stays untouched; a lost answer retries identical
bytes once, and exit 3 retains the key. A comment cannot be edited and is never pushed to holders.
`candle token comments <address> [--limit <n>] [--cursor <c>]` lists comments newest first with
tombstones; it is public and sends no key. `candle token post delete` removes the key account's own
comment, including after selling. Package release remains a separate human-owned step.


### Agent key rotation API

Owner clients can call `POST /api/v1/agent/keys/{prefix}/rotate` using a Privy session or
CLI device token (an agent API key is refused). Send a JSON object with optional
`graceSeconds` (integer 0–86400, default 3600) and `force` (boolean, default false).
Persist an `Idempotency-Key` header and reuse the same header, actor and input after a
lost response: every identity store returns the same secret and timestamps; conflicting
reuse returns 409. The response is `{ key, keyPrefix, rotatedAt, previousValidUntil, note }`.
Save `key` securely; `previousValidUntil` is epoch milliseconds or null for zero grace.

Rotation preserves the prefix, bindings, settings, history and original expiry.
An open grace window requires `force: true` to rotate again, discarding its oldest secret.
Old-secret responses carry `X-Candle-Key-Rotated` with an ISO UTC deadline. Update external
copies before that deadline. `POST /api/v1/agent/keys/{prefix}/rotate/finish` (no body)
ends grace immediately and returns `{ keyPrefix, changed }`; repeating it is harmless.
Zero grace also invalidates the old secret immediately. Invalid JSON/non-object bodies
return 400 without mutation; other-owner prefixes return 404; revoked, expired and hosted
MCP keys return 409; contained accounts return 403. `candle keys rotate` (see the commands
table) drives this route and updates the CLI's own keychain slot.

See [agent access](../../apps/docs/src/content/docs/developers/agent-access.md#rotating-a-key)
for the complete contract.


During the verifier upgrade, rotation and finish may return retryable 503 with reason
`rotation_verifier_not_ready` before changing any credential. Keep the existing secret
and retry after the service is ready; the API does not silently shorten the grace guarantee.

## Uncertain Hood legs (BE-3072)

On Hood, when a leg's receipt is not confirmed, the CLI reports `LEG_UNCONFIRMED` (exit 3), keeps the
hash it computed from its own signed bytes, and tells you not to repeat the trade and to read
`candle swap status <id> --kind trade`. A revert exits 1 before the trade leg succeeded and 3 after.
`No leg landed` is no longer printed on an empty list: it was never negative evidence; the CLI says
`No leg is confirmed yet`. JSON output keeps `legEvidence`, `reconciliation`, `recoveryRequired`,
`safeAction` and `pollAfterMs` from the server. Status makes no signing or send calls.

## Legacy Hood leg recovery and readable guards

A `WALLET_BUSY` refusal names the guarded `operationId`, rail (`operationKind`), client `refId`,
leg, fixed `reason`, `clearingCondition`, `statusPath` and `statusCommand`. An operation id is
separate from a rail's client id:

```sh
candle swap status --operation <operationId>
candle swap recover --operation <operationId> --hash <0x-transaction-hash>
```

`GET /api/v1/agent/hood-tee/operations/{operationId}` and
`POST /api/v1/agent/hood-tee/operations/{operationId}/recover` return
`{ success: true, operation: { ..., guard?, recovery? } }`. The POST body accepts only
`{ candidateHash?: string }`. A locator names a transaction to verify; it never proves identity.
Both paths use the account's owning rail scope (`swap:write`, `launch:read`, or `transfer:write`);
swap operations also require the key that placed them. An unauthorized lookup returns the same
404 `JOB_NOT_FOUND` as an unknown id. Recovery inside an active window returns 409
`OPERATION_ACTIVE`, retryable true. Reads and recovery work while the trading switch is off.

Legacy recovery reconstructs the exact signed type-2 envelope and verifies its hash, signer and
historical Candle stamp before recording an exact-hash receipt. It needs no client-held bytes.
It never signs, sends, rebroadcasts, restamps, returns a next leg, collects fees or revives the
operation. Failed/expired parents and unattempted planned legs keep their labels. Proving one
leg keeps every other unresolved leg held. A nonce count, elapsed time, missing transaction,
allowance or terminal job label cannot clear a hold. `not_sent` requires positive bound claim
proof that signing cannot have happened or happen later; pending/ambiguous claims remain held.

While `guard.recoveryRequired` is true, read status and follow `clearingCondition`. CLI status and
recover exit 3 while held. `legacy_identity_missing` can accept a locator; `nonce_conflict`,
`receipt_conflict`, `legacy_candidate_conflict` and `legacy_proof_incomplete` keep the wallet held
until the stated proof or a separately reviewed disposition exists. A landed leg stays landed.
No rebuild or repeat-trade instruction follows an uncertain result.

Every Hood rail job read carries its operation's `guard`, regardless of the job's terminal label.
`GET /api/v1/agent/wallets/{walletId}/hood-tee` is the read-only locator of last resort, even with
no job row: `guard: { held, incomplete, operations }` lists at most 10 held operations. A held
failed/expired operation also makes `activeOperation` non-null for installed custody clients.
Incomplete proof without a known holder omits `activeOperation`, so those clients fail closed.
Current custody commands refuse `WALLET_GUARDED`. Preserve that compatibility projection during
rollback. This endpoint performs no recovery writes.

SDK: `getHoodTeeOperation(operationId)` and
`recoverHoodTeeOperation(operationId, { candidateHash? })`; `GuardSummary` and `WalletBusyDetails`
are exported. MCP: `candle_get_operation` accepts `operationId` exclusively instead of
`clientId`/`kind`; `candle_recover_operation` accepts `operationId` and optional `candidateHash`.
An older API without explicit operation lookup requires reading the job by its client id.
These client source changes require a separate human package release; this repair bumps no version.
