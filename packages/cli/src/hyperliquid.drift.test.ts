/**
 * Drift guard for the CLI's vendored copy of the SDK's Hyperliquid module (BE-646).
 *
 * `src/hyperliquid.ts` is a byte-identical copy of `packages/sdk/src/hyperliquid.ts`, vendored for
 * the same reason as `wallet-import.ts` (see wallet-import.drift.test.ts): the CLI has no runtime
 * dependencies, and `@noble/hashes` is a devDependency bundled into dist. The SDK's own tests run
 * the official Python SDK's vectors and the pre-sign checks against the original; this test is
 * what makes those results hold here. Copy any change verbatim:
 * `cp packages/sdk/src/hyperliquid.ts packages/cli/src/hyperliquid.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/hyperliquid.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/hyperliquid.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
