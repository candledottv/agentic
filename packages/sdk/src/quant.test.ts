/**
 * BE-1737 (spec S5 Q-2): the Quant key client against a fake API. Paths, the key header, the
 * timeouts, both refusal shapes, and a lost answer reported as transport, not as a refusal.
 */
import { describe, expect, test } from "bun:test"
import { createQuantKeyClient, newClientTurnId, quantCodePoints, quantRefusalCode } from "./quant"

const KEY = `cndl_test_${"r".repeat(43)}`

function fakeApi(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { method: string; url: URL; key: string | null; body: unknown; redirect?: RequestRedirect }[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? "GET",
      url,
      key: new Headers(init.headers).get("x-api-key"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    })
    return respond(url, init)
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe("the Quant key client (Q-2)", () => {
  test("each route at its path, with the key and no redirect", async () => {
    const api = fakeApi((url) => {
      if (url.pathname.endsWith("/status"))
        return Response.json({ enabled: true, allowed: true, tier: "pro", remaining: 12, activeTurnId: null })
      if (url.pathname.endsWith("/turns")) return Response.json({ turnId: "t1", cursor: 0 })
      if (url.pathname.endsWith("/events"))
        return Response.json({ events: [{ seq: 1, kind: "text", data: { text: "hi" } }], next: 1, status: "done" })
      if (url.pathname.endsWith("/cancel")) return Response.json({ cancelled: true })
      return Response.json({ items: [{ id: "m1", role: "assistant", text: "old", createdAt: "x" }], next: null })
    })
    const client = createQuantKeyClient({ apiUrl: "https://staging.api.candle.tv/", apiKey: KEY, fetch: api.fetch })
    expect(await client.status()).toMatchObject({ ok: true, body: { enabled: true, tier: "pro", remaining: 12 } })
    const clientTurnId = newClientTurnId()
    expect(await client.sendTurn({ text: "hello", clientTurnId })).toMatchObject({ ok: true, body: { turnId: "t1" } })
    expect(await client.events("t1", 0)).toMatchObject({ ok: true, body: { next: 1, status: "done" } })
    expect(await client.cancel("t1")).toMatchObject({ ok: true })
    expect(await client.history({ limit: 30 })).toMatchObject({ ok: true, body: { items: [{ id: "m1" }] } })
    expect(api.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/v1/agent/quant/status",
      "POST /api/v1/agent/quant/turns",
      "GET /api/v1/agent/quant/turns/t1/events?after=0",
      "POST /api/v1/agent/quant/turns/t1/cancel",
      "GET /api/v1/agent/quant/history?limit=30",
    ])
    expect(api.calls.every((c) => c.key === KEY && c.redirect === "error")).toBe(true)
    expect(api.calls[1]?.body).toEqual({ text: "hello", clientTurnId })
  })

  test("both refusal shapes, and the named fields a client needs", async () => {
    const api = fakeApi((url) => {
      if (url.pathname.endsWith("/status"))
        return Response.json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } }, { status: 429 })
      return Response.json({ code: "limit_reached", resetsAt: "2026-10-22T00:00:00Z" }, { status: 429 })
    })
    const client = createQuantKeyClient({ apiUrl: "https://staging.api.candle.tv", apiKey: KEY, fetch: api.fetch })
    expect(await client.status()).toEqual({
      ok: false,
      refusal: { code: "RATE_LIMITED", status: 429, shape: "envelope" },
    })
    expect(await client.sendTurn({ text: "x", clientTurnId: newClientTurnId() })).toEqual({
      ok: false,
      refusal: { code: "limit_reached", status: 429, shape: "relay", resetsAt: "2026-10-22T00:00:00Z" },
    })
    expect(quantRefusalCode({ code: "busy" })).toBe("busy")
    expect(quantRefusalCode({ error: { code: "SCOPE_MISSING" } })).toBe("SCOPE_MISSING")
    expect(quantRefusalCode({})).toBeUndefined()
  })

  test("a lost answer and a timeout are transport, never a refusal; a garbled answer is BAD_RESPONSE", async () => {
    let mode: "throw" | "hang" | "garbled" = "throw"
    const api = fakeApi(async (_url, init) => {
      if (mode === "throw") throw new TypeError("socket hang up")
      if (mode === "garbled") return new Response("<html>", { status: 200 })
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )
    })
    const client = createQuantKeyClient({
      apiUrl: "https://staging.api.candle.tv",
      apiKey: KEY,
      fetch: api.fetch,
      callTimeoutMs: 20,
    })
    expect(await client.sendTurn({ text: "x", clientTurnId: newClientTurnId() })).toMatchObject({
      ok: false,
      refusal: { code: "NETWORK_ERROR", shape: "transport", retryable: true },
    })
    mode = "hang"
    expect(await client.status()).toMatchObject({ ok: false, refusal: { code: "TIMEOUT", shape: "transport" } })
    mode = "garbled"
    expect(await client.status()).toMatchObject({ ok: false, refusal: { code: "BAD_RESPONSE" } })
  })

  test("an http API URL off this machine is refused before any call", () => {
    expect(() => createQuantKeyClient({ apiUrl: "http://api.candle.tv", apiKey: KEY })).toThrow("https")
    expect(() => createQuantKeyClient({ apiUrl: "http://localhost:3001", apiKey: KEY })).not.toThrow()
  })

  test("code points, not UTF-16 units", () => {
    expect(quantCodePoints("ab")).toBe(2)
    expect(quantCodePoints("🕯️")).toBe(2)
    expect(quantCodePoints("𝔸")).toBe(1)
  })
})
