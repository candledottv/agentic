/**
 * `candle core serve` (BE-1665, spec 2026-10-19-candle-tui-s1-core-design.md, C-1 to C-4): the
 * local core, one process per profile, the only thing on this machine that holds the profile's
 * trading credentials once trading is on in the Candle TUI.
 *
 * This slice is the process and its state: the 0700 state directory, the single-instance lock
 * (`CORE_ALREADY_RUNNING`), the append-only journal with its redactor, and completing a slot move
 * a crash interrupted. The attach interface, cards, reconciliation and the harness face arrive in
 * the PRs stacked on this one; until then the core accepts no connections and is a preview.
 *
 * This is the ONE file allowed to import `core/slot.ts`, the core-only credential loader (K-11).
 * It must not re-export anything from it; `core-slot-imports.test.ts` checks both.
 */
import { parseArgs } from "../args"
import { acquireInstanceLock, CoreAlreadyRunningError } from "../core/instance-lock"
import { Journal, JournalIdentityError } from "../core/journal"
import { corePaths, ensureCoreDir } from "../core/paths"
import { Redactor } from "../core/redact"
import { finishCoreMove } from "../core/slot"
import type { CommandContext } from "../deps"
import { candleEnvironment, profileSecretRef } from "../profiles"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { CLI_VERSION } from "../version"

const USAGE = "Usage: candle core serve"

export async function coreServe(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\n${USAGE}`, json)
    return 2
  }
  const profile = ctx.profile
  if (profile === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "CORE_PROFILE_REQUIRED",
        message: "The Candle core runs for one profile, and none is in play.",
        suggestion: "Sign in with candle auth login, or name one with --profile.",
      },
      json,
    )
    return 1
  }
  // C-2: the core is bound to one environment for its life, shown on every screen and stored on
  // every journal row. A host that is neither is refused rather than labelled with a guess.
  const environment = candleEnvironment(ctx.apiUrl)
  if (environment === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "CORE_ENVIRONMENT_UNKNOWN",
        message: `The Candle core runs against staging or production, and ${ctx.apiUrl} is neither.`,
        suggestion: "Use a profile whose API URL is https://staging.api.candle.tv or https://api.candle.tv.",
      },
      json,
    )
    return 1
  }

  const paths = corePaths(deps.env, deps.homedir(), profile)
  await ensureCoreDir(paths)
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>>
  try {
    lock = await acquireInstanceLock({ lockPath: paths.lock, socketPath: paths.socket, now: deps.now })
  } catch (error) {
    if (!(error instanceof CoreAlreadyRunningError)) throw error
    writeLocalFailure(
      deps,
      {
        code: error.code,
        message: error.message,
        details: { socketPath: error.socketPath, ...(error.pid !== undefined ? { pid: error.pid } : {}) },
      },
      json,
    )
    return 1
  }

  let journal: Journal | undefined
  try {
    const redactor = new Redactor()
    // C-4: the Read key is loaded at start and used for every read. Registered with the redactor
    // first, so no row this core writes can carry it.
    redactor.add(await deps.store.get(profileSecretRef(profile, "apiKey")))
    try {
      journal = await Journal.open({ path: paths.journal, redactor, environment, profile, now: deps.now })
    } catch (error) {
      if (!(error instanceof JournalIdentityError)) throw error
      writeLocalFailure(deps, { code: error.code, message: error.message }, json)
      return 1
    }
    const removed = await finishCoreMove({ deps, paths, profile })
    if (removed.length > 0) await journal.append({ type: "slot.move_finished", refs: removed })
    const started = await journal.append({ type: "core.started", coreVersion: CLI_VERSION, pid: process.pid })

    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ ok: true, profile, environment, stateDir: paths.dir, socket: paths.socket, journalSeq: started.seq })}\n`,
      )
    } else {
      deps.stdout.write(
        `Candle core (preview) for profile ${profile} on ${environment === "production" ? "PRODUCTION: real funds" : "staging"}\nState: ${paths.dir}\nThe attach interface is not in this build yet; the core accepts no connections.\n`,
      )
    }

    // Runs until SIGINT or SIGTERM. Without a terminate seam (a test that omits it) it returns at once.
    await new Promise<void>((resolve) => {
      if (!deps.onTerminate) return resolve()
      let unsubscribe: (() => void) | undefined
      let done = false
      unsubscribe = deps.onTerminate(() => {
        done = true
        unsubscribe?.()
        resolve()
      })
      if (done) unsubscribe()
    })
    await journal.append({ type: "core.stopped" })
    return 0
  } finally {
    await journal?.close()
    await lock.release()
  }
}
