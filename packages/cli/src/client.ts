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
  | { ok: true; status: number; body: unknown; headers?: Record<string, string> }
  | {
      ok: false
      status: number
      /** The response's headers, names lowercased (absent on a network failure). The x402 client
       * reads `payment-required` and `payment-response` here (packages/cli/src/x402/pay.ts). */
      headers?: Record<string, string>
      code?: string
      message: string
      retryable?: boolean
      routing?: Record<string, unknown>
      discovery?: Record<string, unknown>
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
  /**
   * Raw bytes sent as the request body under their own content type, instead of a JSON `body`
   * (`candle image upload` and `candle launch --image`: `POST /api/v1/uploads/agent-image` takes
   * the image itself). Through this function rather than a second `fetch` call so the cleartext
   * refusal and the credential headers stay in one place.
   */
  raw?: { bytes: Uint8Array; contentType: string }
  /** Multipart uploads; fetch supplies the boundary and content type. */
  form?: FormData
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
  /**
   * Extra request headers, set after the defaults and the credential. The x402 client sends
   * `PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` through this; a request carrying either (in any
   * case) is treated as credentialed, so a paid retry follows the same cleartext refusal and
   * same-origin redirect rules as a keyed one -- a redirect must not forward a proof that spends
   * money to another origin. `authorization` and `x-api-key` are ignored here: those come only
   * from `auth` and `credentials`.
   */
  headers?: Record<string, string>
}

/** Trims trailing slashes so joining with a path never produces (or is missing) a `/`. */
function trimTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/**
 * Set to any non-empty value to allow a cleartext `http://` API URL to a NON-loopback host.
 *
 * Loopback needs no opt-in (see {@link isLoopbackHost}); this exists for the dev shapes that are
 * not loopback but are still local, the common one being a devcontainer reaching its host through
 * `http://host.docker.internal:3000`. Deliberately an explicit, named act rather than a silent
 * allowance: it shows up in a shell profile or a compose file where a reviewer can see it.
 *
 * It reaches PRIVATE hosts only (see {@link isPrivateHost}). A cleartext public URL is refused
 * whether or not this is set, because the failure it prevents (an API key read off the wire) is
 * not something a stale export in someone's shell profile should be able to re-enable.
 */
export const ALLOW_INSECURE_HTTP_ENV = "CANDLE_ALLOW_INSECURE_HTTP"

/**
 * Whether `hostname` is this machine talking to itself, where cleartext never leaves the host.
 *
 * `URL.hostname` keeps IPv6 literals in brackets, hence the `[::1]` form. The whole `127.0.0.0/8`
 * block counts, not just `127.0.0.1`: `127.0.0.2` and friends are equally loopback, and a dev who
 * picked one should not get a security error for it.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "[::1]") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Why this API base URL must not be used, as the sentence to say about it, or `undefined` when it
 * is safe to send credentials to.
 *
 * The CLI attaches a bearer device token or an `x-api-key` to nearly every request, so an
 * `http://` base URL puts a live credential on the wire in the clear. A redirect to HTTPS does not
 * save it: the first request has already left the machine. One mistyped or copy-pasted profile is
 * all it takes, and the failure is silent -- the command works, which is exactly why nobody
 * notices.
 *
 * Returns a sentence rather than throwing because both callers want to present it their own way:
 * `profile add` refuses at the point the value is typed, and {@link apiRequest} refuses at the
 * call site as the backstop for every other route a URL can arrive by (`--api-url`,
 * `CANDLE_API_URL`, a stored profile, a config file edited by hand).
 *
 * A value that does not parse is NOT this function's problem: it returns `undefined` and leaves
 * that to the existing "it needs a scheme" advice, which says something more useful about it.
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

export function insecureApiUrlFault(
  url: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:") return undefined
  if (isLoopbackHost(parsed.hostname)) return undefined
  if (env[ALLOW_INSECURE_HTTP_ENV]?.trim() && isPrivateHost(parsed.hostname)) return undefined
  return (
    `Refusing to send credentials in the clear to ${parsed.origin}. Use https://` +
    (isPrivateHost(parsed.hostname)
      ? `, or set ${ALLOW_INSECURE_HTTP_ENV}=1 if this really is a trusted local endpoint.`
      : `. ${ALLOW_INSECURE_HTTP_ENV} does not apply here: it covers private networks only, and this is a public address.`)
  )
}

/**
 * The URL a browser may be launched at, normalized, or `null` when it must only be printed. The
 * URL comes from the server (the device-code `verificationUriComplete`), and the launcher is a
 * shell on some platforms, so anything but `https:` (or `http:` on loopback, the local dev API) is
 * refused, and the caller passes on the parsed `href` rather than the server's text.
 */
