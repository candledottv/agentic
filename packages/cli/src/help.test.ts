import { describe, expect, test } from "bun:test"
import { ENVIRONMENT, GROUPS, HELP, renderTopic, renderTopLevel } from "./help"
import { run } from "./index"
import { LAUNCH_DEFINITION } from "./launch-definition"
import { displayWidth, terminalStyle } from "./presentation"
import { createCapture, createTestDeps } from "./test-support"

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
const unusedFetch = (() => {
  throw new Error("help must not use the network")
}) as unknown as typeof fetch
const styleAt = (width: number) =>
  terminalStyle(createTestDeps({ fetch: unusedFetch, columns: { stdout: width } }), "stdout", false)

describe("release B help", () => {
  test("every short intro fits three lines at reading widths; all full rules remain local", () => {
    for (const width of [40, 60, 80, 100, 118, 160]) {
      for (const [word, topic] of Object.entries(HELP)) {
        const short = renderTopic(word, styleAt(width)) ?? ""
        const full = renderTopic(word, styleAt(width), true) ?? ""
        expect(short.split("\n\n")[0]?.split("\n").length).toBeLessThanOrEqual(3)
        expect(normalize(short)).toContain(`candle help ${topic.display ?? word} --more`)
        expect(normalize(full)).toContain(normalize(topic.description))
        for (const row of [...topic.rows, ...(topic.flags ?? [])]) {
          expect(normalize(full)).toContain(normalize(row.description))
        }
        expect(short).not.toContain("\nEnvironment\n")
        for (const variable of ENVIRONMENT)
          expect(full.split("\n").filter((line) => line.match(/^ {2}(\S+)/)?.[1] === variable.name)).toHaveLength(0)
      }
    }
  })

  test("top level has one column and one Start here, with every environment variable once", () => {
    for (const width of [60, 80, 100, 160]) {
      const screen = renderTopLevel(styleAt(width))
      for (const group of GROUPS) expect(screen.split(`\n${group}\n`)).toHaveLength(2)
      const commands = screen.slice(screen.indexOf("\nStart here\n"), screen.indexOf("\nGlobal flags\n"))
      const words = commands.split("\n").flatMap((line) => line.match(/^ {2}(\S+)/)?.[1] ?? [])
      expect(words.sort()).toEqual(
        Object.entries(HELP)
          .map(([word, topic]) => topic.display ?? word)
          .sort(),
      )
      for (const variable of ENVIRONMENT) {
        expect(screen.split("\n").filter((line) => line.match(/^ {2}(\S+)/)?.[1] === variable.name)).toHaveLength(1)
      }
    }
  })

  test("usage and rows wrap without creating fake row starts or breaking copyable tokens", () => {
    for (const width of [60, 80, 100]) {
      for (const [word, topic] of Object.entries(HELP)) {
        const screen = renderTopic(word, styleAt(width), true) ?? ""
        for (const line of screen.split("\n")) {
          // Single tokens (addresses, flags or placeholders) are never cut to force a fit.
          if (displayWidth(line) > width) expect(line.trim().split(/\s+/)).toHaveLength(1)
        }
        for (const usage of topic.usage) expect(normalize(screen)).toContain(usage)
        const region = screen.slice(screen.indexOf("Usage:"), screen.indexOf("\nExamples\n"))
        const starts = region.split("\n").flatMap((line) => line.match(/^ {2}(\S+)/)?.[1] ?? [])
        const expected = [...topic.rows, ...(topic.flags ?? [])]
          .filter((row) => !row.invocation.startsWith(" "))
          .map((row) => row.invocation.split(" ")[0] ?? "")
        expect([word, starts]).toEqual([word, expected])
      }
    }
  })

  test("every topic intro and More line fit three lines at 40 and 60 columns on both help routes", async () => {
    for (const columns of [40, 60]) {
      for (const [word, topic] of Object.entries(HELP)) {
        const display = topic.display ?? word
        for (const argv of [
          ["help", display],
          [display, "--help"],
        ]) {
          const stdout = createCapture()
          const stderr = createCapture()
          expect(
            await run(argv, createTestDeps({ stdout, stderr, fetch: unusedFetch, columns: { stdout: columns } })),
          ).toBe(0)
          expect(stderr.text).toBe("")
          const intro = stdout.text.split("\n\n")[0]?.split("\n") ?? []
          expect(intro.length).toBeLessThanOrEqual(3)
          expect(normalize(intro.join(" "))).toContain(`candle help ${display} --more`)
        }
      }
    }
  })

  test("--more is reachable by both help routes with no config or network, including aliases", async () => {
    for (const word of ["perps", "keys", "vault", "wallet"]) {
      const texts: string[] = []
      for (const argv of [
        ["help", word, "--more"],
        [word, "--help", "--more"],
      ]) {
        const stdout = createCapture()
        const stderr = createCapture()
        const fail = () => {
          throw new Error("help must not read config or network")
        }
        expect(
          await run(
            argv,
            createTestDeps({
              stdout,
              stderr,
              fetch: unusedFetch,
              readConfig: fail,
              writeConfig: fail,
              clearConfig: fail,
              updateProfile: fail,
            }),
          ),
        ).toBe(0)
        expect(stderr.text).toBe("")
        texts.push(stdout.text)
      }
      expect(texts[0]).toBe(texts[1])
      expect(texts[0]).toContain("\nRules\n")
    }
  })

  test("launch help retains the generated ranges, pool choices and dev-buy cap", () => {
    const full = normalize(renderTopic("launch", undefined, true) ?? "")
    for (const key of ["curve.virtualQuote", "curve.threshold", "poolOpen", "expPoolShape", "buy"]) {
      const field = LAUNCH_DEFINITION.fields.find((field) => field.key === key)
      expect(field).toBeDefined()
      if (!field) continue
      expect(full).toContain(field.help)
      if ("more" in field) expect(full).toContain(field.more)
    }
  })
})
