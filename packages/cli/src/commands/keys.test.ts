/**
 * `keys list` / `keys create` / `keys revoke`, driven through `run()`. See task-3-brief.md Step 1
 * for the pinned behaviors: "minted by" rendering, store-only-if-empty on create, and
 * clear-the-local-ref-on-self-revoke.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { SECRET_REFS } from "../secret-store"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

describe("keys list", () => {
  test("renders 'minted by' as 'this device' when it matches the stored deviceTokenPrefix, 'browser session' when absent, and the raw prefix for a different device", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          tier: "free",
          keys: [
            {
              keyPrefix: "ck_liveaa",
              scopes: ["launch:write"],
              environment: "production",
              createdAt: 1000,
              mintedByDevicePrefix: "dvcpref1",
            },
            {
              keyPrefix: "ck_livebb",
              scopes: ["launch:write"],
              environment: "production",
              createdAt: 2000,
              mintedByDevicePrefix: undefined,
            },
            {
              keyPrefix: "ck_livecc",
              scopes: ["launch:write"],
              environment: "production",
              createdAt: 3000,
              mintedByDevicePrefix: "dvcprefOTHER",
            },
          ],
        }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const configStore = createFakeConfigStore({ deviceTokenPrefix: "dvcpref1" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["keys", "list"], deps)

    expect(code).toBe(0)
    // The first line is the identity line printIdentity prints ahead of every command's own
    // output; the table itself is everything after it, which is what the "minted by" assertions
    // below are actually about.
    const [, ...tableLines] = stdout.text.split("\n")
    const table = tableLines.join("\n")
    expect(table).toContain("this device")
    // Absent provenance means the key was created in a signed-in browser session (or predates
    // provenance entirely) -- "unknown" read as "a device Candle cannot identify," which a live
    // session escalated as a possible compromise. "browser session" is the truth.
    expect(table).toContain("browser session")
    expect(table).not.toContain("unknown")
    expect(table).toContain("dvcprefOTHER")
  })

  test("requires a device token; without one it fails without making a request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(["keys", "list"], createTestDeps({ fetch, stderr }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text.toLowerCase()).toContain("auth login")
  })

  // The missing-credential exits used to print a plain sentence regardless of --json, so a
  // --json caller got unparseable output on the single most common failure the CLI has.
  test("every keys subcommand's missing-device-token exit honors --json: stdout parses, and carries the code", async () => {
    for (const argv of [
      ["keys", "list", "--json"],
      ["keys", "create", "--json"],
      ["keys", "revoke", "ck_liveab", "--json"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const stdout = createCapture()
      const stderr = createCapture()
      const code = await run(argv, createTestDeps({ fetch, stdout, stderr }))
      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      expect(stderr.text).toBe("")
      const parsed = JSON.parse(stdout.text)
      expect(parsed).toEqual({
        ok: false,
        code: "NO_DEVICE_TOKEN",
        message: "No device token available.",
        suggestion: "Run: candle auth login",
      })
    }
  })

  test("an unknown flag on this read-only command is a usage error, exit 2, with no request made (fix round 1, item 3)", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stderr = createCapture()
    const code = await run(["keys", "list", "--bogus"], createTestDeps({ fetch, store, stderr }))
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--bogus")
  })
})

describe("keys list: Name and Access", () => {
  // The operator's two keys from 2026-09-23, verbatim: the same six scopes stored in two orders
  // (the web minted the first, the device flow the second), and only the first one named.
  const JPVPY8GS = {
    keyPrefix: "JpVPY8gs",
    label: "cndl",
    scopes: ["launch:write", "launch:read", "activity:write", "swap:write", "transfer:write", "account:read"],
    environment: "production",
    createdAt: Date.UTC(2026, 8, 20),
  }
  const B6P_TSRS = {
    keyPrefix: "B6P-TSRs",
    scopes: ["launch:write", "launch:read", "account:read", "activity:write", "swap:write", "transfer:write"],
    environment: "production",
    createdAt: Date.UTC(2026, 8, 23),
    mintedByDevicePrefix: "dvcpref1",
  }
  const SORTED = "account:read,activity:write,launch:read,launch:write,swap:write,transfer:write"

  async function list(keys: object[], argv: string[] = []) {
    const payload = { success: true, tier: "free", keys }
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys": () => jsonResponse(200, payload) })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const configStore = createFakeConfigStore({ deviceTokenPrefix: "dvcpref1" })
    const stdout = createCapture()
    const code = await run(
      ["keys", "list", ...argv],
      createTestDeps({
        fetch,
        store,
        readConfig: configStore.readConfig,
        writeConfig: configStore.writeConfig,
        clearConfig: configStore.clearConfig,
        stdout,
      }),
    )
    expect(code).toBe(0)
    return { payload, stdout: stdout.text }
  }

  /** The table's lines, identity line dropped, each split on the two-space column gap. */
  function tableRows(stdout: string): string[][] {
    const lines = stdout.split("\n").filter((line) => line.length > 0)
    const headerAt = lines.findIndex((line) => line.startsWith("Prefix"))
    return lines.slice(headerAt).map((line) => line.split(/ {2,}/).map((cell) => cell.trim()))
  }

  test("both of the operator's keys read Read:Write, the named one leads with its name, the other is blank", async () => {
    const { stdout } = await list([JPVPY8GS, B6P_TSRS])
    const lines = stdout.split("\n")
    const header = lines.find((line) => line.startsWith("Prefix")) ?? ""
    expect(header.split(/ {2,}/)).toEqual([
      "Prefix",
      "Name",
      "Access",
      "Environment",
      "Created",
      "Last used",
      "Revoked",
      "Minted by",
    ])
    const first = lines.find((line) => line.startsWith("JpVPY8gs")) ?? ""
    const second = lines.find((line) => line.startsWith("B6P-TSRs")) ?? ""
    expect(first).toMatch(/^JpVPY8gs {2}cndl {2}Read:Write {2}production /)
    // Blank Name: the cell is padded to the column's width, so Access starts where it does above.
    expect(second).toMatch(/^B6P-TSRs {8}Read:Write {2}production /)
    expect(second.indexOf("Read:Write")).toBe(first.indexOf("Read:Write"))
    expect(first.endsWith("browser session")).toBe(true)
    expect(second.endsWith("this device")).toBe(true)
    expect(stdout).not.toContain("account:read")
  })

  test("a key matching neither preset reads as the web's chip words, or – when it holds none", async () => {
    const rows = tableRows(
      (
        await list([
          { ...B6P_TSRS, keyPrefix: "legacyful", scopes: JPVPY8GS.scopes.filter((s) => s !== "account:read") },
          { ...B6P_TSRS, keyPrefix: "readonly1", scopes: ["launch:read"] },
          { ...B6P_TSRS, keyPrefix: "readkey01", scopes: ["account:read"] },
        ])
      ).stdout,
    )
    const access = (prefix: string) => rows.find((row) => row[0] === prefix)?.[1]
    // No label on these rows, so the blank Name cell collapses and Access is the second cell.
    expect(access("legacyful")).toBe("Launch, Trade, Transfer, Report")
    expect(access("readonly1")).toBe("–")
    expect(access("readkey01")).toBe("Read")
  })

  test("--scopes adds a sorted Scopes column after Access, and both keys print the same string", async () => {
    const { stdout } = await list([JPVPY8GS, B6P_TSRS], ["--scopes"])
    const rows = tableRows(stdout)
    expect(rows[0]?.slice(0, 4)).toEqual(["Prefix", "Name", "Access", "Scopes"])
    expect(rows.find((row) => row[0] === "JpVPY8gs")?.slice(1, 4)).toEqual(["cndl", "Read:Write", SORTED])
    expect(rows.find((row) => row[0] === "B6P-TSRs")?.slice(1, 3)).toEqual(["Read:Write", SORTED])
  })

  test("a label carrying a newline and a bidi override renders on one line with neither", async () => {
    const { stdout } = await list([{ ...JPVPY8GS, label: "evil\nname‮gnp.exe" }])
    const row = stdout.split("\n").find((line) => line.startsWith("JpVPY8gs")) ?? ""
    expect(row).toContain("evil name gnp.exe  Read:Write")
    expect(stdout).not.toContain("‮")
    expect(stdout.split("\n").some((line) => line.startsWith("name"))).toBe(false)
  })

  test("--json is the API's payload, byte for byte, with or without --scopes", async () => {
    for (const argv of [["--json"], ["--json", "--scopes"]]) {
      const { payload, stdout } = await list([JPVPY8GS, B6P_TSRS], argv)
      expect(stdout).toBe(`${JSON.stringify(payload)}\n`)
    }
  })
})

