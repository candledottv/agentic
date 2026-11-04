/**
 * BE-2712 (D1, D3, D5): `withFileLock` creates the lock's directory before it opens the lock, at
 * 0700, and leaves an existing directory alone. A directory it cannot create or write is
 * `ConfigDirUnwritableError`, and `fn` never runs.
 */
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CONFIG_DIR_UNWRITABLE, ConfigDirUnwritableError, withFileLock } from "./file-lock"
import { run } from "./index"
import { EncryptedFileSecretStore, type SecretStore } from "./secret-store"
import { tempDirs } from "./temp-dirs.test-support"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "./test-support"

const tempDir = tempDirs()
// Root ignores the mode bits these tests take away.
const asRoot = process.getuid?.() === 0

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

describe("withFileLock creates the lock's directory", () => {
  test("a missing directory is created at 0700 and fn runs; no lock is left behind", async () => {
    const dir = join(tempDir("candle-file-lock-"), "candle")
    const target = join(dir, "credentials.enc")
    let ran = false
    expect(
      await withFileLock(target, async () => {
        ran = true
        return "done"
      }),
    ).toBe("done")
    expect(ran).toBe(true)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    await expect(stat(`${target}.lock`)).rejects.toThrow()
  })

  test("an existing directory keeps its mode", async () => {
    const dir = join(tempDir("candle-file-lock-"), "candle")
    await mkdir(dir)
    await chmod(dir, 0o755)
    await withFileLock(join(dir, "credentials.enc"), async () => {})
    expect((await stat(dir)).mode & 0o777).toBe(0o755)
  })

  test.skipIf(asRoot)("an unwritable parent is CONFIG_DIR_UNWRITABLE with EACCES, and fn never runs", async () => {
    const parent = join(tempDir("candle-file-lock-"), "locked")
    await mkdir(parent)
    await chmod(parent, 0o500)
    const dir = join(parent, "candle")
    let ran = false
    const error = await rejection(
      withFileLock(join(dir, "credentials.enc"), async () => {
        ran = true
      }),
    )
    expect(error).toBeInstanceOf(ConfigDirUnwritableError)
    const named = error as ConfigDirUnwritableError
    expect(named.code).toBe(CONFIG_DIR_UNWRITABLE)
    expect(named.code).toBe("CONFIG_DIR_UNWRITABLE")
    expect(named.errno).toBe("EACCES")
    expect(named.path).toBe(dir)
    expect(named.message).toBe(`Cannot write the Candle config directory ${dir} (EACCES).`)
    expect(named.suggestion).toBe(
      `Fix: as the user that runs candle, run mkdir -m 700 ${dir}, or set CANDLE_CONFIG_DIR to a directory that user can write.`,
    )
    expect((named.cause as NodeJS.ErrnoException).code).toBe("EACCES")
    expect(ran).toBe(false)
  })

  test.skipIf(asRoot)(
    "an existing directory the user cannot write is CONFIG_DIR_UNWRITABLE from the lock's open",
    async () => {
      const dir = join(tempDir("candle-file-lock-"), "candle")
      await mkdir(dir)
      await chmod(dir, 0o500)
      const error = await rejection(withFileLock(join(dir, "credentials.enc"), async () => {}))
      expect(error).toBeInstanceOf(ConfigDirUnwritableError)
      expect((error as ConfigDirUnwritableError).errno).toBe("EACCES")
      expect((error as ConfigDirUnwritableError).path).toBe(dir)
    },
  )

  test("a regular file where the directory should be is CONFIG_DIR_UNWRITABLE, worded as not a directory", async () => {
    const dir = join(tempDir("candle-file-lock-"), "candle")
    await writeFile(dir, "not a directory")
    let ran = false
    const error = await rejection(
      withFileLock(join(dir, "credentials.enc"), async () => {
        ran = true
      }),
    )
    expect(error).toBeInstanceOf(ConfigDirUnwritableError)
    const named = error as ConfigDirUnwritableError
    expect(["EEXIST", "ENOTDIR"]).toContain(named.errno)
    expect(named.path).toBe(dir)
    expect(named.message).toBe(`${dir} or one of its parents is not a directory (${named.errno}).`)
    expect(ran).toBe(false)
  })
})

/**
 * D3 through `run()`. `profile rename` is the cheapest offline command whose store write is not
 * caught on the way out: it reads the old profile's secret and `set`s it under the new name. The
 * read comes from a fake (nothing can exist in a directory that cannot be created); the write is
 * the real `EncryptedFileSecretStore.set`, under a 0500 parent.
 */
describe.skipIf(asRoot)("CONFIG_DIR_UNWRITABLE through run()", () => {
  const unusedFetch = (() => {
    throw new Error("profile rename never touches the network")
  }) as unknown as typeof fetch

  async function renameUnder(json: boolean) {
    const parent = join(tempDir("candle-unwritable-run-"), "locked")
    await mkdir(parent)
    await chmod(parent, 0o500)
    const dir = join(parent, "candle")
    const previous = process.env.CANDLE_KEYRING_PASSPHRASE
    process.env.CANDLE_KEYRING_PASSPHRASE = "correct horse battery staple"
    const real = new EncryptedFileSecretStore({ path: join(dir, "credentials.enc") })
    const seeded = createFakeStore({ "profile:staging:device_token": "d" })
    const store: SecretStore = {
      get: (ref) => seeded.get(ref),
      set: (ref, value) => real.set(ref, value),
      delete: (ref) => real.delete(ref),
    }
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      store,
      stdout,
      stderr,
      ...createFakeConfigStore({ profiles: { staging: { apiUrl: "https://staging.api.candle.tv" } } }),
    })
    try {
      const argv = ["profile", "rename", "staging", "hood-staging", ...(json ? ["--json"] : [])]
      return { code: await run(argv, deps), stdout: stdout.text, stderr: stderr.text, dir }
    } finally {
      if (previous === undefined) delete process.env.CANDLE_KEYRING_PASSPHRASE
      else process.env.CANDLE_KEYRING_PASSPHRASE = previous
    }
  }

  test("human output: the message and the Fix: line on stderr, exit 1, no Unexpected error", async () => {
    const out = await renameUnder(false)
    expect(out.code).toBe(1)
    expect(out.stderr).toBe(
      `Cannot write the Candle config directory ${out.dir} (EACCES). Fix: as the user that runs candle, run mkdir -m 700 ${out.dir}, or set CANDLE_CONFIG_DIR to a directory that user can write.\n`,
    )
    expect(out.stdout + out.stderr).not.toContain("Unexpected error")
  })

  test("--json: the CONFIG_DIR_UNWRITABLE envelope on stdout, with details.path and details.errno", async () => {
    const out = await renameUnder(true)
    expect(out.code).toBe(1)
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      code: "CONFIG_DIR_UNWRITABLE",
      message: `Cannot write the Candle config directory ${out.dir} (EACCES).`,
      suggestion: `Fix: as the user that runs candle, run mkdir -m 700 ${out.dir}, or set CANDLE_CONFIG_DIR to a directory that user can write.`,
      details: { path: out.dir, errno: "EACCES" },
    })
    expect(out.stderr).toBe("")
  })
})
