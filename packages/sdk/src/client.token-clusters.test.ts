import { expect, test } from "bun:test"
import { CandleClient } from "./client"
import { CLUSTER_CAVEAT, CLUSTER_LABEL, CLUSTER_MESSAGE, CLUSTER_REASONS, type ClusterResult } from "./index"

const MINT = "So11111111111111111111111111111111111111112"
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const AVAILABLE: ClusterResult = {
  status: "available",
  chain: "solana",
  mint: MINT,
  source: "third_party",
  label: CLUSTER_LABEL,
  caveat: CLUSTER_CAVEAT,
  fetchedAt: "2026-10-27T12:00:00.000Z",
  expiresAt: "2026-10-27T13:00:00.000Z",
  cache: "miss",
  analysis: { clusterSupplyPct: 12.5, clusters: [{ supplyPct: 12.5, addresses: [WALLET], tags: ["linked"] }] },
}
const TRANSPORT = { status: "unavailable", mint: MINT, reason: "transport_error", message: CLUSTER_MESSAGE }

function client(answer: (url: URL) => Response | Promise<Response>, apiKey?: string) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return answer(url)
  }) as unknown as typeof fetch
  return { calls, candle: new CandleClient({ apiUrl: "https://api.test/", fetch: fetcher, apiKey }) }
}

test("one keyless, uncached request to the cluster route resolves an available result", async () => {
  const { calls, candle } = client(() => Response.json({ success: true, data: AVAILABLE }), "fixture-key")
  expect(await candle.getTokenClusters(MINT)).toEqual(AVAILABLE)
  expect(calls).toHaveLength(1)
  const call = calls[0] as { url: URL; init?: RequestInit }
  expect(call.url.href).toBe(`https://api.test/api/v1/tokens/${MINT}/clusters?chain=solana`)
  expect(call.init?.method).toBe("GET")
  expect(call.init?.cache).toBe("no-store")
  expect(call.init?.signal).toBeInstanceOf(AbortSignal)
  expect(new Headers(call.init?.headers).get("x-api-key")).toBeNull()
})

test("every server unavailable reason resolves unchanged, retryAt included", async () => {
  for (const reason of CLUSTER_REASONS) {
    const data = { status: "unavailable", mint: MINT, reason, message: CLUSTER_MESSAGE }
    const { candle } = client(() => Response.json({ success: true, data }))
    expect(await candle.getTokenClusters(MINT)).toEqual(data as ClusterResult)
  }
  const retry = {
    status: "unavailable",
    mint: MINT,
    reason: "request_in_progress",
    message: CLUSTER_MESSAGE,
    retryAt: "2026-10-27T12:00:10.000Z",
  }
  const { candle } = client(() => Response.json({ success: true, data: retry }))
  expect(await candle.getTokenClusters(MINT)).toEqual(retry as ClusterResult)
})

test("hood is sent as asked and the server's unsupported_chain comes back", async () => {
  const data = { status: "unavailable", mint: "0xToken", reason: "unsupported_chain", message: CLUSTER_MESSAGE }
  const { calls, candle } = client(() => Response.json({ success: true, data }))
  expect(await candle.getTokenClusters("0xToken", { chain: "hood" })).toEqual(data as ClusterResult)
  expect(calls[0]?.url.search).toBe("?chain=hood")
})

test("no usable response resolves transport_error and never throws", async () => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    [
      "connection refused",
      () => {
        throw new TypeError("fetch failed")
      },
    ],
    [
      "aborted",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
    ],
    ["HTTP 500", () => Response.json({ success: false, error: { code: "INTERNAL" } }, { status: 500 })],
    ["HTTP 401", () => Response.json({ success: false, error: { code: "UNAUTHORIZED" } }, { status: 401 })],
    ["HTTP 429", () => new Response("slow down", { status: 429 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["success false", () => Response.json({ success: false, data: AVAILABLE })],
    ["another mint", () => Response.json({ success: true, data: { ...AVAILABLE, mint: WALLET } })],
    ["unknown reason", () => Response.json({ success: true, data: { ...TRANSPORT, reason: "vendor_said_no" } })],
    [
      "out-of-range percentage",
      () =>
        Response.json({
          success: true,
          data: { ...AVAILABLE, analysis: { ...AVAILABLE.analysis, clusterSupplyPct: 101 } },
        }),
    ],
    [
      "all-zero analysis",
      () =>
        Response.json({
          success: true,
          data: {
            ...AVAILABLE,
            analysis: { clusterSupplyPct: 0, clusters: [{ supplyPct: 0, addresses: [], tags: [] }] },
          },
        }),
    ],
  ]
  for (const [name, answer] of failures) {
    const { candle } = client(answer)
    expect({ name, result: await candle.getTokenClusters(MINT) }).toEqual({ name, result: TRANSPORT as ClusterResult })
  }
})

test("an available result keeps only protocol fields, with the generic label and caveat", async () => {
  const { candle } = client(() =>
    Response.json({
      success: true,
      data: { ...AVAILABLE, label: "Vendor X", caveat: "trust us", rawVendor: { x: 1 } },
    }),
  )
  const result = await candle.getTokenClusters(MINT)
  expect(result).toEqual(AVAILABLE)
  expect(JSON.stringify(result)).not.toContain("Vendor")
})
