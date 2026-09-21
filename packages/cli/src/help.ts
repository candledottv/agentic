/**
 * The help DATA and its two renderers, and nothing else (BE-238, spec 0.11.1 D1/D2).
 *
 * `index.ts` used to carry one 88-line `HELP_TEXT` block listing every command, every subcommand
 * and every flag inline: the first thing anyone sees, and the least designed surface in the
 * product. It is now two levels. `renderTopLevel` prints command WORDS only, grouped, with the
 * global flags, the ENVIRONMENT section and the plug-in line. `renderTopic` prints one screen per
 * command word: what it is, its usage, its subcommand rows, the flags every subcommand of that
 * word takes, examples, and the environment it reads. There is no third level.
 *
 * This file imports nothing from `index.ts` -- that would be a cycle, since `index.ts` imports the
 * renderers -- so it cannot check itself against dispatch. `index.test.ts` does: T1 pins
 * `Object.keys(HELP)` against `ROUTED_COMMANDS` in BOTH directions, which closes the gap the old
 * drift test's own comment admitted (a command routed but documented nowhere passed it), and T2
 * pins each topic's rows against `ROUTED_SUBCOMMANDS`. `commands/completion.ts` reads this file
 * and nothing else, so a completion script cannot offer a command that does not route.
 *
 * A row's `invocation` is one line. The renderer decides the column and wraps; hand-wrapping an
 * invocation here would break the row parsing every drift test does (`/^ {2}(\S+)/`), because a
 * continuation line must never look like the start of a row.
 */

/** One documented invocation: a subcommand row, a flag row, or a global flag. */
export interface Row {
  /** A single line, never pre-wrapped. For a subcommand row it starts with the subcommand word. */
  invocation: string
  description: string
}

/** An operator-set environment variable, described once here and referenced by name elsewhere. */
export interface EnvVar {
  name: string
  description: string
}

/** One command word's screen. `group` places it on the top level; `display` is the friendlier
 * spelling shown there when it differs from the canonical routed word (`wallet` for `wallets`). */
export interface Topic {
  group: string
  display?: string
  /** The one line under its group on the top level. */
  summary: string
  /** Two lines or so, at the head of the topic screen. */
  description: string
  usage: string[]
  rows: Row[]
  /** The flags every subcommand of this word takes, rendered as their own block. */
  flags?: Row[]
  examples: string[]
  /** Names into `ENVIRONMENT`. The description is looked up there, so it is written once (D2). */
  env?: string[]
}

/** The six groups, in the order the top level prints them. */
export const GROUPS = [
  "Start here",
  "Trade",
  "Account",
  "Custody, on this machine",
  "Your own services",
  "Maintain",
] as const

/**
 * Every operator-set variable the CLI reads, in the order the top level prints them (D2). The list
 * is the whole list on purpose: the section exists so that there is one place to look, and the
 * operator stranded by BE-235's item 4 could not find `CANDLE_CONFIG_DIR` anywhere in `--help`.
 * `index.test.ts`'s T8 scans the source for every `CANDLE_*` name the binary reads and requires
 * each one to be here or in `ENV_NOT_IN_HELP`, so a variable added to the code and documented
 * nowhere fails CI.
 */
export const ENVIRONMENT: EnvVar[] = [
  {
    name: "CANDLE_CONFIG_DIR",
    description:
      "Where vault.enc, tee-wallets.enc, credentials and config live (default ~/.config/candle). Set it once instead of passing --keystore.",
  },
  { name: "CANDLE_PROFILE", description: "The profile to act as, when --profile is not given" },
  { name: "CANDLE_API_URL", description: "API base URL, when --api-url is not given" },
  { name: "CANDLE_API_KEY", description: "An agent API key; beats the stored one" },
  { name: "CANDLE_DEVICE_TOKEN", description: "A device token, for key-management commands" },
  {
    name: "CANDLE_KEYRING_PASSPHRASE",
    description: "Unlocks the encrypted-file backend where no OS keychain exists",
  },
  { name: "CANDLE_SOLANA_RPC_URL", description: "Solana RPC endpoint, when --rpc-url is not given" },
  {
    name: "CANDLE_FIDO2_HELPER",
    description: "Path to the candle-fido2 helper, when it is not beside the binary",
  },
  {
    name: "CANDLE_ENCLAVE_HELPER",
    description: "Path to the signed candle-enclave.app helper (macOS)",
  },
  { name: "CANDLE_NO_UPDATE_NOTIFIER", description: "Set to 1 to silence the update notice" },
  {
    name: "CANDLE_KEYSTORE_PASSPHRASE",
    description: "Refused: no command reads it; vault and tee commands stop while it is set",
  },
]

