/**
 * `auth login` / `auth status` / `auth logout`, driven through `run()` (the dispatch entry) so
 * these tests exercise exactly what a real invocation would, with a scripted fake fetch, an
 * in-memory store and config, and a fake clock so the poll loop's sleeps resolve instantly. See
 * task-3-brief.md Step 4's numbered comment for the binding login sequence these tests pin.
 */

import { describe, expect, test } from "bun:test"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import { run } from "../index"
import { displayWidth } from "../presentation"
import { SECRET_REFS } from "../secret-store"
import type { RouteHandler } from "../test-support"
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
import { authLogin, authLogout } from "./auth"

const CODE_RESPONSE = {
  deviceCode: "dc_abc123",
  userCode: "ABCD-1234",
  verificationUri: "https://candle.tv/dev/agent/device",
  verificationUriComplete: "https://candle.tv/dev/agent/device?code=ABCD-1234",
  expiresIn: 600,
  interval: 5,
}

const DEVICE_TOKEN = "cndl_dvc_PROFILE_FIXTURE_TOKEN"
const API_KEY = "ck_live_PROFILE_FIXTURE_KEY"

/** The happy-path device/code + device/token routes shared by every test that just needs a
 * login to succeed, without exercising the state machine itself (that is
 * `describe("auth login: state machine", ...)`'s job). */
function deviceFlowRoutes(): Record<string, RouteHandler> {
  return {
    "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
    "/api/v1/agent/device/token": () =>
      jsonResponse(200, {
        deviceToken: DEVICE_TOKEN,
        tokenPrefix: "dvcprofl",
        apiKey: { key: API_KEY, keyPrefix: "ck_livepr", embeddedWallet: "denied", scopes: ["launch:write"] },
      }),
  }
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
            apiKey: { key: API_KEY, keyPrefix: "ck_liveab", embeddedWallet: "denied", scopes },
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
      updateProfile: configStore.updateProfile,
      now: clock.now,
      sleep: clock.sleep,
      stdout,
    })

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv"], deps)

    expect(code).toBe(0)
    // No --profile and no existing profiles: the name is derived from the (default) API host --
    // DEFAULT_API_URL's host maps to "production" (defaultProfileNameFor, client.ts).
    expect(await store.get("profile:production:device_token")).toBe(DEVICE_TOKEN)
    expect(await store.get("profile:production:api_key")).toBe(API_KEY)

    const config = await configStore.readConfig()
    const profile = config.profiles?.production
    expect(profile?.deviceTokenPrefix).toBe("dvcpref1")
    expect(profile?.keyPrefix).toBe("ck_liveab")
    expect(profile?.scopes).toEqual(scopes)
    expect(config.activeProfile).toBe("production")

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
    expect(profile?.portalOrigin).toBe("https://candle.tv")
  })

  test("a re-login clears a cached username when the account has since removed its handle", async () => {
    // The profile cached the handle "bob"; the live lookup on re-login names the account but returns
    // no username. The cache write includes `username` unconditionally, so the undefined live value
    // (dropped by the config's JSON write) clears the stale handle rather than keeping it.
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "ACC1", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore()
    const configStore = createFakeConfigStore({
      profiles: { production: { account: "ACC1", username: "bob", accountCachedAt: 1 } },
      activeProfile: "production",
    })
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      updateProfile: configStore.updateProfile,
      stdout: createCapture(),
    })

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv"], deps)
    expect(code).toBe(0)
    const config = await configStore.readConfig()
    expect(config.profiles?.production?.account).toBe("ACC1")
    expect(config.profiles?.production?.username).toBeUndefined()
  })

  test("opens the browser with the verification URL unless --no-browser is passed; the URL is always printed either way", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: "cndl_dvc_x",
          tokenPrefix: "dvcpref1",
          apiKey: { key: "ck_live_x", keyPrefix: "ck_liveab", embeddedWallet: "denied", scopes: ["launch:write"] },
        }),
    })

    const openedWithBrowser: string[] = []
    const stdoutWithBrowser = createCapture()
    await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv"],
      createTestDeps({ fetch, openBrowser: (url) => openedWithBrowser.push(url), stdout: stdoutWithBrowser }),
    )
    expect(openedWithBrowser).toEqual([CODE_RESPONSE.verificationUriComplete])
    expect(stdoutWithBrowser.text).toContain(CODE_RESPONSE.verificationUriComplete)

    const openedNoBrowser: string[] = []
    const stdoutNoBrowser = createCapture()
    await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser"],
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
          apiKey: { key: "ck_live_x", keyPrefix: "ck_liveab", embeddedWallet: "denied", scopes: ["launch:write"] },
        }),
    })
    const deps = createTestDeps({ fetch, hostname: `${"very-long-host-name".repeat(5)}.internal` })

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv"], deps)

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

    await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv"],
      createTestDeps({ fetch, hostname: "laptop" }),
    )

    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    const sent = JSON.parse(codeCall?.init.body as string) as { clientName: string }
    expect(sent.clientName).toBe(`candle-cli/${CLI_VERSION}@laptop`)
  })

  test("an over-long --label is a usage error naming the flag and the limit, exit 2, with NO request made", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "x".repeat(65)],
      createTestDeps({ fetch, stderr }),
    )

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

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", label],
      createTestDeps({ fetch }),
    )

    expect(code).toBe(0)
    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    expect((JSON.parse(codeCall?.init.body as string) as { clientName: string }).clientName).toBe(label)
  })
})

