/**
 * BE-1283 (spec `2026-10-11-agent-launch-local-image-design.md`, 3.1 and 4): `candle image upload`.
 *
 * The file is checked on this machine before any request: its type comes from its first bytes and
 * never from its name, and a file over 10MB is refused unread past the ceiling. What does reach
 * Candle is the raw bytes under the sniffed content type and the key, and a refusal from the route
 * comes back with the server's own code and message. `candle launch --image` runs the same read and
 * the same upload; its tests are beside the launch's (swap.test.ts, launch-transfer-hood.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { MAX_IMAGE_BYTES, sniffImageType } from "./image"

const HOSTED = "https://ipfs.candle.test/ipfs/bafyimage"
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface Sent {
  path: string
  search: string
  method: string | undefined
  headers: Headers
  bytes: Uint8Array
}

async function fixture(opts: { answer?: () => Response; key?: string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-image-"))
  folders.push(dir)
  const sent: Sent[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      path: new URL(String(input)).pathname,
      search: new URL(String(input)).search,
      method: init?.method,
      headers: new Headers(init?.headers),
      bytes: init?.body as Uint8Array,
    })
    return opts.answer ? opts.answer() : Response.json({ success: true, imageUrl: HOSTED })
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, ...(opts.key === null ? {} : { CANDLE_API_KEY: opts.key ?? "launch-key" }) },
    stdout,
    stderr,
  })
  const file = async (name: string, bytes: number[] | Uint8Array) => {
    const path = join(dir, name)
    await writeFile(path, Uint8Array.from(bytes))
    return path
  }
  return { deps, dir, sent, stdout, stderr, file }
}

const refusal = (code: string, message: string, status: number) => () =>
  Response.json({ success: false, error: { code, message } }, { status })

describe("sniffImageType reads the first bytes, and nothing else", () => {
  test("the four types Candle hosts", () => {
    expect(sniffImageType(Uint8Array.from(PNG))).toBe("image/png")
    expect(sniffImageType(Uint8Array.from(JPEG))).toBe("image/jpeg")
    expect(sniffImageType(Uint8Array.from(GIF))).toBe("image/gif")
    expect(sniffImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe("image/gif")
    expect(sniffImageType(Uint8Array.from(WEBP))).toBe("image/webp")
  })

  test("anything else is no type: text, an empty file, a truncated signature, a RIFF that is not WebP", () => {
    expect(sniffImageType(new TextEncoder().encode("not an image"))).toBeUndefined()
    expect(sniffImageType(new Uint8Array(0))).toBeUndefined()
    expect(sniffImageType(Uint8Array.from(PNG.slice(0, 7)))).toBeUndefined()
    expect(sniffImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBeUndefined()
    // A WAV file is a RIFF container too.
    expect(
      sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])),
    ).toBeUndefined()
    // An SVG is an image, and not one of the four.
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined()
  })
})

describe("candle image upload", () => {
  // The name says one thing and the bytes another on purpose: only the bytes are read.
  const TYPES: { name: string; bytes: number[]; contentType: string }[] = [
    { name: "logo.dat", bytes: PNG, contentType: "image/png" },
    { name: "logo.png", bytes: JPEG, contentType: "image/jpeg" },
    { name: "logo", bytes: GIF, contentType: "image/gif" },
    { name: "logo.jpg", bytes: WEBP, contentType: "image/webp" },
  ]
  for (const { name, bytes, contentType } of TYPES) {
    test(`${contentType}: the raw bytes go to the upload route under that content type and the key`, async () => {
      const f = await fixture()
      const path = await f.file(name, bytes)
      expect(await run(["image", "upload", path], f.deps)).toBe(0)
      expect(f.sent).toHaveLength(1)
      const [request] = f.sent
      expect(request?.path).toBe("/api/v1/uploads/agent-image")
      expect(request?.method).toBe("POST")
      expect(request?.headers.get("content-type")).toBe(contentType)
      expect(request?.headers.get("x-api-key")).toBe("launch-key")
      expect([...(request?.bytes ?? [])]).toEqual(bytes)
      // The URL alone on stdout, so `$(candle image upload logo.png)` is the link.
      expect(f.stdout.text).toBe(`${HOSTED}\n`)
      expect(f.stderr.text).toContain(`(${contentType}, ${bytes.length} bytes)`)
      expect(f.stderr.text.replace(/\s+/g, " ")).toContain("The file becomes public and permanent")
    })
  }

  test("without --banner no kind is sent: the token image is the square crop", async () => {
    const f = await fixture()
    const path = await f.file("logo.png", PNG)
    expect(await run(["image", "upload", path], f.deps)).toBe(0)
    expect(f.sent[0]?.search).toBe("")
  })

  test("--banner uploads with kind=banner and prints the URL", async () => {
    const f = await fixture()
    const path = await f.file("banner.png", PNG)
    expect(await run(["image", "upload", path, "--banner"], f.deps)).toBe(0)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.path).toBe("/api/v1/uploads/agent-image")
    expect(f.sent[0]?.search).toBe("?kind=banner")
    expect([...(f.sent[0]?.bytes ?? [])]).toEqual(PNG)
    expect(f.stdout.text).toBe(`${HOSTED}\n`)
  })

  test("--banner passes the server's BANNER_WRONG_SHAPE refusal through for a square image", async () => {
    const message = "Banner is 800x800: send the original as the banner"
    const f = await fixture({ answer: refusal("BANNER_WRONG_SHAPE", message, 400) })
    const path = await f.file("square.png", PNG)
    expect(await run(["image", "upload", path, "--banner", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "BANNER_WRONG_SHAPE", message })
  })

  test("--json is one value: the URL, the content type and the size", async () => {
    const f = await fixture()
    const path = await f.file("logo.png", PNG)
    expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({
      success: true,
      imageUrl: HOSTED,
      contentType: "image/png",
      bytes: PNG.length,
    })
  })

  test("a text file renamed .png is refused here, with no request made", async () => {
    const f = await fixture()
    const path = await f.file("logo.png", new TextEncoder().encode("this is not an image"))
    expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(1)
    expect(f.sent).toEqual([])
    const failure = JSON.parse(f.stdout.text)
    expect(failure).toMatchObject({ ok: false, code: "IMAGE_TYPE_UNSUPPORTED" })
    expect(failure.message).toContain("is not a PNG, JPEG, GIF or WebP image")
    expect(failure.message).toContain("Nothing was uploaded.")
  })

  test("an 11MB file is refused here, with no request made, whatever its first bytes are", async () => {
    const f = await fixture()
    const big = new Uint8Array(11 * 1024 * 1024)
    big.set(PNG)
    const path = await f.file("big.png", big)
    expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(1)
    expect(f.sent).toEqual([])
    const failure = JSON.parse(f.stdout.text)
    expect(failure).toMatchObject({ ok: false, code: "IMAGE_TOO_LARGE" })
    expect(failure.message).toContain("is over 10MB")
  })

  test("the ceiling is the route's: exactly 10MB is sent, and one byte more is refused", async () => {
    const f = await fixture()
    const atLimit = new Uint8Array(MAX_IMAGE_BYTES)
    atLimit.set(PNG)
    expect(await run(["image", "upload", await f.file("at-limit.png", atLimit)], f.deps)).toBe(0)
    expect(f.sent[0]?.bytes.length).toBe(MAX_IMAGE_BYTES)
    const over = new Uint8Array(MAX_IMAGE_BYTES + 1)
    over.set(PNG)
    expect(await run(["image", "upload", await f.file("over.png", over)], f.deps)).toBe(1)
    expect(f.sent).toHaveLength(1)
  })

  test("a path that is missing, or is a directory, is IMAGE_UNREADABLE with no request made", async () => {
    const f = await fixture()
    expect(await run(["image", "upload", join(f.dir, "absent.png"), "--json"], f.deps)).toBe(1)
    const missing = JSON.parse(f.stdout.text)
    expect(missing).toMatchObject({ ok: false, code: "IMAGE_UNREADABLE" })
    expect(missing.message).toContain("there is no file at that path")

    const g = await fixture()
    await mkdir(join(g.dir, "art.png"))
    expect(await run(["image", "upload", join(g.dir, "art.png"), "--json"], g.deps)).toBe(1)
    const directory = JSON.parse(g.stdout.text)
    expect(directory).toMatchObject({ ok: false, code: "IMAGE_UNREADABLE" })
    expect(directory.message).toContain("it is not a file")
    expect([...f.sent, ...g.sent]).toEqual([])
  })

  for (const [code, message, status] of [
    ["RATE_LIMITED", "Too many image uploads; retry shortly", 429],
    ["UPLOAD_INVALID", "Image must be JPEG, PNG, GIF, or WebP", 400],
    ["SCOPE_MISSING", "This key lacks launch:write", 403],
  ] as const) {
    test(`the route's ${code} comes back unchanged, code and message`, async () => {
      const f = await fixture({ answer: refusal(code, message, status) })
      const path = await f.file("logo.png", PNG)
      expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text)).toEqual({ ok: false, code, message })
    })
  }

  test("an answer without an https imageUrl is INVALID_RESPONSE, and no URL is printed", async () => {
    for (const body of [{ success: true }, { success: true, imageUrl: "http://plain.test/a.png" }]) {
      const f = await fixture({ answer: () => Response.json(body) })
      const path = await f.file("logo.png", PNG)
      expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "INVALID_RESPONSE" })
    }
  })

  test("without an API key it is NO_API_KEY, naming the scope, with no request made", async () => {
    const f = await fixture({ key: null })
    const path = await f.file("logo.png", PNG)
    expect(await run(["image", "upload", path, "--json"], f.deps)).toBe(1)
    expect(f.sent).toEqual([])
    const failure = JSON.parse(f.stdout.text)
    expect(failure).toMatchObject({ ok: false, code: "NO_API_KEY" })
    expect(failure.suggestion).toContain("launch:write")
  })

  test("usage: no path, two paths and an unknown flag are exit 2 with no request", async () => {
    for (const argv of [
      ["image", "upload"],
      ["image", "upload", "/tmp/a.png", "/tmp/b.png"],
      ["image", "upload", "/tmp/a.png", "--public"],
    ]) {
      const f = await fixture()
      expect([argv, await run(argv, f.deps)]).toEqual([argv, 2])
      expect(f.sent).toEqual([])
      expect(f.stdout.text).toBe("")
    }
  })

  test("a bare `candle image` is a routing failure that shows the topic, like any word with no bare form", async () => {
    const f = await fixture()
    expect(await run(["image"], f.deps)).toBe(1)
    expect(f.sent).toEqual([])
    expect(f.stderr.text + f.stdout.text).toContain("candle image upload <path>")
  })
})
