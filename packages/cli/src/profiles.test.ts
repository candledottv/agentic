/**
 * profiles.ts: the pure half of "one device, several accounts". Resolution order, refs,
 * names, migration and the identity line, with no IO anywhere.
 */
import { describe, expect, test } from "bun:test"
import {
  defaultProfileNameFor,
  effectiveProfileFields,
  identityLine,
  isValidProfileName,
  migratedConfig,
  profileSecretRef,
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
    expect(resolveProfileNameForLogin(two, { flag: "hood", env: {} })).toBe("hood")
    expect(resolveProfileNameForLogin({}, { env: { CANDLE_PROFILE: "hood" } })).toBe("hood")
  })
  test("with nothing named it refreshes the selected profile, or the sole one", () => {
    expect(resolveProfileNameForLogin({ ...two, activeProfile: "production" }, { env: {} })).toBe("production")
    expect(resolveProfileNameForLogin({ profiles: { staging: {} } }, { env: {} })).toBe("staging")
  })
  test("it never refuses: no profiles, or several with none selected, resolve to none", () => {
    expect(resolveProfileNameForLogin({}, { env: {} })).toBeUndefined()
    expect(resolveProfileNameForLogin(two, { env: {} })).toBeUndefined()
  })
  test("an unusable name is skipped, never written as a profile nothing could select again", () => {
    const config = { ...two, activeProfile: "production" }
    expect(resolveProfileNameForLogin(config, { env: { CANDLE_PROFILE: "bad name" } })).toBe("production")
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
})
