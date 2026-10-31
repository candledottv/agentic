import { expect, test } from "bun:test"
import { CandleApiError, CandleClient, TokenPageError } from "./index"

const token = { chain: "solana" as const, address: "So11111111111111111111111111111111111111112" }
const base = `/api/v1/token-pages/solana/${token.address}`
const versionId = "10000000-0000-4000-8000-000000000001"
const key = "fixture-key"
function fixture(answer: (call: { url: URL; init: RequestInit }, n: number) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = []
  const client = new CandleClient({
    apiUrl: "https://api.test",
    apiKey: key,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: new URL(String(input)), init: init ?? {} }
      calls.push(call)
      return answer(call, calls.length)
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}
const ok = (data: unknown) => Response.json({ success: true, data })

test("update/list/delete/seen retain the public/private boundary and idempotency", async () => {
  const { client, calls } = fixture(() => ok({ id: versionId, sequence: "9007199254740993", items: [] }))
  await client.tokenPages.updates(token, { limit: 20, cursor: "cursor&x" })
  await client.tokenPages.postUpdate(token, { text: "hello" }, { idempotencyKey: "post-1" })
  await client.tokenPages.deletePost(token, versionId, { idempotencyKey: "delete-1" })
  await client.tokenPages.seen(token)
  await client.tokenPages.markSeen(token, "9007199254740993", { idempotencyKey: "seen-1" })
  expect(calls.map((c) => [c.url.pathname, c.init.method])).toEqual([
    [`${base}/updates`, "GET"],
    [`${base}/updates`, "POST"],
    [`${base}/posts/${versionId}`, "DELETE"],
    [`${base}/seen`, "GET"],
    [`${base}/seen`, "POST"],
  ])
  expect(new Headers(calls[0]?.init.headers).has("x-api-key")).toBe(false)
  for (const call of calls.slice(1)) expect(new Headers(call.init.headers).get("x-api-key")).toBe(key)
  expect(new Headers(calls[4]?.init.headers).get("Idempotency-Key")).toBe("seen-1")
  expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ visibleUpdateSequence: "9007199254740993" })
})

test("public reads are keyless, private capabilities are separate, cursors and large strings are preserved", async () => {
  const data = {
    revision: "9007199254740993",
    features: { edit: false },
    items: [{ text: null, tombstone: "removed" }],
    nextCursor: "opaque:next",
  }
  const { client, calls } = fixture(() => ok(data))
  expect(await client.tokenPages.about(token)).toMatchObject(data)
  expect(await client.tokenPages.history(token, "lore", { cursor: "opaque:/?&", limit: 50 })).toMatchObject(data)
  await client.tokenPages.burns(token, { limit: 5 })
  await client.tokenPages.capabilities(token)
  expect(calls.map((c) => c.url.pathname)).toEqual([
    base,
    `${base}/sections/lore/history`,
    `${base}/burns`,
    `${base}/capabilities`,
  ])
  expect(calls[1]?.url.searchParams.get("cursor")).toBe("opaque:/?&")
  for (const call of calls.slice(0, 3)) {
    expect(new Headers(call.init.headers).has("x-api-key")).toBe(false)
    expect(call.init.cache).toBe("no-store")
    expect(call.init.method).toBe("GET")
  }
  expect(new Headers(calls[3]?.init.headers).get("x-api-key")).toBe(key)
})

