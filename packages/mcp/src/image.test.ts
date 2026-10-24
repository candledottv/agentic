/**
 * `imagePath` on the two launch tools (BE-1346, spec 3.2 and the test list in section 4).
 *
 * The directory tests run against real files in a temp directory, links included, because the
 * boundary is a property of what the filesystem resolves and a mocked one would only restate the
 * code. Only the three cases that need a path to change BETWEEN two calls, or a handle that lies
 * about its file, wrap the real operations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  configuredImageDir,
  type ImageFs,
  ImageRefusal,
  MAX_IMAGE_BYTES,
  OUTSIDE_IMAGE_DIR,
  readImageInDir,
  sniffImageType,
} from "./image"
import { executeLaunchAndSeed } from "./orchestrate"
import { registerToolSubset } from "./tools"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4])
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2])

const HOSTED = "https://ipfs.example/ipfs/QmHosted"
const CFG = { apiUrl: "https://api.test", apiKey: "cndl_test_key" }
const realFs: ImageFs = { realpath, lstat, open }

let root: string
let dir: string
let outsideDir: string

beforeAll(() => {
  // Resolved up front: the temp directory is itself behind a link on some machines.
  root = realpathSync(mkdtempSync(join(tmpdir(), "candle-image-")))
  dir = join(root, "pics")
  outsideDir = join(root, "private")
  mkdirSync(join(dir, "nested"), { recursive: true })
  mkdirSync(outsideDir)
  mkdirSync(join(root, "pics-sibling"))
  writeFileSync(join(dir, "logo.png"), PNG)
  writeFileSync(join(dir, "photo.jpg"), JPEG)
  writeFileSync(join(dir, "loop.gif"), GIF)
  writeFileSync(join(dir, "nested", "art.webp"), WEBP)
  writeFileSync(join(dir, "notes.png"), "these are words, not pixels")
  writeFileSync(join(dir, "exact.png"), bytesOf(MAX_IMAGE_BYTES))
  writeFileSync(join(dir, "huge.png"), bytesOf(11 * 1024 * 1024))
  writeFileSync(join(outsideDir, "seed-phrase.png"), PNG)
  writeFileSync(join(root, "pics-sibling", "logo.png"), PNG)
  symlinkSync(join(outsideDir, "seed-phrase.png"), join(dir, "escape.png"))
  symlinkSync(outsideDir, join(dir, "escape-dir"))
  symlinkSync(join(outsideDir, "nothing-here.png"), join(dir, "dangling.png"))
  symlinkSync(join(dir, "logo.png"), join(dir, "alias.png"))
  symlinkSync(dir, join(root, "pics-link"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A PNG signature followed by filler, `size` bytes in all. */
function bytesOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(PNG)
  return bytes
}

async function refusal(run: Promise<unknown>): Promise<ImageRefusal> {
  try {
    await run
  } catch (error) {
    if (error instanceof ImageRefusal) return error
    throw error
  }
  throw new Error("expected a refusal")
}

type Call = { url: string; init?: RequestInit }
type Route = { status?: number; body: unknown }

/** A fetch that records every request and answers by URL; an unrouted URL is a test failure. */
function recordingFetch(routes: Record<string, Route>) {
  const calls: Call[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`unrouted request: ${url}`)
    const status = route.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(route.body) }
  }
  return { calls, fetch }
}

const UPLOAD = "https://api.test/api/v1/uploads/agent-image"
const LAUNCH = "https://api.test/api/v1/launch/headless"
const DRY_RUN = "https://api.test/api/v1/launch/headless/dry-run"
const LAUNCHED = { success: true, chain: "solana", mint: "NewMint111", signature: "Sig111" }
// BE-1849: a Solana seed is an atomic launch, built then submitted, with both legs signed by Candle.
const ATOMIC_BUILD = "https://api.test/api/v1/launch/atomic/build"
const ATOMIC_SUBMIT = "https://api.test/api/v1/launch/atomic/submit"
const BUNDLE_LANDED = { status: "landed", bundleId: "b-1", mint: "NewMint111", signatures: ["S0", "S1"] }
const SEED = { payer: { type: "main" }, amountRaw: "250000000" }
const ROUTES = {
  [UPLOAD]: { body: { success: true, imageUrl: HOSTED } },
  [LAUNCH]: { body: LAUNCHED },
  [ATOMIC_BUILD]: {
    body: {
      bundleId: "b-1",
      legs: [
        { index: 0, role: "launch", signer: "server" },
        { index: 1, role: "buy", signer: "server" },
      ],
    },
  },
  [ATOMIC_SUBMIT]: { body: BUNDLE_LANDED },
  [DRY_RUN]: { body: { success: true, checks: { image: "ok" } } },
  "https://api.test/api/v1/markets/solana/NewMint111": { body: { success: true, market: { mint: "NewMint111" } } },
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
type Registered = { config: { description: string; inputSchema: Record<string, unknown> }; handler: Handler }

/** The two launch tools as a host with this environment registers them. */
function launchTools(env: Record<string, string | undefined> | undefined, fetch: ReturnType<typeof recordingFetch>) {
  const tools = new Map<string, Registered>()
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Handler) {
      tools.set(name, { config, handler })
    },
  } as unknown as Parameters<typeof registerToolSubset>[0]
  registerToolSubset(server, {
    tools: ["candle_launch_token", "candle_launch_and_seed"],
    getConfig: () => CFG,
    fetch: fetch.fetch,
    ...(env ? { env } : {}),
  })
  return {
    token: tools.get("candle_launch_token") as Registered,
    seed: tools.get("candle_launch_and_seed") as Registered,
  }
}

