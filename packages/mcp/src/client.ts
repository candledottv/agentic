/**
 * Env-backed config for talking to the Candle REST API.
 *
 * `CANDLE_API_URL` defaults to production. This package is published to npm and installed by
 * strangers via `npx`, so the default has to be the endpoint that works on a machine that has
 * never run this repo. It used to default to `http://localhost:3001`, which was right while the
 * only way to run this server was from a monorepo checkout and wrong the moment it shipped: every
 * registry install would have pointed at a dev server that isn't running. Point `CANDLE_API_URL`
 * at localhost explicitly when developing against a local API.
 *
 * `CANDLE_AGENT_API_KEY` is optional here: the read-only tools (get_market, get_feed,
 * get_agent_profile) don't need one, and `buildRequest` in tools.ts is what throws a clear error
 * for the write tools (launch, report) when it's missing.
 */
export interface RequestConfig {
  apiUrl: string
  apiKey?: string
}

// The ALPHA deployment (2026-08-23): production api.candle.tv does not serve /api/v1 yet.
// Flip to https://api.candle.tv at GA with a version bump; see packages/cli/src/client.ts.
export const DEFAULT_API_URL = "https://api.alpha.candle.tv"

/** Loopback, where cleartext never leaves the machine. `URL.hostname` keeps brackets on IPv6
 * literals; the whole 127.0.0.0/8 block counts, not just 127.0.0.1. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "[::1]") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Refuse an API base URL that would put the agent key on the wire in the clear.
 *
 * Every write tool sends `x-api-key`, and this server's URL comes from an environment variable set
 * in an MCP host's config file, which is exactly the kind of value that gets copied between
 * machines with its scheme left wrong. Loopback needs no opt-in, since developing against a local
 * API is the documented case; anything else needs `CANDLE_ALLOW_INSECURE_HTTP`, the same escape
 * hatch the CLI uses under the same name.
 *
 * Throws at startup rather than per call: a server that cannot reach its API securely should fail
 * where the operator is looking, not once per tool invocation.
 */
function assertTransportSecurity(apiUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(`CANDLE_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`)
  }
  if (parsed.protocol === "https:") return
  if (parsed.protocol !== "http:") {
    throw new Error(`CANDLE_API_URL must be http or https, got ${parsed.protocol.replace(":", "")}`)
  }
  if (isLoopbackHost(parsed.hostname)) return
  if (process.env.CANDLE_ALLOW_INSECURE_HTTP?.trim()) return
  throw new Error(
    `Refusing to send credentials in the clear to ${parsed.origin}. Set CANDLE_API_URL to an https:// ` +
      "URL, or set CANDLE_ALLOW_INSECURE_HTTP=1 if this really is a trusted local endpoint.",
  )
}

export function resolveConfig(): RequestConfig {
  const apiUrl = process.env.CANDLE_API_URL?.trim() || DEFAULT_API_URL
  assertTransportSecurity(apiUrl)
  // CANDLE_API_KEY is the CLI's variable for the same credential; accept it as an alias so the
  // public install docs teach ONE name per credential. The MCP's own name keeps precedence.
  const apiKey = process.env.CANDLE_AGENT_API_KEY?.trim() || process.env.CANDLE_API_KEY?.trim()
  return apiKey ? { apiUrl, apiKey } : { apiUrl }
}
