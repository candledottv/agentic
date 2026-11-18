import { expect, test } from "bun:test"

test("CLI, MCP and SDK transfer checks remain identical", async () => {
  const source = await Bun.file(new URL("../../cli/src/hyperliquid-transfer.ts", import.meta.url)).text()
  expect(await Bun.file(new URL("./hyperliquid-transfer.ts", import.meta.url)).text()).toBe(source)
  expect(await Bun.file(new URL("../../sdk/src/hyperliquid-transfer.ts", import.meta.url)).text()).toBe(source)
})
