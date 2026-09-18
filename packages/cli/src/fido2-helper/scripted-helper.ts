/**
 * TEST ONLY (Ember Phase 2, BE-140): a `candle-fido2` that answers from a script instead of a key.
 *
 * The CLI's security-key tests spawn this file with `bun` the way the real CLI spawns the compiled
 * helper: a pipe on stdin, one request line, one response line on stdout. Everything above the
 * backend seam is the REAL code (`io.ts`'s loop, `protocol.ts`'s validation, selection, snapshot
 * check and feature detection); only the authenticator is replaced by the script named in argv[2]
 * (`test-backend.ts` describes its shape), so what the tests exercise is the shape the CLI actually
 * talks to, over a real subprocess.
 */
import { readFileSync } from "node:fs"
import { serveOnce } from "./io"
import { type HelperScript, scriptedBackend } from "./test-backend"

const scriptPath = process.argv[2]
if (!scriptPath) {
  process.stderr.write("usage: bun scripted-helper.ts <script.json>\n")
  process.exit(2)
}
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as HelperScript
const code = await serveOnce(
  {
    stdin: process.stdin,
    stdout: { write: (chunk) => process.stdout.write(chunk) },
    stdinIsTTY: Boolean(process.stdin.isTTY),
  },
  () => scriptedBackend(script),
)
process.exit(code)