describe("keys create", () => {
  test("prints the plaintext key exactly once and stores it when no api_key ref exists yet", async () => {
    const NEW_KEY = "ck_live_FIXTURE_NEW_KEY_VALUE"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: NEW_KEY,
          keyPrefix: "ck_livenn",
          scopes: ["launch:write", "launch:read", "activity:write"],
          environment: "production",
        }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
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

    const code = await run(["keys", "create"], deps)

    expect(code).toBe(0)
    const occurrences = stdout.text.split(NEW_KEY).length - 1
    expect(occurrences).toBe(1)
    expect(await store.get(SECRET_REFS.apiKey)).toBe(NEW_KEY)
    expect((await configStore.readConfig()).keyPrefix).toBe("ck_livenn")
  })

  test("does NOT store the new key when the store already holds one; still prints it once", async () => {
    const NEW_KEY = "ck_live_FIXTURE_SECOND_KEY_VALUE"
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: NEW_KEY,
          keyPrefix: "ck_livenn",
          scopes: ["launch:write"],
          environment: "production",
        }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_EXISTING_WORKING_KEY" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveex" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["keys", "create"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain(NEW_KEY)
    expect(await store.get(SECRET_REFS.apiKey)).toBe("ck_live_EXISTING_WORKING_KEY")
    expect((await configStore.readConfig()).keyPrefix).toBe("ck_liveex")
  })

  test("calls out swap:write as fund-moving at the moment the key is actually minted (fix round 1, item 16)", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: "ck_live_FIXTURE_SWAP_KEY",
          keyPrefix: "ck_liveswap",
          scopes: ["launch:write", "swap:write"],
          environment: "production",
        }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["keys", "create", "--scopes", "launch:write,swap:write"], deps)

    expect(code).toBe(0)
    expect(stdout.text).toContain("swap:write")
    expect(stdout.text.toLowerCase()).toContain("fund")
  })
})

