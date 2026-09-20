/**
 * `candle completion zsh|bash|fish` (BE-238, spec 0.11.1 D7, test T15).
 *
 * Two things are being protected. First, that the scripts are COMPLETE against dispatch: because
 * they are generated from `help.ts`, and `help.ts` is pinned to dispatch by the drift tests, a
 * missing word here means one of the three is silently dropping data it was handed. Second, that
 * they PARSE: a completion script is sourced by an interactive shell at startup, so a syntax
 * error in one is not a broken completion, it is a broken shell prompt.
 *
 * `zsh -n` and `bash -n` parse without executing, which is exactly the check worth running in CI.
 * Fish is not on the runner and is not assumed; that test reports itself skipped by name rather
 * than passing silently, so "fish was checked" is never inferred from a green suite.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMPLETION_SHELLS, documentedSubcommands, GLOBAL_FLAGS, HELP } from "../help"
import { ROUTED_COMMANDS, ROUTED_SUBCOMMANDS, run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const unusedFetch = (() => {
  throw new Error("completion must make no request")
}) as unknown as typeof fetch

async function script(shell: string): Promise<string> {
  const stdout = createCapture()
  const stderr = createCapture()
  const code = await run(["completion", shell], createTestDeps({ fetch: unusedFetch, stdout, stderr }))
  expect([shell, code, stderr.text]).toEqual([shell, 0, ""])
  return stdout.text
}

/**
 * Whether `text` offers `flag`, in that shell's own spelling. zsh and bash carry a flag verbatim;
 * fish declares it as `-l <long>` / `-s <short>`, with the dashes stripped. Asserting the literal
 * `--profile` against all three would force a fish script fish does not accept, which is the
 * opposite of what these tests are for.
 */
function namesFlag(text: string, shell: string, flag: string): boolean {
  // A whole token, never a substring: `-k` must not match inside `--keystore`, which the
  // surrounding `[\w-]` guards rule out on both sides.
  if (shell !== "fish") return new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text)
  const [option, name] = flag.startsWith("--") ? ["-l", flag.slice(2)] : ["-s", flag.slice(1)]
  return text.includes(`${option} '${name}'`)
}

/** Whether `shell` is on PATH, so a missing one is reported rather than silently passing. */
function shellOnPath(shell: string): boolean {
  return spawnSync("which", [shell], { encoding: "utf8" }).status === 0
}

