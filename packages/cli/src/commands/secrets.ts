/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-10): `candle secrets set|list|remove <name>`.
 *
 * The user's own third-party API keys (an exchange, a DEX, a data service, a privacy service: the
 * CLI does not know or ask which), stored in the OS keychain under the active profile and under a
 * keychain service of their own, `SECRETS_SERVICE`, distinct from the one holding Candle's
 * credentials. A secret is read on a hidden prompt, never sent to Candle, never logged, and never
 * printed after `set`; `list` shows names only. A plug-in receives a secret only when the
 * invocation names it (`candle <plugin> --secret <name>`), as `CANDLE_SECRET_<NAME>` in its
 * environment, and reads neither keychain namespace itself.
 */
import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { renderTable, writeLocalFailure, writeUsageFailure } from "../render"

/** A name is an environment-variable suffix: letters, digits and underscores, uppercased. */
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** The canonical name: uppercase, so `binance_key` and `BINANCE_KEY` are one secret. */
export function canonicalSecretName(raw: string): string | undefined {
  if (!NAME_SHAPE.test(raw)) return undefined
  return raw.toUpperCase()
}

/** `profile:<name>:secret:<NAME>`, or `secret:<NAME>` in the pre-profile mode. */
export function secretRef(profile: string | undefined, name: string): string {
  return profile === undefined ? `secret:${name}` : `profile:${profile}:secret:${name}`
}

/** The names on record for this profile, from the non-secret config (values live in the keychain). */
export async function storedSecretNames(deps: Deps, profile: string | undefined): Promise<string[]> {
  const config = await deps.readConfig()
  const names = profile === undefined ? config.secretNames : config.profiles?.[profile]?.secretNames
  return [...(names ?? [])].sort()
}

async function writeSecretNames(deps: Deps, profile: string | undefined, names: string[]): Promise<void> {
  const sorted = [...new Set(names)].sort()
  if (profile === undefined) await deps.writeConfig({ secretNames: sorted })
  else await deps.updateProfile(profile, { secretNames: sorted })
}

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

export async function secretsSet(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [raw, extra] = parsed.positionals
  if (!raw || extra !== undefined) return usage(ctx, "Usage: candle secrets set <name>")
  const name = canonicalSecretName(raw)
  if (name === undefined) {
    return usage(ctx, `A secret name is letters, digits and underscores, starting with a letter: ${raw}`)
  }
  if (!ctx.deps.isTTY.stdin || !ctx.deps.isTTY.stdout) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "SECRET_REQUIRES_TTY",
        message: "candle secrets set reads the value from a hidden prompt on a terminal and from nowhere else.",
        suggestion: "There is no environment variable and no flag that supplies a secret's value.",
      },
      ctx.json,
    )
    return 1
  }
  const value = await ctx.deps.promptSecret(`Value for ${name} (input hidden): `)
  if (value.length === 0) return usage(ctx, "An empty value was typed; nothing was stored.")
  try {
    await ctx.deps.secretsStore.set(secretRef(ctx.profile, name), value)
  } catch (error) {
    writeLocalFailure(
      ctx.deps,
      { code: "SECRET_STORE_FAILED", message: error instanceof Error ? error.message : String(error) },
      ctx.json,
    )
    return 1
  }
  await writeSecretNames(ctx.deps, ctx.profile, [...(await storedSecretNames(ctx.deps, ctx.profile)), name])
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, name, backend: ctx.deps.backend })}\n`)
    return 0
  }
  ctx.deps.stdout.write(
    `Stored ${name} in the ${ctx.deps.backend} secrets namespace. It is never sent to Candle and never shown again; a plug-in receives it as CANDLE_SECRET_${name} only when you pass --secret ${name}.\n`,
  )
  return 0
}

export async function secretsList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const names = await storedSecretNames(ctx.deps, ctx.profile)
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, names, backend: ctx.deps.backend })}\n`)
    return 0
  }
  if (names.length === 0) {
    ctx.deps.stdout.write("No secrets stored. Add one: candle secrets set <name>\n")
    return 0
  }
  ctx.deps.stdout.write(
    `${renderTable(
      ["Name", "Passed to a plug-in as"],
      names.map((n) => [n, `CANDLE_SECRET_${n}`]),
    )}\n`,
  )
  return 0
}

export async function secretsRemove(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [raw, extra] = parsed.positionals
  if (!raw || extra !== undefined) return usage(ctx, "Usage: candle secrets remove <name>")
  const name = canonicalSecretName(raw)
  if (name === undefined) {
    return usage(ctx, `A secret name is letters, digits and underscores, starting with a letter: ${raw}`)
  }
  await ctx.deps.secretsStore.delete(secretRef(ctx.profile, name))
  const names = await storedSecretNames(ctx.deps, ctx.profile)
  await writeSecretNames(
    ctx.deps,
    ctx.profile,
    names.filter((n) => n !== name),
  )
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, name, removed: names.includes(name) })}\n`)
    return 0
  }
  ctx.deps.stdout.write(names.includes(name) ? `Removed ${name}.\n` : `No secret named ${name} was stored.\n`)
  return 0
}
