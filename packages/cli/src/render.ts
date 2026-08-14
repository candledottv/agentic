/**
 * render: the CLI's plain fixed-width table helper, the human error-message mapping, scope-label
 * formatting, and the portal-URL helper. Every human-mode error message routes through
 * `renderError`; `--json` mode never touches this file's human-facing output at all (see
 * `writeFailure`, which is the one place that branches between the two).
 */

import { DEFAULT_API_URL } from "./client"

/** Mirrors `apps/api/src/lib/agent-keys.ts`'s `AGENT_KEY_SCOPES`, duplicated here since the CLI
 * has zero runtime dependencies and no cross-package import (spec decision 4: the CLI is
 * standalone). Order matches the API's own array. */
export const ALL_AGENT_SCOPES = ["launch:write", "launch:read", "activity:write", "swap:write"] as const
export type AgentScope = (typeof ALL_AGENT_SCOPES)[number]

/** Mirrors `DEFAULT_AGENT_KEY_SCOPES`: what `POST /keys` grants when `scopes` is omitted.
 * `swap:write` moves real funds on every call, so it is deliberately excluded from the default. */
export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ALL_AGENT_SCOPES.filter((scope) => scope !== "swap:write")

const SWAP_WRITE_NOTE = "moves funds -- this key can execute swaps on your behalf"

/** Renders a scope list for a human, calling `swap:write` out explicitly as fund-moving (the one
 * scope the design calls for plain-language treatment). Every other scope renders as its raw
 * name -- `keys list` shows raw scope strings for all of them, this function is only used where
 * the spec calls for the swap:write callout (the login summary). */
export function formatScopesForSummary(scopes: readonly string[]): string {
  return scopes.map((scope) => (scope === "swap:write" ? `${scope} (${SWAP_WRITE_NOTE})` : scope)).join(", ")
}

/** A plain fixed-width table: a header row, a separator row of dashes, then one row per data
 * row, every column padded to its widest cell (header included). No color, no box drawing --
 * this only has to be readable in a plain terminal and diffable in a test assertion. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)))
  // The last column is never padded: padding it would only add trailing whitespace nobody reads,
  // which pollutes terminal output and would otherwise break every exact-string test assertion.
  const line = (cells: string[]) =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? (cell ?? "") : (cell ?? "").padEnd(widths[col] ?? 0)))
      .join("  ")
  const separator = widths.map((width) => "-".repeat(width)).join("  ")
  return [line(headers), separator, ...rows.map(line)].join("\n")
}

/** Renders a timestamp (epoch ms) for a human, or `whenAbsent` (default `"never"`) when absent. */
export function formatTimestamp(ms: number | undefined, whenAbsent = "never"): string {
  return ms === undefined ? whenAbsent : new Date(ms).toISOString()
}

export interface ErrorRenderContext {
  apiUrl: string
  authType?: "device" | "key" | "none"
}

interface FailureLike {
  status: number
  code?: string
  message: string
}

/**
 * One plain-language line, never a raw envelope. Three mappings are pinned exactly
 * (task-3-brief.md Step 3):
 *
 *   DEVICE_TOKEN_INVALID -> "This device was revoked or its token is stale. Run: candle auth login"
 *   401 on an agent-key call -> "API key invalid or revoked. Run: candle keys create"
 *   network failure (status 0) -> "Could not reach <url>. Set CANDLE_API_URL to override the API endpoint."
 *
 * A fourth mapping appends a fix line to 403 SCOPE_MISSING rather than replacing the message:
 * the API's own text already names the missing scope ("This key lacks the launch:write scope"),
 * which is the part a CLI-side constant could not supply, so the CLI adds only the two commands
 * that resolve it. Without this, a scope-gated route (GET /agent/tier and GET /wallets both sit
 * behind `requireAgentKey("launch:write")`) failed with a statement of fact and no next step.
 *
 * Everything else falls back to the API's own message -- still plain language (launch-errors.ts's
 * `errorBody` messages are already written for a human), just without a CLI-specific fix line.
 */
