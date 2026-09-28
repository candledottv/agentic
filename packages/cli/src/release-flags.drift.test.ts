import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const flags = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"]
test("R1.1 every release binary and helper disables dotenv and bunfig autoload", () => {
  const root = join(import.meta.dir, "../../..")
  const mirror = join(root, "distribution/agentic/.github/workflows/release.yaml")
  const release = existsSync(mirror) ? mirror : join(root, ".github/workflows/release.yaml")
  const scripts = Object.values(
    JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).scripts,
  ) as string[]
  const lines = [...scripts, ...(existsSync(release) ? readFileSync(release, "utf8").split("\n") : [])].filter((line) =>
    /bun build\s+--compile\b/.test(line),
  )
  expect(existsSync(release)).toBe(true)
  expect(lines.length).toBeGreaterThanOrEqual(4)
  for (const line of lines) for (const flag of flags) expect(line).toContain(flag)
})
