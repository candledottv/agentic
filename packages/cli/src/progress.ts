/**
 * Staged progress for long-running commands, on the pattern rustup and bun made standard: one
 * line per stage, a spinner while a stage runs, a checkmark when it lands.
 *
 * Exists because `candle update` was silent from the moment it started downloading to the
 * moment it printed the result -- several seconds of a multi-megabyte download during which the
 * command looked dead, which is exactly the window where someone reaches for Ctrl+C.
 *
 * Everything writes to STDERR: progress is commentary, and stdout stays owned by the command's
 * actual output (--json above all). Two renderings, chosen by `tty`:
 *
 *   - a real terminal gets a braille spinner redrawn in place, then `\r`-overwritten by the
 *     stage's final line, so the whole run reads as a clean checklist;
 *   - everything else (CI, agents, pipes) gets the stage line once at start and once at
 *     completion, because a redrawn line in a log file is garbage bytes.
 *
 * No dependency taken: ora and friends are fine libraries, but this is 40 lines and the CLI's
 * dependency budget is deliberately tight (see release-verify's provenance story).
 */
import type { CommandContext } from "./deps"
import { terminalStyle } from "./presentation"

export interface StepReporter {
  /** Begin a stage: spinner on a TTY, a plain `label...` line otherwise. */
  start(label: string): void
  /** Land the running stage with a checkmark and (possibly amended) label. */
  done(label: string): void
  /** Land the running stage as failed; the caller still reports the error itself. */
  fail(label: string): void
  /** Stop the spinner without a verdict (before an error path that prints its own report). */
  stop(): void
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const INTERVAL_MS = 80

export function stepReporter(write: (text: string) => void, tty: boolean, ascii = false): StepReporter {
  let detach = () => {}
  let timer: ReturnType<typeof setInterval> | null = null
  let frame = 0
  let current: string | null = null

  const clearSpinner = () => {
    detach()
    if (timer !== null) clearInterval(timer)
    timer = null
    if (tty && current !== null) write("\r\x1b[2K")
    current = null
  }

  return {
    start(label) {
      clearSpinner()
      current = label
      if (!tty) {
        write(`${label}...\n`)
        return
      }
      frame = 1
      // Remove our handler before forwarding the signal: cleanup must not turn Ctrl+C into
      // "keep downloading". If another owner handles the signal, leave its cancellation intact.
      const interrupt = (signal: NodeJS.Signals) => {
        clearSpinner()
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
      }
      const sigint = () => interrupt("SIGINT")
      const sigterm = () => interrupt("SIGTERM")
      process.once("SIGINT", sigint)
      process.once("SIGTERM", sigterm)
      detach = () => {
        process.off("SIGINT", sigint)
        process.off("SIGTERM", sigterm)
      }
      timer = setInterval(() => {
        write(`\r\x1b[2K${FRAMES[frame % FRAMES.length]} ${current}`)
        frame++
      }, INTERVAL_MS)
      // A spinner must never hold the process open past the work it decorates.
      if (typeof timer === "object" && "unref" in timer) timer.unref()
      // Install cancellation and timer cleanup before the first visible frame: a terminal
      // can deliver Ctrl+C as soon as it sees that frame.
      write(`${FRAMES[0]} ${label}`)
    },
    done(label) {
      clearSpinner()
      write(`${ascii ? "OK" : "✓"} ${label}\n`)
    },
    fail(label) {
      clearSpinner()
      write(`${ascii ? "FAIL" : "✗"} ${label}\n`)
    },
    stop: clearSpinner,
  }
}

/** Scope-bound cleanup covers every return and thrown failure in the two progress commands. */
export function commandSteps(ctx: CommandContext): StepReporter & Disposable {
  const style = terminalStyle(ctx.deps, "stderr", ctx.json)
  const reporter = stepReporter(
    ctx.json ? () => {} : (text) => ctx.deps.stderr.write(text),
    style.motion,
    !style.styled,
  )
  // Match Bun's `using` transform on older Node 18 releases without Symbol.dispose.
  return { ...reporter, [Symbol.dispose ?? Symbol.for("Symbol.dispose")]: () => reporter.stop() } as StepReporter &
    Disposable
}

/** "12.4 MB" from a byte count; whole kilobytes below a megabyte. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
