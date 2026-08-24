/**
 * client: the CLI's single HTTP call site.
 *
 * `DEFAULT_API_URL` matches `packages/mcp/src/client.ts`'s convention: this package is fetched via
 * `bunx`/`npx` by people who have never run this monorepo, so the default has to be the endpoint
 * that works on a machine that never ran a local Candle API. That is the ALPHA deployment for now
 * (2026-08-23): production api.candle.tv does not serve /api/v1 yet, and candle.tv redirects to
 * alpha.candle.tv while the alpha runs, for an indeterminate time. Flip this to
 * https://api.candle.tv at GA with a version bump -- npx users pick the new default up
 * automatically. Point `CANDLE_API_URL` at localhost explicitly when developing against a local
 * API.
 *
 * `apiRequest` never throws on an HTTP-level error (4xx/5xx): those come back as a typed
 * `ApiResult` with `ok: false` so command code can pattern-match on it. It only rejects for
 * programmer errors (e.g. a body that can't be `JSON.stringify`'d); a network-level failure (DNS,
 * connection refused, timeout) is itself reported as `ok: false` too, with `status: 0`, since the
 * caller usually wants to handle "the server said no" and "we couldn't reach the server" the same
 * way (print an error and exit non-zero) without a try/catch at every call site.
 */

export const DEFAULT_API_URL = "https://api.alpha.candle.tv"

export type ApiResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false
      status: number
      code?: string
      message: string
      rfcError?: string
      /** The API's plain-language fix for this error (ERROR_UI_CATALOG's uiHint), when it sent
       * one -- surfaced so `--json` failures can carry a `suggestion` an agent can act on. */
      uiHint?: string
      /** The API's docs path for this error, relative to docs.candle.tv, when it sent one. */
      docsPath?: string
      raw: unknown
    }

export interface ApiRequestOptions {
  method?: string
  body?: unknown
  auth: "device" | "key" | "none"
  credentials: { deviceToken?: string; apiKey?: string }
  apiUrl: string
  /**
   * Optional fetch override. Additive: every existing caller omits this and keeps using the
   * global `fetch` exactly as before. The CLI (packages/cli) passes its own injected `fetch`
   * here so its command tests never touch the network or swap `globalThis.fetch`, rather than
   * this module growing a second, parallel way to make the same HTTP call.
   */
  fetch?: typeof fetch
  /**
   * Optional environment override, read for the network-failure message's "currently ..." hint
   * (which env var value is CANDLE_API_URL actually set to right now). Additive: defaults to
   * `process.env` when omitted, matching every caller from before this field existed. The CLI
   * passes its own injected `deps.env` here so a test never has to mutate real `process.env` to
   * exercise that hint.
   */
  env?: Record<string, string | undefined>
}

/** Trims trailing slashes so joining with a path never produces (or is missing) a `/`. */
function trimTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/**
 * Resolves the API base URL a command should use: `CANDLE_API_URL` (an explicit override, e.g. for
 * pointing at a local dev API) beats the value stored in `CliConfig.apiUrl` (set during `candle
 * login`, e.g. for a staging deployment) beats {@link DEFAULT_API_URL}. Does not read the config
 * file itself -- pass `readConfig()`'s `apiUrl` field in, so this stays synchronous and callers that
 * already have a `CliConfig` in hand don't pay for a second read.
 *
 * `env` defaults to `process.env`; the CLI passes its own injected `deps.env` explicitly so this
 * stays testable without mutating real process environment variables. Additive: every existing
 * caller that omits it keeps reading real `process.env`, unchanged.
 */
export function resolveApiUrl(
  configuredApiUrl?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.CANDLE_API_URL?.trim()
  const resolved = fromEnv || configuredApiUrl?.trim() || DEFAULT_API_URL
  return trimTrailingSlashes(resolved)
}

function buildHeaders(opts: ApiRequestOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" }
  if (opts.auth === "device" && opts.credentials.deviceToken) {
    headers.authorization = `Bearer ${opts.credentials.deviceToken}`
  } else if (opts.auth === "key" && opts.credentials.apiKey) {
    headers["x-api-key"] = opts.credentials.apiKey
  }
  // auth: "none" (and auth modes missing their credential) send neither header, deliberately --
  // apiRequest never throws on a missing credential; the server's resulting 401 is what surfaces
  // through the normal ok:false path, one error-handling shape for the caller either way.
  return headers
}

function buildUrl(apiUrl: string, path: string): string {
  const base = trimTrailingSlashes(apiUrl)
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${base}${normalizedPath}`
}

/** Best-effort JSON parse: returns the parsed value, or the raw text if it isn't valid JSON. */
function parseBody(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Classifies a non-2xx JSON body into `code`/`message` or `rfcError`/`message`. Candle's own API
 * error envelope is `{success:false,error:{code,message}}`; the OAuth device-authorization flow
 * (RFC 8628) instead returns bare RFC 6749-style errors like `{error:"authorization_pending"}`. A
 * body matching neither shape (or non-JSON, or no response at all) falls through to a generic
 * status-only message.
 */
function classifyError(
  status: number,
  raw: unknown,
): { code?: string; message: string; rfcError?: string; uiHint?: string; docsPath?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>

    if (typeof obj.error === "string") {
      const description = typeof obj.error_description === "string" ? obj.error_description : obj.error
      return { rfcError: obj.error, message: description }
    }

    if (obj.error && typeof obj.error === "object") {
      const errorObj = obj.error as Record<string, unknown>
      const code = typeof errorObj.code === "string" ? errorObj.code : undefined
      const message = typeof errorObj.message === "string" ? errorObj.message : `Request failed with status ${status}`
      // uiHint/docsPath ride along when the API sent them (launch-errors.ts's errorBody):
      // dropping them here is why `--json` failures used to answer "what went wrong" but never
      // "what do I do about it".
      const uiHint = typeof errorObj.uiHint === "string" ? errorObj.uiHint : undefined
      const docsPath = typeof errorObj.docsPath === "string" ? errorObj.docsPath : undefined
      return { code, message, ...(uiHint ? { uiHint } : {}), ...(docsPath ? { docsPath } : {}) }
    }
  }

  return { message: `Request failed with status ${status}` }
}

export async function apiRequest(path: string, opts: ApiRequestOptions): Promise<ApiResult> {
  const url = buildUrl(opts.apiUrl, path)
  const headers = buildHeaders(opts)
  // Stringified outside the network try/catch below on purpose: a body that can't be serialized
  // (circular references, a BigInt without a toJSON) is a programmer error in the caller, not a
  // network failure, and should throw as itself rather than being reported as "Could not reach
  // <url>" with status 0, which would contradict this module's own header comment.
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  const doFetch = opts.fetch ?? fetch

  let response: Response
  try {
    response = await doFetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const env = opts.env ?? process.env
    const envOverride = env.CANDLE_API_URL?.trim()
    return {
      ok: false,
      status: 0,
      message: `Could not reach ${url}: ${reason} (set CANDLE_API_URL to override; ${
        envOverride ? `currently "${envOverride}"` : "currently unset"
      })`,
      raw: undefined,
    }
  }

  const text = await response.text()
  const raw = parseBody(text)

  if (response.ok) {
    return { ok: true, status: response.status, body: raw }
  }

  const classified = classifyError(response.status, raw)
  return { ok: false, status: response.status, raw, ...classified }
}
