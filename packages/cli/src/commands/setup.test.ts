/**
 * `candle setup`, driven through `run()`: the wizard that sequences authorize -> fund ->
 * connect -> verify. Tests pin the sequencing decisions, not the underlying commands (auth
 * login and doctor have their own suites): idempotent skip when already authorized, the
 * funding and brief output, setup's exit code being doctor's, and the human-only refusal of
 * --json.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

const SOL = "vP5sRxZFRxTdwtLADe4NxhiqNosJb2guRCYphojbG4j"
const EVM = "0x00000000000000000000000000000000000000A1"

/** Routes the authorized-path wizard needs: embedded wallets + doctor's own probes. Doctor's
 * checks hit several endpoints; answering 200 generically keeps its table all-PASS without
 * re-testing doctor here. */
function armRoutes() {
  return createRoutedFetch({
    "/api/v1/agent/wallets/embedded": () =>
      jsonResponse(200, {
        success: true,
        account: "AgentWa11et",
        wallets: { solana: { address: SOL, delegated: true }, evm: { address: EVM, delegated: true } },
      }),
    "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    "/api/v1/agent/device/tokens": () => jsonResponse(200, { success: true, tokens: [] }),
    "/api/v1/status": () => jsonResponse(200, { ok: true }),
    "/api/v1/agent/wallets": () => jsonResponse(200, { success: true, page: [], isDone: true, continueCursor: null }),
  })
}

function authorizedStore() {
  return createFakeStore({ device_token: "cndl_dvc_x", api_key: "cndl_live_key" })
}

describe("setup", () => {
  test("already authorized: skips login, prints funding addresses and the agent brief, links the console", async () => {
    const { fetch } = armRoutes()
    const stdout = createCapture()
    await run(["setup"], createTestDeps({ fetch, store: authorizedStore(), stdout }))

    const out = stdout.text
    expect(out).toContain("Skipping login")
    expect(out).toContain(SOL)
    expect(out).toContain(EVM)
    expect(out).toContain("Tell your agent")
    expect(out).toContain("/plugin marketplace add candledottv/agentic")
    expect(out).toContain("candle mcp --print-config")
    expect(out).toContain("/dev/agent")
    // The four numbered stages appear in order.
    const order = ["1/4", "2/4", "3/4", "4/4"].map((mark) => out.indexOf(mark))
    expect(order.every((idx, i) => idx >= 0 && (i === 0 || idx > (order[i - 1] as number)))).toBe(true)
  })

  test("setup's exit code is doctor's: a failing check fails setup", async () => {
    // No routes at all: doctor's API-reachability checks fail, so its exit is nonzero -- and
    // setup must surface that rather than reporting a green wizard over a red rail.
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: SOL, delegated: true }, evm: null } }),
    })
    const stdout = createCapture()
    const code = await run(["setup"], createTestDeps({ fetch, store: authorizedStore(), stdout }))
    expect(code).not.toBe(0)
    expect(stdout.text).toContain("failed checks")
  })

  test("--json is refused: the wizard is human-only, with guidance to the composable commands", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stdout = createCapture()
    const code = await run(["setup", "--json"], createTestDeps({ fetch, store: authorizedStore(), stdout }))
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("USAGE")
    expect(envelope.message).toContain("doctor --json")
  })

  test("an unknown flag is a usage error before anything runs", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const code = await run(["setup", "--frobnicate"], createTestDeps({ fetch, store: authorizedStore() }))
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  test("unauthorized: the wizard starts the device flow (login is step 1)", async () => {
    // Login's own success path is auth.test.ts's territory; here it is enough to observe that
    // setup reaches for POST /device/code when no credentials are stored, and stops when that
    // fails rather than plowing on to funding output.
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(500, { success: false, error: { message: "down" } }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(["setup"], createTestDeps({ fetch, stdout, stderr }))
    expect(code).not.toBe(0)
    expect(calls.some((c) => c.url.includes("/device/code"))).toBe(true)
    expect(stderr.text).toContain("Setup stopped")
    expect(stdout.text).not.toContain("Tell your agent")
  })
})
