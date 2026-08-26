/**
 * `verifyReleaseAsset` against real, committed Sigstore material (test-fixtures/sigstore, see its
 * README for what each file is and where it came from). No network: the bundle carries the
 * certificate and the transparency-log entry, and `src/sigstore-trusted-root.json` carries the
 * keys that vouch for them.
 *
 * The contract these tests pin is three bindings, not one. The signature has to be bound to the
 * identity, the identity to its issuer, and the bundle to THESE bytes -- and the third is the one
 * the Sigstore library does not do for every bundle shape (Task 1's spike result, "The verify()
 * call does NOT bind the bundle to the file").
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RELEASE_ISSUER, releaseIdentityUri } from "./release"
import { verifyReleaseAsset } from "./release-verify"

const dir = join(import.meta.dir, "..", "test-fixtures", "sigstore")
const bytes = new Uint8Array(readFileSync(join(dir, "fixture.bin")))
const bundle = JSON.parse(readFileSync(join(dir, "fixture.sigstore.json"), "utf8"))
/** The identity the fixture bundle was signed with; see test-fixtures/sigstore/README.md. */
const FIXTURE_IDENTITY = readFileSync(join(dir, "identity.txt"), "utf8").trim()
const FIXTURE_ISSUER = readFileSync(join(dir, "issuer.txt"), "utf8").trim()

describe("verifyReleaseAsset", () => {
  test("accepts the bundle for the identity it was signed with", () => {
    expect(verifyReleaseAsset(bytes, bundle, FIXTURE_IDENTITY, FIXTURE_ISSUER)).toEqual({ ok: true })
  })

  test("refuses the release identity, which did not sign this bundle", () => {
    const result = verifyReleaseAsset(bytes, bundle, releaseIdentityUri("0.6.0"), RELEASE_ISSUER)
    expect(result.ok).toBe(false)
  })

  /**
   * `@sigstore/verify` matches the policy identity with `signerIdentity.match(policyIdentity)`
   * (policy.js), which compiles a string into an UNANCHORED regular expression. A bare URI is
   * therefore a substring test, and every one of these accepted the goreleaser fixture before the
   * identity was anchored: its own prefix, its own tail, the empty string, and `.*`. An installer
   * built on that would accept any Sigstore-signed binary whose identity merely contained ours.
   */
  test("a substring of the identity is not the identity", () => {
    for (const nearMiss of [
      "https://github.com/goreleaser/goreleaser",
      "v2.18.0",
      "",
      ".*",
      "https://github.com/goreleaser/goreleaser/.github/workflows/release.yml@refs/tags/v2.18.1",
    ]) {
      expect(verifyReleaseAsset(bytes, bundle, nearMiss, FIXTURE_ISSUER).ok).toBe(false)
    }
    // The exact identity still passes, so the anchoring is not simply refusing everything.
    expect(verifyReleaseAsset(bytes, bundle, FIXTURE_IDENTITY, FIXTURE_ISSUER)).toEqual({ ok: true })
  })

  // The identity is escaped before it is anchored, so a regular-expression metacharacter in it is
  // matched literally rather than compiled. Without the escape, `.` alone would match any byte.
  test("regex metacharacters in the identity are matched literally", () => {
    const wildcarded = FIXTURE_IDENTITY.replace("release.yml", "release.ym.")
    expect(verifyReleaseAsset(bytes, bundle, wildcarded, FIXTURE_ISSUER).ok).toBe(false)
  })

  test("refuses the right identity under the wrong issuer", () => {
    const result = verifyReleaseAsset(bytes, bundle, FIXTURE_IDENTITY, "https://accounts.google.com")
    expect(result.ok).toBe(false)
  })

  test("refuses altered bytes", () => {
    const altered = new Uint8Array(bytes)
    altered[0] = (altered[0] ?? 0) ^ 0xff
    expect(verifyReleaseAsset(altered, bundle, FIXTURE_IDENTITY, FIXTURE_ISSUER).ok).toBe(false)
  })

  test("refuses a malformed bundle", () => {
    expect(verifyReleaseAsset(bytes, { not: "a bundle" }, FIXTURE_IDENTITY, FIXTURE_ISSUER).ok).toBe(false)
  })

  test("a genuine bundle cannot vouch for different bytes", () => {
    const other = new TextEncoder().encode("not the fixture")
    const result = verifyReleaseAsset(other, bundle, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/digest does not match/)
  })
})

