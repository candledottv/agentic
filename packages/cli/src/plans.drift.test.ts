/**
 * Drift guard for the vendored copy of the SDK's plan-table module (BE-723). `src/plans.ts` is a
 * byte-identical copy of `packages/sdk/src/plans.ts`, so this package, the SDK and the docs render
 * the served plan table in the same words. Copy any change verbatim:
 * `cp packages/sdk/src/plans.ts packages/cli/src/plans.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/plans.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/plans.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "plans.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
