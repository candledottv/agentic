import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CandleApiError } from "./errors"

test("own profile methods use key-authenticated self routes and preserve PATCH fields", async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, init })
    return Response.json({ success: true, profileId: "prof_0123456789abcdef", canEdit: true })
  }) as unknown as typeof fetch
  const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "fixture-key", fetch: fetcher })
  expect((await client.getOwnProfile()).canEdit).toBe(true)
  const patch = { publicThesis: "Trades 0.5 sol", publicLinks: { website: "https://example.com", x: "fixture" } }
  await client.updateOwnProfile(patch)
  await client.uploadProfileImage("banner", new Uint8Array([1, 2, 3]), "image/png")
  expect(calls.map((call) => [call.path, call.init?.method])).toEqual([
    ["/api/v1/agent/keys/self/public-profile", "GET"],
    ["/api/v1/agent/keys/self/public-profile", "PATCH"],
    ["/api/v1/uploads/agent-profile-image", "POST"],
  ])
  for (const call of calls) expect(new Headers(call.init?.headers).get("x-api-key")).toBe("fixture-key")
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(patch)
  const form = calls[2]?.init?.body as FormData
  expect(form.get("kind")).toBe("banner")
  expect((form.get("image") as File).type).toBe("image/png")
  expect(new Headers(calls[2]?.init?.headers).has("content-type")).toBe(false)
})

test("own profile methods need a key and preserve server denials", async () => {
  const fetcher = (async () =>
    Response.json(
      { success: false, error: { code: "PROFILE_SELF_EDIT_DENIED", message: "Off", retryable: false } },
      { status: 403 },
    )) as unknown as typeof fetch
  const anonymous = new CandleClient({ apiUrl: "https://api.test", fetch: fetcher })
  await expect(anonymous.getOwnProfile()).rejects.toThrow(/key/i)
  await expect(anonymous.updateOwnProfile({ publicThesis: "x" })).rejects.toThrow(/key/i)
  await expect(anonymous.uploadProfileImage("avatar", new Uint8Array(), "image/png")).rejects.toThrow(/key/i)
  const client = new CandleClient({ apiUrl: "https://api.test", apiKey: "fixture-key", fetch: fetcher })
  try {
    await client.updateOwnProfile({ publicThesis: "x" })
    throw new Error("Expected denial")
  } catch (err) {
    expect(err).toBeInstanceOf(CandleApiError)
    expect(err).toMatchObject({ code: "PROFILE_SELF_EDIT_DENIED", status: 403, retryable: false })
  }
})
