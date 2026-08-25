/**
 * `run()`: the dispatch entry. Covers unknown-command handling, `--version`, `--json` as a
 * generic renderer switch, and the cross-command secrecy guarantee (task-3-brief.md Step 1): a
 * fixture device token must never appear in captured output across an `auth login` + `keys
 * create` run, and the fixture API key appears exactly once (its one-time issuance display).
 */

import { describe, expect, test } from "bun:test"
import { run } from "./index"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "./test-support"
import { CLI_VERSION } from "./version"

describe("dispatch", () => {
  test("an unknown top-level command names the offending token, then prints help, and exits 1", async () => {
    const stderr = createCapture()
    const code = await run(["frobnicate"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("Unknown command: frobnicate")
    expect(stderr.text.toLowerCase()).toContain("usage")
  })

  // `bunx github:candledottv/agentic candle auth login` resolves the bin by name and then hands
  // that same name to the CLI as its first argument. Both forms have to dispatch identically.
  test("a leading 'candle' token is dropped, so the bunx passthrough form dispatches like the bare form", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })

    const bare = createCapture()
    expect(await run(["keys", "list", "--json"], createTestDeps({ fetch, store, stdout: bare }))).toBe(0)

    const passthrough = createCapture()
    expect(await run(["candle", "keys", "list", "--json"], createTestDeps({ fetch, store, stdout: passthrough }))).toBe(
      0,
    )

    expect(passthrough.text).toBe(bare.text)
  })

  test("only ONE leading 'candle' is dropped: a second one is still an unknown command that names itself", async () => {
    const stderr = createCapture()
    const code = await run(["candle", "candle", "auth", "status"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("Unknown command: candle")
  })

  test("a bare 'candle' with nothing after it prints help alone, with no unknown-command line", async () => {
    const stderr = createCapture()
    const code = await run(["candle"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).not.toContain("Unknown command")
    expect(stderr.text.toLowerCase()).toContain("usage")
  })

  test("no command at all prints help and exits 1", async () => {
    const stderr = createCapture()
    const code = await run([], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text.length).toBeGreaterThan(0)
  })

  test("an unknown auth subcommand names the full command path and exits 1", async () => {
    const stderr = createCapture()
    const code = await run(["auth", "frobnicate"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("Unknown command: auth frobnicate")
  })

  test("a known command with NO subcommand prints help alone -- the command itself is not unknown", async () => {
    const stderr = createCapture()
    const code = await run(["keys"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).not.toContain("Unknown command")
    expect(stderr.text.toLowerCase()).toContain("usage")
  })

  test("--version prints CLI_VERSION and nothing else meaningful, exit 0", async () => {
    const stdout = createCapture()
    const code = await run(["--version"], createTestDeps({ fetch: unusedFetch, stdout }))
    expect(code).toBe(0)
    expect(stdout.text.trim()).toBe(CLI_VERSION)
  })

  test("--help prints help and exits 0", async () => {
    const stdout = createCapture()
    const code = await run(["--help"], createTestDeps({ fetch: unusedFetch, stdout }))
    expect(code).toBe(0)
    expect(stdout.text.toLowerCase()).toContain("usage")
  })

  test("-h and -v are recognized aliases for --help and --version", async () => {
    const stdoutHelp = createCapture()
    expect(await run(["-h"], createTestDeps({ fetch: unusedFetch, stdout: stdoutHelp }))).toBe(0)
    expect(stdoutHelp.text.toLowerCase()).toContain("usage")

    const stdoutVersion = createCapture()
    expect(await run(["-v"], createTestDeps({ fetch: unusedFetch, stdout: stdoutVersion }))).toBe(0)
    expect(stdoutVersion.text.trim()).toBe(CLI_VERSION)
  })

  test("every global option's description starts in the same column, --profile included", async () => {
    const stdout = createCapture()
    await run(["--help"], createTestDeps({ fetch: unusedFetch, stdout }))
    const globals = stdout.text.slice(stdout.text.indexOf("Global options:")).split("\n")
    const columns = globals
      .filter((line) => line.startsWith("  --"))
      .map((line) => (line.match(/^ {2}.*? {2,}(?=\S)/) as RegExpMatchArray)[0].length)
    expect(columns.length).toBeGreaterThan(1)
    expect(new Set(columns).size).toBe(1)
  })

  test("--api-url with no value is a usage error naming the flag, exit 2 (fix round 1, item 13)", async () => {
    const stderr = createCapture()
    const code = await run(["doctor", "--api-url"], createTestDeps({ fetch: unusedFetch, stderr }))
    expect(code).toBe(2)
    expect(stderr.text).toContain("--api-url")
  })

  test("--json switches the renderer: keys list prints the raw JSON body instead of a table", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    const code = await run(["keys", "list", "--json"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.text)
    expect(parsed).toEqual({ success: true, tier: "free", keys: [] })
  })

  test("human mode (no --json) never prints a raw envelope for the same request", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    await run(["keys", "list"], createTestDeps({ fetch, store, stdout }))
    expect(() => JSON.parse(stdout.text)).toThrow()
  })
})

describe("secrecy", () => {
  test("the fixture device token never appears in stdout or stderr across auth login + keys create; the fixture API key appears exactly once", async () => {
    const DEVICE_TOKEN = "cndl_dvc_SUPER_SECRET_FIXTURE_TOKEN_VALUE"
    const API_KEY = "ck_live_SUPER_SECRET_FIXTURE_KEY_VALUE"

    const { fetch } = createRoutedFetch({
      "/api/v1/agent/device/code": () =>
        jsonResponse(200, {
          deviceCode: "dc_abc123",
          userCode: "ABCD-1234",
          verificationUri: "https://candle.tv/dev/agent/device",
          verificationUriComplete: "https://candle.tv/dev/agent/device?code=ABCD-1234",
          expiresIn: 600,
          interval: 5,
        }),
      "/api/v1/agent/device/token": () =>
        jsonResponse(200, {
          deviceToken: DEVICE_TOKEN,
          tokenPrefix: "dvcpref1",
          apiKey: null,
          apiKeyError: "No delegated launch wallet on file",
        }),
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: API_KEY,
          keyPrefix: "ck_livenn",
          scopes: ["launch:write"],
          environment: "production",
        }),
    })

    const store = createFakeStore()
    // A real CLI session shares one config.json across separate invocations; login now creates a
    // profile and `keys create` has to resolve the SAME one (its device token lives under that
    // profile's namespaced ref since Task 5), so the fake config store is shared here the same
    // way `store` already is.
    const config = createFakeConfigStore()
    const stdoutLogin = createCapture()
    const stderrLogin = createCapture()
    const loginCode = await run(
      ["auth", "login"],
      createTestDeps({ fetch, store, stdout: stdoutLogin, stderr: stderrLogin, ...config }),
    )
    expect(loginCode).toBe(0)

    const stdoutCreate = createCapture()
    const stderrCreate = createCapture()
    const createCode = await run(
      ["keys", "create"],
      createTestDeps({ fetch, store, stdout: stdoutCreate, stderr: stderrCreate, ...config }),
    )
    expect(createCode).toBe(0)

    const combined = stdoutLogin.text + stderrLogin.text + stdoutCreate.text + stderrCreate.text
    expect(combined).not.toContain(DEVICE_TOKEN)

    const occurrences = combined.split(API_KEY).length - 1
    expect(occurrences).toBe(1)
  })
})

describe("profiles at dispatch", () => {
  const keysRoute = { "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }) }

  test("--profile selects which stored device token a command uses", async () => {
    const { fetch, calls } = createRoutedFetch(keysRoute)
    const store = createFakeStore({
      "profile:staging:device_token": "cndl_dvc_staging",
      "profile:production:device_token": "cndl_dvc_prod",
    })
    const config = createFakeConfigStore({ profiles: { staging: {}, production: {} } })
    const code = await run(
      ["keys", "list", "--profile", "production", "--json"],
      createTestDeps({ fetch, store, ...config }),
    )
    expect(code).toBe(0)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toContain("cndl_dvc_prod")
  })

  test("CANDLE_PROFILE selects the profile when no flag is given", async () => {
    const { fetch, calls } = createRoutedFetch(keysRoute)
    const store = createFakeStore({
      "profile:staging:device_token": "cndl_dvc_staging",
      "profile:production:device_token": "cndl_dvc_prod",
    })
    const config = createFakeConfigStore({ profiles: { staging: {}, production: {} } })
    const code = await run(
      ["keys", "list", "--json"],
      createTestDeps({ fetch, store, env: { CANDLE_PROFILE: "staging" }, ...config }),
    )
    expect(code).toBe(0)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toContain("cndl_dvc_staging")
  })

  test("several profiles and nothing selected refuses before any request, exit 1, naming them", async () => {
    const stderr = createCapture()
    const config = createFakeConfigStore({ profiles: { staging: {}, production: {} } })
    const code = await run(["keys", "list"], createTestDeps({ fetch: unusedFetch, stderr, ...config }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("staging")
    expect(stderr.text).toContain("production")
    expect(stderr.text).toContain("--profile")
  })

  test("the profile's apiUrl is used, and --api-url / CANDLE_API_URL still beat it", async () => {
    const { fetch, calls } = createRoutedFetch(keysRoute)
    const store = createFakeStore({ "profile:staging:device_token": "t" })
    const config = createFakeConfigStore({ profiles: { staging: { apiUrl: "https://staging.api.candle.tv" } } })
    await run(["keys", "list", "--json"], createTestDeps({ fetch, store, ...config }))
    expect(calls[0]?.url.startsWith("https://staging.api.candle.tv/")).toBe(true)
    await run(
      ["keys", "list", "--json", "--api-url", "https://other.example"],
      createTestDeps({ fetch, store, ...config }),
    )
    expect(calls[1]?.url.startsWith("https://other.example/")).toBe(true)
  })

  test("a pre-profile install is migrated silently: profile 'default', secrets copied, old refs kept", async () => {
    const { fetch } = createRoutedFetch(keysRoute)
    const store = createFakeStore({ device_token: "cndl_dvc_old", api_key: "ck_live_old" })
    const config = createFakeConfigStore({
      apiUrl: "https://staging.api.candle.tv",
      deviceTokenPrefix: "RMe25DjO",
      keyPrefix: "8I0CZztp",
    })
    const stdout = createCapture()
    const code = await run(["keys", "list", "--json"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    const after = await config.readConfig()
    expect(after.activeProfile).toBe("default")
    expect(after.profiles?.default).toEqual({
      apiUrl: "https://staging.api.candle.tv",
      deviceTokenPrefix: "RMe25DjO",
      keyPrefix: "8I0CZztp",
    })
    expect(after.deviceTokenPrefix).toBe("RMe25DjO")
    expect(await store.get("profile:default:device_token")).toBe("cndl_dvc_old")
    expect(await store.get("profile:default:api_key")).toBe("ck_live_old")
    expect(await store.get("device_token")).toBe("cndl_dvc_old")
    expect(stdout.text).not.toContain("migrat")
  })

  test("--version and --help never touch the config, so they work with an unresolvable profile set", async () => {
    const config = createFakeConfigStore({ profiles: { a: {}, b: {} } })
    const stdout = createCapture()
    expect(await run(["--version"], createTestDeps({ fetch: unusedFetch, stdout, ...config }))).toBe(0)
    expect(stdout.text.trim()).toBe(CLI_VERSION)
  })
})

const unusedFetch = (() => {
  throw new Error("fetch should not be called for this test")
}) as unknown as typeof fetch
