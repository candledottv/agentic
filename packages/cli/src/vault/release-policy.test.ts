/**
 * Ember Phase 2 (BE-141): the checked-in release policy is the one switch for the signed macOS
 * helper, and both readers of it (this CLI, the release workflow) must agree on its shape.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseReleasePolicy } from "./enclave"
import { RELEASE_POLICY } from "./release-policy"

describe("release-policy.json", () => {
  test("parses, and is omit with no team id until Apple approves the AD-1 enrolment", () => {
    expect(RELEASE_POLICY.macosHelper.release).toBe("omit")
    expect(RELEASE_POLICY.macosHelper.teamId).toBe("")
    expect(RELEASE_POLICY.macosHelper.bundleId).toBe("tv.candle.cli.enclave")
  })

  test("signed requires a ten-character team id; omit forbids one; anything else is refused", () => {
    expect(() => parseReleasePolicy({ macosHelper: { release: "signed", bundleId: "a.b", teamId: "" } })).toThrow(
      /signed.*teamId/,
    )
    expect(() =>
      parseReleasePolicy({ macosHelper: { release: "omit", bundleId: "a.b", teamId: "ABCDE12345" } }),
    ).toThrow(/omit.*teamId/)
    expect(() => parseReleasePolicy({ macosHelper: { release: "maybe", bundleId: "a.b", teamId: "" } })).toThrow(
      /must be "omit" or "signed"/,
    )
    expect(() => parseReleasePolicy({ macosHelper: { release: "omit", bundleId: "", teamId: "" } })).toThrow(/bundleId/)
    expect(() => parseReleasePolicy({})).toThrow(/macosHelper is missing/)
    expect(parseReleasePolicy({ macosHelper: { release: "signed", bundleId: "a.b", teamId: "ABCDE12345" } })).toEqual({
      macosHelper: { release: "signed", bundleId: "a.b", teamId: "ABCDE12345" },
    })
  })

  test("the release workflow reads the same file and knows both states", async () => {
    const candidates = [
      join(import.meta.dir, "..", "..", "..", "..", "distribution", "agentic", ".github", "workflows", "release.yaml"),
      join(import.meta.dir, "..", "..", "..", "..", ".github", "workflows", "release.yaml"),
    ]
    let workflow: string | undefined
    for (const candidate of candidates) {
      try {
        workflow = await readFile(candidate, "utf8")
        break
      } catch {
        // Try the next location.
      }
    }
    if (workflow === undefined) throw new Error(`release.yaml not found at any of: ${candidates.join(", ")}`)
    expect(workflow).toContain("packages/cli/release-policy.json")
    expect(workflow).toContain("macos-helper")
    for (const secret of [
      "APPLE_DEVELOPER_ID_CERT_P12_BASE64",
      "APPLE_DEVELOPER_ID_CERT_PASSWORD",
      "APPLE_TEAM_ID",
      "APPLE_NOTARY_KEY_ID",
      "APPLE_NOTARY_ISSUER_ID",
      "APPLE_NOTARY_KEY_P8_BASE64",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
    // The policy is the only switch: the job never reads a credential to decide.
    expect(workflow).toContain('"omit"')
    expect(workflow).toContain('"signed"')
  })
})
