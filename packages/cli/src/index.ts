#!/usr/bin/env node
/**
 * `candle`: the CLI's dispatch entry. `run(argv, deps)` is exported for tests (see
 * `test-support.ts`'s fakes) and is what the bin entry at the bottom of this file calls with real
 * deps and `process.argv.slice(2)`.
 *
 * Global flags (`--api-url`, `--json`, `--help`, `--version`, and the vault's `--factor` and
 * `--device`) are stripped out of `argv` wherever they appear, so `candle keys list --json` and
 * `candle --json keys list` behave identically. One
 * leading `candle` token is dropped too (bunx passes the bin's own name through as argv[0]; see
 * the comment at that line). The remaining tokens are the command path: `auth
 * <login|status|logout>`, `keys <list|create|revoke>`, `wallets`, `doctor`.
 *
 * Exit codes: 0 success, 1 user-facing failure (denied, expired, invalid input, or a routing
 * failure -- no command or subcommand matched, so nothing ran), 2 a malformed invocation of an
 * otherwise-valid command (a recognized command missing a required flag/argument, or given an
 * unknown flag). `doctor` exits 1 on any FAIL row (`doctor.ts`).
 */

import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { chmod, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { pathToFileURL } from "node:url"
import { resolveApiUrl } from "./client"
import { authLogin, authLogout, authStatus } from "./commands/auth"
import { completion, completionBash, completionFish, completionZsh } from "./commands/completion"
import { doctor } from "./commands/doctor"
import { externalList, externalNew, externalSweep } from "./commands/external"
import { help } from "./commands/help"
import { keysCreate, keysList, keysRevoke } from "./commands/keys"
import { keysAccess } from "./commands/keys-access"
import { keysWallets } from "./commands/keys-wallets"
import { launch } from "./commands/launch"
import { lpAdd, lpClaim, lpPools, lpPositions, lpRemove } from "./commands/lp"
import { mcp, mcpActsAsIdentity } from "./commands/mcp"
import { plugins, runPlugin } from "./commands/plugins"
import { pnl } from "./commands/pnl"
import { portfolio } from "./commands/portfolio"
import { profileAdd, profileList, profileRemove, profileRename, profileSet, profileUse } from "./commands/profile"
import { secretsList, secretsRemove, secretsSet } from "./commands/secrets"
import { setup } from "./commands/setup"
import { sign, signMessage } from "./commands/sign"
import { swap, swapStatus } from "./commands/swap"
import { teeDisable, teeEnable, teeFund, teeNew, teeStatus, teeSweep } from "./commands/tee"
import { teeRebind, teeRebinds } from "./commands/tee-rebind"
import { transfer } from "./commands/transfer"
import { update } from "./commands/update"
import { vaultBackup, vaultVerifyBackup } from "./commands/vault-backup"
import { vaultDemote } from "./commands/vault-demote"
import { vaultExportKey } from "./commands/vault-export-key"
import { vaultFactorAdd } from "./commands/vault-factor"
import { vaultFactor } from "./commands/vault-factor-dispatch"
import { vaultFund } from "./commands/vault-fund"
import { vaultImportLegacy } from "./commands/vault-import-legacy"
import { vaultInit } from "./commands/vault-init"
import { vaultList } from "./commands/vault-list"
import { vaultNewKey } from "./commands/vault-new-key"
import { vaultPhrase } from "./commands/vault-phrase-dispatch"
import { vaultPromote } from "./commands/vault-promote"
import { vaultPromoteBatch } from "./commands/vault-promote-batch"
import { vaultRename } from "./commands/vault-rename"
import { vaultReconcileExposure, vaultRestore } from "./commands/vault-restore"
import { vaultRetireLegacy } from "./commands/vault-retire-legacy"
import { vaultStatus } from "./commands/vault-status"
import { vaultTransfer } from "./commands/vault-transfer"
import { verify } from "./commands/verify"
import { wallets, walletsImport, walletsRevoke } from "./commands/wallets"
import { walletsTrust, walletsUntrust } from "./commands/wallets-trust"
import type { CliConfig } from "./config"
import { clearConfig, readConfig, updateProfile, writeConfig } from "./config"
import type { CommandContext, Deps } from "./deps"
import { verifyProfileAccount } from "./guard"
import { renderTopic, renderTopLevel } from "./help"
import { resolveSecretStore, SECRETS_SERVICE } from "./keychain"
import { pluginInvocation, realRunPlugin } from "./plugins"
import { migratedConfig, profileSecretRef, resolveProfileName, resolveProfileNameForLogin } from "./profiles"
import { platformKey } from "./release"
import { writeLocalFailure, writeUsageFailure } from "./render"
import { defaultSecretsPath, promptHiddenSecret, promptVisibleLine, SECRET_REFS } from "./secret-store"
import { maybeWriteUpdateNotice } from "./update-notice"
import { appendEvmRecordForTrade } from "./vault/evm-tee"
import type { HelperRun } from "./vault/fido2"
import { RELEASE_POLICY } from "./vault/release-policy"
import { CLI_VERSION } from "./version"

interface GlobalFlags {
  apiUrl?: string
  profile?: string
  /** Ember Phase 2 (BE-140): which envelope a vault command unlocks with, and which security key. */
  vaultFactor?: string
  vaultDevice?: string
  json: boolean
  help: boolean
  version: boolean
  noVerifyAccount: boolean
}

function extractGlobalFlags(argv: string[]): { rest: string[]; flags: GlobalFlags } | { error: string } {
  const rest: string[] = []
  const flags: GlobalFlags = { json: false, help: false, version: false, noVerifyAccount: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") flags.json = true
    else if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--version" || arg === "-v") flags.version = true
    else if (arg === "--no-verify-account") flags.noVerifyAccount = true
    else if (arg === "--api-url") {
      const value = argv[++i]
      if (value === undefined) return { error: "--api-url requires a value" }
      flags.apiUrl = value
    } else if (arg?.startsWith("--api-url=")) flags.apiUrl = arg.slice("--api-url=".length)
    else if (arg === "--profile") {
      const value = argv[++i]
      if (value === undefined) return { error: "--profile requires a value" }
      flags.profile = value
    } else if (arg?.startsWith("--profile=")) flags.profile = arg.slice("--profile=".length)
    else if (arg === "--factor") {
      const value = argv[++i]
      if (value === undefined) return { error: "--factor requires a value" }
      flags.vaultFactor = value
    } else if (arg?.startsWith("--factor=")) flags.vaultFactor = arg.slice("--factor=".length)
    else if (arg === "--device") {
      const value = argv[++i]
      if (value === undefined) return { error: "--device requires a value" }
      flags.vaultDevice = value
    } else if (arg?.startsWith("--device=")) flags.vaultDevice = arg.slice("--device=".length)
    else if (arg !== undefined) rest.push(arg)
  }
  return { rest, flags }
}

type CommandHandler = (args: string[], ctx: CommandContext) => Promise<number>

interface CommandRoute {
  /** Handlers keyed by the subcommand word, each called with the tokens AFTER it. */
  subcommands?: Record<string, CommandHandler>
  /** The command's own form, run when no subcommand matches: `candle wallets`, `candle doctor`,
   * `candle mcp --read-only`. Called with the tokens after the command word, so a leading flag is
   * never mistaken for a subcommand. A word with no bare form answers usage instead. */
  bare?: CommandHandler
}

/**
 * The dispatch table: every command word `run` routes, its subcommands, and its bare form. This
 * is the single copy -- `ROUTED_COMMANDS`, `ROUTED_SUBCOMMANDS`, the guard's routability gate and
 * the chain at the bottom of `run` are all derived from it, so the invocations the guard reasons
 * about are by construction the ones dispatch actually runs. A command added here is routed,
 * listed and gated in one edit.
 */
const COMMANDS: Record<string, CommandRoute> = {
  swap: { bare: swap, subcommands: { status: swapStatus } },
  // Read:Write:Transfer (BE-332 PR C): move funds out of a TEE wallet through its bound key, to
  // the account's own wallets or the wallet's vault. Server-built, relay-signed, never a vault key.
  transfer: { bare: transfer },
  launch: { bare: launch },
  // Ember Phase 3 R7 (BE-316): read-only. `pnl --profile <name>` reads the global flag as the
  // per-key request (see commands/pnl.ts).
  pnl: { bare: pnl },
  portfolio: { bare: portfolio },
  // Ember Phase 3 PR D (BE-315, R4): Meteora DAMM v2 liquidity from a TEE wallet, on the agent
  // rail under the bound key's opt-in `lp:write`. Server-built, relay-signed, never a vault key.
  lp: { subcommands: { pools: lpPools, add: lpAdd, positions: lpPositions, remove: lpRemove, claim: lpClaim } },
  auth: { subcommands: { login: authLogin, status: authStatus, logout: authLogout } },
  // BE-361: `keys access` moves an existing key between the three levels in place.
  keys: {
    subcommands: { list: keysList, create: keysCreate, access: keysAccess, revoke: keysRevoke, wallets: keysWallets },
  },
  // D6 (BE-238): `wallets generate` and `wallets export` were tombstoned in 0.10.0 and are gone
  // in 0.11.1. Nobody ran the releases in between (BE-235, item 3), so the tombstone had no
  // audience, and a routed word documented nowhere is the half-state the drift test cannot see.
  // `wallets` has a bare form, so those two words never reach unknownCommand. They answer as
  // any other leftover positional after wallet: Unexpected argument, exit 2 (T14).
  wallets: {
    // BE-329: the owner's trust mark, over the device token (never an API key).
    subcommands: { import: walletsImport, revoke: walletsRevoke, trust: walletsTrust, untrust: walletsUntrust },
    bare: wallets,
  },
  // Ember Phase 2 (BE-136). Local custody: every one of these reads or writes `vault.enc` on this
  // machine, and no API, relay or server ever sees a vault key (CC-08). `factor` and `phrase` take
  // a second word of their own, which their handlers route from the tokens dispatch hands them.
  vault: {
    subcommands: {
      init: vaultInit,
      status: vaultStatus,
      // BE-274 (D9): the listing. `status` is the report about the vault FILE and keeps printing
      // its keys in this release, with a line pointing here.
      list: vaultList,
      "new-key": vaultNewKey,
      // BE-259: one entry's label, and nothing else in the file, changes.
      rename: vaultRename,
      phrase: vaultPhrase,
      restore: vaultRestore,
      "reconcile-exposure": vaultReconcileExposure,
      factor: vaultFactor,
      // D5 (BE-241): `vault enroll <kind>` IS `vault factor add <kind>` -- the same handler, so it
      // inherits every flag, refusal and `--json` behaviour rather than reimplementing them. Four
      // words before an argument is what the operator typing from memory on a first-vault machine
      // pays, and that machine is exactly the one with no completions installed yet.
      enroll: vaultFactorAdd,
      backup: vaultBackup,
      "verify-backup": vaultVerifyBackup,
      "import-legacy": vaultImportLegacy,
      "retire-legacy": vaultRetireLegacy,
      transfer: vaultTransfer,
      promote: vaultPromote,
      // BE-285: many in-place promotions under one unlock and one reviewed acknowledgement.
      "promote-batch": vaultPromoteBatch,
      fund: vaultFund,
      demote: vaultDemote,
      "export-key": vaultExportKey,
    },
  },
  tee: {
    subcommands: {
      new: teeNew,
      enable: teeEnable,
      fund: teeFund,
      status: teeStatus,
      disable: teeDisable,
      sweep: teeSweep,
      // BE-303: owner-only, device token, never the vault.
      rebind: teeRebind,
      rebinds: teeRebinds,
    },
  },
  profile: {
    subcommands: {
      list: profileList,
      add: profileAdd,
      use: profileUse,
      rename: profileRename,
      remove: profileRemove,
      // BE-355 (D5): this profile's Solana RPC.
      set: profileSet,
    },
  },
  // Ember Phase 3 PR F (BE-226, R6): bring your own services. None of these acts as the Candle
  // identity or reaches Candle's API: the vault's external branch, the generic signer, the user's
  // own secrets, and the plug-ins that receive them.
  external: { subcommands: { new: externalNew, list: externalList, sweep: externalSweep } },
  sign: { subcommands: { message: signMessage }, bare: sign },
  secrets: { subcommands: { set: secretsSet, list: secretsList, remove: secretsRemove } },
  plugins: { bare: plugins },
  doctor: { bare: doctor },
  mcp: { bare: mcp },
  setup: { bare: setup },
  verify: { bare: verify },
  update: { bare: update },
  // D1/D7 (BE-238). Both are in the table so the drift test sees them and so `ROUTED_COMMANDS`
  // covers them, but neither is dispatched from the walk at the bottom of `runCommand`: they are
  // answered earlier, before any config is read. See the comment at that branch.
  completion: {
    subcommands: { zsh: completionZsh, bash: completionBash, fish: completionFish },
    bare: completion,
  },
  help: { bare: help },
}

/** Every command word the dispatch table routes. The guard's gate reads it so that an
 * unrecognized word prints usage without a network call. `index.test.ts`'s T1 asserts it against
 * `Object.keys(HELP)` (help.ts) in BOTH directions: every routed word has a topic screen, and
 * every topic screen routes. The old version of that test compared against the rendered help and
 * could only enforce one direction, so a command added to dispatch and documented nowhere passed
 * it and still ran unguarded. Reading the data rather than the rendering is what closes that. */
export const ROUTED_COMMANDS = new Set(Object.keys(COMMANDS))

/**
 * Command-word aliases, resolved to the canonical word BEFORE routing and before the guard reads
 * the command word. `wallet` -> `wallets`: the singular is the friendlier primary (the topic's
 * `display` in help.ts is it), but `wallets` is released and referenced by docs, skills and the MCP surface, so
 * it stays the canonical word every derived set (`ROUTED_COMMANDS`, `ROUTED_SUBCOMMANDS`, the
 * guard, dispatch) reasons about. An alias therefore inherits the canonical command's subcommands
 * and its guard for free. T1 maps `HELP`'s keys through this before comparing, and pins every
 * `display` to an alias entry, so the friendlier spelling on screen and the word dispatch accepts
 * can never come apart.
 */
export const ALIASES: Record<string, string> = { wallet: "wallets" }

/** The canonical command word for `word`, resolving an alias (own-property only, never a
 * prototype member) and passing everything else through unchanged. */
function canonicalCommand(word: string | undefined): string | undefined {
  return word !== undefined && Object.hasOwn(ALIASES, word) ? ALIASES[word] : word
}

/** The subcommands each command routes, for the words that have any (`doctor`, `mcp` and `setup`
 * take none and are absent). The guard reads it to tell an invocation that is about to RUN from
 * one that is about to print usage: `candle keys bogus` names no subcommand dispatch has, so it
 * gets usage without a verification request first. Derived from the table above, so it cannot
 * drift from the chain; T2 pins it against each topic's documented rows. */
export const ROUTED_SUBCOMMANDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(COMMANDS)
    .filter(([, route]) => route.subcommands !== undefined)
    .map(([word, route]) => [word, Object.keys(route.subcommands ?? {})]),
)

