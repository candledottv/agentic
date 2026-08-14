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
}

export interface ParsedArgs {
  values: Record<string, string>
  booleans: Set<string>
  positionals: string[]
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
    const arg = args[i]
    if (arg === undefined) continue
    if (valueFlags.has(arg)) {
      const value = args[++i]
      // A missing value, or the next token itself looking like a flag (starts with "-"), is a
      // usage error rather than silently consuming that next flag as this one's value -- e.g.
      // `auth login --scopes --no-browser` must not swallow --no-browser as a scope string.
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` }
      values[arg] = value
    } else if (booleanFlags.has(arg)) {
      booleans.add(arg)
    } else if (arg.startsWith("-")) {
      return { error: `Unknown flag: ${arg}` }
    } else {
      positionals.push(arg)
    }
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