describe("keys revoke", () => {
  test("revoking the stored prefix also clears the local api_key ref and says so", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/ck_liveab": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_stored" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveab" })
    const stdout = createCapture()
    // This config's legacy `keyPrefix` is silently migrated to profile "default" on the very
    // first dispatch (profiles.ts's migratedConfig), so `deps` must wire ALL four config-store
    // fields (not just the three read/write/clear ones the pre-profile version of this test
    // needed) -- `updateProfile` is how the revoke actually clears the migrated profile's key.
    const deps = createTestDeps({ fetch, store, stdout, ...configStore })

    const code = await run(["keys", "revoke", "ck_liveab"], deps)

    expect(code).toBe(0)
    expect(calls[0]?.init.method).toBe("DELETE")
    // The ref and field this clears are the namespaced ones the migrated "default" profile
    // actually uses -- not the untouched legacy `api_key` / top-level `keyPrefix`, which
    // migration deliberately leaves in place so a rollback to a pre-profile CLI keeps working.
    expect(await store.get("profile:default:api_key")).toBeNull()
    expect((await configStore.readConfig()).profiles?.default?.keyPrefix).toBeUndefined()
    expect(stdout.text.toLowerCase()).toContain("cleared")
  })

  test("revoking a DIFFERENT prefix leaves the stored api_key ref untouched", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys/ck_liveother": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: "ck_live_stored" })
    const configStore = createFakeConfigStore({ keyPrefix: "ck_liveab" })
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
    })

    const code = await run(["keys", "revoke", "ck_liveother"], deps)

    expect(code).toBe(0)
    expect(await store.get(SECRET_REFS.apiKey)).toBe("ck_live_stored")
    expect((await configStore.readConfig()).keyPrefix).toBe("ck_liveab")
  })

  test("URL-encodes the prefix path segment (fix round 1, item 12)", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/weird%2Fprefix": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const deps = createTestDeps({ fetch, store })

    const code = await run(["keys", "revoke", "weird/prefix"], deps)

    expect(code).toBe(0)
    expect(calls[0]?.url).toContain("weird%2Fprefix")
  })
})

