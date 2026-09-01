/**
 * The update-available notice, on the update-notifier model npm made familiar: learn about the
 * newer version for free, tell the user at most once a day, name the exact command, never block
 * or slow the command that discovered it.
 *
 * "For free" is the header ride-along: the API stamps x-candle-cli-latest on every response
 * (apps/api/src/lib/client-versions.ts), apiRequest notes it in module state as responses
 * arrive, and `run` prints at exit from what was noted. No registry call, no background
 * process, no startup cost -- a command that never touched the API simply prints nothing.
 *
 * The notice goes to STDERR always, --json included: agents drive the CLI in --json mode, the
 * user wants agents told too, and stdout stays byte-clean for parsers either way. Opt out with
 * CANDLE_NO_UPDATE_NOTIFIER=1. `update` and `doctor` never notice-nag: both already answer the
 * question as their whole job.
 */
import { __resetLatestCliVersionForTest, latestCliVersionFromApi } from "./client"
import type { Deps } from "./deps"
import { compareVersions, isPlainVersion } from "./release"
import { CLI_VERSION } from "./version"

export function __resetUpdateNoticeForTest(): void {
  __resetLatestCliVersionForTest()
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Print the one-line notice if a newer version was seen this invocation and the same version
 * has not been shown in the last day. Every failure path is silent: the notice is a courtesy,
 * and a courtesy that can break a command is worse than none.
 */
export async function maybeWriteUpdateNotice(deps: Deps, opts: { command?: string } = {}): Promise<void> {
  try {
    if (deps.env.CANDLE_NO_UPDATE_NOTIFIER) return
    if (opts.command === "update" || opts.command === "doctor") return
    const latest = latestCliVersionFromApi()
    if (!latest || !isPlainVersion(latest) || compareVersions(latest, CLI_VERSION) <= 0) return

    const config = await deps.readConfig()
    const prior = config.updateNotice
    if (prior && prior.version === latest && deps.now() - prior.shownAt < DAY_MS) return

    // Dim on a TTY, plain everywhere else; one line, the exact command, nothing to dismiss.
    const line = `Update available: candle ${CLI_VERSION} -> ${latest}. Run: candle update`
    const tty = process.stderr.isTTY === true
    deps.stderr.write(tty ? `\x1b[2m${line}\x1b[0m\n` : `${line}\n`)
    await deps.writeConfig({ updateNotice: { version: latest, shownAt: deps.now() } })
  } catch {
    // Deliberately swallowed: see the doc comment.
  }
}
