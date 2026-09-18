/**
 * Ember Phase 2 (BE-140, helper protocols): the one request in, one response out loop.
 *
 * Shared by the real entry (`main.ts`, over libfido2) and by the scripted helper the CLI's tests
 * spawn, so what the tests exercise is this exact loop over a real pipe rather than a mock of it.
 *
 * The helper never reads the terminal (ED-11, T47). That is enforced here in two ways: the request
 * is read from whatever stdin is, one line and nothing more, and a stdin that IS a terminal is
 * refused before a byte is read. A PIN only ever arrives inside the JSON request the CLI pipes in,
 * and this module has no prompt of any kind to put one on a screen.
 */
import { type Fido2Backend, HELPER_PROTOCOL, handleLine } from "./protocol"

/** A request line larger than this is not a request; it is refused before it is parsed. */
export const MAX_REQUEST_BYTES = 64 * 1024

export interface HelperStreams {
  stdin: AsyncIterable<Uint8Array | string>
  stdout: { write(chunk: string): unknown }
  stdinIsTTY: boolean
}

export const TERMINAL_REFUSAL =
  "candle-fido2 reads exactly one JSON request from a piped stdin and never from a terminal; it is run by the candle CLI, not by hand"

/**
 * Reads the first line of `stdin` as UTF-8, stopping at the first newline or at end of input. The
 * buffered bytes are zeroed once the line has been copied out, because the line may carry a PIN.
 */
export async function readFirstLine(stdin: AsyncIterable<Uint8Array | string>): Promise<string | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  let done = false
  for await (const chunk of stdin) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    const newline = bytes.indexOf(0x0a)
    const take = newline === -1 ? bytes : bytes.subarray(0, newline)
    chunks.push(Uint8Array.from(take))
    total += take.length
    if (total > MAX_REQUEST_BYTES) {
      for (const c of chunks) c.fill(0)
      return null
    }
    if (newline !== -1) {
      done = true
      break
    }
  }
  if (!done && total === 0) return null
  const joined = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    joined.set(c, offset)
    offset += c.length
    c.fill(0)
  }
  const line = new TextDecoder().decode(joined)
  joined.fill(0)
  return line
}

/**
 * Serves one request and returns the process exit code: 0 for an `ok: true` response, 1 for a typed
 * failure, 2 when no request could be read at all. The response is always exactly one line.
 */
export async function serveOnce(streams: HelperStreams, backend: () => Fido2Backend): Promise<number> {
  if (streams.stdinIsTTY) {
    streams.stdout.write(
      `${JSON.stringify({ ok: false, protocol: HELPER_PROTOCOL, code: "BAD_REQUEST", message: TERMINAL_REFUSAL })}\n`,
    )
    return 2
  }
  const line = await readFirstLine(streams.stdin)
  if (line === null || line.trim() === "") {
    streams.stdout.write(
      `${JSON.stringify({
        ok: false,
        protocol: HELPER_PROTOCOL,
        code: "BAD_REQUEST",
        message: `expected one JSON request line on stdin (at most ${MAX_REQUEST_BYTES} bytes)`,
      })}\n`,
    )
    return 2
  }
  const response = handleLine(line, backend)
  streams.stdout.write(`${JSON.stringify(response)}\n`)
  return response.ok ? 0 : 1
}