describe("keys create: name, expiry, and transaction limit (portal parity)", () => {
  const routes = () =>
    createRoutedFetch({
      "/api/v1/agent/keys": () => {
        // Assertions read the SENT body off createRoutedFetch's captured calls, not this response.
        return jsonResponse(200, {
          success: true,
          key: "cndl_live_plain",
          keyPrefix: "ck_liveaa",
          scopes: ["launch:write"],
          environment: "production",
        })
      },
    })

  test("--label, --expires-in, and --tx-limit ride the POST body in the API's own field shapes", async () => {
    const { fetch, calls } = routes()
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const code = await run(
      [
        "keys",
        "create",
        "--label",
        "trading-bot",
        "--expires-in",
        "30",
        "--tx-limit",
        "$1,500.50",
        "--reset",
        "weekly",
      ],
      createTestDeps({ fetch, store }),
    )
    expect(code).toBe(0)
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.label).toBe("trading-bot")
    expect(body.expiresInDays).toBe(30)
    expect(body.txLimit).toEqual({ usdMicros: 1_500_500_000, reset: "weekly" })
  })

  test("omitted flags are omitted from the body entirely, never sent blank", async () => {
    const { fetch, calls } = routes()
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const code = await run(["keys", "create"], createTestDeps({ fetch, store }))
    expect(code).toBe(0)
    const body = JSON.parse(String(calls[0]?.init.body))
    expect("label" in body).toBe(false)
    expect("expiresInDays" in body).toBe(false)
    expect("txLimit" in body).toBe(false)
  })

  test("--tx-limit without --reset defaults to daily, matching the portal's create form", async () => {
    const { fetch, calls } = routes()
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const code = await run(["keys", "create", "--tx-limit", "100"], createTestDeps({ fetch, store }))
    expect(code).toBe(0)
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.txLimit).toEqual({ usdMicros: 100_000_000, reset: "daily" })
  })

  test("malformed values fail as usage errors BEFORE any request: bad amount, bad days, bare --reset, oversize label", async () => {
    for (const argv of [
      ["keys", "create", "--tx-limit", "a-lot"],
      ["keys", "create", "--expires-in", "0"],
      ["keys", "create", "--expires-in", "1.5"],
      ["keys", "create", "--reset", "weekly"],
      ["keys", "create", "--label", "x".repeat(65)],
      ["keys", "create", "--tx-limit", "100", "--reset", "hourly"],
    ]) {
      const { fetch, calls } = routes()
      const store = createFakeStore({ device_token: "cndl_dvc_x" })
      const code = await run(argv, createTestDeps({ fetch, store }))
      expect(code).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("a usage error under --json is still an envelope on stdout", async () => {
    const { fetch } = routes()
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const stdout = createCapture()
    const code = await run(["keys", "create", "--tx-limit", "nope", "--json"], createTestDeps({ fetch, store, stdout }))
    expect(code).toBe(2)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.ok).toBe(false)
    expect(envelope.code).toBe("USAGE")
    expect(envelope.message).toContain("--tx-limit")
  })
})

