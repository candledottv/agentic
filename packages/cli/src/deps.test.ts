/**
 * `resolveDeviceToken` / `resolveApiKey`: the one place credential precedence (env override, then
 * the store) is defined. Every command relies on this being right, so it gets its own direct
 * coverage rather than only being exercised incidentally through command tests.
 *
 * T2 (BE-274, D1) is the other half: `homedir` is a dep, and the two implementations of it are the
 * whole point of the seam -- the real one is `node:os`, the test one is a path that cannot exist.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { resolveApiKey, resolveDeviceToken } from "./deps"
import { createFakeStore, createTestDeps, TEST_HOME } from "./test-support"
import { defaultVaultPath } from "./vault/store"
import { defaultKeystorePath, defaultTeeKeystorePath, legacyTeeKeystorePath } from "./wallet-keystore"

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

describe("profile-aware resolution", () => {
  const unused = (() => {
    throw new Error("not used")
  }) as unknown as typeof fetch

  test("with a profile named, the namespaced ref is read and the legacy ref is ignored", async () => {
    const deps = createTestDeps({
      fetch: unused,
      store: createFakeStore({
        api_key: "legacy",
        "profile:staging:api_key": "staged",
        "profile:staging:device_token": "dvc",
      }),
      env: {},
    })
    expect(await resolveApiKey(deps, "staging")).toBe("staged")
    expect(await resolveDeviceToken(deps, "staging")).toBe("dvc")
  })

  test("with no profile the legacy ref is read, so a pre-profile install keeps working", async () => {
    const deps = createTestDeps({ fetch: unused, store: createFakeStore({ api_key: "legacy" }), env: {} })
    expect(await resolveApiKey(deps, undefined)).toBe("legacy")
  })

  test("the env override still beats a profile's stored value", async () => {
    const deps = createTestDeps({
      fetch: unused,
      store: createFakeStore({ "profile:staging:api_key": "staged" }),
      env: { CANDLE_API_KEY: "from-env" },
    })
    expect(await resolveApiKey(deps, "staging")).toBe("from-env")
  })

  test("a profile with nothing stored resolves to undefined rather than falling back to another identity", async () => {
    const deps = createTestDeps({ fetch: unused, store: createFakeStore({ api_key: "legacy" }), env: {} })
    expect(await resolveApiKey(deps, "staging")).toBeUndefined()
  })
})

/**
 * T2 (BE-274, D1): the injected home, and the binding that makes the real one real.
 *
 * The bug this closes is a test that resolved the DEVELOPER's `~/.config/candle`, so the case that
 * asserts "there is no vault here" passed on CI and failed at home. Both halves are asserted: what
 * a test's deps answer, and that `index.ts` binds `node:os`'s `homedir` and nothing else -- checked
 * by reading the source, in the shape this package's other drift tests already use, because
 * building the real deps would resolve a real secret store.
 *
 * The five config-dir builders D1 leaves alone (`secret-store.ts`, `config.ts`, `commands/auth.ts`,
 * `trading.ts`) are deliberately outside this assertion: none of them builds the vault or the
 * keystore path.
 */
describe("T2: homedir is a dep, and the vault and keystore paths are built from it", () => {
  test("createTestDeps injects a home that cannot exist, never the machine's own", () => {
    const deps = createTestDeps({
      fetch: (() => {
        throw new Error("not used")
      }) as unknown as typeof fetch,
    })
    expect(deps.homedir()).toBe("/nonexistent/candle-test-home")
    expect(deps.homedir()).toBe(TEST_HOME)
    expect(deps.homedir()).not.toBe(homedir())
  })

  test("every path builder in the seam resolves from the home it is given", () => {
    const home = "/tmp/candle-not-a-real-home"
    const config = join(home, ".config", "candle")
    expect(defaultVaultPath({}, home)).toBe(join(config, "vault.enc"))
    expect(defaultKeystorePath({}, home)).toBe(join(config, "wallets.enc"))
    expect(defaultTeeKeystorePath({}, home)).toBe(join(config, "tee-wallets.enc"))
    expect(legacyTeeKeystorePath({}, home)).toBe(join(config, "hot-wallets.enc"))
    // CANDLE_CONFIG_DIR still wins, unchanged: the home is only the fallback (D2).
    expect(defaultVaultPath({ CANDLE_CONFIG_DIR: "/elsewhere" }, home)).toBe("/elsewhere/vault.enc")
  })

  test("index.ts binds node:os homedir, so the shipped CLI builds the paths it always did", async () => {
    const source = await readFile(resolve(import.meta.dir, "index.ts"), "utf8")
    expect(source).toContain('import { homedir, hostname } from "node:os"')
    // The real deps object names it beside `hostname`, which is injected for the same reason.
    const realDeps = source.slice(source.indexOf("export async function buildRealDeps"))
    expect(realDeps).toContain("hostname: hostname(),")
    expect(realDeps.split("\n").map((line) => line.trim())).toContain("homedir,")
  })
})