/**
 * Own-property lookups, never a bare index: `COMMANDS` and each subcommand map are plain objects,
 * so `COMMANDS["toString"]` and `subcommands["constructor"]` would otherwise find members of
 * Object.prototype. That made `candle toString` a "known" word (help alone, its own name never
 * echoed back) and `candle keys toString` find a "handler" that is not one and CALL it, returning
 * a string where an exit code belongs. Every such word is an unknown command like any other.
 */
function routeFor(word: string | undefined): CommandRoute | undefined {
  return word !== undefined && Object.hasOwn(COMMANDS, word) ? COMMANDS[word] : undefined
}

function subHandlerFor(route: CommandRoute | undefined, sub: string | undefined): CommandHandler | undefined {
  const subcommands = route?.subcommands
  if (!subcommands || sub === undefined || !Object.hasOwn(subcommands, sub)) return undefined
  return subcommands[sub]
}

/** Whether dispatch will hand this invocation to a command at all. False means the chain answers
 * `unknownCommand`, which needs no identity and must cost no request. Exported for T7, which
 * checks that every example on every topic screen names a command that actually runs. */
export function routesToCommand(cmd: string | undefined, sub: string | undefined): boolean {
  const route = routeFor(cmd)
  if (!route) return false
  if (subHandlerFor(route, sub) !== undefined) return true
  return route.bare !== undefined
}