/**
 * The `CANDLE_*` names the source mentions that deliberately do NOT appear on the help screen,
 * each with the reason (D2). T8 reads this beside `ENVIRONMENT`: a name in neither is a variable
 * the binary reads and documents nowhere, which is the rot BE-235's item 4 was. Keeping the reason
 * here rather than in a test comment is what makes the omission a decision instead of an oversight.
 */
export const ENV_NOT_IN_HELP: Record<string, string> = {
  CANDLE_RELEASE_BASE_URL: "Test and staging knob: where the release manifest and assets are fetched from.",
  CANDLE_ALLOW_INSECURE_HTTP: "Test and staging knob: permits a plain-http API URL.",
  CANDLE_VAULT_FAKE_OS_MAJOR: "Test only: pins the macOS major version the platform checks read.",
  CANDLE_INSTALL_DIR: "Read by install.sh, not by this binary.",
  CANDLE_INSTALL_ALLOW_UNSIGNED: "Read by install.sh, not by this binary.",
  CANDLE_AGENT_API_KEY: "Set BY `candle mcp` for the server it hosts; never read by the CLI.",
  CANDLE_MCP_TOOLS: "Set BY `candle mcp` for the server it hosts; never read by the CLI.",
  CANDLE_PLUGIN_RPC_URL: "Written into a plug-in's environment, never read. Documented on the plugins topic.",
  CANDLE_PLUGIN_NETWORK: "Written into a plug-in's environment, never read. Documented on the plugins topic.",
  CANDLE_PLUGIN_WALLET: "Prefix written into a plug-in's environment, never read. Documented on the plugins topic.",
  CANDLE_SECRET: "Prefix written into a plug-in's environment, never read. Documented on the plugins topic.",
}

/** The environment lists topics repeat, by name. Written once here so a topic cannot disagree
 * with another about which variables its family of commands reads. */
const ENV_API = [
  "CANDLE_PROFILE",
  "CANDLE_API_URL",
  "CANDLE_API_KEY",
  "CANDLE_DEVICE_TOKEN",
  "CANDLE_KEYRING_PASSPHRASE",
]
const ENV_LOCAL_SIGNING = ["CANDLE_CONFIG_DIR", "CANDLE_SOLANA_RPC_URL", "CANDLE_KEYSTORE_PASSPHRASE"]

/** The four kinds `vault factor add` takes, in the order `vault status` lists them. One copy: the
 * vault topic's row and the completion script's value list are both built from it, so a kind
 * cannot be offered by a completion the help never names. */
export const FACTOR_KINDS = ["passphrase", "security-key", "touch-id", "passkey"] as const

/** The shells `candle completion` writes a script for. One copy: the topic's rows below and
 * `commands/completion.ts`'s refusal are both built from it, so the help and the error message
 * cannot come to name different sets. */
export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const

/** The flags every `vault` subcommand takes. `tee`, `external` and `sign` share the keystore line
 * and not the factor ones, which only the vault's own envelopes use. */
const KEYSTORE_FLAG: Row = {
  invocation: "-k, --keystore <path>",
  description: "The vault file for this invocation. For a permanent location set CANDLE_CONFIG_DIR instead.",
}

export const GLOBAL_FLAGS: Row[] = [
  { invocation: "--profile <name>", description: "Act as a named profile" },
  { invocation: "--api-url <url>", description: "Override the API base URL" },
  { invocation: "--json", description: "Machine-readable output: exactly one JSON value on stdout" },
  { invocation: "--factor <id|kind>", description: "Vault commands: unlock with this envelope" },
  { invocation: "--device <id>", description: "Vault commands: the security key to use, by id" },
  {
    invocation: "--no-verify-account",
    description: "Skip the check that the stored key belongs to the profile's account",
  },
  { invocation: "--help, -h", description: "Show help; after a command word, that command's help" },
  { invocation: "--version, -v", description: "Show the CLI version" },
]

