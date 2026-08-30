/**
 * A cross-process exclusive lock, for the read-modify-write cycles that share one file.
 *
 * credentials.enc and wallets.enc are each a SINGLE json document holding every entry, so a write
 * is read-whole, modify-one, write-whole. Two of those interleaving is not a torn file (the write
 * itself is atomic via rename) but a LOST ENTRY: both readers see the same starting state, both
 * add their own ref, and whichever renames second silently drops the other's. Running `candle keys
 * create` in one terminal while `candle auth login` finishes in another is enough.
 *
 * O_EXCL is the primitive because the guarantee has to hold across PROCESSES, which an in-memory
 * mutex cannot do. A lock older than STALE_MS is broken rather than waited on, so a process killed
 * while holding one does not wedge the CLI for the next operator; the window is long enough that
 * no honest holder is mistaken for a corpse.
 */
import { open, rm, stat } from "node:fs/promises"

const STALE_MS = 30_000
const RETRY_MS = 25
const TIMEOUT_MS = 10_000

export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    try {
      // "wx" is O_CREAT|O_EXCL: it succeeds for exactly one caller and throws EEXIST for the rest.
      await (await open(lockPath, "wx")).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const age = await stat(lockPath)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0)
      if (age > STALE_MS) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${lockPath}. Another candle process is writing; if none is running, delete that file.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    // Always, including on a throw: a lock outliving its holder is the failure this guards against.
    await rm(lockPath, { force: true })
  }
}