describe("auth login: --label names the key as well as the device", () => {
  const KEY_PATH = "/api/v1/agent/keys/ck_livepr"
  const LABEL_TOKEN = "cndl_dvc_LABEL_FIXTURE_TOKEN"

  function labelRoutes(
    patch: RouteHandler | undefined,
    apiKey: { key: string; keyPrefix: string; scopes: string[]; embeddedWallet?: string } | null = {
      key: "ck_live_LABEL_FIXTURE_KEY",
      keyPrefix: "ck_livepr",
      embeddedWallet: "denied",
      // The device flow's stored order, so the summary's sort is visible.
      scopes: ["launch:write", "launch:read", "account:read", "activity:write", "swap:write", "transfer:write"],
    },
  ): Record<string, RouteHandler> {
    return {
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: LABEL_TOKEN,
          tokenPrefix: "dvclabel",
          apiKey,
          ...(apiKey ? {} : { apiKeyError: "No delegated wallet yet." }),
        }),
      ...(patch ? { [KEY_PATH]: patch } : {}),
    }
  }

  const patchCalls = (calls: Array<{ url: string; init: RequestInit }>) =>
    calls.filter((call) => new URL(call.url).pathname.startsWith("/api/v1/agent/keys/"))

  test("one PATCH { label } over the new device token, and the name is reported", async () => {
    const { fetch, calls } = createRoutedFetch(labelRoutes(() => jsonResponse(200, { success: true })))
    const store = createFakeStore()
    const stdout = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "  vault-promote  "],
      createTestDeps({ fetch, store, stdout }),
    )

    expect(code).toBe(0)
    const patches = patchCalls(calls)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.init.method).toBe("PATCH")
    expect(new URL(patches[0]?.url ?? "").pathname).toBe(KEY_PATH)
    expect(JSON.parse(patches[0]?.init.body as string)).toEqual({ label: "vault-promote" })
    expect((patches[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${LABEL_TOKEN}`)
    // The device keeps the same name, trimmed like the key's.
    const codeCall = calls.find((call) => call.url.includes("/device/code"))
    expect((JSON.parse(codeCall?.init.body as string) as { clientName: string }).clientName).toBe("vault-promote")
    expect(stdout.text).toContain("API key prefix       ck_livepr\n  API key name         vault-promote\n")
    expect(stdout.text).toContain(
      "Granted scopes\n    account:read\n    activity:write\n    launch:read\n    launch:write\n    swap:write      moves funds",
    )
  })

  test("BE-503: the key's embedded-wallet value is reported, in text and in --json", async () => {
    for (const embeddedWallet of ["denied", "allowed"] as const) {
      const apiKey = {
        key: "ck_live_LABEL_FIXTURE_KEY",
        keyPrefix: "ck_livepr",
        scopes: ["swap:write"],
        embeddedWallet,
      }
      // A key ends allowed only when the operator asked for it and confirmed at a terminal.
      const flags = embeddedWallet === "allowed" ? ["--embedded-wallet", "allow"] : []
      const text = createCapture()
      const { fetch } = createRoutedFetch(labelRoutes(undefined, apiKey))
      const textDeps = createTestDeps({ fetch, stdout: text })
      textDeps.promptLine = async () => "y"
      expect(await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv", ...flags], textDeps)).toBe(0)
      expect(text.text).toContain(`Embedded wallet      ${embeddedWallet}`)
      const json = createCapture()
      const again = createRoutedFetch(labelRoutes(undefined, apiKey))
      const jsonDeps = createTestDeps({ fetch: again.fetch, stdout: json })
      jsonDeps.promptLine = async () => "y"
      expect(
        await run(["--json", "auth", "login", "--api-url", "https://api.alpha.candle.tv", ...flags], jsonDeps),
      ).toBe(0)
      expect((JSON.parse(json.text) as Record<string, unknown>).embeddedWallet).toBe(embeddedWallet)
    }
    // An API that reports nothing and cannot be corrected leaves the deny unconfirmed: fail closed.
    const old = createCapture()
    const { fetch } = createRoutedFetch(
      labelRoutes(undefined, { key: "ck_live_x", keyPrefix: "ck_livepr", scopes: ["swap:write"] }),
    )
    expect(
      await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv"], createTestDeps({ fetch, stdout: old })),
    ).toBe(1)
    expect(old.text).not.toContain("Device authorized")
  })

  test("--json carries apiKeyLabel", async () => {
    const { fetch } = createRoutedFetch(labelRoutes(() => jsonResponse(200, { success: true })))
    const stdout = createCapture()

    const code = await run(
      ["--json", "auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "vault-promote"],
      createTestDeps({ fetch, stdout }),
    )

    expect(code).toBe(0)
    const out = JSON.parse(stdout.text) as Record<string, unknown>
    expect(out.apiKeyLabel).toBe("vault-promote")
    expect("apiKeyLabelError" in out).toBe(false)
  })

  test("a failed rename never fails the login: credentials stored, the reason and the key manager named", async () => {
    const { fetch } = createRoutedFetch(
      labelRoutes(() => jsonResponse(500, { success: false, error: { code: "INTERNAL", message: "boom" } })),
    )
    const store = createFakeStore()
    const stdout = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "vault-promote"],
      createTestDeps({ fetch, store, stdout }),
    )

    expect(code).toBe(0)
    expect(await store.get("profile:production:device_token")).toBe(LABEL_TOKEN)
    expect(await store.get("profile:production:api_key")).toBe("ck_live_LABEL_FIXTURE_KEY")
    expect(stdout.text).not.toContain("API key name:")
    expect(stdout.text).toContain("API key prefix       ck_livepr")
    expect(stdout.text).toContain(
      "\n  ! Could not name the key: boom.\n    Name it in the key manager: https://candle.tv/dev/agent\n\n",
    )
  })

  test("a thrown rename (network) is reported in --json as apiKeyLabelError, never apiKeyLabel", async () => {
    // No route for the PATCH: the fake fetch throws, which is what a dropped connection looks like.
    const { fetch } = createRoutedFetch(labelRoutes(undefined))
    const stdout = createCapture()

    const code = await run(
      ["--json", "auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "vault-promote"],
      createTestDeps({ fetch, stdout }),
    )

    expect(code).toBe(0)
    const out = JSON.parse(stdout.text) as Record<string, unknown>
    expect(typeof out.apiKeyLabelError).toBe("string")
    expect("apiKeyLabel" in out).toBe(false)
  })

  test("no key in the exchange: no PATCH", async () => {
    const { fetch, calls } = createRoutedFetch(labelRoutes(() => jsonResponse(200, { success: true }), null))

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "vault-promote"],
      createTestDeps({ fetch }),
    )

    expect(code).toBe(0)
    expect(patchCalls(calls)).toHaveLength(0)
  })

  // Key default without transfer (2026-10-08 spec, section 6): a scope-less login whose key was
  // not issued yet reports what the device route will grant, the Write preset, not every scope.
  test("no key and no --scopes: the authorized scopes are Write, without transfer", async () => {
    const { fetch } = createRoutedFetch(labelRoutes(undefined, null))
    const stdout = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv"],
      createTestDeps({ fetch, stdout }),
    )

    expect(code).toBe(0)
    const line = stdout.text.split("Authorized scopes (no key issued yet)\n")[1] ?? ""
    expect(line).toContain("    account:read\n    activity:write\n    launch:read\n    launch:write\n    swap:write")
    expect(line).not.toContain("transfer:write")
    expect(line).not.toContain("transfer:bound")
  })

  test("no --label: no PATCH, and neither new line nor field", async () => {
    const { fetch, calls } = createRoutedFetch(labelRoutes(() => jsonResponse(200, { success: true })))
    const stdout = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv"],
      createTestDeps({ fetch, stdout }),
    )

    expect(code).toBe(0)
    expect(patchCalls(calls)).toHaveLength(0)
    expect(stdout.text).not.toContain("API key name:")
    expect(stdout.text).not.toContain("Could not name the key")
  })

  test("a blank --label is a usage error, exit 2, before any request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--label", "   "],
      createTestDeps({ fetch, stderr }),
    )

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--label must be 1 to 64 characters.")
  })
})

describe("auth login: terminal paths", () => {
  async function runWithTerminalError(rfcError: string): Promise<{ code: number; stderr: string }> {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () => jsonResponse(400, { error: rfcError }),
    })
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv"],
      createTestDeps({ fetch, stderr }),
    )
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
      updateProfile: configStore.updateProfile,
      stdout,
    })

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv"], deps)

    expect(code).toBe(0)
    expect(await store.get("profile:production:device_token")).toBe(DEVICE_TOKEN)
    expect(await store.get("profile:production:api_key")).toBeNull()
    expect(stdout.text).toContain("candle keys create")
    expect(stdout.text).toContain("No delegated launch wallet on file")

    // Fix round 1, item 4: no key was issued, so nothing was "Granted" -- the summary must not
    // claim otherwise, and the profile's scopes must not be persisted for a key that doesn't
    // exist (doctor would later report those scopes against whatever DIFFERENT key eventually
    // gets created).
    expect(stdout.text).not.toContain("Granted")
    const config = await configStore.readConfig()
    const profile = config.profiles?.production
    expect(profile?.scopes).toBeUndefined()
    expect(profile?.deviceTokenPrefix).toBe("dvcpref2")
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
          apiKey: { key: API_KEY, keyPrefix: "ck_livejj", embeddedWallet: "denied", scopes },
        }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, backend: "encrypted-file", stdout, stderr })

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--json"], deps)

    expect(code).toBe(0)
    // FIX 1: stdout must be parseable as-is -- the two progress lines ("Your device code:",
    // "Open this URL to approve:") must have gone to stderr instead, not been mixed into stdout.
    const parsed = JSON.parse(stdout.text)
    expect(parsed.backend).toBe("encrypted-file")
    expect(parsed.deviceTokenPrefix).toBe("dvcpref3")
    expect(parsed.apiKeyPrefix).toBe("ck_livejj")
    expect(parsed.scopes).toEqual(scopes)
    expect(stderr.text).toBe(
      `API: https://api.alpha.candle.tv\nYour device code: ${CODE_RESPONSE.userCode}\nOpen this URL to approve: ${CODE_RESPONSE.verificationUriComplete}\n`,
    )

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

    const code = await run(["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--json"], deps)

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

    // `keyPrefix`/`deviceTokenPrefix` in the seed are pre-profile fields, so `run()`'s migration
    // step turns this into profile "default" before logout ever runs. Logout clears THAT
    // profile's refs and entry AND the legacy refs and prefixes it was migrated from: migration
    // COPIES the secrets, so a logout that spared the originals would leave a live device token
    // in the store that the very next command falls back to once the profile is gone.
    expect(await store.get("profile:default:device_token")).toBeNull()
    expect(await store.get("profile:default:api_key")).toBeNull()
    expect(await store.get(SECRET_REFS.deviceToken)).toBeNull()
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect(await configStore.readConfig()).toEqual({ profiles: {} })

    expect(stdout.text).toContain("/agents")
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
    // Asserted on the Portal line itself rather than on the whole of stdout: the identity line
    // logout now prints ahead of everything names the API host legitimately, and the claim here
    // was only ever about the portal pointer not being derived from it.
    expect(stdout.text.split("\n").find((line) => line.startsWith("  Connected devices  "))).toBe(
      "  Connected devices  https://staging.candle.tv/agents?tab=keys#connected-devices",
    )
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
    expect(stdout.text).toContain("https://staging.candle.tv/agents")
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
    // Anchored on the literal notice line, not just the variable names: the identity line prints
    // them too, so a test that only checked for the names would not notice this notice vanishing.
    expect(stdout.text).toContain("Still set in this shell: CANDLE_API_KEY, CANDLE_DEVICE_TOKEN")
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
    // `keyPrefix` in the seed is a pre-profile field, so this migrates to profile "default"
    // before logout runs. --keep-key is about the REMOTE revoke only: locally it still clears
    // everything, the legacy refs the migration copied from included.
    expect(await store.get("profile:default:device_token")).toBeNull()
    expect(await store.get("profile:default:api_key")).toBeNull()
    expect(await store.get(SECRET_REFS.deviceToken)).toBeNull()
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect(await configStore.readConfig()).toEqual({ profiles: {} })
  })

  test("after logout on a migrated install neither resolver finds a credential, and the next keys create takes the not-set path", async () => {
    // The whole point: a logout that left the legacy refs behind left the device token LIVE.
    // `resolveDeviceToken`/`resolveApiKey` fall back to those refs the moment the profile is
    // gone, so the next command would have kept working against the account just logged out of.
    const { fetch, calls } = createRoutedFetch({})
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const configStore = createFakeConfigStore({ deviceTokenPrefix: "dvcpref1" })
    const deps = createTestDeps({ fetch, store, ...configStore })

    expect(await run(["auth", "logout"], deps)).toBe(0)

    expect(await resolveDeviceToken(deps)).toBeUndefined()
    expect(await resolveApiKey(deps)).toBeUndefined()
    expect(await resolveDeviceToken(deps, "default")).toBeUndefined()
    expect(await resolveApiKey(deps, "default")).toBeUndefined()

    const stderr = createCapture()
    const nextCode = await run(["keys", "create"], createTestDeps({ fetch, store, stderr, ...configStore }))
    expect(nextCode).toBe(1)
    expect(stderr.text).toContain("No device token available.")
    expect(calls).toHaveLength(0)
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
    expect(stdout.text).toContain("Account FaKwE2xX")
  })

  test("names the account's username beside its address when the live lookup returns one", async () => {
    // The embedded endpoint answers WHO the key is: address plus, when set, the Candle handle. The
    // handle is what an operator recognizes, so the identity line leads with it, address in parens.
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, {
          success: true,
          account: "FaKwE2xX",
          username: "satoshi",
          wallets: { solana: null, evm: null },
        }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account satoshi (FaKwE2xX)")
  })

  test("pairs the shown username with the shown account: a live account with no handle never borrows the cached one", async () => {
    // The live key answers account OTHER22 with NO username; the profile cached CACHED1 as "bob".
    // Falling back to the cached handle here would print `bob (OTHER22)` -- a handle that belongs to
    // a DIFFERENT account, in the very command whose job is to reveal exactly that kind of mismatch.
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "OTHER22", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({
      profiles: { staging: { account: "CACHED1", username: "bob" } },
      activeProfile: "staging",
    })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account OTHER22")
    expect(stdout.text).not.toContain("bob")
  })

  // Fix wave item 1: the live account alone reads as "fine" to an operator who never doubted it.
  // The repair is only obvious once BOTH names are on screen, so the mismatch line names what the
  // profile recorded beside what the key answers, and points at the one-command fix.
  test("names the cached account beside the live one when they differ, and the cheapest repair", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "OTHER22", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "CACHED1" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account OTHER22")
    expect(stdout.text).toContain("Profile staging recorded CACHED1")
    expect(stdout.text).toContain("this key belongs to OTHER22")
    expect(stdout.text).toContain("Run: candle profile use staging")
  })

  test("--json carries cachedAccount beside account when the two differ", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "OTHER22", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "CACHED1" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(["auth", "status", "--json"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.text) as { account?: string; cachedAccount?: string }
    expect(parsed.account).toBe("OTHER22")
    expect(parsed.cachedAccount).toBe("CACHED1")
  })

  test("a cached account that matches the live one prints nothing extra", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "CACHED1", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "CACHED1" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    expect(stdout.text).toContain("Account CACHED1")
    expect(stdout.text).not.toContain("recorded")
    expect(stdout.text).not.toContain("candle profile use")
  })

  // The env-override correction to item 1. Under CANDLE_API_KEY (or CANDLE_DEVICE_TOKEN) the live
  // answer comes from a credential that is NOT the profile's stored key, so the two names differing
  // is expected rather than wrong, and `profile use` would re-cache from the wrong key entirely.
  // The guard skips for exactly this reason; this line stays quiet on the same condition.
  test("an env credential override silences the mismatch line, leaving the identity line", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "OTHER22", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "CACHED1" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(
      ["auth", "status"],
      createTestDeps({ fetch, store, stdout, env: { CANDLE_API_KEY: "ck_live_env" }, ...config }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toContain("Profile staging · Account OTHER22 · ")
    expect(stdout.text).not.toContain("recorded")
    expect(stdout.text).not.toContain("candle profile use")
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
    expect(stdout.text).toContain("Account unknown")
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

describe("profiles", () => {
  test("auth login with no profiles creates one named from the host, active, with the account cached", async () => {
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "FaKwE2xX", wallets: { solana: null, evm: null } }),
    })
    const store = createFakeStore()
    const config = createFakeConfigStore({})
    const code = await run(
      ["auth", "login", "--no-browser", "--api-url", "https://staging.api.candle.tv"],
      createTestDeps({ fetch, store, ...config }),
    )
    expect(code).toBe(0)
    const after = await config.readConfig()
    expect(after.activeProfile).toBe("staging")
    expect(after.profiles?.staging).toMatchObject({
      apiUrl: "https://staging.api.candle.tv",
      account: "FaKwE2xX",
      deviceTokenPrefix: expect.any(String),
    })
    expect(await store.get("profile:staging:device_token")).toBe(DEVICE_TOKEN)
    expect(await store.get("profile:staging:api_key")).toBe(API_KEY)
    expect(await store.get("device_token")).toBeNull()
  })

  test("auth login --profile names the new profile and a second login does not overwrite the first", async () => {
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "A" }),
    })
    const store = createFakeStore({ "profile:hood:device_token": "keep-me" })
    const config = createFakeConfigStore({ profiles: { hood: { account: "A" } }, activeProfile: "hood" })
    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser", "--profile", "sol"],
      createTestDeps({ fetch, store, ...config }),
    )
    expect(code).toBe(0)
    expect(await store.get("profile:hood:device_token")).toBe("keep-me")
    expect(await store.get("profile:sol:device_token")).toBe(DEVICE_TOKEN)
    expect((await config.readConfig()).activeProfile).toBe("hood")
  })

  test("auth login with no flag re-authenticates the sole existing profile IN PLACE, never a numbered twin", async () => {
    // Re-running `auth login` is the documented way to refresh an expired device token. Deriving
    // a fresh name from the host instead produced `production-2`: a second, non-active profile
    // holding the only working credentials, while every command kept resolving `production`.
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const store = createFakeStore({ "profile:production:device_token": "stale-token" })
    const config = createFakeConfigStore({
      profiles: { production: { deviceTokenPrefix: "oldpref1", account: "FaKwE2xX" } },
      activeProfile: "production",
    })

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser"],
      createTestDeps({ fetch, store, ...config }),
    )

    expect(code).toBe(0)
    expect(await store.get("profile:production:device_token")).toBe(DEVICE_TOKEN)
    expect(await store.get("profile:production:api_key")).toBe(API_KEY)
    expect(await store.get("profile:production-2:device_token")).toBeNull()
    const after = await config.readConfig()
    expect(Object.keys(after.profiles ?? {})).toEqual(["production"])
    expect(after.profiles?.production).toMatchObject({ deviceTokenPrefix: "dvcprofl", keyPrefix: "ck_livepr" })
    expect(after.activeProfile).toBe("production")
  })

  test("auth login --profile <existing> honors that profile's apiUrl and leaves it intact", async () => {
    const { fetch, calls } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const store = createFakeStore()
    const config = createFakeConfigStore({
      profiles: { staging: { apiUrl: "https://staging.api.candle.tv" } },
      activeProfile: "staging",
    })

    const code = await run(
      ["auth", "login", "--profile", "staging", "--no-browser"],
      createTestDeps({ fetch, store, ...config }),
    )

    expect(code).toBe(0)
    // The device flow itself has to run against the profile's own backend: authorizing against
    // production and then filing the result under `staging` is how a profile ends up holding
    // credentials for a host it does not name.
    expect(calls[0]?.url.startsWith("https://staging.api.candle.tv/")).toBe(true)
    expect((await config.readConfig()).profiles?.staging?.apiUrl).toBe("https://staging.api.candle.tv")
  })

  test("auth login --profile still CREATES a new profile when another one would have resolved", async () => {
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "A" }),
    })
    const store = createFakeStore({ "profile:production:device_token": "keep-me" })
    const config = createFakeConfigStore({ profiles: { production: {} }, activeProfile: "production" })

    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser", "--profile", "new-one"],
      createTestDeps({ fetch, store, ...config }),
    )

    expect(code).toBe(0)
    expect(await store.get("profile:new-one:device_token")).toBe(DEVICE_TOKEN)
    expect(await store.get("profile:production:device_token")).toBe("keep-me")
    const after = await config.readConfig()
    expect(Object.keys(after.profiles ?? {}).sort()).toEqual(["new-one", "production"])
    expect(after.activeProfile).toBe("production")
  })

  test("auth login rejects an invalid --profile before any request", async () => {
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--profile", "bad name"],
      createTestDeps({ fetch: unusedFetch, stderr, ...createFakeConfigStore({}) }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("profile")
  })

  test("auth status prints the identity line first, from the profile's cached account", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "max" }),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({
      profiles: { staging: { account: "FaKwE2xX", apiUrl: "https://staging.api.candle.tv" } },
      activeProfile: "staging",
    })
    const stdout = createCapture()
    await run(["auth", "status"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(
      stdout.text.startsWith("Profile staging · Account FaKwE2xX · staging.api.candle.tv\n\nCredentials\n\n  Backend "),
    ).toBe(true)
  })

  test("auth status reports the PROFILE's prefixes: a login-created profile has no legacy top-level fields to read", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })
    const config = createFakeConfigStore({
      profiles: { staging: { deviceTokenPrefix: "RMe25DjO", keyPrefix: "8I0CZztp" } },
      activeProfile: "staging",
    })

    const stdout = createCapture()
    expect(await run(["auth", "status"], createTestDeps({ fetch, store, stdout, ...config }))).toBe(0)
    // Reading the legacy top-level fields here printed "not set" for both prefixes on every
    // profile created since the upgrade -- the exact opposite of what the command is for.
    expect(stdout.text).toContain("Device token prefix  RMe25DjO")
    expect(stdout.text).toContain("API key prefix       8I0CZztp")
    expect(stdout.text).not.toContain("not set")

    const stdoutJson = createCapture()
    expect(
      await run(["auth", "status", "--json"], createTestDeps({ fetch, store, stdout: stdoutJson, ...config })),
    ).toBe(0)
    const parsed = JSON.parse(stdoutJson.text)
    expect(parsed.deviceTokenPrefix).toBe("RMe25DjO")
    expect(parsed.keyPrefix).toBe("8I0CZztp")
  })

  test("auth logout prints the identity line first, naming the profile it is about to remove", async () => {
    // The one command whose whole effect is destructive was the one command that never said
    // which identity it was acting on.
    const { fetch } = createRoutedFetch({})
    const store = createFakeStore({ "profile:staging:device_token": "d" })
    const config = createFakeConfigStore({
      profiles: {
        staging: {
          account: "FaKwE2xX",
          apiUrl: "https://staging.api.candle.tv",
          portalOrigin: "https://staging.candle.tv",
        },
      },
      activeProfile: "staging",
    })
    const stdout = createCapture()

    const code = await run(["auth", "logout"], createTestDeps({ fetch, store, stdout, ...config }))

    expect(code).toBe(0)
    expect(stdout.text.startsWith("Profile staging · Account FaKwE2xX · staging.api.candle.tv\n")).toBe(true)
    // And the portal pointer still comes from the profile's own recorded origin.
    expect(stdout.text.split("\n").find((line) => line.startsWith("  Connected devices  "))).toBe(
      "  Connected devices  https://staging.candle.tv/agents?tab=keys#connected-devices",
    )
  })

  test("auth logout clears only the active profile's secrets and entry", async () => {
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys/8I0CZztp": () => jsonResponse(200, { success: true }) })
    const store = createFakeStore({
      "profile:staging:device_token": "d",
      "profile:staging:api_key": "k",
      "profile:production:device_token": "p",
    })
    const config = createFakeConfigStore({
      profiles: { staging: { keyPrefix: "8I0CZztp" }, production: {} },
      activeProfile: "staging",
    })
    const code = await run(["auth", "logout"], createTestDeps({ fetch, store, ...config }))
    expect(code).toBe(0)
    expect(await store.get("profile:staging:device_token")).toBeNull()
    expect(await store.get("profile:staging:api_key")).toBeNull()
    expect(await store.get("profile:production:device_token")).toBe("p")
    const after = await config.readConfig()
    expect(after.profiles).toEqual({ production: {} })
    expect(after.activeProfile).toBeUndefined()
  })

  test("auth login stamps when the account was cached", async () => {
    const { fetch } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const clock = createFakeClock(1_700_000_000_000)
    const config = createFakeConfigStore({})
    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser"],
      createTestDeps({ fetch, store: createFakeStore(), ...config, now: clock.now, sleep: clock.sleep }),
    )
    expect(code).toBe(0)
    const profile = Object.values((await config.readConfig()).profiles ?? {})[0]
    expect(profile?.account).toBe("FaKwE2xX")
    expect(profile?.accountCachedAt).toBe(clock.now())
  })
})