export const PLUGIN_LINE: Row = {
  invocation: "candle <name> [--secret <name>]... [--wallet <label>]... [args]",
  description:
    "Runs candle-<name> from your PATH with an allowlist environment: only the secrets and external wallet addresses named here, never a Candle credential.",
}

/**
 * Every routed command word's screen, keyed by the CANONICAL word dispatch routes (`wallets`, not
 * `wallet`). Rows are the 0.11.0 help block's rows with the command word stripped, moved verbatim
 * except where D6 removed the two 0.10.0 tombstones.
 */
export const HELP: Record<string, Topic> = {
  setup: {
    group: "Start here",
    summary: "One wizard: authorize, fund, connect, verify",
    description:
      "The onboarding wizard, safe to re-run: it authorizes this device when it is not already authorized, prints the agent wallets as funding destinations, shows the skill and MCP install lines, and finishes with the full doctor check.",
    usage: ["candle setup [--no-browser]"],
    rows: [],
    flags: [{ invocation: "--no-browser", description: "Print the approval URL instead of opening a browser" }],
    examples: ["candle setup", "candle setup --no-browser"],
    env: ENV_API,
  },
  auth: {
    group: "Start here",
    summary: "Authorize this device, or show and clear its credentials",
    description:
      "Device authorization: a code is printed, an approval URL is opened or printed, and the device token and API key it returns are stored in this machine's keychain. Nothing here is ever written to a plaintext dotfile.",
    usage: ["candle auth <subcommand> [flags]"],
    rows: [
      {
        invocation: "login [--scopes <a,b,c>] [--label <name>] [--no-browser] [--profile <name>]",
        description: "Authorize this device",
      },
      { invocation: "status", description: "Show credential status" },
      { invocation: "logout [--keep-key]", description: "Clear local credentials" },
    ],
    examples: [
      "candle auth login",
      "candle auth login --no-browser --profile staging",
      "candle auth status",
      "candle auth logout --keep-key",
    ],
    env: ENV_API,
  },
  doctor: {
    group: "Start here",
    summary: "Diagnose CLI setup: credentials, storage backend, API reachability",
    description:
      "One PASS/FAIL/SKIP table over the runtime, the storage backend, both credentials, API reachability and wallet delegation. Its output is meant to be pasted into a bug report. Exits nonzero on any FAIL.",
    usage: ["candle doctor"],
    rows: [],
    examples: ["candle doctor", "candle doctor --json"],
    env: ENV_API,
  },

  swap: {
    group: "Trade",
    summary: "Quote, confirm and swap on Solana; read an operation by id",
    description:
      "Swaps run through a TEE wallet's bound key: the quote is shown and confirmed before anything is sent, and the first buy after a launch is this command rather than part of the launch.",
    usage: ["candle swap <from> <to> [flags]", "candle swap status <id>"],
    rows: [
      {
        invocation: "<from> <to> --amount <n>|--percent <n> --wallet <tee>",
        description: "Quote, confirm and swap on Solana",
      },
      {
        invocation: "status <id> [--kind trade|swap|launch]",
        description: "Read an operation without resending it",
      },
    ],
    examples: [
      "candle swap SOL USDC --amount 0.5 --wallet AgentOne",
      "candle swap USDC SOL --percent 100 --wallet AgentOne",
      "candle swap status op_123 --kind swap",
    ],
    env: ENV_API,
  },
  launch: {
    group: "Trade",
    summary: "Create a Solana token (the first buy is a separate swap)",
    description:
      "Creates a Solana token with no first buy, so the launch and the position are two decisions rather than one. Needs the launch:write scope and an operator-enabled allowLaunch.",
    usage: ["candle launch --name <name> --symbol <symbol> --image-url <url> --wallet <tee>"],
    rows: [],
    flags: [
      { invocation: "--name <name>", description: "The token's name" },
      { invocation: "--symbol <symbol>", description: "The token's ticker" },
      { invocation: "--image-url <url>", description: "The token image, already hosted" },
      { invocation: "--wallet <tee>", description: "The TEE wallet that creates it" },
    ],
    examples: ["candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet AgentOne"],
    env: ENV_API,
  },

  keys: {
    group: "Account",
    summary: "API keys, and the wallets each key may use",
    description:
      "API keys are minted over the device token and shown exactly once. A key's wallet set and scope decide which wallets an agent holding it may act on.",
    usage: ["candle keys <subcommand> [flags]"],
    rows: [
      { invocation: "list", description: "List API keys" },
      {
        invocation:
          "create [--scopes <a,b,c>] [--label <name>] [--expires-in <days>] [--tx-limit <usd> [--reset daily|weekly|monthly|never]]",
        description: "Create an API key",
      },
      { invocation: "revoke <prefix>", description: "Revoke an API key" },
      { invocation: "wallets <prefix>", description: "Wallets an agent profile can use" },
      // Indented, as the 0.11.0 block had them: these are second words under `keys wallets`, not
      // subcommands of `keys`. The indent is what keeps them out of every row-start scan (the
      // drift test's, and the completion generator's), which reads a row start as `/^ {2}(\S+)/`.
      { invocation: "  set <prefix> --wallets <id,id>", description: "Replace the profile's wallet set" },
      {
        invocation: "  scope <prefix> --scope <all|selected>",
        description: "Limit a profile to assigned wallets",
      },
    ],
    examples: [
      "candle keys list",
      "candle keys create --scopes trade:write --label agent-one",
      "candle keys wallets ck_live_ab12",
      "candle keys revoke ck_live_ab12",
    ],
    env: ENV_API,
  },
  wallets: {
    group: "Account",
    display: "wallet",
    summary: "Launch and linked wallets; import or revoke one (wallets is an alias)",
    description:
      "The account's embedded launch wallets and any wallet you linked, with a Signer column saying whether this machine holds the signing key. Keys are derived in the vault now: this command links and revokes, it never generates or prints one.",
    usage: ["candle wallet [flags]", "candle wallet <subcommand> [flags]"],
    rows: [
      {
        invocation: "import --chain <solana|evm> [options]",
        description: "Import a wallet you own (key via --key-file or hidden prompt)",
      },
      { invocation: "revoke <wallet-id>", description: "Revoke a linked wallet" },
    ],
    examples: [
      "candle wallet",
      "candle wallet import --chain solana --key-file ./signer.json",
      "candle wallet revoke wal_123",
    ],
    env: ENV_API,
  },
  profile: {
    group: "Account",
    summary: "Named profiles, one per account or environment",
    description:
      "A profile is a named set of credentials and an API URL: one per account, or one per environment. Every other command acts as the selected profile, and these manage the map itself.",
    usage: ["candle profile <subcommand> [flags]"],
    rows: [
      { invocation: "list", description: "Profiles on this machine, with cached accounts" },
      { invocation: "add <name> --api-url <url>", description: "Create a profile before authenticating it" },
      { invocation: "use <name>", description: "Make a profile the active one" },
      { invocation: "rename <old> <new>", description: "Rename a profile" },
      { invocation: "remove <name> --yes", description: "Delete a profile and its stored credentials" },
    ],
    examples: [
      "candle profile list",
      "candle profile add staging --api-url https://staging.api.candle.tv",
      "candle profile use staging",
      "candle profile remove old --yes",
    ],
  },

  vault: {
    group: "Custody, on this machine",
    summary: "Your vault: factors, keys, backup, restore, transfer, promote",
    description:
      "Self-custody on this machine. vault.enc holds one data key wrapped once per factor, one encrypted blob per private key, and a 24-word root every derived key comes from. No API, relay or server ever sees a vault key.",
    usage: ["candle vault <subcommand> [flags]"],
    rows: [
      {
        invocation: "init [--own-passphrase]",
        description: "Create the vault: one passphrase factor and an HD root",
      },
      { invocation: "status [--unlock]", description: "What the vault holds, and what opens it" },
      {
        invocation: "new-key --chain solana [--label <name>] [--count <n>] [--labels-from <file>]",
        description: "Derive the next Solana key, or n of them under one unlock",
      },
      { invocation: "phrase show", description: "Show the 24-word recovery phrase (terminal only)" },
      {
        invocation:
          "restore --phrase [--own-passphrase] [--count <n>] [--tee-count <k>] [--external-count <e>] [--rpc-url <url>]",
        description: "Rebuild a vault from the recovery phrase; it gets a new passphrase",
      },
      {
        invocation: "reconcile-exposure",
        description: "Re-read this account and add exposure; clears nothing",
      },
      {
        invocation: "factor list | add <kind> | remove <id>",
        description: `Manage the factors that open the vault: ${FACTOR_KINDS.join(", ")}`,
      },
      {
        invocation: "enroll <kind> [--label <name>]",
        description: `Same as factor add: ${FACTOR_KINDS.join(", ")}`,
      },
      {
        invocation: "backup --to <path>|icloud [--accept-shared-domain]",
        description: "Copy the vault and verify the copy in full; icloud is iCloud Drive",
      },
      { invocation: "verify-backup <path>", description: "Verify a copy in full (all eight steps)" },
      { invocation: "import-legacy --tee [--from <path>]", description: "Migrate tee-wallets.enc into the vault" },
      {
        invocation: "retire-legacy [--from <path>]",
        description: "Rename the Phase 1 store after a verified backup",
      },
      {
        invocation: "transfer <to> --amount <n> --asset SOL|<mint> --from <label> --rpc-url <url>",
        description: "Sign a vault-key transfer locally",
      },
      {
        invocation: "promote --from|--in-place <label> [--sweep-to <label>] [--rpc-url <url>]",
        description: "Fresh TEE key, or promote one vault key in place",
      },
      {
        invocation: "fund <tee-address|external> --amount <n> --asset SOL|USDC --rpc-url <url> [--from <label>]",
        description: "Fund a TEE or external wallet from a vault key",
      },
      {
        invocation: "demote <tee-address> --rpc-url <url> [--emergency]",
        description: "Disable then sweep a TEE wallet back to its pin",
      },
      {
        invocation: "export-key <label> --to <new-file>",
        description: "Export one key as plaintext (interactive ceremony)",
      },
    ],
    flags: [
      KEYSTORE_FLAG,
      {
        invocation: "--factor <id|kind>",
        description:
          "Unlock with this envelope: an id from factor list, or passphrase, security-key, touch-id, passkey",
      },
      { invocation: "--device <id>", description: "The security key to use when more than one is attached" },
      {
        invocation: "--labels-from <file>",
        description:
          "new-key: one name per line, one key each, one unlock (max 256). Each key is committed on its own, so a batch that is interrupted keeps every key that landed and you re-run for the rest.",
      },
    ],
    examples: [
      "candle vault init",
      "candle vault new-key --chain solana --label treasury",
      "candle vault new-key --chain solana --labels-from ./replacement-names.txt",
      "candle vault enroll security-key --label yubikey-a",
      "candle vault backup --to /Volumes/BACKUP/vault.enc",
      "candle vault backup --to icloud",
      "CANDLE_CONFIG_DIR=$HOME/t47 candle vault status",
    ],
    env: ["CANDLE_CONFIG_DIR", "CANDLE_FIDO2_HELPER", "CANDLE_ENCLAVE_HELPER", "CANDLE_KEYSTORE_PASSPHRASE"],
  },
  tee: {
    group: "Custody, on this machine",
    summary: "Dedicated TEE wallet keys for agents: seal, delegate, fund, sweep",
    description:
      "A dedicated, capped Solana wallet for one agent. The key is generated and sealed on this machine; enable delegates it to this profile's API key with a sweep vault pinned, and sweep moves everything back to that vault, signed locally.",
    usage: ["candle tee <subcommand> [flags]"],
    rows: [
      { invocation: "new [--label <name>]", description: "Seal a fresh dedicated Solana TEE wallet key locally" },
      {
        invocation: "enable <address> --vault <address>",
        description: "Delegate a TEE wallet key; pin the sweep vault (--vault-key <label> also)",
      },
      {
        invocation: "fund <address> --amount <n> [--asset SOL|USDC]",
        description: "Print the funding instruction for your vault to sign",
      },
      {
        invocation: "status <address> [--rpc-url <url>]",
        description: "Server lifecycle state and on-chain balances",
      },
      {
        invocation: "disable <address>",
        description: 'Stop the agent; verified stop or pending, never "done" on a 200',
      },
      {
        invocation: "sweep <address> --rpc-url <url> [--emergency]",
        description: "Sign locally and move everything to the pinned vault",
      },
    ],
    flags: [KEYSTORE_FLAG],
    examples: [
      "candle tee new --label AgentOne",
      "candle tee status AgentOneAddress",
      "candle tee sweep AgentOneAddress --rpc-url https://api.mainnet-beta.solana.com",
    ],
    env: ENV_LOCAL_SIGNING,
  },
  external: {
    group: "Custody, on this machine",
    summary: "External wallets for outside tools, never delegated",
    description:
      "Keys on the vault's third branch, for tools that are not Candle: never delegated to an agent, never registered with Candle. Sweep sends everything back to a named vault key, signed locally.",
    usage: ["candle external <subcommand> [flags]"],
    rows: [
      {
        invocation: "new [--label <name>]",
        description: "Derive an external wallet for outside tools (never delegated, never registered)",
      },
      { invocation: "list", description: "The external wallets in the vault" },
      {
        invocation: "sweep <external> --to <vault> --rpc-url <url>",
        description: "Send everything an external wallet holds back to a vault key",
      },
    ],
    flags: [KEYSTORE_FLAG],
    examples: [
      "candle external new --label defi-tool",
      "candle external list",
      "candle external sweep defi-tool --to treasury --rpc-url https://api.mainnet-beta.solana.com",
    ],
    env: ENV_LOCAL_SIGNING,
  },
  sign: {
    group: "Custody, on this machine",
    summary: "Sign a transaction or a message with an external wallet",
    description:
      "The generic signer: a base64 transaction any tool built, decoded and simulated over your own RPC before it is displayed and signed. External wallets only; a vault key or a TEE wallet is refused.",
    usage: ["candle sign [--file <path>] --wallet <external>... [flags]", "candle sign message --wallet <external>"],
    rows: [
      {
        invocation: "[--file <path>] --wallet <external>... [--broadcast] [--yes]",
        description: "Decode, simulate and sign a base64 transaction with an external wallet",
      },
      {
        invocation: "message --wallet <external> [--file <path>] [--yes]",
        description: "Sign an off-chain message (the exact bytes of the file or stdin)",
      },
    ],
    flags: [KEYSTORE_FLAG],
    examples: [
      "candle sign --file ./tx.b64 --wallet defi-tool",
      "candle sign message --wallet defi-tool --file ./message.txt",
    ],
    env: ENV_LOCAL_SIGNING,
  },

  secrets: {
    group: "Your own services",
    summary: "Your third-party API keys, in their own keychain namespace",
    description:
      "Your own API keys, stored in a keychain namespace separate from Candle's credentials, typed on a hidden prompt and never shown again. A plug-in receives one as CANDLE_SECRET_<NAME> only when you name it with --secret.",
    usage: ["candle secrets <subcommand> [flags]"],
    rows: [
      {
        invocation: "set <name>",
        description: "Store one of your own third-party API keys (hidden prompt, never sent to Candle)",
      },
      { invocation: "list", description: "The names of your stored secrets" },
      { invocation: "remove <name>", description: "Delete a stored secret" },
    ],
    examples: ["candle secrets set helius", "candle secrets list", "candle secrets remove helius"],
  },
  plugins: {
    group: "Your own services",
    summary: "The candle-<name> executables on your PATH",
    description:
      "Git-style plug-ins: an executable candle-<name> on your PATH runs as candle <name>, with an environment built from empty. No parent CANDLE_* variable, no Candle credential and no private key ever reaches it.",
    usage: ["candle plugins"],
    rows: [],
    examples: ["candle plugins"],
  },

  mcp: {
    group: "Maintain",
    summary: "Run the Candle MCP server with stored credentials",
    description:
      "Runs the Candle MCP server, which is built into this binary, with this CLI's stored API key and API URL in its environment. The host needs nothing else installed.",
    usage: ["candle mcp [flags]"],
    rows: [],
    flags: [
      { invocation: "--tools <a,b,c>", description: "Pin an explicit tool allowlist" },
      { invocation: "--read-only", description: "Start with no key and only the keyless read tools" },
      { invocation: "--print-config", description: "Print the MCP client config block for this install" },
    ],
    examples: ["candle mcp", "candle mcp --print-config", "candle mcp --read-only"],
    env: ENV_API,
  },
  update: {
    group: "Maintain",
    summary: "Update the CLI to the latest signed release",
    description:
      "Replaces this binary with the latest signed release. The download is renamed over the running binary only after its checksum matches and its Sigstore bundle verifies in process against that exact version's release workflow.",
    usage: ["candle update [flags]"],
    rows: [],
    flags: [
      { invocation: "--check", description: "Report what is available and install nothing" },
      { invocation: "--to <tag>", description: "Pin a release (an older one installs, with a warning)" },
    ],
    examples: ["candle update", "candle update --check", "candle update --to cli-v0.11.0"],
    env: ["CANDLE_NO_UPDATE_NOTIFIER"],
  },
  verify: {
    group: "Maintain",
    summary: "Verify a release asset's Sigstore bundle",
    description:
      "Verifies a release asset against the trusted root compiled into this binary. No network, no credentials, and nothing else installed: the bundle carries the certificate and the transparency-log entry.",
    usage: ["candle verify <file> --bundle <path>"],
    rows: [],
    flags: [{ invocation: "--bundle <path>", description: "The .sigstore.json bundle beside the asset" }],
    examples: ["candle verify ./candle-darwin-arm64 --bundle ./candle-darwin-arm64.sigstore.json"],
  },
  completion: {
    group: "Maintain",
    summary: "Shell completions for zsh, bash or fish",
    description:
      "Prints a completion script for one shell to stdout. The script is generated from this help, so it offers exactly the commands, subcommands and flags the help documents, and nothing that does not route.",
    usage: ["candle completion <zsh|bash|fish>"],
    rows: [
      {
        invocation: "zsh",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh's own $fpath expansion, printed verbatim for the operator to paste
        description: 'candle completion zsh > "${fpath[1]}/_candle"',
      },
      { invocation: "bash", description: "candle completion bash > ~/.local/share/bash-completion/completions/candle" },
      { invocation: "fish", description: "candle completion fish > ~/.config/fish/completions/candle.fish" },
    ],
    examples: ["candle completion zsh", "candle completion bash", "candle completion fish"],
  },
  help: {
    group: "Maintain",
    summary: "This screen, or a command's own: candle help vault",
    description:
      "The top-level screen, or one command's own: its subcommands, the flags they share, examples, and the environment it reads. Reads no config and makes no request, so it answers on a machine with no profile selected.",
    usage: ["candle help", "candle help <command>"],
    rows: [],
    examples: ["candle help", "candle help vault", "candle help completion"],
  },
}

