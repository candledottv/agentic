/**
 * Source scanning for the import tests (`declared-imports.test.ts`, `core/core-slot-imports.test.ts`).
 * Not a test file itself, and imported by nothing that ships: `index.ts` never reaches it.
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Every `.ts` / `.mts` file under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
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
 * Drops block and line comments, so a specifier written in prose is not read as an import. Crude
 * by design: it does not need to understand the language, only to stop a comment from looking
 * like a statement.
 */
export function withoutComments(source: string): string {
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
export function specifiersIn(rawSource: string): string[] {
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
