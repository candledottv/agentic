import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const PROFILE = "prof_0123456789abcdef"
const MINT = "So11111111111111111111111111111111111111112"

function fixture(answer: (path: string) => Response = () => Response.json({ success: true, profileId: PROFILE })) {
  const calls: { path: string; search: string; init?: RequestInit }[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: "fixture-key" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, search: url.search, init })
      return answer(url.pathname)
    }) as typeof fetch,
  })
  return { deps, calls, stdout, stderr }
}
const keyOf = (call: { init?: RequestInit } | undefined) => new Headers(call?.init?.headers).get("x-api-key")

test("candle agent post create sends the text and the optional token with the key", async () => {
  const plain = fixture()
  expect(await run(["agent", "post", "create", "--text", "line one\nline two", "--json"], plain.deps)).toBe(0)
  expect(plain.calls).toHaveLength(1)
  expect(plain.calls[0]?.path).toBe("/api/v1/agent/posts")
  expect(plain.calls[0]?.init?.method).toBe("POST")
  expect(keyOf(plain.calls[0])).toBe("fixture-key")
  expect(JSON.parse(String(plain.calls[0]?.init?.body))).toEqual({ text: "line one\nline two" })
  expect(JSON.parse(plain.stdout.text).profileId).toBe(PROFILE)

  const chipped = fixture()
  expect(
    await run(["agent", "post", "create", "--text", "thesis", "--chain", "solana", "--mint", MINT], chipped.deps),
  ).toBe(0)
  expect(JSON.parse(String(chipped.calls[0]?.init?.body))).toEqual({
    text: "thesis",
    token: { chain: "solana", mint: MINT },
  })
})

test("candle agent post delete names the post in the path", async () => {
  const f = fixture()
  expect(await run(["agent", "post", "delete", "id with/slash", "--json"], f.deps)).toBe(0)
  expect(f.calls[0]?.path).toBe("/api/v1/agent/posts/id%20with%2Fslash")
  expect(f.calls[0]?.init?.method).toBe("DELETE")
  expect(f.calls[0]?.init?.body).toBeUndefined()
  expect(keyOf(f.calls[0])).toBe("fixture-key")
})

test("candle agent post list reads a named profile without a key, and this key's own with none named", async () => {
  const page = { success: true, posts: [{ id: "p1", text: "hello", createdAt: 1, token: null }], cursor: null }
  const named = fixture(() => Response.json(page))
  expect(await run(["agent", "post", "list", PROFILE, "--limit", "5", "--cursor", "1:2", "--json"], named.deps)).toBe(0)
  expect(named.calls).toHaveLength(1)
  expect(named.calls[0]?.path).toBe(`/api/v1/agent/records/${PROFILE}/posts`)
  expect(named.calls[0]?.search).toBe("?limit=5&cursor=1%3A2")
  expect(keyOf(named.calls[0])).toBeNull()
  expect(JSON.parse(named.stdout.text).posts[0].text).toBe("hello")

  const own = fixture((path) =>
    path.endsWith("/public-profile") ? Response.json({ success: true, profileId: PROFILE }) : Response.json(page),
  )
  expect(await run(["agent", "post", "list", "--json"], own.deps)).toBe(0)
  expect(own.calls.map((call) => call.path)).toEqual([
    "/api/v1/agent/keys/self/public-profile",
    `/api/v1/agent/records/${PROFILE}/posts`,
  ])
  expect(keyOf(own.calls[0])).toBe("fixture-key")
  expect(keyOf(own.calls[1])).toBeNull()
})

test("malformed input is a usage error with no request", async () => {
  for (const args of [
    [],
    ["publish"],
    ["create"],
    ["create", "--text", "x", "extra"],
    ["create", "--text", "x", "--chain", "solana"],
    ["create", "--text", "x", "--mint", MINT],
    ["create", "--text", "x", "--chain", "base", "--mint", MINT],
    ["create", "--text", "x", "--limit", "5"],
    ["create", "--text", "x", "--profile-id", PROFILE],
    ["delete"],
    ["delete", "a", "b"],
    ["delete", "a", "--text", "x"],
    ["list", PROFILE, "extra"],
    ["list", "--limit", "0"],
    ["list", "--limit", "many"],
    ["list", "--text", "x"],
  ]) {
    const f = fixture()
    expect(await run(["agent", "post", ...args, "--json"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(JSON.parse(f.stdout.text).code).toBe("USAGE")
  }
})

test("server refusals remain structured failures", async () => {
  for (const [status, code, args] of [
    [403, "PROFILE_SELF_EDIT_DENIED", ["create", "--text", "x"]],
    [403, "SCOPE_MISSING", ["create", "--text", "x"]],
    [429, "RATE_LIMITED", ["create", "--text", "x"]],
    [404, "RECORD_NOT_FOUND", ["delete", "p1"]],
    [404, "RECORD_NOT_FOUND", ["list", PROFILE]],
    [403, "PROFILE_SELF_EDIT_DENIED", ["list"]],
  ] as const) {
    const f = fixture(() =>
      Response.json({ success: false, error: { code, message: "Refused", retryable: false } }, { status }),
    )
    expect(await run(["agent", "post", ...args, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code, status })
  }
})
