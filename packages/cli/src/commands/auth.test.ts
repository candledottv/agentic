/**
 * `auth login` / `auth status` / `auth logout`, driven through `run()` (the dispatch entry) so
 * these tests exercise exactly what a real invocation would, with a scripted fake fetch, an
 * in-memory store and config, and a fake clock so the poll loop's sleeps resolve instantly. See
 * task-3-brief.md Step 4's numbered comment for the binding login sequence these tests pin.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { SECRET_REFS } from "../secret-store"
import {
  createCapture,
  createFakeClock,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"
import { CLI_VERSION } from "../version"

const CODE_RESPONSE = {
  deviceCode: "dc_abc123",
  userCode: "ABCD-1234",
  verificationUri: "https://candle.tv/dev/agent/device",
  verificationUriComplete: "https://candle.tv/dev/agent/device?code=ABCD-1234",
  expiresIn: 600,
  interval: 5,
}

describe("auth login: state machine", () => {
  test("code issued -> pending -> slow_down (next poll waits the increased interval) -> success stores both credentials under SECRET_REFS, writes config, and names the backend and swap:write in the summary", async () => {
    const DEVICE_TOKEN = "cndl_dvc_FIXTURE_DEVICE_TOKEN_VALUE"
    const API_KEY = "ck_live_FIXTURE_API_KEY_VALUE"
    const scopes = ["launch:write", "launch:read", "activity:write", "swap:write"]

    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": [
        () => jsonResponse(400, { error: "authorization_pending" }),
        () => jsonResponse(400, { error: "slow_down" }),
        () =>
          jsonResponse(200, {
            deviceToken: DEVICE_TOKEN,
            tokenPrefix: "dvcpref1",
            apiKey: { key: API_KEY, keyPrefix: "ck_liveab", scopes },
          }),
      ],
    })

    const store = createFakeStore()
    const configStore = createFakeConfigStore()
    const clock = createFakeClock()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      backend: "keychain",
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      now: clock.now,
      sleep: clock.sleep,
      stdout,
    })

    const code = await run(["auth", "login"], deps)

    expect(code).toBe(0)
    expect(await store.get(SECRET_REFS.deviceToken)).toBe(DEVICE_TOKEN)
    expect(await store.get(SECRET_REFS.apiKey)).toBe(API_KEY)

    const config = await configStore.readConfig()
    expect(config.deviceTokenPrefix).toBe("dvcpref1")
    expect(config.keyPrefix).toBe("ck_liveab")
    expect(config.scopes).toEqual(scopes)

    // Sleep calls, in order: the initial 5s interval while pending, the SAME 5s interval again
    // for the poll that comes back slow_down (the increase only applies going forward), then the
    // INCREASED 10s interval for the next poll -- which succeeds. This is the load-bearing
    // assertion for "the next poll waits the increased interval".
    expect(clock.calls).toEqual([5000, 5000, 10000])

    expect(stdout.text).toContain("keychain")
    expect(stdout.text).toContain("swap:write")
    expect(stdout.text.toLowerCase()).toContain("fund")

    // The portal origin is taken from the API's own verificationUri, not derived from the API
    // URL, so `auth logout` later points at the portal this backend actually uses.
    expect(config.portalOrigin).toBe("https://candle.tv")
  })

  test("opens the browser with the verification URL unless --no-browser is passed; the URL is always printed either way", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: "cndl_dvc_x",
          tokenPrefix: "dvcpref1",
          apiKey: { key: "ck_live_x", keyPrefix: "ck_liveab", scopes: ["launch:write"] },
        }),
    })

    const openedWithBrowser: string[] = []
    const stdoutWithBrowser = createCapture()
    await run(
      ["auth", "login"],
      createTestDeps({ fetch, openBrowser: (url) => openedWithBrowser.push(url), stdout: stdoutWithBrowser }),
    )
    expect(openedWithBrowser).toEqual([CODE_RESPONSE.verificationUriComplete])
    expect(stdoutWithBrowser.text).toContain(CODE_RESPONSE.verificationUriComplete)

    const openedNoBrowser: string[] = []
    const stdoutNoBrowser = createCapture()
    await run(
      ["auth", "login", "--no-browser"],
      createTestDeps({ fetch, openBrowser: (url) => openedNoBrowser.push(url), stdout: stdoutNoBrowser }),
    )
    expect(openedNoBrowser).toEqual([])
    expect(stdoutNoBrowser.text).toContain(CODE_RESPONSE.verificationUriComplete)
  })
})

describe("auth login: clientName length cap", () => {
  // POST /device/code validates clientName at 64 characters against the RAW string, before it
  // sanitizes. A hostname over 47 characters pushed the default name past that cap, so the very
  // first command a user ever ran failed with an error that never mentioned --label.
  test("a hostname long enough to blow the cap is truncated, and login still succeeds", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: "cndl_dvc_x",
          tokenPrefix: "dvcpref1",
          apiKey: { key: "ck_live_x", keyPrefix: "ck_liveab", scopes: ["launch:write"] },
        }),
    })
    const deps = createTestDeps({ fetch, hostname: `${"very-long-host-name".repeat(5)}.internal` })

    const code = await run(["auth", "login"], deps)

    expect(code).toBe(0)
    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    const sent = JSON.parse(codeCall?.init.body as string) as { clientName: string }
    expect(sent.clientName.length).toBe(64)
    expect(sent.clientName.startsWith("candle-cli/")).toBe(true)
  })

  test("a short hostname is sent whole, not padded or trimmed to the cap", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, { deviceToken: "cndl_dvc_x", tokenPrefix: "dvcpref1", apiKey: null, apiKeyError: "none" }),
    })

    await run(["auth", "login"], createTestDeps({ fetch, hostname: "laptop" }))

    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    const sent = JSON.parse(codeCall?.init.body as string) as { clientName: string }
    expect(sent.clientName).toBe(`candle-cli/${CLI_VERSION}@laptop`)
  })

  test("an over-long --label is a usage error naming the flag and the limit, exit 2, with NO request made", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()

    const code = await run(["auth", "login", "--label", "x".repeat(65)], createTestDeps({ fetch, stderr }))

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--label")
    expect(stderr.text).toContain("64")
  })

  test("a --label exactly at the limit is accepted and sent verbatim", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, { deviceToken: "cndl_dvc_x", tokenPrefix: "dvcpref1", apiKey: null, apiKeyError: "none" }),
    })
    const label = "y".repeat(64)

    const code = await run(["auth", "login", "--label", label], createTestDeps({ fetch }))

    expect(code).toBe(0)
    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    expect((JSON.parse(codeCall?.init.body as string) as { clientName: string }).clientName).toBe(label)
  })
})

describe("auth login: terminal paths", () => {
  async function runWithTerminalError(rfcError: string): Promise<{ code: number; stderr: string }> {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () => jsonResponse(400, { error: rfcError }),
    })
    const stderr = createCapture()
    const code = await run(["auth", "login"], createTestDeps({ fetch, stderr }))
    return { code, stderr: stderr.text }
  }

  test("access_denied exits 1 with a denial message", async () => {
    const { code, stderr } = await runWithTerminalError("access_denied")
    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toContain("denied")
  })

  test("expired_token exits 1 with an expiry message", async () => {
    const { code, stderr } = await runWithTerminalError("expired_token")
    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toContain("expired")
  })

  test("invalid_grant exits 1 with an unknown-or-used message", async () => {
    const { code, stderr } = await runWithTerminalError("invalid_grant")
    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toContain("unknown")
  })

  test("the three terminal paths produce genuinely distinct messages, not one generic string", async () => {
    const denied = await runWithTerminalError("access_denied")
    const expired = await runWithTerminalError("expired_token")
    const invalidGrant = await runWithTerminalError("invalid_grant")
    const messages = new Set([denied.stderr, expired.stderr, invalidGrant.stderr])
    expect(messages.size).toBe(3)
  })
})

describe("auth login: provisioning failure", () => {
  test("apiKey:null + apiKeyError is NOT a login failure: stores the device token, exits 0, and points at keys create", async () => {
    const DEVICE_TOKEN = "cndl_dvc_FIXTURE_DEVICE_TOKEN_2"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          tokenPrefix: "dvcpref2",
          apiKey: null,
          apiKeyError: "No delegated launch wallet on file",
        }),
    })
    const store = createFakeStore()
    const configStore = createFakeConfigStore()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["auth", "login"], deps)

    expect(code).toBe(0)
    expect(await store.get(SECRET_REFS.deviceToken)).toBe(DEVICE_TOKEN)
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect(stdout.text).toContain("candle keys create")
    expect(stdout.text).toContain("No delegated launch wallet on file")

    // Fix round 1, item 4: no key was issued, so nothing was "Granted" -- the summary must not
    // claim otherwise, and config.scopes must not be persisted for a key that doesn't exist
    // (doctor would later report those scopes against whatever DIFFERENT key eventually gets
    // created).
    expect(stdout.text).not.toContain("Granted")
    const config = await configStore.readConfig()
    expect(config.scopes).toBeUndefined()
    expect(config.deviceTokenPrefix).toBe("dvcpref2")
  })
})

describe("auth login: --json", () => {
  test("stdout is exactly one parseable JSON value; no plaintext credentials leak into stdout or stderr; prefixes/scopes/backend present", async () => {
    const DEVICE_TOKEN = "cndl_dvc_FIXTURE_JSON_DEVICE_TOKEN"
    const API_KEY = "ck_live_FIXTURE_JSON_API_KEY"
    const scopes = ["launch:write", "swap:write"]
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          tokenPrefix: "dvcpref3",
          apiKey: { key: API_KEY, keyPrefix: "ck_livejj", scopes },
        }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, backend: "encrypted-file", stdout, stderr })

    const code = await run(["auth", "login", "--json"], deps)

    expect(code).toBe(0)
    // FIX 1: stdout must be parseable as-is -- the two progress lines ("Your device code:",
    // "Open this URL to approve:") must have gone to stderr instead, not been mixed into stdout.
    const parsed = JSON.parse(stdout.text)
    expect(parsed.backend).toBe("encrypted-file")
    expect(parsed.deviceTokenPrefix).toBe("dvcpref3")
    expect(parsed.apiKeyPrefix).toBe("ck_livejj")
    expect(parsed.scopes).toEqual(scopes)

    // FIX 2: reverting the redaction (JSON.stringify(rawBody)) would leak both plaintext
    // credentials right here.
    const combined = stdout.text + stderr.text
    expect(combined).not.toContain(DEVICE_TOKEN)
    expect(combined).not.toContain(API_KEY)
  })

  test("provisioning-failure case: apiKeyError is present in the parsed object, apiKeyPrefix is absent, no plaintext leaks", async () => {
    const DEVICE_TOKEN = "cndl_dvc_FIXTURE_JSON_DEVICE_TOKEN_2"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          tokenPrefix: "dvcpref4",
          apiKey: null,
          apiKeyError: "No delegated launch wallet on file",
        }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, stdout, stderr })

    const code = await run(["auth", "login", "--json"], deps)

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.deviceTokenPrefix).toBe("dvcpref4")
    expect(parsed.apiKeyPrefix).toBeUndefined()
    expect(parsed.apiKeyError).toBe("No delegated launch wallet on file")

    const combined = stdout.text + stderr.text
    expect(combined).not.toContain(DEVICE_TOKEN)
  })
})

describe("auth logout", () => {
  test("revokes the stored key via DELETE /keys/<prefix> with the device token, clears both refs and config, and prints the portal URL and the session-only explanation", async () => {
    const DEVICE_TOKEN = "cndl_dvc_FIXTURE_LOGOUT_TOKEN"
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/ck_liveab": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: DEVICE_TOKEN, api_key: "ck_live_something" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveab", deviceTokenPrefix: "dvcpref1" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["auth", "logout"], deps)

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/api/v1/agent/keys/ck_liveab")
    expect(calls[0]?.init.method).toBe("DELETE")
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
    expect(headers["x-api-key"]).toBeUndefined()

    expect(await store.get(SECRET_REFS.deviceToken)).toBeNull()
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect(await configStore.readConfig()).toEqual({})

    expect(stdout.text).toContain("/dev/agent")
    expect(stdout.text.toLowerCase()).toContain("session")
    // The claim is narrowed to what is actually true: GET /keys carries mintedByDevicePrefix and
    // IS device-token-readable, so sibling prefixes are visible. What the session-only routes
    // withhold is device metadata and the ability to revoke a sibling.
    expect(stdout.text).not.toContain("enumerate")
    expect(stdout.text).toContain("revoke a sibling device")
  })

  test("points at the portal origin recorded at login, not one derived from the API host", async () => {
    // The staging shape: API at staging.api.candle.tv, portal at staging.candle.tv. The stored
    // origin comes from the API's own verificationUri, so it is right without any derivation.
    const { fetch } = createRoutedFetch({})
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const configStore = createFakeConfigStore({ portalOrigin: "https://staging.candle.tv" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      env: { CANDLE_API_URL: "https://staging.api.candle.tv" },
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["auth", "logout"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain("https://staging.candle.tv/dev/agent")
    expect(stdout.text).not.toContain("staging.api.candle.tv")
  })

  test("with no recorded portal origin, the fallback derivation still names the portal, not the API host", async () => {
    const { fetch } = createRoutedFetch({})
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      env: { CANDLE_API_URL: "https://staging.api.candle.tv" },
      stdout,
    })

    const code = await run(["auth", "logout"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain("https://staging.candle.tv/dev/agent")
  })

  test("names any env-var credential still live in this shell, which clearing the store does not touch", async () => {
    const { fetch } = createRoutedFetch({})
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      env: { CANDLE_DEVICE_TOKEN: "cndl_dvc_from_env", CANDLE_API_KEY: "ck_live_from_env" },
      stdout,
    })

    const code = await run(["auth", "logout"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain("CANDLE_DEVICE_TOKEN")
    expect(stdout.text).toContain("CANDLE_API_KEY")
    // The values themselves are never echoed, only the variable names.
    expect(stdout.text).not.toContain("cndl_dvc_from_env")
    expect(stdout.text).not.toContain("ck_live_from_env")
  })

  test("says nothing about env overrides when none are set", async () => {
    const { fetch } = createRoutedFetch({})
    const stdout = createCapture()

    const code = await run(["auth", "logout"], createTestDeps({ fetch, stdout }))

    expect(code).toBe(0)
    expect(stdout.text).not.toContain("CANDLE_DEVICE_TOKEN")
    expect(stdout.text).not.toContain("CANDLE_API_KEY")
  })

  test("--keep-key skips the DELETE call but still clears local credentials and config", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/ck_liveab": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveab" })
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
    })

    const code = await run(["auth", "logout", "--keep-key"], deps)

    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(await store.get(SECRET_REFS.deviceToken)).toBeNull()
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect(await configStore.readConfig()).toEqual({})
  })

  test("logout with no stored key prefix never attempts a DELETE (nothing to revoke)", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const deps = createTestDeps({ fetch, store })

    const code = await run(["auth", "logout"], deps)

    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("a typo'd --keep-keys is a usage error, exit 2, and issues NO remote call -- it must never fall through to the destructive default of proceeding with the revoke (fix round 1, item 3)", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/ck_liveab": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveab" })
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stderr,
    })

    const code = await run(["auth", "logout", "--keep-keys"], deps)

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--keep-keys")
    // Nothing was cleared either: a rejected invocation must not have any side effect at all.
    expect(await store.get(SECRET_REFS.deviceToken)).toBe("cndl_dvc_x")
    expect((await configStore.readConfig()).keyPrefix).toBe("ck_liveab")
  })
})

describe("auth status", () => {
  test("both credentials present and valid: two PASS rows, exit 0", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("PASS")
    expect(stdout.text).not.toContain("FAIL")
  })

  test("names the account these credentials act as, not just that they are valid", async () => {
    // The 2026-08-19 case: both rows read PASS while an EVM import had landed on a different
    // account than the operator believed. Valid-but-wrong-account is the failure this command is
    // reached for, so the account has to be on screen.
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "FaKwE2xX", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account: FaKwE2xX")
  })

  test("an unreachable identity lookup degrades to unknown rather than failing the report", async () => {
    // Absence of evidence again: a 500 on the identity call says nothing about the credentials,
    // and must not turn a credential report into a failure.
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(500, { success: false }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account: unknown")
    expect(stdout.text).not.toContain("FAIL")
  })

  test("a missing credential SKIPs its row rather than failing, and does not fail the exit code", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const code = await run(["auth", "status"], createTestDeps({ fetch, store }))
    expect(code).toBe(0)
  })

  test("--json rows use the same {check, state, detail} shape doctor's rows use (fix round 1, item 11)", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status", "--json"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.rows).toHaveLength(2)
    for (const row of parsed.rows) {
      expect(Object.keys(row).sort()).toEqual(["check", "detail", "state"])
    }
  })

  test("an invalid device token FAILs its row and the command exits 1", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(401, {
          success: false,
          error: { code: "DEVICE_TOKEN_INVALID", message: "Invalid or revoked device token" },
        }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(1)
    expect(stdout.text).toContain("FAIL")
    expect(stdout.text).toContain("candle auth login")
  })
})