/** The canonical word for a displayed spelling, so `renderTopic("wallet")` finds the `wallets`
 * topic without importing `ALIASES` from `index.ts` (which imports this file). T1 pins the two
 * against each other, so a display name and an alias cannot come to disagree. */
function topicFor(word: string): Topic | undefined {
  if (Object.hasOwn(HELP, word)) return HELP[word]
  return Object.values(HELP).find((topic) => topic.display === word)
}

/** How a topic is spelled on screen: the friendlier display word when it has one. */
function displayName(canonical: string): string {
  return HELP[canonical]?.display ?? canonical
}

/**
 * The subcommand words a topic documents: the plain-word first token of every row that STARTS a
 * row. An indented invocation (`keys wallets set`, a second word under a subcommand) is not a row
 * start and is skipped -- the same rule every row-start scan applies, so the drift test, the
 * completion generator and the renderer all agree on what a row is.
 */
export function documentedSubcommands(topic: Topic): string[] {
  const words: string[] = []
  for (const row of topic.rows) {
    if (row.invocation.startsWith(" ")) continue
    const first = row.invocation.split(" ")[0]
    if (first !== undefined && /^[a-z][a-z-]*$/.test(first)) words.push(first)
  }
  return words
}

/** Every flag a topic documents, from its rows and its shared-flag block: the long forms, plus
 * `-k` where a row spells it out. Read from the same rows the help prints, so a completion offers
 * exactly what the help documents and nothing else (D7). */
