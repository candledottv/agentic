/**
 * A single, shared CLI argument parser used by every command (fix round 1, item 3): an
 * unrecognized flag must reject with a usage error, exit 2, BEFORE any remote call, on every
 * command -- not just the two that happened to validate their own flags before this fix. A typo
 * like `auth logout --keep-keys` must never silently fall through to the default behavior of the
 * flag it was meant to be (here, that default is "proceed with the remote revoke", which is
 * exactly the destructive case this closes).
 */

export interface ArgSpec {
  /** Flags that take a value, e.g. "--scopes". */
  valueFlags?: string[]
  /** Flags that are present/absent only, e.g. "--no-browser". */
  booleanFlags?: string[]
  /**
   * The subset of `valueFlags` whose value is a filesystem path this CLI will read or write (D4).
   * Naming them per command is the point: `--to` is a file on `vault backup` and a key label on
   * `external sweep`, and `--from` is a file on `vault import-legacy` and a label on `vault
   * transfer`, so the rule follows the value's MEANING and cannot live in one global list of flag
   * names. Listed here, the tilde refusal runs at parse time -- before any prompt and before any
   * file is touched -- rather than as a line each handler could forget.
   */
  pathFlags?: string[]
  /**
   * Positional arguments that are filesystem paths, by index, named as the help spells them
   * (`["<path>"]` for `vault verify-backup <path>`). An empty string at an index means that
   * positional is not a path.
   */
  pathPositionals?: string[]
}

export interface ParsedArgs {
  values: Record<string, string>
  booleans: Set<string>
  positionals: string[]
}

/**
 * Short forms, expanded to the long flag before anything else reads the token (D5, BE-241). The
 * expansion applies only where the long form is in THIS command's `valueFlags`, so `-k` is
 * `--keystore` on the ~25 commands that take a keystore and stays `Unknown flag: -k` everywhere
 * else -- a short form that silently meant nothing on some commands would be worse than no short
 * form. `-k=<path>` is not accepted, matching a parser that takes no `--flag=value` form either.
 */
export const SHORT_FLAGS: Record<string, string> = { "-k": "--keystore" }

/** The tail every literal-tilde refusal ends with (D4). One copy: the flag form and the
 * `CANDLE_CONFIG_DIR` form differ only in what they name and in "the path" vs "the value". */
const TILDE_TAIL =
  'begins with a literal "~", which the shell did not expand and candle will not guess at. Use an absolute path, or set CANDLE_CONFIG_DIR. Nothing was read or written.'

/**
 * D4 (BE-241): a path that still begins with a literal `~` is REFUSED, never expanded.
 *
 * `--keystore ~t47/vault.enc` reached `writeFile` as typed in 0.11.0, because a shell leaves
 * `~t47` alone when no user `t47` exists and leaves `"~/x"` alone inside double quotes. That is
 * how `vault init` created a directory literally named `~t47` in the working directory, one `cd`
 * away from being unfindable. Guessing at a path that holds keys is worse than stopping.
 *
 * `name` is either a flag (`--keystore`), a positional as the help spells it (`<path>`) or an
 * environment variable (`CANDLE_CONFIG_DIR`); the variable form is named `NAME=value` and speaks
 * of "the value", every other form is named `name value` and speaks of "the path". Returns the
 * usage message, or undefined when there is nothing to refuse.
 */
export function refuseUnexpandedTilde(name: string, value: string): string | undefined {
  if (!value.startsWith("~")) return undefined
  const isEnvVar = /^[A-Z][A-Z0-9_]*$/.test(name)
  const subject = isEnvVar ? "the value" : "the path"
  return `${isEnvVar ? `${name}=${value}` : `${name} ${value}`}: ${subject} ${TILDE_TAIL}`
}

/**
 * A usage refusal thrown from somewhere that cannot return one. The only thrower is
 * `candleConfigDir` (D4): it builds every default path and its ~40 callers all take a string, so
 * the literal-tilde refusal for `CANDLE_CONFIG_DIR` has nowhere to go but up. `vaultPathFor` turns
 * it back into the `{ error }` its callers already handle; `writeVaultFailure`, `resolveTeeAddress`
 * and the TEE-store path helper map any that reaches them to the same `USAGE` envelope and exit 2
 * a mistyped flag gets. It must not escape `run()`.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function isUsageError(error: unknown): error is UsageError {
  return error instanceof UsageError
}

/**
 * Parses `args` against `spec`. Anything starting with "-" that isn't a recognized flag is a
 * usage error (unknown flag); a recognized value-flag with nothing after it is also a usage
 * error (missing value). Everything else is a positional argument -- the caller validates how
 * many it expects (most commands expect none; `keys revoke` expects exactly one).
 */