describe("profiles", () => {
  test("keys create stores the key under the profile and records its prefix on the profile", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(201, {
          success: true,
          key: "ck_live_new",
          keyPrefix: "ck_live_ne",
          scopes: ["trade:write"],
          createdAt: 1,
        }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "A" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(
      ["keys", "create", "--scopes", "trade:write"],
      createTestDeps({ fetch, store, stdout, ...config }),
    )
    expect(code).toBe(0)
    expect(await store.get("profile:staging:api_key")).toBe("ck_live_new")
    expect(await store.get("api_key")).toBeNull()
    expect((await config.readConfig()).profiles?.staging).toMatchObject({
      keyPrefix: "ck_live_ne",
      scopes: ["trade:write"],
    })
    expect(stdout.text.startsWith("Profile: staging   Account: A at ")).toBe(true)
  })

  test("keys list reads the PROFILE's device prefix, so a key this device minted still says 'this device'", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          keys: [
            {
              keyPrefix: "ck_liveaa",
              scopes: ["launch:write"],
              environment: "production",
              createdAt: 1000,
              mintedByDevicePrefix: "dvcprofl",
            },
          ],
        }),
    })
    const store = createFakeStore({ "profile:staging:device_token": "d" })
    const config = createFakeConfigStore({
      profiles: { staging: { deviceTokenPrefix: "dvcprofl" } },
      activeProfile: "staging",
    })
    const stdout = createCapture()

    const code = await run(["keys", "list"], createTestDeps({ fetch, store, stdout, ...config }))

    expect(code).toBe(0)
    // Reading the legacy top-level `deviceTokenPrefix` (absent on every login-created profile)
    // printed this device's own prefix as if it belonged to some other machine.
    expect(stdout.text).toContain("this device")
    expect(stdout.text).not.toContain("browser session")
  })

  test("with CANDLE_API_KEY set, the identity line names the override instead of the profile's cached account", async () => {
    // The cached account describes the profile's OWN key. An env override is a different
    // credential, possibly a different account entirely, and printing the cached name beside it
    // asserts an identity nothing checked -- the exact failure the identity line exists to stop.
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys": () => jsonResponse(200, { success: true, keys: [] }) })
    const store = createFakeStore({ "profile:staging:device_token": "d" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "FaKwE2xX" } }, activeProfile: "staging" })
    const stdout = createCapture()

    const code = await run(
      ["keys", "list"],
      createTestDeps({ fetch, store, stdout, env: { CANDLE_API_KEY: "ck_live_from_env" }, ...config }),
    )

    expect(code).toBe(0)
    expect(stdout.text).toContain("Account: unknown (CANDLE_API_KEY override)")
    expect(stdout.text).not.toContain("FaKwE2xX")
  })

  test("keys revoke of the stored key clears the profile's key and prefix", async () => {
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys/ck_live_ne": () => jsonResponse(200, { success: true }) })
    const store = createFakeStore({ "profile:staging:device_token": "d", "profile:staging:api_key": "ck_live_new" })
    const config = createFakeConfigStore({
      profiles: { staging: { keyPrefix: "ck_live_ne" } },
      activeProfile: "staging",
    })
    const code = await run(["keys", "revoke", "ck_live_ne"], createTestDeps({ fetch, store, ...config }))
    expect(code).toBe(0)
    expect(await store.get("profile:staging:api_key")).toBeNull()
    expect((await config.readConfig()).profiles?.staging?.keyPrefix).toBeUndefined()
  })
})

/**
 * The API issues the plaintext key exactly once. A store failure used to skip the display
 * entirely, leaving an ACTIVE key on the account that nobody had ever seen: unusable, and
 * revocable only by first noticing an orphaned prefix in `keys list`.
 */
describe("keys create: a storage failure never swallows the key", () => {
  const FAIL_KEY = "ck_live_FIXTURE_UNSTORABLE"
  const routes = () =>
    createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: FAIL_KEY,
          keyPrefix: "ck_livezz",
          scopes: ["trade:write"],
          environment: "live",
        }),
    })
  const lockedStore = () => {
    const base = createFakeStore({ device_token: "cndl_dvc_x" })
    return {
      ...base,
      set: async () => {
        throw new Error("keychain is locked")
      },
    }
  }

  test("the key is printed, the failure is reported, and the exit is non-zero", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["keys", "create"],
      createTestDeps({ fetch: routes().fetch, store: lockedStore(), stdout, stderr }),
    )
    expect(stdout.text).toContain(FAIL_KEY)
    expect(stderr.text).toMatch(/NOT stored/)
    expect(stderr.text).toContain("keys revoke")
    expect(code).toBe(1)
  })

  test("--json still emits one object carrying the key and the failure", async () => {
    const stdout = createCapture()
    const code = await run(
      ["keys", "create", "--json"],
      createTestDeps({ fetch: routes().fetch, store: lockedStore(), stdout }),
    )
    const parsed = JSON.parse(stdout.text.trim()) as { key: string; stored: boolean; storeError?: string }
    expect(parsed.key).toBe(FAIL_KEY)
    expect(parsed.stored).toBe(false)
    expect(parsed.storeError).toMatch(/locked/)
    expect(code).toBe(1)
  })
})