const TOKEN = { clientLaunchId: "L-1", name: "T", symbol: "T" }

describe("sniffImageType", () => {
  test("names the four types Candle hosts from their first bytes, and nothing else", () => {
    expect(sniffImageType(PNG)).toBe("image/png")
    expect(sniffImageType(JPEG)).toBe("image/jpeg")
    expect(sniffImageType(GIF)).toBe("image/gif")
    expect(sniffImageType(WEBP)).toBe("image/webp")
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined()
    expect(sniffImageType(new Uint8Array(0))).toBeUndefined()
  })
})

describe("CANDLE_IMAGE_DIR selects the launch schema", () => {
  test("unset or blank: imagePath is absent and imageUrl stays required, on both tools", () => {
    expect(configuredImageDir({})).toBeUndefined()
    expect(configuredImageDir({ CANDLE_IMAGE_DIR: "   " })).toBeUndefined()
    for (const env of [undefined, {}, { CANDLE_IMAGE_DIR: "" }, { CANDLE_IMAGE_DIR: "  " }]) {
      const { token, seed } = launchTools(env, recordingFetch({}))
      for (const tool of [token, seed]) {
        expect(Object.keys(tool.config.inputSchema)).not.toContain("imagePath")
        expect((tool.config.inputSchema.imageUrl as { isOptional(): boolean }).isOptional()).toBe(false)
        expect(tool.config.description).not.toContain("imagePath")
      }
    }
  })

  test("set: both tools offer imagePath beside an optional imageUrl, and say an upload is a publication", () => {
    const { token, seed } = launchTools({ CANDLE_IMAGE_DIR: dir }, recordingFetch({}))
    for (const tool of [token, seed]) {
      const shape = tool.config.inputSchema as Record<string, { isOptional(): boolean; description?: string }>
      expect(shape.imageUrl?.isOptional()).toBe(true)
      expect(shape.imagePath?.isOptional()).toBe(true)
      expect(shape.imagePath?.description).toContain(
        "An absolute image path inside CANDLE_IMAGE_DIR. The file is uploaded and becomes public and permanent, including on a dry run.",
      )
      expect(shape.imagePath?.description).toContain("does not count against the launch cap")
      expect(tool.config.description).toContain("public and permanent, on a dry run too")
      expect(`${tool.config.description} ${shape.imagePath?.description}`).not.toMatch(/stays? private|kept private/i)
    }
    // The seeded tool keeps its own fields and still does not advertise the raw buyAmount.
    expect(Object.keys(seed.config.inputSchema)).toContain("devBuy")
    expect(Object.keys(seed.config.inputSchema)).not.toContain("buyAmount")
    expect(Object.keys(token.config.inputSchema)).toContain("buyAmount")
  })

  test("with no directory, an imagePath that reaches a handler is refused and no file is read", async () => {
    const fetch = recordingFetch(ROUTES)
    const { token, seed } = launchTools(undefined, fetch)
    for (const tool of [token, seed]) {
      const result = await tool.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
      expect(result.isError).toBe(true)
      const body = JSON.parse(result.content[0]?.text ?? "{}")
      expect(body.error.code).toBe("MCP_VALIDATION")
      expect(body.error.message).toContain("imagePath is not available on this server")
    }
    expect(fetch.calls).toEqual([])
  })

  test("with no directory, a URL launch is sent exactly as before", async () => {
    const fetch = recordingFetch(ROUTES)
    const { token } = launchTools(undefined, fetch)
    const result = await token.handler({ ...TOKEN, imageUrl: "https://x/y.png" })
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(fetch.calls.map((call) => call.url)).toEqual([LAUNCH])
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({ ...TOKEN, imageUrl: "https://x/y.png" })
  })
})