export function browserUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  if (parsed.protocol === "https:") return parsed.href
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.href
  return null
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
  const headers: Record<string, string> = {
    "content-type": opts.raw?.contentType ?? "application/json",
    accept: "application/json",
  }
  if (opts.auth === "device" && opts.credentials.deviceToken) {
    headers.authorization = `Bearer ${opts.credentials.deviceToken}`
  } else if (opts.auth === "key" && opts.credentials.apiKey) {
    headers["x-api-key"] = opts.credentials.apiKey
  }
  // auth: "none" (and auth modes missing their credential) send neither header, deliberately --
  // apiRequest never throws on a missing credential; the server's resulting 401 is what surfaces
  // through the normal ok:false path, one error-handling shape for the caller either way.
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    const lower = name.toLowerCase()
    if (lower === "authorization" || lower === "x-api-key") continue
    headers[name] = value
  }
  return headers
}

/** The statuses fetch would follow, the ones that carry a Location to go to. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

/** A credentialed request was redirected to another origin; the credential was not sent there. */
export class CrossOriginRedirectError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`The API at ${from} redirected to ${to}, another origin. Not followed, so the credential was not sent there.`)
    this.name = "CrossOriginRedirectError"
  }
}

/**
 * Header names (lowercased) a redirect must never forward to another origin: the two
 * credentials, and the two x402 proof headers. Those are not login credentials, but they spend
 * money the same way -- `PAYMENT-SIGNATURE` carries a partly signed transfer, and
 * `SIGN-IN-WITH-X` a proof whose nonce can spend a wallet credit for minutes after it leaves.
 * Matched case-insensitively because the credentials are written lowercase while the x402
 * client sends its headers with their wire casing through `ApiRequestOptions.headers`.
 */
const PROTECTED_REQUEST_HEADERS = new Set(["x-api-key", "authorization", "payment-signature", "sign-in-with-x"])

/**
 * fetch for a request that carries a header a redirect must not forward: the API key, the device
 * token, or an x402 payment header (`PAYMENT-SIGNATURE`, `SIGN-IN-WITH-X`). fetch's own redirect
 * handling forwards custom headers such as `x-api-key` to wherever a Location points, another
 * host included, so a redirect from the API (or anything between it and this machine) would hand
 * that header to a third party. Here every hop is `redirect: "manual"`: a Location on the
 * request's own origin is re-issued with the same headers (the API's legacy routes redirect that
 * way), and any other origin throws {@link CrossOriginRedirectError} without a request being
 * made to it. 303, and 301/302 after a POST, continue as a body-less GET, as fetch would.
 */
