/**
 * TEST ONLY (Ember Phase 2, BE-141): a `candle-enclave` that answers from a script and a file of
 * P-256 keys instead of a Secure Enclave.
 *
 * The CLI's Touch ID tests spawn this file with `bun` the way the real CLI spawns the executable
 * inside the signed `.app`: a pipe on stdin, one request line, one response line on stdout, the
 * process exits. The request loop is `candle-fido2`'s (`fido2-helper/io.ts`: one line, a terminal
 * refused, the request bytes zeroed), the validation is `protocol.ts`'s, and only the Enclave is a
 * script (`test-backend.ts`).
 */
import { readFileSync } from "node:fs"
import { MAX_REQUEST_BYTES, readFirstLine, TERMINAL_REFUSAL } from "../fido2-helper/io"
import { ENCLAVE_PROTOCOL, handleEnclaveLine } from "./protocol"
import { type EnclaveScript, scriptedEnclaveBackend } from "./test-backend"

const scriptPath = process.argv[2]
if (!scriptPath) {
  process.stderr.write("usage: bun scripted-helper.ts <script.json>\n")
  process.exit(2)
}
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as EnclaveScript

if (process.argv.slice(3).includes("--version")) {
  process.stdout.write(`candle-enclave ${script.version} (protocol ${ENCLAVE_PROTOCOL})\n`)
  process.exit(0)
}

const refuse = (message: string, code: number): never => {
  process.stdout.write(`${JSON.stringify({ ok: false, protocol: ENCLAVE_PROTOCOL, code: "BAD_REQUEST", message })}\n`)
  process.exit(code)
}
if (process.stdin.isTTY) refuse(TERMINAL_REFUSAL.replace("candle-fido2", "candle-enclave"), 2)
const line = await readFirstLine(process.stdin)
if (line === null || line.trim() === "") {
  refuse(`expected one JSON request line on stdin (at most ${MAX_REQUEST_BYTES} bytes)`, 2)
}
const response = await handleEnclaveLine(line as string, () => scriptedEnclaveBackend(script))
process.stdout.write(`${JSON.stringify(response)}\n`)
process.exit(response.ok ? 0 : 1)
