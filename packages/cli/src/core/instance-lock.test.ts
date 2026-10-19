/**
 * BE-1665 (spec C-2, T-14's lock half): one core per profile. `commands/core.test.ts` drives the
 * same refusal through `candle core serve`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireInstanceLock, CoreAlreadyRunningError, pidIsAlive } from "./instance-lock"

const dirs: string[] = []
async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "candle-core-lock-"))
  dirs.push(dir)
  return { lockPath: join(dir, "core.lock"), socketPath: join(dir, "core.sock") }
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("acquireInstanceLock", () => {
  test("a second acquire for a live holder refuses with CORE_ALREADY_RUNNING and the socket path", async () => {
    const p = await paths()
    const held = await acquireInstanceLock({ ...p, pid: process.pid })
    const second = acquireInstanceLock({ ...p, pid: process.pid + 1 })
    await expect(second).rejects.toBeInstanceOf(CoreAlreadyRunningError)
    await second.catch((error: CoreAlreadyRunningError) => {
      expect(error.code).toBe("CORE_ALREADY_RUNNING")
      expect(error.socketPath).toBe(p.socketPath)
      expect(error.pid).toBe(process.pid)
    })
    await held.release()
    const third = await acquireInstanceLock({ ...p, pid: process.pid })
    await third.release()
  })

  test("a lock whose pid is dead is taken over", async () => {
    const p = await paths()
    await writeFile(p.lockPath, `${JSON.stringify({ pid: 999_999_999 })}\n`)
    const lock = await acquireInstanceLock({ ...p, pid: process.pid, isAlive: (pid) => pid === process.pid })
    expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(process.pid)
    await lock.release()
  })

  test("an unreadable lock counts as held: it may be one being written this instant", async () => {
    const p = await paths()
    await writeFile(p.lockPath, "")
    await expect(acquireInstanceLock({ ...p, isAlive: () => false })).rejects.toBeInstanceOf(CoreAlreadyRunningError)
  })

  test("release removes only our own lock", async () => {
    const p = await paths()
    const lock = await acquireInstanceLock({ ...p, pid: process.pid })
    await writeFile(p.lockPath, `${JSON.stringify({ pid: 12345 })}\n`)
    await lock.release()
    expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(12345)
  })

  test("pidIsAlive", () => {
    expect(pidIsAlive(process.pid)).toBe(true)
    expect(pidIsAlive(0)).toBe(false)
    expect(pidIsAlive(-1)).toBe(false)
  })
})
