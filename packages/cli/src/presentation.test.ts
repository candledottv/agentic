import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { renderTopic, renderTopLevel } from "./help"
import { run } from "./index"
import { LAUNCH_DEFINITION } from "./launch-definition"
import { brandHeader, terminalStyle } from "./presentation"
import { TERMINAL_TOKENS } from "./terminal-theme"
import { createCapture, createTestDeps } from "./test-support"
import { CLI_VERSION } from "./version"

const TUI_BIN = new URL("../../tui/src/bin.tsx", import.meta.url).pathname

const unusedFetch = (() => {
  throw new Error("presentation must not fetch")
}) as unknown as typeof fetch
// biome-ignore lint/suspicious/noControlCharactersInRegex: assert only SGR is added to terminal help
const sgr = /\x1b\[[0-9;]*m/g
const clean = (text: string) => text.replace(sgr, "")

describe("terminal presentation", () => {
  test("help matrix: widths, backgrounds, color/plain modes and actual output stream", async () => {
    for (const width of [40, 60, 80, 120]) {
      for (const background of ["0", "15"]) {
        for (const mode of ["color", "no-color", "plain", "pipe", "CI", "dumb", "env-plain"]) {
          const stdout = createCapture()
          const deps = createTestDeps({
            fetch: unusedFetch,
            stdout,
            env: {
              TERM: mode === "dumb" ? "dumb" : "xterm-256color",
              COLORTERM: "truecolor",
              COLORFGBG: `15;${background}`,
              ...(mode === "CI" ? { CI: "1" } : {}),
              ...(mode === "env-plain" ? { CANDLE_PLAIN: "1" } : {}),
            },
            isTTY: { stdin: true, stdout: mode !== "pipe", stderr: true },
            columns: { stdout: width },
            readConfig: async () => {
              throw new Error("help must not read config")
            },
            store: {
              get: async () => {
                throw new Error("help must not read secrets")
              },
              set: async () => {},
              delete: async () => {},
            },
          })
          expect(
            await run(
              ["--help", ...(mode === "no-color" ? ["--no-color"] : mode === "plain" ? ["--plain"] : [])],
              deps,
            ),
          ).toBe(0)
          const text = clean(stdout.text)
          const intro = LAUNCH_DEFINITION.surfacesIntro.join(" ")
          const normalized = text.replace(/\s+/g, " ")
          expect(normalized).toContain(intro)
          expect(normalized.indexOf(intro)).toBeGreaterThan(normalized.indexOf("one command away."))
          expect(normalized.indexOf(intro)).toBeLessThan(normalized.indexOf("Start here"))
          expect(text).toContain("candle setup")
          expect(text).toContain("candle portfolio")
          expect(text).toContain("CANDLE_CONFIG_DIR")
          expect(text).not.toContain("…")
          const styled = mode === "color" || mode === "no-color"
          expect(text.includes("┌")).toBe(styled)
          expect(stdout.text.includes("\x1b")).toBe(mode === "color")
          if (!styled) expect([...text].some((char) => char.charCodeAt(0) > 127)).toBe(false)
          if (styled) {
            expect(text).toContain(`CLI ${CLI_VERSION}`)
            expect(text.includes("█")).toBe(width >= 80)
          }
          // Long tokens may soft-wrap in a terminal; words and identifiers are never split.
          for (const line of text.split("\n")) {
            if (line.startsWith("  candle ")) continue
            if (
              line
                .trim()
                .split(/\s+/)
                .some((word) => word.length > width - 4)
            )
              continue
            expect(line.length).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test("NO_COLOR and --no-color retain layout; plain and machine modes dominate cosmetics", () => {
    for (const env of [{ NO_COLOR: "1" }, { NO_COLOR: "" }]) {
      const deps = createTestDeps({ fetch: unusedFetch, env: { TERM: "xterm", ...env } })
      const style = terminalStyle(deps, "stdout")
      expect(style.styled).toBe(true)
      expect(style.color === 0).toBe(Boolean(env.NO_COLOR))
      expect(style.motion).toBe(!env.NO_COLOR)
      expect(terminalStyle(deps, "stdout", true).styled).toBe(false)
    }
    const deps = createTestDeps({
      fetch: unusedFetch,
      env: { TERM: "xterm-256color", FORCE_COLOR: "3" },
      presentation: { plain: true },
    })
    expect(terminalStyle(deps, "stdout").color).toBe(0)
    expect(brandHeader(terminalStyle(deps, "stdout"))).toEqual([])
    deps.isTTY.stdout = false
    deps.presentation = undefined
    expect(terminalStyle(deps, "stdout").styled).toBe(false)
    expect(terminalStyle(deps, "stderr").styled).toBe(true)
  })

  test("16/256/truecolor support and light-safe unknown background", () => {
    for (const [env, color] of [
      [{ TERM: "xterm" }, 16],
      [{ TERM: "xterm-256color" }, 256],
      [{ COLORTERM: "24bit" }, 24],
    ] as const) {
      const style = terminalStyle(createTestDeps({ fetch: unusedFetch, env }), "stdout")
      expect(style.color).toBe(color)
      expect(style.theme).toBe("light")
    }
  })

  test("long topic commands and addresses stay inspectable", () => {
    const style = terminalStyle(createTestDeps({ fetch: unusedFetch, columns: { stdout: 40 } }), "stdout")
    const text = renderTopic("tee", style) ?? ""
    expect(text).toContain("0x000000000000000000000000000000000000dEaD")
    expect(text).toContain("candle tee rename --pairs-from ./tee-names.csv --dry-run")
    expect(text).not.toContain("…")
    expect(text).not.toContain("┌")
  })

  test("version, completion, ordinary and error bytes/codes ignore cosmetic flags anywhere", async () => {
    for (const argv of [
      ["--version"],
      ["completion", "zsh"],
      ["completion", "bash"],
      ["completion", "fish"],
      ["secrets", "list"],
      ["setup", "--json"],
      ["keys", "bad-subcommand"],
      ["bogus"],
      ["auth", "--bogus", "--json"],
    ]) {
      const invoke = async (args: string[]) => {
        const stdout = createCapture(),
          stderr = createCapture()
        const code = await run(
          args,
          createTestDeps({ fetch: unusedFetch, stdout, stderr, env: { TERM: "xterm-256color" } }),
        )
        return { code, stdout: stdout.text, stderr: stderr.text }
      }
      const original = await invoke(argv)
      expect(await invoke(["--plain", ...argv])).toEqual(original)
      expect(await invoke([...argv, "--no-color"])).toEqual(original)
      expect(await invoke(["--no-color", ...argv.slice(0, 1), "--plain", ...argv.slice(1)])).toEqual(original)
      expect(`${original.stdout}${original.stderr}`).not.toContain("\x1b")
    }
  })

  test("bare invocation uses stderr's capabilities, exits 1 and needs no identity", async () => {
    const stdout = createCapture(),
      stderr = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      stderr,
      env: { TERM: "xterm" },
      isTTY: { stdin: false, stdout: false, stderr: true },
      columns: { stderr: 40 },
      readConfig: async () => {
        throw new Error("no profile required")
      },
    })
    expect(await run([], deps)).toBe(1)
    expect(stdout.text).toBe("")
    expect(clean(stderr.text)).toContain("CANDLE")
    expect(await run(["--plain"], deps)).toBe(1)
  })

  test("truecolor accents meet 4.5:1 against default white/light and black/dark references", () => {
    const luminance = (hex: string) => {
      const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/../g) ?? []).map((part) => {
        const c = Number.parseInt(part, 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    for (const theme of ["light", "dark"] as const) {
      for (const token of Object.values(TERMINAL_TOKENS[theme])) {
        const l = luminance(token.hex)
        expect(theme === "light" ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("every command survives the wide two-column layout", () => {
    const deps = createTestDeps({ fetch: unusedFetch, columns: { stdout: 120 } })
    const text = clean(renderTopLevel(terminalStyle(deps, "stdout")))
    expect(text).toMatch(/Trade +Account/)
    expect(text).toMatch(/Custody, on this machine +Your own services/)
  })
  // The public agentic export carries the CLI without packages/tui, so the TUI entry is absent there.
  test.skipIf(!existsSync(TUI_BIN))(
    "the standalone TUI rejects a pipe before importing its screen or starting a session",
    async () => {
      const child = Bun.spawn([process.execPath, TUI_BIN], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH },
      })
      child.stdin.end()
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("Use candle portfolio or candle help")
      expect(stderr).not.toContain("\x1b")
    },
  )
})