/**
 * The DSSE half of the same rule. `toSignedEntity(bundle, artifact)` throws `artifact` away for a
 * DSSE bundle, so a real attestation would otherwise "verify" beside a file it says nothing
 * about; the in-toto subject digest is what closes it, and it is checked BEFORE the signature.
 *
 * The fixture is GitHub's own release attestation over the same bytes, which is signed in
 * GitHub's internal trust domain rather than the public-good one. That makes it two tests in one:
 * the subject-digest branch is exercised for the wrong bytes, and the right bytes get past that
 * check only to be refused by the trusted root, which is exactly what selecting a bundle by line
 * index instead of by trust domain would run into.
 */
describe("verifyReleaseAsset, DSSE bundles", () => {
  const dsse = JSON.parse(readFileSync(join(dir, "dsse-github-internal.sigstore.json"), "utf8"))

  test("refuses a DSSE attestation whose subject digest does not cover these bytes", () => {
    const other = new TextEncoder().encode("not the fixture")
    const result = verifyReleaseAsset(other, dsse, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/subject digest does not match/)
  })

  test("refuses a payload that is not an in-toto statement", () => {
    const wrongType = JSON.parse(JSON.stringify(dsse))
    wrongType.dsseEnvelope.payloadType = "application/vnd.something-else+json"
    const result = verifyReleaseAsset(bytes, wrongType, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/unsupported attestation payload type/)
  })

  test("refuses a payload that is not JSON, in words about the file rather than the parser", () => {
    const notJson = JSON.parse(JSON.stringify(dsse))
    notJson.dsseEnvelope.payload = Buffer.from("<html>not a statement</html>").toString("base64")
    const result = verifyReleaseAsset(bytes, notJson, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("the attestation payload is not valid JSON")
      expect(result.reason).not.toMatch(/JSON.parse|Unexpected|position/i)
    }
  })

  test("a bundle from another trust domain is refused even when its subject digest matches", () => {
    const result = verifyReleaseAsset(bytes, dsse, "https://dotcom.releases.github.com", FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    // Past the digest check, refused by the trusted root: the reason must not be about digests.
    if (!result.ok) expect(result.reason).not.toMatch(/digest does not match/)
  })
})

/**
 * The embedded trust root is refreshed per release and then frozen into the binary, so a binary
 * left installed long enough will one day fail to chain a perfectly good signature. That refusal
 * is indistinguishable from a forged download unless the message says otherwise.
 *
 * Driven with real material rather than a mock: the goreleaser bundle carrying GitHub's leaf
 * certificate, which is a genuine Fulcio certificate from a trust domain the embedded root does
 * not know. Its timestamps still verify, so verification reaches chain building and dies there,
 * which is the branch under test. (The GitHub-internal bundle on its own fails earlier, at
 * "timestamp could not be verified", so it cannot reach this.)
 */
describe("an out-of-date trust root says so", () => {
  test("a certificate-chain failure carries the reinstall hint", () => {
    const dsse = JSON.parse(readFileSync(join(dir, "dsse-github-internal.sigstore.json"), "utf8"))
    const foreignLeaf = JSON.parse(readFileSync(join(dir, "fixture.sigstore.json"), "utf8"))
    foreignLeaf.verificationMaterial.certificate = dsse.verificationMaterial.certificate

    const result = verifyReleaseAsset(bytes, foreignLeaf, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/certificate chain/i)
      expect(result.reason).toContain("the trust root embedded in this candle may be out of date")
      expect(result.reason).toContain("curl -fsSL https://candle.tv/install.sh | bash")
    }
  })

  // The hint is for one family of failures. A wrong identity or a bad digest has nothing to do
  // with the trust root, and telling someone to reinstall would send them the wrong way.
  test("an ordinary refusal does not carry it", () => {
    const wrongIdentity = verifyReleaseAsset(bytes, bundle, releaseIdentityUri("0.6.0"), RELEASE_ISSUER)
    expect(wrongIdentity.ok).toBe(false)
    if (!wrongIdentity.ok) expect(wrongIdentity.reason).not.toContain("out of date")

    const wrongBytes = verifyReleaseAsset(new TextEncoder().encode("nope"), bundle, FIXTURE_IDENTITY, FIXTURE_ISSUER)
    expect(wrongBytes.ok).toBe(false)
    if (!wrongBytes.ok) expect(wrongBytes.reason).not.toContain("out of date")
  })
})
