import { describe, expect, test } from "bun:test"
import { recoveryNext } from "./tools"

describe("BE-3072: MCP points an uncertain operation at the status read", () => {
  test("evidence beside or inside the error yields words, naming the id and kind", () => {
    const inside = { success: false, error: { code: "SWAP_FAILED", safeAction: "read_status", pollAfterMs: 5000 } }
    const beside = { success: false, error: { code: "SWAP_FAILED" }, recoveryRequired: true }
    for (const body of [inside, beside]) {
      const next = recoveryNext(body, "swap-1", "swap")
      expect(next).toContain('clientId "swap-1"')
      expect(next).toContain('kind "swap"')
      expect(next).toContain("Do not call this tool again")
    }
    expect(recoveryNext(inside, "swap-1", "swap")).toContain("5000 ms")
  })
  test("an ordinary refusal or an old server's answer gets no extra guidance", () => {
    expect(recoveryNext({ success: false, error: { code: "VALIDATION_FAILED" } }, "x", "swap")).toBeNull()
    expect(recoveryNext({ success: false, error: { code: "SWAP_FAILED", safeAction: "none" } }, "x", "swap")).toBeNull()
  })
})
