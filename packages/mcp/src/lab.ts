/**
 * Dependency-free hacc strategy lab client (BE-2038, strategy lab spec R18).
 * The CLI carries a byte-identical copy. Copy changes verbatim:
 * `cp packages/sdk/src/lab.ts packages/cli/src/lab.ts`.
 * Bodies, including refusals and older results without a lead card, are kept unchanged.
 */
export const LAB_DEFAULT_URL = "https://api.hacc.fun"
export const LAB_PATH = "/v1/strategy-lab"
export const LAB_CALL_TIMEOUT_MS = 10_000
export const LAB_REPLAY_INTERVAL_MS = 5_000
export const LAB_REPLAY_TIMEOUT_MS = 660_000

export type LabRecord = Record<string, unknown>
export type LabJobId = string | number

export interface LabStatus extends LabRecord {
  plan: string
  allowed: boolean
  replays: { cap: number | null; used: number | null; resets_at: string }
  active_job_id: LabJobId | null
}

export interface LabReplayInput {
  definition: LabRecord
  from: string
  to: string
  asset_ids?: number[]
  cost?: { fee_bps_per_side?: number; slippage_bps_per_side?: number }
}

export interface LabReplayStarted extends LabRecord {
  job_id: LabJobId
}

export interface LabReplayJob extends LabReplayStarted {
  status: string
  error?: string | null
  result?: LabRecord | null
}

export interface LabRefusal {
  status: number
  code: string
  message: string
  /** The server's complete body, retained for machine output and future additive fields. */
  body?: unknown
}

export type LabAnswer<T> = { ok: true; status: number; body: T } | { ok: false; refusal: LabRefusal }

export interface LabClientOptions {
  apiKey: string
  /** Pass CANDLE_HACC_URL here; it must be HTTPS, including for local servers. */
  apiUrl?: string
  fetch?: typeof fetch
  callTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface LabClient {
  status(): Promise<LabAnswer<LabStatus>>
  replay(body: LabReplayInput): Promise<LabAnswer<LabReplayStarted>>
  replayGet(id: LabJobId): Promise<LabAnswer<LabReplayJob>>
  replayCancel(id: LabJobId): Promise<LabAnswer<LabRecord>>
  runners(q?: { hours?: number; min_wallets?: number }): Promise<LabAnswer<LabRecord>>
  edges(q?: { days?: number; min_n?: number }): Promise<LabAnswer<LabRecord>>
  waitForReplay(id: LabJobId, options?: { intervalMs?: number; timeoutMs?: number }): Promise<LabAnswer<LabReplayJob>>
}

function record(value: unknown): value is LabRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function transportRefusal(code: string, message: string): LabAnswer<never> {
  return { ok: false, refusal: { status: 0, code, message } }
}

function query(values: Record<string, number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) search.set(key, String(value))
  return search.size ? `?${search}` : ""
}

export function createLabClient(options: LabClientOptions): LabClient {
  const base = new URL(options.apiUrl ?? LAB_DEFAULT_URL)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("The lab needs an HTTPS CANDLE_HACC_URL without credentials, query or fragment.")
  }
  const root = base.toString().replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch
  const callMs = options.callTimeoutMs ?? LAB_CALL_TIMEOUT_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function call<T extends LabRecord>(
    method: "GET" | "POST",
    path: string,
    valid: (body: LabRecord) => boolean = () => true,
    body?: unknown,
    timeoutMs = callMs,
  ): Promise<LabAnswer<T>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await doFetch(`${root}${LAB_PATH}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const received: unknown = await response.json().catch(() => undefined)
      if (timedOut) return transportRefusal("TIMEOUT", "The lab request timed out.")
      if (!response.ok) {
        return {
          ok: false,
          refusal: {
            status: response.status,
            code: record(received) && typeof received.code === "string" ? received.code : `HTTP_${response.status}`,
            message:
              record(received) && typeof received.error === "string"
                ? received.error
                : `Lab request failed (${response.status}).`,
            body: received,
          },
        }
      }
      if (!record(received) || !valid(received)) {
        return transportRefusal("BAD_RESPONSE", "The lab returned an unreadable response.")
      }
      return { ok: true, status: response.status, body: received as T }
    } catch {
      return transportRefusal(
        timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        timedOut ? "The lab request timed out." : "Could not reach the lab.",
      )
    } finally {
      clearTimeout(timer)
    }
  }

  const jobPath = (id: LabJobId) => `/replay/${encodeURIComponent(String(id))}`
  const validId = (id: unknown) =>
    (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id) && id > 0)
  const validJob = (body: LabRecord) => validId(body.job_id) && typeof body.status === "string"
  return {
    status: () =>
      call<LabStatus>(
        "GET",
        "/status",
        (b) => typeof b.plan === "string" && typeof b.allowed === "boolean" && record(b.replays),
      ),
    replay: (body) => call<LabReplayStarted>("POST", "/replay", (b) => validId(b.job_id), body),
    replayGet: (id) => call<LabReplayJob>("GET", jobPath(id), validJob),
    replayCancel: (id) => call("POST", `${jobPath(id)}/cancel`),
    runners: (q = {}) => call("GET", `/runners${query(q)}`),
    edges: (q = {}) => call("GET", `/edges${query(q)}`),
    async waitForReplay(id, wait = {}) {
      const intervalMs = wait.intervalMs ?? LAB_REPLAY_INTERVAL_MS
      const timeoutMs = wait.timeoutMs ?? LAB_REPLAY_TIMEOUT_MS
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Replay polling interval and timeout must be positive finite numbers.")
      }
      const deadline = now() + timeoutMs
      while (now() < deadline) {
        const answer = await call<LabReplayJob>(
          "GET",
          jobPath(id),
          validJob,
          undefined,
          Math.min(callMs, deadline - now()),
        )
        if (!answer.ok || !["pending", "running"].includes(answer.body.status)) return answer
        await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
      }
      return transportRefusal(
        "REPLAY_TIMEOUT",
        `Replay ${id} is still pending or running. Read it with candle lab replay get ${id}.`,
      )
    },
  }
}
