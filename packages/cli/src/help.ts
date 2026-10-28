/**
 * The help DATA and its two renderers, and nothing else (BE-238, spec 0.11.1 D1/D2).
 *
 * `index.ts` used to carry one 88-line `HELP_TEXT` block listing every command, every subcommand
 * and every flag inline: the first thing anyone sees, and the least designed surface in the
 * product. It is now two levels. `renderTopLevel` prints command WORDS only, grouped, with the
 * global flags, the ENVIRONMENT section and the plug-in line. `renderTopic` prints one screen per
 * command word: a short intro, usage, subcommands, shared flags and examples. `--more` includes
 * the full rules and row descriptions locally; environment descriptions live only at top level.
 *
 * This file imports nothing from `index.ts` -- that would be a cycle, since `index.ts` imports the
 * renderers -- so it cannot check itself against dispatch. `index.test.ts` does: T1 pins
 * `Object.keys(HELP)` against `ROUTED_COMMANDS` in BOTH directions, which closes the gap the old
 * drift test's own comment admitted (a command routed but documented nowhere passed it), and T2
 * pins each topic's rows against `ROUTED_SUBCOMMANDS`. `commands/completion.ts` reads this file
 * and nothing else, so a completion script cannot offer a command that does not route.
 *
 * A row's `invocation` is stored on one line. The renderer wraps it with continuation indentation
 * that cannot look like a row start to the drift tests (`/^ {2}(\S+)/`).
 */

import { LAUNCH_DEFINITION } from "./launch-definition"
import { LAUNCH_USAGE, launchFlagRows } from "./launch-options"
import { accent, brandHeader, type TerminalStyle, wrapText } from "./presentation"

