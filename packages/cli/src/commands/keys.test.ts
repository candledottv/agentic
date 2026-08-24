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
    expect(stdout.text).toContain("this device")
    // Absent provenance means the key was created in a signed-in browser session (or predates
    // provenance entirely) -- "unknown" read as "a device Candle cannot identify," which a live
    // session escalated as a possible compromise. "browser session" is the truth.
    expect(stdout.text).toContain("browser session")
    expect(stdout.text).not.toContain("unknown")
    expect(stdout.text).toContain("dvcprefOTHER")
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
    const deps = createTestDeps({
      fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
    })

    const code = await run(["keys", "revoke", "ck_liveab"], deps)

    expect(code).toBe(0)
    expect(calls[0]?.init.method).toBe("DELETE")
    expect(await store.get(SECRET_REFS.apiKey)).toBeNull()
    expect((await configStore.readConfig()).keyPrefix).toBeUndefined()
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
