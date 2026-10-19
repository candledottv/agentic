/**
 * Ember Phase 2 (BE-136, CC-09): every bare import under `packages/cli/src` names a package
 * declared in `packages/cli/package.json`.
 *
 * This exists because of E21, which is the failure this repository has already paid for once. CLI
 * 0.9.1's signed binary release failed in the `candledottv/agentic` mirror because tests imported
 * `@solana/spl-token` and `@solana/web3.js`, which resolved happily from other monorepo workspaces
 * and were never declared HERE. The mirror sees only this package's `package.json`, so the import
 * that works in the monorepo is the import that breaks the release, and it breaks it at the last
 * possible moment: after the version bump, inside the job that publishes npm, tags the mirror,
 * compiles four binaries and bumps Homebrew.
 *
 * So the check runs in the monorepo, where the answer is cheap, instead of in the mirror, where it
 * is a failed release. PR A adds three declared imports of its own (`@noble/hashes/argon2`,
 * `@scure/bip39`, `@scure/bip39/wordlists/english`) and this is what proves they are declared.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import pkg from "../package.json"
import { sourceFiles, specifiersIn } from "./import-scan"

const srcDir = resolve(import.meta.dir)

/**
 * The package a specifier resolves to. `@scope/name/sub` is `@scope/name`; `name/sub` is `name`.
 * A relative or absolute specifier, and a `node:`/`bun:` builtin, is not a package at all.
 */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return null
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  return parts[0] ?? specifier
}

describe("every bare import is declared in this package's own package.json", () => {
  const declared = new Set([
    ...Object.keys((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...Object.keys((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  ])

  test("the scan finds source files at all", () => {
    // A traversal that silently matched nothing would make every assertion below vacuous, which is
    // precisely the shape of failure this test exists to prevent.
    expect(sourceFiles(srcDir).length).toBeGreaterThan(50)
  })

  test("no file imports an undeclared package", () => {
    const undeclared: string[] = []
    for (const file of sourceFiles(srcDir)) {
      for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
        const name = packageOf(specifier)
        if (name === null || declared.has(name)) continue
        undeclared.push(`${file.slice(srcDir.length + 1)} imports ${specifier} (package ${name})`)
      }
    }
    // The whole list, not the first one: a release blocked one undeclared import at a time is a
    // release blocked several times.
    expect(undeclared).toEqual([])
  })

  test("the three libraries the vault rests on are actually imported and declared", () => {
    // The converse of the test above, so that deleting the vault's imports and leaving the
    // declarations (or the reverse) does not quietly pass.
    const all = sourceFiles(srcDir).flatMap((file) => specifiersIn(readFileSync(file, "utf8")))
    for (const specifier of ["@noble/hashes/argon2", "@scure/bip39", "@scure/bip39/wordlists/english"]) {
      expect(`${specifier}: ${all.includes(specifier)}`).toBe(`${specifier}: true`)
      expect(declared.has(packageOf(specifier) as string)).toBe(true)
    }
  })

  test("a bare import of an undeclared package would be caught", () => {
    // The detector, exercised on a synthetic source rather than trusted. Without this, a regex that
    // stopped matching would turn the assertion above into a permanent pass.
    const synthetic = `import { a } from "@not-declared/at-all"\nimport { b } from "./local"\nimport { c } from "node:fs"\n`
    const names = specifiersIn(synthetic).map(packageOf)
    expect(names).toEqual(["@not-declared/at-all", null, null])
    expect(declared.has("@not-declared/at-all")).toBe(false)
  })
})
