/**
 * Temp folders that a test file cleans up after itself (BE-2216).
 *
 * `vault-parity.test.ts` made a fresh `candle-vault-parity-*` folder per run and compiled a 93 MB
 * binary into it with nothing removing it. On the self-hosted CI guests, which keep `/tmp` between
 * jobs, hundreds of them filled the disks on 2026-10-29. `scripts/check-temp-dirs.ts` now fails a
 * test file that calls `mkdtemp` with no cleanup in the same file; this is the cleanup.
 *
 * Call `tempDirs()` ONCE at the top level of a test file and use what it returns everywhere in the
 * file, inside tests and hooks included:
 *
 *     const tempDir = tempDirs()
 *     ...
 *     const dir = tempDir("candle-thing-")
 *
 * Why a factory and not a plain `tempDir(prefix)` that registers its own hook: bun runs every test
 * file in one process and evaluates a shared module once, so a hook in this module would belong to
 * the first file that imported it. And an `afterAll` registered from inside a test or a `beforeAll`
 * runs as soon as that test or hook ends, which would remove a folder a later test still reads.
 * The top-level call registers one `afterAll` that runs after the file's last test, pass or fail.
 */
import { afterAll } from "bun:test"
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function tempDirs(): (prefix: string) => string {
  const made: string[] = []
  afterAll(() => {
    for (const dir of made.splice(0)) removeTempDir(dir)
  })
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    made.push(dir)
    return dir
  }
}

/**
 * Removes a test's temp folder, best effort. Some tests take permissions away on purpose (an
 * unreadable vault, a read-only folder), so a first failure gives the owner back write access
 * through the tree and tries once more. A folder that still will not go is reported, not thrown:
 * cleanup must never be the reason a suite fails.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
    return
  } catch {
    restoreAccess(dir)
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn(`temp-dirs: could not remove ${dir}: ${(err as Error).message}`)
  }
}

function restoreAccess(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
    if (stat.isDirectory()) for (const name of readdirSync(path)) restoreAccess(join(path, name))
  } catch {
    // Nothing more to try here; the second rmSync reports what is left.
  }
}