// Read:Write:Transfer (2026-09-24 spec, D6 / R17): `keys create --access` maps each level to the
// exact scope list the shared module mints for that preset, so a key created here is the same key
// the web picker creates. `--access` and `--scopes` together is a usage error, exit 2, no request.
describe("keys create --access (R17)", () => {
  const LEVELS: Array<[string, string[]]> = [
    ["read", ["account:read"]],
    ["read-write", ["launch:write", "launch:read", "activity:write", "swap:write", "transfer:write", "account:read"]],
    [
      "read-write-transfer",
      [
        "launch:write",
        "launch:read",
        "activity:write",
        "swap:write",
        "transfer:write",
        "account:read",
        "transfer:bound",
      ],
    ],
  ]
  for (const [level, scopes] of LEVELS) {
    test(`--access ${level} sends exactly the preset's scope list`, async () => {
      const { fetch, calls } = createRoutedFetch({
        "/api/v1/agent/keys": () =>
          jsonResponse(200, {
            success: true,
            key: "ck_live_FIXTURE_ACCESS_KEY",
            keyPrefix: "ck_liveacc",
            scopes,
            environment: "production",
          }),
      })
      const store = createFakeStore({ device_token: "cndl_dvc_x" })
      const stdout = createCapture()
      const code = await run(
        ["keys", "create", "--access", level, "--label", "rebalancer"],
        createTestDeps({ fetch, store, stdout }),
      )
      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect((JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>).scopes).toEqual(scopes)
      expect(stdout.text).not.toContain("No --access or --scopes given")
    })
  }

  test("read-write-transfer calls out transfer:bound as fund-moving when the key is minted", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          key: "ck_live_FIXTURE_RWT_KEY",
          keyPrefix: "ck_livermt",
          scopes: LEVELS[2]?.[1],
          environment: "production",
        }),
    })
    const stdout = createCapture()
    const code = await run(
      ["keys", "create", "--access", "read-write-transfer"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toContain("transfer:bound (moves funds")
  })

  test("--access with --scopes is a usage error, exit 2, with no request made", async () => {
    for (const argv of [
      ["keys", "create", "--access", "read", "--scopes", "account:read"],
      ["keys", "create", "--access", "read-write-transfer", "--scopes", "transfer:bound", "--json"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const stdout = createCapture()
      const stderr = createCapture()
      const code = await run(
        argv,
        createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout, stderr }),
      )
      expect(code).toBe(2)
      expect(calls).toHaveLength(0)
      if (argv.includes("--json")) expect(JSON.parse(stdout.text).message).toContain("mutually exclusive")
      else expect(stderr.text).toContain("mutually exclusive")
    }
  })

  test("an unknown --access value is a usage error naming the three levels, with no request made", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(
      ["keys", "create", "--access", "full"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stderr }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("read, read-write, read-write-transfer")
  })
})

// R18: `keys list` reads the shared classification, so the third preset prints its name and a
// key holding transfer:bound in any other combination prints its chip words, Linked transfer included.
describe("keys list: Read:Write:Transfer (R18)", () => {
  test("prints Read:Write:Transfer for the preset and Linked transfer for a custom set", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": () =>
        jsonResponse(200, {
          success: true,
          tier: "pro",
          keys: [
            {
              keyPrefix: "ck_livermt",
              label: "rebalancer",
              scopes: [
                "transfer:bound",
                "account:read",
                "launch:write",
                "launch:read",
                "activity:write",
                "swap:write",
                "transfer:write",
              ],
              environment: "production",
              createdAt: 1000,
            },
            {
              keyPrefix: "ck_livecus",
              scopes: ["account:read", "transfer:write", "transfer:bound"],
              environment: "production",
              createdAt: 2000,
            },
          ],
        }),
    })
    const stdout = createCapture()
    const code = await run(
      ["keys", "list"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout }),
    )
    expect(code).toBe(0)
    const [, ...tableLines] = stdout.text.split("\n")
    const first = tableLines.find((line) => line.startsWith("ck_livermt"))
    const second = tableLines.find((line) => line.startsWith("ck_livecus"))
    expect(first).toMatch(/^ck_livermt {2}rebalancer {2}Read:Write:Transfer {2,}production /)
    expect(second).toContain("Transfer, Linked transfer")
    expect(second).not.toContain("Read:Write:Transfer")
  })
})
