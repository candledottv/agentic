/**
 * `candle-fido2`: the security key helper's entry (Ember Phase 2, BE-140, ED-11).
 *
 * Compiled by the release job into one executable per target beside the four `candle` binaries
 * (`bun build --compile --target=bun-<os>-<arch> src/fido2-helper/main.ts`), signed by the same
 * cosign step, and installed beside `candle`. The CLI spawns it with a pipe on stdin and stdout,
 * writes one JSON request line, and reads one JSON response line; this process does that one
 * operation and exits. It has no prompt and never reads a terminal: a PIN arrives only inside the
 * request the CLI piped in, and a stdin that is a terminal is refused before anything is read.
 *
 * `--version` is the one argv the helper answers, so an operator can check which helper is beside
 * their binary; everything else about an operation travels on stdin, never on argv.
 */
import { CLI_VERSION } from "../version"
import { serveOnce } from "./io"
import { openLibfido2 } from "./libfido2"
import { HELPER_PROTOCOL } from "./protocol"

if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(`candle-fido2 ${CLI_VERSION} (protocol ${HELPER_PROTOCOL})\n`)
  process.exit(0)
}

const code = await serveOnce(
  {
    stdin: process.stdin,
    stdout: { write: (chunk) => process.stdout.write(chunk) },
    stdinIsTTY: Boolean(process.stdin.isTTY),
  },
  () => openLibfido2(),
)
process.exit(code)
