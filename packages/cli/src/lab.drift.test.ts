import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/lab.ts is byte-identical to the SDK original", () => {
  const original = join(import.meta.dir, "../../sdk/src/lab.ts")
  if (!existsSync(original)) return
  expect(readFileSync(join(import.meta.dir, "lab.ts"), "utf8")).toBe(readFileSync(original, "utf8"))
})
