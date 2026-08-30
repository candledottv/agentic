/**
 * profiles.ts: the pure half of "one device, several accounts". Resolution order, refs,
 * names, migration and the identity line, with no IO anywhere.
 */
import { describe, expect, test } from "bun:test"
import {
  defaultProfileNameFor,
  effectiveProfileFields,
  formatCacheAge,
  identityLine,
  isValidProfileName,
  migratedConfig,
  profileSecretRef,
  profileTable,
  resolveProfileName,
  resolveProfileNameForLogin,
} from "./profiles"

describe("profileSecretRef", () => {
  test("namespaces the two credential refs per profile", () => {
    expect(profileSecretRef("staging", "deviceToken")).toBe("profile:staging:device_token")
    expect(profileSecretRef("staging", "apiKey")).toBe("profile:staging:api_key")
  })
})

describe("isValidProfileName", () => {
  test("accepts short names of letters, digits, dot, dash and underscore", () => {
    for (const name of ["staging", "prod-2", "hood.staging", "a", "A_b"]) expect(isValidProfileName(name)).toBe(true)
  })
  test("rejects names that could not be a keychain account or a flag value", () => {
    for (const name of ["", " staging", "st aging", "-x", "a\nb", 'a"b', "x".repeat(33)]) {
      expect(isValidProfileName(name)).toBe(false)
    }
  })
})