describe("an invalid CANDLE_IMAGE_DIR never falls back to reading anywhere", () => {
  test.each([
    ["a relative path", () => "pics"],
    ["a directory that does not exist", () => join(root, "no-such-dir")],
    ["a file, not a directory", () => join(dir, "logo.png")],
    ["the filesystem root", () => "/"],
  ])("%s refuses every imagePath, inside it or not", async (_name, configured) => {
    for (const path of [join(dir, "logo.png"), join(outsideDir, "seed-phrase.png"), "/etc/hostname"]) {
      const refused = await refusal(readImageInDir(configured(), path))
      expect(refused.code).toBe("IMAGE_DIR_INVALID")
      expect(refused.message).toContain("CANDLE_IMAGE_DIR must be an absolute path to an existing directory")
    }
  })

  test("the tools still offer imagePath, and the refusal reaches the caller with no request made", async () => {
    const fetch = recordingFetch(ROUTES)
    const { token, seed } = launchTools({ CANDLE_IMAGE_DIR: join(root, "no-such-dir") }, fetch)
    for (const tool of [token, seed]) {
      const result = await tool.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0]?.text ?? "{}").error.code).toBe("IMAGE_DIR_INVALID")
    }
    expect(fetch.calls).toEqual([])
  })
})

describe("readImageInDir", () => {
  test("reads an allowed image of each type, with the content type its bytes declare", async () => {
    for (const [name, bytes, contentType] of [
      ["logo.png", PNG, "image/png"],
      ["photo.jpg", JPEG, "image/jpeg"],
      ["loop.gif", GIF, "image/gif"],
      [join("nested", "art.webp"), WEBP, "image/webp"],
    ] as const) {
      const image = await readImageInDir(dir, join(dir, name))
      expect(image.contentType).toBe(contentType)
      expect(image.bytes).toEqual(bytes)
    }
  })

  test("a link that stays inside the directory is followed, and so is a link TO the directory", async () => {
    expect((await readImageInDir(dir, join(dir, "alias.png"))).contentType).toBe("image/png")
    // The configured directory may itself be a link; containment is judged on real paths.
    expect((await readImageInDir(join(root, "pics-link"), join(dir, "logo.png"))).contentType).toBe("image/png")
    expect((await readImageInDir(dir, join(root, "pics-link", "logo.png"))).contentType).toBe("image/png")
  })

  test("a relative path is refused with a sentence asking for an absolute one", async () => {
    for (const path of ["logo.png", "./logo.png", "~/logo.png", "pics/logo.png"]) {
      const refused = await refusal(readImageInDir(dir, path))
      expect(refused.code).toBe("MCP_VALIDATION")
      expect(refused.message).toContain("imagePath must be an absolute path")
    }
  })

  test("every path outside the directory gets the same sentence, whatever is at it", async () => {
    const outside = [
      // present, and an image
      join(outsideDir, "seed-phrase.png"),
      // missing
      join(outsideDir, "no-such-file.png"),
      join(root, "no-such-dir", "x.png"),
      // a directory
      outsideDir,
      root,
      // a sibling whose name starts with the directory's name
      join(root, "pics-sibling", "logo.png"),
      join(root, "pics-sibling", "missing.png"),
      // reached by climbing out
      join(dir, "..", "private", "seed-phrase.png"),
      join(dir, "..", "private", "missing.png"),
      // links inside the directory whose targets are outside it
      join(dir, "escape.png"),
      join(dir, "escape-dir", "seed-phrase.png"),
      join(dir, "escape-dir", "missing.png"),
      join(dir, "dangling.png"),
      // the directory itself, and a system path
      dir,
      "/etc/hostname",
      "/etc/no-such-file",
    ]
    // Refused on the resolved path alone: nothing outside the directory is so much as opened.
    let opens = 0
    const fs: ImageFs = {
      ...realFs,
      open: (path, flags) => {
        opens += 1
        return open(path, flags)
      },
    }
    for (const path of outside) {
      const refused = await refusal(readImageInDir(dir, path, fs))
      expect({ path, code: refused.code, message: refused.message }).toEqual({
        path,
        code: "IMAGE_OUTSIDE_DIR",
        message: OUTSIDE_IMAGE_DIR,
      })
    }
    expect(opens).toBe(0)
    expect(OUTSIDE_IMAGE_DIR).toBe("Image files must be inside the configured CANDLE_IMAGE_DIR.")
  })

  test("inside the directory, a missing file and a directory each say what is wrong", async () => {
    for (const path of [join(dir, "typo.png"), join(dir, "no-such-dir", "typo.png"), join(dir, "logo.png", "x")]) {
      const missing = await refusal(readImageInDir(dir, path))
      expect(missing.code).toBe("IMAGE_UNREADABLE")
      expect(missing.message).toContain("there is no file at that path")
    }
    const folder = await refusal(readImageInDir(dir, join(dir, "nested")))
    expect(folder.code).toBe("IMAGE_UNREADABLE")
    expect(folder.message).toContain("it is not a regular file")
  })

  test("a text file named .png is refused by its bytes", async () => {
    const refused = await refusal(readImageInDir(dir, join(dir, "notes.png")))
    expect(refused.code).toBe("IMAGE_TYPE_UNSUPPORTED")
    expect(refused.message).toContain("not a PNG, JPEG, GIF or WebP image")
  })

  test("a file of exactly 10MB is read, and an 11MB one is refused", async () => {
    expect((await readImageInDir(dir, join(dir, "exact.png"))).bytes.length).toBe(MAX_IMAGE_BYTES)
    const refused = await refusal(readImageInDir(dir, join(dir, "huge.png")))
    expect(refused.code).toBe("IMAGE_TOO_LARGE")
  })

  test("a file that grows past 10MB while it is read is refused by the count of bytes read", async () => {
    // The handle says the file is 12 bytes, as it was when opened, and then never runs out.
    let asked = 0
    const fs: ImageFs = {
      ...realFs,
      open: async (path, flags) => {
        const handle = await open(path, flags)
        return {
          stat: (options) => handle.stat(options),
          close: () => handle.close(),
          read: async (buffer, offset, length) => {
            asked += length
            buffer.fill(7, offset, offset + length)
            if (asked === length) buffer.set(PNG, offset)
            return { bytesRead: length }
          },
        }
      },
    }
    const refused = await refusal(readImageInDir(dir, join(dir, "logo.png"), fs))
    expect(refused.code).toBe("IMAGE_TOO_LARGE")
    // Bounded: the ceiling plus one byte, and not one more.
    expect(asked).toBe(MAX_IMAGE_BYTES + 1)
  })

  test("a handle that is not a regular file is refused before any read", async () => {
    let reads = 0
    const fs: ImageFs = {
      ...realFs,
      open: async (path, flags) => {
        const handle = await open(path, flags)
        return {
          // The same file as far as device and inode go, so only its TYPE can refuse it.
          stat: async (options) => {
            const stats = await handle.stat(options)
            return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { isFile: () => false })
          },
          close: () => handle.close(),
          read: async () => {
            reads += 1
            return { bytesRead: 0 }
          },
        }
      },
    }
    const refused = await refusal(readImageInDir(dir, join(dir, "logo.png"), fs))
    expect(refused.code).toBe("IMAGE_UNREADABLE")
    expect(refused.message).toContain("it is not a regular file")
    expect(reads).toBe(0)
  })
})

