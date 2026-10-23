/**
 * `candle tui` (BE-1665, spec C-1): the thin entry that starts the Candle TUI, `candle-tui`, on this
 * terminal. The TUI starts the core (`candle core serve`, this binary) when it is not running and
 * launches the views. It ships in its own package (`@candledottv/tui`) so the views and the bundled
 * Pi agent stay out of this binary, and that package never imports the keychain or the vault.
 *
 * The TUI gets an environment built from empty: where the config lives, which profile, the
 * terminal, and the encrypted-file store's passphrase when one is set, so the core it starts can
 * open the store. Never `CANDLE_API_KEY` or `CANDLE_DEVICE_TOKEN`: the TUI holds no key.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { findPlugin } from "../plugins"
import { writeLocalFailure, writeUsageFailure } from "../render"

const PASSED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "TZ",
  "LANG",
  "LC_ALL",
  "CANDLE_CONFIG_DIR",
  "CANDLE_KEYRING_PASSPHRASE",
  "NO_COLOR",
]

export async function tui(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\nUsage: candle tui [--profile <name>]`, json)
    return 2
  }
  if (
    json ||
    !deps.isTTY.stdin ||
    !deps.isTTY.stdout ||
    deps.env.TERM === "dumb" ||
    deps.presentation?.plain ||
    deps.env.CANDLE_PLAIN === "1"
  ) {
    writeLocalFailure(
      deps,
      {
        code: "TUI_REQUIRES_TERMINAL",
        message: "The Candle TUI needs an interactive terminal.",
        suggestion: "Use candle portfolio or candle help for command-line output.",
      },
      json,
    )
    return 1
  }
  const path = findPlugin("tui", deps.env.PATH)
  if (path === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "TUI_NOT_INSTALLED",
        message: "The Candle TUI (candle-tui) is not on PATH.",
        suggestion:
          "It is a preview and not released yet; from a checkout, run bun packages/tui/src/bin.tsx --candle <this candle>.",
      },
      json,
    )
    return 1
  }
  const env: Record<string, string> = {}
  for (const name of PASSED) {
    const value = deps.env[name]
    if (value !== undefined) env[name] = value
  }
  if (deps.presentation?.noColor) env.NO_COLOR = "1"
  // The profile resolved for this invocation, and this candle, so the TUI starts the same core.
  const candle = deps.execPath.endsWith("/node") || deps.execPath.endsWith("/bun") ? "candle" : deps.execPath
  return deps.runPlugin(path, [...(ctx.profile ? ["--profile", ctx.profile] : []), "--candle", candle], env)
}