export async function fetchSameOriginRedirects(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let current = url
  let next: RequestInit = { ...init, redirect: "manual" }
  for (let hops = 0; ; hops++) {
    const response = await doFetch(current, next)
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null
    if (!location) return response
    const from = new URL(current)
    const target = new URL(location, from)
    if (target.origin !== from.origin) throw new CrossOriginRedirectError(from.origin, target.origin)
    if (hops >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`)
    const method = (next.method ?? "GET").toUpperCase()
    if (
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      next = { ...next, method: "GET", body: undefined }
    }
    current = target.href
  }
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
): {
  code?: string
  message: string
  rfcError?: string
  uiHint?: string
  docsPath?: string
  retryable?: boolean
  routing?: Record<string, unknown>
  discovery?: Record<string, unknown>
} {
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
      return {
        code,
        message,
        ...(typeof errorObj.retryable === "boolean" ? { retryable: errorObj.retryable } : {}),
        ...(typeof errorObj.routing === "object" && errorObj.routing !== null
          ? { routing: errorObj.routing as Record<string, unknown> }
          : {}),
        ...(typeof errorObj.discovery === "object" && errorObj.discovery !== null
          ? { discovery: errorObj.discovery as Record<string, unknown> }
          : {}),
        ...(uiHint ? { uiHint } : {}),
        ...(docsPath ? { docsPath } : {}),
      }
    }
  }

  return { message: `Request failed with status ${status}` }
}

let latestCliVersionSeen: string | null = null

/** What the API said the latest CLI version is, from any response this process has made. */
export function latestCliVersionFromApi(): string | null {
  return latestCliVersionSeen
}

export function __resetLatestCliVersionForTest(): void {
  latestCliVersionSeen = null
}

/** A response's headers as a plain object with lowercased names, or undefined when the (test)
 * response carries none. */
function headersOf(response: Response): Record<string, string> | undefined {
  const headers = response.headers as Headers | undefined
  if (!headers || typeof headers.forEach !== "function") return undefined
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value
  })
  return out
}

export async function apiRequest(path: string, opts: ApiRequestOptions): Promise<ApiResult> {
  const url = buildUrl(opts.apiUrl, path)
  // The backstop, checked here because this is the CLI's single HTTP call site: a URL can arrive
  // from --api-url, CANDLE_API_URL, a stored profile or a hand-edited config, and validating each
  // of those routes separately means the next one added is unguarded. Refused BEFORE the headers
  // are built, so the credential is never even assembled for a cleartext request.
  const insecure = insecureApiUrlFault(opts.apiUrl, opts.env ?? process.env)
  if (insecure) {
    return { ok: false, status: 0, code: "INSECURE_API_URL", message: insecure, raw: undefined }
  }
  const headers = buildHeaders(opts)
  if (opts.form) delete headers["content-type"]
  // Stringified outside the network try/catch below on purpose: a body that can't be serialized
  // (circular references, a BigInt without a toJSON) is a programmer error in the caller, not a
  // network failure, and should throw as itself rather than being reported as "Could not reach
  // <url>" with status 0, which would contradict this module's own header comment.
  const body =
    opts.form ??
    (opts.raw ? (opts.raw.bytes as BodyInit) : opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const doFetch = opts.fetch ?? fetch

  const init: RequestInit = { method: opts.method ?? "GET", headers, body }
  const credentialed = Object.keys(headers).some((name) => PROTECTED_REQUEST_HEADERS.has(name.toLowerCase()))

  let response: Response
  try {
    response = credentialed ? await fetchSameOriginRedirects(doFetch, url, init) : await doFetch(url, init)
  } catch (err) {
    if (err instanceof CrossOriginRedirectError) {
      return { ok: false, status: 0, code: "CROSS_ORIGIN_REDIRECT", message: err.message, raw: undefined }
    }
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

  // Ride-along update discovery: every API response carries the latest CLI version
  // (apps/api client-versions middleware). Noted here, at the single HTTP call site, and READ
  // by update-notice.ts at exit -- that direction keeps this file import-free, which it visibly
  // is on purpose. Raw and unvalidated on purpose too: the notice module owns trust decisions.
  const latestHeader = response.headers?.get?.("x-candle-cli-latest")
  if (latestHeader) latestCliVersionSeen = latestHeader

  const text = await response.text()
  const raw = parseBody(text)
  const responseHeaders = headersOf(response)

  if (response.ok) {
    return { ok: true, status: response.status, body: raw, ...(responseHeaders ? { headers: responseHeaders } : {}) }
  }

  const classified = classifyError(response.status, raw)
  return {
    ok: false,
    status: response.status,
    raw,
    ...classified,
    ...(responseHeaders ? { headers: responseHeaders } : {}),
  }
}
