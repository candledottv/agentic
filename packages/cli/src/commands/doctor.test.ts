/**
 * `doctor`, driven through `run()`. Every check is scripted against a fake fetch (see
 * task-3-brief.md's checklist: runtime version, backend, credentials present, API reachable,
 * device token valid, agent key valid, launch wallet delegated) so the PASS/FAIL/SKIP table and
 * the nonzero-on-any-FAIL exit code are exercised deterministically.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

describe("doctor", () => {
  test("renders a PASS/FAIL/SKIP table and exits 1 when any check FAILs; the FAIL line names its fix", async () => {
    const { fetch, unmatched } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
      "/api/v1/agent/keys": () =>
        jsonResponse(401, {
          success: false,
          error: { code: "DEVICE_TOKEN_INVALID", message: "Invalid or revoked device token" },
        }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: "abc", delegated: false }, evm: null } }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["doctor"], deps)

    expect(code).toBe(1)
    expect(stdout.text).toContain("PASS")
    expect(stdout.text).toContain("FAIL")
    expect(stdout.text).toContain("candle auth login")
    expect(unmatched).toHaveLength(0)
  })

  test("all checks passing exits 0 with no FAIL rows", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [], tier: "free" }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: "abc", delegated: true }, evm: null } }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["doctor"], deps)

    expect(code).toBe(0)
    expect(stdout.text).not.toContain("FAIL")
  })

  test("missing credentials SKIP the checks that need them rather than FAILing, but credentials-present itself FAILs with no device token at all", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
    })
    const store = createFakeStore()
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["doctor"], deps)

    expect(code).toBe(1)
    expect(stdout.text).toContain("SKIP")
    expect(stdout.text).toContain("FAIL")
  })

  // Fix round 1, item 6: a mutant that FAILs the exit code on ANY SKIP (not just on an actual
  // FAIL) would pass every test above (they all also contain a genuine FAIL row) but would be
  // caught here, where SKIPs exist and nothing actually fails.
  test("SKIPs alone (a device token but no API key yet) never fail the exit code -- only an actual FAIL does", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [], tier: "free" }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["doctor"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain("SKIP")
    expect(stdout.text).not.toContain("FAIL")
  })

  // The agent-key row probes GET /agent/tier, which is behind requireAgentKey("launch:write").
  // A valid activity-only key therefore FAILs it, so the row has to say which scope it proves and
  // the FAIL has to carry a fix, not just "this key lacks the launch:write scope".
  test("the agent-key row names the scope it proves, and a SCOPE_MISSING 403 FAILs with a fix line", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [], tier: "free" }),
      "/api/v1/agent/tier": () =>
        jsonResponse(403, {
          success: false,
          error: { code: "SCOPE_MISSING", message: "This key lacks the launch:write scope" },
        }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: "abc", delegated: true }, evm: null } }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_activity_only" })
    const stdout = createCapture()

    const code = await run(["doctor"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(1)
    const row = stdout.text.split("\n").find((line) => line.startsWith("API key valid (launch:write)"))
    expect(row).toBeDefined()
    expect(row).toContain("FAIL")
    expect(row).toContain("candle keys create --scopes")
    expect(row).toContain("candle keys list")
  })

  test("the runtime-version check FAILs when the injected node version is below the minimum, and PASSes on a real modern version", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
    })

    const stdoutOld = createCapture()
    const oldCode = await run(["doctor"], createTestDeps({ fetch, stdout: stdoutOld, nodeVersion: "16.20.0" }))
    expect(oldCode).toBe(1)
    expect(stdoutOld.text).toContain("Runtime version")
    expect(stdoutOld.text).toContain("FAIL")
    expect(stdoutOld.text).toContain("16.20.0")
    expect(stdoutOld.text).toContain("upgrade Node.js")

    const stdoutNew = createCapture()
    const newCode = await run(["doctor"], createTestDeps({ fetch, stdout: stdoutNew, nodeVersion: "22.1.0" }))
    // Runtime version alone doesn't determine the overall exit code (no credentials configured
    // either, which FAILs "Credentials present" independently) -- assert the ROW, not the code.
    expect(newCode).toBe(1)
    const runtimeLine = stdoutNew.text.split("\n").find((line) => line.startsWith("Runtime version"))
    expect(runtimeLine).toContain("PASS")
  })
})
