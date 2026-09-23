/**
 * Drift guard for how the CLI exits (BE-299, T6). `main()` sets `process.exitCode` and returns;
 * the runtime then exits once stdout and stderr have drained. A `process.exit(` anywhere in
 * index.ts ends the process in the same turn as the command's write, and to a pipe that cut the
 * output at 65,536 bytes with a status of 0. The compiled-binary test (stdout-drain.compiled.test.ts)
 * catches that behaviour; this catches the shape before anything is built.
 *
 * `await main()` is the other half: the pending top-level await is what holds the process open
 * until `main` settles (BE-136, T49). The pty parity test is its behavioural guard.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("index.ts exits by returning: no process.exit, and main() is awaited at the top level", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  expect(source).not.toContain("process.exit(")
  expect(source).toContain("await main()")
})
