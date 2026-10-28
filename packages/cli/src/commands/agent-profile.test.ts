import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function localImage(bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
  const dir = await mkdtemp(join(tmpdir(), "profile-image-"))
  dirs.push(dir)
  const path = join(dir, "artwork.dat")
  await writeFile(path, bytes)
  return path
}

test("profile file flags publish multipart bytes with sniffed MIME and save without PATCH", async () => {
  const path = await localImage()
  for (const kind of ["avatar", "banner"]) {
    const imageUrl = `https://uploads.candle.tv/agent-public-${kind}s/owner/profile.image`
    const f = fixture(Response.json({ success: true, profileId: "prof_0123456789abcdef", imageUrl }))
    expect(await run(["agent", "profile", "set", `--${kind}-file`, path, "--json"], f.deps)).toBe(0)
    expect(f.calls).toHaveLength(1)
    const sent = f.calls[0]
    expect(sent?.path).toBe("/api/v1/uploads/agent-profile-image")
    expect(sent?.init?.method).toBe("POST")
    expect(new Headers(sent?.init?.headers).get("x-api-key")).toBe("fixture-key")
    expect(new Headers(sent?.init?.headers).has("content-type")).toBe(false)
    const form = sent?.init?.body as FormData
    expect(form.get("kind")).toBe(kind)
    const image = form.get("image") as File
    expect(image.type).toBe("image/png")
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()))
    expect(f.stderr.text).toContain("become public")
    expect(JSON.parse(f.stdout.text)).toMatchObject({ success: true, imageUrl, images: { [kind]: imageUrl } })
  }
})

test("both file flags and text use separate writes, with all files checked before the first write", async () => {
  const path = await localImage()
  const f = fixture(
    Response.json({ success: true, profileId: "prof_0123456789abcdef", imageUrl: "https://uploads.candle.tv/image" }),
  )
  expect(
    await run(
      ["agent", "profile", "set", "--bio", "Hello", "--avatar-file", path, "--banner-file", path, "--json"],
      f.deps,
    ),
  ).toBe(0)
  expect(f.calls.map((call) => call.init?.method)).toEqual(["PATCH", "POST", "POST"])
  expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ publicThesis: "Hello" })
  expect(JSON.parse(f.stdout.text).images).toEqual({
    avatar: "https://uploads.candle.tv/image",
    banner: "https://uploads.candle.tv/image",
  })
  const bad = fixture()
  expect(
    await run(
      [
        "agent",
        "profile",
        "set",
        "--bio",
        "Hello",
        "--avatar-file",
        path,
        "--banner-file",
        `${path}/missing`,
        "--json",
      ],
      bad.deps,
    ),
  ).toBe(1)
  expect(bad.calls).toEqual([])
})

test("file/URL conflicts, missing values and literal tilde paths are usage errors before any request", async () => {
  for (const args of [
    ["--avatar", "https://uploads.candle.tv/a", "--avatar-file", "/missing"],
    ["--banner", "https://uploads.candle.tv/a", "--banner-file", "/missing"],
    ["--avatar-file"],
    ["--avatar-file", "~/avatar.png"],
  ]) {
    const f = fixture()
    expect(await run(["agent", "profile", "set", ...args, "--json"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  }
})

test("non-images and files above 10MB are refused locally", async () => {
  for (const [bytes, code] of [
    [new Uint8Array([1, 2, 3]), "IMAGE_TYPE_UNSUPPORTED"],
    [new Uint8Array(10 * 1024 * 1024 + 1), "IMAGE_TOO_LARGE"],
  ] as const) {
    const path = await localImage(bytes)
    const f = fixture()
    expect(await run(["agent", "profile", "set", "--avatar-file", path, "--json"], f.deps)).toBe(1)
    expect(f.calls).toEqual([])
    expect(JSON.parse(f.stdout.text).code).toBe(code)
  }
})

test("profile uploads relay shape, permission, quota and storage refusals", async () => {
  const path = await localImage()
  for (const [status, code] of [
    [400, "BANNER_WRONG_SHAPE"],
    [403, "PROFILE_SELF_EDIT_DENIED"],
    [429, "RATE_LIMITED"],
    [503, "LAUNCH_FAILED"],
  ] as const) {
    const f = fixture(Response.json({ success: false, error: { code, message: "Refused" } }, { status }))
    expect(await run(["agent", "profile", "set", "--banner-file", path, "--json"], f.deps)).toBe(1)
    expect(f.calls).toHaveLength(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ code, status })
  }
})

test("a successful upload response without a profile-hosted URL is not reported as saved", async () => {
  const path = await localImage()
  const f = fixture(Response.json({ success: true, imageUrl: "https://ipfs.example/image.png" }))
  expect(await run(["agent", "profile", "set", "--avatar-file", path, "--json"], f.deps)).toBe(1)
  expect(JSON.parse(f.stdout.text).code).toBe("INVALID_RESPONSE")
})