export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs | { error: string } {
  const valueFlags = new Set(spec.valueFlags ?? [])
  const booleanFlags = new Set(spec.booleanFlags ?? [])
  const values: Record<string, string> = {}
  const booleans = new Set<string>()
  const positionals: string[] = []

  for (let i = 0; i < args.length; i++) {
    const typed = args[i]
    if (typed === undefined) continue
    // The token as the operator typed it is what every error message names ("-k requires a
    // value", not "--keystore requires a value"); `arg` is what the parsed result is keyed by.
    const long = SHORT_FLAGS[typed]
    const arg = long !== undefined && valueFlags.has(long) ? long : typed
    if (valueFlags.has(arg)) {
      const value = args[++i]
      // A missing value, or the next token itself looking like a flag (starts with "-"), is a
      // usage error rather than silently consuming that next flag as this one's value -- e.g.
      // `auth login --scopes --no-browser` must not swallow --no-browser as a scope string.
      if (!value || value.startsWith("-")) return { error: `${typed} requires a value` }
      values[arg] = value
    } else if (booleanFlags.has(arg)) {
      booleans.add(arg)
    } else if (typed.startsWith("-")) {
      return { error: `Unknown flag: ${typed}` }
    } else {
      positionals.push(typed)
    }
  }

  // D4, at parse time: before any prompt, before any file is opened. A flag whose value is a path
  // is refused here so the operator never types a passphrase for a path that is about to be
  // rejected -- the principle `vault export-key` already states for its destination rules.
  for (const flag of spec.pathFlags ?? []) {
    const value = values[flag]
    if (value === undefined) continue
    const refusal = refuseUnexpandedTilde(flag, value)
    if (refusal !== undefined) return { error: refusal }
  }
  for (const [index, name] of (spec.pathPositionals ?? []).entries()) {
    const value = positionals[index]
    if (name === "" || value === undefined) continue
    const refusal = refuseUnexpandedTilde(name, value)
    if (refusal !== undefined) return { error: refusal }
  }

  return { values, booleans, positionals }
}

/** Parses a comma-separated `--scopes` value into a trimmed, non-empty list. Shared by `auth
 * login` and `keys create`, the two commands that accept a `--scopes` flag. */
export function parseScopesList(raw: string): string[] {
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
}

/** Mirrors the portal's `parseUsdAmount` (apps/frontend .../key-usage-format.ts), duplicated here
 * since the CLI has zero runtime dependencies and no cross-package import -- same convention as
 * `ALL_AGENT_SCOPES` in render.ts. Accepts "$1,500" / "1500" / "0.5"; rejects blank, non-numeric,
 * and non-positive amounts. Returns integer micro-USD, the unit `POST /keys`'s txLimit speaks. */
export function parseUsdToMicros(raw: string): { ok: true; usdMicros: number } | { ok: false; message: string } {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "")
  if (cleaned.length === 0) return { ok: false, message: "--tx-limit requires a dollar amount, for example 100." }
  const usd = Number(cleaned)
  if (!Number.isFinite(usd)) return { ok: false, message: `--tx-limit is not a dollar amount: ${raw}` }
  const usdMicros = Math.round(usd * 1_000_000)
  if (usdMicros <= 0) return { ok: false, message: "--tx-limit must be greater than $0." }
  return { ok: true, usdMicros }
}

/** `--reset` cadences `POST /keys`'s txLimit accepts, mirroring the portal's create form. */
export const TX_LIMIT_RESETS = ["daily", "weekly", "monthly", "never"] as const
export type TxLimitReset = (typeof TX_LIMIT_RESETS)[number]

/** Parses `--expires-in`: a positive integer count of days. */
export function parseExpiresInDays(raw: string): { ok: true; days: number } | { ok: false; message: string } {
  const days = Number(raw.trim())
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, message: `--expires-in must be a positive whole number of days, got: ${raw}` }
  }
  return { ok: true, days }
}
