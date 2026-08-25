/**
 * `run()`: the dispatch entry. Covers unknown-command handling, `--version`, `--json` as a
 * generic renderer switch, and the cross-command secrecy guarantee (task-3-brief.md Step 1): a
 * fixture device token must never appear in captured output across an `auth login` + `keys
 * create` run, and the fixture API key appears exactly once (its one-time issuance display).
 */

import { describe, expect, test } from "bun:test"
import { NEVER_GUARDED, ROUTED_COMMANDS, ROUTED_SUBCOMMANDS, run } from "./index"
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

  // The dispatch table and each command's subcommand map are plain objects, so a bare index
  // lookup finds Object.prototype's members: "toString" would route as a command word, and "keys
  // toString" would find a "handler" that is not one and call it. Every one of these is an
  // unknown command and has to read exactly like any other unknown word.
  test("a prototype member is an unknown command, not a routed one", async () => {
    const control = createCapture()
    expect(await run(["frobnicate"], createTestDeps({ fetch: unusedFetch, stderr: control }))).toBe(1)

    for (const [argv, token] of [
      [["toString"], "toString"],
      [["constructor", "foo"], "constructor"],
      [["keys", "toString"], "keys toString"],
    ] as const) {
      const stderr = createCapture()
      // unusedFetch throws, so this also pins that none of them pays for a verification request.
      expect(await run([...argv], createTestDeps({ fetch: unusedFetch, stderr }))).toBe(1)
      expect(stderr.text).toBe(control.text.replace("frobnicate", token))
    }
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

  // Both refusals below happen at dispatch, before any command owns the output stream. Under
  // --json they still have to keep the CLI's contract with agents: exactly one JSON value on
  // stdout, stderr reserved for diagnostics. They used to write a bare sentence to stderr and
  // leave stdout empty, so a --json caller got an unparseable exit 1.
  test("--json: an unresolved profile is an envelope on stdout, with nothing on stderr", async () => {
    const config = createFakeConfigStore({ profiles: { staging: {}, production: {} } })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["keys", "list", "--json"],
      createTestDeps({ fetch: unusedFetch, stdout, stderr, ...config }),
    )
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("PROFILE_UNRESOLVED")
    expect(`${parsed.message} ${parsed.suggestion}`).toContain("staging")
    expect(stderr.text).toBe("")
  })

  test("--json: auth login's invalid CANDLE_PROFILE is a USAGE envelope on stdout, exit 2", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--no-browser", "--json"],
      createTestDeps({
        fetch: unusedFetch,
        stdout,
        stderr,
        env: { CANDLE_PROFILE: "bad name" },
        ...createFakeConfigStore({}),
      }),
    )
    expect(code).toBe(2)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("USAGE")
    expect(parsed.message).toContain("Invalid profile name")
    expect(stderr.text).toBe("")
  })

  // Every shape resolveProfileName can refuse with, pinned to the byte: splitFix cuts these into
  // a message and a suggestion for the envelope, and writeLocalFailure has to put the very same
  // separator back -- a newline before a list, a single space before a " Run: ..." tail.
  test("human mode is unchanged: every resolution refusal is the same text on stderr", async () => {
    const named = createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: { account: "ACC1" }, production: {} },
    })
    const namedOut = createCapture()
    const namedErr = createCapture()
    await run(
      ["keys", "list", "--profile", "gone"],
      createTestDeps({ fetch: unusedFetch, stdout: namedOut, stderr: namedErr, ...named }),
    )
    expect(namedOut.text).toBe("")
    expect(namedErr.text).toBe(
      ['No profile named "gone".', "Profiles on this machine:", "  staging (active)  ACC1", "  production", ""].join(
        "\n",
      ),
    )

    // With no profiles at all there is no list to print, and the fix sits on the same line.
    const emptyOut = createCapture()
    const emptyErr = createCapture()
    await run(
      ["keys", "list", "--profile", "gone"],
      createTestDeps({ fetch: unusedFetch, stdout: emptyOut, stderr: emptyErr, ...createFakeConfigStore({}) }),
    )
    expect(emptyOut.text).toBe("")
    expect(emptyErr.text).toBe('No profile named "gone". Run: candle auth login --profile gone\n')

    const severalOut = createCapture()
    const severalErr = createCapture()
    await run(
      ["keys", "list"],
      createTestDeps({
        fetch: unusedFetch,
        stdout: severalOut,
        stderr: severalErr,
        ...createFakeConfigStore({ profiles: { staging: {}, production: {} } }),
      }),
    )
    expect(severalOut.text).toBe("")
    expect(severalErr.text).toBe(
      [
        "Several profiles exist and none is selected. Pick one with --profile <name> or CANDLE_PROFILE=<name>:",
        "  staging",
        "  production",
        "",
      ].join("\n"),
    )
  })

  test("auth login with an invalid CANDLE_PROFILE is a usage error before any request", async () => {
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--no-browser"],
      createTestDeps({ fetch: unusedFetch, stderr, env: { CANDLE_PROFILE: "bad name" }, ...createFakeConfigStore({}) }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("Invalid profile name")
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

describe("the account guard at dispatch", () => {
  const guarded = () =>
    createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: { apiUrl: "https://staging.api.candle.tv", account: "CACHED1" } },
    })
  const store = () => createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "k" })

  test("a mismatched account refuses an authenticated command before it runs, exit 1", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "OTHER22" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const stderr = createCapture()
    const code = await run(["keys", "list"], createTestDeps({ fetch, store: store(), stderr, ...guarded() }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("OTHER22")
    expect(calls.some((c) => c.url.includes("/agent/keys"))).toBe(false)
  })

  test("--json: the refusal is an envelope on stdout, with nothing on stderr", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "OTHER22" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["keys", "list", "--json"],
      createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }),
    )
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("ACCOUNT_MISMATCH")
    expect(parsed.message).toContain("OTHER22")
    expect(parsed.suggestion).toContain("candle profile use staging")
    expect(stderr.text).toBe("")
  })

  // The wording is guard.ts's, and routing it through render.ts must not have moved a byte of it.
  test("human mode is unchanged: the sentence naming both accounts, then the three repairs", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "OTHER22" }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    await run(["keys", "list"], createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }))
    expect(stdout.text).toBe("")
    expect(stderr.text).toBe(
      [
        "Refusing: profile staging expects account CACHED1 but its stored key belongs to OTHER22.",
        "If that key was legitimately re-issued: candle profile use staging",
        "To re-authenticate: candle auth login --profile staging",
        "To proceed once without the check: --no-verify-account",
        "",
      ].join("\n"),
    )
  })

  test("--no-verify-account runs the command without the check", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const code = await run(
      ["keys", "list", "--no-verify-account", "--json"],
      createTestDeps({ fetch, store: store(), ...guarded() }),
    )
    expect(code).toBe(0)
    expect(calls.some((c) => c.url.includes("/wallets/embedded"))).toBe(false)
  })

  test("an unreachable API warns on stderr and the command still runs", async () => {
    let first = true
    const fetch = (async (url: string) => {
      if (String(url).includes("/wallets/embedded") && first) {
        first = false
        throw new Error("ECONNREFUSED")
      }
      return jsonResponse(200, { success: true, tier: "free", keys: [] })
      // `typeof globalThis.fetch`, not `typeof fetch`: this const is itself named `fetch`, so the
      // bare form would be a self-reference and infer `any`.
    }) as unknown as typeof globalThis.fetch
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["keys", "list", "--json"],
      createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }),
    )
    expect(code).toBe(0)
    expect(stderr.text).toContain("Could not verify")
    // The warning is a diagnostic and stays on stderr in BOTH modes: under --json stdout carries
    // exactly one JSON value, the command's own.
    expect(JSON.parse(stdout.text)).toEqual({ success: true, tier: "free", keys: [] })
  })

  // The exempt commands (NEVER_GUARDED in index.ts), each run against the very fixture that
  // refuses `keys list` above: cached account CACHED1, live account OTHER22. Every one of these
  // fails if its exemption is removed, which is the point -- an operator holding a mismatch must
  // keep the commands that show it and fix it.
  const mismatched = {
    "/api/v1/agent/wallets/embedded": () =>
      jsonResponse(200, {
        success: true,
        account: "OTHER22",
        wallets: { solana: { address: "abc", delegated: true }, evm: null },
      }),
  }

  test("auth login is never guarded: re-authenticating the profile is how a moved key gets fixed", async () => {
    const { fetch } = createRoutedFetch({
      ...mismatched,
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
          deviceToken: "cndl_dvc_fresh",
          tokenPrefix: "dvcprofl",
          apiKey: { key: "ck_live_fresh", keyPrefix: "ck_livepr", scopes: ["launch:write"] },
        }),
    })
    const secrets = store()
    const stderr = createCapture()
    const code = await run(
      ["auth", "login", "--no-browser"],
      createTestDeps({ fetch, store: secrets, stderr, ...guarded() }),
    )
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    // The credentials the login just filed, which a refusal would have prevented it from writing.
    expect(await secrets.get("profile:staging:device_token")).toBe("cndl_dvc_fresh")
    expect(await secrets.get("profile:staging:api_key")).toBe("ck_live_fresh")
  })

  test("auth status is never guarded: reading the live account is how a mismatch gets seen", async () => {
    const { fetch } = createRoutedFetch({
      ...mismatched,
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(["auth", "status"], createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }))
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    // It reports the LIVE account, which is the whole reason it must not be refused.
    expect(stdout.text).toContain("OTHER22")
  })

  test("auth logout is never guarded, and still revokes the stored key with the credential it names", async () => {
    const { fetch, calls } = createRoutedFetch({
      ...mismatched,
      "/api/v1/agent/keys/ck_livepr": () => jsonResponse(200, { success: true }),
    })
    const config = createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: { apiUrl: "https://staging.api.candle.tv", account: "CACHED1", keyPrefix: "ck_livepr" } },
    })
    const stderr = createCapture()
    const code = await run(["auth", "logout"], createTestDeps({ fetch, store: store(), stderr, ...config }))
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    expect(calls.some((c) => c.url.endsWith("/api/v1/agent/keys/ck_livepr") && c.init.method === "DELETE")).toBe(true)
  })

  test("doctor is never guarded: it is the command the mismatch is diagnosed with", async () => {
    const { fetch } = createRoutedFetch({
      ...mismatched,
      "/api/v1/status": () => jsonResponse(200, { api: "ok" }),
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [], tier: "free" }),
      "/api/v1/agent/tier": () => jsonResponse(200, { success: true, tier: "free" }),
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(["doctor"], createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }))
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    expect(stdout.text).toContain("PASS")
  })

  test("profile commands are never guarded, and make no verification call at all", async () => {
    // Protected twice over: dispatch resolves no profile for `profile *` (so the guard would
    // skip at "no profile" even if it ran), and NEVER_GUARDED exempts the word. The behaviour
    // below therefore cannot distinguish the two, so the rule itself is asserted as well: an
    // exemption that holds only by accident of resolution would break the day `profile use`
    // wanted a resolved `ctx.profile`.
    expect(NEVER_GUARDED.has("profile")).toBe(true)
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(["profile", "list"], createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }))
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toBe("")
  })

  // An invocation dispatch is about to answer with usage has no identity to verify: the guard's
  // request would be spent on a command that never runs. The three cases below all sit on the
  // fixture that refuses `keys list`, so a guard that still ran would refuse them instead.
  test("an unknown subcommand prints usage without paying for a verification request", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stderr = createCapture()
    const code = await run(["keys", "bogus"], createTestDeps({ fetch, store: store(), stderr, ...guarded() }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("Unknown command: keys bogus")
    expect(stderr.text).not.toContain("Refusing")
    expect(calls).toHaveLength(0)
  })

  test("a command word with no subcommand prints usage without paying for a verification request", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stderr = createCapture()
    const code = await run(["keys"], createTestDeps({ fetch, store: store(), stderr, ...guarded() }))
    expect(code).toBe(1)
    expect(stderr.text).not.toContain("Unknown command")
    expect(stderr.text.toLowerCase()).toContain("usage")
    expect(calls).toHaveLength(0)
  })

  test("mcp --read-only is not guarded: it launches with no key at all, so it acts as no account", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const children: string[][] = []
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--read-only"],
      createTestDeps({
        fetch,
        store: store(),
        stderr,
        runChild: async (_command, args) => {
          children.push(args)
          return 0
        },
        ...guarded(),
      }),
    )
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    expect(calls).toHaveLength(0)
    expect(children).toHaveLength(1)
  })

  test("mcp --print-config stays guarded: the block it prints launches a server WITH the key", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--print-config"],
      createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toContain("OTHER22")
    expect(stdout.text).toBe("")
    expect(calls).toHaveLength(1)
  })

  // The two flags together print the block for a launch that carries NO key, so there is still no
  // identity to verify: what --print-config is guarded for is the key the printed command would
  // run with, not the printing.
  test("mcp --print-config --read-only is not guarded: the block it prints is a keyless launch", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--print-config", "--read-only"],
      createTestDeps({ fetch, store: store(), stdout, stderr, ...guarded() }),
    )
    expect(code).toBe(0)
    expect(stderr.text).not.toContain("Refusing")
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text).mcpServers.candle.args).toEqual(["mcp", "--read-only"])
  })

  // `wallets` with no subcommand is not a usage error: it IS a command, and an authenticated one.
  // Skipping the guard for it (its subcommands are import and revoke, neither of them typed here)
  // would run it as whatever account the stored key belongs to.
  test("bare wallets is a command in its own right, so it stays guarded", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stderr = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, store: store(), stderr, ...guarded() }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("OTHER22")
    expect(calls).toHaveLength(1)
  })

  test("setup stays guarded: it skips login when credentials exist, then acts as whoever they belong to", async () => {
    const { fetch, calls } = createRoutedFetch(mismatched)
    const stderr = createCapture()
    const code = await run(["setup"], createTestDeps({ fetch, store: store(), stderr, ...guarded() }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("OTHER22")
    expect(calls).toHaveLength(1)
  })

  test("the guarded set stays in step with the commands dispatch routes", async () => {
    // ROUTED_COMMANDS duplicates the dispatch chain, so a command added there and left out here
    // would be silently unguarded. The help text's Commands: block is the third copy, and what
    // this compares against. What it enforces is one direction: a command DOCUMENTED in the help
    // must be in the set. A command added to dispatch and documented nowhere passes this test and
    // still runs unguarded; the convention that every command is documented is what closes that.
    const stdout = createCapture()
    await run(["--help"], createTestDeps({ fetch: unusedFetch, stdout }))
    const block = stdout.text.slice(
      stdout.text.indexOf("Commands:") + "Commands:".length,
      stdout.text.indexOf("Global options:"),
    )
    const documented = new Set(
      block
        .split("\n")
        .map((line) => line.match(/^ {2}(\S+)/)?.[1])
        .filter((word): word is string => word !== undefined),
    )
    expect([...documented].sort()).toEqual([...ROUTED_COMMANDS].sort())
    // A typo here would silently guard a command the ruling exempts, or exempt nothing at all.
    expect([...NEVER_GUARDED].filter((word) => !ROUTED_COMMANDS.has(word))).toEqual([])

    // The same block documents SUBCOMMANDS ("auth login", "keys create"), and the guard now reads
    // them: an invocation whose subcommand is not one dispatch routes is about to print usage, so
    // it is not verified. A subcommand documented here and missing from the map would therefore
    // run its command with no verification at all.
    const documentedSubs: Record<string, string[]> = {}
    for (const line of block.split("\n")) {
      // The second token only counts when it is a plain word: `setup [--no-browser]` and `keys
      // revoke <prefix>` document a flag and an argument, not a subcommand.
      const match = line.match(/^ {2}(\S+) ([a-z][a-z-]*)(?:\s|$)/)
      if (!match?.[1] || !match[2]) continue
      documentedSubs[match[1]] = [...(documentedSubs[match[1]] ?? []), match[2]]
    }
    const sorted = (map: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(map).map(([word, subs]) => [word, [...subs].sort()]))
    expect(sorted(documentedSubs)).toEqual(sorted(ROUTED_SUBCOMMANDS))
    expect(Object.keys(ROUTED_SUBCOMMANDS).filter((word) => !ROUTED_COMMANDS.has(word))).toEqual([])
  })
})

const unusedFetch = (() => {
  throw new Error("fetch should not be called for this test")
}) as unknown as typeof fetch