export function documentedFlags(topic: Topic): string[] {
  const flags = new Set<string>()
  for (const row of [...topic.rows, ...(topic.flags ?? [])]) {
    for (const match of row.invocation.matchAll(/--[a-z][a-z-]*/g)) flags.add(match[0])
    if (/(^|[\s,])-k([\s,]|$)/.test(row.invocation)) flags.add("-k")
  }
  return [...flags].sort()
}

const WIDTH = 118

/** Wraps `text` to `width`, never breaking a word. One line in, one or more lines out. */
function wrap(text: string, width: number): string[] {
  if (text === "") return [""]
  if (width < 20) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line === "") line = word
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== "") lines.push(line)
  return lines
}

/**
 * Renders a block of rows at a shared description column.
 *
 * An invocation too long for the column keeps its own line and the description starts on the next
 * one, indented to the column. That is deliberate: hand-wrapping an invocation would put a second
 * line where a row start belongs, and every drift test reads a row start as `/^ {2}(\S+)/`. A
 * continuation line here begins with the column's spaces, so it can never be mistaken for one.
 */
function renderRows(rows: Row[], maxColumn: number): string[] {
  if (rows.length === 0) return []
  const longest = Math.max(...rows.map((row) => row.invocation.length))
  const column = Math.min(2 + longest + 2, maxColumn)
  const pad = " ".repeat(column)
  const out: string[] = []
  for (const row of rows) {
    const [first = "", ...rest] = wrap(row.description, WIDTH - column)
    if (2 + row.invocation.length + 2 <= column) out.push(`  ${row.invocation.padEnd(column - 2)}${first}`)
    else out.push(`  ${row.invocation}`, `${pad}${first}`)
    for (const line of rest) out.push(`${pad}${line}`)
  }
  return out
}

