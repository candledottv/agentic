/**
 * The help DATA against what dispatch actually routes, and against what the source actually reads
 * (BE-238, spec 0.11.1, tests T1, T2, T3, T7, T8).
 *
 * The rendered screens are pinned in `index.test.ts` (T4 to T6, T14). The split is deliberate: a
 * test that reads `help.ts`'s data can check BOTH directions -- every routed word documented, and
 * every documented word routed -- while a test that parses the printed screen can only ever check
 * the direction the screen shows. The old drift test parsed the screen, and its own comment
 * admitted the gap it could not close: "a command added to dispatch and documented nowhere passes
 * this test and still runs unguarded". These close it, and the rendered tests then make sure the
 * data actually reaches the screen.
 *
 * T8 is the same shape one level down, for environment variables, and exists because of the same
 * rot: `CANDLE_CONFIG_DIR` was read by the code, documented in the docs site, and absent from
 * `--help`, which is what stranded the operator in BE-235's item 4.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { documentedFlags, documentedSubcommands, ENV_NOT_IN_HELP, ENVIRONMENT, GROUPS, HELP, type Topic } from "./help"
import { ALIASES, NEVER_GUARDED, ROUTED_COMMANDS, ROUTED_SUBCOMMANDS, routesToCommand } from "./index"

const sorted = (words: readonly string[]) => [...words].sort()

describe("the help data stays in step with dispatch", () => {
  test("T1: every routed word has a topic, and every topic routes", () => {
    const documented = Object.keys(HELP).map((word) => ALIASES[word] ?? word)
    expect(sorted(documented)).toEqual(sorted([...ROUTED_COMMANDS]))

    // Both directions stated separately, because the equality above reads as one claim and is
    // two. A word in `HELP` that dispatch cannot reach is a screen documenting a command that
    // does not exist; a routed word with no topic is a command nothing documents.
    expect(Object.keys(HELP).filter((word) => !ROUTED_COMMANDS.has(word))).toEqual([])
    expect([...ROUTED_COMMANDS].filter((word) => !Object.hasOwn(HELP, word))).toEqual([])

    // A `display` is the friendlier spelling the top level prints. It is legitimate exactly when
    // dispatch accepts it as an alias of the word it belongs to, or the screen would name a word
    // nobody can type.
    for (const [canonical, topic] of Object.entries(HELP)) {
      if (topic.display === undefined) continue
      expect([topic.display, ALIASES[topic.display]]).toEqual([topic.display, canonical])
    }
    // And no alias points somewhere dispatch cannot reach.
    expect(Object.values(ALIASES).filter((target) => !ROUTED_COMMANDS.has(target))).toEqual([])

    // Every topic sits in one of the six groups the top level prints, or it is data that renders
    // nowhere at all.
    for (const [word, topic] of Object.entries(HELP)) {
      expect([word, GROUPS.includes(topic.group as (typeof GROUPS)[number])]).toEqual([word, true])
    }
  })

  test("T2: each topic's rows document exactly the subcommands that word routes", () => {
    const documented: Record<string, string[]> = {}
    for (const [word, topic] of Object.entries(HELP)) {
      const subcommands = documentedSubcommands(topic)
      if (subcommands.length > 0) documented[word] = subcommands
      // A row starting with a plain word that dispatch does not route is the failure mode that
      // matters most here: it reads as authoritative and sends someone to type a command that
      // cannot run.
      for (const subcommand of subcommands) {
        expect([`${word} ${subcommand}`, (ROUTED_SUBCOMMANDS[word] ?? []).includes(subcommand)]).toEqual([
          `${word} ${subcommand}`,
          true,
        ])
      }
      // A row documented twice would satisfy the membership check above and still be wrong.
      expect([word, new Set(subcommands).size]).toEqual([word, subcommands.length])
    }
    const asSets = (map: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(map).map(([word, subs]) => [word, sorted(subs)]))
    expect(asSets(documented)).toEqual(asSets(ROUTED_SUBCOMMANDS))
    expect(Object.keys(ROUTED_SUBCOMMANDS).filter((word) => !ROUTED_COMMANDS.has(word))).toEqual([])
  })

  test("T3: the guarded set stays in step, and help and completion are never guarded", () => {
    // A typo here would silently guard a command the ruling exempts, or exempt nothing at all.
    expect([...NEVER_GUARDED].filter((word) => !ROUTED_COMMANDS.has(word))).toEqual([])
    // `update` replaces this binary and acts as no identity, so it must keep working on a machine
    // whose stored key belongs to another account -- that is precisely when an upgrade is wanted.
    // `help` and `completion` are the same argument (D1/D7): they read nothing and ask nothing,
    // and they are how an operator with no working identity finds out what to do about it.
    for (const word of ["update", "help", "completion"]) {
      expect([word, NEVER_GUARDED.has(word)]).toEqual([word, true])
    }
  })

  test("T7: every example on every topic names a command that actually routes", () => {
    for (const [word, topic] of Object.entries(HELP)) {
      expect([word, topic.examples.length > 0]).toEqual([word, true])
      for (const example of topic.examples) {
        // `CANDLE_CONFIG_DIR=$HOME/t47 candle vault status` is a complete command line and a
        // legitimate example; the leading assignments are not part of the command path. A
        // trailing `# ...` comment is not either.
        const tokens = example.split("#")[0]?.trim().split(/\s+/) ?? []
        while (tokens[0] !== undefined && /^[A-Z][A-Z0-9_]*=/.test(tokens[0])) tokens.shift()
        expect([example, tokens[0]]).toEqual([example, "candle"])
        const typed = tokens[1]
        const cmd = typed === undefined ? undefined : (ALIASES[typed] ?? typed)
        expect([example, routesToCommand(cmd, tokens[2])]).toEqual([example, true])
      }
    }
  })
})

/**
 * T8. Every `CANDLE_*` name the shipping source reads is on the help screen or recorded as
 * deliberately absent, with its reason.
 *
 * A dotted scan alone is not enough, and that is the whole point of the pattern below: the two
 * helper variables BE-235's item 4 turned on are not read as `env.CANDLE_FIDO2_HELPER` but as
 * `deps.env[HELPER_ENV]`, where `HELPER_ENV` is the quoted literal `"CANDLE_FIDO2_HELPER"`. The
 * same shape is `ENCLAVE_HELPER_ENV`, `RPC_URL_ENV` and `ALLOW_INSECURE_HTTP_ENV`. A dotted-only
 * scan would let `CANDLE_FIDO2_HELPER` fall off the help screen and say nothing.
 */
