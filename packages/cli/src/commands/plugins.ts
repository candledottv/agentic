/**
 * Ember Phase 3 PR F (BE-226, R6): `candle plugins`, and the dispatch of `candle <plugin>`.
 *
 * `plugins` lists the `candle-<name>` executables on `PATH`. `runPlugin` is what dispatch calls
 * when a command word is not built in and such an executable exists: it resolves the `--secret`
 * and `--wallet` names the invocation carries (the secrets from the user's own keychain namespace,
 * the wallets from the vault's `role: "external"` entries, which needs the vault opened), builds
 * the allowlist environment, and runs the plug-in on this terminal with the rest of the arguments
 * verbatim. Nothing of Candle's reaches the child: no API key, no device token, no passphrase, no
 * private key, and no inherited `CANDLE_*` variable of any kind (`plugins.ts`).
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { findPlugin, listPlugins, pluginEnvironment, splitPluginArgs } from "../plugins"
import { renderTable, writeLocalFailure, writeUsageFailure } from "../render"
import { resolveSolanaEndpoint } from "../solana-endpoint"
import { closeVault } from "../vault/store"
import { secretRef } from "./secrets"
import {
  describeRole,
  findExternalEntry,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
} from "./vault-support"

/** The one network every external wallet is on; passed to a plug-in as `CANDLE_PLUGIN_NETWORK`. */
export const PLUGIN_NETWORK = "solana-mainnet"

export async function plugins(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(ctx.deps, `Unexpected argument: ${parsed.positionals[0]}`, ctx.json)
    return 2
  }
  const found = listPlugins(ctx.deps.env.PATH)
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, plugins: found })}\n`)
    return 0
  }
  if (found.length === 0) {
    ctx.deps.stdout.write(
      "No plug-ins found. An executable named candle-<name> on your PATH runs as: candle <name> [--secret <name>]... [--wallet <label>]... [args]\n",
    )
    return 0
  }
  ctx.deps.stdout.write(
    `${renderTable(
      ["Command", "Executable"],
      found.map((plugin) => [`candle ${plugin.name}`, plugin.path]),
    )}\n`,
  )
  return 0
}

/**
 * Runs `candle <name> ...`. `rawArgs` is everything after the plug-in name on the ORIGINAL command
 * line, global flags included, because those belong to the plug-in from there on.
 */
export async function runPlugin(name: string, rawArgs: string[], ctx: CommandContext): Promise<number> {
  const path = findPlugin(name, ctx.deps.env.PATH)
  if (path === undefined) {
    writeLocalFailure(
      ctx.deps,
      { code: "PLUGIN_NOT_FOUND", message: `No candle-${name} executable on PATH.` },
      ctx.json,
    )
    return 1
  }
  const split = splitPluginArgs(rawArgs)
  if ("error" in split) {
    writeUsageFailure(ctx.deps, split.error, ctx.json)
    return 2
  }

  const secrets: Record<string, string> = {}
  for (const requested of split.secrets) {
    const name = requested.toUpperCase()
    const value = await ctx.deps.secretsStore.get(secretRef(ctx.profile, name))
    if (value === null) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "SECRET_MISSING",
          message: `No secret named ${name} is stored for this profile.`,
          suggestion: `Store it first: candle secrets set ${name}`,
        },
        ctx.json,
      )
      return 1
    }
    secrets[name] = value
  }

  const wallets: Record<string, string> = {}
  if (split.wallets.length > 0) {
    // Addresses live inside the encrypted index, so naming a wallet means opening the vault. The
    // vault is closed again before the child starts: it receives addresses and nothing else.
    if (!refuseEnvPassphrase(ctx)) return 1
    if (!requireTty(ctx, "candle <plugin> --wallet")) return 1
    // No `--keystore` on a plug-in invocation: the vault is wherever CANDLE_CONFIG_DIR or the
    // default puts it, and a `~`-prefixed CANDLE_CONFIG_DIR is refused here as anywhere (D4).
    const resolvedVault = vaultPathFor(ctx, { values: {}, booleans: new Set(), positionals: [] })
    if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
    const vaultPath = resolvedVault.path
    const resolved = await runVaultCommand(ctx, async ({ hold }) => {
      const raw = await requireVaultRaw(ctx, resolvedVault)
      const vault = hold((await unlockInteractively(ctx, vaultPath, raw)).vault)
      for (const requested of split.wallets) {
        const entry = findExternalEntry(vault.index, requested)
        if (entry === undefined) {
          const other = vault.index.entries.find((e) => e.label === requested || e.address === requested)
          writeLocalFailure(
            ctx.deps,
            {
              code: "PLUGIN_WALLET_NOT_EXTERNAL",
              message:
                other === undefined
                  ? `No external wallet in this vault matches --wallet ${requested}.`
                  : `${requested} is ${describeRole(other)}; only an external wallet's address is passed to a plug-in.`,
              suggestion: "Create one: candle external new --label <name>",
            },
            ctx.json,
          )
          return 1
        }
        wallets[entry.label] = entry.address
      }
      closeVault(vault)
      return 0
    })
    if (resolved !== 0) return resolved
  }

  // BE-355 (D6): the resolver's first sources in decision 5's order, CANDLE_SOLANA_RPC_URL then
  // the profile's rpcUrl (`--rpc-url` is not a CLI flag on a plug-in invocation). The public
  // default is NOT injected: the CLI makes no request on a plug-in's behalf, so it could neither
  // disclose the host before the plug-in's first request nor turn its 429 into RPC_RATE_LIMITED.
  const endpoint = resolveSolanaEndpoint(ctx, undefined, await ctx.deps.readConfig())
  if ("error" in endpoint) {
    writeUsageFailure(ctx.deps, endpoint.error, ctx.json)
    return 2
  }
  const env = pluginEnvironment({
    parentEnv: ctx.deps.env,
    rpcUrl: endpoint.source === "default" ? undefined : endpoint.url,
    network: PLUGIN_NETWORK,
    wallets,
    secrets,
  })
  return ctx.deps.runPlugin(path, split.passthrough, env)
}
