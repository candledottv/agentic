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
/**
 * Whether `hostname` is on a private network, i.e. somewhere cleartext stays inside a LAN or a
 * container host instead of crossing the public internet.
 *
 * This is what BOUNDS the insecure-HTTP escape hatch rather than merely describing it. The hatch
 * exists for one shape, a devcontainer reaching its host (`http://host.docker.internal:3000`), and
 * that shape is always private. Letting the same opt-in also cover a public address is what turns
 * a dev convenience into an API key read off the wire by anyone on the path, so the flag no longer
 * reaches those at all: a cleartext public URL is refused with or without it.
 *
 * Names as well as literals, because the documented case IS a name: `host.docker.internal` never
 * appears as an IP in the URL. A single-label host is included for the same reason it cannot be a
 * public FQDN.
 *
 * Deliberately excluded: 100.64.0.0/10 (carrier-grade NAT) is not "your network" in any sense a
 * developer controls, so it gets no more trust than the public internet.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  // A single-label name has no public DNS answer, so it can only be resolved locally.
  if (!host.includes(".") && !host.includes(":")) return true
  if (/\.(local|internal|home\.arpa)$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  return /^fe[89ab][0-9a-f]:/.test(host)
}

function assertTransportSecurity(apiUrl: string, env: Record<string, string | undefined>): void {
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
  if (env.CANDLE_ALLOW_INSECURE_HTTP?.trim() && isPrivateHost(parsed.hostname)) return
  throw new Error(
    `Refusing to send credentials in the clear to ${parsed.origin}. Set CANDLE_API_URL to an https:// ` +
      (isPrivateHost(parsed.hostname)
        ? "URL, or set CANDLE_ALLOW_INSECURE_HTTP=1 if this really is a trusted local endpoint."
        : "URL. CANDLE_ALLOW_INSECURE_HTTP does not apply here: it covers private networks only, " +
          "and this is a public address."),
  )
}

/**
 * `env` is a parameter rather than a direct `process.env` read so an in-process host can pass the
 * environment it means. `candle mcp` runs this server inside its own process having stripped every
 * inherited credential, and reading the ambient environment here would hand back exactly the
 * variables that strip removed. Defaults to `process.env` for the published bin, which has no
 * other source.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env): RequestConfig {
  const apiUrl = env.CANDLE_API_URL?.trim() || DEFAULT_API_URL
  assertTransportSecurity(apiUrl, env)
  // CANDLE_API_KEY is the CLI's variable for the same credential; accept it as an alias so the
  // public install docs teach ONE name per credential. The MCP's own name keeps precedence.
  const apiKey = env.CANDLE_AGENT_API_KEY?.trim() || env.CANDLE_API_KEY?.trim()
  return apiKey ? { apiUrl, apiKey } : { apiUrl }
}
