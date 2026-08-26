/**
 * Verifies a release asset's Sigstore bundle in process, against the trusted root embedded at
 * build time (src/sigstore-trusted-root.json, refreshed by scripts/refresh-sigstore-root.mjs at
 * every release). No network: the bundle carries the certificate and the transparency-log entry,
 * and the root carries the keys that vouch for them. `candle update` calls this before it will
 * rename a downloaded binary over itself, and `candle verify` exposes it as a command.
 *
 * The Bun shim is the FIRST import here and that is not stylistic: it has to be evaluated before
 * any Sigstore module, or every EC signature in the chain fails closed. See bun-crypto-shim.ts.
 */

import "./bun-crypto-shim"
import { createHash } from "node:crypto"
import { bundleFromJSON } from "@sigstore/bundle"
import { TrustedRoot } from "@sigstore/protobuf-specs"
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify"
import trustedRootJson from "./sigstore-trusted-root.json"

export type VerifyResult = { ok: true } | { ok: false; reason: string }

let verifier: Verifier | undefined

/** Built once, lazily: parsing the root and building the trust material is the expensive half,
 * and a CLI that never verifies anything should not pay for it at startup. */
function getVerifier(): Verifier {
  if (!verifier) {
    const root = TrustedRoot.fromJSON(trustedRootJson)
    verifier = new Verifier(toTrustMaterial(root), { ctlogThreshold: 1, tlogThreshold: 1 })
  }
  return verifier
}

/** The in-toto statement type a build-provenance DSSE envelope must declare. */
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json"

/**
 * The identity, as an ANCHORED, ESCAPED regular expression.
 *
 * `@sigstore/verify` matches the policy identity with `signerIdentity.match(policyIdentity)`
 * (its policy.js), which compiles a plain string into an UNANCHORED regular expression. Passing
 * the bare URI was therefore a substring test: the goreleaser fixture verified against
 * `https://github.com/goreleaser/goreleaser`, against `v2.18.0`, against `.*`, and against the
 * empty string. An installer built on that accepts any Sigstore-signed artifact whose identity
 * merely CONTAINS ours, which is every fork and every tag.
 *
 * Escaping comes before anchoring for the same reason: an identity carrying a metacharacter (a
 * version interpolated from a downloaded manifest, say) would otherwise compile as a pattern
 * instead of matching literally. `release.ts` validates the version too; this is the other half.
 */
function exactIdentity(identityUri: string): RegExp {
  return new RegExp(`^${identityUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
}

/**
 * Certificate-chain and certificate-path failures are the shape an OUT OF DATE embedded trust
 * root takes: the root ships compiled into the binary (sigstore-trusted-root.json) and is
 * refreshed per release, so a binary left installed long enough eventually cannot chain a
 * perfectly good signature. That reads as "this download is forged" unless the message says
 * otherwise, and the fix is not something the reader can guess.
 *
 * Matched against the library's own wording, which is a family rather than one string:
 * "Failed to verify certificate chain", "invalid certificate chain", "no trusted certificate path
 * found", "no valid certificate path found", and the expiry message beside them.
 */
function withTrustRootHint(reason: string): string {
  const staleRoot = /certificate chain|certificate path|certificate is not valid or expired/i
  if (!staleRoot.test(reason)) return reason
  return `${reason}; the trust root embedded in this candle may be out of date; reinstall with curl -fsSL https://candle.tv/install.sh | bash`
}

/**
 * Verification binds three things: the signature to the identity (the Verifier), the identity to
 * the issuer (the policy), and the bundle to THESE bytes (below). The last one is not the
 * Verifier's job for every bundle shape: for a DSSE bundle `toSignedEntity` ignores the artifact
 * entirely, so a genuine attestation could vouch for a swapped file. Our release bundles are
 * message signatures (cosign sign-blob), whose digest is checked against the bytes here; a DSSE
 * bundle is accepted only when an in-toto subject digest equals the bytes' SHA-256.
 *
 * Every failure is a returned reason rather than a throw: the callers are an installer and a
 * command, and both have to be able to say WHY they refused.
 */
export function verifyReleaseAsset(
  bytes: Uint8Array,
  bundleJson: unknown,
  identityUri: string,
  issuer: string,
): VerifyResult {
  try {
    const bundle = bundleFromJSON(bundleJson)
    const digest = createHash("sha256").update(bytes).digest()
    const content = bundle.content
    if (content.$case === "messageSignature") {
      const claimed = content.messageSignature.messageDigest?.digest
      if (!claimed || Buffer.compare(Buffer.from(claimed), digest) !== 0) {
        return { ok: false, reason: "the bundle's message digest does not match the file" }
      }
    } else if (content.$case === "dsseEnvelope") {
      // The subject digest below is only meaningful in an in-toto statement. Any other payload
      // type is a document this code does not know how to read, and reading it anyway would mean
      // deciding a file matched an attestation whose shape was never checked.
      if (content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
        return { ok: false, reason: `unsupported attestation payload type: ${content.dsseEnvelope.payloadType}` }
      }
      let statement: { subject?: { digest?: { sha256?: string } }[] }
      try {
        statement = JSON.parse(Buffer.from(content.dsseEnvelope.payload).toString("utf8"))
      } catch {
        // The raw parse message ("Unexpected token < in JSON at position 0") describes the parser,
        // not the file, and this is the message a person reads when an install refuses.
        return { ok: false, reason: "the attestation payload is not valid JSON" }
      }
      const hex = digest.toString("hex")
      if (!statement.subject?.some((subject) => subject.digest?.sha256 === hex)) {
        return { ok: false, reason: "the attestation's subject digest does not match the file" }
      }
    } else {
      return { ok: false, reason: "unsupported bundle content" }
    }
    const entity = toSignedEntity(bundle, Buffer.from(bytes))
    // `extensions.issuer` is compared with `!==` and needs no such treatment; only the SAN is
    // matched as a pattern.
    getVerifier().verify(entity, { subjectAlternativeName: exactIdentity(identityUri), extensions: { issuer } })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: withTrustRootHint(error instanceof Error ? error.message : String(error)) }
  }
}
