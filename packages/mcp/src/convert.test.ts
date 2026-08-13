import { describe, expect, test } from "bun:test"
import { decimalToRaw, defaultQuoteId, percentOfBalance, QUOTE_DECIMALS } from "./convert"

describe("QUOTE_DECIMALS pins the API's quote-asset decimals", () => {
  // Inlined rather than imported from @candle/shared because the mcp package must build
  // standalone in the public agentic repo, where @candle/shared does not exist. This test is
  // the drift alarm: if the API's pair table ever changes, update BOTH places.
  test("the five quote assets carry their known decimals", () => {
    expect(QUOTE_DECIMALS).toEqual({ sol: 9, usdc: 6, cndl: 6, eth: 18, usdg: 6 })
  })
})

describe("decimalToRaw: the 1000x-error danger zone", () => {
  test("whole units scale by 10^decimals", () => {
    expect(decimalToRaw("1", 9)).toBe("1000000000")
    expect(decimalToRaw("0.5", 9)).toBe("500000000")
    expect(decimalToRaw("1000", 6)).toBe("1000000000")
  })
  test("full-precision fractions convert exactly", () => {
    expect(decimalToRaw("0.000000001", 9)).toBe("1")
    expect(decimalToRaw("1.234567", 6)).toBe("1234567")
  })
  test("18-decimal amounts stay exact far beyond float precision", () => {
    expect(decimalToRaw("1.000000000000000001", 18)).toBe("1000000000000000001")
  })
  test("more fraction digits than the asset has decimals is rejected, never silently truncated", () => {
    expect(() => decimalToRaw("0.1234567", 6)).toThrow(/decimals/)
  })
  test("zero, negative, and malformed inputs are rejected", () => {
    expect(() => decimalToRaw("0", 6)).toThrow()
    expect(() => decimalToRaw("-1", 6)).toThrow()
    expect(() => decimalToRaw("1e9", 6)).toThrow()
    expect(() => decimalToRaw("abc", 6)).toThrow()
    expect(() => decimalToRaw("", 6)).toThrow()
    expect(() => decimalToRaw("1.2.3", 6)).toThrow()
  })
  test("a non-integer or negative decimals argument throws instead of mispricing", () => {
    expect(() => decimalToRaw("1", 6.5)).toThrow(/decimals/)
    expect(() => decimalToRaw("1", -1)).toThrow(/decimals/)
    expect(() => decimalToRaw("1", Number.NaN)).toThrow(/decimals/)
  })
})

describe("defaultQuoteId pins the API's per-chain default quote", () => {
  test("hood defaults to eth, everything else to sol", () => {
    expect(defaultQuoteId("hood")).toBe("eth")
    expect(defaultQuoteId("solana")).toBe("sol")
    expect(defaultQuoteId(undefined)).toBe("sol")
  })
})

describe("percentOfBalance: BigInt floor, no float anywhere", () => {
  test("50 percent of an even balance", () => {
    expect(percentOfBalance("1000000", 50)).toBe("500000")
  })
  test("floors an uneven division", () => {
    expect(percentOfBalance("1000001", 50)).toBe("500000")
    expect(percentOfBalance("3", 50)).toBe("1")
  })
  test("100 percent is the whole balance; 1 percent of a tiny balance floors to zero and is rejected", () => {
    expect(percentOfBalance("777", 100)).toBe("777")
    expect(() => percentOfBalance("50", 1)).toThrow(/zero/)
  })
  test("percent out of range or fractional is rejected", () => {
    expect(() => percentOfBalance("1000", 0)).toThrow()
    expect(() => percentOfBalance("1000", 101)).toThrow()
    expect(() => percentOfBalance("1000", 12.5)).toThrow()
  })
  test("balances beyond Number.MAX_SAFE_INTEGER stay exact", () => {
    expect(percentOfBalance("9007199254740993000", 50)).toBe("4503599627370496500")
  })
})
