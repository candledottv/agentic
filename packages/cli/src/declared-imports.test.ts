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
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import pkg from "../package.json"

const srcDir = resolve(import.meta.dir)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (name.endsWith(".ts") || name.endsWith(".mts")) {
      out.push(path)
    }
  }
  return out
}

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

/**
 * Drops block and line comments, so a specifier written in prose (this file documents several) is
 * not read as an import. Crude by design: it does not need to understand the language, only to
 * stop a comment from looking like a statement.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
}

/**
 * Every specifier a file imports, static and dynamic, including `export ... from`.
 *
 * The clause between the keyword and `from` is restricted to the characters an import clause can
 * actually contain, which is what keeps the match from running across a whole file: a lazy
 * `[\s\S]*?` found the word "from" inside `vault/eff-wordlist.ts` and reported one of its 7776
 * words as a package.
 */
function specifiersIn(rawSource: string): string[] {
  const source = withoutComments(rawSource)
  const found: string[] = []
  const patterns = [
    // import x from "y" / import type { A, B } from "y" / export { x } from "y", across lines.
    /^[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?[\w*{},\s$]*?from[ \t]*["']([^"']+)["']/gm,
    // import "y" (side effect only).
    /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
    // await import("y").
    /\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1])
    }
  }
  return found
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
