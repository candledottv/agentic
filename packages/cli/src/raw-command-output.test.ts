import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { rawProseWrites } from "./raw-command-output.test-support"

test("commands add no raw multi-sentence writes; use the output kit", () => {
  const directory = join(import.meta.dir, "commands")
  const unexpected: Array<{ file: string; prose: string }> = []
  // No baseline: release C converts all residual human prose. Held TUI paths stay excluded.
  for (const file of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    if (
      !file.endsWith(".ts") ||
      file.endsWith(".test.ts") ||
      file.startsWith("__fixtures__/") ||
      ["tui.ts", "core.ts", "core-mcp.ts"].includes(file)
    )
      continue
    for (const prose of rawProseWrites(readFileSync(join(directory, file), "utf8"))) {
      unexpected.push({ file, prose })
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

test("the guard permits machine diagnostics and kit calls, without letting JSON hide adjacent prose", () => {
  expect(rawProseWrites('if (ctx.json) deps.stderr.write("Machine diagnostic. Next step.")')).toEqual([])
  expect(rawProseWrites('if (ctx.json) {} else deps.stderr.write("Human prose. Next step.")')).toEqual([
    "Human prose. Next step.",
  ])
  expect(rawProseWrites('out.write(fields([["Fact", "Value. Advice."]], style).join("\\n"))')).toEqual([])
  expect(rawProseWrites('out.write("First sentence. Second sentence. " + JSON.stringify(data))')).toEqual([
    "First sentence. Second sentence.",
  ])
  expect(rawProseWrites('out.write(ok ? "First outcome." : "Other outcome.")')).toEqual([])
  expect(rawProseWrites('out.write("first sentence. second sentence.")')).toEqual(["first sentence. second sentence."])
  expect(rawProseWrites('out.write(["First sentence.", "Second sentence."].join("\\n"))')).toEqual([
    "First sentence. Second sentence.",
  ])
})
