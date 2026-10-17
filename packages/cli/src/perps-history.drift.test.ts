/**
 * Drift guard for the vendored copy of the SDK's Hyperliquid history module (BE-1583, spec
 * 2026-10-17-hyperliquid-phase1-c-small-items-design.md, sections 3 and 4). `src/perps-history.ts`
 * is a byte-identical copy of `packages/sdk/src/perps-history.ts`, so `candle perps fills|funding`,
 * `candle_perps_fills|funding` and the SDK's `perpsFillsPage|perpsFundingPage` page the same way;
 * the SDK's tests are what make those results hold here. Copy any change verbatim:
 * `cp packages/sdk/src/perps-history.ts packages/cli/src/perps-history.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/perps-history.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/perps-history.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "perps-history.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
