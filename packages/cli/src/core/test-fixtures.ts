/**
 * BE-1665: shared fixtures for the core tests. Not a `*.test.ts` file itself, and imported by
 * nothing that ships.
 */
import type { CliConfig } from "../config"
import { keySignerRef } from "../key-signers"
import { profileSecretRef } from "../profiles"
import type { SecretStore } from "../secret-store"

/** A Candle-shaped Write key (prefix `wwwwwwww`), Read key (prefix `rrrrrrrr`), device token and signer. */
export const WRITE_KEY = `cndl_test_${"w".repeat(43)}`
export const READ_KEY = `cndl_test_${"r".repeat(43)}`
export const DEVICE_TOKEN = `cndl_dt_${"d".repeat(40)}`
export const SIGNER_HALF = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFIXTUREfixturefixture"
export const SPKI = "a".repeat(64)
export const WRITE_PREFIX = "wwwwwwww"
export const READ_PREFIX = "rrrrrrrr"

/** A secret store whose contents a test can inspect in full. */
export function inspectableStore(seed: Record<string, string> = {}): SecretStore & { entries(): [string, string][] } {
  const data = new Map(Object.entries(seed))
  return {
    async get(ref) {
      return data.get(ref) ?? null
    },
    async set(ref, value) {
      data.set(ref, value)
    },
    async delete(ref) {
      data.delete(ref)
    },
    entries() {
      return [...data.entries()]
    },
  }
}

/** The plain items a signed-in profile holds before trading moves them. */
export function plainSeed(profile: string): Record<string, string> {
  return {
    [profileSecretRef(profile, "apiKey")]: WRITE_KEY,
    [profileSecretRef(profile, "deviceToken")]: DEVICE_TOKEN,
    [keySignerRef(WRITE_PREFIX, SPKI)]: SIGNER_HALF,
  }
}

export function profileConfig(profile: string, apiUrl = "https://staging.api.candle.tv"): CliConfig {
  return {
    profiles: { [profile]: { apiUrl, account: "Acct111", keyPrefix: WRITE_PREFIX } },
    activeProfile: profile,
    keySigners: {
      entries: [
        {
          keyPrefix: WRITE_PREFIX,
          spkiSha256: SPKI,
          fingerprint: "CNDL-AAAA-AAAA-AAAA",
          publicKeyDer: "x",
          createdAt: 0,
        },
      ],
    },
  }
}