test("claim, edit, restore and flag send the exact DTO, explicit key and one request each", async () => {
  const { client, calls } = fixture(() => ok({ id: versionId, revision: "9007199254740993" }))
  const bodies = [
    { kind: "creator" as const, challengeId: versionId, signature: "exact-signature" },
    { text: "line one\r\n🕯️", baseRevision: "9007199254740992" },
    { versionId, baseRevision: "9007199254740993" },
    { contentId: versionId, reason: "unsafe_link" as const, detail: "review this exact version" },
  ] as const
  const options = { idempotencyKey: "persisted-request" }
  const result = await client.tokenPages.claim(token, bodies[0], options)
  await client.tokenPages.setSection(token, "thesis", bodies[1], options)
  await client.tokenPages.restoreSection(token, "thesis", bodies[2], options)
  await client.tokenPages.flag(token, bodies[3], options)
  expect(result).toMatchObject({
    data: { id: versionId, revision: "9007199254740993" },
    idempotencyKey: options.idempotencyKey,
  })
  expect(calls.map((c) => [c.url.pathname, c.init.method])).toEqual([
    [`${base}/claims`, "POST"],
    [`${base}/sections/thesis`, "PUT"],
    [`${base}/sections/thesis/restore`, "POST"],
    [`${base}/flags`, "POST"],
  ])
  calls.forEach((c, i) => {
    expect(JSON.parse(String(c.init.body))).toEqual(bodies[i])
    expect(new Headers(c.init.headers).get("idempotency-key")).toBe(options.idempotencyKey)
    expect(new Headers(c.init.headers).get("x-api-key")).toBe(key)
    expect(c.init.redirect).toBe("manual")
  })
})

test("challenge bytes are untouched, never signed or followed by an implicit claim, and never retried", async () => {
  const challenge = {
    challengeId: versionId,
    message: "Candle token page creator proof v1\nNonce: 🕯\n",
    expiresAt: "2026-10-28T16:00:00Z",
  }
  const { client, calls } = fixture(() => ok(challenge))
  expect(await client.tokenPages.creatorChallenge(token)).toEqual(challenge)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url.pathname).toBe(`${base}/creator-challenges`)
  expect(calls[0]?.init.body).toBe("{}")
  expect(new Headers(calls[0]?.init.headers).has("idempotency-key")).toBe(false)
  const failed = fixture(() => {
    throw new Error("sensitive transport text")
  })
  await expect(failed.client.tokenPages.creatorChallenge(token)).rejects.toMatchObject({ code: "NETWORK_ERROR" })
  expect(failed.calls).toHaveLength(1)
})

test("lost write response retries identical bytes once, exposing the generated key", async () => {
  const body = { text: "original draft", baseRevision: "0" }
  const { client, calls } = fixture((_c, n) => {
    if (n === 1) {
      body.text = "draft changed locally"
      throw new Error("connection lost")
    }
    return ok({ id: versionId, revision: "1" })
  })
  const result = await client.tokenPages.setSection(token, "lore", body)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.init.body).toBe(calls[1]?.init.body)
  expect(JSON.parse(String(calls[1]?.init.body)).text).toBe("original draft")
  expect(result.idempotencyKey).toBeTruthy()
  for (const c of calls) expect(new Headers(c.init.headers).get("idempotency-key")).toBe(result.idempotencyKey)
})

test("two lost answers or a malformed success expose replay key without credentials or draft in the error", async () => {
  for (const malformed of [false, true]) {
    const { client, calls } = fixture(() => {
      if (malformed) return new Response("bad success")
      throw new Error("fixture-key secret draft")
    })
    try {
      await client.tokenPages.setSection(
        token,
        "lore",
        { text: "secret draft", baseRevision: "0" },
        { idempotencyKey: "replay" },
      )
      throw new Error("expected error")
    } catch (e) {
      expect(e).toBeInstanceOf(TokenPageError)
      expect(e).toMatchObject({ code: "OUTCOME_UNKNOWN", idempotencyKey: "replay" })
      expect(String(e)).not.toContain("fixture-key")
      expect(String(e)).not.toContain("secret draft")
    }
    expect(calls).toHaveLength(malformed ? 1 : 2)
  }
})

test("a response body interrupted after headers is retried with the same request identity", async () => {
  const { client, calls } = fixture((_call, n) => {
    if (n === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("cut off"))
          },
        }),
      )
    return ok({ state: "claimed", kind: "holder", creatorProven: false, revision: "1" })
  })
  const result = await client.tokenPages.claim(token, { kind: "holder" })
  expect(calls).toHaveLength(2)
  expect(calls[0]?.init.body).toBe(calls[1]?.init.body)
  for (const call of calls) expect(new Headers(call.init.headers).get("idempotency-key")).toBe(result.idempotencyKey)
  const next = await client.tokenPages.claim(token, { kind: "holder" })
  expect(next.idempotencyKey).not.toBe(result.idempotencyKey)
})

