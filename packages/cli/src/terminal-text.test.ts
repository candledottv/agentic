import { expect, test } from "bun:test"
import { printTradingResult } from "./commands/swap"
import { fields, heading, renderNotice, terminalStyle } from "./presentation"
import { identityLine } from "./profiles"
import { renderTable, writeFailure } from "./render"
import { terminalLines, escapeTerminalText as terminalText } from "./terminal-text"
import { createCapture, createTestDeps } from "./test-support"

const hostile = "name\x1b[2J\r\x07\x7f\x9b\x1b]52;c;payload\x1b\\"
const escaped = "name\\x1b[2J\\r\\x07\\x7f\\x9b\\x1b]52;c;payload\\x1b\\"

test("every C0 except tab, DEL and C1 becomes visible, with no control left to execute", () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i)]) {
    const char = String.fromCharCode(code)
    const output = terminalText(`a${char}z`)
    if (code === 9) expect(output).toBe("a\tz")
    else {
      expect(output).not.toContain(char)
      expect(output.startsWith("a\\")).toBe(true)
      expect(output.endsWith("z")).toBe(true)
    }
  }
  expect(terminalText(hostile)).toBe(escaped)
  expect(terminalText(escaped)).toBe(escaped)
  expect(terminalText("日本語 café 🚀")).toBe("日本語 café 🚀")
  expect(terminalLines("one\n\n" + hostile)).toBe("one\n\n" + escaped)
})

test("human renderers escape data before fitting and add only their own styles", () => {
  for (const color of [false, true]) {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("rendering must not fetch")
      }) as unknown as typeof fetch,
      isTTY: { stdin: true, stdout: color, stderr: color },
      env: { TERM: "xterm-256color" },
      columns: { stdout: 240, stderr: 240 },
    })
    const style = terminalStyle(deps, "stdout")
    for (const text of [
      renderTable(["Name"], [[hostile]]),
      renderTable(["Name"], [[hostile]], { style, columns: [{ id: true }] }),
      fields([["Name", hostile]], style).join("\n"),
      heading(hostile, style),
      renderNotice("warning", hostile, style).join("\n"),
      identityLine("profile", "account", "https://api.example.test", undefined, hostile, { style }),
    ]) {
      expect(text).toContain(escaped)
      expect(text).not.toContain("\x1b[2J")
      expect(text).not.toContain("\x1b]52;")
      expect(text).not.toContain("\r")
      expect(text).not.toContain("\x07")
    }
    expect(fields([["Name", "line\nname"]], style).join("\n")).toContain("line\\nname")
    if (color) expect(heading("safe", style)).toContain("\x1b[1m")
  }
})

test("API errors escape human text while the JSON error retains its exact data", () => {
  const result = { status: 400, message: hostile, code: "BAD_INPUT" }
  for (const json of [false, true]) {
    const stdout = createCapture()
    const stderr = createCapture()
    writeFailure({ stdout, stderr }, result, { apiUrl: "https://api.example.test" }, json)
    if (json) {
      expect(JSON.parse(stdout.text).message).toBe(hostile)
      expect(stderr.text).toBe("")
    } else {
      expect(stderr.text).toBe(`${escaped}\n`)
      expect(stdout.text).toBe("")
    }
  }
})

test("pretty JSON on a human screen escapes C1; --json retains the original bytes", () => {
  const result = { text: "user\x9b2J\x9d52;c;payload\x9c" }
  for (const json of [false, true]) {
    const stdout = createCapture()
    const deps = createTestDeps({
      stdout,
      fetch: (() => {
        throw new Error("rendering must not fetch")
      }) as unknown as typeof fetch,
    })
    expect(printTradingResult({ deps, json, apiUrl: "https://api.example.test", verifyAccount: true }, result)).toBe(0)
    if (json) expect(stdout.text).toBe(`${JSON.stringify(result)}\n`)
    else {
      expect(stdout.text).toContain("user\\x9b2J\\x9d52;c;payload\\x9c")
      expect(stdout.text).not.toContain("\x9b")
      expect(stdout.text).toContain("\n  ")
    }
  }
})
