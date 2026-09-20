/**
 * `candle help` and `candle help <command>` (BE-238, spec 0.11.1 D1).
 *
 * A routed command word rather than an alias for `--help`, so `candle help vault --json` parses
 * like any other invocation. It is dispatched before `migrateProfiles` / `resolveProfileName`
 * (`index.ts`), which is the whole point: help is how the operator stranded by BE-235's item 4
 * discovers `CANDLE_CONFIG_DIR`, so it has to answer on a machine with several profiles and none
 * selected, exactly the way `candle --help` already does. It reads no config and makes no request.
 *
 * `candle help bogus` is the same routing failure as `candle bogus`: the token named on stderr,
 * the top level after it, exit 1.
 */
import type { CommandContext } from "../deps"
import { renderTopic, renderTopLevel } from "../help"

export async function help(args: string[], ctx: CommandContext): Promise<number> {
  const word = args[0]
  if (word === undefined) {
    ctx.deps.stdout.write(renderTopLevel())
    return 0
  }
  const topic = renderTopic(word)
  if (topic === undefined) {
    ctx.deps.stderr.write(`Unknown command: ${word}\n`)
    ctx.deps.stderr.write(renderTopLevel())
    return 1
  }
  ctx.deps.stdout.write(topic)
  return 0
}
