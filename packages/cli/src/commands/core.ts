/**
 * `candle core serve` (BE-1665, spec 2026-10-19-candle-tui-s1-core-design.md, C-1 to C-4): the
 * local core, one process per profile, the only thing on this machine that holds the profile's
 * trading credentials once trading is on in the Candle TUI.
 *
 * The process and its state: the 0700 state directory, the single-instance lock
 * (`CORE_ALREADY_RUNNING`), the append-only journal with its redactor, completing a slot move a
 * crash interrupted, and the attach interface (`core/server.ts`, spec A) on `core.sock`. Cards,
 * reconciliation and the harness face arrive in the PRs stacked on this one.
 *
 * `--view-token-fd <n>` (A-2): the launcher (`candle tui`) passes an inherited descriptor; the core
 * writes this start's view token to it once and closes it. The token is never written to disk, so
 * a core started without that descriptor, by a harness for instance, has no view anyone can attach
 * as, and refuses every card with `NO_VIEW_ATTACHED` (C-3, K-11).
 * A-2 residual risk: the descriptor's caller is not authenticated. Any same-user process can
 * start the core with its own pipe, receive the token and attach as a view. `NO_VIEW_ATTACHED`
 * without the TUI therefore holds only by convention. That process can register harnesses and
 * disrupt view state, but approval and opening a timed window still require the vault factor.
 *
 * Lifetime (C-3): the core exits on SIGINT or SIGTERM, and when the last attached view detaches.
 *
 * This is the ONE file allowed to import `core/slot.ts`, the core-only credential loader (K-11).
 * It must not re-export anything from it; `core-slot-imports.test.ts` checks both.
 */
import { closeSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "../args"
import { acquireInstanceLock, CoreAlreadyRunningError } from "../core/instance-lock"
import { Journal, JournalIdentityError } from "../core/journal"
import { corePaths, ensureCoreDir } from "../core/paths"
import { Redactor } from "../core/redact"
import { CoreServer, CoreSocketError } from "../core/server"
import { finishCoreMove } from "../core/slot"
import { TokenBook } from "../core/tokens"
import type { CommandContext } from "../deps"
import { candleEnvironment, profileSecretRef } from "../profiles"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { CLI_VERSION } from "../version"

const USAGE = "Usage: candle core serve [--view-token-fd <n>]"

export async function coreServe(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--view-token-fd"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\n${USAGE}`, json)
    return 2
  }
  const fdFlag = parsed.values["--view-token-fd"]
  const viewTokenFd = fdFlag === undefined ? undefined : Number(fdFlag)
  if (viewTokenFd !== undefined && (!Number.isInteger(viewTokenFd) || viewTokenFd < 3)) {
    writeUsageFailure(deps, `--view-token-fd takes a descriptor number of 3 or more, not ${fdFlag}\n${USAGE}`, json)
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
  let server: CoreServer | undefined
  let stopReason = "start_failed"
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
    const tokens = await TokenBook.open(paths.tokens, deps.now)
    redactor.add(tokens.viewToken)
    server = new CoreServer({
      socketPath: paths.socket,
      layoutPath: join(paths.dir, "config.json"),
      profile,
      environment,
      coreVersion: CLI_VERSION,
      journal,
      redactor,
      tokens,
      now: deps.now,
    })
    try {
      await server.listen()
    } catch (error) {
      if (!(error instanceof CoreSocketError)) throw error
      writeLocalFailure(deps, { code: error.code, message: error.message }, json)
      return 1
    }
    if (viewTokenFd !== undefined) {
      try {
        writeSync(viewTokenFd, `${tokens.viewToken}\n`)
        closeSync(viewTokenFd)
      } catch {
        writeLocalFailure(
          deps,
          { code: "CORE_VIEW_TOKEN_FD", message: `Could not write the view token to descriptor ${viewTokenFd}.` },
          json,
        )
        return 1
      }
    }
    const started = await journal.append({
      type: "core.started",
      coreVersion: CLI_VERSION,
      pid: process.pid,
      viewTokenHandedOff: viewTokenFd !== undefined,
    })

    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ ok: true, profile, environment, stateDir: paths.dir, socket: paths.socket, journalSeq: started.seq })}\n`,
      )
    } else {
      deps.stdout.write(
        `Candle core (preview) for profile ${profile} on ${environment === "production" ? "PRODUCTION: real funds" : "staging"}\nState: ${paths.dir}\nSocket: ${paths.socket}\n`,
      )
    }

    // Runs until SIGINT or SIGTERM, or until the last view that attached detaches (C-3). Without a
    // terminate seam (a test that omits it) only the second ends it.
    const running = server
    await new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | undefined
      let done = false
      const finish = (reason: string) => {
        if (done) return
        done = true
        stopReason = reason
        unsubscribe?.()
        resolve()
      }
      running.onViewCount((count) => {
        if (count === 0 && running.hadView()) finish("last_view_detached")
      })
      unsubscribe = deps.onTerminate?.(() => finish("terminated"))
      if (done) unsubscribe?.()
    })
    return 0
  } finally {
    await server?.close()
    if (journal) {
      await journal.append({ type: "core.stopped", reason: stopReason }).catch(() => {})
      await journal.close()
    }
    await lock.release()
  }
}
