/**
 * The real prompts, on explicit streams (Ember Phase 2, BE-136, T39): the prompt text goes to the
 * error stream and nothing to standard output, so a `--json` command that unlocks a vault on a
 * terminal still leaves stdout as exactly one JSON value; and the hidden prompt echoes nothing of
 * what was typed. The command tests cannot see either, because they inject fake prompts.
 */
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { readHiddenLine, readVisibleLine } from "./secret-store"

/** Cursor-control sequences readline emits around a prompt (`ESC [ ... letter`), removed for the text assertion. */
const ESCAPE = String.fromCharCode(27)
const withoutAnsi = (text: string): string => text.replace(new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, "g"), "")

function capture() {
  let text = ""
  const stream = new PassThrough()
  stream.on("data", (chunk: Buffer | string) => {
    text += chunk.toString()
  })
  return {
    stream,
    get text() {
      return text
    },
  }
}

describe("the real prompts write to the stream they are given, and the hidden one echoes nothing", () => {
  test("hidden: the prompt and the closing newline reach the output stream, the answer never does", async () => {
    const input = new PassThrough()
    const output = capture()
    const answered = readHiddenLine("Vault passphrase (input hidden): ", { input, output: output.stream })
    await Bun.sleep(20)
    input.write("correct horse\r")
    expect(await answered).toBe("correct horse")
    // readline surrounds the prompt with cursor-control sequences; the TEXT is the prompt, a
    // newline, and nothing typed.
    expect(withoutAnsi(output.text)).toBe("Vault passphrase (input hidden): \n")
    expect(output.text).not.toContain("correct")
    expect(output.text).not.toContain("horse")
  })

  test("visible: the prompt and the echoed answer reach the output stream", async () => {
    const input = new PassThrough()
    const output = capture()
    const answered = readVisibleLine("Type word 3: ", { input, output: output.stream })
    await Bun.sleep(20)
    input.write("liar\r")
    expect(await answered).toBe("liar")
    expect(output.text).toContain("Type word 3: ")
    expect(output.text).toContain("liar")
  })

  test("the shipped prompts render on stderr, so stdout is untouched by a prompt", async () => {
    // Asserted at the source, since only a terminal can drive the TTY-guarded wrappers: the one
    // place the real streams are chosen names stderr for output and nothing names stdout.
    const source = await Bun.file(new URL("./secret-store.ts", import.meta.url)).text()
    const chosen = /function realPromptStreams\(\)[^}]*\{([^}]*)\}/.exec(source)?.[1] ?? ""
    expect(chosen).toContain("output: process.stderr")
    expect(chosen).not.toContain("stdout")
    const hidden = source.slice(source.indexOf("export async function readHiddenLine"))
    expect(hidden).not.toContain("process.stdout")
  })
})
