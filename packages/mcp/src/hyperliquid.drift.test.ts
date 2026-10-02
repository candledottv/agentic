/**
 * Drift guard for the MCP server's vendored copy of the SDK's Hyperliquid module (BE-646).
 *
 * `src/hyperliquid.ts` is a byte-identical copy of `packages/sdk/src/hyperliquid.ts`. The server
 * does not depend on the SDK package, so it carries the file, and `@noble/hashes` (its one import)
 * is a dependency of its own. The SDK's own tests run
 * the official Python SDK's vectors and the pre-sign checks against the original; this test is
 * what makes those results hold here. Copy any change verbatim:
 * `cp packages/sdk/src/hyperliquid.ts packages/mcp/src/hyperliquid.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/hyperliquid.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/hyperliquid.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