const unusedFetch = (() => {
  throw new Error("fetch should not be called for this test")
}) as unknown as typeof fetch

// Read:Write:Transfer (2026-09-24 spec, D6; BE-332 PR C): this CLI never puts `transfer:bound` on a
// device login. The API refuses it there too (R22); refusing here, before /code, says where the
// level is minted instead.
describe("auth login never requests transfer:bound", () => {
  test("--scopes naming transfer:bound is a usage error, exit 2, with no request made", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(
      [
        "auth",
        "login",
        "--api-url",
        "https://api.alpha.candle.tv",
        "--scopes",
        "transfer:write,transfer:bound",
        "--no-browser",
      ],
      createTestDeps({ fetch, stderr }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("transfer:bound is not available on a device login")
    expect(stderr.text.replace(/\s+/g, " ")).toContain("candle keys create --access withdraw")
    // BE-361 (T-B12): widen an existing key in place, as its own repair line.
    expect(stderr.text).toContain("candle keys access <prefix> --access withdraw")
    expect(stderr.text).not.toContain("with: candle")
  })
  test("--plain at width 40 puts each repair on its own command line; --json keeps the sentence", async () => {
    const usage =
      "transfer:bound is not available on a device login. Mint a Withdraw key with: candle keys create --access withdraw, or widen an existing key with: candle keys access <prefix> --access withdraw"
    const narrowErr = createCapture()
    const narrowOut = createCapture()
    const { fetch, calls } = createRoutedFetch({})
    expect(
      await run(
        [
          "auth",
          "login",
          "--api-url",
          "https://api.alpha.candle.tv",
          "--scopes",
          "transfer:bound",
          "--plain",
          "--no-browser",
        ],
        createTestDeps({
          fetch,
          stdout: narrowOut,
          stderr: narrowErr,
          columns: { stderr: 40 },
          presentation: { plain: true },
        }),
      ),
    ).toBe(2)
    expect(calls).toHaveLength(0)
    expect(narrowOut.text).toBe("")
    expect(narrowErr.text.replace(/\s+/g, " ")).toContain("transfer:bound is not available on a device login.")
    expect(narrowErr.text).toMatch(/device login\.\n\n/)
    expect(narrowErr.text).toContain("\n  candle keys create --access withdraw\n")
    expect(narrowErr.text).not.toContain("with: candle")
    for (const line of narrowErr.text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    const messageLines = narrowErr.text.split("\n\n")[0] ?? ""
    expect(messageLines).not.toContain("candle keys")

    const stdout = createCapture()
    const stderr = createCapture()
    expect(
      await run(
        [
          "auth",
          "login",
          "--api-url",
          "https://api.alpha.candle.tv",
          "--scopes",
          "transfer:bound",
          "--json",
          "--no-browser",
        ],
        createTestDeps({ fetch, stdout, stderr }),
      ),
    ).toBe(2)
    expect(stderr.text).toBe("")
    expect(JSON.parse(stdout.text)).toEqual({ ok: false, code: "USAGE", message: usage })
  })

  test("an invalid profile flag keeps its repair off the message line", async () => {
    const stderr = createCapture()
    const stdout = createCapture()
    expect(
      await authLogin([], {
        deps: createTestDeps({
          fetch: unusedFetch,
          stdout,
          stderr,
          columns: { stderr: 40 },
          presentation: { plain: true },
        }),
        json: false,
        apiUrl: "https://api.example.test",
        profileFlag: "BAD!",
        verifyAccount: false,
      }),
    ).toBe(2)
    expect(stdout.text).toBe("")
    expect(stderr.text).toContain("Invalid profile name: BAD!.")
    expect(stderr.text).toContain("\n  candle auth login --profile <name>\n")
    expect(stderr.text).not.toContain("Run: candle")
    for (const line of stderr.text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)

    const jsonOut = createCapture()
    const jsonErr = createCapture()
    expect(
      await authLogin([], {
        deps: createTestDeps({ fetch: unusedFetch, stdout: jsonOut, stderr: jsonErr }),
        json: true,
        apiUrl: "https://api.example.test",
        profileFlag: "BAD!",
        verifyAccount: false,
      }),
    ).toBe(2)
    expect(jsonErr.text).toBe("")
    expect(JSON.parse(jsonOut.text)).toEqual({
      ok: false,
      code: "USAGE",
      message: "Invalid profile name: BAD!. Run: candle auth login --profile <name>",
    })
  })

  test("a login that omits scopes sends none, so the server's device default (no transfer:bound) applies", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          deviceTokenPrefix: "dvcpref1",
          apiKey: {
            key: API_KEY,
            keyPrefix: "ck_livexx",
            embeddedWallet: "denied",
            scopes: ["launch:write", "account:read"],
          },
        }),
    })
    const code = await run(
      ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--no-browser"],
      createTestDeps({ fetch, stdout: createCapture() }),
    )
    expect(code).toBe(0)
    const codeCall = calls.find((call) => call.url.endsWith("/api/v1/agent/device/code"))
    expect(codeCall).toBeDefined()
    expect("scopes" in (JSON.parse(String(codeCall?.init.body)) as Record<string, unknown>)).toBe(false)
  })
})

