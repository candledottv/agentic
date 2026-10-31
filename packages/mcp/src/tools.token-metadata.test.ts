/**
 * BE-2140: candle_token_edit refuses an unknown socials key before any request and sends a keyed
 * PATCH with an Idempotency-Key; candle_token_history is keyless. The same-body check against the
 * CLI and the SDK (AC23) is scripts/token-metadata-surfaces.test.ts, outside this exported package.
 */
import { describe, expect, test } from "bun:test"
import { tokenEditBody } from "./token-metadata"
import { buildRequest } from "./tools"

const MINT = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"
const cfg = { apiUrl: "https://api.example", apiKey: "cdl_key" }

describe("candle_token_edit", () => {
  test("a PATCH with the key and an Idempotency-Key, given or fresh", () => {
    const given = buildRequest(
      "candle_token_edit",
      { chain: "hood", mint: "0xabc", description: "x", idempotencyKey: "k" },
      cfg,
    )
    expect(given.url).toBe("https://api.example/api/v1/tokens/hood/0xabc/metadata")
    expect(given.init.method).toBe("PATCH")
    const headers = given.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("cdl_key")
    expect(headers["Idempotency-Key"]).toBe("k")
    expect(JSON.parse(String(given.init.body))).toEqual({ description: "x" })
    const fresh = buildRequest("candle_token_edit", { chain: "solana", mint: MINT, description: "x" }, cfg)
    expect((fresh.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("an unknown socials key, a non-URL link or an empty edit is refused locally", () => {
    expect(tokenEditBody({ socials: { instagram: "https://instagram.com/a" } })).toEqual({
      refusal: expect.objectContaining({ code: "VALIDATION_FAILED", field: "socials.instagram" }),
    })
    expect(tokenEditBody({ socials: { website: "javascript:alert(1)" } })).toEqual({
      refusal: expect.objectContaining({ field: "socials.website" }),
    })
    expect(tokenEditBody({})).toEqual({ refusal: expect.objectContaining({ field: "body" }) })
    expect(tokenEditBody({ socials: { website: null, twitter: "" } })).toEqual({
      body: { socials: { website: null, twitter: "" } },
    })
  })

  test("it needs a key", () => {
    expect(() =>
      buildRequest("candle_token_edit", { chain: "solana", mint: MINT, description: "x" }, { apiUrl: cfg.apiUrl }),
    ).toThrow("CANDLE_AGENT_API_KEY")
  })
})

describe("candle_token_history", () => {
  test("keyless, with cursor and limit", () => {
    const built = buildRequest("candle_token_history", { chain: "solana", mint: MINT, cursor: "4", limit: 10 }, cfg)
    expect(built.url).toBe(`https://api.example/api/v1/tokens/solana/${MINT}/metadata/history?limit=10&cursor=4`)
    expect((built.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })
})
