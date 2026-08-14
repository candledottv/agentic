/**
 * `resolveDeviceToken` / `resolveApiKey`: the one place credential precedence (env override, then
 * the store) is defined. Every command relies on this being right, so it gets its own direct
 * coverage rather than only being exercised incidentally through command tests.
 */

import { describe, expect, test } from "bun:test"
import { resolveApiKey, resolveDeviceToken } from "./deps"
import { createFakeStore, createTestDeps } from "./test-support"

describe("resolveDeviceToken", () => {
  test("returns the env override when CANDLE_DEVICE_TOKEN is set, ignoring the store", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore({ device_token: "stored_value" }),
      env: { CANDLE_DEVICE_TOKEN: "env_value" },
    })
    expect(await resolveDeviceToken(deps)).toBe("env_value")
  })

  test("falls back to the store when no env override is set", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore({ device_token: "stored_value" }),
      env: {},
    })
    expect(await resolveDeviceToken(deps)).toBe("stored_value")
  })

  test("returns undefined when neither the env nor the store has a value", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore(),
      env: {},
    })
    expect(await resolveDeviceToken(deps)).toBeUndefined()
  })

  test("an empty-string env override is treated as unset, not as an empty credential", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore({ device_token: "stored_value" }),
      env: { CANDLE_DEVICE_TOKEN: "   " },
    })
    expect(await resolveDeviceToken(deps)).toBe("stored_value")
  })
})

describe("resolveApiKey", () => {
  test("returns the env override when CANDLE_API_KEY is set, ignoring the store", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore({ api_key: "stored_key" }),
      env: { CANDLE_API_KEY: "env_key" },
    })
    expect(await resolveApiKey(deps)).toBe("env_key")
  })

  test("falls back to the store when no env override is set", async () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
      store: createFakeStore({ api_key: "stored_key" }),
      env: {},
    })
    expect(await resolveApiKey(deps)).toBe("stored_key")
  })
})
