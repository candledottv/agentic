/**
 * `candle keys limit` sets or clears the USD cap on a key that already exists.
 * An 8-character label is resolved through the same account list as `keys update`.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

const DEVICE = { device_token: "cndl_dvc_x" }

function routes() {
  return createRoutedFetch({
    "/api/v1/agent/keys": () =>
      jsonResponse(200, {
        keys: [
          { keyPrefix: "xjxJTsc4", label: "cov-main", scopes: ["swap:write"] },
          { keyPrefix: "Ab3dEf9h", label: "agent-one", scopes: ["swap:write"] },
        ],
      }),
    "/api/v1/agent/keys/xjxJTsc4": () => jsonResponse(200, { success: true }),
    "/api/v1/agent/keys/Ab3dEf9h": () => jsonResponse(200, { success: true }),
  })
}

describe("keys limit", () => {
  test("--tx-limit sends exactly { txLimit } and defaults the reset to daily", async () => {
    const { fetch, calls } = routes()
    const stdout = createCapture()
    const code = await run(
      ["keys", "limit", "Ab3dEf9h", "--tx-limit", "100"],
      createTestDeps({ fetch, store: createFakeStore(DEVICE), stdout }),
    )
    expect(code).toBe(0)
    const patch = calls.find((call) => call.init.method === "PATCH")
    expect(JSON.parse(String(patch?.init.body))).toEqual({ txLimit: { usdMicros: 100_000_000, reset: "daily" } })
    expect(stdout.text).toContain("Ab3dEf9h")
    expect(stdout.text).toContain("100")
    expect(stdout.text).toContain("daily")
  })

  test("an 8-character label is patched on the key's prefix", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "limit", "cov-main", "--tx-limit", "1.5", "--reset", "weekly"],
      createTestDeps({ fetch, store: createFakeStore(DEVICE) }),
    )
    expect(code).toBe(0)
    const patch = calls.find((call) => call.init.method === "PATCH")
    expect(patch?.url).toContain("/keys/xjxJTsc4")
    expect(patch?.url).not.toContain("/keys/cov-main")
    expect(JSON.parse(String(patch?.init.body))).toEqual({ txLimit: { usdMicros: 1_500_000, reset: "weekly" } })
  })

  test("--clear sends exactly { clearTxLimit: true }", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "limit", "agent-one", "--clear", "--json"],
      createTestDeps({ fetch, store: createFakeStore(DEVICE), stdout: createCapture() }),
    )
    expect(code).toBe(0)
    const patch = calls.find((call) => call.init.method === "PATCH")
    expect(JSON.parse(String(patch?.init.body))).toEqual({ clearTxLimit: true })
  })

  test("--tx-limit and --clear together are a usage error before any request", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "limit", "Ab3dEf9h", "--tx-limit", "10", "--clear"],
      createTestDeps({ fetch, store: createFakeStore(DEVICE) }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})