/**
 * The commands the account guard never runs for, in one place. The rule is what a command does
 * with the identity: the guard belongs in front of the ones that ACT as it, and nowhere else.
 * `auth` in every form is the repair path (login re-authenticates a profile whose key moved,
 * status only reads, and logout revokes the stored key using that very credential); `doctor` only
 * reads, and is how a mismatch gets seen in the first place; `profile` manages the profiles map
 * rather than acting as an identity. Refusing any of these would leave an operator holding a
 * mismatch with no command left to diagnose or repair it with.
 *
 * `verify` is here for the plainest version of the same reason: it reads two files off disk and
 * checks a signature against the trusted root compiled into this binary. There is no key, no
 * request, and no account for a mismatch to be about.
 *
 * `setup` is deliberately NOT here: it skips its login step whenever both credentials are already
 * stored (setup.ts) and then mints keys as whoever those credentials belong to.
 *
 * `update` acts as no identity and must work before any login.
 *
 * `help` and `completion` (BE-238, D1/D7) read nothing and make no request, the same reason
 * `verify` is here. Membership alone is not what makes them work on a machine with no profile
 * selected -- this set only skips `verifyProfileAccount` below, and profile resolution runs
 * before it -- so they are also dispatched ahead of that resolution. Both halves are needed.
 */
