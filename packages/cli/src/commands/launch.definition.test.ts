import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { HELP } from "../help"
import { LAUNCH_CLI_CONTROLS, LAUNCH_IMAGE_FLAG, launchFlagFields } from "../launch-options"
import { LAUNCH_ARG_SPEC, USAGE } from "./launch"

const sorted = (values: Iterable<string>) => [...new Set(values)].sort()
describe("CLI launch definition conformance in both directions", () => {
  test("the actual parser accepts exactly the definition, image alternative and named controls", () => {
    const expected = sorted(
      [...launchFlagFields.map((field) => field.cli.flag), LAUNCH_IMAGE_FLAG, ...LAUNCH_CLI_CONTROLS].filter(
        (flag) => flag !== "--json",
      ),
    )
    expect(sorted([...(LAUNCH_ARG_SPEC.valueFlags ?? []), ...(LAUNCH_ARG_SPEC.booleanFlags ?? [])])).toEqual(expected)
    // Pin the parser's use of the audited spec: a second inline spec cannot bypass this check.
    const command = readFileSync(resolve(import.meta.dir, "launch.ts"), "utf8")
    expect(command.match(/parseArgs\(/g)).toHaveLength(1)
    expect(command).toMatch(/LAUNCH_ARG_SPEC,?\s*\)/)
    // Flags wired by handlers must match too. A new field needs an implementation, even when
    // the author regenerates the copy, and a handler-only fake flag cannot hide in the parser.
    const handlers = command + readFileSync(resolve(import.meta.dir, "pool-options.ts"), "utf8")
    const handled = sorted(
      [...handlers.matchAll(/flags\["(--[a-z-]+)"\]/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
    )
    const dataDriven = launchFlagFields
      .filter((field) => field.key.startsWith("socials."))
      .map((field) => field.cli.flag)
    // --dry-run, --yes and --check are boolean controls read through `parsed.booleans`, so they
    // have no `flags[...]` handler to find in the source.
    expect(sorted([...handled, ...dataDriven, "--dry-run", "--yes", "--check"])).toEqual(expected)
  })
  test("usage and help list every definition flag and its exact help sentence", () => {
    const topic = HELP.launch
    if (!topic) throw new Error("Missing launch help")
    for (const field of launchFlagFields) {
      expect(USAGE).toContain(field.cli.flag)
      expect(topic.usage.join("\n")).toContain(field.cli.flag)
      expect(topic.flags).toContainEqual({
        invocation: `${field.cli.flag}${"value" in field.cli ? ` ${field.cli.value}` : ""}`,
        description: field.help,
        ...("more" in field ? { more: field.more } : {}),
      })
    }
  })
})
