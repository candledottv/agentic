import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

const PROFILE = "prof_0123456789abcdef"
const POST = { id: "post-fixture", text: "thesis\nline two", createdAt: 1_700_000_000_000, token: null }

function recorder(answer: (path: string) => unknown) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return Response.json(answer(url.pathname))
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

test("createPost and deletePost use the key-authenticated post routes and send the body as given", async () => {
  const { calls, fetcher } = recorder((path) =>
    path.endsWith("/posts")
      ? { success: true, profileId: PROFILE, post: POST }
      : { success: true, profileId: PROFILE, postId: POST.id },
  )
  const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "fixture-key", fetch: fetcher })
  const request = {
    text: POST.text,
    token: { chain: "solana" as const, mint: "So11111111111111111111111111111111111111112" },
  }
  expect((await client.createPost(request)).post).toEqual(POST)
  expect(await client.deletePost("id with/slash")).toMatchObject({ profileId: PROFILE, postId: POST.id })
  expect(calls.map((call) => [call.url.pathname, call.init?.method])).toEqual([
    ["/api/v1/agent/posts", "POST"],
    ["/api/v1/agent/posts/id%20with%2Fslash", "DELETE"],
  ])
  for (const call of calls) expect(new Headers(call.init?.headers).get("x-api-key")).toBe("fixture-key")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request)
  expect(calls[1]?.init?.body).toBeUndefined()
})

test("listAgentPosts is keyless, pages by cursor and unwraps the page", async () => {
  const { calls, fetcher } = recorder(() => ({ success: true, posts: [POST], cursor: "1700000000000:1.5" }))
  const client = new CandleClient({ apiUrl: "https://api.test", fetch: fetcher })
  expect(await client.listAgentPosts(PROFILE)).toEqual({ posts: [POST], cursor: "1700000000000:1.5" })
  await client.listAgentPosts(PROFILE, { limit: 5, cursor: "1700000000000:1.5" })
  expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
    `/api/v1/agent/records/${PROFILE}/posts`,
    `/api/v1/agent/records/${PROFILE}/posts?limit=5&cursor=1700000000000%3A1.5`,
  ])
  for (const call of calls) {
    expect(call.init?.method).toBe("GET")
    expect(new Headers(call.init?.headers).has("x-api-key")).toBe(false)
  }
})

test("post writes need a key, and a server refusal keeps its code and status", async () => {
  const refusal = (code: string, status: number) =>
    (async () =>
      Response.json(
        { success: false, error: { code, message: "refused", retryable: false } },
        { status },
      )) as unknown as typeof fetch
  const anonymous = new CandleClient({ apiUrl: "https://api.test", fetch: refusal("SCOPE_MISSING", 403) })
  await expect(anonymous.createPost({ text: "x" })).rejects.toThrow(/key/i)
  await expect(anonymous.deletePost("x")).rejects.toThrow(/key/i)
  for (const [code, status] of [
    ["PROFILE_SELF_EDIT_DENIED", 403],
    ["SCOPE_MISSING", 403],
    ["RATE_LIMITED", 429],
    ["RECORD_NOT_FOUND", 404],
  ] as const) {
    const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "fixture-key", fetch: refusal(code, status) })
    for (const call of [
      () => client.createPost({ text: "x" }),
      () => client.deletePost("x"),
      () => client.listAgentPosts(PROFILE),
    ]) {
      try {
        await call()
        throw new Error("Expected a refusal")
      } catch (err) {
        expect(err).toBeInstanceOf(CandleApiError)
        expect(err).toMatchObject({ code, status })
      }
    }
  }
})
