/**
 * BE-1665 (spec K-11, T-18's import half): the core-only credential slot is read by exactly one
 * code path, the loader inside `candle core serve`. `core/slot.ts` may be imported by
 * `commands/core.ts` alone -- statically, dynamically or through a re-export -- and that file must
 * not hand any of it on. Tests may import it; they never ship.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { sourceFiles, specifiersIn, withoutComments } from "../import-scan"

const srcDir = resolve(import.meta.dir, "..")
const SLOT = resolve(srcDir, "core/slot")
const ALLOWED_IMPORTER = resolve(srcDir, "commands/core.ts")

function shipped(file: string): boolean {
  return !file.endsWith(".test.ts")
}

function resolvesToSlot(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false
  return resolve(dirname(file), specifier).replace(/\.[cm]?[jt]s$/, "") === SLOT
}

/** Any quoted path ending in `/slot` or `/slot.ts`: catches a specifier the import patterns cannot see. */
const SLOT_STRING = /["'`][^"'`\n]*\/slot(?:\.[cm]?[jt]s)?["'`]/

describe("the core slot loader has one importer", () => {
  const files = sourceFiles(srcDir).filter(shipped)

  test("the scan sees the slot module and its importer", () => {
    expect(files).toContain(`${SLOT}.ts`)
    expect(files).toContain(ALLOWED_IMPORTER)
  })

  test("no shipped file but commands/core.ts imports core/slot", () => {
    const importers = files.filter((file) =>
      specifiersIn(readFileSync(file, "utf8")).some((specifier) => resolvesToSlot(file, specifier)),
    )
    expect(importers.map((file) => relative(srcDir, file))).toEqual(["commands/core.ts"])
  })

  test("no shipped file names the slot module in any string, so no computed import can reach it", () => {
    const naming = files
      .filter((file) => file !== ALLOWED_IMPORTER && file !== `${SLOT}.ts`)
      .filter((file) => SLOT_STRING.test(withoutComments(readFileSync(file, "utf8"))))
    expect(naming.map((file) => relative(srcDir, file))).toEqual([])
  })

  test("commands/core.ts re-exports nothing from the slot module", () => {
    const source = withoutComments(readFileSync(ALLOWED_IMPORTER, "utf8"))
    expect(source).not.toMatch(/^\s*export\s+(?:\*|\{[^}]*\})\s*from/m)
    for (const name of [
      "openCoreSlot",
      "sealCoreSlot",
      "resealCoreSlot",
      "moveProfileToCore",
      "finishCoreMove",
      "readCoreSlotHeader",
    ]) {
      expect(source).not.toMatch(new RegExp(`export[^\\n]*\\b${name}\\b`))
    }
  })

  test("the detector would catch a dynamic import and a re-export", () => {
    const fake = resolve(srcDir, "commands/other.ts")
    for (const line of ['await import("../core/slot")', 'export { openCoreSlot } from "../core/slot.ts"']) {
      expect(specifiersIn(line).some((specifier) => resolvesToSlot(fake, specifier))).toBe(true)
    }
    expect(SLOT_STRING.test('const m = await import(dir + "/slot.ts")')).toBe(true)
    expect(SLOT_STRING.test('Pick<CorePaths, "slot">')).toBe(false)
  })
})
