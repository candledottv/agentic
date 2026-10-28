/**
 * `candle setup`, driven through `run()`: the wizard that sequences authorize -> fund ->
 * connect -> verify. Tests pin the sequencing decisions, not the underlying commands (auth
 * login and doctor have their own suites): idempotent skip when already authorized, the
 * funding and brief output, setup's exit code being doctor's, and the human-only refusal of
 * --json.
 */
import { describe, expect, test } from "bun:test"
import { resolveApiKey } from "../deps"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

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
    await run(
      ["setup"],
      createTestDeps({ fetch, store: authorizedStore(), stdout, execPath: "/Users/a/.local/bin/candle" }),
    )

    const out = stdout.text
    expect(humanText(out)).toContain(humanText("Skipping login"))
    expect(out).toContain(SOL)
    expect(out).toContain(EVM)
    // The live identity (section 2) is followed by a blank line. The funding addresses stay
    // whole: they are what the operator pastes into the next command.
    expect(humanText(out)).toContain(
      humanText(
        `Profile none · Account AgentWa11et · api.alpha.candle.tv\n\n  Solana (send SOL here)  ${SOL}\n  Hood (send ETH here)    ${EVM}\n`,
      ),
    )
    expect(humanText(out)).toContain(humanText("Tell your agent"))
    expect(humanText(out)).toContain(humanText("/plugin marketplace add candledottv/agentic"))
    expect(humanText(out)).toContain(humanText("MCP (any client), paste into the host config"))
    expect(out).toContain('"command": "/Users/a/.local/bin/candle"')
    // The server is bundled into the binary, so setup no longer tells the operator to install a
    // Node runtime for the MCP host: there is nothing left to install.
    expect(humanText(out)).toContain(humanText("The MCP server is built into this binary"))
    expect(out).not.toContain("Node 18+")
    expect(out).toContain("/agents")
    // The four numbered stages appear in order.
    const order = ["1/4", "2/4", "3/4", "4/4"].map((mark) => out.indexOf(mark))
    expect(order.every((idx, i) => idx >= 0 && (i === 0 || idx > (order[i - 1] as number)))).toBe(true)
  })

  test("only interactive setup gets a header; no-color keeps it and plain/CI/pipes suppress it", async () => {
    let expectedCode: number | undefined
    for (const mode of ["tty", "no-color", "plain", "pipe", "CI", "no-input"]) {
      const { fetch } = armRoutes()
      const stdout = createCapture()
      const args = ["setup", ...(mode === "no-color" ? ["--no-color"] : mode === "plain" ? ["--plain"] : [])]
      const code = await run(
        args,
        createTestDeps({
          fetch,
          store: authorizedStore(),
          stdout,
          env: { TERM: "xterm-256color", ...(mode === "CI" ? { CI: "1" } : {}) },
          isTTY: { stdin: mode !== "no-input", stdout: mode !== "pipe", stderr: true },
          columns: { stdout: 40 },
        }),
      )
      expectedCode ??= code
      expect(code).toBe(expectedCode)
      expect(stdout.text.includes("┌")).toBe(mode === "tty" || mode === "no-color")
      if (mode !== "tty" && mode !== "no-input") expect(stdout.text).not.toContain("\x1b")
      expect(stdout.text).toContain(SOL)
      expect(stdout.text).toContain(EVM)
      expect(humanText(stdout.text)).toContain(humanText("Skipping login"))
      const sep = mode === "plain" || mode === "pipe" || mode === "CI" ? "-" : "·"
      expect(humanText(stdout.text)).toContain(
        humanText(
          `Account AgentWa11et ${sep} api.alpha.candle.tv\n\n  Solana (send SOL here)  ${SOL}\n  Hood (send ETH here)    ${EVM}\n`,
        ),
      )
    }
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
    expect(humanText(stdout.text)).toContain(humanText("failed checks"))
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

  test("a profile with a device token but no key: the nested login files the key under THAT profile and funding reads it", async () => {
    // The wizard's own precondition. Its nested `auth login` has to refresh the profile setup
    // already resolved: a login that invented a second name stored the new key somewhere step 2
    // does not look, so the funding read found no key and the wizard fell to its "could not read
    // the agent wallets" branch on a perfectly healthy account.
    const NEW_KEY = "cndl_live_setup_key"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () =>
        jsonResponse(200, {
          deviceCode: "dc_setup",
          userCode: "ABCD-1234",
          verificationUri: "https://candle.tv/dev/agent/device",
          verificationUriComplete: "https://candle.tv/dev/agent/device?code=ABCD-1234",
          expiresIn: 600,
          interval: 5,
        }),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: "cndl_dvc_setup",
          tokenPrefix: "dvcpref9",
          apiKey: { key: NEW_KEY, keyPrefix: "ck_livenn", embeddedWallet: "denied", scopes: ["launch:write"] },
        }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, {
          success: true,
          account: "AgentWa11et",
          wallets: { solana: { address: SOL, delegated: true }, evm: { address: EVM, delegated: true } },
        }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
      "/api/v1/agent/wallets/trading": () => jsonResponse(200, { success: true }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/status": () => jsonResponse(200, { ok: true }),
    })
    const store = createFakeStore({ "profile:production:device_token": "cndl_dvc_existing" })
    const config = createFakeConfigStore({
      profiles: { production: { deviceTokenPrefix: "dvcpref1" } },
      activeProfile: "production",
    })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout, ...config })

    const code = await run(["setup", "--no-browser"], deps)

    expect(code).toBe(0)
    expect(await resolveApiKey(deps, "production")).toBe(NEW_KEY)
    expect(Object.keys((await config.readConfig()).profiles ?? {})).toEqual(["production"])
    expect(stdout.text).toContain(SOL)
    expect(humanText(stdout.text)).toContain(humanText("Tell your agent"))
    expect(stdout.text).not.toContain("Could not read the agent wallets")
    // The console link comes from the portal origin the login just recorded ON THE PROFILE, not
    // from the legacy top-level field (absent here) and so not derived from the API host.
    const consoleLine = stdout.text.split("\n").find((line) => line.trimStart().startsWith("Console "))
    expect(consoleLine).toContain("https://candle.tv/agents")
    expect(consoleLine).not.toContain("alpha")
  })

  test("fresh install, no profiles at all: the nested login mints the profile step 2 has to read", async () => {
    // ctx.profile is undefined at dispatch here (no profiles exist yet), the true fresh-install
    // case. finishLogin derives "production" from the default API URL and makes it active, but
    // setup's OWN ctx.profile is still undefined for the rest of the run unless setup re-resolves
    // after the nested login -- otherwise step 2's resolveApiKey(deps, undefined) reads the
    // legacy flat ref, finds nothing, and degrades to "Could not read the agent wallets right now."
    const NEW_KEY = "cndl_live_fresh_key"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () =>
        jsonResponse(200, {
          deviceCode: "dc_fresh",
          userCode: "WXYZ-5678",
          verificationUri: "https://candle.tv/dev/agent/device",
          verificationUriComplete: "https://candle.tv/dev/agent/device?code=WXYZ-5678",
          expiresIn: 600,
          interval: 5,
        }),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: "cndl_dvc_fresh",
          tokenPrefix: "dvcpref2",
          apiKey: { key: NEW_KEY, keyPrefix: "ck_freshnn", embeddedWallet: "denied", scopes: ["launch:write"] },
        }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, {
          success: true,
          account: "AgentWa11et",
          wallets: { solana: { address: SOL, delegated: true }, evm: { address: EVM, delegated: true } },
        }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
      "/api/v1/agent/wallets/trading": () => jsonResponse(200, { success: true }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/status": () => jsonResponse(200, { ok: true }),
    })
    const store = createFakeStore()
    const config = createFakeConfigStore({})
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout, ...config })
    deps.promptLine = async () => "https://api.alpha.candle.tv"

    const code = await run(["setup", "--no-browser"], deps)

    expect(code).toBe(0)
    expect(stdout.text).not.toContain("Could not read the agent wallets")
    expect(stdout.text).toContain(SOL)
    expect(await resolveApiKey(deps, "production")).toBe(NEW_KEY)
    expect((await config.readConfig()).activeProfile).toBe("production")
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
    const code = await run(
      ["setup"],
      createTestDeps({ fetch, stdout, stderr, promptLine: async () => "https://api.alpha.candle.tv" }),
    )
    expect(code).not.toBe(0)
    expect(calls.some((c) => c.url.includes("/device/code"))).toBe(true)
    expect(humanText(stderr.text)).toContain(humanText("Setup stopped"))
    expect(stdout.text).not.toContain("Tell your agent")
  })
})
