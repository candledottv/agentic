import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  ApiKeyFileError,
  type ApiKeyFileIo,
  apiKeyFileIo,
  apiKeyFileSnapshot,
  assertApiKeySources,
  readApiKeyFile,
} from "./api-key-file"

const KEY = "fixture-opaque-credential"
function fixture(body: string, use: (path: string, dir: string) => void, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "candle-key-"))
  const path = join(dir, "key")
  try {
    writeFileSync(path, body, { mode })
    use(path, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function codeOf(read: () => unknown): string | undefined {
  try {
    read()
    return undefined
  } catch (error) {
    expect(error instanceof ApiKeyFileError).toBe(true)
    return (error as ApiKeyFileError).code
  }
}

describe("bounded POSIX API-key file", () => {
  for (const mode of [0o400, 0o600])
    for (const ending of ["", "\n", "\r\n"]) {
      test(`mode ${mode.toString(8)}, terminator ${JSON.stringify(ending)}, absolute and relative`, () => {
        fixture(
          KEY + ending,
          (path) => {
            expect(readApiKeyFile(path) === KEY).toBe(true)
            expect(readApiKeyFile(relative(process.cwd(), path)) === KEY).toBe(true)
          },
          mode,
        )
      })
    }
  for (const body of [
    "",
    " ",
    "x y",
    "\tx",
    "x\t",
    "x\n\n",
    "x\r",
    "x\ny",
    "x\0",
    "\ufeffx",
    "é",
    "x\x7f",
    "x".repeat(4097),
  ]) {
    test(`refuses invalid bytes (${Buffer.byteLength(body)} bytes)`, () => {
      fixture(body, (path) => expect(codeOf(() => readApiKeyFile(path))).toBe("API_KEY_FILE_INVALID"))
    })
  }
  test("accepts exactly 4096 bytes", () =>
    fixture("x".repeat(4096), (path) => expect(readApiKeyFile(path).length).toBe(4096)))
  for (const mode of [0o640, 0o644, 0o700, 0o4600, 0o2600, 0o1600]) {
    test(`refuses mode ${mode.toString(8)}`, () =>
      fixture(KEY, (path) => {
        execFileSync("chmod", [mode.toString(8), path])
        expect(codeOf(() => readApiKeyFile(path))).toBe("API_KEY_FILE_INVALID")
      }))
  }
  test("missing, injected access/I/O error, malicious path and injected exception are sanitized", () => {
    for (const read of [
      () => readApiKeyFile(`/missing/${KEY}`),
      () =>
        readApiKeyFile(KEY, {
          ...apiKeyFileIo,
          open() {
            throw new Error(KEY)
          },
        }),
    ]) {
      try {
        read()
        throw new Error("expected refusal")
      } catch (error) {
        expect(error instanceof ApiKeyFileError).toBe(true)
        expect(String(error).includes(KEY)).toBe(false)
        expect((error as ApiKeyFileError).code).toBe("API_KEY_FILE_UNREADABLE")
      }
    }
  })
  test("refuses directory, final symlink, and a FIFO without blocking", () =>
    fixture(KEY, (path, dir) => {
      const link = join(dir, "link")
      symlinkSync(path, link)
      expect(codeOf(() => readApiKeyFile(dir))).toBe("API_KEY_FILE_INVALID")
      expect(codeOf(() => readApiKeyFile(link))).toBe("API_KEY_FILE_INVALID")
      const fifo = join(dir, "fifo")
      execFileSync("mkfifo", [fifo])
      const start = Date.now()
      expect(codeOf(() => readApiKeyFile(fifo))).toBe("API_KEY_FILE_INVALID")
      expect(Date.now() - start < 1000).toBe(true)
    }))
  test("unsupported platform and missing primitives fail closed", () => {
    for (const io of [
      { ...apiKeyFileIo, platform: "win32" },
      { ...apiKeyFileIo, effectiveUid: () => undefined },
      { ...apiKeyFileIo, constants: { ...apiKeyFileIo.constants, O_NOFOLLOW: 0 } },
    ])
      expect(codeOf(() => readApiKeyFile(KEY, io))).toBe("API_KEY_FILE_UNSUPPORTED")
  })
  test("wrong effective owner is invalid, including root", () =>
    fixture(KEY, (path) => {
      const io = {
        ...apiKeyFileIo,
        stat: (fd: number) => ({
          ...apiKeyFileIo.stat(fd),
          uid: BigInt((process.geteuid?.() ?? 0) + 1),
          isFile: () => true,
        }),
      }
      expect(codeOf(() => readApiKeyFile(path, io))).toBe("API_KEY_FILE_INVALID")
    }))
  test("oversized stat skips all reads, and unavailable descriptor metadata fails unsupported", () => {
    fixture("x".repeat(4097), (path) => {
      let reads = 0,
        closes = 0
      expect(
        codeOf(() =>
          readApiKeyFile(path, {
            ...apiKeyFileIo,
            read() {
              reads++
              throw new Error("must not read")
            },
            close(fd) {
              closes++
              apiKeyFileIo.close(fd)
            },
          }),
        ),
      ).toBe("API_KEY_FILE_INVALID")
      expect([reads, closes]).toEqual([0, 1])
    })
    fixture(KEY, (path) => {
      expect(
        codeOf(() =>
          readApiKeyFile(path, {
            ...apiKeyFileIo,
            stat(fd) {
              const meta = apiKeyFileIo.stat(fd)
              return { ...meta, mtimeNs: undefined as unknown as bigint, isFile: () => true }
            },
          }),
        ),
      ).toBe("API_KEY_FILE_UNSUPPORTED")
    })
  })
  test("validates/read/closes one descriptor; pathname replacement keeps the opened inode", () =>
    fixture(KEY, (path, dir) => {
      let opens = 0,
        closes = 0,
        cap = 0
      const io: ApiKeyFileIo = {
        ...apiKeyFileIo,
        open(path, flags) {
          opens++
          const fd = apiKeyFileIo.open(path, flags)
          renameSync(path, join(dir, "original"))
          writeFileSync(path, "replacement", { mode: 0o600 })
          return fd
        },
        read(fd, bytes, offset, length) {
          cap = Math.max(cap, offset + length)
          return apiKeyFileIo.read(fd, bytes, offset, length)
        },
        close(fd) {
          closes++
          apiKeyFileIo.close(fd)
        },
      }
      expect(readApiKeyFile(path, io) === KEY).toBe(true)
      expect([opens, closes, cap]).toEqual([1, 1, 4097])
    }))
  test("closes on pre-read, content, metadata, and read errors", () => {
    for (const failure of ["owner", "content", "metadata", "read", "growth"] as const)
      fixture(failure === "content" ? "\0" : KEY, (path) => {
        let stats = 0,
          closes = 0
        const io: ApiKeyFileIo = {
          ...apiKeyFileIo,
          stat(fd) {
            stats++
            const meta = apiKeyFileIo.stat(fd)
            return failure === "owner"
              ? { ...meta, uid: meta.uid + 1n, isFile: () => true }
              : failure === "metadata" && stats === 2
                ? { ...meta, mtimeNs: meta.mtimeNs + 1n, isFile: () => true }
                : meta
          },
          read(fd, bytes, offset, length) {
            if (failure === "read") throw new Error(KEY)
            if (failure === "growth") {
              bytes.fill(0x78)
              return length
            }
            return apiKeyFileIo.read(fd, bytes, offset, length)
          },
          close(fd) {
            closes++
            apiKeyFileIo.close(fd)
          },
        }
        expect(codeOf(() => readApiKeyFile(path, io))).toBe(
          failure === "read" ? "API_KEY_FILE_UNREADABLE" : "API_KEY_FILE_INVALID",
        )
        expect(closes).toBe(1)
      })
  })
  test("Linux magic fd links are refused", () => {
    if (process.platform !== "linux") return
    fixture(KEY, (path) => {
      const fd = apiKeyFileIo.open(path, 0)
      try {
        expect(codeOf(() => readApiKeyFile(`/proc/self/fd/${fd}`))).toBe("API_KEY_FILE_INVALID")
      } finally {
        apiKeyFileIo.close(fd)
      }
    })
  })
})

describe("selection and private snapshots", () => {
  test("blank raw aliases do not conflict with a selected file", async () => {
    const load = apiKeyFileSnapshot(
      { CANDLE_API_KEY_FILE: "/fixture", CANDLE_API_KEY: " \t ", CANDLE_AGENT_API_KEY: "" },
      () => KEY,
    )
    expect((await load()) === KEY).toBe(true)
  })
  test("file conflicts with either or both raw aliases, even equal bytes; no loader calls", async () => {
    for (const raw of [
      { CANDLE_API_KEY: KEY },
      { CANDLE_AGENT_API_KEY: KEY },
      { CANDLE_API_KEY: KEY, CANDLE_AGENT_API_KEY: KEY },
    ]) {
      let reads = 0
      const env = { CANDLE_API_KEY_FILE: KEY, ...raw }
      expect(codeOf(() => assertApiKeySources(env))).toBe("API_KEY_SOURCE_CONFLICT")
      const load = apiKeyFileSnapshot(env, () => {
        reads++
        return KEY
      })
      await expect(load()).rejects.toMatchObject({ code: "API_KEY_SOURCE_CONFLICT" })
      expect(reads).toBe(0)
    }
  })
  test("success/failure memoized, original path/cwd retained, next snapshot resolves anew", async () => {
    let reads = 0
    const env = { CANDLE_API_KEY_FILE: " path with spaces " }
    const load = apiKeyFileSnapshot(
      env,
      (path) => {
        reads++
        expect(path.endsWith("/ path with spaces ")).toBe(true)
        return KEY
      },
      "/initial",
    )
    env.CANDLE_API_KEY_FILE = "/changed"
    expect((await load()) === KEY && (await load()) === KEY).toBe(true)
    expect(reads).toBe(1)
    const fail = apiKeyFileSnapshot(env, () => {
      reads++
      throw new Error(KEY)
    })
    for (let i = 0; i < 2; i++) await expect(fail()).rejects.toMatchObject({ code: "API_KEY_FILE_UNREADABLE" })
    expect(reads).toBe(2)
    await apiKeyFileSnapshot(env, () => {
      reads++
      return KEY
    })()
    expect(reads).toBe(3)
    expect(await apiKeyFileSnapshot({ CANDLE_API_KEY_FILE: " \t " })()).toBeUndefined()
  })
})
