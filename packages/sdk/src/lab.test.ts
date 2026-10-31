import { describe, expect, test } from "bun:test"
import {
  createLabClient,
  LAB_CALL_TIMEOUT_MS,
  LAB_REPLAY_INTERVAL_MS,
  LAB_REPLAY_TIMEOUT_MS,
  type LabClientOptions,
} from "./lab"

const key = "cndl_live_lab_fixture"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const input = {
  definition: { entry: { pattern: "new_ticker" } },
  from: "2026-10-25T00:00:00Z",
  to: "2026-10-26T00:00:00Z",
}

describe("hacc lab client", () => {
  test("every route uses Bearer auth, no redirects, and keeps the server's body", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const reply = {
      job_id: 42,
      status: "done",
      plan: "max",
      allowed: true,
      replays: {},
      result: { lead_card: { version: 1 } },
      future: { untouched: true },
    }
    const client = createLabClient({
      apiKey: key,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return json(reply)
      }) as unknown as typeof fetch,
    })
    for (const answer of [
      await client.status(),
      await client.replay(input),
      await client.replayGet("42/?"),
      await client.replayCancel(42),
      await client.runners({ hours: 12, min_wallets: 3 }),
      await client.edges({ days: 7, min_n: 15 }),
    ]) {
      expect(answer.ok && answer.body).toEqual(reply)
    }
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.hacc.fun/v1/strategy-lab/status",
      "https://api.hacc.fun/v1/strategy-lab/replay",
      "https://api.hacc.fun/v1/strategy-lab/replay/42%2F%3F",
      "https://api.hacc.fun/v1/strategy-lab/replay/42/cancel",
      "https://api.hacc.fun/v1/strategy-lab/runners?hours=12&min_wallets=3",
      "https://api.hacc.fun/v1/strategy-lab/edges?days=7&min_n=15",
    ])
    for (const { init } of calls) {
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      expect(new Headers(init.headers).has("x-api-key")).toBe(false)
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(input)
    expect(calls[3]?.init.method).toBe("POST")
    expect(calls[3]?.init.body).toBeUndefined()
  })

  test("an HTTPS override is used; unsafe URLs are refused before fetch", async () => {
    let requested = ""
    const fetcher = (async (url: string | URL | Request) => {
      requested = String(url)
      return json({})
    }) as unknown as typeof fetch
    await createLabClient({ apiKey: key, apiUrl: "https://lab.example/prefix/", fetch: fetcher }).edges()
    expect(requested).toBe("https://lab.example/prefix/v1/strategy-lab/edges")
    for (const apiUrl of [
      "http://api.hacc.fun",
      "http://localhost",
      "ftp://lab.example",
      "not-a-url",
      "https://user:password@lab.example",
      "https://lab.example?x=1",
      "https://lab.example#x",
    ]) {
      expect(() => createLabClient({ apiKey: key, apiUrl, fetch: fetcher })).toThrow()
    }
  })

  test("refusals carry HTTP status, body.code, server message and the complete body", async () => {
    for (const [status, code] of [
      [403, "lab_plan"],
      [429, "lab_quota"],
      [409, "lab_active"],
      [503, "lab_busy"],
      [400, "lab_window"],
    ] as const) {
      const body = { code, error: "server message", resets_at: "2026-10-30T00:00:00Z", extra: true }
      const client = createLabClient({
        apiKey: key,
        fetch: (async () => json(body, status)) as unknown as typeof fetch,
      })
      expect(await client.status()).toEqual({ ok: false, refusal: { status, code, message: "server message", body } })
    }
    const client = createLabClient({
      apiKey: key,
      fetch: (async () => json({ error: "old server" }, 404)) as unknown as typeof fetch,
    })
    expect(await client.status()).toMatchObject({
      ok: false,
      refusal: { status: 404, code: "HTTP_404", message: "old server" },
    })
  })

  test("transport, redirect and malformed responses are failures without leaking the key", async () => {
    for (const fetcher of [
      (async () => {
        throw new Error(`fetch failed with ${key}`)
      }) as unknown as typeof fetch,
      (async () => Response.redirect("https://another.example")) as unknown as typeof fetch,
      (async () => new Response("not json")) as unknown as typeof fetch,
      (async () => json({ job_id: 42 })) as unknown as typeof fetch,
    ]) {
      const answer = await createLabClient({ apiKey: key, fetch: fetcher }).replayGet(42)
      expect(answer.ok).toBe(false)
      expect(JSON.stringify(answer)).not.toContain(key)
    }
  })

  test("calls abort on timeout, including while reading the response body", async () => {
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })) as unknown as typeof fetch
    const client = createLabClient({ apiKey: key, fetch: fetcher, callTimeoutMs: 5 })
    expect(await client.status()).toMatchObject({ ok: false, refusal: { code: "TIMEOUT" } })
    const bodyFetch = (async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
    })) as unknown as typeof fetch
    expect(await createLabClient({ apiKey: key, fetch: bodyFetch, callTimeoutMs: 5 }).status()).toMatchObject({
      ok: false,
      refusal: { code: "TIMEOUT" },
    })
    expect(LAB_CALL_TIMEOUT_MS).toBe(10_000)
  })

  test("wait polls every five seconds and returns done or failed without rewriting the job", async () => {
    for (const terminal of ["done", "failed"]) {
      let now = 0
      let calls = 0
      const sleeps: number[] = []
      const last = { job_id: 42, status: terminal, result: { pnl_usd: 10 } }
      const options: LabClientOptions = {
        apiKey: key,
        now: () => now,
        sleep: async (ms) => {
          now += ms
          sleeps.push(ms)
        },
        fetch: (async () => {
          calls++
          return json(calls === 3 ? last : { job_id: 42, status: calls === 1 ? "pending" : "running" })
        }) as unknown as typeof fetch,
      }
      expect(await createLabClient(options).waitForReplay(42)).toEqual({ ok: true, status: 200, body: last })
      expect(sleeps).toEqual([5_000, 5_000])
      expect(calls).toBe(3)
    }
  })

  test("wait stops at 660 seconds, accepts a shorter deadline, and returns poll refusals immediately", async () => {
    for (const timeoutMs of [undefined, 12_000]) {
      let now = 0
      const client = createLabClient({
        apiKey: key,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        fetch: (async () => json({ job_id: 42, status: "pending" })) as unknown as typeof fetch,
      })
      expect(await client.waitForReplay(42, { timeoutMs })).toMatchObject({
        ok: false,
        refusal: { code: "REPLAY_TIMEOUT" },
      })
      expect(now).toBe(timeoutMs ?? 660_000)
    }
    const client = createLabClient({
      apiKey: key,
      fetch: (async () => json({ code: "lab_plan", error: "denied" }, 403)) as unknown as typeof fetch,
    })
    expect(await client.waitForReplay(42)).toMatchObject({ ok: false, refusal: { code: "lab_plan" } })
    expect(LAB_REPLAY_INTERVAL_MS).toBe(5_000)
    expect(LAB_REPLAY_TIMEOUT_MS).toBe(660_000)
  })
})