describe("a path replaced between the resolution and the open", () => {
  /** A fresh directory per case, since each one rearranges it. */
  function arena() {
    const base = realpathSync(mkdtempSync(join(root, "swap-")))
    const pics = join(base, "pics")
    const secrets = join(base, "secrets")
    mkdirSync(join(pics, "album"), { recursive: true })
    mkdirSync(join(secrets, "album"), { recursive: true })
    writeFileSync(join(pics, "album", "logo.png"), PNG)
    writeFileSync(join(secrets, "album", "logo.png"), JPEG)
    return { pics, secrets, target: join(pics, "album", "logo.png") }
  }

  /** The real operations, with `before` run once just ahead of the open and `after` just behind it. */
  function swapping(before: () => void, after: () => void = () => {}): { fs: ImageFs; reads: () => number } {
    let reads = 0
    return {
      reads: () => reads,
      fs: {
        ...realFs,
        open: async (path, flags) => {
          before()
          const handle = await open(path, flags)
          after()
          return {
            stat: (options) => handle.stat(options),
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              reads += 1
              return handle.read(buffer, offset, length, position)
            },
          }
        },
      },
    }
  }

  test("the file itself becomes a link to a file outside: refused, and never opened through", async () => {
    const { pics, secrets, target } = arena()
    const { fs, reads } = swapping(() => {
      rmSync(target)
      symlinkSync(join(secrets, "album", "logo.png"), target)
    })
    const refused = await refusal(readImageInDir(pics, target, fs))
    expect(refused.message).toBe(OUTSIDE_IMAGE_DIR)
    expect(reads()).toBe(0)
  })

  test("a parent directory becomes a link to one outside: the open lands outside and is refused unread", async () => {
    const { pics, secrets, target } = arena()
    const { fs, reads } = swapping(() => {
      renameSync(join(pics, "album"), join(pics, "album-was"))
      symlinkSync(join(secrets, "album"), join(pics, "album"))
    })
    const refused = await refusal(readImageInDir(pics, target, fs))
    expect(refused.message).toBe(OUTSIDE_IMAGE_DIR)
    expect(reads()).toBe(0)
  })

  test("swapped out for the open and back again after it: the handle is not the file at the path", async () => {
    const { pics, secrets, target } = arena()
    const { fs, reads } = swapping(
      () => {
        renameSync(join(pics, "album"), join(pics, "album-was"))
        symlinkSync(join(secrets, "album"), join(pics, "album"))
      },
      () => {
        rmSync(join(pics, "album"))
        renameSync(join(pics, "album-was"), join(pics, "album"))
      },
    )
    const refused = await refusal(readImageInDir(pics, target, fs))
    expect(refused.message).toBe(OUTSIDE_IMAGE_DIR)
    expect(reads()).toBe(0)
  })

  test("the configured directory itself is repointed after the resolution: refused unread", async () => {
    const { pics, secrets, target } = arena()
    const granted = join(pics, "..", "granted")
    symlinkSync(pics, granted)
    const { fs, reads } = swapping(() => {
      rmSync(granted)
      symlinkSync(secrets, granted)
    })
    const refused = await refusal(readImageInDir(granted, target, fs))
    expect(refused.message).toBe(OUTSIDE_IMAGE_DIR)
    expect(reads()).toBe(0)
  })
})

