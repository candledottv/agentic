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

// `GET /keys` as `keys list` reads it: what stop and resume resolve a label against (BE-3298).
const listRoute = () =>
  jsonResponse(200, {
    success: true,
    keys: [
      { keyPrefix: "ck_test1", label: "bot one" },
      { keyPrefix: "-Ab3dEf9" },
      { keyPrefix: "Twin0001", label: "twin" },
      { keyPrefix: "Twin0002", label: "twin" },
    ],
  })

for (const command of ["stop", "resume"] as const) {
  const paused = command === "stop"
  const state = paused ? "stopped" : "resumed"

  describe(`keys ${command}`, () => {
    test("POSTs the encoded prefix and paused boolean with device auth, preserving JSON", async () => {
      const body = { success: true, paused, changed: true }
      const { fetch, calls } = createRoutedFetch({
        "/api/v1/agent/keys": listRoute,
        "/api/v1/agent/keys/-Ab3dEf9/stop": () => jsonResponse(200, body),
      })
      const stdout = createCapture()
      const stderr = createCapture()
      const store = createFakeStore({ device_token: "cndl_dvc_test", api_key: "cndl_live_unused" })
      const code = await run(["keys", command, "-Ab3dEf9", "--json"], createTestDeps({ fetch, store, stdout, stderr }))
      expect(code).toBe(0)
      expect(calls).toHaveLength(2)
      expect(calls[1]?.init.method).toBe("POST")
      expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer cndl_dvc_test")
      expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ paused })
      expect(JSON.parse(stdout.text)).toEqual(body)
      expect(stderr.text).toBe("")
    })

    for (const changed of [true, false]) {
      test(`renders changed=${changed} and retains the stored working key`, async () => {
        const { fetch } = createRoutedFetch({
          "/api/v1/agent/keys": listRoute,
          "/api/v1/agent/keys/ck_test1/stop": () => jsonResponse(200, { success: true, paused, changed }),
        })
        const stdout = createCapture()
        const store = createFakeStore({ device_token: "cndl_dvc_test", api_key: "cndl_live_working" })
        const config = createFakeConfigStore({ keyPrefix: "ck_test1" })
        const code = await run(["keys", command, "ck_test1"], createTestDeps({ fetch, store, stdout, ...config }))
        expect(code).toBe(0)
        expect(stdout.text).toContain(`Key ck_test1 ${changed ? "" : "already "}${state}.`)
        expect(await store.get("profile:default:api_key")).toBe("cndl_live_working")
        expect((await config.readConfig()).profiles?.default?.keyPrefix).toBe("ck_test1")
      })
    }

    test("uses the selected profile's device token and API host", async () => {
      const { fetch, calls } = createRoutedFetch({
        "/api/v1/agent/keys": listRoute,
        "/api/v1/agent/keys/ck_test1/stop": () => jsonResponse(200, { success: true, paused, changed: true }),
      })
      const store = createFakeStore({ "profile:other:device_token": "cndl_dvc_other" })
      const config = createFakeConfigStore({ profiles: { other: { apiUrl: "https://other.example" } } })
      const code = await run(
        ["--profile", "other", "keys", command, "ck_test1"],
        createTestDeps({ fetch, store, ...config }),
      )
      expect(code).toBe(0)
      expect(calls[0]?.url).toBe("https://other.example/api/v1/agent/keys")
      expect(calls[1]?.url).toBe("https://other.example/api/v1/agent/keys/ck_test1/stop")
      expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer cndl_dvc_other")
    })

    test("requires a device token even when an API key is available", async () => {
      const { fetch, calls } = createRoutedFetch({})
      const stdout = createCapture()
      const store = createFakeStore({ api_key: "cndl_live_only" })
      const code = await run(["keys", command, "ck_test1", "--json"], createTestDeps({ fetch, store, stdout }))
      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      expect(JSON.parse(stdout.text).code).toBe("NO_DEVICE_TOKEN")
    })

    for (const args of [[], ["one", "two"], [" "], ["one", "--unknown"]]) {
      test(`rejects invalid arguments ${JSON.stringify(args)} before requesting`, async () => {
        const { fetch, calls } = createRoutedFetch({})
        const stdout = createCapture()
        const code = await run(["keys", command, ...args, "--json"], createTestDeps({ fetch, stdout }))
        expect(code).toBe(2)
        expect(calls).toHaveLength(0)
        expect(JSON.parse(stdout.text).ok).toBe(false)
      })
    }

    for (const status of [401, 403, 404, 500]) {
      test(`propagates HTTP ${status} as failure without claiming success`, async () => {
        const { fetch } = createRoutedFetch({
          "/api/v1/agent/keys": listRoute,
          "/api/v1/agent/keys/ck_test1/stop": () =>
            jsonResponse(status, { error: { code: "VALIDATION_FAILED", message: "Cannot change this key" } }),
        })
        const stdout = createCapture()
        const store = createFakeStore({ device_token: "cndl_dvc_test" })
        const code = await run(["keys", command, "ck_test1", "--json"], createTestDeps({ fetch, store, stdout }))
        expect(code).toBe(1)
        expect(JSON.parse(stdout.text).message).toContain("Cannot change this key")
        expect(stdout.text).not.toContain(`Key ck_test1 ${state}`)
      })
    }

    test("reports a network failure", async () => {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/keys": listRoute,
        "/api/v1/agent/keys/ck_test1/stop": () => {
          throw new Error("offline")
        },
      })
      const stdout = createCapture()
      const store = createFakeStore({ device_token: "cndl_dvc_test" })
      const code = await run(["keys", command, "ck_test1", "--json"], createTestDeps({ fetch, store, stdout }))
      expect(code).toBe(1)
      expect(JSON.parse(stdout.text).ok).toBe(false)
    })

    test("a label resolves to its live key's prefix (BE-3298)", async () => {
      const { fetch, calls } = createRoutedFetch({
        "/api/v1/agent/keys": listRoute,
        "/api/v1/agent/keys/ck_test1/stop": () => jsonResponse(200, { success: true, paused, changed: true }),
      })
      const stdout = createCapture()
      const store = createFakeStore({ device_token: "cndl_dvc_test" })
      const code = await run(["keys", command, "bot one"], createTestDeps({ fetch, store, stdout }))
      expect(code).toBe(0)
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/v1/agent/keys",
        "/api/v1/agent/keys/ck_test1/stop",
      ])
      expect(stdout.text).toContain(`Key ck_test1 ${state}.`)
    })

    test("an ambiguous label refuses with both prefixes and changes nothing", async () => {
      const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/keys": listRoute })
      const stdout = createCapture()
      const store = createFakeStore({ device_token: "cndl_dvc_test" })
      const code = await run(["keys", command, "twin", "--json"], createTestDeps({ fetch, store, stdout }))
      expect(code).toBe(1)
      expect(calls).toHaveLength(1)
      const body = JSON.parse(stdout.text)
      expect(body.code).toBe(`KEY_${command.toUpperCase()}_KEY_AMBIGUOUS`)
      expect(body.suggestion).toContain("Twin0001")
      expect(body.suggestion).toContain("Twin0002")
    })

    test("an unknown label refuses locally and changes nothing", async () => {
      const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/keys": listRoute })
      const stdout = createCapture()
      const store = createFakeStore({ device_token: "cndl_dvc_test" })
      const code = await run(["keys", command, "nobody", "--json"], createTestDeps({ fetch, store, stdout }))
      expect(code).toBe(1)
      expect(calls).toHaveLength(1)
      expect(JSON.parse(stdout.text).code).toBe(`KEY_${command.toUpperCase()}_KEY_NOT_FOUND`)
    })
  })
}
