/**
 * Drift guard for the MCP server's vendored copy of the SDK's Hyperliquid risk engine (BE-1582, spec A-1,
 * invariant I1, AC18).
 *
 * `src/hyperliquid-risk.ts` is a byte-identical copy of `packages/sdk/src/hyperliquid-risk.ts`: one
 * rule for every surface's level, and no second implementation. The SDK's own tests run the engine;
 * this test is what makes those results hold here. It imports nothing, so the copy needs no
 * dependency. Copy any change verbatim:
 * `cp packages/sdk/src/hyperliquid-risk.ts packages/mcp/src/hyperliquid-risk.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/hyperliquid-risk.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/hyperliquid-risk.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid-risk.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
