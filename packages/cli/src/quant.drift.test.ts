/**
 * Drift guard for the vendored copy of the SDK's Quant key client (BE-1737, spec S5 Q-2).
 * `src/quant.ts` is a byte-identical copy of `packages/sdk/src/quant.ts`, so the core and any other
 * SDK consumer call the key route the same way. Copy any change verbatim:
 * `cp packages/sdk/src/quant.ts packages/cli/src/quant.ts`.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("src/quant.ts is byte-identical to the SDK original", () => {
  const sdkFile = join(import.meta.dir, "../../sdk/src/quant.ts")
  if (!existsSync(sdkFile)) return
  expect(readFileSync(join(import.meta.dir, "quant.ts"), "utf8")).toBe(readFileSync(sdkFile, "utf8"))
})
