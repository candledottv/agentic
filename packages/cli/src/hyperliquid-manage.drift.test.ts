/**
 * Drift guard for the CLI's vendored copy of the SDK's Hyperliquid management plans (BE-1584,
 * spec 2026-10-17-hyperliquid-phase1-d-management-actions-design.md, section 3: CLI, SDK and local
 * MCP parity).
 *
 * `src/hyperliquid-manage.ts` is a byte-identical copy of `packages/sdk/src/hyperliquid-manage.ts`:
 * one TP/SL and flatten plan for every surface, and no second implementation. The SDK's own tests run
 * it; this test is what makes those results hold here. Its only import is `./hyperliquid`, copied the
 * same way. Copy any change verbatim:
 * `cp packages/sdk/src/hyperliquid-manage.ts packages/cli/src/hyperliquid-manage.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/hyperliquid-manage.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/hyperliquid-manage.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid-manage.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
