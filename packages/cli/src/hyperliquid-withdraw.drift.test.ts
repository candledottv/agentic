/**
 * Drift guard for the CLI's vendored copy of the SDK's withdrawal checks (BE-1573).
 *
 * `src/hyperliquid-withdraw.ts` is a byte-identical copy of `packages/sdk/src/hyperliquid-withdraw.ts`,
 * vendored for the same reason as `hyperliquid.ts`: the CLI has no runtime dependencies. The SDK's
 * tests run the pre-sign checks against the original; this test is what makes those results hold
 * here. Copy any change verbatim:
 * `cp packages/sdk/src/hyperliquid-withdraw.ts packages/cli/src/hyperliquid-withdraw.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/hyperliquid-withdraw.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/hyperliquid-withdraw.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid-withdraw.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
