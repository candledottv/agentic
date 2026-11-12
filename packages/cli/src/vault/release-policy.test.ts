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
  test("parses, and is signed by team ZC2DLBZS4U since Apple approved the AD-1 enrolment (BE-3251)", () => {
    expect(RELEASE_POLICY.macosHelper.release).toBe("signed")
    expect(RELEASE_POLICY.macosHelper.teamId).toBe("ZC2DLBZS4U")
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
      // PR G (BE-135): the Developer ID provisioning profile the associated-domains entitlement
      // needs, required under `signed` like the six above.
      "APPLE_DEVELOPER_ID_PROVISIONING_PROFILE_BASE64",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
      // Each is in the "require every signing input" loop, so a missing one fails the job.
      expect(workflow).toMatch(new RegExp(`for name in [^\\n]*\\b${secret}\\b`))
    }
    // The profile is embedded by build.sh (fifth argument) and the signed entitlements are checked
    // for the keychain access group. The passkey factor's associated domain is not shipped yet
    // (BE-3251: the profile has no Associated Domains), so the job must not require it.
    expect(workflow).toContain('"$TEAM_ID" "$PROFILE"')
    expect(workflow).toContain("embedded.provisionprofile")
    expect(workflow).not.toContain("grep -q 'webcredentials:cli.candle.tv'")
    // The signed entitlements are read as a plist, not grepped: the group must be entry 0 and equal,
    // and associated-domains must be absent. The read fails closed.
    expect(workflow).toContain("codesign -d --entitlements - --xml")
    expect(workflow).toContain("Print :keychain-access-groups:0")
    expect(workflow).toContain('[ "$group" = "${TEAM_ID}.${BUNDLE_ID}" ]')
    expect(workflow).toContain("Print :com.apple.developer.associated-domains")
    expect(workflow).not.toContain('grep -q "${TEAM_ID}.${BUNDLE_ID}"')
    // The kept profile gates: app id, TeamIdentifier and expiry refusals.
    expect(workflow).toContain("Print :Entitlements:com.apple.application-identifier")
    expect(workflow).toContain('[ "$app_id" = "${APPLE_TEAM_ID}.${BUNDLE_ID}" ]')
    expect(workflow).toContain("Print :TeamIdentifier")
    expect(workflow).toContain("TeamIdentifier does not include")
    expect(workflow).toContain("Print :ExpirationDate")
    expect(workflow).toContain("the provisioning profile expired on")
    // The policy is the only switch: the job never reads a credential to decide.
    expect(workflow).toContain('"omit"')
    expect(workflow).toContain('"signed"')
  })

  test("the entitlements template keeps the app identifier and keychain group, and has no associated domains", async () => {
    const template = await readFile(
      join(import.meta.dir, "..", "enclave-helper", "app", "entitlements.plist.template"),
      "utf8",
    )
    // Strip comments, which mention the removed key by name.
    const body = template.replace(/<!--[\s\S]*?-->/g, "")
    expect(body).toContain("<key>com.apple.application-identifier</key>")
    expect(body).toContain("<key>keychain-access-groups</key>")
    expect(body.match(/<string>__TEAM_ID__\.__BUNDLE_ID__<\/string>/g)?.length).toBe(2)
    expect(body).not.toContain("com.apple.developer.associated-domains")
  })
})