describe("logout device and machine metadata", () => {
  for (const json of [false, true]) {
    test(`auth logout prints device prefix and label and connected-devices URL (json=${json})`, async () => {
      const config = createFakeConfigStore({
        deviceTokenPrefix: "dvc12345",
        label: "test-box",
        portalOrigin: "https://staging.candle.tv",
      })
      const stdout = createCapture()
      const deps = createTestDeps({
        fetch: createRoutedFetch({}).fetch,
        stdout,
        readConfig: config.readConfig,
        writeConfig: config.writeConfig,
        clearConfig: config.clearConfig,
      })
      expect(await authLogout([], { deps, apiUrl: "https://staging.api.candle.tv", json, verifyAccount: false })).toBe(
        0,
      )
      if (json)
        expect(JSON.parse(stdout.text)).toMatchObject({
          device: { prefix: "dvc12345", label: "test-box" },
          portalUrl: "https://staging.candle.tv/agents?tab=keys#connected-devices",
        })
      else
        expect(stdout.text).toContain(
          "Device dvc12345 (test-box) is still live on the server. Revoke it under Connected devices:\n    https://staging.candle.tv/agents?tab=keys#connected-devices",
        )
    })
  }
  test("auth logout without --profile keeps keySigners, secretNames, updateNotice, and publicRpcNotice", async () => {
    const machine = {
      keySigners: { entries: [], pins: {} },
      secretNames: ["rpc"],
      updateNotice: { shownAt: 1, version: "0.11.16" },
      publicRpcNotice: { shownAt: 1 },
    }
    const config = createFakeConfigStore({
      ...machine,
      apiUrl: "https://api.test",
      keyPrefix: "prefix",
      label: "box",
      deviceTokenPrefix: "device",
      portalOrigin: "https://portal.test",
      scopes: [],
    })
    const deps = createTestDeps({
      fetch: createRoutedFetch({}).fetch,
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      clearConfig: async () => {
        throw new Error("metadata must survive")
      },
    })
    expect(await authLogout([], { deps, apiUrl: "https://api.test", json: true, verifyAccount: false })).toBe(0)
    expect(await config.readConfig()).toEqual(machine)
  })
  test("auth logout without --profile deletes config.json only when machine fields are absent too", async () => {
    const config = createFakeConfigStore({ keyPrefix: "prefix", deviceTokenPrefix: "device" })
    let cleared = false
    const deps = createTestDeps({
      fetch: createRoutedFetch({}).fetch,
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      clearConfig: async () => {
        cleared = true
        await config.clearConfig()
      },
    })
    expect(await authLogout([], { deps, apiUrl: "https://api.test", json: true, verifyAccount: false })).toBe(0)
    expect(cleared).toBe(true)
    expect(await config.readConfig()).toEqual({})
  })
})

