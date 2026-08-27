/**
 * `candle profile`: the management commands over the profiles map. No credentials are needed,
 * so these bypass profile resolution; that is also what makes `profile use` the way out of the
 * "several profiles, none selected" refusal.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

const unusedFetch = (() => {
  throw new Error("must not fetch")
}) as unknown as typeof fetch

const NOW = Date.parse("2026-08-25T12:00:00Z")
const twoProfiles = () =>
  createFakeConfigStore({
    activeProfile: "staging",
    profiles: {
      staging: {
        apiUrl: "https://staging.api.candle.tv",
        account: "FaKwE2xX",
        accountCachedAt: NOW - 3_600_000,
        keyPrefix: "8I0CZztp",
      },
      production: { apiUrl: "https://api.candle.tv", account: "7o3msKCe" },
    },
  })

describe("profile list", () => {
  test("lists every profile with its cached account and age, marking the active one, without a network call", async () => {
    const stdout = createCapture()
    const code = await run(
      ["profile", "list"],
      createTestDeps({ fetch: unusedFetch, stdout, now: () => NOW, ...twoProfiles() }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toContain("staging")
    expect(stdout.text).toContain("FaKwE2xX")
    expect(stdout.text).toContain("1h ago")
    expect(stdout.text).toContain("production")
    // `production` carries an account from before `accountCachedAt` existed: the age is what is
    // unknown, and "not cached" printed beside the very account it claimed was not cached.
    expect(stdout.text).toContain("age unknown")
    expect(stdout.text).not.toContain("not cached")
    expect(stdout.text).toMatch(/staging.*\(active\)|\(active\).*staging/)
  })

  test("a profile with no account at all still reads not cached", async () => {
    const stdout = createCapture()
    const config = createFakeConfigStore({ profiles: { fresh: { apiUrl: "https://api.candle.tv" } } })
    expect(await run(["profile", "list"], createTestDeps({ fetch: unusedFetch, stdout, ...config }))).toBe(0)
    expect(stdout.text).toContain("not cached")
    expect(stdout.text).not.toContain("age unknown")
  })

  test("--json returns the rows as data", async () => {
    const stdout = createCapture()
    await run(
      ["profile", "list", "--json"],
      createTestDeps({ fetch: unusedFetch, stdout, now: () => NOW, ...twoProfiles() }),
    )
    const rows = JSON.parse(stdout.text) as Array<{ name: string; active: boolean; cachedAge: string }>
    expect(rows.map((r) => r.name)).toEqual(["production", "staging"])
    expect(rows.find((r) => r.name === "staging")?.active).toBe(true)
  })

  test("with no profiles it says so and points at auth login", async () => {
    const stdout = createCapture()
    const code = await run(
      ["profile", "list"],
      createTestDeps({ fetch: unusedFetch, stdout, ...createFakeConfigStore({}) }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toContain("No profiles")
    expect(stdout.text).toContain("candle auth login")
  })

  test("works while several profiles exist and none is active (the refusal must not block it)", async () => {
    const config = createFakeConfigStore({ profiles: { a: {}, b: {} } })
    const stdout = createCapture()
    expect(await run(["profile", "list"], createTestDeps({ fetch: unusedFetch, stdout, ...config }))).toBe(0)
  })
})

describe("profile add", () => {
  test("creates an empty profile with its host, and makes it active when nothing was", async () => {
    const config = createFakeConfigStore({})
    const code = await run(
      ["profile", "add", "hood", "--api-url", "https://staging.api.candle.tv"],
      createTestDeps({ fetch: unusedFetch, ...config }),
    )
    expect(code).toBe(0)
    const after = await config.readConfig()
    expect(after.profiles?.hood).toEqual({ apiUrl: "https://staging.api.candle.tv" })
    expect(after.activeProfile).toBe("hood")
  })

  test("does not steal activeProfile, refuses an existing name and an invalid one", async () => {
    const config = twoProfiles()
    expect(
      await run(
        ["profile", "add", "hood", "--api-url", "https://x"],
        createTestDeps({ fetch: unusedFetch, ...config }),
      ),
    ).toBe(0)
    expect((await config.readConfig()).activeProfile).toBe("staging")
    const stderr = createCapture()
    expect(
      await run(
        ["profile", "add", "staging", "--api-url", "https://x"],
        createTestDeps({ fetch: unusedFetch, stderr, ...config }),
      ),
    ).toBe(1)
    expect(stderr.text).toContain("already exists")
    expect(
      await run(
        ["profile", "add", "bad name", "--api-url", "https://x"],
        createTestDeps({ fetch: unusedFetch, ...config }),
      ),
    ).toBe(2)
    expect(await run(["profile", "add", "hood2"], createTestDeps({ fetch: unusedFetch, ...config }))).toBe(2)
  })

  // Fix wave item 4: the profile group is the one group whose failures were bare sentences on
  // stderr under --json. A --json caller reads stdout and gets nothing at all, which is
  // indistinguishable from a command that printed no output and succeeded.
  test("--json renders an existing name as a machine-readable failure on stdout, nothing else", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["profile", "add", "staging", "--api-url", "https://x", "--json"],
      createTestDeps({ fetch: unusedFetch, stdout, stderr, ...twoProfiles() }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toBe("")
    const parsed = JSON.parse(stdout.text) as { ok: boolean; code: string; message: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("PROFILE_EXISTS")
    expect(parsed.message).toContain("staging")
  })

  // Fix wave item 10: the host is the one field `profile add` exists to record, and it is written
  // to config unread. A typo became a profile whose every command failed to reach anything, with
  // the mistake sitting in a file the operator had no reason to open.
  test("an unparseable --api-url is a usage error, and no profile is created", async () => {
    const config = createFakeConfigStore({})
    const stderr = createCapture()
    const code = await run(
      ["profile", "add", "hood", "--api-url", "staging.api.candle.tv"],
      createTestDeps({ fetch: unusedFetch, stderr, ...config }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toBe(
      "Invalid --api-url: staging.api.candle.tv. It needs a scheme, such as https://staging.api.candle.tv\n",
    )
    expect((await config.readConfig()).profiles).toBeUndefined()
  })

  test("a cleartext --api-url is refused, and no profile is created to fail later", async () => {
    const config = createFakeConfigStore({})
    const stderr = createCapture()
    const code = await run(
      ["profile", "add", "hood", "--api-url", "http://staging.api.candle.tv"],
      createTestDeps({ fetch: unusedFetch, stderr, ...config, env: {} }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("Refusing to send credentials in the clear")
    expect(stderr.text).toContain("CANDLE_ALLOW_INSECURE_HTTP")
    expect((await config.readConfig()).profiles).toBeUndefined()
  })

  test("a loopback --api-url is still accepted: local development needs no opt-in", async () => {
    const config = createFakeConfigStore({})
    const code = await run(
      ["profile", "add", "local", "--api-url", "http://localhost:3000"],
      createTestDeps({ fetch: unusedFetch, ...config, env: {} }),
    )
    expect(code).toBe(0)
    expect((await config.readConfig()).profiles?.local?.apiUrl).toBe("http://localhost:3000")
  })

  // `new URL` alone is not the test: it ACCEPTS "localhost:3000" (scheme "localhost:", no host)
  // and "api.candle.tv:443" the same way, so the host-shaped typo the check exists to catch was
  // the one shape it let through. The advice differs with what is actually wrong: a value with no
  // usable scheme is told to add one, while a value that HAS a scheme the client cannot speak is
  // told that -- "such as https://ftp://api.candle.tv" would be nonsense.
  test("an --api-url no command could reach is a usage error, and no profile is created", async () => {
    const cases = [
      ["localhost:3000", "Invalid --api-url: localhost:3000. It needs a scheme, such as https://localhost:3000\n"],
      [
        "api.candle.tv:443",
        "Invalid --api-url: api.candle.tv:443. It needs a scheme, such as https://api.candle.tv:443\n",
      ],
      ["ftp://api.candle.tv", "Invalid --api-url: ftp://api.candle.tv. The scheme must be http or https.\n"],
    ] as const
    for (const [value, expected] of cases) {
      const config = createFakeConfigStore({})
      const stderr = createCapture()
      const code = await run(
        ["profile", "add", "hood", "--api-url", value],
        createTestDeps({ fetch: unusedFetch, stderr, ...config }),
      )
      expect(code).toBe(2)
      expect(stderr.text).toBe(expected)
      expect((await config.readConfig()).profiles).toBeUndefined()
    }
  })

  test("http and https hosts are accepted, port and all", async () => {
    for (const value of ["http://localhost:3000", "https://api.candle.tv"]) {
      const config = createFakeConfigStore({})
      const code = await run(
        ["profile", "add", "hood", "--api-url", value],
        createTestDeps({ fetch: unusedFetch, ...config }),
      )
      expect(code).toBe(0)
      expect((await config.readConfig()).profiles?.hood).toEqual({ apiUrl: value })
    }
  })
})

describe("profile use", () => {
  test("sets activeProfile, refreshes the cached account live, and prints the identity line", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "NEWACCT1" }),
    })
    const config = twoProfiles()
    const store = createFakeStore({ "profile:production:api_key": "ck_live_prod" })
    const stdout = createCapture()
    const code = await run(
      ["profile", "use", "production"],
      createTestDeps({ fetch, store, stdout, now: () => NOW, ...config }),
    )
    expect(code).toBe(0)
    const after = await config.readConfig()
    expect(after.activeProfile).toBe("production")
    expect(after.profiles?.production?.account).toBe("NEWACCT1")
    expect(after.profiles?.production?.accountCachedAt).toBe(NOW)
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("ck_live_prod")
    expect(stdout.text).toContain("Profile: production   Account: NEWACCT1 at https://api.candle.tv")
  })

  // Fix wave item 5: switching to a profile that holds no credentials succeeded in silence, and
  // the identity line it printed looked exactly like a working switch. The next authenticated
  // command is where the operator found out, one error message removed from the cause.
  test("a profile with no stored key is switched to without a network call, cache untouched, and says so", async () => {
    const config = twoProfiles()
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["profile", "use", "production"],
      createTestDeps({ fetch: unusedFetch, store: createFakeStore(), stdout, stderr, ...config }),
    )
    expect(code).toBe(0)
    expect((await config.readConfig()).profiles?.production?.account).toBe("7o3msKCe")
    expect(stdout.text).toContain("Account: 7o3msKCe")
    expect(stderr.text).toContain("No stored credentials for production.")
    expect(stderr.text).toContain("candle auth login --profile production")
  })

  test("an unreachable API warns and still switches, keeping the cached account", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const config = twoProfiles()
    const stderr = createCapture()
    const code = await run(
      ["profile", "use", "production"],
      createTestDeps({
        fetch: failing,
        store: createFakeStore({ "profile:production:api_key": "k" }),
        stderr,
        ...config,
      }),
    )
    expect(code).toBe(0)
    expect((await config.readConfig()).activeProfile).toBe("production")
    expect(stderr.text).toContain("Could not refresh the account")
  })

  test("an unknown name refuses and lists the profiles", async () => {
    const stderr = createCapture()
    const code = await run(["profile", "use", "nope"], createTestDeps({ fetch: unusedFetch, stderr, ...twoProfiles() }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("staging")
    expect(stderr.text).toContain("production")
  })

  test("--json renders an unknown name as a machine-readable failure on stdout, nothing else", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["profile", "use", "nope", "--json"],
      createTestDeps({ fetch: unusedFetch, stdout, stderr, ...twoProfiles() }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toBe("")
    const parsed = JSON.parse(stdout.text) as { ok: boolean; code: string; message: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("NO_SUCH_PROFILE")
    expect(parsed.message).toContain("nope")
  })

  // Fix wave item 11: CANDLE_PROFILE beats activeProfile at resolution, so a shell that exports it
  // makes `profile use` look like it did nothing. It DID do something (activeProfile moved); the
  // env var is simply what every later command will read instead.
  test("an exported CANDLE_PROFILE that differs from the chosen name is named as taking precedence", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "NEWACCT1" }),
    })
    const config = twoProfiles()
    const stderr = createCapture()
    const code = await run(
      ["profile", "use", "production"],
      createTestDeps({
        fetch,
        store: createFakeStore({ "profile:production:api_key": "k" }),
        stderr,
        env: { CANDLE_PROFILE: "staging" },
        ...config,
      }),
    )
    expect(code).toBe(0)
    expect((await config.readConfig()).activeProfile).toBe("production")
    expect(stderr.text).toContain("CANDLE_PROFILE=staging is set and takes precedence over the active profile.")
  })

  test("a CANDLE_PROFILE naming the very profile being chosen says nothing", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "NEWACCT1" }),
    })
    const stderr = createCapture()
    await run(
      ["profile", "use", "production"],
      createTestDeps({
        fetch,
        store: createFakeStore({ "profile:production:api_key": "k" }),
        stderr,
        env: { CANDLE_PROFILE: "production" },
        ...twoProfiles(),
      }),
    )
    expect(stderr.text).toBe("")
  })
})

describe("profile rename", () => {
  test("moves both secret refs and the entry, and re-points activeProfile", async () => {
    const config = twoProfiles()
    const store = createFakeStore({
      "profile:staging:device_token": "d",
      "profile:staging:api_key": "k",
      wallet_signer_w1: "pem",
    })
    const code = await run(
      ["profile", "rename", "staging", "hood-staging"],
      createTestDeps({ fetch: unusedFetch, store, ...config }),
    )
    expect(code).toBe(0)
    expect(await store.get("profile:hood-staging:device_token")).toBe("d")
    expect(await store.get("profile:hood-staging:api_key")).toBe("k")
    expect(await store.get("profile:staging:device_token")).toBeNull()
    expect(await store.get("wallet_signer_w1")).toBe("pem")
    const after = await config.readConfig()
    expect(after.profiles?.["hood-staging"]?.account).toBe("FaKwE2xX")
    expect(after.profiles?.staging).toBeUndefined()
    expect(after.activeProfile).toBe("hood-staging")
  })

  test("refuses an unknown source, an existing target, and an invalid target", async () => {
    const config = twoProfiles()
    expect(await run(["profile", "rename", "nope", "x"], createTestDeps({ fetch: unusedFetch, ...config }))).toBe(1)
    expect(
      await run(["profile", "rename", "staging", "production"], createTestDeps({ fetch: unusedFetch, ...config })),
    ).toBe(1)
    expect(
      await run(["profile", "rename", "staging", "bad name"], createTestDeps({ fetch: unusedFetch, ...config })),
    ).toBe(2)
  })
})

describe("profile remove", () => {
  // Fix wave item 4: the dry run is a usage failure like any other (the invocation was
  // incomplete), so it goes out the way every other one does -- stderr in human mode, an envelope
  // on stdout under --json -- rather than as a sentence on the stream a --json caller parses.
  test("without --yes it says what it would delete and exits 2, deleting nothing", async () => {
    const config = twoProfiles()
    const store = createFakeStore({ "profile:staging:device_token": "d" })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["profile", "remove", "staging"],
      createTestDeps({ fetch: unusedFetch, store, stdout, stderr, ...config }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("--yes")
    expect(stderr.text).toContain("staging")
    expect(stdout.text).toBe("")
    expect(await store.get("profile:staging:device_token")).toBe("d")
    expect((await config.readConfig()).profiles?.staging).toBeDefined()
  })

  test("--json renders the dry run as a machine-readable usage failure on stdout, nothing else", async () => {
    const config = twoProfiles()
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["profile", "remove", "staging", "--json"],
      createTestDeps({ fetch: unusedFetch, store: createFakeStore(), stdout, stderr, ...config }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toBe("")
    const parsed = JSON.parse(stdout.text) as { ok: boolean; code: string; message: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("USAGE")
    expect(parsed.message).toContain("--yes")
    expect((await config.readConfig()).profiles?.staging).toBeDefined()
  })

  test("with --yes it deletes the refs and the entry, clears activeProfile, and leaves wallet signers alone", async () => {
    const config = twoProfiles()
    const store = createFakeStore({
      "profile:staging:device_token": "d",
      "profile:staging:api_key": "k",
      "profile:production:api_key": "p",
      wallet_signer_w1: "pem",
    })
    const code = await run(
      ["profile", "remove", "staging", "--yes"],
      createTestDeps({ fetch: unusedFetch, store, ...config }),
    )
    expect(code).toBe(0)
    expect(await store.get("profile:staging:device_token")).toBeNull()
    expect(await store.get("profile:staging:api_key")).toBeNull()
    expect(await store.get("profile:production:api_key")).toBe("p")
    expect(await store.get("wallet_signer_w1")).toBe("pem")
    const after = await config.readConfig()
    expect(after.profiles).toEqual({ production: { apiUrl: "https://api.candle.tv", account: "7o3msKCe" } })
    expect(after.activeProfile).toBeUndefined()
  })

  test("removing a non-active profile keeps activeProfile", async () => {
    const config = twoProfiles()
    await run(
      ["profile", "remove", "production", "--yes"],
      createTestDeps({ fetch: unusedFetch, store: createFakeStore(), ...config }),
    )
    expect((await config.readConfig()).activeProfile).toBe("staging")
  })

  test("an unknown name refuses", async () => {
    expect(
      await run(["profile", "remove", "nope", "--yes"], createTestDeps({ fetch: unusedFetch, ...twoProfiles() })),
    ).toBe(1)
  })

  // Fix wave item 12: removing the active profile leaves `activeProfile` unset. With one profile
  // left, resolution falls back to it and nothing is needed; with several, the very next command
  // refuses with "several profiles exist and none is selected", which the success message can
  // pre-empt in one line.
  test("removing the active profile while several remain points at the command that picks the next one", async () => {
    const config = createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: {}, production: {}, hood: {} },
    })
    const stdout = createCapture()
    const code = await run(
      ["profile", "remove", "staging", "--yes"],
      createTestDeps({ fetch: unusedFetch, store: createFakeStore(), stdout, ...config }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toContain("Deleted profile staging")
    expect(stdout.text).toContain("candle profile use")
    expect((await config.readConfig()).activeProfile).toBeUndefined()
  })

  test("removing the active profile with only one left says nothing about picking, since resolution falls back to it", async () => {
    const config = twoProfiles()
    const stdout = createCapture()
    await run(
      ["profile", "remove", "staging", "--yes"],
      createTestDeps({ fetch: unusedFetch, store: createFakeStore(), stdout, ...config }),
    )
    expect(stdout.text).toContain("Deleted profile staging")
    expect(stdout.text).not.toContain("candle profile use")
  })
})
