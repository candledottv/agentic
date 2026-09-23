/**
 * T13 (BE-241, D5): `candle vault enroll <kind>` IS `candle vault factor add <kind>`.
 *
 * Not a wrapper and not a second spelling of the behaviour: one entry in `vault`'s subcommand map
 * pointing at the same handler, so it inherits every flag, refusal and `--json` shape rather than
 * being kept in step with them. The test is therefore an equivalence test -- the two invocations
 * produce byte-identical output and the same exit code -- because that is the property that would
 * break if `enroll` ever grew a handler of its own.
 *
 * Kind abbreviations (`sk`, `pp`) were considered and rejected in D5: the kind words are the
 * vocabulary the typed codes and `vault status` use, and two spellings of one factor is how a docs
 * search misses half the answers.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { ROUTED_SUBCOMMANDS, run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function ran(argv: string[], vaultPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = createCapture()
  const stderr = createCapture()
  const deps: Deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: {},
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async (text: string) => {
      throw new Error(`nothing in this test should prompt: ${text}`)
    },
  })
  const code = await run([...argv, "--keystore", vaultPath], deps)
  return { code, stdout: stdout.text, stderr: stderr.text }
}

/** The same invocation, spelled both ways, against the same absent vault. */
async function bothWays(tail: string[]): Promise<[Awaited<ReturnType<typeof ran>>, Awaited<ReturnType<typeof ran>>]> {
  const path = join(await mkdtemp(join(tmpdir(), "candle-enroll-")), "vault.enc")
  return [await ran(["vault", "enroll", ...tail], path), await ran(["vault", "factor", "add", ...tail], path)]
}

describe("T13: vault enroll", () => {
  test("it is routed, so the drift test sees it beside every other subcommand", () => {
    expect(ROUTED_SUBCOMMANDS.vault).toContain("enroll")
    expect(ROUTED_SUBCOMMANDS.vault).toContain("factor")
  })

  test("enroll <kind> and factor add <kind> are the same invocation", async () => {
    for (const tail of [["security-key", "--label", "yubikey-a"], ["passkey"], ["touch-id"]]) {
      const [enroll, factorAdd] = await bothWays(tail)
      expect(enroll.code).toBe(factorAdd.code)
      expect(enroll.stdout).toBe(factorAdd.stdout)
      expect(enroll.stderr).toBe(factorAdd.stderr)
    }
  })

  test("--json behaves identically too", async () => {
    const [enroll, factorAdd] = await bothWays(["passphrase", "--json"])
    expect(enroll.code).toBe(factorAdd.code)
    expect(enroll.stdout).toBe(factorAdd.stdout)
    expect(enroll.stderr).toBe(factorAdd.stderr)
  })

  test("enroll with no kind prints factor add's own 'Which factor?' usage", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "candle-enroll-bare-")), "vault.enc")
    const out = await ran(["vault", "enroll"], path)
    expect(out.code).toBe(2)
    expect(out.stderr).toContain("Which factor?")
    expect(out.stderr).toContain("passphrase | security-key | touch-id | passkey")
  })

  test("an unknown kind is refused with factor add's own wording", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "candle-enroll-bogus-")), "vault.enc")
    const out = await ran(["vault", "enroll", "yubikey"], path)
    expect(out.code).toBe(2)
    expect(out.stderr).toContain("Unknown factor: yubikey")
  })
})