describe("auth output kit", () => {
  test("login groups full approval values and never reveals plaintext credentials at a narrow width", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const { fetch } = createRoutedFetch(deviceFlowRoutes())
    expect(
      await run(
        ["auth", "login", "--api-url", "https://api.alpha.candle.tv", "--plain", "--no-browser"],
        createTestDeps({ fetch, stdout, stderr, columns: { stdout: 40 } }),
      ),
    ).toBe(0)
    expect(stdout.text).toContain("Authorize this device")
    expect(stdout.text).toContain(CODE_RESPONSE.userCode)
    expect(stdout.text).toContain(CODE_RESPONSE.verificationUriComplete)
    expect(stdout.text).toContain("ok Device authorized")
    expect(stdout.text).toContain("dvcprofl")
    expect(stdout.text).toContain("ck_livepr")
    expect(stdout.text).not.toContain(API_KEY)
    expect(stdout.text).not.toContain(DEVICE_TOKEN)
    expect(stderr.text).toBe("")
  })
  test("status wraps details at 40 columns and uses one missing mark", async () => {
    const { fetch } = createRoutedFetch({})
    const stdout = createCapture()
    const stderr = createCapture()
    expect(
      await run(["auth", "status", "--plain"], createTestDeps({ fetch, stdout, stderr, columns: { stdout: 40 } })),
    ).toBe(0)
    expect(stdout.text).toContain("Credentials\n")
    expect(stdout.text).toContain("Device token prefix  -")
    expect(stdout.text).toContain("API key prefix       -")
    expect(stdout.text).toContain("Checks\n")
    expect(stdout.text.replace(/\s+/g, " ")).toContain("Device token SKIP not set. Run: candle auth login")
    const checks = stdout.text.split("Checks\n")[1] ?? ""
    for (const line of checks.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    expect(stderr.text).toBe("")
  })
})

