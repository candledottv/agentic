import { expect, test } from "bun:test"
import { CLUSTER_READ_DESCRIPTION, tokenClustersShape } from "./cluster-read"
import { CLUSTER_CAVEAT, CLUSTER_LABEL, CLUSTER_MESSAGE, CLUSTER_REASONS } from "./token-clusters"
import { registerToolSubset } from "./tools"

const MINT = "So11111111111111111111111111111111111111112"
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const AVAILABLE = {
  status: "available",
  chain: "solana",
  mint: MINT,
  source: "third_party",
  label: CLUSTER_LABEL,
  caveat: CLUSTER_CAVEAT,
  fetchedAt: "2026-10-27T12:00:00.000Z",
  expiresAt: "2026-10-27T13:00:00.000Z",
  cache: "hit",
  analysis: { clusterSupplyPct: 40, clusters: [{ supplyPct: 40, addresses: [WALLET], tags: ["pool"] }] },
}
const TRANSPORT = { status: "unavailable", mint: MINT, reason: "transport_error", message: CLUSTER_MESSAGE }

type Result = { content: { type: string; text: string }[]; isError?: boolean }
function tool(answer: (url: string) => Response | Promise<Response>, apiKey?: string) {
  const calls: { url: string; init?: RequestInit }[] = []
  let handler: ((args: Record<string, unknown>) => Promise<Result>) | undefined
  let config: Record<string, unknown> | undefined
  registerToolSubset(
    {
      registerTool(name: string, c: Record<string, unknown>, h: typeof handler) {
        if (name === "candle_token_clusters") {
          config = c
          handler = h
        }
      },
    } as unknown as Parameters<typeof registerToolSubset>[0],
    {
      tools: ["candle_token_clusters"],
      getConfig: () => ({ apiUrl: "http://local-api/", ...(apiKey ? { apiKey } : {}) }),
      fetch: async (url, init) => {
        calls.push({ url, init })
        return answer(url)
      },
    },
  )
  if (!handler) throw new Error("candle_token_clusters was not registered")
  return { calls, config, call: handler }
}
const read = (r: Result) => JSON.parse(r.content[0]?.text ?? "null")

test("relays an available result with isError false, from one keyless uncached request", async () => {
  const { calls, call } = tool(() => Response.json({ success: true, data: AVAILABLE }), "fixture-key")
  const result = await call({ mint: MINT })
  expect(result.isError).toBe(false)
  expect(result.content).toHaveLength(1)
  expect(read(result)).toEqual(AVAILABLE)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(`http://local-api/api/v1/tokens/${MINT}/clusters?chain=solana`)
  expect(calls[0]?.init?.cache).toBe("no-store")
  expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  expect(new Headers(calls[0]?.init?.headers).get("x-api-key")).toBeNull()
})

test("every server unavailable reason is a non-error result, unchanged", async () => {
  for (const reason of CLUSTER_REASONS) {
    const data = { status: "unavailable", mint: MINT, reason, message: CLUSTER_MESSAGE }
    const { call } = tool(() => Response.json({ success: true, data }))
    const result = await call({ mint: MINT })
    expect({ reason, isError: result.isError, data: read(result) }).toEqual({ reason, isError: false, data })
  }
})

test("hood passes through to the server's unsupported_chain", async () => {
  const data = { status: "unavailable", mint: "0xToken", reason: "unsupported_chain", message: CLUSTER_MESSAGE }
  const { calls, call } = tool(() => Response.json({ success: true, data }))
  const result = await call({ mint: "0xToken", chain: "hood" })
  expect(result.isError).toBe(false)
  expect(read(result)).toEqual(data)
  expect(calls[0]?.url.endsWith("?chain=hood")).toBe(true)
})

test("a failed or unusable response is transport_error with isError false and no raw body", async () => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    [
      "connection refused",
      () => {
        throw new TypeError("fetch failed: ECONNREFUSED internal-host")
      },
    ],
    ["HTTP 502", () => new Response("upstream stack trace", { status: 502 })],
    ["HTTP 403", () => Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["success false", () => Response.json({ success: false, data: AVAILABLE })],
    ["another mint", () => Response.json({ success: true, data: { ...AVAILABLE, mint: WALLET } })],
    ["numbers on unavailable", () => Response.json({ success: true, data: { ...TRANSPORT, reason: "nope" } })],
    [
      "invalid address",
      () =>
        Response.json({
          success: true,
          data: {
            ...AVAILABLE,
            analysis: { clusterSupplyPct: 1, clusters: [{ supplyPct: 1, addresses: ["x"], tags: [] }] },
          },
        }),
    ],
  ]
  for (const [name, answer] of failures) {
    const { call } = tool(answer)
    const result = await call({ mint: MINT })
    expect({ name, isError: result.isError, data: read(result) }).toEqual({ name, isError: false, data: TRANSPORT })
    expect(result.content[0]?.text).not.toMatch(/stack|ECONNREFUSED|internal-host/)
  }
})

test("is a read-only tool whose public text names no data supplier or private setting", () => {
  const { config } = tool(() => Response.json({}))
  expect(config?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  expect(config?.description).toBe(CLUSTER_READ_DESCRIPTION)
  const text = [CLUSTER_READ_DESCRIPTION, ...Object.values(tokenClustersShape).map((s) => s.description ?? "")].join(
    " ",
  )
  expect(text).not.toMatch(/insightx|atlas|TOKEN_CLUSTERS_|API_KEY|https?:\/\//i)
  expect(text).toContain("third-party")
  expect(text).toContain("Cluster analysis not available for this token")
})
