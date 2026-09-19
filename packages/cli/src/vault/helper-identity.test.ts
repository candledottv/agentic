import { expect, test } from "bun:test"
import { createTestDeps } from "../test-support"
import { codesignRequirement, openEnclaveSession, type ReleasePolicy } from "./enclave"
import { openPasskeySession } from "./passkey"

const trusted = { teamId: "ABCDE12345", bundleId: "tv.candle.cli.enclave" }
const releasePolicy: ReleasePolicy = { macosHelper: { release: "signed", ...trusted } }

test("both sessions refuse a foreign team or bundle before any spawn", async () => {
  for (const open of [openEnclaveSession, openPasskeySession]) {
    for (const helper of [
      { ...trusted, teamId: "ZZZZZ99999" },
      { ...trusted, bundleId: "org.other.helper" },
    ]) {
      let spawned = false
      const deps = createTestDeps({
        fetch: (async () => {
          throw new Error("must not fetch")
        }) as unknown as typeof fetch,
        releasePolicy,
        spawnHelper: async () => {
          spawned = true
          throw new Error("must not spawn")
        },
      })
      await expect(open(deps, helper)).rejects.toMatchObject({
        code: "VAULT_HELPER_UNTRUSTED",
        message: expect.stringContaining(
          `${helper.teamId} / ${helper.bundleId}; this build trusts ${trusted.teamId} / ${trusted.bundleId}`,
        ),
      })
      expect(spawned).toBe(false)
    }
  }
})

test("codesign requirements accept only validated literal identities", () => {
  expect(codesignRequirement(trusted)).toContain('subject.OU] = "ABCDE12345" and identifier "tv.candle.cli.enclave"')
  for (const teamId of ['ABCDE12345" or true', "abcde12345", "SHORT", "ABCDE123456", "ABCDE12345\n"]) {
    expect(() => codesignRequirement({ ...trusted, teamId })).toThrow(
      expect.objectContaining({ code: "VAULT_HELPER_UNTRUSTED" }),
    )
  }
  for (const bundleId of [
    'tv.candle" or true',
    "tv..candle",
    "tv.candle_foo",
    "tv.candle/helper",
    "tv.-candle",
    "candle",
    "tv.candle\n",
  ]) {
    expect(() => codesignRequirement({ ...trusted, bundleId })).toThrow(
      expect.objectContaining({ code: "VAULT_HELPER_UNTRUSTED" }),
    )
  }
})
