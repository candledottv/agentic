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
 *
 * The lock file lives in the target's directory, so the lock creates that directory first (BE-2712,
 * D1). On a fresh box nothing had made `~/.config/candle` yet, the `"wx"` open failed with ENOENT,
 * and the first credential write died as `Unexpected error` before the store's own `mkdir` could
 * run. A directory this creates is set to 0700, the mode every caller gives it on its next write;
 * an existing one is left exactly as it is.
 */
import { chmod, mkdir, open, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

const STALE_MS = 30_000
const RETRY_MS = 25
const TIMEOUT_MS = 10_000

export const CONFIG_DIR_UNWRITABLE = "CONFIG_DIR_UNWRITABLE"

/**
 * The lock's directory could not be created or written (BE-2712, D3): a parent the user cannot
 * write, a read-only filesystem, or a file where a directory should be. `run()` maps it to the
 * `CONFIG_DIR_UNWRITABLE` failure with a fix line, instead of the bare errno escaping as
 * `Unexpected error`. `path` is the lock's directory: the config directory for the credential
 * stores, `<config>/spend` for the x402 callers.
 */
export class ConfigDirUnwritableError extends Error {
  readonly code = CONFIG_DIR_UNWRITABLE
  readonly suggestion: string
  constructor(
    readonly path: string,
    readonly errno: string,
    cause: unknown,
  ) {
    // EEXIST reaches here only from the `mkdir` (the open's EEXIST is the retry below): that path
    // or one of its parents is a file.
    super(
      errno === "ENOTDIR" || errno === "EEXIST"
        ? `${path} or one of its parents is not a directory (${errno}).`
        : `Cannot write the Candle config directory ${path} (${errno}).`,
      { cause },
    )
    this.name = "ConfigDirUnwritableError"
    this.suggestion = `Fix: as the user that runs candle, run mkdir -m 700 ${path}, or set CANDLE_CONFIG_DIR to a directory that user can write.`
  }
}

function unwritable(dir: string, error: unknown): ConfigDirUnwritableError {
  return new ConfigDirUnwritableError(dir, (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN", error)
}

export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const dir = dirname(target)
  try {
    // `recursive` returns the first directory it made, or undefined when it was already there, so
    // only a directory made here is tightened. Parents it also made get the mode `writeContents`
    // has always given them.
    const created = await mkdir(dir, { recursive: true })
    if (created !== undefined) await chmod(dir, 0o700)
  } catch (error) {
    throw unwritable(dir, error)
  }
  const lockPath = `${target}.lock`
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    try {
      // "wx" is O_CREAT|O_EXCL: it succeeds for exactly one caller and throws EEXIST for the rest.
      await (await open(lockPath, "wx")).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unwritable(dir, error)
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
