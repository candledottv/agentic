/** Human summaries shared by key creation and device login. JSON never uses these. */

import { sortAgentKeyScopes } from "../agent-key-access"
import type { Deps } from "../deps"
import { dim, displayWidth, fields, heading, padDisplay, type TerminalStyle, terminalStyle } from "../presentation"
import {
  type ErrorFix,
  type ErrorRenderContext,
  errorParts,
  formatScopesForSummary,
  renderErrorBlock,
  writeFailure,
  writeLocalFailure,
  writeUsageFailure,
} from "../render"

export function scopeSummary(scopes: readonly string[], style: TerminalStyle, title = "Scopes"): string {
  const rows = sortAgentKeyScopes(scopes).map((scope): [string, string] => {
    const summary = formatScopesForSummary([scope])
    return [scope, summary === scope ? "" : summary.slice(scope.length + 2, -1)]
  })
  const width = Math.max(0, ...scopes.map(displayWidth))
  const lines = rows.flatMap(([scope, note]) =>
    note ? fields([[padDisplay(scope, width), note]], style, 4) : [`    ${dim(scope, style)}`],
  )
  return `\n${heading(title, style)}\n${lines.join("\n")}\n`
}

export function embeddedWalletSummary(permission: "allowed" | "denied"): string {
  return permission === "allowed"
    ? "allowed (Candle signs trades with swap:write, launches with launch:write, transfers only with transfer:write)"
    : "denied (cannot spend the account's embedded wallet)"
}

/** Kit errors for these screens; preserve the existing machine envelope and stderr stream. */
export function writeScreenFailure(
  deps: Deps,
  result: Parameters<typeof writeFailure>[1],
  context: ErrorRenderContext,
  json: boolean,
): void {
  if (json) writeFailure(deps, result, context, json)
  else deps.stderr.write(`${renderErrorBlock(errorParts(result, context), terminalStyle(deps, "stderr")).join("\n")}\n`)
}

export function writeScreenLocalFailure(
  deps: Deps,
  failure: Parameters<typeof writeLocalFailure>[1],
  json: boolean,
): void {
  if (json) writeLocalFailure(deps, failure, json)
  else writeScreenMessage(deps, failure.message, failure.suggestion)
}

/**
 * A usage error on these screens. `message` is the `--json` envelope text and is written whole,
 * on stdout, so a caller that already reads the sentence still sees the repair commands there.
 * Pass `screen` when that sentence also names repairs: the human message stays the fact, and
 * each repair is its own line (audit rule 8). Exit 2 stays at the call site. Stderr stays empty
 * in `--json` mode.
 */
export function writeScreenUsageFailure(
  deps: Deps,
  message: string,
  json: boolean,
  screen?: { message: string; fixes: readonly ErrorFix[] },
): void {
  if (json) writeUsageFailure(deps, message, json)
  else if (screen) {
    deps.stderr.write(
      `${renderErrorBlock({ message: screen.message, fixes: [...screen.fixes] }, terminalStyle(deps, "stderr")).join("\n")}\n`,
    )
  } else writeScreenMessage(deps, message)
}

export function writeScreenMessage(deps: Deps, message: string, suggestion?: string): void {
  const fixes = suggestion
    ? [suggestion.startsWith("Run: ") ? { label: "Run", command: suggestion.slice(5) } : { label: suggestion }]
    : []
  deps.stderr.write(`${renderErrorBlock({ message, fixes }, terminalStyle(deps, "stderr")).join("\n")}\n`)
}
