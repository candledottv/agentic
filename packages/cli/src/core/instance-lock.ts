/**
 * One core per profile (BE-1665, spec C-2). A second `candle core serve` for the same profile
 * exits with `CORE_ALREADY_RUNNING` and the socket path, so `candle tui` attaches instead of
 * starting a rival that would hold its own card queue and journal.
 *
 * The lock is a file created with O_EXCL holding the owner's pid. Unlike `file-lock.ts`, whose
 * locks live for one read-modify-write and are broken by age, this one is held for the life of
 * the process, so age says nothing. A lock is stale when its pid is not a live process; a stale
 * lock is moved aside (never deleted in place, so two starters racing over it cannot both win)
 * and the create is tried once more.
 */
import { link, open, readFile, rename, rm } from "node:fs/promises"

export interface InstanceLock {
  release(): Promise<void>
}

export class CoreAlreadyRunningError extends Error {
  readonly code = "CORE_ALREADY_RUNNING"
  constructor(
    readonly pid: number | undefined,
    readonly socketPath: string,
  ) {
    super(
      `A Candle core is already running for this profile${pid !== undefined ? ` (pid ${pid})` : ""}. Attach to it at ${socketPath}.`,
    )
    this.name = "CoreAlreadyRunningError"
  }
}

/** Whether `pid` names a live process. EPERM means it exists under another user, so it is alive. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function lockOwner(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }
    return typeof parsed.pid === "number" ? parsed.pid : undefined
  } catch {
    return undefined
  }
}

export async function acquireInstanceLock(input: {
  lockPath: string
  socketPath: string
  pid?: number
  now?: () => number
  isAlive?: (pid: number) => boolean
}): Promise<InstanceLock> {
  const pid = input.pid ?? process.pid
  const isAlive = input.isAlive ?? pidIsAlive
  const now = input.now ?? Date.now
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(input.lockPath, "wx", 0o600)
      try {
        await handle.write(`${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          // Only our own lock: a lock another core took after ours was moved aside is not ours.
          if ((await lockOwner(input.lockPath)) === pid) await rm(input.lockPath, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = await lockOwner(input.lockPath)
      // An unreadable lock may be one being written this instant; treat it as held.
      if (owner === undefined || isAlive(owner)) throw new CoreAlreadyRunningError(owner, input.socketPath)
      const aside = `${input.lockPath}.stale-${owner}-${pid}-${now()}`
      try {
        await rename(input.lockPath, aside)
      } catch (renameError) {
        // Another starter moved it first; the retry decides between us by O_EXCL.
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError
        continue
      }
      const moved = await lockOwner(aside)
      if (moved !== owner) {
        // Between our read and our rename, another starter replaced the stale lock with its own
        // live one, and we moved THAT aside. Put it back without clobbering (link fails if the
        // path is taken again), and yield to it.
        await link(aside, input.lockPath).catch(() => {})
        await rm(aside, { force: true })
        throw new CoreAlreadyRunningError(moved, input.socketPath)
      }
      await rm(aside, { force: true })
    }
  }
  throw new CoreAlreadyRunningError(await lockOwner(input.lockPath), input.socketPath)
}
