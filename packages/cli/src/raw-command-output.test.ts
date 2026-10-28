import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import baseline from "./fixtures/raw-command-output.json"
import { rawProseWrites } from "./raw-command-output.test-support"

test("commands add no raw multi-sentence writes; use the output kit", () => {
  const directory = join(import.meta.dir, "commands")
  const unexpected: Array<{ file: string; prose: string }> = []
  // Frozen residual prose and machine diagnostics. Part 2 removes converted entries. Do not add new prose to
  // the baseline: new commands use fields/notices/errors from the kit. Held TUI paths are excluded.
  const allowed: Record<string, string[]> = structuredClone(baseline)
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || ["tui.ts", "core.ts", "core-mcp.ts"].includes(file))
      continue
    const remaining = allowed[file] ?? []
    for (const prose of rawProseWrites(readFileSync(join(directory, file), "utf8"))) {
      const index = remaining.indexOf(prose)
      if (index === -1) unexpected.push({ file, prose })
      else remaining.splice(index, 1)
    }
  }
  expect(unexpected).toEqual([])
})

test("the guard sees concatenation, templates and paragraphs but ignores JSON and single facts", () => {
  expect(rawProseWrites('deps.stdout.write("First sentence. " + "Second sentence.\\n")')).toEqual([
    "First sentence. Second sentence.",
  ])
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code for the parser.
  expect(rawProseWrites("deps.stderr.write(`Key ${prefix} changed. Check its limits.\\n`)")).toEqual([
    "Key changed. Check its limits.",
  ])
  expect(rawProseWrites('out.write("First sentence.\\nSecond sentence.")')).toEqual([
    "First sentence. Second sentence.",
  ])
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code for the parser.
  expect(rawProseWrites('out.write(`${JSON.stringify({message: "First. Second."})}\\n`)')).toEqual([])
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code for the parser.
  expect(rawProseWrites("out.write(`Address: ${address}\\n`)")).toEqual([])
})
