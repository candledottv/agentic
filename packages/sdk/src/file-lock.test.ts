/**
 * BE-2712 (D2): the SDK's `withFileLock` creates the lock's directory before it opens the lock, at
 * 0700, and leaves an existing directory alone.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withFileLock } from "./file-lock"

const made: string[] = []
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "candle-sdk-file-lock-"))
  made.push(dir)
  return dir
}

describe("withFileLock creates the lock's directory", () => {
  test("a missing directory is created at 0700 and fn runs; no lock is left behind", async () => {
    const dir = join(await tempDir(), "state")
    const target = join(dir, "signer.enc")
    expect(await withFileLock(target, async () => "done")).toBe("done")
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    await expect(stat(`${target}.lock`)).rejects.toThrow()
  })

  test("an existing directory keeps its mode", async () => {
    const dir = join(await tempDir(), "state")
    await mkdir(dir)
    await chmod(dir, 0o755)
    await withFileLock(join(dir, "signer.enc"), async () => {})
    expect((await stat(dir)).mode & 0o777).toBe(0o755)
  })
})