export const NEVER_GUARDED = new Set([
  "auth",
  "profile",
  "doctor",
  "verify",
  "update",
  "help",
  "completion",
  // R6 (P3-AD-10): Candle is never a party to what these do. `external`, `sign`, `secrets` and
  // `plugins` act as no Candle identity and make no Candle request, and the guard's own request
  // would be one; a plug-in invocation is exempt for the same reason (`pluginInvocation`, plugins.ts).
  "external",
  "sign",
  "secrets",
  "plugins",
])

export async function run(argv: string[], deps: Deps): Promise<number> {
  const code = await runCommand(argv, deps)
  // After the command, never before or during: the notice must not interleave with command
  // output, and a command that failed still deserves to learn an update exists -- the fix for
  // its failure may BE the update. The command word rides along so `update` and `doctor`, whose
  // whole job is this question, never also nag.
  const extractedForNotice = extractGlobalFlags(argv)
  const word =
    "error" in extractedForNotice
      ? undefined
      : canonicalCommand(
          extractedForNotice.rest[0] === "candle" ? extractedForNotice.rest[1] : extractedForNotice.rest[0],
        )
  await maybeWriteUpdateNotice(deps, { command: word })
  return code
}

async function runCommand(argv: string[], deps: Deps): Promise<number> {
  const extracted = extractGlobalFlags(argv)
  if ("error" in extracted) {
    deps.stderr.write(`${extracted.error}\n`)
    return 2
  }
  const { rest, flags } = extracted

  // A plug-in (R6) takes the rest of the command line verbatim, so it is recognized on the raw argv
  // before the global-flag handling below can claim a `--json` or `--help` that belongs to it.
  const plugin = pluginInvocation(argv, deps.env, (word) => ROUTED_COMMANDS.has(canonicalCommand(word) ?? ""))
  if (plugin !== undefined) {
    const leading = extractGlobalFlags(argv.slice(0, argv.length - plugin.args.length - 1))
    const pluginFlags = "error" in leading ? flags : leading.flags
    const config = await migrateProfiles(deps)
    const resolution = resolveProfileName(config, { flag: pluginFlags.profile, env: deps.env })
    if (!resolution.ok) {
      writeLocalFailure(deps, { code: "PROFILE_UNRESOLVED", ...splitFix(resolution.message) }, pluginFlags.json)
      return 1
    }
    const profile = resolution.name
    const profileApiUrl = profile ? config.profiles?.[profile]?.apiUrl : config.apiUrl
    return runPlugin(plugin.name, plugin.args, {
      deps,
      json: pluginFlags.json,
      apiUrl: pluginFlags.apiUrl ?? resolveApiUrl(profileApiUrl, deps.env),
      apiUrlFlag: pluginFlags.apiUrl,
      profile,
      profileFlag: pluginFlags.profile,
      verifyAccount: false,
      vaultFactor: pluginFlags.vaultFactor,
      vaultDevice: pluginFlags.vaultDevice,
    })
  }

  // `bunx github:candledottv/agentic candle auth login` uses "candle" to RESOLVE the bin and then
  // passes that same token through as the CLI's own first argument, so argv here starts with the
  // bin's own name rather than a command. Dropping exactly one leading "candle" makes both
  // invocation forms dispatch identically; a second one (`candle candle auth`) is still an
  // unknown command, as it should be.
  const tokens = rest[0] === "candle" ? rest.slice(1) : rest

  if (flags.version) {
    // A command word left behind by a stripped `--version` is not a request for the version.
    // `candle update --version cli-v0.6.0` is what someone types straight after reading
    // install.sh, whose own pin flag IS `--version`: the flag was stripped here, this binary's
    // version was printed, the process exited 0, and nothing was updated. That reads as success.
    // The CLI's pin flag is `--to`, and this says so rather than obeying the wrong reading
    // silently. Bare `candle --version`, with no command word behind it, is untouched.
    const versionWord = canonicalCommand(tokens[0])
    if (versionWord !== undefined && ROUTED_COMMANDS.has(versionWord)) {
      const fix = "--version prints the CLI version; to pin a release use: candle update --to <tag>"
      writeUsageFailure(deps, fix, flags.json)
      return 2
    }
    deps.stdout.write(`${CLI_VERSION}\n`)
    return 0
  }
  // D1 (BE-238): the `--help` short-circuit stays exactly where it is -- BEFORE `migrateProfiles`
  // and `resolveProfileName` below -- which is why `candle --help` and `candle vault --help` have
  // always worked on a machine with several profiles and none selected. What changes is WHICH
  // screen: the command word that survived flag stripping selects its topic, and a word that is
  // not a command falls back to the top level, as a bare `candle --help` does.
  if (flags.help) {
    deps.stdout.write(renderTopic(canonicalCommand(tokens[0]) ?? "") ?? renderTopLevel())
    return 0
  }

  // An alias is resolved to its canonical word here, once, before anything reads `cmd`: routing,
  // the guard's command-word gate, and the unknown-command message all then see `wallets` for a
  // typed `wallet`. `sub` is untouched, so `wallet import` dispatches as `wallets import`.
  const [rawCmd, sub, ...cmdArgs] = tokens
  const cmd = canonicalCommand(rawCmd)

  // D1/D7 (BE-238): `help` and `completion` are answered HERE -- after the command word is known,
  // before `migrateProfiles` and `resolveProfileName` below. Being in `NEVER_GUARDED` is not
  // enough on its own: that set only skips `verifyProfileAccount`, and resolution runs first, so
  // on a machine with several profiles and none selected a routed `help vault` would be
  // `PROFILE_UNRESOLVED` while `vault --help` kept working. `isProfileCommand`'s skip below is
  // not the shape either -- it avoids `resolveProfileName` but still runs `migrateProfiles`,
  // which WRITES config. Help and completion must read and write nothing: they are how the
  // operator with no identity yet discovers CANDLE_CONFIG_DIR in the first place (BE-235, item 4).
  if (cmd === "help" || cmd === "completion") {
    return dispatch(cmd, sub, cmdArgs, tokens, {
      deps,
      json: flags.json,
      apiUrl: flags.apiUrl ?? resolveApiUrl(undefined, deps.env),
      apiUrlFlag: flags.apiUrl,
      profile: undefined,
      profileFlag: flags.profile,
      verifyAccount: !flags.noVerifyAccount,
      vaultFactor: flags.vaultFactor,
      vaultDevice: flags.vaultDevice,
    })
  }

  const config = await migrateProfiles(deps)
  // `auth login` resolves LENIENTLY about EXISTENCE (resolveProfileNameForLogin): its `--profile`
  // may name a profile to CREATE, so it must not be gated by resolveProfileName's "does this name
  // already exist" refusal, which exists to protect a command ACTING as an already-selected
  // identity. But it must still SEE the profile that is already selected: skipping resolution
  // entirely made every re-login derive a fresh host-based name, filing the new credentials under
  // `production-2` while every other command went on resolving `production`, and losing the
  // selected profile's own `apiUrl` in the bargain. See
  // docs/superpowers/specs/2026-08-19-cli-profiles-design.md, "auth login creates a profile
  // implicitly" (settled 2026-08-19). An invalid NAME is still refused: `authLogin` validates the
  // flag's shape itself (naming the flag in its message), and resolveProfileNameForLogin refuses
  // an invalid CANDLE_PROFILE the same way, below, as a usage error rather than a silent skip to
  // whatever profile was already active.
  const isAuthLogin = cmd === "auth" && sub === "login"
  // `profile` needs no resolved identity at all: its subcommands manage the profiles map itself
  // (list, add, and -- Tasks 3 and 4 -- use/rename/remove), and `profile use` is the way OUT of
  // resolveProfileName's "several profiles, none selected" refusal, so it cannot be gated by it.
  const isProfileCommand = cmd === "profile"
  const resolution = isAuthLogin
    ? resolveProfileNameForLogin(config, { flag: flags.profile, env: deps.env })
    : isProfileCommand
      ? ({ ok: true, name: undefined } as const)
      : resolveProfileName(config, { flag: flags.profile, env: deps.env })
  if (!resolution.ok) {
    // Both refusals go through render.ts's writers rather than straight to stderr: they happen
    // before any command owns the output stream, and a `--json` caller has to get the same
    // envelope on stdout it gets for every other failure instead of an unparseable exit. Human
    // mode is unchanged to the byte.
    //
    // A resolution failure reaching `auth login` is a usage error (an invalid CANDLE_PROFILE,
    // Task 6): exit 2, before any request. Every other command's refusal (an ambiguous or unknown
    // profile selection) stays exit 1, as it always has.
    if (isAuthLogin) {
      writeUsageFailure(deps, resolution.message, flags.json)
      return 2
    }
    writeLocalFailure(deps, { code: "PROFILE_UNRESOLVED", ...splitFix(resolution.message) }, flags.json)
    return 1
  }
  const profile = resolution.name
  const profileApiUrl = profile ? config.profiles?.[profile]?.apiUrl : config.apiUrl
  const apiUrl = flags.apiUrl ?? resolveApiUrl(profileApiUrl, deps.env)
  const ctx: CommandContext = {
    deps,
    json: flags.json,
    apiUrl,
    apiUrlFlag: flags.apiUrl,
    profile,
    profileFlag: flags.profile,
    verifyAccount: !flags.noVerifyAccount,
    vaultFactor: flags.vaultFactor,
    vaultDevice: flags.vaultDevice,
  }

  // The strict account guard (guard.ts), run once here rather than inside each command: a command
  // that ACTS as the resolved profile must first be told its stored key still belongs to that
  // profile's account, and that is one decision about the command being dispatched, not six
  // copies of one. NEVER_GUARDED names the commands that only read the identity or repair it,
  // which must keep working precisely when the guard would refuse.
  //
  // The rest of the gate is about what this invocation is about to DO. It pays a request only
  // when a command will actually run as the identity:
  //   - `routesToCommand` is false for a word or subcommand the chain answers with usage
  //     (`candle keys bogus`, `candle keys`), which acts as nobody.
  //   - `mcp --read-only` launches a server with no key at all, so there is no identity to verify
  //     (mcpActsAsIdentity; `--print-config` is deliberately still guarded).
  // Malformed FLAGS on an invocation that DOES route still pay for the check (`candle keys create
  // --bogus`, `candle mcp --tools nonsense`): the command owns its own flags, dispatch does not
  // parse them, and guessing at them here is how the gate would come to disagree with the command
  // about whether it was going to run.
  const word = cmd ?? ""
  const actsAsIdentity = word !== "mcp" || mcpActsAsIdentity(tokens.slice(1))
  if (ROUTED_COMMANDS.has(word) && !NEVER_GUARDED.has(word) && routesToCommand(cmd, sub) && actsAsIdentity) {
    const verdict = await verifyProfileAccount(ctx, config)
    if (!verdict.ok) {
      writeLocalFailure(
        deps,
        { code: "ACCOUNT_MISMATCH", message: verdict.message, suggestion: verdict.suggestion },
        flags.json,
      )
      return 1
    }
    // The warning stays on stderr in BOTH modes: the command is about to run and its own output
    // owns stdout, which under `--json` must carry exactly one JSON value.
    if (verdict.warning) deps.stderr.write(`${verdict.warning}\n`)
  }

  return dispatch(cmd, sub, cmdArgs, tokens, ctx)
}

