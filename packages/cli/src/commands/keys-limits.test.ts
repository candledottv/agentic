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
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.method).toBe("PUT")
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      limits: [
        { asset: "sol", maxPerTxRaw: "1000000000" },
        { asset: "usdc", maxPerTxRaw: "50000000" },
      ],
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get("x-api-key")).toBe(API_KEY)
    expect(headers.get("authorization")).toBeNull()
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
