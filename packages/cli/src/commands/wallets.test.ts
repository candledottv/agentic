/**
 * `wallets`, driven through `run()`: fetches embedded (launch) wallets and linked wallets with
 * the agent key. Not in task-3-brief.md's required coverage list, but covered here for the same
 * reason every other command is: it is a real, user-facing command surface.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

describe("wallets", () => {
  test("prints embedded and linked wallets using the agent key", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, {
          success: true,
          wallets: { solana: { address: "So1anaAddr", delegated: true }, evm: null },
        }),
      "/api/v1/agent/wallets": () =>
        jsonResponse(200, {
          success: true,
          page: [{ _id: "lw_listed01", address: "0xLinked", chain: "evm", label: "my wallet" }],
          isDone: true,
          continueCursor: null,
        }),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>
      expect(headers["x-api-key"]).toBe("ck_live_x")
    }
    expect(stdout.text).toContain("So1anaAddr")
    expect(stdout.text).toContain("0xLinked")
    // The row id renders: it is the handle wallets revoke and the trade API's linkedWalletId take.
    expect(stdout.text).toContain("lw_listed01")
  })

  test("requires an API key; without one it fails without making a request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, stderr }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text.toLowerCase()).toContain("keys create")
  })

  test("the missing-API-key exit honors --json: stdout parses, and carries the code", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(["wallets", "--json"], createTestDeps({ fetch, stderr }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stderr.text)).toEqual({
      ok: false,
      code: "NO_API_KEY",
      message: "No API key available. Run: candle keys create",
    })
  })

  // GET /wallets sits behind requireAgentKey("launch:write"), so an activity-only key gets a 403
  // here. Without the SCOPE_MISSING mapping that printed a statement of fact with no next step.
  test("a 403 SCOPE_MISSING on the linked-wallets call keeps the scope name and adds the fix commands", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: "So1", delegated: true }, evm: null } }),
      "/api/v1/agent/wallets": () =>
        jsonResponse(403, {
          success: false,
          error: { code: "SCOPE_MISSING", message: "This key lacks the launch:write scope" },
        }),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stderr = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stderr }))

    expect(code).toBe(1)
    expect(stderr.text).toContain("launch:write")
    expect(stderr.text).toContain("candle keys create --scopes")
    expect(stderr.text).toContain("candle keys list")
  })
})