/**
 * The dispatch walk itself: the command's subcommand, then its bare form, then the routing
 * failure. One copy, called from the end of `runCommand` and from the early `help`/`completion`
 * branch above, so the two cannot come to route the same invocation differently.
 */
async function dispatch(
  cmd: string | undefined,
  sub: string | undefined,
  cmdArgs: string[],
  tokens: string[],
  ctx: CommandContext,
): Promise<number> {
  const route = routeFor(cmd)
  const handler = subHandlerFor(route, sub)
  if (handler) return handler(cmdArgs, ctx)
  // tokens.slice(1), not cmdArgs: a bare command has no subcommand, so its first flag must not be
  // destructured away as one (`candle mcp --read-only`, `candle wallets --json`).
  if (route?.bare) return route.bare(tokens.slice(1), ctx)
  // A known word with a subcommand it does not have names the pair; with none typed, there is
  // nothing to be wrong about and help alone is the answer. Either way the screen is that
  // command's own topic, not the whole surface (D1).
  if (route) return unknownCommand(ctx.deps, sub === undefined ? undefined : `${cmd} ${sub}`, cmd)
  return unknownCommand(ctx.deps, cmd)
}

/**
 * Splits a profile-resolution refusal into the finding and the fix that follows it, for the
 * `--json` envelope's two fields. `resolveProfileName` owns the wording and is not changed for
 * this: its messages already end in a fix, either on the same line (" Run: candle auth login
 * --profile x") or as a block below it ("Profiles on this machine:" and the list).
 *
 * The cut is only ever made where `writeLocalFailure` puts the very same separator back -- a
 * newline before a multi-line suggestion, a space before a one-line one -- so human-mode output
 * is byte for byte what it was before any of this was split. Anything that does not fit that
 * stays whole, as one message with no suggestion.
 */
