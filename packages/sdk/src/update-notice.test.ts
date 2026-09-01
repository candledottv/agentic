/**
 * The SDK's whole update surface is one console.warn per process, fed by a header on responses
 * it already makes. The latch, the opt-out, and the version drift guard are the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import pkg from "../package.json"
import { __resetSdkUpdateNoticeForTest, CandleClient, SDK_VERSION } from "./client"

const warns: string[] = []
const realWarn = console.warn

function clientAgainst(headers: Record<string, string>): CandleClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ success: true, tier: "free", feeBps: 100, maxExpired: false }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch
  return new CandleClient({ apiKey: "ck_live_x", apiUrl: "https://api.test", fetch: fetchImpl })
}

beforeEach(() => {
  __resetSdkUpdateNoticeForTest()
  warns.length = 0
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "))
  }
  delete process.env.CANDLE_NO_UPDATE_NOTICE
})

afterEach(() => {
  console.warn = realWarn
  delete process.env.CANDLE_NO_UPDATE_NOTICE
})

describe("sdk update notice", () => {
  test("SDK_VERSION agrees with package.json, or the baked notice lies about itself", () => {
    expect(SDK_VERSION).toBe(pkg.version)
  })

  test("warns exactly once per process, with the exact install command", async () => {
    const client = clientAgainst({ "x-candle-sdk-latest": "99.0.0" })
    await client.getAgentTier()
    await client.getAgentTier()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(`@candledottv/agent-sdk 99.0.0 is available (running ${SDK_VERSION})`)
    expect(warns[0]).toContain("npm install @candledottv/agent-sdk@latest")
  })

  test("an up-to-date header, a garbage header, and a missing header all stay silent", async () => {
    const cases: Record<string, string>[] = [
      { "x-candle-sdk-latest": SDK_VERSION },
      { "x-candle-sdk-latest": "not-a-version|.*" },
      {},
    ]
    for (const headers of cases) {
      __resetSdkUpdateNoticeForTest()
      await clientAgainst(headers).getAgentTier()
    }
    expect(warns).toHaveLength(0)
  })

  test("CANDLE_NO_UPDATE_NOTICE=1 silences it", async () => {
    process.env.CANDLE_NO_UPDATE_NOTICE = "1"
    await clientAgainst({ "x-candle-sdk-latest": "99.0.0" }).getAgentTier()
    expect(warns).toHaveLength(0)
  })
})
