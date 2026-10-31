/**
 * Drift guard for the MCP server's vendored copy of the SDK's strategy lab client (BE-2039,
 * strategy lab spec R18).
 *
 * `src/lab.ts` is a byte-identical copy of `packages/sdk/src/lab.ts`; the CLI carries a third
 * (`packages/cli/src/lab.drift.test.ts`). The server does not depend on the SDK package, so it
 * carries the file. The SDK's own tests (HTTPS only, no redirect, Bearer key, timeouts, polling)
 * run against the original; this test is what makes those results hold here. Copy any change
 * verbatim: `cp packages/sdk/src/lab.ts packages/mcp/src/lab.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/lab.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/lab.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "lab.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
