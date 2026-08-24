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

export function resolveConfig(): RequestConfig {
  const apiUrl = process.env.CANDLE_API_URL?.trim() || DEFAULT_API_URL
  // CANDLE_API_KEY is the CLI's variable for the same credential; accept it as an alias so the
  // public install docs teach ONE name per credential. The MCP's own name keeps precedence.
  const apiKey = process.env.CANDLE_AGENT_API_KEY?.trim() || process.env.CANDLE_API_KEY?.trim()
  return apiKey ? { apiUrl, apiKey } : { apiUrl }
}