const PROD = "https://api.alpha.candle.tv"

function loginReturning(embeddedWallet: "allowed" | "denied" | undefined) {
  const puts: Array<Record<string, unknown>> = []
  const routed = createRoutedFetch({
    "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
    "/api/v1/agent/device/token": () =>
      jsonResponse(200, {
        deviceToken: DEVICE_TOKEN,
        tokenPrefix: "dvcprofl",
        apiKey: {
          key: API_KEY,
          keyPrefix: "ck_livepr",
          scopes: ["swap:write"],
          ...(embeddedWallet ? { embeddedWallet } : {}),
        },
      }),
    "/api/v1/agent/keys/ck_livepr/embedded-wallet": (req) => {
      const body = JSON.parse(String(req.init.body)) as Record<string, unknown>
      puts.push(body)
      return jsonResponse(200, {
        success: true,
        dryRun: body.dryRun === true,
        keyPrefix: "ck_livepr",
        label: null,
        direction: "narrow",
        from: embeddedWallet ?? "allowed",
        to: body.permission,
      })
    },
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
  })
  return { ...routed, puts }
}

describe("auth login: a new profile names its API host", () => {
  test("a new --profile does not inherit a leftover config.apiUrl", async () => {
    const { fetch, calls } = createRoutedFetch(deviceFlowRoutes())
    const config = createFakeConfigStore({
      apiUrl: "https://staging.api.candle.tv",
      profiles: { hood: { apiUrl: "https://staging.api.candle.tv" } },
      activeProfile: "hood",
    })
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--no-browser", "--profile", "prod-coverage-trip"],
      createTestDeps({
        fetch,
        stderr,
        ...config,
        isTTY: { stdin: false, stdout: true, stderr: true },
      }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--api-url")
    expect(stderr.text).not.toContain("staging.api.candle.tv")
    expect((await config.readConfig()).profiles?.["prod-coverage-trip"]).toBeUndefined()
  })

  test("a prompted host is the one the device flow and the new profile use", async () => {
    const { fetch, calls } = createRoutedFetch({
      ...deviceFlowRoutes(),
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    const config = createFakeConfigStore({ apiUrl: "https://staging.api.candle.tv" })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, stdout, ...config })
    deps.promptLine = async () => PROD
    const code = await run(["auth", "login", "--no-browser", "--profile", "prod"], deps)
    expect(code).toBe(0)
    expect(calls[0]?.url.startsWith(`${PROD}/`)).toBe(true)
    expect(stdout.text.indexOf(PROD)).toBeLessThan(stdout.text.indexOf(CODE_RESPONSE.userCode))
    expect((await config.readConfig()).profiles?.prod?.apiUrl).toBe(PROD)
  })

  test("CANDLE_API_URL is an explicit host for a new profile", async () => {
    const { fetch, calls } = createRoutedFetch(deviceFlowRoutes())
    const config = createFakeConfigStore({ apiUrl: "https://staging.api.candle.tv" })
    const code = await run(
      ["auth", "login", "--no-browser", "--profile", "from-env"],
      createTestDeps({
        fetch,
        ...config,
        env: { CANDLE_API_URL: PROD },
        isTTY: { stdin: false, stdout: false, stderr: false },
      }),
    )
    expect(code).toBe(0)
    expect(calls[0]?.url.startsWith(`${PROD}/`)).toBe(true)
    expect((await config.readConfig()).profiles?.["from-env"]?.apiUrl).toBe(PROD)
  })
})

describe("auth login: the embedded wallet defaults to deny", () => {
  test("an approval that allowed the wallet is put back to denied", async () => {
    const { fetch, puts } = loginReturning("allowed")
    const stdout = createCapture()
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD], createTestDeps({ fetch, stdout }))
    expect(code).toBe(0)
    expect(puts).toEqual([
      { permission: "denied", dryRun: true },
      { permission: "denied", expect: "allowed" },
    ])
    expect(stdout.text).toContain("denied")
    expect(stdout.text).not.toContain("Embedded wallet      allowed")
  })

  test("--embedded-wallet allow is confirmed before the flow and is not corrected when the page agrees", async () => {
    const { fetch, calls, puts } = loginReturning("allowed")
    const prompts: string[] = []
    const deps = createTestDeps({ fetch })
    deps.promptLine = async (text) => {
      prompts.push(text)
      return "y"
    }
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD, "--embedded-wallet", "allow"], deps)
    expect(code).toBe(0)
    expect(prompts[0]).toContain("allowed")
    expect(puts).toEqual([])
    expect(calls.some((call) => call.url.includes("/device/code"))).toBe(true)
  })

  function failClosedLogin(opts: {
    reported: "allowed" | "denied" | undefined
    preview: number
    commit: number
    revoke: number
  }) {
    const deleted: string[] = []
    const routed = createRoutedFetch({
      "/api/v1/agent/device/code": () => jsonResponse(200, CODE_RESPONSE),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          tokenPrefix: "dvcprofl",
          apiKey: {
            key: API_KEY,
            keyPrefix: "ck_livepr",
            scopes: ["swap:write"],
            ...(opts.reported ? { embeddedWallet: opts.reported } : {}),
          },
        }),
      "/api/v1/agent/keys/ck_livepr/embedded-wallet": (req) => {
        const body = JSON.parse(String(req.init.body)) as Record<string, unknown>
        const status = body.dryRun === true ? opts.preview : opts.commit
        if (status !== 200) return jsonResponse(status, { error: { code: "UNAVAILABLE", message: "down" } })
        return jsonResponse(200, { success: true, dryRun: body.dryRun === true, from: "allowed", to: body.permission })
      },
      "/api/v1/agent/keys/ck_livepr": (req) => {
        if (req.init.method === "DELETE") deleted.push("ck_livepr")
        return jsonResponse(opts.revoke, { success: true })
      },
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "FaKwE2xX" }),
    })
    return { ...routed, deleted }
  }

  for (const [name, opts] of [
    ["the correction preview fails", { reported: "allowed", preview: 503, commit: 200, revoke: 200 }],
    ["the correction commit fails", { reported: "allowed", preview: 200, commit: 503, revoke: 200 }],
    [
      "the token response omits the permission and the correction fails",
      { reported: undefined, preview: 503, commit: 200, revoke: 200 },
    ],
  ] as const) {
    test(`${name}: the key is revoked, nothing is stored, and login fails`, async () => {
      const { fetch, deleted } = failClosedLogin(opts)
      const store = createFakeStore()
      const stderr = createCapture()
      const stdout = createCapture()
      const code = await run(
        ["auth", "login", "--no-browser", "--api-url", PROD, "--json"],
        createTestDeps({ fetch, store, stderr, stdout }),
      )
      expect(code).toBe(1)
      expect(deleted).toEqual(["ck_livepr"])
      expect(stdout.text).toBe("")
      expect(stderr.text).toContain("embedded_wallet_not_denied")
      expect(await store.get("profile:production:api_key")).toBeFalsy()
      expect(await store.get("profile:production:device_token")).toBeFalsy()
    })
  }

  test("an omitted permission is established as denied by the correction", async () => {
    const { fetch, puts } = loginReturning(undefined)
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD], createTestDeps({ fetch }))
    expect(code).toBe(0)
    expect(puts).toEqual([
      { permission: "denied", dryRun: true },
      { permission: "denied", expect: "allowed" },
    ])
  })

  test("a failed correction whose key cannot be revoked says so and still fails", async () => {
    const { fetch } = failClosedLogin({ reported: "allowed", preview: 503, commit: 503, revoke: 503 })
    const stderr = createCapture()
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD], createTestDeps({ fetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("could NOT be revoked")
    expect(stderr.text.replace(/\s+/g, " ")).toContain("--embedded-wallet deny")
  })

  test("a requested allow that cannot be applied leaves the narrower key, unrevoked", async () => {
    const { fetch, deleted } = failClosedLogin({ reported: "denied", preview: 503, commit: 503, revoke: 200 })
    const deps = createTestDeps({ fetch })
    deps.promptLine = async () => "y"
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD, "--embedded-wallet", "allow"], deps)
    expect(code).toBe(0)
    expect(deleted).toEqual([])
  })

  test("a declined allow starts no device flow", async () => {
    const { fetch, calls } = loginReturning("allowed")
    const deps = createTestDeps({ fetch })
    deps.promptLine = async () => "n"
    const code = await run(["auth", "login", "--no-browser", "--api-url", PROD, "--embedded-wallet", "allow"], deps)
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
  })
})