function splitFix(message: string): { message: string; suggestion?: string } {
  const newline = message.indexOf("\n")
  if (newline !== -1) {
    const suggestion = message.slice(newline + 1)
    return suggestion.includes("\n") ? { message: message.slice(0, newline), suggestion } : { message }
  }
  const fixAt = message.indexOf(" Run: ")
  return fixAt === -1 ? { message } : { message: message.slice(0, fixAt), suggestion: message.slice(fixAt + 1) }
}

/** Names the offending token before printing help, so "it printed usage" and "it did not
 * recognize THIS word" are distinguishable -- the runbook's bunx diagnostic reads the token back.
 * `undefined` means nothing was typed to be wrong about (a bare `candle`, or `candle auth` with
 * no subcommand), which gets help alone. Exit 1 either way: a routing failure, nothing ran.
 *
 * `word` is the command whose topic to print (D1): a routing failure INSIDE a known command shows
 * that command's screen, which is where the subcommand that was meant is listed. An unknown
 * command word has no topic, so the top level is the answer -- that is the screen listing the
 * words there are. Both go to stderr, as they always have. */
function unknownCommand(deps: Deps, token: string | undefined, word?: string): number {
  if (token !== undefined) deps.stderr.write(`Unknown command: ${token}\n`)
  deps.stderr.write((word === undefined ? undefined : renderTopic(word)) ?? renderTopLevel())
  return 1
}

/**
 * First run after the upgrade that introduced profiles: a pre-profile install becomes profile
 * "default" (config half in profiles.ts's migratedConfig), and its two secrets are COPIED to the
 * namespaced refs. The old refs and fields are left in place: a rollback to the previous CLI must
 * keep working, and a keychain entry is not ours to delete on someone's behalf. Silent on success.
 */