describe("resolveProfileName", () => {
  const two = { profiles: { staging: {}, production: {} } }

  test("the flag wins over everything", () => {
    expect(
      resolveProfileName(
        { ...two, activeProfile: "production" },
        { flag: "staging", env: { CANDLE_PROFILE: "production" } },
      ),
    ).toEqual({ ok: true, name: "staging" })
  })
  test("CANDLE_PROFILE beats activeProfile", () => {
    expect(resolveProfileName({ ...two, activeProfile: "production" }, { env: { CANDLE_PROFILE: "staging" } })).toEqual(
      { ok: true, name: "staging" },
    )
  })
  test("activeProfile is used when nothing names one", () => {
    expect(resolveProfileName({ ...two, activeProfile: "production" }, { env: {} })).toEqual({
      ok: true,
      name: "production",
    })
  })
  test("a sole profile is used without being named", () => {
    expect(resolveProfileName({ profiles: { staging: {} } }, { env: {} })).toEqual({ ok: true, name: "staging" })
  })
  test("no profiles at all resolves to none, so a fresh or env-only install keeps working", () => {
    expect(resolveProfileName({}, { env: {} })).toEqual({ ok: true, name: undefined })
  })
  test("several profiles and nothing selected REFUSES, listing them and how to pick one", () => {
    const r = resolveProfileName(two, { env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("staging")
      expect(r.message).toContain("production")
      expect(r.message).toContain("--profile")
      expect(r.message).toContain("CANDLE_PROFILE")
    }
  })
  test("a named profile that does not exist refuses and lists what does", () => {
    const r = resolveProfileName(two, { flag: "hood", env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('No profile named "hood"')
  })
  test("an invalid name refuses before any lookup", () => {
    expect(resolveProfileName(two, { env: { CANDLE_PROFILE: "bad name" } }).ok).toBe(false)
  })
})

describe("resolveProfileNameForLogin", () => {
  const two = { profiles: { staging: {}, production: {} } }

  test("a named profile need not exist yet: naming one is how login creates it", () => {
    expect(resolveProfileNameForLogin(two, { flag: "hood", env: {} })).toEqual({ ok: true, name: "hood" })
    expect(resolveProfileNameForLogin({}, { env: { CANDLE_PROFILE: "hood" } })).toEqual({ ok: true, name: "hood" })
  })
  test("with nothing named it refreshes the selected profile, or the sole one", () => {
    expect(resolveProfileNameForLogin({ ...two, activeProfile: "production" }, { env: {} })).toEqual({
      ok: true,
      name: "production",
    })
    expect(resolveProfileNameForLogin({ profiles: { staging: {} } }, { env: {} })).toEqual({
      ok: true,
      name: "staging",
    })
  })
  test("with no profile in play at all it resolves to none, not an error", () => {
    expect(resolveProfileNameForLogin({}, { env: {} })).toEqual({ ok: true, name: undefined })
    expect(resolveProfileNameForLogin(two, { env: {} })).toEqual({ ok: true, name: undefined })
  })
  test("an invalid name is an error even with an active profile it could otherwise fall back to", () => {
    const config = { ...two, activeProfile: "production" }
    const r = resolveProfileNameForLogin(config, { env: { CANDLE_PROFILE: "bad name" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("Invalid profile name")
  })

  test("an invalid requested name is an error, not silently skipped", () => {
    const r = resolveProfileNameForLogin({ profiles: { staging: {} } }, { env: { CANDLE_PROFILE: "bad name" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("Invalid profile name")
  })
})

describe("migratedConfig", () => {
  test("a pre-profile config becomes profile 'default', active, with the old fields left in place", () => {
    const before = {
      apiUrl: "https://staging.api.candle.tv",
      keyPrefix: "8I0CZztp",
      deviceTokenPrefix: "RMe25DjO",
      scopes: ["trade:write"],
      label: "laptop",
      portalOrigin: "https://staging.candle.tv",
    }
    const { config, migrated } = migratedConfig(before)
    expect(migrated).toBe(true)
    expect(config.activeProfile).toBe("default")
    expect(config.profiles?.default).toEqual(before)
    expect(config.apiUrl).toBe(before.apiUrl)
    expect(config.keyPrefix).toBe("8I0CZztp")
  })
  test("a config that already has profiles is untouched", () => {
    const before = { profiles: { staging: { apiUrl: "x" } }, activeProfile: "staging" }
    const { config, migrated } = migratedConfig(before)
    expect(migrated).toBe(false)
    expect(config).toEqual(before)
  })
  test("an empty config (never logged in) is untouched", () => {
    expect(migratedConfig({})).toEqual({ config: {}, migrated: false })
  })
})

describe("effectiveProfileFields", () => {
  const config = {
    profiles: { staging: { keyPrefix: "8I0CZztp", scopes: ["trade:write"] } },
    keyPrefix: "LEGACY01",
    deviceTokenPrefix: "LEGACY02",
    scopes: ["launch:write"],
  }

  test("a profile's own fields, never the legacy top-level ones beside them", () => {
    expect(effectiveProfileFields(config, "staging")).toEqual({ keyPrefix: "8I0CZztp", scopes: ["trade:write"] })
  })
  test("no profile in play falls back to the pre-profile top-level fields", () => {
    expect(effectiveProfileFields(config, undefined)).toEqual({
      keyPrefix: "LEGACY01",
      deviceTokenPrefix: "LEGACY02",
      scopes: ["launch:write"],
    })
  })
  test("an unknown profile yields nothing rather than borrowing another identity's fields", () => {
    expect(effectiveProfileFields(config, "hood")).toEqual({})
  })
})

describe("defaultProfileNameFor", () => {
  test("derives staging and production from the known hosts, else the hostname", () => {
    expect(defaultProfileNameFor("https://staging.api.candle.tv", undefined)).toBe("staging")
    expect(defaultProfileNameFor("https://api.candle.tv", undefined)).toBe("production")
    expect(defaultProfileNameFor("https://api.alpha.candle.tv", undefined)).toBe("production")
    expect(defaultProfileNameFor("http://localhost:3005", undefined)).toBe("localhost")
  })
  test("de-duplicates with a numeric suffix", () => {
    expect(defaultProfileNameFor("https://staging.api.candle.tv", { staging: {} })).toBe("staging-2")
    expect(defaultProfileNameFor("https://staging.api.candle.tv", { staging: {}, "staging-2": {} })).toBe("staging-3")
  })
  test("a derived name that isValidProfileName would reject falls back to 'profile', de-duplicated too", () => {
    // A hostname may legally start with a character a profile name may not, and writing such a
    // name would create an entry `--profile` could never select again.
    expect(isValidProfileName("-foo-example")).toBe(false)
    expect(defaultProfileNameFor("https://-foo.example", undefined)).toBe("profile")
    expect(defaultProfileNameFor("https://-foo.example", { profile: {} })).toBe("profile-2")
  })
})

describe("identityLine", () => {
  test("names the profile, the account and the host in the spec's exact form", () => {
    expect(identityLine("hood-staging", "FaKwE2xX", "https://staging.api.candle.tv")).toBe(
      "Profile: hood-staging   Account: FaKwE2xX at https://staging.api.candle.tv",
    )
  })
  test("says what it does not know rather than omitting it", () => {
    expect(identityLine(undefined, undefined, "https://api.candle.tv")).toBe(
      "Profile: none   Account: unknown at https://api.candle.tv",
    )
  })
  test("an acting env override is named INSTEAD of the cached account, which is not what is acting", () => {
    expect(identityLine("staging", "FaKwE2xX", "https://api.candle.tv", ["CANDLE_API_KEY"])).toBe(
      "Profile: staging   Account: unknown (CANDLE_API_KEY override) at https://api.candle.tv",
    )
    expect(
      identityLine("staging", "FaKwE2xX", "https://api.candle.tv", ["CANDLE_API_KEY", "CANDLE_DEVICE_TOKEN"]),
    ).toBe(
      "Profile: staging   Account: unknown (CANDLE_API_KEY, CANDLE_DEVICE_TOKEN override) at https://api.candle.tv",
    )
    expect(identityLine("staging", "FaKwE2xX", "https://api.candle.tv", [])).toContain("Account: FaKwE2xX")
  })
  test("shows the username beside the address when both are present, the address alone without", () => {
    expect(identityLine("hood-staging", "FaKwE2xX", "https://staging.api.candle.tv", undefined, "satoshi")).toBe(
      "Profile: hood-staging   Account: satoshi (FaKwE2xX) at https://staging.api.candle.tv",
    )
    // No username: the address alone, byte for byte what it was before the parameter existed.
    expect(identityLine("hood-staging", "FaKwE2xX", "https://staging.api.candle.tv", undefined, undefined)).toBe(
      "Profile: hood-staging   Account: FaKwE2xX at https://staging.api.candle.tv",
    )
    // A username with no account cannot form the pair, so the "unknown" fallback still wins.
    expect(identityLine("hood-staging", undefined, "https://staging.api.candle.tv", undefined, "satoshi")).toBe(
      "Profile: hood-staging   Account: unknown at https://staging.api.candle.tv",
    )
  })
  test("an env override stays username-free even when a username is cached", () => {
    // The override REPLACES the account entirely; a cached username describes the profile's own
    // stored key, not the credential the env var supplied, so it must not appear beside it.
    expect(identityLine("staging", "FaKwE2xX", "https://api.candle.tv", ["CANDLE_API_KEY"], "satoshi")).toBe(
      "Profile: staging   Account: unknown (CANDLE_API_KEY override) at https://api.candle.tv",
    )
  })
})

describe("formatCacheAge", () => {
  const now = Date.parse("2026-08-25T12:00:00Z")
  test("names the age in the largest whole unit, and the absent case", () => {
    expect(formatCacheAge(now, undefined)).toBe("not cached")
    expect(formatCacheAge(now, now - 30_000)).toBe("just now")
    expect(formatCacheAge(now, now - 5 * 60_000)).toBe("5m ago")
    expect(formatCacheAge(now, now - 3 * 3_600_000)).toBe("3h ago")
    expect(formatCacheAge(now, now - 2 * 86_400_000)).toBe("2d ago")
  })
  test("a cache stamped in the future reads as just now rather than negative", () => {
    expect(formatCacheAge(now, now + 60_000)).toBe("just now")
  })
})

describe("profileTable", () => {
  const now = Date.parse("2026-08-25T12:00:00Z")

  // Fix wave item 3: every profile that predates `accountCachedAt` has an account and no stamp,
  // so "not cached" said the opposite of what the row showed -- an account, right there, beside
  // the claim that none was cached. The unknown is the AGE, not the account.
  test("an account with no stamp reads as an unknown age, not as an uncached account", () => {
    const rows = profileTable({ profiles: { upgraded: { account: "FaKwE2xX" } } }, now)
    expect(rows[0]?.account).toBe("FaKwE2xX")
    expect(rows[0]?.cachedAge).toBe("age unknown")
  })

  test("a profile with no account at all still reads not cached", () => {
    const rows = profileTable({ profiles: { fresh: { apiUrl: "https://api.candle.tv" } } }, now)
    expect(rows[0]?.account).toBeUndefined()
    expect(rows[0]?.cachedAge).toBe("not cached")
  })

  test("a stamped profile still reads its age, sorted by name, marking the active one", () => {
    const rows = profileTable(
      {
        activeProfile: "staging",
        profiles: {
          staging: { account: "A", accountCachedAt: now - 3_600_000 },
          production: { account: "B", accountCachedAt: now - 30_000 },
        },
      },
      now,
    )
    expect(rows.map((r) => r.name)).toEqual(["production", "staging"])
    expect(rows.map((r) => r.cachedAge)).toEqual(["just now", "1h ago"])
    expect(rows.map((r) => r.active)).toEqual([false, true])
  })
})

/**
 * `in` walks the prototype chain, so every Object.prototype member resolved as a profile name
 * against an ordinary object literal. `candle --profile constructor` passed the existence check
 * and carried a function forward as if it were config.
 */
describe("profile lookup ignores inherited properties", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    test(`"${name}" is not a profile`, () => {
      const config = { profiles: { real: { apiUrl: "https://api.test" } }, activeProfile: "real" }
      const r = resolveProfileName(config as never, { flag: name, env: {} })
      expect(r.ok).toBe(false)
    })
  }

  test("a real profile still resolves", () => {
    const config = { profiles: { real: { apiUrl: "https://api.test" } }, activeProfile: "real" }
    expect(resolveProfileName(config as never, { flag: "real", env: {} })).toEqual({ ok: true, name: "real" })
  })
})