describe("candle_launch_token with imagePath", () => {
  const env = () => ({ CANDLE_IMAGE_DIR: dir })

  test("each type is uploaded under its own content type, then launched with the URL that came back", async () => {
    for (const [name, bytes, contentType] of [
      ["logo.png", PNG, "image/png"],
      ["photo.jpg", JPEG, "image/jpeg"],
      ["loop.gif", GIF, "image/gif"],
      [join("nested", "art.webp"), WEBP, "image/webp"],
    ] as const) {
      const fetch = recordingFetch(ROUTES)
      const result = await launchTools(env(), fetch).token.handler({ ...TOKEN, imagePath: join(dir, name) })
      expect(result.isError).toBeUndefined()
      expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD, LAUNCH])

      const upload = fetch.calls[0]?.init
      expect(upload?.method).toBe("POST")
      expect(new Headers(upload?.headers).get("content-type")).toBe(contentType)
      expect(new Headers(upload?.headers).get("x-api-key")).toBe("cndl_test_key")
      expect(upload?.body as unknown as Uint8Array).toEqual(bytes)

      const launchBody = JSON.parse(String(fetch.calls[1]?.init?.body))
      expect(launchBody).toEqual({ ...TOKEN, imageUrl: HOSTED })
      expect(launchBody).not.toHaveProperty("imagePath")

      // The API's body, verbatim, then what this server did.
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(LAUNCHED)
      const note = JSON.parse(result.content[1]?.text ?? "{}")
      expect(note.imageUrl).toBe(HOSTED)
      expect(note.note).toContain("public and permanent")
    }
  })

  test("a dry run uploads too, and validates the URL that came back", async () => {
    const fetch = recordingFetch(ROUTES)
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imagePath: join(dir, "logo.png"),
      dryRun: true,
    })
    expect(result.isError).toBeUndefined()
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD, DRY_RUN])
    expect(JSON.parse(String(fetch.calls[1]?.init?.body))).toEqual({ ...TOKEN, imageUrl: HOSTED })
    expect(JSON.parse(result.content[1]?.text ?? "{}").imageUrl).toBe(HOSTED)
  })

  test("imageUrl alone still launches with no upload, and no second block", async () => {
    const fetch = recordingFetch(ROUTES)
    const result = await launchTools(env(), fetch).token.handler({ ...TOKEN, imageUrl: "https://x/y.png" })
    expect(fetch.calls.map((call) => call.url)).toEqual([LAUNCH])
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({ ...TOKEN, imageUrl: "https://x/y.png" })
    expect(result.content).toHaveLength(1)
  })

  test("both image inputs, or neither, are refused before any file read or request", async () => {
    const fetch = recordingFetch(ROUTES)
    const { token } = launchTools(env(), fetch)
    // The path does not exist: a file read would have answered differently.
    const both = await token.handler({ ...TOKEN, imageUrl: "https://x/y.png", imagePath: join(dir, "typo.png") })
    expect(both.isError).toBe(true)
    expect(JSON.parse(both.content[0]?.text ?? "{}").error).toMatchObject({
      code: "MCP_VALIDATION",
      message: "Pass exactly one of imageUrl or imagePath, not both. Nothing was uploaded.",
    })
    const neither = await token.handler({ ...TOKEN })
    expect(neither.isError).toBe(true)
    expect(JSON.parse(neither.content[0]?.text ?? "{}").error.code).toBe("MCP_VALIDATION")
    expect(fetch.calls).toEqual([])
  })

  test("a local refusal makes no request: wrong bytes, too large, relative, outside", async () => {
    const fetch = recordingFetch(ROUTES)
    const { token } = launchTools(env(), fetch)
    for (const [imagePath, code] of [
      [join(dir, "notes.png"), "IMAGE_TYPE_UNSUPPORTED"],
      [join(dir, "huge.png"), "IMAGE_TOO_LARGE"],
      ["logo.png", "MCP_VALIDATION"],
      [join(outsideDir, "seed-phrase.png"), "IMAGE_OUTSIDE_DIR"],
      [join(outsideDir, "no-such-file.png"), "IMAGE_OUTSIDE_DIR"],
      [join(dir, "escape.png"), "IMAGE_OUTSIDE_DIR"],
      [join(root, "pics-sibling", "logo.png"), "IMAGE_OUTSIDE_DIR"],
    ] as const) {
      const result = await token.handler({ ...TOKEN, imagePath })
      expect(result.isError).toBe(true)
      const body = JSON.parse(result.content[0]?.text ?? "{}")
      expect({ imagePath, code: body.error.code }).toEqual({ imagePath, code })
      expect(body.success).toBe(false)
      if (code === "IMAGE_OUTSIDE_DIR") expect(body.error.message).toBe(OUTSIDE_IMAGE_DIR)
    }
    expect(fetch.calls).toEqual([])
  })

  test.each([
    [
      "RATE_LIMITED",
      429,
      { success: false, error: { code: "RATE_LIMITED", message: "Too many image uploads", retryable: true } },
    ],
    ["UPLOAD_INVALID", 400, { success: false, error: { code: "UPLOAD_INVALID", message: "bad", field: "image" } }],
  ])("the upload's %s comes back unchanged, and no launch is attempted", async (_code, status, body) => {
    const fetch = recordingFetch({ ...ROUTES, [UPLOAD]: { status, body } })
    const result = await launchTools(env(), fetch).token.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toBe(JSON.stringify(body))
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD])
  })

  test("an upload that fails in transit, or answers without an https URL, launches nothing", async () => {
    const thrown = {
      calls: [] as Call[],
      fetch: async (url: string, init?: RequestInit) => {
        thrown.calls.push({ url, init })
        throw new Error("socket hang up")
      },
    }
    const dropped = await launchTools(env(), thrown).token.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
    expect(dropped.isError).toBe(true)
    const error = JSON.parse(dropped.content[0]?.text ?? "{}").error
    expect(error.code).toBe("MCP_TRANSPORT")
    expect(error.message).toContain("No launch was attempted")
    expect(error.message).toContain("may or may not have reached Candle")
    expect(thrown.calls.map((call) => call.url)).toEqual([UPLOAD])

    const fetch = recordingFetch({ ...ROUTES, [UPLOAD]: { body: { success: true, imageUrl: "http://plain/x.png" } } })
    const odd = await launchTools(env(), fetch).token.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
    expect(odd.isError).toBe(true)
    expect(JSON.parse(odd.content[0]?.text ?? "{}").error.code).toBe("MCP_TRANSPORT")
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD])
  })

  test("a launch refused after the upload still reports the URL the file was published at", async () => {
    const refused = { success: false, error: { code: "IMAGE_WRONG_SHAPE", message: "too wide" } }
    const fetch = recordingFetch({ ...ROUTES, [LAUNCH]: { status: 400, body: refused } })
    const result = await launchTools(env(), fetch).token.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(JSON.stringify(refused))
    expect(JSON.parse(result.content[1]?.text ?? "{}").imageUrl).toBe(HOSTED)
  })

  test("without a key, nothing is read or sent", async () => {
    const fetch = recordingFetch(ROUTES)
    const tools = new Map<string, Registered>()
    registerToolSubset(
      {
        registerTool: (name: string, config: Registered["config"], handler: Handler) =>
          tools.set(name, { config, handler }),
      } as unknown as Parameters<typeof registerToolSubset>[0],
      {
        tools: ["candle_launch_token"],
        getConfig: () => ({ apiUrl: CFG.apiUrl }),
        fetch: fetch.fetch,
        env: env(),
      },
    )
    const result = await (tools.get("candle_launch_token") as Registered).handler({
      ...TOKEN,
      imagePath: join(dir, "typo.png"),
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]?.text ?? "{}").error.message).toContain("CANDLE_AGENT_API_KEY is required")
    expect(fetch.calls).toEqual([])
  })
})