export function renderError(result: FailureLike, ctx: ErrorRenderContext): string {
  if (result.code === "DEVICE_TOKEN_INVALID") {
    return "This device was revoked or its token is stale. Run: candle auth login"
  }
  if (result.status === 403 && result.code === "SCOPE_MISSING") {
    return `${result.message}. Mint one that has it with: candle keys create --scopes <a,b,c>, or check an existing key's scopes with: candle keys list`
  }
  if (result.status === 401 && ctx.authType === "key") {
    return "API key invalid or revoked. Run: candle keys create"
  }
  if (result.status === 0) {
    return `Could not reach ${ctx.apiUrl}. Set CANDLE_API_URL to override the API endpoint.`
  }
  return result.message
}

/** Writes a failed `ApiResult` to `writer`: the raw result as JSON in `--json` mode, `renderError`'s
 * plain-language line otherwise. The one place every command branches between the two, so no call
 * site can accidentally print a raw envelope in human mode or a rendered string in JSON mode. */
export function writeFailure(
  writer: { write(chunk: string): void },
  result: FailureLike & Record<string, unknown>,
  ctx: ErrorRenderContext,
  json: boolean,
): void {
  writer.write(json ? `${JSON.stringify(result)}\n` : `${renderError(result, ctx)}\n`)
}

/**
 * A LOCAL failure, decided before any request was made: the command needs a credential the CLI
 * does not have. Same two-mode contract `writeFailure` gives an API failure -- a machine-readable
 * object in `--json` mode, the plain line otherwise -- so a `--json` caller never has to parse a
 * sentence. Deliberately not routed through `writeFailure`: that takes an HTTP status, and there
 * is no honest one here (status 0 specifically means "could not reach the server", which
 * `renderError` would then print INSTEAD of the message this failure carries).
 */
export function writeLocalFailure(
  writer: { write(chunk: string): void },
  failure: { code: string; message: string },
  json: boolean,
): void {
  writer.write(json ? `${JSON.stringify({ ok: false, ...failure })}\n` : `${failure.message}\n`)
}

/**
 * The portal's device-management screen URL. `portalOrigin` -- persisted at login from the origin
 * of the device-code response's own `verificationUri`, which the API computes from its `FRONTEND_URL`
 * -- is AUTHORITATIVE when present: it is the portal the API itself points device approvals at, so
 * it is right by construction on every environment, including ones no derivation rule could guess.
 *
 * The derivation below is the fallback for a config written before this field existed, or for
 * env-only usage that never ran `auth login` on this machine. The API lives at api.candle.tv and
 * the portal at candle.tv, so it removes the first host LABEL that is exactly "api" -- anywhere in
 * the hostname, not only leading, since staging is `staging.api.candle.tv` -> `staging.candle.tv`
 * (a leading-only rule pointed that case back at the API host, which 404s). A convenience pointer
 * in a printed message, not a routing decision -- kept small on purpose.
 *
 * Parses the URL and operates on `hostname` LABELS specifically, never a string replace on the
 * whole URL: `"staging-api.candle.tv".replace("api.", "")` would wrongly cut the middle of a
 * hostname that merely CONTAINS "api." (producing "staging-.candle.tv"), and could just as easily
 * match "api." inside a path segment that has nothing to do with the host. Only the hostname is
 * ever touched -- the reconstructed URL is always `<origin>/dev/agent`, never carrying over any
 * path `apiUrl` had (this is a portal deep link with its own fixed path, not a URL rewrite).
 */
export function portalDeviceUrl(apiUrl: string, portalOrigin?: string): string {
  if (portalOrigin) {
    try {
      return `${new URL(portalOrigin).origin}/dev/agent`
    } catch {
      // A hand-edited or corrupted config value: fall through to the derivation rather than
      // emitting a broken URL built out of it.
    }
  }
  if (apiUrl === DEFAULT_API_URL) return "https://candle.tv/dev/agent"
  try {
    const url = new URL(apiUrl)
    const labels = url.hostname.split(".")
    const apiLabel = labels.indexOf("api")
    // `labels.length > 1` guards a hostname that is nothing but "api": removing its only label
    // would leave an empty hostname, which the URL setter silently ignores anyway.
    if (apiLabel !== -1 && labels.length > 1) {
      labels.splice(apiLabel, 1)
      url.hostname = labels.join(".")
    }
    return `${url.origin}/dev/agent`
  } catch {
    // Not a parseable URL -- shouldn't happen in practice (apiUrl always comes from
    // resolveApiUrl/--api-url), but fail soft rather than throw out of a printed-message helper.
    return `${apiUrl}/dev/agent`
  }
}