test("Hood proof signature remains unchanged and credentials never follow a foreign redirect", async () => {
  const hood = { chain: "hood" as const, address: `0x${"ab".repeat(20)}` }
  const signature = `0x${"cd".repeat(65)}`
  const success = fixture(() => ok({ state: "claimed", kind: "creator", creatorProven: true, revision: "1" }))
  await success.client.tokenPages.claim(hood, { kind: "creator", challengeId: versionId, signature })
  expect(JSON.parse(String(success.calls[0]?.init.body)).signature).toBe(signature)
  expect(success.calls[0]?.url.pathname).toBe(`/api/v1/token-pages/hood/${hood.address}/claims`)
  const redirected = fixture(
    () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
  )
  await expect(redirected.client.tokenPages.claim(hood, { kind: "holder" })).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
  })
  for (const call of redirected.calls) expect(call.url.origin).toBe("https://api.test")
})

test("server refusals preserve codes/status, retry-after and latest revision; no auto restore or retry", async () => {
  for (const [code, status] of [
    ["invalid_body", 400],
    ["invalid_token", 400],
    ["invalid_text", 422],
    ["invalid_signature", 422],
    ["challenge_used", 409],
    ["insufficient_holding", 403],
    ["restricted", 403],
    ["feature_off", 409],
    ["revision_conflict", 409],
    ["idempotency_conflict", 409],
    ["eligibility_unavailable", 503],
    ["rate_limited", 429],
  ] as const) {
    const latest = { revision: "9007199254740994", versionId }
    const { client, calls } = fixture(() =>
      Response.json({ success: false, error: code, latest }, { status, headers: { "retry-after": "60" } }),
    )
    const draft = { text: "my draft", baseRevision: "1" }
    await expect(
      client.tokenPages.setSection(token, "thesis", draft, { idempotencyKey: "keep" }),
    ).rejects.toMatchObject({
      code,
      status,
      latest,
      idempotencyKey: "keep",
      retryAfterHeader: "60",
    })
    expect(calls).toHaveLength(1)
    expect(draft).toEqual({ text: "my draft", baseRevision: "1" })
  }
})

test("middleware errors and old APIs retain CandleApiError compatibility", async () => {
  for (const [status, answer, code] of [
    [
      401,
      { success: false, error: { code: "UNAUTHORIZED", message: "missing auth", retryable: false } },
      "UNAUTHORIZED",
    ],
    [
      403,
      { success: false, error: { code: "SCOPE_MISSING", message: "wrong scope", retryable: false } },
      "SCOPE_MISSING",
    ],
    [404, "old API", "HTTP_404"],
  ] as const) {
    const { client, calls } = fixture(() =>
      typeof answer === "string" ? new Response(answer, { status }) : Response.json(answer, { status }),
    )
    try {
      await client.tokenPages.capabilities(token)
      throw new Error("expected refusal")
    } catch (e) {
      expect(e).toBeInstanceOf(CandleApiError)
      expect(e).toMatchObject({ code, status })
    }
    expect(calls).toHaveLength(1)
  }
})

test("all private calls require a key before transport; public reads remain usable", async () => {
  let calls = 0
  const client = new CandleClient({
    apiUrl: "https://api.test",
    fetch: (async () => {
      calls++
      return ok({})
    }) as unknown as typeof fetch,
  })
  for (const call of [
    () => client.tokenPages.capabilities(token),
    () => client.tokenPages.creatorChallenge(token),
    () => client.tokenPages.claim(token, { kind: "holder" }),
    () => client.tokenPages.setSection(token, "lore", { text: "", baseRevision: "0" }),
    () => client.tokenPages.restoreSection(token, "lore", { versionId, baseRevision: "1" }),
    () => client.tokenPages.flag(token, { contentId: versionId, reason: "spam" }),
  ])
    await expect(call()).rejects.toThrow(/key/i)
  expect(calls).toBe(0)
  await client.tokenPages.about(token)
  expect(calls).toBe(1)
})