const ENV_PATTERN = /(?:deps\.)?env\.(CANDLE_[A-Z0-9_]+)|["'](CANDLE_[A-Z0-9_]+)["']/g

/** Every shipping `.ts` under `src`, tests excluded: a name only a test mentions is not one the
 * binary reads. */
function shippingSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...shippingSources(path))
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(path)
  }
  return out
}

function namesReadBySource(): Map<string, string> {
  const found = new Map<string, string>()
  for (const path of shippingSources(import.meta.dir)) {
    const source = readFileSync(path, "utf8")
    for (const match of source.matchAll(ENV_PATTERN)) {
      const name = match[1] ?? match[2]
      if (name !== undefined && !found.has(name)) found.set(name, path)
    }
  }
  return found
}

/** The names a given `ENVIRONMENT` list fails to account for. Taking the list as an argument is
 * what lets the test below prove the scan can actually fail. */
function undocumented(found: Map<string, string>, documented: readonly string[]): string[] {
  return [...found.keys()].filter((name) => !documented.includes(name) && !Object.hasOwn(ENV_NOT_IN_HELP, name))
}

describe("the ENVIRONMENT section stays in step with the source", () => {
  test("T8: every CANDLE_* name the binary reads is on the help screen or recorded as absent", () => {
    const found = namesReadBySource()
    // A scan that found nothing would pass every assertion below without checking anything.
    expect(found.size).toBeGreaterThan(10)
    expect(found.has("CANDLE_FIDO2_HELPER")).toBe(true)
    expect(found.has("CANDLE_ENCLAVE_HELPER")).toBe(true)

    const names = ENVIRONMENT.map((entry) => entry.name)
    expect(undocumented(found, names)).toEqual([])

    // The scan can fail. Dropping the variable that BE-235's item 4 turned on must be caught, and
    // under a dotted-only scan it would not have been.
    const withoutFido2 = names.filter((name) => name !== "CANDLE_FIDO2_HELPER")
    expect(undocumented(found, withoutFido2)).toEqual(["CANDLE_FIDO2_HELPER"])

    // No name is claimed twice, which would make one of the two descriptions dead text.
    expect(names.filter((name) => Object.hasOwn(ENV_NOT_IN_HELP, name))).toEqual([])
    expect(new Set(names).size).toBe(names.length)
    // Every recorded omission carries its reason; an empty one is an omission nobody decided.
    for (const [name, reason] of Object.entries(ENV_NOT_IN_HELP)) {
      expect([name, reason.length > 0]).toEqual([name, true])
    }
  })

  test("T8: every name a topic lists is described once, in ENVIRONMENT", () => {
    const names = ENVIRONMENT.map((entry) => entry.name)
    for (const [word, topic] of Object.entries(HELP) as [string, Topic][]) {
      for (const name of topic.env ?? []) {
        // Looked up rather than repeated (D2), so a description is written once and two screens
        // cannot come to disagree about what a variable does.
        expect([`${word}:${name}`, names.includes(name)]).toEqual([`${word}:${name}`, true])
      }
      expect([word, new Set(topic.env ?? []).size]).toEqual([word, (topic.env ?? []).length])
    }
  })
})