async function migrateProfiles(deps: Deps): Promise<CliConfig> {
  const before = await deps.readConfig()
  const { config, migrated } = migratedConfig(before)
  if (!migrated) return before
  for (const [legacyRef, kind] of [
    [SECRET_REFS.deviceToken, "deviceToken"],
    [SECRET_REFS.apiKey, "apiKey"],
  ] as const) {
    const value = await deps.store.get(legacyRef)
    if (value) await deps.store.set(profileSecretRef("default", kind), value)
  }
  await deps.writeConfig({ profiles: config.profiles, activeProfile: config.activeProfile })
  return config
}

/** Best-effort browser launch: `open` on macOS, `start` via `cmd` on Windows, `xdg-open`
 * elsewhere. Failure (no launcher on PATH, no display) is swallowed -- the URL is always printed
 * by the caller regardless, which is the actual guarantee for a headless/SSH session. Not unit
 * tested: it spawns a real OS process, the same reason secret-store.ts's
 * `promptHiddenPassphrase` (which needs a real TTY) is left untested; command tests inject their
 * own `openBrowser` fake instead (see `deps.openBrowser`). */
function realOpenBrowser(url: string): void {
  try {
    const platform = process.platform
    const child =
      platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Best-effort only.
  }
}

/**
 * Runs `candle-fido2` once (Ember Phase 2, BE-140). Three stdio pipes and nothing inherited, so the
 * helper can never see the terminal: its one request, PIN included, is written to its stdin and
 * the pipe is closed; its one response is read off stdout. Past `timeoutMs` it gets SIGTERM, then
 * SIGKILL two seconds later, and the caller reports the signal as a cancellation with nothing
 * derived. A process that cannot be started at all is reported as `spawnError` rather than thrown,
 * so the vault code can turn it into `VAULT_HELPER_MISSING` with the install instruction.
 */
/** What `spawnHelper` takes: the timeout, and argv for the two callers that pass one (BE-141). */
type SpawnOptions = { timeoutMs: number; args?: string[] }

/**
 * The working directory every helper is started in (BE-198). The root directory is chosen because
 * it is the one directory on both platforms that an unprivileged user cannot write into, and
 * because it is not inherited: a helper started here cannot be reached by anything the operator's
 * own folder happens to contain, whichever loader or library later resolves a relative path.
 *
 * Defense in depth, not the fix. The fix is that `candle-fido2` hands its loader absolute paths
 * only (`fido2-helper/library-paths.ts`); this makes the working directory worthless to a planted
 * file even if some future dependency of either helper does consult it.
 */
export const HELPER_WORKING_DIRECTORY = "/"

export function realSpawnHelper(path: string, requestLine: string, opts: SpawnOptions): Promise<HelperRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, opts.args ?? [], { stdio: ["pipe", "pipe", "pipe"], cwd: HELPER_WORKING_DIRECTORY })
    } catch (error) {
      resolve({ stdout: "", stderr: "", exitCode: null, signal: null, spawnError: messageOf(error) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    let settled = false
    const finish = (result: { exitCode: number | null; signal: string | null; spawnError?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ...result })
    }
    // `close` (every pipe drained) is the normal end. After the timeout the process is told to
    // stop, and if its pipes are still held open two seconds later (a grandchild it left behind),
    // the run is settled on what `exit` reported rather than waiting on a pipe nothing will close.
    let exited: { exitCode: number | null; signal: string | null } | undefined
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => {
        child.kill("SIGKILL")
        finish(exited ?? { exitCode: null, signal: "SIGTERM" })
      }, 2_000).unref()
    }, opts.timeoutMs)
    child.on("error", (error) => finish({ exitCode: null, signal: null, spawnError: messageOf(error) }))
    child.on("exit", (code, signal) => {
      exited = { exitCode: code, signal }
    })
    child.on("close", (code, signal) => finish({ exitCode: code, signal }))
    child.stdin?.on("error", () => {})
    child.stdin?.end(`${requestLine}\n`)
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The real `Deps` the bin entry runs with. Exported for index.test.ts: the update path's own
 * guarantees live in these implementations rather than in any command (the verifier seam stays
 * unset; `writeBytes` is 0755 and refuses an existing path), and a suite built entirely on fakes
 * cannot see them. */
