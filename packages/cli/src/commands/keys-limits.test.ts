/**
 * `candle keys limits` (BE-2691, R54): per-asset caps over the profile's own API key, tighten only.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

const PREFIX = "Ab3dEf9h"
const API_KEY = `cndl_live_${PREFIX}${"q".repeat(35)}`

function ok() {
  return createRoutedFetch({
    [`/api/v1/agent/keys/${PREFIX}/limits`]: (req) =>
      jsonResponse(200, { success: true, keyPrefix: PREFIX, limits: JSON.parse(String(req.init.body)).limits }),
  })
}

describe("keys limits", () => {
  test("PUTs exactly { limits } with the API key, never the device token", async () => {
    const { fetch, calls } = ok()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ device_token: "cndl_dvc_x" }),
      stdout,
      env: { CANDLE_API_KEY: API_KEY },
    })
    expect(await run(["keys", "limits", PREFIX, "sol=1000000000", "USDC=50000000"], deps)).toBe(0)
    // BE-2677 (R32): under the CANDLE_API_KEY override the identity line asks the acting key which
    // account it is (a GET with the same key), so the call list holds that lookup plus the one PUT.
    // The lookup is intended; the contract under test is that exactly one PUT goes out and that
    // every request carries the API key, never the device token.
    const puts = calls.filter((c) => c.init.method === "PUT")
    expect(puts).toHaveLength(1)
    expect(calls.filter((c) => c.init.method !== "PUT")).toHaveLength(calls.length - 1)
    expect(JSON.parse(String(puts[0]?.init.body))).toEqual({
      limits: [
        { asset: "sol", maxPerTxRaw: "1000000000" },
        { asset: "usdc", maxPerTxRaw: "50000000" },
      ],
    })
    for (const call of calls) {
      const headers = new Headers(call.init.headers)
      expect(headers.get("x-api-key")).toBe(API_KEY)
      expect(headers.get("authorization")).toBeNull()
    }
    expect(stdout.text).toContain(PREFIX)
    expect(stdout.text).toContain("1000000000")
  })

  test("--json prints the stored limits", async () => {
    const { fetch } = ok()
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), stdout, env: { CANDLE_API_KEY: API_KEY } })
    expect(await run(["keys", "limits", PREFIX, "eth=5", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual({
      ok: true,
      keyPrefix: PREFIX,
      limits: [{ asset: "eth", maxPerTxRaw: "5" }],
    })
  })

  test.each([
    [["keys", "limits", PREFIX]],
    [["keys", "limits"]],
    [["keys", "limits", PREFIX, "doge=5"]],
    [["keys", "limits", PREFIX, "sol"]],
    [["keys", "limits", PREFIX, "sol=0"]],
    [["keys", "limits", PREFIX, "sol=1.5"]],
    [["keys", "limits", PREFIX, "sol=01"]],
    [["keys", "limits", PREFIX, "sol=-1"]],
    [["keys", "limits", PREFIX, "sol=1", "sol=2"]],
  ])("%j is a usage error before any request", async (argv) => {
    const { fetch, calls } = ok()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), env: { CANDLE_API_KEY: API_KEY } })
    expect(await run(argv, deps)).toBe(2)
    expect(calls).toHaveLength(0)
  })

  test("a profile with no API key stops before any request", async () => {
    const { fetch, calls } = ok()
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout })
    expect(await run(["keys", "limits", PREFIX, "sol=1", "--json"], deps)).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text).code).toBe("API_KEY_REQUIRED")
  })

  test("the server's LOOSEN_REQUIRES_SESSION names the owner's fix", async () => {
    const { fetch } = createRoutedFetch({
      [`/api/v1/agent/keys/${PREFIX}/limits`]: () =>
        jsonResponse(403, { success: false, error: { code: "LOOSEN_REQUIRES_SESSION", message: "no" } }),
    })
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), stderr, env: { CANDLE_API_KEY: API_KEY } })
    expect(await run(["keys", "limits", PREFIX, "sol=9"], deps)).toBe(1)
    expect(stderr.text).toContain("key manager")
    expect(stderr.text).toContain("nothing changed")
  })
})
