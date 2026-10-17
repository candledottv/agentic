import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("hyperliquid-markets.ts is byte-identical to the SDK original", () => {
  const sdk = join(import.meta.dir, "../../sdk/src/hyperliquid-markets.ts")
  if (!existsSync(sdk)) return
  expect(readFileSync(join(import.meta.dir, "hyperliquid-markets.ts"), "utf8")).toBe(readFileSync(sdk, "utf8"))
})
