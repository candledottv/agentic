/**
 * Drift guard for the MCP server's vendored copy of the CLI's hacc signal records client (BE-3411,
 * hacc north-star CL1).
 *
 * `src/signal-records.ts` is a byte-identical copy of `packages/cli/src/signal-records.ts`. The
 * server does not depend on the CLI package, so it carries the file; this test is what makes the
 * CLI's results (HTTPS only, no redirect, Bearer key, GET only, the fixed line on every answer)
 * hold here. Copy any change verbatim:
 * `cp packages/cli/src/signal-records.ts packages/mcp/src/signal-records.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/signal-records.ts is byte-identical to the CLI original", () => {
  const original = join(import.meta.dir, "../../cli/src/signal-records.ts")
  if (!existsSync(original)) return
  expect(readFileSync(join(import.meta.dir, "signal-records.ts"), "utf8")).toBe(readFileSync(original, "utf8"))
})