describe("T15: the completion scripts", () => {
  test("each script names every routed word, every routed subcommand, every global flag and -k", async () => {
    for (const shell of COMPLETION_SHELLS) {
      const text = await script(shell)
      const label = (what: string) => `${shell}: ${what}`

      for (const word of ROUTED_COMMANDS) {
        expect([label(word), new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text)]).toEqual([label(word), true])
      }
      // The friendlier spelling the top level prints has to be completable too, or the completion
      // offers a word the help never shows.
      for (const topic of Object.values(HELP)) {
        if (topic.display === undefined) continue
        expect([label(topic.display), text.includes(topic.display)]).toEqual([label(topic.display), true])
      }
      for (const [word, subcommands] of Object.entries(ROUTED_SUBCOMMANDS)) {
        for (const subcommand of subcommands) {
          expect([label(`${word} ${subcommand}`), text.includes(subcommand)]).toEqual([
            label(`${word} ${subcommand}`),
            true,
          ])
        }
      }
      for (const row of GLOBAL_FLAGS) {
        for (const token of row.invocation.split(/[\s,]+/)) {
          if (!token.startsWith("--")) continue
          expect([label(token), namesFlag(text, shell, token)]).toEqual([label(token), true])
        }
      }
      // `-k` is what D5 adds to every keystore-taking command. The scripts carry it from this
      // release even though the parser accepts it in the next: nothing is published between the
      // two, and the completion data is the thing PR 2 builds on.
      expect([label("-k"), namesFlag(text, shell, "-k")]).toEqual([label("-k"), true])
      expect([label("--keystore"), namesFlag(text, shell, "--keystore")]).toEqual([label("--keystore"), true])
    }
  })

  test("the scripts are generated from the help data, so they offer no word that does not route", async () => {
    // The zsh and bash scripts both branch on the command word. Every branch label must be a word
    // dispatch accepts, or tab-completion would offer a command that cannot run.
    const accepted = new Set<string>()
    for (const [word, topic] of Object.entries(HELP)) {
      accepted.add(word)
      if (topic.display) accepted.add(topic.display)
    }
    for (const shell of ["zsh", "bash"] as const) {
      const text = await script(shell)
      const labels = [...text.matchAll(/^ {4}([a-z][a-z-]*)\)$/gm)].map((match) => match[1] as string)
      expect([shell, labels.length]).toEqual([shell, accepted.size])
      expect(labels.filter((label) => !accepted.has(label))).toEqual([])
    }

    // And the subcommand list each branch offers is that topic's documented rows, nothing more.
    const vault = HELP.vault
    expect(vault).toBeDefined()
    const zsh = await script("zsh")
    for (const subcommand of documentedSubcommands(vault as NonNullable<typeof vault>)) {
      expect([subcommand, zsh.includes(subcommand)]).toEqual([subcommand, true])
    }
  })

  test.each(["zsh", "bash"])("%s accepts its own script", async (shell) => {
    if (!shellOnPath(shell)) {
      // Reported by name rather than passing quietly: a green suite must not be read as "the
      // script parses" on a machine where the shell that would say so is absent.
      console.warn(`SKIPPED: ${shell} is not on PATH, so ${shell} -n did not run against the generated script`)
      return
    }
    const dir = mkdtempSync(join(tmpdir(), `candle-completion-${shell}-`))
    try {
      const path = join(dir, `candle.${shell}`)
      writeFileSync(path, await script(shell))
      const parsed = spawnSync(shell, ["-n", path], { encoding: "utf8" })
      expect([shell, parsed.status, parsed.stderr]).toEqual([shell, 0, ""])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fish is not syntax-checked here, and says so", () => {
    // fish is not on the CI runner and this suite does not assume it. The script is still
    // generated and still checked for completeness above; what is NOT checked anywhere is whether
    // fish itself parses it. Recorded as a test so the gap is visible in the output.
    console.warn("NOT CHECKED: fish syntax. `fish -n` is not run; no fish on the CI runner (spec section 4).")
    expect(COMPLETION_SHELLS).toContain("fish")
  })
})

describe("T15: the completion refusals", () => {
  test("no shell, and an unknown shell, are usage errors naming the three", async () => {
    for (const argv of [["completion"], ["completion", "powershell"]]) {
      const stdout = createCapture()
      const stderr = createCapture()
      expect([argv.join(" "), await run(argv, createTestDeps({ fetch: unusedFetch, stdout, stderr }))]).toEqual([
        argv.join(" "),
        2,
      ])
      expect(stderr.text).toContain("zsh|bash|fish")
      expect(stdout.text).toBe("")
    }
    // The unknown one names what was typed, so the operator can see the typo rather than guess.
    const stderr = createCapture()
    await run(["completion", "powershell"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(stderr.text).toContain("powershell")
  })

  test("--json is a usage error: the script is the payload and has no JSON form", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    expect(await run(["completion", "zsh", "--json"], createTestDeps({ fetch: unusedFetch, stdout, stderr }))).toBe(2)
    // The envelope goes to stdout like every other --json failure, and carries USAGE.
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
    expect(stderr.text).toBe("")
    // Not TTY-only: the plain form still writes the script to a pipe, which is how it is installed.
    expect((await script("zsh")).length).toBeGreaterThan(0)
  })

  test("completion answers with no profile selected, reading and writing no config", async () => {
    // The several-profiles fixture: any routed word that reached profile resolution would be
    // PROFILE_UNRESOLVED here. `completion` is dispatched before it (D7).
    const writes: string[] = []
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch: unusedFetch, stdout, stderr })
    const code = await run(["completion", "bash"], {
      ...deps,
      readConfig: async () => ({ profiles: { staging: {}, production: {} } }),
      writeConfig: async () => {
        writes.push("writeConfig")
      },
    })
    expect(code).toBe(0)
    expect(stdout.text).toContain("_candle")
    expect(stderr.text).toBe("")
    // `migrateProfiles` WRITES config on a pre-profiles install. Help and completion must not.
    expect(writes).toEqual([])
  })
})
