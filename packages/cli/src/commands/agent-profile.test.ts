import { expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

function fixture(response: Response = Response.json({ success: true, profileId: "prof_0123456789abcdef" })) {
  const calls: { path: string; init?: RequestInit }[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: "fixture-key" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, init })
      return response.clone()
    }) as typeof fetch,
  })
  return { deps, calls, stdout, stderr }
}

test("candle agent profile show and set reach the self routes", async () => {
  const show = fixture()
  expect(await run(["agent", "profile", "show", "--json"], show.deps)).toBe(0)
  expect(show.calls[0]?.init?.method).toBe("GET")
  expect(JSON.parse(show.stdout.text).profileId).toBe("prof_0123456789abcdef")
  const set = fixture()
  expect(
    await run(
      [
        "agent",
        "profile",
        "set",
        "--bio",
        "Trades 0.5 sol",
        "--models",
        "claude,gpt",
        "--links",
        '{"x":"fixture"}',
        "--json",
      ],
      set.deps,
    ),
  ).toBe(0)
  expect(set.calls[0]?.path).toBe("/api/v1/agent/keys/self/public-profile")
  expect(set.calls[0]?.init?.method).toBe("PATCH")
  expect(new Headers(set.calls[0]?.init?.headers).get("x-api-key")).toBe("fixture-key")
  expect(JSON.parse(String(set.calls[0]?.init?.body))).toEqual({
    publicThesis: "Trades 0.5 sol",
    publicModels: ["claude", "gpt"],
    publicLinks: { x: "fixture" },
  })
})

test("unknown/owner-only flags and malformed input are usage errors with no profile write", async () => {
  for (const args of [
    ["set"],
    ["set", "--name", "rename"],
    ["set", "--slug", "slug"],
    ["set", "--links", "bad-json"],
    ["show", "--bio", "x"],
  ]) {
    const f = fixture()
    expect(await run(["agent", "profile", ...args, "--json"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
    expect(JSON.parse(f.stdout.text).code).toBe("USAGE")
  }
})

test("server permission and quota errors remain structured failures", async () => {
  for (const [status, code] of [
    [403, "PROFILE_SELF_EDIT_DENIED"],
    [429, "RATE_LIMITED"],
  ] as const) {
    const f = fixture(
      Response.json({ success: false, error: { code, message: "Refused", retryable: false } }, { status }),
    )
    expect(await run(["agent", "profile", "set", "--bio", "x", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code, status })
  }
})
