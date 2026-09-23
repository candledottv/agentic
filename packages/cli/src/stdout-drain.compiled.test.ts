/**
 * The built `candle` delivers its whole output through a real pipe (BE-299). Before the fix the CLI
 * ended with `process.exit(code)` in the same turn as the command's write; to a pipe that write
 * hands the kernel one 64 KiB buffer and finishes the rest from the event loop, so everything past
 * 65,536 bytes was lost and the process still exited 0. A file redirect got all of it.
 *
 * Three things make this test see that, and each was learned the hard way (spec §2.4, §5):
 *   - It runs the COMPILED binary, built here the way release-verify.compiled.test.ts builds it.
 *     An in-process test with a mocked `deps.stdout` cannot see a bug in how the process exits.
 *   - stdout is a pipe(2) that `bash` makes, never the spawner's own `stdout: "pipe"`, which is a
 *     socketpair with a far larger buffer: the unfixed binary passes straight through it.
 *   - The reader sleeps before it reads, so the buffer is full when the CLI reaches its exit, and
 *     the unfixed binary loses everything past the first buffer on every run, not just sometimes.
 *
 * The fake API is served from this process, so the CLI is spawned asynchronously (`runPipeline`).
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeWalletsAddress, fakeWalletsApi, pipeEnv, runPipeline, shellQuote } from "./test-support"

setDefaultTimeout(120_000)

const dir = join(import.meta.dir, "..")
const bin = join(dir, "dist-bin", "candle")
const ROWS = 1_200
/** The document has to be well past one pipe buffer, or the test proves nothing. */
const PIPE_BUFFER = 65_536

let api: { url: string; stop(): void }

beforeAll(async () => {
  const proc = Bun.spawn(["bun", "build", "--compile", "--minify", "src/index.ts", "--outfile", bin], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`bun build --compile failed (${code}):\n${err}`)
  api = fakeWalletsApi(ROWS)
})

afterAll(() => api?.stop())

function candle(args: string): string {
  return `${shellQuote(bin)} --api-url ${shellQuote(api.url)} --no-verify-account ${args}`
}

const SLOW_READER = "| (sleep 0.5; cat)"

async function fileDocument(): Promise<Buffer> {
  const out = join(mkdtempSync(join(tmpdir(), "candle-drain-")), "wallets.json")
  const res = await runPipeline(`${candle("wallets --json")} > ${shellQuote(out)}`, pipeEnv())
  expect(res.err).toBe("")
  expect(res.status).toBe(0)
  return readFileSync(out)
}

test("T1: wallets --json through a pipe to a slow reader arrives whole, and equals the file redirect", async () => {
  const res = await runPipeline(`${candle("wallets --json")} ${SLOW_READER}`, pipeEnv())
  expect(res.err).toBe("")
  expect(res.status).toBe(0)
  expect(res.out.length).toBeGreaterThan(4 * PIPE_BUFFER)
  expect(res.out.at(-1)).toBe(0x0a)
  const doc = JSON.parse(res.out.toString("utf8"))
  expect(doc.walletCount).toBe(ROWS)
  expect(doc.linked.page.length).toBe(ROWS)
  expect(doc.truncated).toBe(false)
  expect(res.out.equals(await fileDocument())).toBe(true)
})

test("T2: a reader that closes early (| head) ends the output quietly with the command's own status", async () => {
  // `2>&1` so an EPIPE stack trace, if one were printed, would land in what head reads or be the
  // pipeline's stderr; the CLI's own status comes from PIPESTATUS, not from head.
  const res = await runPipeline(`${candle("wallets --json")} 2>&1 | head -c 10; exit "\${PIPESTATUS[0]}"`, pipeEnv())
  expect(res.err).toBe("")
  expect(res.status).toBe(0)
  expect(res.out.length).toBe(10)
  expect(res.out.equals((await fileDocument()).subarray(0, 10))).toBe(true)
})

test("T3: the control, a file redirect, is complete", async () => {
  const doc = JSON.parse((await fileDocument()).toString("utf8"))
  expect(doc.walletCount).toBe(ROWS)
})

test("T4: a failure's exit code reaches the pipe, and its envelope drains the same way", async () => {
  const res = await runPipeline(`${candle("wallets --json")} ${SLOW_READER}`, pipeEnv("wrong"))
  expect(res.status).toBe(1)
  const text = res.out.toString("utf8")
  expect(text.endsWith("\n")).toBe(true)
  expect(text.trimEnd().split("\n")).toHaveLength(1)
  const envelope = JSON.parse(text)
  expect(envelope.ok).toBe(false)
  expect(envelope.walletCount).toBeUndefined()
})

test("T7: the human table has the same bound and arrives whole through a pipe", async () => {
  const res = await runPipeline(`${candle("wallets")} ${SLOW_READER}`, pipeEnv())
  expect(res.err).toBe("")
  expect(res.status).toBe(0)
  expect(res.out.length).toBeGreaterThan(PIPE_BUFFER)
  const text = res.out.toString("utf8")
  const missing = Array.from({ length: ROWS }, (_, index) => fakeWalletsAddress(index)).filter(
    (address) => !text.includes(address),
  )
  expect(missing).toEqual([])
  // The `none` signer hint is printed after the table, so it is how the end of the document is known.
  const hint = text.lastIndexOf("A wallet marked none has no signer on this machine")
  expect(hint).toBeGreaterThan(text.lastIndexOf(fakeWalletsAddress(ROWS - 1)))
})