/** The environment block, rendered from names looked up in `ENVIRONMENT` so a description is
 * written once (D2). An unknown name is skipped rather than printed empty; T8 is what stops one
 * from being introduced. */
function renderEnv(names: readonly string[]): string[] {
  const vars = names
    .map((name) => ENVIRONMENT.find((entry) => entry.name === name))
    .filter((entry): entry is EnvVar => entry !== undefined)
  return renderRows(
    vars.map((entry) => ({ invocation: entry.name, description: entry.description })),
    32,
  )
}

/**
 * The top level: `candle`, `candle --help`, `candle -h`, `candle help`. Command WORDS only, in six
 * groups, then the global flags, the environment and the plug-in line. Subcommand rows and flags
 * live on the topic screens (`candle help <command>`).
 */
export function renderTopLevel(): string {
  const out: string[] = [
    "candle: Candle from the terminal: trade, launch, and hold your keys on your own machine",
    "",
    "Usage: candle <command> [<subcommand>] [flags]",
    "       candle help <command>                a command's subcommands, flags and examples",
  ]
  const entries = Object.entries(HELP)
  const longest = Math.max(...entries.map(([word]) => displayName(word).length))
  const column = 2 + longest + 2
  for (const group of GROUPS) {
    out.push("", group)
    for (const [word, topic] of entries) {
      if (topic.group !== group) continue
      out.push(`  ${displayName(word).padEnd(column - 2)}${topic.summary}`)
    }
  }
  out.push("", "Global flags", ...renderRows(GLOBAL_FLAGS, 28))
  out.push("", "Environment", ...renderEnv(ENVIRONMENT.map((entry) => entry.name)))
  out.push("", "Plug-ins", ...renderRows([PLUGIN_LINE], 26))
  return `${out.join("\n")}\n`
}

/**
 * One command word's screen. Takes the canonical word or its displayed spelling, so
 * `candle wallet --help` and `candle help wallet` land on the same screen as `wallets`.
 * `undefined` for a word that is not a command, which is what lets the caller fall back to the top
 * level and print `Unknown command: <word>` first.
 */
export function renderTopic(word: string): string | undefined {
  const topic = topicFor(word)
  if (!topic) return undefined
  const canonical = Object.keys(HELP).find((key) => HELP[key] === topic) ?? word
  const display = displayName(canonical)
  const out: string[] = [wrap(`candle ${display}: ${topic.description}`, WIDTH).join("\n")]
  out.push("", `Usage: ${topic.usage.join("\n       ")}`)
  if (topic.rows.length > 0) out.push("", ...renderRows(topic.rows, 58))
  if (topic.flags && topic.flags.length > 0) {
    out.push("", `Flags every ${display} subcommand takes`, ...renderRows(topic.flags, 28))
  }
  out.push("", "Examples", ...topic.examples.map((example) => `  ${example}`))
  if (topic.env && topic.env.length > 0) out.push("", "Environment", ...renderEnv(topic.env))
  return `${out.join("\n")}\n`
}