describe("candle_launch_and_seed with imagePath", () => {
  const env = () => ({ CANDLE_IMAGE_DIR: dir })

  test("uploads once, launches with the URL and the converted seed, and reports the URL used", async () => {
    const fetch = recordingFetch(ROUTES)
    const result = await launchTools(env(), fetch).seed.handler({
      ...TOKEN,
      imagePath: join(dir, "photo.jpg"),
      devBuy: "0.25",
    })
    expect(result.isError).toBeUndefined()
    expect(fetch.calls.map((call) => call.url)).toEqual([
      UPLOAD,
      ATOMIC_BUILD,
      ATOMIC_SUBMIT,
      "https://api.test/api/v1/markets/solana/NewMint111",
    ])
    expect(new Headers(fetch.calls[0]?.init?.headers).get("content-type")).toBe("image/jpeg")
    const launchBody = JSON.parse(String(fetch.calls[1]?.init?.body))
    expect(launchBody).toEqual({ ...TOKEN, imageUrl: HOSTED, payer: SEED.payer, firstBuys: [SEED] })
    expect(launchBody).not.toHaveProperty("imagePath")
    const parsed = JSON.parse(result.content[0]?.text ?? "{}")
    expect(parsed).toMatchObject({ clientLaunchId: "L-1", imageUrl: HOSTED, launch: BUNDLE_LANDED })
    expect(parsed.imageNote).toContain("public and permanent")
  })

  test("a dry run uploads too, and the result says the file is public", async () => {
    const fetch = recordingFetch(ROUTES)
    const result = await launchTools(env(), fetch).seed.handler({
      ...TOKEN,
      imagePath: join(dir, "logo.png"),
      dryRun: true,
    })
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD, DRY_RUN])
    expect(JSON.parse(String(fetch.calls[1]?.init?.body))).toEqual({ ...TOKEN, imageUrl: HOSTED })
    const parsed = JSON.parse(result.content[0]?.text ?? "{}")
    expect(parsed).toMatchObject({ clientLaunchId: "L-1", dryRun: true, imageUrl: HOSTED })
    expect(parsed.imageNote).toContain("public and permanent")
  })

  test("a bad devBuy is refused before the upload: a refusal must not cost a publication", async () => {
    const fetch = recordingFetch(ROUTES)
    const result = await launchTools(env(), fetch).seed.handler({
      ...TOKEN,
      imagePath: join(dir, "logo.png"),
      devBuy: "not-a-number",
    })
    expect(result.isError).toBe(true)
    expect(fetch.calls).toEqual([])
  })

  test("both or neither, and every outside path, are refused under the caller's id with no request", async () => {
    const fetch = recordingFetch(ROUTES)
    const { seed } = launchTools(env(), fetch)
    for (const [args, code] of [
      [{ imageUrl: "https://x/y.png", imagePath: join(dir, "logo.png") }, "MCP_VALIDATION"],
      [{}, "MCP_VALIDATION"],
      [{ imagePath: "logo.png" }, "MCP_VALIDATION"],
      [{ imagePath: join(outsideDir, "seed-phrase.png") }, "IMAGE_OUTSIDE_DIR"],
      [{ imagePath: join(outsideDir, "missing.png") }, "IMAGE_OUTSIDE_DIR"],
      [{ imagePath: join(dir, "escape.png") }, "IMAGE_OUTSIDE_DIR"],
      [{ imagePath: join(dir, "notes.png") }, "IMAGE_TYPE_UNSUPPORTED"],
    ] as const) {
      const result = await seed.handler({ ...TOKEN, ...args })
      expect(result.isError).toBe(true)
      const body = JSON.parse(result.content[0]?.text ?? "{}")
      expect({ args, code: body.error.code, id: body.clientLaunchId }).toEqual({ args, code, id: "L-1" })
    }
    expect(fetch.calls).toEqual([])
  })

  test("the upload's refusal is relayed under api, as this tool relays every API body", async () => {
    const body = { success: false, error: { code: "RATE_LIMITED", message: "Too many image uploads", retryable: true } }
    const fetch = recordingFetch({ ...ROUTES, [UPLOAD]: { status: 429, body } })
    const result = await launchTools(env(), fetch).seed.handler({ ...TOKEN, imagePath: join(dir, "logo.png") })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ clientLaunchId: "L-1", api: body })
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD])
  })

  test("a launch that fails in transit after the upload keeps the id and the published URL", async () => {
    const calls: string[] = []
    const fetch = async (url: string) => {
      calls.push(url)
      if (url === UPLOAD) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, imageUrl: HOSTED }) }
      }
      throw new Error("socket hang up")
    }
    const result = await executeLaunchAndSeed({ ...TOKEN, imagePath: join(dir, "logo.png") }, CFG, fetch, dir)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed).toMatchObject({ clientLaunchId: "L-1", imageUrl: HOSTED, error: { code: "MCP_TRANSPORT" } })
    expect(calls).toEqual([UPLOAD, LAUNCH])
  })
})

