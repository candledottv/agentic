/**
 * SEC-009: a request that carries `x-api-key` never follows a redirect off its own origin, because
 * fetch would forward the key to wherever the Location points. Same-origin redirects (the API's
 * legacy routes) are still followed.
 */
import { describe, expect, test } from "bun:test"
import { CandleClient, CrossOriginRedirectError, keyedRedirectGuard } from "./client"

interface Seen {
  url: string
  init: RequestInit
}

function stub(respond: (url: string, seen: Seen[]) => Response) {
  const seen: Seen[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init: init ?? {} })
    return respond(url, seen)
  }) as unknown as typeof fetch
  return { seen, impl }
}

const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } })
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

describe("keyed requests and redirects", () => {
  test("a keyed request redirected to another origin throws, and nothing is sent there", async () => {
    const { seen, impl } = stub((url) =>
      url.startsWith("https://api.candle.tv") ? redirect(302, "https://attacker.example/x") : json({ ok: true }),
    )
    const guarded = keyedRedirectGuard(impl)
    await expect(
      guarded("https://api.candle.tv/api/v1/agent/wallets", { headers: { "x-api-key": "ck_live_secret" } }),
    ).rejects.toBeInstanceOf(CrossOriginRedirectError)
    expect(seen.map((s) => s.url)).toEqual(["https://api.candle.tv/api/v1/agent/wallets"])
    expect(seen[0]?.init.redirect).toBe("manual")
  })

  test("through the client: the call fails and the key never reaches the other origin", async () => {
    const { seen, impl } = stub((url) =>
      url.startsWith("https://api.candle.tv") ? redirect(301, "https://attacker.example/x") : json({ ok: true }),
    )
    const client = new CandleClient({ apiUrl: "https://api.candle.tv", apiKey: "ck_live_secret", fetch: impl })
    await expect(client.getMarket("solana", "Mint111")).rejects.toThrow("another origin")
    expect(seen.every((s) => s.url.startsWith("https://api.candle.tv/"))).toBe(true)
  })

  test("a same-origin redirect is followed with the key; 303 continues as a body-less GET", async () => {
    const { seen, impl } = stub((url) => (url.endsWith("/old") ? redirect(303, "/new") : json({ at: "new" })))
    const guarded = keyedRedirectGuard(impl)
    const res = await guarded("https://api.candle.tv/old", {
      method: "POST",
      headers: { "x-api-key": "ck_live_secret" },
      body: "{}",
    })
    expect(await res.json()).toEqual({ at: "new" })
    expect(seen.map((s) => s.url)).toEqual(["https://api.candle.tv/old", "https://api.candle.tv/new"])
    expect((seen[1]?.init.headers as Record<string, string>)["x-api-key"]).toBe("ck_live_secret")
    expect(seen[1]?.init.method).toBe("GET")
    expect(seen[1]?.init.body).toBeUndefined()
  })

  test("a request without the key is passed through untouched", async () => {
    const { seen, impl } = stub(() => json({ ok: true }))
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    await keyedRedirectGuard(impl)("https://rpc.example/", init)
    expect(seen[0]?.init).toBe(init)
  })
})