export async function buildRealDeps(): Promise<Deps> {
  const { store, backend } = await resolveSecretStore()
  // R6: the user's own secrets, in a namespace of their own (a separate keychain service, or a
  // separate encrypted file), resolved on the same backend rule as the credential store.
  const { store: secretsStore } = await resolveSecretStore(process.platform, {
    service: SECRETS_SERVICE,
    filePath: defaultSecretsPath(process.env),
  })
  return {
    fetch: globalThis.fetch,
    store,
    secretsStore,
    backend,
    readConfig,
    writeConfig,
    clearConfig,
    updateProfile,
    stdout: {
      write: (chunk: string) => {
        process.stdout.write(chunk)
      },
    },
    stderr: {
      write: (chunk: string) => {
        process.stderr.write(chunk)
      },
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: realOpenBrowser,
    env: process.env,
    nodeVersion: process.versions.node,
    hostname: hostname(),
    // The real home, so every default path is the path this CLI has always built (BE-274, D1).
    // Only `createTestDeps` injects anything else.
    homedir,
    // Imported lazily so the MCP server and its transport are only pulled in when `candle mcp`
    // actually runs. The module is bundled into this binary either way, but `./server` connects a
    // transport the moment it is asked to run, and every other command should stay untouched by
    // that. A static import would also make the server's own module graph part of startup for
    // `candle --version`.
    // BE-391 (Phase 4b, D1): the sealed EVM record's writer, for BE-392's leg loop.
    appendEvmRecord: appendEvmRecordForTrade,
    runMcpServer: async (env) => {
      const { runStdioServer } = await import("../../mcp/src/server")
      await runStdioServer(env)
    },
    readFile: (path: string) => readFile(path, "utf8"),
    readBytes: (path: string) => readFile(path),
    readStdin: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = []
        process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk))
        process.stdin.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
        process.stdin.on("error", reject)
        process.stdin.resume()
      }),
    runPlugin: realRunPlugin,
    // 0600: the only caller is wallets import's --signer-out, and the content is a signing
    // private key.
    writeFile: (path: string, content: string) => writeFile(path, content, { mode: 0o600 }),
    promptSecret: promptHiddenSecret,
    promptLine: promptVisibleLine,
    isTTY: {
      stdin: Boolean(process.stdin.isTTY),
      stdout: Boolean(process.stdout.isTTY),
      stderr: Boolean(process.stderr.isTTY),
    },
    execPath: process.execPath,
    argv1: process.argv[1] ?? "",
    platformKey: platformKey(process.platform, process.arch),
    platform: process.platform,
    arch: process.arch,
    realpath: (path) => realpath(path),
    spawnHelper: realSpawnHelper,
    releasePolicy: RELEASE_POLICY,
    // `flag: "wx"` refuses an existing path instead of truncating it. The only caller is
    // `update`, writing a fresh random temp name beside the binary: a path that already exists
    // there is either a collision or somebody else's file, and neither is ours to overwrite and
    // then rename over the running binary. The chmod follows the write because `mode` is masked
    // by the process umask.
    writeBytes: async (path, bytes) => {
      await writeFile(path, bytes, { flag: "wx", mode: 0o755 })
      await chmod(path, 0o755)
    },
    rename: (from, to) => rename(from, to),
    unlink: (path) => unlink(path),
  }
}

async function main(): Promise<void> {
  const deps = await buildRealDeps()
  // Set, not exited (BE-299). `process.exit` ends the process before a pending pipe write has
  // drained: to a pipe, `process.stdout.write` hands the kernel one buffer (64 KiB) and finishes
  // the rest from the event loop, and exiting in the same turn discarded everything past that
  // buffer while still reporting the command's code. Returning lets the runtime exit once both
  // streams are drained, which is the documented contract for `exitCode`. The compiled-binary
  // test drives `candle` through a real pipe with a slow reader and is the check that this stays.
  process.exitCode = await run(process.argv.slice(2), deps)
}

// Only run the bin entry when this module is executed directly, not when a test imports `run`.
// `process.argv[1]` is the entry script's path either way (bun test's own runner when imported by
// a test, this file's own path when run directly), so comparing it against `import.meta.url`
// distinguishes the two under both bun and plain node -- unlike `import.meta.main`, which bun
// supports but node does not.
//
// argv[1] must be REALPATH'd before comparing: package managers execute a bin through a symlink
// (node_modules/.bin/candle -> .../packages/cli/dist/index.js), and node resolves import.meta.url
// to the real file while argv[1] keeps the symlink path. Without the realpath, every bunx/npx
// invocation failed this guard and exited 0 having done nothing -- caught live by the P4b-3
// acceptance test, invisible to any test that ran the file by its direct path.
function entryHref(argv1: string): string {
  try {
    return pathToFileURL(realpathSync(argv1)).href
  } catch {
    // argv[1] may not exist as a file at all (some embedders pass synthetic values); fall back to
    // the plain comparison, which is what this guard always did for the direct-path case.
    return pathToFileURL(argv1).href
  }
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === entryHref(process.argv[1])
if (isMainModule) {
  // The reader went away (`candle ... | head`): nothing to report, and the command's own exit code
  // stands. Under node an unhandled EPIPE would otherwise end the process with a stack trace and
  // exit 1 now that the write outlives the command (BE-299, D3). Any other stream error is
  // reported once, in the same form as the catch below, and is an exit 1. `reported` is shared by
  // both listeners, so stdout and stderr together produce one line. A non-EPIPE error on stderr
  // sets the code and does not write: the line would go back into the stream that just failed.
  // T2 pins EPIPE only; a non-EPIPE error is not tested (§8).
  let reported = false
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EPIPE") return
      if (reported) return
      reported = true
      process.exitCode = 1
      if (stream === process.stderr) return
      process.stderr.write(`Unexpected error: ${err?.message ?? String(err)}\n`)
    })
  }
  // AWAITED at the top level, not fired and forgotten (Ember Phase 2, BE-136, T49). Under Bun a
  // pending WebCrypto operation does not by itself keep the process alive, and a hidden prompt
  // leaves stdin paused once it closes, so a command that prompts and then awaits `crypto.subtle`
  // (every vault unlock does: the KDF, then the key unwrap) had nothing holding the process open
  // and exited 0 mid-command with nothing printed -- on a real terminal, in the compiled binary
  // and under `bun run` alike, while every in-process test passed because the test runner's own
  // work kept the loop alive. A pending top-level await holds the process until `main` settles,
  // whatever handles the loop happens to have. The parity test drives the compiled binary on a
  // pseudo-terminal and is the check that this line stays.
  await main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