describe("bannerPath on the launch tools", () => {
  const env = () => ({ CANDLE_IMAGE_DIR: dir })
  const BANNER_UPLOAD = `${UPLOAD}?kind=banner`
  const BANNER_HOSTED = "https://ipfs.example/ipfs/QmBanner"
  const routes = {
    ...ROUTES,
    [BANNER_UPLOAD]: { body: { success: true, imageUrl: BANNER_HOSTED } },
  }

  test("both tools offer bannerPath beside bannerUrl, and the text separates it from the cropped token image", () => {
    const { token, seed } = launchTools(env(), recordingFetch(routes))
    for (const tool of [token, seed]) {
      expect(Object.keys(tool.config.inputSchema)).toEqual(expect.arrayContaining(["bannerPath", "bannerUrl"]))
      expect(tool.config.description).toContain("bannerPath")
    }
    const fieldText = String((token.config.inputSchema.bannerPath as { description?: string }).description)
    expect(fieldText).toContain("BANNER_WRONG_SHAPE")
    expect(fieldText).toContain("not a cropped copy")
    expect(String((token.config.inputSchema.imagePath as { description?: string }).description)).toContain(
      "Candle crops it to a square",
    )
  })

  test("without a directory there is no bannerPath, and one that reaches the handler is refused unread", async () => {
    const fetch = recordingFetch(routes)
    const { token } = launchTools(undefined, fetch)
    expect(Object.keys(token.config.inputSchema)).not.toContain("bannerPath")
    const result = await token.handler({ ...TOKEN, imageUrl: "https://x/y.png", bannerPath: join(dir, "logo.png") })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("bannerPath is not available")
    expect(fetch.calls).toEqual([])
  })

  test("a banner file is uploaded with kind=banner and the launch carries the bannerUrl that came back", async () => {
    const fetch = recordingFetch(routes)
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerPath: join(dir, "logo.png"),
    })
    expect(result.isError).toBeUndefined()
    expect(fetch.calls.map((call) => call.url)).toEqual([BANNER_UPLOAD, LAUNCH])
    expect(fetch.calls[0]?.init?.body as unknown as Uint8Array).toEqual(PNG)
    const launchBody = JSON.parse(String(fetch.calls[1]?.init?.body))
    expect(launchBody).toEqual({ ...TOKEN, imageUrl: "https://x/y.png", bannerUrl: BANNER_HOSTED })
    expect(launchBody).not.toHaveProperty("bannerPath")
    const note = JSON.parse(result.content[1]?.text ?? "{}")
    expect(note.bannerUrl).toBe(BANNER_HOSTED)
    expect(note.bannerNote).toContain("public and permanent")
  })

  test("imagePath and bannerPath together upload the image as a token image and the banner as a banner", async () => {
    const fetch = recordingFetch(routes)
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imagePath: join(dir, "photo.jpg"),
      bannerPath: join(dir, "logo.png"),
    })
    expect(result.isError).toBeUndefined()
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD, BANNER_UPLOAD, LAUNCH])
    expect(JSON.parse(String(fetch.calls[2]?.init?.body))).toEqual({
      ...TOKEN,
      imageUrl: HOSTED,
      bannerUrl: BANNER_HOSTED,
    })
  })

  test("bannerPath and bannerUrl together are refused before any read or request", async () => {
    const fetch = recordingFetch(routes)
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerUrl: "https://x/b.png",
      bannerPath: join(dir, "logo.png"),
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("at most one of bannerUrl or bannerPath")
    expect(fetch.calls).toEqual([])
  })

  test("a bad banner file is refused before the image is uploaded: no publication is spent", async () => {
    for (const bannerPath of [join(dir, "notes.png"), join(outsideDir, "seed-phrase.png"), "relative.png"]) {
      const fetch = recordingFetch(routes)
      const result = await launchTools(env(), fetch).token.handler({
        ...TOKEN,
        imagePath: join(dir, "logo.png"),
        bannerPath,
      })
      expect(result.isError).toBe(true)
      expect(fetch.calls).toEqual([])
    }
    const result = await launchTools(env(), recordingFetch(routes)).token.handler({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerPath: join(dir, "notes.png"),
    })
    expect(result.content[0]?.text).toContain("bannerPath")
  })

  test("a square banner is refused by the upload route; its body is relayed and nothing launches", async () => {
    const body = { success: false, error: { code: "BANNER_WRONG_SHAPE", message: "Banner is 800x800" } }
    const fetch = recordingFetch({ ...routes, [BANNER_UPLOAD]: { status: 400, body } })
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerPath: join(dir, "logo.png"),
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(body)
    expect(fetch.calls.map((call) => call.url)).toEqual([BANNER_UPLOAD])
  })

  test("a banner upload that fails after the image uploaded names the image URL for the retry", async () => {
    const fetch = recordingFetch({ ...routes, [BANNER_UPLOAD]: { status: 400, body: { error: { code: "X" } } } })
    const result = await launchTools(env(), fetch).token.handler({
      ...TOKEN,
      imagePath: join(dir, "logo.png"),
      bannerPath: join(dir, "logo.png"),
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(HOSTED)
    expect(fetch.calls.map((call) => call.url)).toEqual([UPLOAD, BANNER_UPLOAD])
  })

  test("candle_launch_and_seed uploads the banner and reports it under bannerUrl", async () => {
    const fetch = recordingFetch(routes)
    const result = await launchTools(env(), fetch).seed.handler({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerPath: join(dir, "logo.png"),
      devBuy: "0.25",
    })
    expect(result.isError).toBeUndefined()
    expect(fetch.calls.map((call) => call.url).slice(0, 3)).toEqual([BANNER_UPLOAD, ATOMIC_BUILD, ATOMIC_SUBMIT])
    const launchBody = JSON.parse(String(fetch.calls[1]?.init?.body))
    expect(launchBody).toEqual({
      ...TOKEN,
      imageUrl: "https://x/y.png",
      bannerUrl: BANNER_HOSTED,
      payer: SEED.payer,
      firstBuys: [SEED],
    })
    const parsed = JSON.parse(result.content[0]?.text ?? "{}")
    expect(parsed.bannerUrl).toBe(BANNER_HOSTED)
    expect(parsed.bannerNote).toContain("public and permanent")
  })
})