describe("the flags a completion can offer", () => {
  test("a documented flag is spelled as a flag, and -k only where --keystore is documented", () => {
    for (const [word, topic] of Object.entries(HELP)) {
      for (const flag of documentedFlags(topic)) {
        expect([`${word}:${flag}`, /^--?[a-z][a-z-]*$/.test(flag)]).toEqual([`${word}:${flag}`, true])
      }
      // `-k` is the short form of `--keystore` and of nothing else (D5). A topic offering `-k`
      // without documenting `--keystore` would complete a flag that command does not take.
      const flags = documentedFlags(topic)
      if (flags.includes("-k")) expect([word, flags.includes("--keystore")]).toEqual([word, true])
    }
  })
})

/**
 * BE-355 (section 8, T18): `profile set` is routed and documented both ways, the env row names the
 * profile and the public endpoint, the restore row says the scan needs `--rpc-url`, and the rows
 * whose `--rpc-url` became optional say so.
 */
describe("BE-355 T18: the help rows", () => {
  test("profile set is routed and documented, with its example", () => {
    expect(ROUTED_SUBCOMMANDS.profile).toContain("set")
    const row = HELP.profile?.rows.find((r) => r.invocation.startsWith("set "))
    expect(row?.invocation).toBe("set <name> --rpc-url <url> | --clear-rpc-url")
    expect(row?.description).toContain("config.json")
    expect(row?.description).toContain("only its host is ever shown")
    expect(HELP.profile?.examples).toContain("candle profile set work --rpc-url https://<your-rpc>")
    expect(HELP.profile?.rows.find((r) => r.invocation === "list")?.description).toContain("Solana RPC host")
  })

  test("the env row, the restore row, and the rows whose --rpc-url became optional", () => {
    const env = ENVIRONMENT.find((entry) => entry.name === "CANDLE_SOLANA_RPC_URL")
    expect(env?.description).toBe(
      "Solana RPC endpoint, when --rpc-url is not given. Beats the profile's (candle profile set <name> --rpc-url); the public endpoint when none is set",
    )
    const restore = HELP.vault?.rows.find((r) => r.invocation.startsWith("restore "))
    expect(restore?.description).toContain(
      "A gap scan needs --rpc-url on this command; no default or stored endpoint is used for it",
    )
    for (const [word, prefix] of [
      ["vault", "transfer "],
      ["vault", "promote "],
      ["vault", "promote-batch "],
      ["vault", "fund "],
      ["vault", "demote "],
      ["tee", "sweep "],
      ["external", "sweep "],
    ] as const) {
      const row = HELP[word]?.rows.find((r) => r.invocation.startsWith(prefix))
      expect([word, prefix, row?.invocation.includes("[--rpc-url <url>]")]).toEqual([word, prefix, true])
      expect([word, prefix, row?.invocation.includes(" --rpc-url <url>")]).toEqual([word, prefix, false])
    }
    expect(HELP.portfolio?.flags?.find((f) => f.invocation === "--rpc-url <url>")?.description).toContain(
      "then the profile's, then the public endpoint",
    )
    // No example still pastes the public endpoint as if it had to be typed.
    for (const [word, topic] of Object.entries(HELP)) {
      for (const example of topic.examples) {
        expect([word, example, example.includes("api.mainnet-beta.solana.com")]).toEqual([word, example, false])
      }
    }
  })
})