/** One documented invocation: a subcommand row, a flag row, or a global flag. */
export interface Row {
  /** A single line, never pre-wrapped. For a subcommand row it starts with the subcommand word. */
  invocation: string
  description: string
  /** Additional rules supplied by the shared launch definition. */
  more?: string
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
  /** Optional shorter form of `summary` for the topic screen, so the intro and its More line fit
   * three lines at 40 columns. */
  intro?: string
  /** Full rules, available locally with help <topic> --more. */
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
  { name: "CANDLE_PLAIN", description: "Set to 1 for --plain output" },
  {
    name: "CANDLE_CONFIG_DIR",
    description:
      "Where vault.enc, tee-wallets.enc, credentials and config live (default ~/.config/candle). Set it once instead of passing --keystore.",
  },
  { name: "CANDLE_PROFILE", description: "The profile to act as, when --profile is not given" },
  { name: "CANDLE_API_URL", description: "API base URL, when --api-url is not given" },
  {
    name: "CANDLE_X402_NETWORK",
    description: "The network per-use x402 payments are made on: mainnet (default) or devnet, for tests",
  },
  {
    name: "CANDLE_X402_PAY_TO",
    description: "Devnet tests only: the address devnet x402 payments go to (mainnet pays its pinned address)",
  },
  { name: "CANDLE_API_KEY", description: "An agent API key; beats the stored one" },
  { name: "CANDLE_DEVICE_TOKEN", description: "A device token, for key-management commands" },
  {
    name: "CANDLE_KEYRING_PASSPHRASE",
    description: "Unlocks the encrypted-file backend where no OS keychain exists",
  },
  {
    name: "CANDLE_SOLANA_RPC_URL",
    description:
      "Solana RPC endpoint, when --rpc-url is not given. Beats the profile's (candle profile set <name> --rpc-url); the public endpoint when none is set",
  },
  {
    name: "CANDLE_EVM_RPC_URL",
    description:
      "EVM RPC endpoint for an EVM vault key, when --rpc-url (transfer) or --evm-rpc-url (list) is not given; without it the built-in Hood RPC is used",
  },
  {
    name: "CANDLE_FIDO2_HELPER",
    description: "Path to the candle-fido2 helper, when it is not beside the binary",
  },
  {
    name: "CANDLE_ENCLAVE_HELPER",
    description: "Path to the signed candle-enclave.app helper (macOS)",
  },
  {
    name: "CANDLE_HYPERLIQUID_BUILDER",
    description:
      "candle perps: deliberately replace this release's builder trust anchor with a nonzero EVM address; shown in the preview. Unset uses the release pin, never the API's builder",
  },
  { name: "CANDLE_HYPERLIQUID_NETWORK", description: "candle perps: set to testnet to trade Hyperliquid testnet" },
  {
    name: "CANDLE_PERPS_WITHDRAW_PINS",
    description:
      "candle perps withdraw: JSON {token, destinationDex, depositories, amountForm} pinning what every withdrawal is checked against before it is signed; replaces the pins this release ships (Relay's recorded depository and quote shape)",
  },
  { name: "CANDLE_NO_UPDATE_NOTIFIER", description: "Set to 1 to silence the update notice" },
  {
    name: "CANDLE_KEYSTORE_PASSPHRASE",
    description: "Refused: no command reads it; vault and tee commands stop while it is set",
  },
  {
    name: "CANDLE_CORE_TOKEN",
    description: "A harness token for candle core mcp, when --token is not given; minted in the Candle TUI",
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
  { invocation: "--plain", description: "Plain ASCII: no banner, boxes, color or animation" },
  { invocation: "--no-color", description: "Suppress color and decorative animation; keep terminal layout" },
  { invocation: "--full", description: "Print ids in full where a table would shorten them" },
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
      "Device authorization: the API host is printed, a code is printed, an approval URL is opened or printed, and the device token and API key it returns are stored in this machine's keychain. Nothing here is ever written to a plaintext dotfile. A new profile needs --api-url or a prompt; it does not inherit another profile's host or the production default. --embedded-wallet defaults to deny, the same as keys create; allow is confirmed at a terminal. transfer:bound is refused on a device login and is granted afterwards with keys access <prefix> --access withdraw.",
    usage: ["candle auth <subcommand> [flags]"],
    rows: [
      {
        invocation:
          "login [--api-url <url>] [--scopes <a,b,c>] [--label <name>] [--embedded-wallet deny|allow] [--no-browser] [--profile <name>]",
        description: "Authorize this device and mint its API key; --label names both",
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
    intro: "Diagnose setup: credentials, storage, API, key helper",
    summary: "Diagnose CLI setup: credentials, storage backend, API reachability, security key helper",
    description:
      "One PASS/FAIL/SKIP table over the runtime, the storage backend, both credentials, API reachability, wallet delegation, the install method, the account's plan and its trade fee, and whether the security key helper (candle-fido2) is beside the binary. Its output is meant to be pasted into a bug report. Exits nonzero on any FAIL.",
    usage: ["candle doctor [--role owner|bot|auto]"],
    rows: [],
    examples: ["candle doctor", "candle doctor --json"],
    env: ENV_API,
  },

  swap: {
    group: "Trade",
    intro: "Quote, swap and bridge on Solana or Hood; read an operation",
    summary: "Quote, confirm and swap on Solana or Hood, bridge between them; read an operation by id",
    description:
      "Swaps run through a TEE wallet's bound key: the quote is shown and confirmed before anything is sent. The first buy after a launch is this command, unless the launch carried it with candle launch --buy. The assets decide the chain (ETH, USDG or a 0x token is Hood; SOL, USDC, CNDL or a mint is Solana) and a named wallet must be on it. A Hood TEE wallet signs one leg at a time: approve, Permit2, trade, then the fee, each only after the one before it landed. SOL or USDC to ETH or USDG, or back, is a bridge through Relay from a TEE wallet into this key's own TEE wallet on the other chain (--to names it when there are several); Candle charges no fee, only configured raw caps and USD limits apply (unset means unlimited, zero still binds), and this machine checks Relay's deposit before it is signed. The bridge prints its deposit and returns while Relay fills; --wait follows it for up to ten minutes. While it is open, a sweep of either wallet refuses BRIDGE_IN_FLIGHT for two hours. Vault to vault: fund the Solana TEE wallet from the vault, bridge, then disable and sweep the Hood TEE wallet into its vault. Every plan can trade Candle-launched tokens and base assets, and sell a token it holds that was not launched on Candle; buying such a token needs Pro or Max (TIER_REQUIRED otherwise). Each trade pays the plan's agent fee on top; a base-pair swap or a bridge between this key's own wallets pays none. candle plans shows the fees in force.",
    usage: ["candle swap <from> <to> [flags]", "candle swap status <id>"],
    rows: [
      {
        invocation: "<from> <to> --amount <n>|--percent <n> --wallet <tee> [--to <tee>] [--wait]",
        description: "Quote, confirm and swap on Solana or Hood, or bridge between them",
      },
      {
        invocation: "status <id> [--kind trade|swap|launch] [--wait]",
        description: "Read an operation without resending it; --wait follows a bridge until it ends",
      },
    ],
    examples: [
      "candle swap SOL USDC --amount 0.5 --wallet AgentOne",
      "candle swap USDC SOL --percent 100 --wallet AgentOne",
      "candle swap ETH USDG --amount 0.05 --wallet HoodOne",
      "candle swap 0xTokenAddress ETH --percent 100 --wallet HoodOne",
      "candle swap status op_123 --kind swap",
      "candle vault fund AgentOneAddress --amount 1 --asset SOL   # vault to vault: fund the Solana TEE wallet",
      "candle swap SOL ETH --amount 1 --wallet AgentOne   # bridge into this key's Hood TEE wallet",
      "candle swap status op_123 --wait",
      "candle tee disable 0xHoodOneAddress   # then: candle tee sweep 0xHoodOneAddress",
    ],
    env: ENV_API,
  },
  stake: {
    group: "Trade",
    intro: "Stake CNDL, withdraw, claim Solana staking rewards",
    summary: "Stake CNDL, start and finish withdrawals, claim Solana staking rewards",
    description:
      "Solana only. MOVES REAL FUNDS from the embedded wallet (default) or a named TEE wallet whose relay signer is on this machine. add takes decimal CNDL; remove takes decimal sCNDL. No instant unstake: finish waits for the pool's withdrawalTimelockSeconds, shown by candle stake. Solana rewards accrue to the holding wallet; sCNDL in any eligible account wallet counts toward Pro and earns the account's Hood reward, except a wallet another account also claims, wallets past the 200-wallet cap, and an account with no EVM wallet. Pending withdrawals count toward nothing for Pro. Writes require swap:write and an enabled agent staking rail. Reuse --client-stake-id on retry: a rerun posts the saved signed transaction to submit again without re-signing. The server reads the chain for that signature first, so it lands once. The signed transaction is kept in the CLI operations directory for that retry. Ordinary linked wallets use SDK builds and external signing.",
    usage: [
      "candle stake [--wallet <wallet>]",
      "candle stake add <amount>",
      "candle stake remove <amount>",
      "candle stake finish [<withdrawal>]",
      "candle stake claim <rewardId> | --all",
    ],
    rows: [
      { invocation: "add <amount>", description: "Stake decimal CNDL in the selected wallet" },
      { invocation: "remove <amount>", description: "Start a withdrawal of decimal sCNDL" },
      {
        invocation: "finish [<withdrawal>]",
        description: "Finish a matured withdrawal; omit only when exactly one is ready in the selected wallet",
      },
      {
        invocation: "claim <rewardId> | --all",
        description: "Claim one reward or all listed unclaimed rewards, including unresolved claims",
      },
    ],
    flags: [
      { invocation: "--wallet <wallet>", description: "main (embedded), or a wallet id, address or label" },
      {
        invocation: "--client-stake-id <id>",
        description: "Stable operation id, up to 128 characters; reuse on retry",
      },
      { invocation: "--yes", description: "Approve the displayed wallet, amounts and costs without a prompt" },
      { invocation: "--all", description: "claim only: claim every listed reward for the selected wallets" },
    ],
    examples: [
      "candle stake --json",
      "candle stake add 100 --wallet main --client-stake-id stake-1 --yes",
      "candle stake remove 100 --wallet tee",
      "candle stake finish",
      "candle stake claim --all --yes",
    ],
    env: ["CANDLE_API_KEY", "CANDLE_API_URL", "CANDLE_CONFIG_DIR"],
  },
  lp: {
    group: "Trade",
    intro: "Meteora DAMM v2 liquidity from a TEE wallet",
    summary: "Meteora DAMM v2 liquidity from a TEE wallet: pools, add, positions, remove, claim",
    description:
      "Provide liquidity on any Meteora DAMM v2 pool from a TEE wallet, through its bound key (scope lp:write, opt-in). Every write is quoted, shown with the pool's Token-2022 warnings, confirmed, signed by Candle's relay and broadcast over your RPC; no Candle fee. Only configured raw caps and USD limits apply to deposits; unset means unlimited and zero still binds. A sweep closes open positions itself (tee sweep).",
    usage: ["candle lp <subcommand> [flags]"],
    rows: [
      {
        invocation: "pools <token> [--page <n>]",
        description: "Pools listing a token: liquidity, fee, 24h volume, estimated yield",
      },
      {
        invocation: "add <pool> --amount <n> <token> --wallet <tee> [--position <nft>]",
        description: "Open a position, or add to one; the other side follows the pool's ratio",
      },
      { invocation: "positions [--wallet <tee>]", description: "Every position across your TEE wallets" },
      {
        invocation: "remove <position> --percent <n> [--wallet <tee>]",
        description: "Withdraw; at 100% also claims fees and closes the position",
      },
      { invocation: "claim <position> [--wallet <tee>]", description: "Claim fees and any rewards" },
    ],
    flags: [
      { invocation: "--wallet <tee>", description: "The TEE wallet by id, address or unique label" },
      { invocation: "--rpc-url <url>", description: "Your own Solana RPC (optional; see candle help profile)" },
      {
        invocation: "--client-trade-id <id>",
        description: "Idempotency: the same id never deposits or withdraws twice",
      },
      { invocation: "--slippage-bps <n>", description: "add and remove: the tolerance, 0 to 1000 (default 100)" },
      { invocation: "--yes", description: "Skip the confirmation prompt (an ordinary prompt only)" },
    ],
    examples: [
      "candle lp pools So11111111111111111111111111111111111111112",
      "candle lp add <pool> --amount 0.5 SOL --wallet AgentOne",
      "candle lp positions",
      "candle lp remove <position> --percent 100 --wallet AgentOne",
    ],
    env: ENV_API,
  },
  // BE-1748: candle-hl-design.md §5.1 (verbatim on BE-1575) scopes PnL to --profile.
  // Spec A's non-goals leave pnl unrealized/transfers for a later card; do not promise them here.
  perps: {
    group: "Trade",
    intro: "Trade Hyperliquid perps from this key's EVM TEE wallet",
    summary: "Trade Hyperliquid perpetuals from this key's EVM TEE wallet",
    description:
      "markets, market, book and candles read directly from Hyperliquid with any Candle agent key and no signer or wallet. Candle supplies only the OI gate config; its build gate is not an execution promise. Trade perpetuals on Hyperliquid's main perp exchange from the EVM TEE wallet bound to this key (scope perps:write, opt-in). A key gets an EVM TEE wallet by promoting one from the vault: candle vault new-key --chain evm, then candle vault promote --from <cold> --to-key <prefix>, and candle tee signer new --key <prefix> on the machine that trades it; candle tee new is Solana only. Candle builds each action within the key's limits; this machine recomputes its hash and checks the action type and Candle's builder before anything is signed, then Candle's relay signs and this machine submits to Hyperliquid. Every plan is eligible for perps, once the deployment has perps enabled. Every plan except Max pays Candle a builder fee on each order (0.1% today); Max pays none. candle plans shows the rate in force. Deposits move SOL, USDC, ETH or USDG onto the Hyperliquid account through Relay; withdrawals move USDC back through Relay to the key's own Solana or Hood TEE wallet (scope perps:withdraw, opt-in, after one vault unlock and a typed confirm). candle pnl --profile <name> shows the profile's Hyperliquid P&L under its own heading, over every EVM TEE wallet bound to the profile: realized, funding, fees, unrealized and the net, which is also counted in the profile's Total. Live positions and risk are shown by candle perps positions and candle portfolio. Account-wide candle pnl and its By agent table cover ledger trades only; a key with only perps activity has no row there. account, positions, risk and watch read Hyperliquid's public API directly from this machine and sign nothing: risk and watch exit 0 (ok), 10 (warn) or 11 (critical), and 1 with a PERPS_* code when no level could be read (unknown), so a script never mistakes \"could not tell\" for ok. A position is warn under its key's warn distance from liquidation (default 15%) or when the cross margin ratio is above the warn ratio (default 0.6); critical under 7% or above 0.8; a position with no Hyperliquid mark is at least warn. risk is one stateless read; watch adds hysteresis (a level clears only past its threshold by the clear band, default 2 points). One watcher at the default 10 s interval spends about 136 of the 1,200 request weight per minute Hyperliquid allows per IP. Funding paid since open is Hyperliquid's sign: positive is paid. Until Candle's server-side monitor exists, nothing warns you unless you poll candle perps risk or run candle perps watch. Candle's server may also watch this wallet; GET /perps/risk reports whether it does. modify, margin, tpsl, schedule-cancel, flatten and close --pct are built, checked against this machine's own read of Hyperliquid, signed and submitted like every other write; tpsl and flatten are plans of several such steps, confirmed once (or --yes), and a plan that does not finish says so and exits 1 (3 when a signed step's submit did not answer). A key that is reduce-only (reduce-only on) can close, cancel, protect, schedule a cancel and add isolated margin, and nothing that opens or grows exposure; only the owner's device token turns it off, and it cancels no resting order and revokes no signed action.",
    usage: ["candle perps <subcommand> [flags]"],
    rows: [
      {
        invocation: "markets [--sort <volume|oi|funding|change|name>] [--limit <n>] [--all]",
        description: "List live main-perp markets directly from Hyperliquid; any Candle agent key required",
      },
      { invocation: "market <coin>", description: "Market detail, margin tiers, impact prices and precision rules" },
      {
        invocation: "book <coin> [--depth <1-20>] [--sig-figs <2-5>]",
        description: "Live order book, spread and mid, directly from Hyperliquid",
      },
      {
        invocation: "candles <coin> [--interval <i>] [--count <1-5000>] [--end <time>]",
        description: "OHLCV candles (default 1h, 100); oldest first, directly from Hyperliquid",
      },
      {
        invocation: "deposit <amount> <SOL|USDC|ETH|USDG> [--wallet <tee>] [--to <evm tee>] | deposit status <id>",
        description:
          "Move funds onto the Hyperliquid account through Relay, from the key's Solana or Hood TEE wallet (swap:write); only configured raw caps and USD limits apply (unset means unlimited, zero still binds); --no-submit is a dry run that holds no wallet and uses no limit; status reads one",
      },
      {
        invocation: "setup [--wallet <tee>]",
        description:
          "After the first deposit has landed, approve Candle's builder fee once; shows the account's mode and balance. Refused, with nothing signed, while the account has never received a deposit or unless Hyperliquid shows it in standard mode",
      },
      {
        invocation: "open <coin> <long|short> <size> [--price <px>]",
        description: "Market (IOC) without --price, limit with it; optional --tp and --sl",
      },
      {
        invocation: "close <coin> [--size <n> | --pct <1-100>]",
        description:
          "Reduce-only IOC close of all or part of a position; --pct closes a percentage (at most 4 decimals), rounded down to the market's size step, and a result of zero is refused, never rounded up",
      },
      { invocation: "cancel <cloid>", description: "Cancel an order Candle built, by its cloid" },
      {
        invocation: "modify --cloid <cloid> [--price <px>] [--size <n>]",
        description:
          "Change a resting order Candle built; side, time in force and reduce-only are kept from Hyperliquid's record. A trigger leg is not modified (use tpsl)",
      },
      {
        invocation: "margin <coin> --amount <usd> | --mode cross|isolated [--leverage <n>]",
        description:
          "Add isolated margin (positive only), or set the coin's margin mode keeping its leverage unless --leverage names one; a mode change needs no position and no resting order in the coin",
      },
      {
        invocation:
          "tpsl <coin> [--take-profit <px>] [--stop-loss <px>] [--remove-tp] [--remove-sl] [--target-tp <cloid>] [--target-sl <cloid>]",
        description:
          "Attach, change or remove position take-profit / stop-loss legs, sized to the position now. A change cancels the old leg first (a protection gap). Legs Candle did not build are listed and left alone",
      },
      {
        invocation: "schedule-cancel <seconds> | schedule-cancel --clear",
        description:
          "Set (at least 5 s ahead) or clear Hyperliquid's cancel-all timer. Wallet-wide: it cancels every open order, protection included, not positions; 10 triggers per UTC day, not counted by Candle",
      },
      {
        invocation: "flatten [--wallet <tee>]",
        description:
          "Cancel every open main-perp order, then close every main-perp position, then read again; at most 100 signed steps a run. Spot, HIP-3 and vaults are not reached",
      },
      {
        invocation: "reduce-only [on|off] [--key <self|prefix|label>]",
        description:
          "Read or set the key's reduce-only restriction. This key may turn itself on; off, or another key, needs the owner's device token. Limits new Candle builds only",
      },
      {
        invocation: "orders [--wallet <tee>]",
        description: "Open orders on Hyperliquid, and every action Candle built",
      },
      {
        invocation: "withdraw <amount> --to solana|hood [--wallet <evm tee>] | withdraw status <id>",
        description:
          "Move USDC from the Hyperliquid account to this key's own Solana or Hood TEE wallet through Relay (perps:withdraw); at least 10 USDC, with Relay's fees at most 5% (Hyperliquid's one-time 1 USDC activation fee on a first withdrawal not counted); one vault unlock and a typed confirm, no --yes",
      },
      {
        invocation: "positions [--wallet <tee>]",
        description: "Positions, account value and withdrawable USDC, read live, and any withdrawal in flight",
      },
      {
        invocation: "fills [--start-time <ms>] [--end-time <ms>] [--limit <n>] [--cursor <c>]",
        description:
          "One page of the wallet's fills, read directly from Hyperliquid (any read-capable key; no signer). Default: the last 7 days, 100 rows. Closed P&L is gross and the fee already includes the builder fee. Hyperliquid keeps only the 10,000 most recent fills",
      },
      {
        invocation: "funding [--start-time <ms>] [--end-time <ms>] [--limit <n>] [--cursor <c>]",
        description:
          "One page of the wallet's funding payments, signed (paid or received), read directly from Hyperliquid; at most 500 rows a page",
      },
      { invocation: "leverage <coin> <x> [--isolated]", description: "Set a market's leverage and margin mode" },
      {
        invocation: "account [--wallet <tee>] [--since <30m|24h|7d|ISO>]",
        description:
          "Account value, margin used, free margin, withdrawable, margin ratio, and realized P&L, fees and funding over a window (default 24h, at most 30 days)",
      },
      {
        invocation: "risk [--wallet <tee>]",
        description: "The level now (ok, warn, critical) with what drives it; exit 0, 10 or 11, and 1 when unknown",
      },
      {
        invocation:
          "watch [--interval <s>] [--heartbeat <s>] [--on-warn <cmd>] [--on-critical <cmd>] [--once-level-change]",
        description:
          "Poll from this machine and print one JSON line per level change, heartbeat or error; runs until stopped and exits with the last level's code",
      },
      {
        invocation:
          "thresholds | thresholds set [--warn-distance <pct>] ... [--key <prefix|label|self>] | thresholds clear",
        description:
          "Show this key's risk thresholds; set or clear them. As self (the default) a key may only tighten; a prefix or label uses the device token and may loosen",
      },
    ],
    flags: [
      {
        invocation: "--sort <volume|oi|funding|change|name>",
        description: "markets: descending metric, ascending name (default volume)",
      },
      {
        invocation: "--limit <n>",
        description:
          "markets: maximum rows, 1 to 500 (default all tradeable markets); orders: rows (default 50); fills and funding: rows per page (default 100)",
      },
      {
        invocation: "--all",
        description: "markets: include refused markets and reasons; OI caps can still refuse an order",
      },
      { invocation: "--depth <1-20>", description: "book: levels per side (default 20)" },
      { invocation: "--sig-figs <2-5>", description: "book: Hyperliquid price aggregation" },
      {
        invocation: "--interval <i>",
        description: "candles: 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M (default 1h)",
      },
      {
        invocation: "--count <1-5000>",
        description: "candles: newest count (default 100); 1M window uses 31 days per step",
      },
      { invocation: "--end <time>", description: "candles: ISO 8601 or epoch milliseconds, no later than now" },
      {
        invocation: "--wallet <tee>",
        description:
          "The EVM TEE wallet by id, address or unique label (default: the only one); for deposit, the paying TEE wallet",
      },
      { invocation: "--tif <Gtc|Alo|Ioc>", description: "open with --price: time in force (default Gtc)" },
      {
        invocation: "--slippage-bps <n>",
        description: "open at market and close: the bound against the mid; deposit: Relay's slippage (default 100)",
      },
      { invocation: "--tp <px> / --sl <px>", description: "open: reduce-only take-profit and stop-loss triggers" },
      {
        invocation: "--client-id <0x+32 hex>",
        description:
          "open and close: your own order id. Retrying the same command with the same id returns the original order instead of placing another, and signs nothing; the same id with a different order is refused. It deduplicates, it does not resume a build you stopped with --no-submit. Use a new id for a new order",
      },
      {
        invocation: "--start-time <ms> / --end-time <ms>",
        description: "fills and funding: the window in epoch milliseconds (default: the 7 days before now)",
      },
      {
        invocation: "--cursor <c>",
        description: "fills and funding: the next page, as the previous page printed it; the window must not change",
      },
      {
        invocation: "--to <evm tee>",
        description: "deposit from Solana: the EVM TEE wallet whose account receives it",
      },
      { invocation: "--id <id>", description: "deposit and withdraw: the idempotency id (default: a new one)" },
      { invocation: "--keystore <path>", description: "withdraw: the vault whose unlock confirms the withdrawal" },
      { invocation: "--rpc-url <url>", description: "deposit from Solana: the RPC the deposit check reads" },
      { invocation: "--no-submit", description: "Build and check only; sign and submit nothing" },
      { invocation: "--sign-only", description: "Build, check and sign through the relay; submit nothing" },
      { invocation: "--yes", description: "Skip the confirmation prompt" },
      { invocation: "--since <window>", description: "account: the recent window, 30m, 24h, 7d or an ISO time" },
      {
        invocation: "--interval <seconds>",
        description: "watch: seconds between polls, 5 to 300 (default 10, about 136 request weight a minute)",
      },
      { invocation: "--heartbeat <seconds>", description: "watch: a heartbeat line this often (default 60, 0 is off)" },
      {
        invocation: "--on-warn <command> / --on-critical <command>",
        description:
          "watch: run through your shell once per rise to warn (or critical) or critical, with the level line on stdin and CANDLE_PERPS_RISK_LEVEL set; killed after 30 s",
      },
      { invocation: "--once-level-change", description: "watch: exit at the first level change, with its code" },
      {
        invocation: "--warn-distance <pct> / --critical-distance <pct>",
        description: "thresholds set: liquidation distance thresholds in percent (default 15 and 7)",
      },
      {
        invocation: "--warn-margin-ratio <r> / --critical-margin-ratio <r>",
        description: "thresholds set: cross margin ratio thresholds, 1 is liquidation (default 0.6 and 0.8)",
      },
      { invocation: "--clear-band <pct>", description: "thresholds set: watch's clear band in points (default 2)" },
      {
        invocation: "--key <prefix|label|self>",
        description: "thresholds set and clear: the key (default self, which may only tighten)",
      },
    ],
    examples: [
      "candle perps deposit 25 USDC",
      "candle perps setup",
      "candle perps open BTC long 0.01",
      "candle perps open ETH short 0.5 --price 3200 --tp 2900 --sl 3400",
      "candle perps close BTC",
      "candle perps open BTC long 0.01 --client-id 0x0123456789abcdef0123456789abcdef",
      "candle perps fills --limit 50",
      "candle perps funding --start-time 1790000000000",
      "candle perps leverage BTC 5 --isolated",
      "candle perps close BTC --pct 25",
      "candle perps tpsl BTC --take-profit 66000 --stop-loss 57000",
      "candle perps schedule-cancel 300",
      "candle perps flatten",
      "candle perps reduce-only on",
      "candle perps withdraw 25 --to solana",
      "candle perps risk --json",
      "candle perps watch --on-critical 'notify-send perps critical'",
      "candle perps thresholds set --warn-distance 20",
    ],
    env: [...ENV_API, "CANDLE_HYPERLIQUID_BUILDER", "CANDLE_HYPERLIQUID_NETWORK", "CANDLE_PERPS_WITHDRAW_PINS"],
  },
  transfer: {
    group: "Trade",
    intro: "Move funds out of a TEE wallet to your wallets or its vault",
    summary: "Move funds out of a TEE wallet to your own wallets or its vault, through its bound key",
    description:
      "Moves one asset out of a TEE wallet this machine can sign for. The bound key must be a Withdraw key (transfer:bound); from that wallet, Candle allows only its own pinned vault or another of the account's wallets you linked while signed in or marked trusted. To a linked wallet only configured raw caps and USD limits apply (unset means unlimited, zero still binds), and the asset must be a base asset; to the vault any token and max are allowed. Candle builds the transaction, this machine approves the relay, Privy signs, Candle broadcasts. The destination and its kind are shown before you confirm. The asset decides the chain: ETH, USDG or --token is Hood, from a Hood TEE wallet, where this machine checks the one leg moves exactly what you confirmed before it is signed, and ETH max leaves the gas reserve.",
    usage: [
      "candle transfer --to <address|wallet name|vault> --asset <SOL|USDC|CNDL|ETH|USDG>|--mint <mint>|--token <0x...> --amount <decimal|max> [--wallet <tee>] [--yes] [--json]",
    ],
    rows: [],
    flags: [
      {
        invocation: "--to <address|wallet name|vault>",
        description: "Where the funds go: vault is the wallet's own pin",
      },
      {
        invocation: "--asset <SOL|USDC|CNDL|ETH|USDG>",
        description: "A base asset (required for a linked-wallet destination)",
      },
      { invocation: "--mint <mint>", description: "Any Solana mint, instead of --asset (vault destinations only)" },
      { invocation: "--token <0x...>", description: "Any Hood ERC-20, instead of --asset (vault destinations only)" },
      { invocation: "--amount <decimal|max>", description: "How much, or max for the whole spendable balance" },
      { invocation: "--wallet <tee>", description: "The TEE wallet the funds leave; optional with one payer" },
      {
        invocation: "--rpc-url <url>",
        description: "Your own Solana RPC, or on Hood the EVM RPC a --token's decimals are read over (optional)",
      },
      { invocation: "--yes", description: "Skip the confirmation prompt (the destination is still printed)" },
    ],
    examples: [
      "candle transfer --to vault --asset SOL --amount max --wallet AgentOne",
      "candle transfer --to treasury --asset USDC --amount 250 --wallet AgentOne --yes --json",
      "candle transfer --to vault --asset ETH --amount max --wallet HoodAgent",
    ],
    env: ENV_API,
  },

  launch: {
    group: "Trade",
    summary: "Create a token on Solana or Hood, with an optional first buy",
    description:
      "Creates a token from the wallet you name, with an optional first buy. Embedded launches use /launch/headless on every plan, with the key's embedded-wallet allowance and launch:write; no swap:write is needed. A Solana first buy is a creator bundle, signed by Candle. A Hood first buy is best effort after creation. TEE launches use /launch/self and require Pro or Max, allowLaunch, a bound key and verified authority. TEE buys need TEE_LAUNCH_BUYS_ENABLED on the server; Solana buys also need AGENT_TRADING_ENABLED and Jito. Existing server gates and ceilings apply. The embedded path previews the launch before confirmation; --dry-run stops at the preview. No buy creates only the token. Local image and banner uploads happen before confirmation and are public and permanent even if the launch is declined. Reuse --client-trade-id for recovery. --check answers first, before any of it: which launch path works on this key and server (embedded allowance, tier, allowLaunch, TEE_LAUNCH_BUYS_ENABLED) in one call, with nothing uploaded, built or sent; name a wallet with --wallet to narrow it, and it exits 1 when no path works.",
    usage: [LAUNCH_USAGE],
    rows: [],
    flags: [
      ...launchFlagRows,
      {
        invocation: "--image <path>",
        description:
          "Upload a local PNG, JPEG, GIF or WebP (at most 10MB) instead of --image-url; public and permanent before confirmation.",
      },
      {
        invocation: "--check",
        description:
          "Answer which launch path works (embedded allowance, tier, allowLaunch, TEE_LAUNCH_BUYS_ENABLED) in one call, before any image upload; nothing is sent. Exits 1 when no path works.",
      },
      { invocation: "--yes", description: "Confirm the launch without an interactive prompt." },
      {
        invocation: "--rpc-url <url>",
        description: "The Solana RPC for a TEE launch with no first buy, or the Hood RPC for receipt reads.",
      },
    ],
    examples: [
      "candle launch --check",
      "candle launch --check --wallet AgentOne",
      "candle launch --name Demo --symbol DEMO --image ./logo.png --wallet AgentOne",
      "candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet AgentOne",
      "candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet HoodAgent --dex-version v4",
      "candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet AgentOne --buy 0.1",
      "candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet embedded --buy 0.1 --dry-run",
      "candle launch --name Demo --symbol DEMO --image-url https://example.com/d.png --wallet AgentOne --mode exp-custom --curve-v 4 --curve-g 20 --creator-fee-bps 100 --dry-run",
    ],
    env: ENV_API,
  },

  image: {
    group: "Trade",
    summary: "Host an image file from this machine and print its https URL",
    description:
      "Uploads a PNG, JPEG, GIF or WebP file, at most 10MB, to Candle and prints the https URL it is hosted at, ready to be a launch's image. The type is read from the file's first bytes, not its name, and a file that is none of the four or is too large is refused before any request. The upload is a publication: Candle pins the file to public storage, the URL cannot be withdrawn, and whatever the file carries (metadata included) goes with it, so upload only an image meant to be public. It spends no funds and does not count against the daily launch cap; the key's uploads-per-minute limit applies. Needs an API key with the launch:write scope. candle launch --image <path> does this upload itself; use this command for the link alone, or to launch through the hosted connector, which cannot read a file on your machine. Without --banner Candle crops the image to a square, so it hosts a token image and not a banner: a banner sent that way comes back cropped. With --banner nothing is cropped: the image must be wider than 1.5:1 (for example 2171x724 or 1200x630) or the upload is refused with BANNER_WRONG_SHAPE, and the URL is for a launch's bannerUrl.",
    usage: ["candle image upload <path> [--banner] [--json]"],
    rows: [
      {
        invocation: "upload <path>",
        description:
          "Upload the file and print its URL; --json adds the content type and the size in bytes; --banner hosts a wide banner uncropped",
      },
    ],
    examples: [
      "candle image upload ./logo.png",
      "candle image upload /Users/me/art/logo.webp --json",
      "candle image upload ./banner.png --banner",
    ],
    env: ENV_API,
  },

  scan: {
    group: "Trade",
    summary: "The token card for one contract: market, all-time high, safety facts, tracked wallets",
    intro: "The token card for one pasted contract",
    description:
      "Prints the token card a Quant group gets when a contract is pasted, from the public card route (GET /api/v1/tokens/:chain/:mint/card): ticker, name, chain and launchpad, then price, market cap, the all-time high since launch, 5 minute change, liquidity, volume and buys and sells, the bundles, snipers, insiders, fresh-wallet and wallet-age facts, tracked wallets and signals in the last hour, the same-name token that leads, whether Candle's forensics covers it, and the Candle page. Facts only: there is no score and no verdict. A field with no source prints a dash, never a guess, and a Sources block names where each figure came from. The chain is read from the address (0x is Hood, base58 is Solana); --chain overrides it, and any other address is refused before a request. Free for every plan: needs no key and sends none. Off on a deployment until TOKEN_CARD_ENABLED is on; until then the command answers TOKEN_CARD_DISABLED.",
    usage: ["candle scan <contract address> [--chain solana|hood] [--json]"],
    rows: [],
    flags: [{ invocation: "--chain <chain>", description: "solana or hood; read from the address when omitted" }],
    examples: ["candle scan <mint>", "candle scan 0x<token> --json"],
    env: ["CANDLE_API_URL"],
  },
  portfolio: {
    group: "Account",
    intro: "Holdings, prices and value of every wallet",
    summary: "Every wallet's holdings, prices and value on Solana and Hood (vault read over your own RPCs)",
    description:
      "Vault, TEE and embedded wallets on Solana and Hood, each token with its chain, amount, price and value, then subtotals per group and per chain and one total. TEE and embedded balances, on both chains, come from Candle. Solana vault and external wallets are read over your own Solana RPC, and Candle is sent only the mints they hold, for prices. EVM vault keys are read over your own EVM RPC for ETH and USDG only (the CLI cannot list other tokens), which must be Hood's (chain id 4663); any other chain is refused. Their prices come from Candle by asset (ETH, USDG), never by address. Unpriced tokens are shown as unpriced with the reason (no-market-row, stale-mark, unusable-price, source-unavailable) and left out of the total. A wallet that could not be read in full is marked not read, the footer names its chain, and the exit is 3. Where Candle serves LP, each Solana TEE wallet's DAMM v2 positions follow the tokens (share of the pool plus unclaimed fees, valued by Candle at the same marks) and count in the total; a position whose pool could not be read is shown as not read and the total says it is partial. A bridge moves value between the chain subtotals; it is not a trade. With a filter, only the wallets whose label or address contains it are read and shown, the subtotals and total are for those wallets, and the first line says how many matched. When Candle listed only part of the account's wallets, the result stays partial even if every wallet shown was read, and no match says so. After the totals, a Hyperliquid section (live from Hyperliquid, not in the ledger, and never in the total) lists each EVM TEE wallet's Hyperliquid account value, unrealized P&L, positions and risk at the default thresholds, read from Hyperliquid's public API on this machine; a failed read there is not read and the exit is 3. --chain solana and --no-perps read nothing from Hyperliquid.",
    usage: [
      "candle portfolio [<filter>] [--chain solana|hood] [--rpc-url <url>] [--evm-rpc-url <url>] [--no-perps] [--json]",
    ],
    rows: [
      {
        invocation: "<filter>",
        description:
          "Keep the wallets whose label or address contains this text, in every group. Vault keys it leaves out are never sent to your RPC",
      },
    ],
    flags: [
      { invocation: "--chain solana|hood", description: "Show one chain, and read nothing on the other" },
      {
        invocation: "--rpc-url <url>",
        description:
          "Your Solana RPC, for the vault. Without one: CANDLE_SOLANA_RPC_URL, then the profile's, then the public endpoint",
      },
      {
        invocation: "--evm-rpc-url <url>",
        description: "Your Hood RPC, for EVM vault keys. Without one: CANDLE_EVM_RPC_URL, then the built-in Hood RPC",
      },
      {
        invocation: "--no-perps",
        description: "Skip the Hyperliquid section: send no EVM TEE address to Hyperliquid's public API",
      },
      KEYSTORE_FLAG,
    ],
    examples: [
      "candle portfolio",
      "candle portfolio --chain hood",
      "candle portfolio p-",
      "candle portfolio --rpc-url https://your-rpc.example --evm-rpc-url https://your-hood-rpc.example --json",
    ],
    env: [...ENV_API, ...ENV_LOCAL_SIGNING],
  },
  agent: {
    group: "Account",
    summary: "Read or edit this agent's public page, and post on it",
    description:
      "An acting key with profileSelfEdit allowed may edit its bio, strategy, models, links and images, and publish or delete posts on its own page. Name, slug and visibility remain owner-only. The server enforces permission, admin lock and the daily limits: 20 profile edits and 30 posts per UTC day, each shared by every key of the profile. A post is free text shown as plain text, tied to no trade or launch. --avatar-file and --banner-file publish the image and metadata on uploads.candle.tv and save the field without a later PATCH. Each image and any text PATCH consume separate profile edits and may succeed independently. candle image upload is for launch images (IPFS), not profile images.",
    usage: [
      "candle agent profile show",
      "candle agent profile set [flags]",
      "candle agent post create --text <text> [--chain <solana|hood> --mint <address>]",
      "candle agent post delete <post-id>",
      "candle agent post list [profile-id] [--limit <n>] [--cursor <cursor>]",
    ],
    rows: [
      { invocation: "profile show|set", description: "Read the displayed profile or edit allowed fields" },
      {
        invocation: "post create|delete|list",
        description: "Publish or delete a post on this agent's page; list an agent's posts (this key's own by default)",
      },
    ],
    flags: [
      { invocation: "--bio <text>", description: "Bio (280 characters, no links)" },
      { invocation: "--strategy <tag>", description: "Strategy category" },
      { invocation: "--strategy-note <text>", description: "How it trades (280 characters, no links)" },
      { invocation: "--models <comma-separated>", description: "Declared models; empty clears" },
      { invocation: "--links <JSON>", description: "Website and X; null clears" },
      { invocation: "--avatar <URL>", description: "Candle-hosted avatar" },
      { invocation: "--banner <URL>", description: "Candle-hosted banner" },
      {
        invocation: "--avatar-file <path>",
        description: "Upload and save a public avatar (PNG, JPEG, GIF or WebP, at most 10MB); exclusive with --avatar",
      },
      {
        invocation: "--banner-file <path>",
        description:
          "Upload and save a public banner, wider than 1.5:1 (BANNER_WRONG_SHAPE otherwise); same types/10MB limit, exclusive with --banner",
      },
      { invocation: "--text <text>", description: "Post text (1 to 500 characters, line breaks kept)" },
      { invocation: "--chain <solana|hood>", description: "Chain of the token the post names; with --mint" },
      { invocation: "--mint <address>", description: "A token Candle shows publicly, shown as a chip" },
      { invocation: "--limit <n>", description: "Posts per page, 1 to 50 (default 20)" },
      { invocation: "--cursor <cursor>", description: "The previous page's cursor" },
    ],
    examples: [
      "candle agent profile show --json",
      'candle agent profile set --bio "Trades 0.5 sol at a time"',
      "candle agent profile set --avatar-file avatar.png --banner-file banner.webp",
      'candle agent post create --text "Watching the curve fill"',
      "candle agent post list --json",
    ],
    env: [],
  },
  fees: {
    group: "Account",
    summary: "Creator fees your launched tokens can pay, and the claim",
    description:
      "Lists the tokens launched by this account's wallets and what each could pay now, from direct chain reads, with the reason a token cannot be claimed. `fees claim` collects one token's creator fees and pays them to the wallet fixed at launch: there is no destination option, Candle signs with the embedded wallet, and that wallet pays the network fee. The key needs launch:write to claim and account:read to list. A Phantom-signup account's Solana fees are credited to the external wallet, which Candle cannot sign for, so its agent cannot claim them.",
    usage: ["candle fees [--cursor <cursor>] [--limit <1-50>]", "candle fees claim <mint> [--dry-run]"],
    rows: [
      {
        invocation: "claim <mint> [--dry-run]",
        description: "Claim one token's creator fees; --dry-run sends nothing",
      },
    ],
    flags: [
      { invocation: "--cursor <cursor>", description: "The previous page's continue cursor" },
      { invocation: "--limit <n>", description: "Tokens per page, 1 to 50 (default 20)" },
    ],
    examples: ["candle fees", "candle fees claim <mint> --dry-run", "candle fees claim <mint>"],
    env: ENV_API,
  },
  pnl: {
    group: "Account",
    intro: "P&L per chain and combined (--profile: one key's share)",
    summary:
      "P&L per chain and combined: realized, fees, unrealized and open positions (--profile for one key's share)",
    description:
      "Without --profile, the account's books: every profile, the web app and the CLI, one ledger, the same figures the console shows, to the cent for the same moment. Needs a key with the Read scope (account:read). With --profile <name>, that profile's key reads its share of the same P&L: realized on the sales it made, and the open positions that belong to it (the wallet's bound key, else the key whose buy opened them), with a row per wallet that sums to the total. Positions live in wallets: each wallet is its own average-cost pool, the account is the sum of its wallets, and a recorded move between two of the account's wallets carries its cost and realizes nothing. Both show a Solana block, a Hood block, then the combined figure, the closed positions as money made, minus money lost, plus partial sells, and a CHAIN column (and WALLET, where the API names it) on positions. The account's books add a By agent table (each key, then Manual for web-app trades, then the account total). Unpriced positions are shown as unpriced and never valued at zero; a position worth under one cent is marked dust and still counted. A bridge between Solana and Hood is not a trade: it opens and closes nothing, and bridge and Relay costs are not netted from P&L. Where Candle serves LP, DAMM v2 positions are included: realized (withdrawals against the cost basis at the add, plus claimed fees), unrealized (open positions at their share of the pool plus unclaimed fees, against that basis), and vs holding (what the deposited tokens would be worth held); Total is the console's token figure, and Total with LP covers tokens and LP. Only --profile <name> adds a Hyperliquid section under its own heading, over every EVM TEE wallet bound to the profile, per binding period: realized gross, funding (received positive, paid negative), fees including builder fees, realized net, unrealized and the net. Facts and unrealized stop at the same cutoff per wallet; a cutoff read now is marked (live, not yet settled). The net is also counted in Total, whose line says it includes Hyperliquid; when the section cannot be read, Total is the token figure and the CLI says it excludes perps and why. Deposits and withdrawals are not P&L. Account-wide candle pnl and its By agent table cover ledger trades only; a key with only perps activity has no row there. For live perps positions and risk, use candle perps positions or candle portfolio.",
    usage: ["candle pnl [--profile <name>] [--dust] [--json]"],
    rows: [],
    examples: ["candle pnl", "candle pnl --profile scalper --json"],
    env: ENV_API,
  },
  token: {
    group: "Account",
    summary: "Token About pages, events, cluster analysis, forensics and the vamp finder",
    intro: "Token About pages, events, clusters, forensics, vamp finder",
    description:
      "about, claim, section, history and flag are the token's About page: three shared sections (thesis, tokenomics, lore) any eligible holder may edit, with full history. about and history are public and send no key. about --capabilities reads this account's own eligibility (token-pages:read). claim, section set, section restore and flag act as the key's account and need token-pages:write; neither scope is in any preset, so grant them with keys create --scopes token-pages:read,token-pages:write. Candle checks on every write that the account's Candle-known wallets hold at least 0.5% of the token's current supply (any positive balance to flag); the scope is never a holding. A creator proof is a message, never a transaction: claim --creator --challenge prints the exact bytes to sign (and --message-out writes them to a file), you sign them on your own machine, for example with candle sign message, and claim --creator --challenge-id <id> --signature <sig> sends the signature; a creator wallet already among the account's known wallets needs no signature. Section text comes from --file and is checked here first (valid UTF-8, at most 32 KiB, no control characters but newline and tab, thesis 280 characters, tokenomics and lore 5,000); the file is only read. Every write sends an Idempotency-Key and retries once on no answer with the same key. Exit codes: 0 done, 1 refused (the code is in --json), 2 usage or local input refused (nothing sent), 3 no answer so the outcome is unknown (rerun with the printed --idempotency-key), 4 revision conflict (your file is untouched; read history, merge, rerun with the latest --base-revision). Token page switches ship off; a switched-off server answers feature_off or not_found. events lists one token's signals, callouts and tracked-wallet trades, one event per line: time, kind, name or short address, action, size. Needs no key; a configured key is sent so wallet group names follow its tier. Off on a deployment until TOKEN_EVENTS_ENABLED is on; until then the command answers TOKEN_EVENTS_DISABLED. clusters reads third-party estimates of linked Solana wallets. Exchange, pool and service wallets may be grouped together; the figures do not establish common ownership or wrongdoing. Unavailable analysis is a normal result and exits 0. Needs no key and sends none. forensics and vamp-candidates send the profile's API key when it has one. Where the API offers x402 per-use payments, forensics past the free rate and the vamp finder without a key (or past a Free account's daily allowance) answer with a price: the CLI pays it in USDC from a Solana vault key, at a terminal, after a typed confirm (or --yes), within the limits candle spend sets, or prints the price and pays nothing. A paid call that Candle then fails to serve is credited, never refunded.",
    usage: [
      "candle token clusters <mint> [--chain solana|hood] [--json]",
      "candle token events <mint> [--chain solana|hood] [--kind trade|signal|callout] [--since <iso-8601>] [--limit <n>] [--before <cursor>] [--json]",
      "candle token forensics <mint> [--chain solana|hood] [--wallet <vault key>] [--yes] [--json]",
      "candle token vamp-candidates [--limit <n>] [--min-copies <n>] [--stage final_stretch|graduated|all] [--wallet <vault key>] [--yes] [--json]",
      "candle token about <address> [--chain solana|hood] [--capabilities] [--json]",
      "candle token claim <address> [--creator [--challenge [--message-out <path>] | --challenge-id <id> --signature <sig>]] [--json]",
      "candle token section set|restore <address> <thesis|tokenomics|lore> --file <path>|--version-id <id> --base-revision <n> [--json]",
      "candle token history <address> <thesis|tokenomics|lore> [--limit <n>] [--cursor <c>] [--json]",
      "candle token flag <address> --content <id> --reason <reason> [--detail <text>] [--json]",
    ],
    rows: [
      { invocation: "clusters <mint>", description: "Read cluster analysis, or its unavailable reason" },
      {
        invocation: "events <mint>",
        description: "Signals, callouts and tracked-wallet trades for one token, one per line",
      },
      { invocation: "forensics <mint>", description: "Token forensics; may cost a per-use payment past the free rate" },
      {
        invocation: "vamp-candidates",
        description: "Tokens near graduation whose ticker others copy; may cost a per-use payment",
      },
      {
        invocation: "about <address>",
        description:
          "The token's About page: claim, sections and measured supply; --capabilities adds your eligibility",
      },
      {
        invocation: "claim <address>",
        description: "Join the page's editors as a holder, or as its creator with --creator (a signed message)",
      },
      {
        invocation: "section set|restore <address> <section>",
        description: "Write a section from --file, or restore an earlier --version-id, at --base-revision",
      },
      { invocation: "history <address> <section>", description: "A section's versions, newest first" },
      { invocation: "flag <address>", description: "Report one exact version to Candle's review queue" },
    ],
    flags: [
      { invocation: "--chain <chain>", description: "solana (default) or hood; Hood cluster analysis is unavailable" },
      {
        invocation: "--kind <kind>",
        description: "events: trade, signal or callout; filters the page locally (the route has no kind filter)",
      },
      {
        invocation: "--limit <n>",
        description: "events, history or vamp-candidates: how many to read (events 1 to 1000, history 1 to 50)",
      },
      { invocation: "--min-copies <n>", description: "vamp-candidates: copies in the last 24h, at least" },
      { invocation: "--since <iso-8601>", description: "events: list only events at or after this time" },
      { invocation: "--before <cursor>", description: "events: continue the page a previous answer's cursor names" },
      { invocation: "--stage <stage>", description: "vamp-candidates: final_stretch, graduated or all (default)" },
      {
        invocation: "--wallet <vault key>",
        description: "The Solana vault key that pays, by label or address (needed when the vault has several)",
      },
      { invocation: "--yes", description: "Pay without the typed confirm (the vault unlock still prompts)" },
      { invocation: "--file <path>", description: "section set: the section text, UTF-8; an empty file needs --clear" },
      {
        invocation: "--base-revision <n>",
        description: "section set|restore: the revision you started from (0 first)",
      },
      { invocation: "--version-id <id>", description: "section restore: the earlier version to copy into a new one" },
      { invocation: "--content <id>", description: "flag: the exact version id being reported" },
      {
        invocation: "--reason <reason>",
        description: "flag: spam, scam, abuse, misleading, unsafe_link or other; --detail adds up to 500 characters",
      },
      { invocation: "--idempotency-key <key>", description: "Writes: reuse a key to retry without writing twice" },
    ],
    examples: [
      "candle token about <mint> --capabilities",
      "candle token section set <mint> thesis --file ./thesis.txt --base-revision 3",
      "candle token claim <mint> --creator --challenge --message-out ./proof.txt",
      "candle token clusters <mint>",
      "candle token clusters <mint> --json",
      "candle token events <mint> --kind signal --limit 50",
      "candle token forensics <mint>",
      "candle token vamp-candidates --stage graduated --json",
    ],
    env: ["CANDLE_API_URL", "CANDLE_X402_NETWORK", "CANDLE_X402_PAY_TO"],
  },
  spend: {
    group: "Account",
    intro: "x402 payments: local log, daily limit, per-call ceiling",
    summary: "x402 per-use payments: the local log, the daily limit, the per-call ceiling, pause",
    description:
      "Every per-use x402 payment this machine makes is checked first against limits kept on this machine, per profile: payments not paused, the price at most the per-call ceiling (default $1), and today's per-use total (UTC, counting payments not yet confirmed) plus the price at most the daily limit (default $5). The pay-to address must be the one this CLI pins for the network. Each payment is logged before it is sent, in <config dir>/spend/<profile>.jsonl (mode 0600), and its outcome after: settled, failed (nothing moved), unknown (not yet known; counted until resolved) or credited (Candle failed to serve a settled call and credited it). candle spend shows the log, today's total and the Candle credit balance (with an API key); an unknown older than 15 minutes is resolved against the server's payment list when the profile has a key. Plan purchases are not per-use and are outside the daily limit.",
    usage: [
      "candle spend [--days <n>] [--json]",
      "candle spend limit [<usd>]",
      "candle spend max-per-call [<usd>]",
      "candle spend pause",
      "candle spend resume",
    ],
    rows: [
      { invocation: "limit [<usd>]", description: "Show or set the daily per-use limit (default $5)" },
      { invocation: "max-per-call [<usd>]", description: "Show or set the per-call ceiling (default $1)" },
      { invocation: "pause", description: "Stop every per-use payment until resumed" },
      { invocation: "resume", description: "Allow per-use payments again" },
    ],
    flags: [{ invocation: "--days <n>", description: "How many days of the log to show (default 7)" }],
    examples: ["candle spend", "candle spend --days 30 --json", "candle spend limit 2", "candle spend pause"],
    env: ["CANDLE_CONFIG_DIR", "CANDLE_API_URL"],
  },
  quant: {
    group: "Account",
    intro: "Quant's terms, accepted before per-use answers",
    summary: "Quant's terms, which per-use Quant answers need accepted first",
    description:
      "terms shows Quant's terms and Privacy Policy and records this account's acceptance through its API key. Quant accepts only its current version; the default is the version this release was built with, and --terms-version sends another. A paid Quant answer past the daily limit is refused until the terms are accepted, before any payment is asked for.",
    usage: ["candle quant terms [--terms-version <YYYY-MM-DD>] [--yes] [--json]"],
    rows: [{ invocation: "terms", description: "Show Quant's terms and record acceptance" }],
    flags: [
      { invocation: "--terms-version <date>", description: "The terms version to accept, YYYY-MM-DD" },
      { invocation: "--yes", description: "Accept without the typed confirm" },
    ],
    examples: ["candle quant terms", "candle quant terms --yes --json"],
    env: ENV_API,
  },
  plans: {
    group: "Account",
    intro: "API plans: prices, fees, limits and what each does",
    summary: "The plans this API serves: prices, fees, limits and what each can do",
    description:
      "The plan table in force on the API this profile points at (GET /api/v1/agent/plans): each plan's monthly price, the agent trade fee, the Hyperliquid perps builder fee, the limits a new key gets, and one row per capability (buying and selling tokens not launched on Candle, self-launch, atomic launch, linked wallets, perps, limit orders). Every number is the server's; the CLI bundles none. Needs no key and sends none. Which plan this account is on is candle doctor's Plan row.",
    usage: ["candle plans [--json]"],
    rows: [],
    examples: ["candle plans", "candle plans --json", "candle plans --api-url https://staging.api.candle.tv"],
    env: ["CANDLE_API_URL"],
  },
  keys: {
    group: "Account",
    summary: "API keys, and the wallets each key may use",
    description:
      "API keys are minted over the device token and shown exactly once. A key's wallet set and scope decide which wallets an agent holding it may act on. To give a key TEE wallets, move them to it with candle tee rebind; keys wallets set cannot widen a key's set from the CLI.",
    usage: ["candle keys <subcommand> [flags]"],
    rows: [
      {
        invocation: "list [--scopes] [--all]",
        description:
          "List live API keys: name and Read, Write or Withdraw access; --all includes revoked keys; --scopes adds the raw scopes",
      },
      {
        invocation:
          "create [--access read|write|withdraw|trade-perps | --scopes <a,b,c>] [--label <name>] [--expires-in <days>] [--tx-limit <usd> [--reset daily|weekly|monthly|never]] [--embedded-wallet deny|allow]",
        description:
          "Create an API key; --access mints one of the levels (write trades and launches; only withdraw can move funds; trade-perps is exactly account:read and perps:write, for Hyperliquid perps setup and orders, and it cannot fund its own Hyperliquid account: a Relay deposit needs swap:write and a withdrawal needs perps:withdraw, each a separate grant through --scopes). A trade-perps key trades from an EVM TEE wallet promoted onto it (candle vault new-key --chain evm, then candle vault promote --from <cold> --to-key <prefix>; candle tee new is Solana only) and a signer on the trading machine (candle tee signer new --key <prefix>). --embedded-wallet defaults to deny; allow lets the key spend the account's embedded wallet and is confirmed at a terminal",
      },
      {
        invocation: "access <prefix|label|self> (--access read|write|withdraw [--yes] | --history)",
        description:
          "Change an existing key's level in place (same key, wallets and caps). Widening needs the device token and the prefix typed back at a terminal; --yes skips the prompt when narrowing; self narrows the profile's own key. --history lists the key's changes and who made them",
      },
      {
        invocation: "update <prefix|label> --embedded-wallet allow|deny [--yes]",
        description:
          "Allow or deny a key the account's embedded wallet, with the device token. Allowing needs the prefix typed back at a terminal; --yes skips the prompt when denying",
      },
      {
        invocation: "limit <prefix|label> (--tx-limit <usd> [--reset daily|weekly|monthly|never] | --clear)",
        description:
          "Set or clear the USD transaction cap on an existing key, with the device token. --reset defaults to daily",
      },
      {
        invocation: "self embedded-wallet deny",
        description:
          "The profile's own key gives up the embedded wallet, with no prompt. A key can never allow itself: the owner does that with keys update",
      },
      { invocation: "revoke <prefix>", description: "Revoke an API key" },
      {
        invocation: "signer approve <code> --key <prefix|label> [--reject]",
        description:
          "Approve (or reject) a key's signer request with the device token; type the full fingerprint the trading machine printed",
      },
      // Indented like `keys wallets set`: a second word under `keys signer`, not a subcommand of `keys`.
      {
        invocation: "  move <prefix|label> [--to-key <prefix|label>]",
        description:
          "On the machine holding a wallet's current signer: move every wallet on the key onto its active signer (legacy per-wallet ones too). --to-key moves a revoked key's wallets to a live key (device token). Resumable",
      },
      {
        invocation: "wallets <prefix>",
        description: "Wallets an agent profile can use. TEE wallets move between keys with candle tee rebind",
      },
      // Indented, as the 0.11.0 block had them: these are second words under `keys wallets`, not
      // subcommands of `keys`. The indent is what keeps them out of every row-start scan (the
      // drift test's, and the completion generator's), which reads a row start as `/^ {2}(\S+)/`.
      {
        invocation: "  set <prefix> --wallets <id,id>",
        description:
          "Replace the profile's wallet set; from a key it can only narrow. To move TEE wallets to a key: candle tee rebind",
      },
      {
        invocation: "  scope <prefix> --scope <all|selected>",
        description: "Limit a profile to assigned wallets",
      },
    ],
    examples: [
      "candle keys list",
      "candle keys create --access withdraw --label rebalancer",
      "candle keys create --access trade-perps --label perps-bot",
      "candle keys create --scopes trade:write --label agent-one",
      "candle keys access cndl --access withdraw",
      "candle keys access self --access read --yes",
      "candle keys update agent-one --embedded-wallet deny --yes",
      "candle keys self embedded-wallet deny",
      "candle keys wallets ck_live_ab12",
      "candle tee rebind --label-prefix dest- --to-key Ab3dEf9h",
      "candle keys signer approve ABCD-EFGH --key tr-2",
      "candle keys signer move tr-2",
      "candle keys revoke ck_live_ab12",
    ],
    env: ENV_API,
  },
  wallets: {
    group: "Account",
    intro: "Launch and linked wallets; import or revoke one",
    display: "wallet",
    summary: "Launch and linked wallets; import or revoke one (wallets is an alias)",
    description:
      "The account's embedded launch wallets and any wallet you linked, with a Signer column saying whether this machine holds the signing key and a Trusted column saying whether it is yours: linked while signed in, or marked with wallet trust. Keys are derived in the vault now: this command links and revokes, it never generates or prints one.",
    usage: ["candle wallet [flags]", "candle wallet <subcommand> [flags]"],
    rows: [
      {
        invocation: "import --chain <solana|evm> [options]",
        description:
          "Import a wallet you own (key via --key-file or hidden prompt). A fresh key, without solana-keygen: candle vault new-key --chain solana, candle vault export-key <label> --to <file>, import that file, then delete the file",
      },
      { invocation: "revoke <wallet-id>", description: "Revoke a linked wallet" },
      {
        invocation: "trust <label|address|id|prefix*>...",
        description: "Mark linked wallets yours, so agents can move funds into them (owner only; typed confirm)",
      },
      {
        invocation: "untrust <label|address|id|prefix*>... [--yes]",
        description: "Clear the mark; moving funds in needs the withdrawal allowlist again (owner only)",
      },
      {
        invocation: "allow-launch <label|address|id|prefix*>...",
        description:
          "Let TEE wallets pay for a launch (candle launch), after a screen of label, address and bound key (owner only; typed confirm)",
      },
      {
        invocation: "disallow-launch <label|address|id|prefix*>... [--yes]",
        description: "Stop TEE wallets paying for a launch; trading is unchanged (owner only)",
      },
      {
        invocation:
          "close-empty [--wallet embedded|<tee address|label>] [--keep <mint>]... [--client-trade-id <id>] [--yes]",
        description:
          "Close a wallet's empty token accounts and return their rent to it, after a preview: the embedded wallet (transfer:write), or a TEE wallet bound to this key, signed by its key signer (swap:write)",
      },
    ],
    examples: [
      "candle wallet",
      "candle wallet import --chain solana --key-file ./signer.json",
      "candle wallet revoke wal_123",
      "candle wallet trust 'tr-*' 'dest-*'",
      "candle wallet allow-launch launcher-1",
      "candle wallet close-empty --keep EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "candle wallet close-empty --wallet agent-one",
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
      {
        invocation: "list",
        description: "Profiles on this machine, with cached accounts, and each one's Solana RPC host",
      },
      { invocation: "add <name> --api-url <url>", description: "Create a profile before authenticating it" },
      { invocation: "use <name>", description: "Make a profile the active one" },
      { invocation: "rename <old> <new>", description: "Rename a profile" },
      { invocation: "remove <name> --yes", description: "Delete a profile and its stored credentials" },
      {
        invocation: "set <name> --rpc-url <url> | --clear-rpc-url",
        description:
          "This profile's Solana RPC, used when --rpc-url and CANDLE_SOLANA_RPC_URL are not given. Stored in config.json; only its host is ever shown",
      },
    ],
    examples: [
      "candle profile list",
      "candle profile add staging --api-url https://staging.api.candle.tv",
      "candle profile use staging",
      "candle profile set work --rpc-url https://<your-rpc>",
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
        invocation: "list [<filter>] [--balances] [--rpc-url <url>] [--evm-rpc-url <url>]",
        description:
          "One line per key: address, label, role, derivation. Prompts for the passphrase. --balances reads SOL over your Solana RPC and ETH (plus USDG on Hood) for EVM keys over --evm-rpc-url, CANDLE_EVM_RPC_URL, or the built-in Hood RPC",
      },
      {
        invocation: "new-key --chain solana|evm [--label <name>] [--count <n>] [--labels-from <file>]",
        description:
          "Derive the next Solana key (m/44'/501'/n'/0') or EVM key (m/44'/60'/n'/0/0), or n of them under one unlock; the name must be free",
      },
      {
        invocation: "rename <label|address|id> <new-label> [--id <entry-id>]",
        description:
          "Rename one vault or external key. New names: at most 64 characters, no edge whitespace. The address, the derivation and the key blob do not change",
      },
      {
        invocation: "  rename --pairs-from <file> [--dry-run]",
        description:
          "Rename 1–256 vault or external keys under one unlock and one commit. All findings refuse the whole file; swaps are allowed. --dry-run prints the plan and writes nothing; --json returns the renamed rows",
      },
      { invocation: "phrase show", description: "Show the 24-word recovery phrase (terminal only)" },
      {
        invocation:
          "restore --phrase [--own-passphrase] [--count <n>] [--tee-count <k>] [--external-count <e>] [--evm-count <m>] [--evm-tee-count <k>] [--rpc-url <url>]",
        description:
          "Rebuild a vault from the recovery phrase; it gets a new passphrase. --evm-count derives EVM indices 0..m-1 and --evm-tee-count Hood TEE wallets 0..k-1 on m/44'/60'/n'/1'/0' (default 0, never gap-scanned; the sealed EVM record does not come back, so a sweep then needs --from-block or --token). A gap scan needs --rpc-url on this command; no default or stored endpoint is used for it",
      },
      {
        invocation: "reconcile-exposure",
        description: "Re-read this account and add exposure; clears nothing",
      },
      {
        invocation: "factor list | add <kind> [--install-helper] | remove <id>",
        description: `Manage the factors that open the vault: ${FACTOR_KINDS.join(", ")}. --install-helper (security-key) fetches and verifies this release's candle-fido2 first`,
      },
      {
        invocation: "enroll <kind> [--label <name>] [--install-helper]",
        description: `Same as factor add: ${FACTOR_KINDS.join(", ")}`,
      },
      {
        invocation: "backup --to <path>|icloud [--accept-shared-domain]",
        description:
          "Copy the vault and verify the copy in full; icloud is iCloud Drive; sealed copies carry the passphrase and security keys. A vault with Hood TEE wallets also writes its sealed EVM record beside the copy (<copy minus .enc>.evm-record.sealed), the lines that decrypt only",
      },
      {
        invocation: "verify-backup <path>",
        description:
          "Verify a copy in full (all eight steps; a ninth for a vault with Hood TEE wallets: every line of the record beside the copy decrypts under the copy's key)",
      },
      { invocation: "import-legacy --tee [--from <path>]", description: "Migrate tee-wallets.enc into the vault" },
      {
        invocation: "retire-legacy [--from <path>]",
        description: "Rename the Phase 1 store after a verified backup",
      },
      {
        invocation:
          "transfer <to> --amount <n|max> --asset SOL|<mint>|ETH|USDG|<0x token> --from <label> [--rpc-url <url>]",
        description:
          "Sign a transfer locally from a vault key or a promoted TEE wallet (Solana, or Hood: refused while a sequenced trade holds the wallet's nonce, and when that cannot be read). From an EVM key: ETH or an ERC-20, on Hood by default (--rpc-url for any EVM chain; the chain id is read from the RPC), exit 0 means depth-confirmed (1 block on Hood, 2 elsewhere), not finalized. A Solana key reads and sends over --rpc-url, else CANDLE_SOLANA_RPC_URL, else the profile's RPC, else the public endpoint. One verification: the unlock names the send; after the decoded display you type confirm. No --yes",
      },
      {
        invocation:
          "promote --from|--in-place <label> [--sweep-to <label>] [--rpc-url <url>] [--to-key <prefix|label>]",
        description:
          "Fresh TEE key, or promote one vault key in place. Reads, over your RPC, whether each key is a token mint, freeze, program upgrade or stake authority (9 requests per key; public endpoints refuse the token scans). Multisig membership is not checked. An EVM key becomes a Hood TEE wallet (--from derives m/44'/60'/n'/1'/0'; --sweep-to is a cold EVM vault key; --rpc-url is the Hood RPC); the vault becomes version 4 and records the promote height as the wallet's scan start.",
      },
      {
        invocation: "promote-batch --pairs-from <file> [--rpc-url <url>] [--to-key <prefix|label>] [--token-holdings]",
        description:
          "Promote many vault keys in place: one unlock, one reviewed acknowledgement. Reads, over your RPC, whether each key is a token mint, freeze, program upgrade or stake authority (9 requests per key; public endpoints refuse the token scans). Multisig membership is not checked. A file of EVM keys promotes them to Hood TEE wallets (ETH shown, no authority read); one file is one chain.",
      },
      {
        invocation:
          "fund <tee-address|external> --amount <n> --asset SOL|USDC|ETH|USDG [--rpc-url <url>] [--from <label>]",
        description:
          "Fund a TEE or external wallet from a vault key. A Hood TEE wallet takes ETH or USDG from its pinned EVM vault key. One verification: the unlock names the send; after the decoded display you type confirm. No --yes",
      },
      {
        invocation:
          "demote <tee-address> [--rpc-url <url>] [--emergency] [--sweep-to <label>] [--token <0x...>] [--from-block <n>]",
        description:
          "Disable then sweep a TEE wallet back to its pin. A Hood wallet takes tee sweep's --token and --from-block",
      },
      {
        invocation: "export-key <label> --to <new-file>",
        description: "Export one key as plaintext (interactive ceremony: unlock, then type confirm under the address)",
      },
    ],
    flags: [
      KEYSTORE_FLAG,
      {
        invocation: "--factor <id|kind>",
        description:
          "Unlock with this envelope: an id from factor list, or passphrase, security-key, touch-id, passkey; without it, a terminal lists the factors to pick by number",
      },
      {
        invocation: "--device <id>",
        description:
          "The security key to use when more than one is attached; on factor add security-key, the key to add (the vault opens with the passphrase or another key)",
      },
      {
        invocation: "--balances",
        description:
          "list: SOL per matched key, read from your RPC (one request per 100 matched keys). Every matched address goes to that one endpoint together, which links them; SPL tokens are never read. EVM keys are read over the EVM endpoint: ETH, and USDG on Hood",
      },
      {
        invocation: "--evm-rpc-url <url>",
        description:
          "list --balances: the EVM endpoint for EVM keys. Else CANDLE_EVM_RPC_URL, else the built-in Hood RPC; the Solana --rpc-url is never sent an EVM address. The host is printed on stderr before the read",
      },
      {
        invocation: "--labels-from <file>",
        description:
          "new-key: one name per line, one key each, one unlock (max 256). Each key is committed on its own, so a batch that is interrupted keeps every key that landed and you re-run for the rest.",
      },
      {
        invocation: "--pairs-from <file>",
        description:
          "rename: one '<label|address|id> <new-label>' per line, or CSV columns from,to (1–256 rows; blank lines and # comments skipped). No trimming of names; use CSV for names with spaces. promote-batch: one '<label> <destination>' per line, or a CSV with label and sweep_to columns (max 256). Every row is checked against the whole set before anything is written, and each key is committed on its own, so an interrupted batch keeps what landed and re-running the same file resumes.",
      },
      {
        invocation: "--dry-run",
        description: "rename --pairs-from: unlock, check every row, print the plan, and write nothing",
      },
      {
        invocation: "--to-key <prefix|label>",
        description:
          "promote, promote-batch: bind the promoted wallets to this key instead of the calling one. The import runs under the calling key as before, then the wallets are moved to the named key by a rebind (device token; the target's secret never touches this machine). The target is checked before the unlock; a wallet whose rebind fails is named as still on the calling key, with the tee rebind command that finishes.",
      },
    ],
    examples: [
      "candle vault init",
      "candle vault new-key --chain solana --label treasury",
      "candle vault new-key --chain evm --label hood-cold",
      "candle vault transfer 0x000000000000000000000000000000000000dEaD --amount 0.5 --asset USDG --from hood-cold",
      "candle vault list cn-s",
      "candle vault rename key-7 treasury-cold",
      "candle vault rename --pairs-from ./rename-plan.csv --dry-run",
      "candle vault new-key --chain solana --labels-from ./replacement-names.txt",
      "candle vault promote-batch --pairs-from ./promote-plan.csv",
      "candle vault promote-batch --pairs-from ./promote-plan.csv --to-key tr-01",
      "candle vault enroll security-key --label yubikey-a",
      "candle vault backup --to /Volumes/BACKUP/vault.enc",
      "candle vault backup --to icloud",
      "candle vault promote --in-place hood-cold-1 --sweep-to hood-cold",
      "candle vault fund 0x000000000000000000000000000000000000dEaD --amount 0.01 --asset ETH",
      "CANDLE_CONFIG_DIR=$HOME/t47 candle vault status",
    ],
    env: [
      "CANDLE_CONFIG_DIR",
      "CANDLE_SOLANA_RPC_URL",
      "CANDLE_EVM_RPC_URL",
      "CANDLE_FIDO2_HELPER",
      "CANDLE_ENCLAVE_HELPER",
      "CANDLE_KEYSTORE_PASSPHRASE",
    ],
  },
  tee: {
    group: "Custody, on this machine",
    summary: "Dedicated TEE wallet keys for agents: seal, delegate, fund, sweep",
    description:
      "A dedicated, capped Solana wallet for one agent. The key is generated and sealed on this machine; enable delegates it to this profile's API key with a sweep vault pinned, and sweep moves everything back to that vault, signed locally.",
    usage: ["candle tee <subcommand> [flags]"],
    rows: [
      {
        invocation: "new [--label <name>]",
        description:
          "Add a Solana key to an existing tee-wallets.enc. With no store, refuses: candle vault new-key --chain solana, then candle vault promote --from <label> --to-key <prefix>. --factor does not apply",
      },
      {
        invocation: "enable <address> --vault <address>",
        description: "Delegate a TEE wallet key; pin the sweep vault (--vault-key <label> also)",
      },
      {
        invocation: "fund <address> --amount <n> [--asset SOL|USDC]",
        description: "Print the funding instruction for your vault to sign",
      },
      {
        invocation: "status <address> [--rpc-url <url>] [--verify]",
        description:
          "Server lifecycle state and on-chain balances without unlocking; --verify opens the vault and checks the key. On Hood, ETH, USDG, the gas reserve and gas: low",
      },
      {
        invocation: "disable <address>",
        description: 'Stop the agent; verified stop or pending, never "done" on a 200',
      },
      {
        invocation: "sweep <address> [--rpc-url <url>] [--emergency] [--token <0x...>] [--from-block <n>]",
        description:
          "Sign locally and move everything to the pinned vault; closes DAMM v2 LP positions after verifying each server-built close (--emergency moves the position NFT instead, with no API). A Hood wallet (0x): USDG, WETH, the sealed EVM record, the server's list (not under --emergency), every --token, and Transfer logs from its recorded scan start or --from-block, then ETH last; it refuses while a sequenced trade holds the wallet's nonce",
      },
      {
        invocation: "rebind <wallet...> --to-key <prefix|label> [--label-prefix <p>]",
        description:
          "Move TEE wallets to another key on this account, which is how a key gets TEE wallets. Name them, or --label-prefix for every wallet whose label starts with it (owner only; funds do not move)",
      },
      { invocation: "rebinds [wallet]", description: "List TEE wallet rebinds for this account (owner only)" },
      {
        invocation: "rename <label|address|id> <new-label>",
        description:
          "Rename one TEE wallet: the label Candle holds and, when its key is in this vault, the vault entry (owner only). New names: at most 64 characters, no edge whitespace. Funds, the address and the key do not change",
      },
      {
        invocation: "  rename --pairs-from <file> [--dry-run]",
        description:
          "Rename 1–256 TEE wallets with one server call, all or nothing, then one vault commit. Every finding refuses the whole file. The vault is unlocked once, only when a named TEE wallet may be in it. --dry-run prints the plan and changes nothing; if the vault write fails after the server accepted, it prints address-keyed rows to re-run",
      },
      {
        invocation: "signer new --key <prefix|label> [--out <pem>] [--force]",
        description:
          "On the trading machine, with that key's API key: generate the key's signer here and wait for the owner to approve it. Its wallets then trade from this machine. --out also writes a plaintext PEM for an SDK process (weaker than the secret store); --force adds a signer while an older signer on THIS machine still owns wallets; it moves, revokes and deletes nothing",
      },
    ],
    flags: [
      KEYSTORE_FLAG,
      {
        invocation: "--pairs-from <file>",
        description:
          "rename: one '<label|address|id> <new-label>' per line, or CSV columns from,to (1–256 rows; blank lines and # comments skipped). No trimming of names; use CSV for names with spaces.",
      },
      {
        invocation: "--dry-run",
        description: "rename --pairs-from: resolve and check every row, print the plan, and change nothing",
      },
    ],
    examples: [
      "candle tee new --label AgentOne",
      "candle tee status AgentOneAddress",
      "candle tee sweep AgentOneAddress",
      "candle tee sweep 0x000000000000000000000000000000000000dEaD --emergency --from-block 1200000",
      "candle tee rebind tr-01 tr-02 --to-key Ab3dEf9h",
      "candle tee rebind --label-prefix dest- --to-key Ab3dEf9h",
      "candle tee rename tr-01 desk-01",
      "candle tee rename --pairs-from ./tee-names.csv --dry-run",
      "candle tee signer new --key tr-2",
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
        invocation: "sweep <external> --to <vault> [--rpc-url <url>]",
        description:
          "Send everything an external wallet holds back to a vault key. One verification: the unlock names the send; after the display you type confirm",
      },
    ],
    flags: [KEYSTORE_FLAG],
    examples: [
      "candle external new --label defi-tool",
      "candle external list",
      "candle external sweep defi-tool --to treasury",
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
  tui: {
    group: "Start here",
    intro: "The Candle TUI: holdings, feed, agents, approvals (preview)",
    summary: "The Candle TUI: holdings, the feed, your agents and approval cards, in the terminal (preview)",
    description:
      "Starts the Candle TUI (candle-tui), which starts the local core for the profile when it is not running. Every live money action an agent proposes becomes an approval card you approve there with your vault factor. Preview: the TUI is not released yet.",
    usage: ["candle tui [--profile <name>]"],
    rows: [],
    examples: ["candle tui", "candle tui --profile staging"],
    env: ["CANDLE_CONFIG_DIR", "CANDLE_PROFILE"],
  },
  core: {
    group: "Maintain",
    summary: "Run the local Candle core the Candle TUI attaches to (preview)",
    description:
      "The local core: one process per profile, and the only thing on this machine that holds the profile's trading credentials once trading is on in the Candle TUI. Views and harnesses attach to it on a local socket; every live money action becomes an approval card you approve in the TUI with your vault factor. Preview.",
    usage: ["candle core serve [--profile <name>] [--view-token-fd <n>]", "candle core mcp [--token <harness token>]"],
    rows: [
      { invocation: "serve", description: "Start the core for the profile in play; one per profile" },
      {
        invocation: "mcp [--token <t>] [--harness <kind>]",
        description: "A stdio MCP server for any harness, attached to the running core: money writes become cards",
      },
    ],
    flags: [
      {
        invocation: "--view-token-fd <n>",
        description: "Write this start's view token to an inherited descriptor (the TUI launcher's)",
      },
    ],
    examples: ["candle core serve", "candle core serve --profile staging", "CANDLE_CORE_TOKEN=cht_... candle core mcp"],
    env: ["CANDLE_CONFIG_DIR", "CANDLE_PROFILE", "CANDLE_CORE_TOKEN"],
  },
  update: {
    group: "Maintain",
    intro: "Update the CLI and its key helper to the latest release",
    summary: "Update the CLI and its security key helper to the latest signed release",
    description:
      "Replaces this binary, and the candle-fido2 security key helper beside it, with the latest signed release. Both downloads are checked the same way and nothing is renamed until both pass: the checksum must match and the Sigstore bundle must verify in process against that exact version's release workflow. A release that ships no helper for this platform updates the binary alone.",
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
    usage: ["candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]"],
    rows: [],
    flags: [
      { invocation: "--bundle <path>", description: "The .sigstore.json bundle beside the asset" },
      {
        invocation: "--identity <uri>",
        description:
          "The signing identity to require; defaults to the release identity for the version in a latest.json beside the bundle",
      },
      { invocation: "--issuer <url>", description: "The certificate issuer to require; defaults to GitHub Actions'" },
    ],
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
      "The top-level screen, or one command's own: its subcommands, flags and examples. --more includes the full rules and row descriptions. Shared environment variables are listed once at the top level. Reads no config and makes no request, so it answers on a machine with no profile selected.",
    usage: ["candle help", "candle help <command> [--more]"],
    flags: [
      { invocation: "--more", description: "Include the full rules and row descriptions, without opening a browser" },
    ],
    rows: [],
    examples: ["candle help", "candle help vault", "candle help perps --more", "candle help completion"],
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

const WIDTH = 100

/** Continuations use four or more spaces, never the two-space row-start marker. */
function indented(text: string, width: number, first = "  ", continuation = "    "): string[] {
  const leading = text.match(/^ +/)?.[0] ?? ""
  const lines = wrapText(
    text.trimStart(),
    Math.max(1, width - Math.max(first.length + leading.length, continuation.length)),
  )
  return lines.map((line, index) => `${index === 0 ? first + leading : continuation}${line}`)
}

/** Keep the action on the short screen; all qualifications remain in --more. */
function rowSummary(description: string): string {
  let depth = 0
  for (let i = 0; i < description.length; i++) {
    const char = description[i]
    if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && char === ";" && description[i + 1] === " ") return description.slice(0, i)
    else if (depth === 0 && char === "." && /^ [A-Z-]/.test(description.slice(i + 1)))
      return description.slice(0, i + 1)
  }
  return description
}

function renderRows(rows: Row[], maxColumn: number, width = WIDTH, more = true): string[] {
  if (rows.length === 0) return []
  const longest = Math.max(...rows.map((row) => row.invocation.length))
  const column = Math.min(2 + longest + 2, maxColumn, Math.max(4, Math.floor(width / 3)))
  const pad = " ".repeat(column)
  const out: string[] = []
  for (const row of rows) {
    const description = more ? [row.description, row.more].filter(Boolean).join(" ") : rowSummary(row.description)
    if (2 + row.invocation.length + 2 <= column) {
      const [first = "", ...rest] = wrapText(description, width - column)
      out.push(`  ${row.invocation.padEnd(column - 2)}${first}`, ...rest.map((line) => `${pad}${line}`))
    } else {
      out.push(...indented(row.invocation, width), ...indented(description, width, "    "))
    }
  }
  return out
}

/** The environment block, rendered from names looked up in `ENVIRONMENT` so a description is
 * written once (D2). An unknown name is skipped rather than printed empty; T8 is what stops one
 * from being introduced. */
function renderEnv(names: readonly string[], width = WIDTH): string[] {
  const vars = names
    .map((name) => ENVIRONMENT.find((entry) => entry.name === name))
    .filter((entry): entry is EnvVar => entry !== undefined)
  return renderRows(
    vars.map((entry) => ({ invocation: entry.name, description: entry.description })),
    32,
    width,
  )
}

/**
 * The top level: `candle`, `candle --help`, `candle -h`, `candle help`. Command WORDS only, in six
 * groups, then the global flags, the environment and the plug-in line. Subcommand rows and flags
 * live on the topic screens (`candle help <command>`).
 */
export function renderTopLevel(style?: TerminalStyle): string {
  return renderPresentedTopLevel(style)
}

/**
 * One command word's screen. Takes the canonical word or its displayed spelling, so
 * `candle wallet --help` and `candle help wallet` land on the same screen as `wallets`.
 * `undefined` for a word that is not a command, which is what lets the caller fall back to the top
 * level and print `Unknown command: <word>` first.
 */
export function renderTopic(word: string, style?: TerminalStyle, more = false): string | undefined {
  const topic = topicFor(word)
  if (!topic) return undefined
  const canonical = Object.keys(HELP).find((key) => HELP[key] === topic) ?? word
  const display = displayName(canonical)
  const width = Math.min(style?.width ?? WIDTH, WIDTH)
  const out = [
    ...wrapText(`candle ${display}: ${topic.intro ?? topic.summary}.`, width),
    ...wrapText(`More: candle help ${display} --more`, width),
  ]
  out.push(
    "",
    ...topic.usage.flatMap((usage, index) => indented(usage, width, index === 0 ? "Usage: " : "       ", "       ")),
  )
  if (topic.rows.length > 0) out.push("", ...renderRows(topic.rows, 58, width, more))
  if (topic.flags && topic.flags.length > 0) {
    out.push(
      "",
      ...wrapText(`Flags every ${display} subcommand takes`, width),
      ...renderRows(topic.flags, 28, width, more),
    )
  }
  out.push("", "Examples", ...topic.examples.flatMap((example) => indented(example, width)))
  if (more) out.push("", "Rules", ...wrapText(topic.description, width))
  out.push("", ...wrapText("Environment variables: candle --help", width))
  return `${out.join("\n")}\n`
}

/** One command column at every width, including plain output and routing diagnostics. */
function renderPresentedTopLevel(style?: TerminalStyle): string {
  const width = Math.min(style?.width ?? WIDTH, WIDTH)
  const heading = (text: string) => (style ? accent(text, style) : text)
  const out = [
    ...(style ? brandHeader(style) : []),
    ...(!style?.styled ? [...wrapText("Candle CLI: Your wallets and agent tools, one command away.", width), ""] : []),
    ...LAUNCH_DEFINITION.surfacesIntro.flatMap((line) => wrapText(line, width)),
    "",
    ...indented("candle <command> [<subcommand>] [flags]", width, "Usage: ", "       "),
    ...indented("candle help <command> [--more]", width, "       ", "       "),
  ]
  for (const name of GROUPS) {
    out.push(
      "",
      heading(name),
      ...renderRows(
        Object.entries(HELP)
          .filter(([, topic]) => topic.group === name)
          .map(([word, topic]) => ({ invocation: displayName(word), description: topic.summary })),
        18,
        width,
      ),
    )
  }
  out.push("", heading("Global flags"), ...renderRows(GLOBAL_FLAGS, 28, width))
  out.push(
    "",
    heading("Environment"),
    ...renderEnv(
      ENVIRONMENT.map((entry) => entry.name),
      width,
    ),
  )
  out.push("", heading("Plug-ins"), ...renderRows([PLUGIN_LINE], 26, width))
  return `${out.join("\n")}\n`
}
