/**
 * Dependency-free client for hacc's public signal records (BE-3411, hacc north-star CL1): the
 * daily scorecard and per-signal measured records at `api.hacc.fun/v1/public/...`, read with the
 * profile's production Candle key as a Bearer. GET only: nothing here writes, trades or moves funds.
 *
 * Routes, filters and fields follow hacc's generated `docs/openapi.yaml` and the
 * `candle_signal_scorecard`, `candle_signal_records` and `candle_signal_record` entries of
 * `docs/generated/mcp-tools.json` (wallet-track C2, 321723e5).
 *
 * Every answer, success or refusal, carries the fixed line `measure: "Measured record, not a
 * forecast."`. hacc sends it on its own record bodies; `withMeasure` sets it on everything else
 * (an auth or server error, an unreadable body, a transport failure) so no rendering is without it.
 *
 * The MCP server carries a byte-identical copy (`packages/mcp/src/signal-records.drift.test.ts`).
 * Copy changes verbatim: `cp packages/cli/src/signal-records.ts packages/mcp/src/signal-records.ts`.
 */
export const SIGNAL_RECORDS_DEFAULT_URL = "https://api.hacc.fun"
export const SIGNAL_RECORDS_TIMEOUT_MS = 10_000

/** The fixed line (hacc north-star spec 5.4). Every output of these reads carries it, exactly. */
export const MEASURE = "Measured record, not a forecast."

export const RECORD_SOURCES = ["pattern", "quant_call", "holder_band", "launch_read"] as const
export type RecordSource = (typeof RECORD_SOURCES)[number]

export const RECORDS_LIMIT_MAX = 100
export const SOURCE_ID_MAX = 128

export type MeasuredBody = Record<string, unknown> & { measure: typeof MEASURE }

export interface SignalRecordsRefusal {
  /** HTTP status, or 0 when no answer arrived. */
  status: number
  code: string
  message: string
  /** hacc's complete body, kept for `--json`; always carries the fixed line. */
  body: MeasuredBody
}

export type SignalRecordsAnswer =
  | { ok: true; status: number; body: MeasuredBody }
  | { ok: false; refusal: SignalRecordsRefusal }

export interface SignalRecordsQuery {
  source?: RecordSource
  before?: number
  limit?: number
}

export interface SignalRecordsClientOptions {
  apiKey: string
  /** CANDLE_HACC_URL; it must be HTTPS, including for local servers. */
  apiUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface SignalRecordsClient {
  scorecard(date?: string): Promise<SignalRecordsAnswer>
  records(query?: SignalRecordsQuery): Promise<SignalRecordsAnswer>
  record(source: RecordSource, sourceId: string): Promise<SignalRecordsAnswer>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The body with the fixed line set, whatever hacc sent (an object is kept field for field). */
export function withMeasure(body: unknown): MeasuredBody {
  return { ...(isObject(body) ? body : {}), measure: MEASURE }
}

/** A calendar day, YYYY-MM-DD, that exists. */
export function isScorecardDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function isRecordSource(value: unknown): value is RecordSource {
  return typeof value === "string" && (RECORD_SOURCES as readonly string[]).includes(value)
}

/** A local refusal, decided before anything is sent. Same shape as hacc's, fixed line included. */
export function localRefusal(code: string, message: string): { ok: false; refusal: SignalRecordsRefusal } {
  return { ok: false, refusal: { status: 0, code, message, body: withMeasure({ error: message, code }) } }
}

export function createSignalRecordsClient(options: SignalRecordsClientOptions): SignalRecordsClient {
  const base = new URL(options.apiUrl ?? SIGNAL_RECORDS_DEFAULT_URL)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Signal records need an HTTPS CANDLE_HACC_URL without credentials, query or fragment.")
  }
  const root = base.toString().replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? SIGNAL_RECORDS_TIMEOUT_MS

  async function get(path: string): Promise<SignalRecordsAnswer> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await doFetch(`${root}${path}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      })
      const received: unknown = await response.json().catch(() => undefined)
      if (timedOut) return localRefusal("TIMEOUT", "The signal records request timed out.")
      if (!response.ok) {
        const message =
          isObject(received) && typeof received.error === "string"
            ? received.error
            : `Signal records request failed (${response.status}).`
        const code =
          isObject(received) && typeof received.code === "string"
            ? received.code
            : response.status === 404
              ? "NOT_FOUND"
              : `HTTP_${response.status}`
        return {
          ok: false,
          refusal: {
            status: response.status,
            code,
            message,
            body: withMeasure(isObject(received) ? received : { error: message }),
          },
        }
      }
      if (!isObject(received)) return localRefusal("BAD_RESPONSE", "hacc returned an unreadable response.")
      return { ok: true, status: response.status, body: withMeasure(received) }
    } catch {
      return timedOut
        ? localRefusal("TIMEOUT", "The signal records request timed out.")
        : localRefusal("NETWORK_ERROR", "Could not reach hacc.")
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    scorecard(date) {
      if (date !== undefined && !isScorecardDate(date)) {
        return Promise.resolve(localRefusal("INVALID_DATE", "date must be YYYY-MM-DD."))
      }
      return get(date === undefined ? "/v1/public/scorecard" : `/v1/public/scorecard/${date}`)
    },
    records(query = {}) {
      const search = new URLSearchParams()
      if (query.source !== undefined) {
        if (!isRecordSource(query.source)) {
          return Promise.resolve(localRefusal("INVALID_SOURCE", `source must be one of ${RECORD_SOURCES.join(", ")}.`))
        }
        search.set("source", query.source)
      }
      if (query.before !== undefined) {
        if (!Number.isSafeInteger(query.before) || query.before < 1) {
          return Promise.resolve(localRefusal("INVALID_BEFORE", "before must be a positive integer."))
        }
        search.set("before", String(query.before))
      }
      if (query.limit !== undefined) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > RECORDS_LIMIT_MAX) {
          return Promise.resolve(
            localRefusal("INVALID_LIMIT", `limit must be an integer from 1 to ${RECORDS_LIMIT_MAX}.`),
          )
        }
        search.set("limit", String(query.limit))
      }
      return get(`/v1/public/signal-records${search.size ? `?${search}` : ""}`)
    },
    record(source, sourceId) {
      if (!isRecordSource(source)) {
        return Promise.resolve(localRefusal("INVALID_SOURCE", `source must be one of ${RECORD_SOURCES.join(", ")}.`))
      }
      if (typeof sourceId !== "string" || sourceId.length < 1 || sourceId.length > SOURCE_ID_MAX) {
        return Promise.resolve(localRefusal("INVALID_SOURCE_ID", `source_id must be 1 to ${SOURCE_ID_MAX} characters.`))
      }
      return get(`/v1/public/signal-records/${source}/${encodeURIComponent(sourceId)}`)
    },
  }
}
