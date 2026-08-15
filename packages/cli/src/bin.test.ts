/**
 * Bundle-level tests of the bin entry itself: build dist/index.js and execute it the ways a real
 * installation does. The symlink case is the load-bearing one. Package managers run a bin through
 * node_modules/.bin/candle, a SYMLINK to the bundle, and node keeps the symlink path in argv[1]
 * while import.meta.url resolves to the real file. The original isMainModule guard compared the
 * two unrealpath'd, so every bunx/npx invocation silently exited 0 having done nothing -- caught
 * live by the P4b-3 acceptance test after three review rounds of direct-path-only testing.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pkgDir = resolve(import.meta.dir, "..")
const bundle = join(pkgDir, "dist", "index.js")

beforeAll(() => {
  const built = spawnSync("bun", ["run", "build"], { cwd: pkgDir, encoding: "utf8" })
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`)
})

function runNode(entry: string, args: string[]) {
  return spawnSync("node", [entry, ...args], { encoding: "utf8" })
}

describe("the built bin entry", () => {
  test("runs when invoked by its direct path", () => {
    const res = runNode(bundle, ["--version"])
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("runs when invoked through a symlink, the way bunx and npx execute a bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-bin-"))
    const link = join(dir, "candle")
    symlinkSync(bundle, link)
    const res = runNode(link, ["--version"])
    // The unfixed guard exits 0 with EMPTY output here, so assert on stdout, not just the code.
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(res.status).toBe(0)
  })

  test("through a symlink, a real command still dispatches (bunx passthrough token included)", () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-bin-"))
    const link = join(dir, "candle")
    symlinkSync(bundle, link)
    // `candle` as the first token mirrors bunx passing the bin name through; the dispatcher
    // strips one leading `candle`. `--help` proves main() ran and dispatch executed.
    const res = runNode(link, ["candle", "--help"])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("Usage:")
  })
})
