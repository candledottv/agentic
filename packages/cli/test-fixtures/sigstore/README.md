# Sigstore verification fixtures

Real, public Sigstore material, committed so `release-verify.test.ts` and
`release-verify.compiled.test.ts` can prove verification end to end with no network and no
secrets. Almost nothing here is ours: the material verification is proved against is another
project's signed release, chosen because it is small and because its signature was made on the
public-good Sigstore instance, which is the same instance our own releases sign against. The one
exception is `legacy-cosign-bundle.json`, which is ours and is here because it is malformed.

| File | What it is |
| --- | --- |
| `fixture.bin` | goreleaser v2.18.0's `checksums.txt`, 5,271 bytes, sha256 `5cde70ff710a88df1c6a21980400884712451b096b53815717ad8d535ca14888`. Named `.bin` so nothing is tempted to normalize its line endings: the digest is the whole point. |
| `fixture.sigstore.json` | The Sigstore bundle goreleaser published beside it (`checksums.txt.sigstore.json`). A **message-signature** bundle, the same shape `cosign sign-blob` produces and the same shape our release workflow publishes. |
| `identity.txt` | The certificate's subject alternative name, the identity that bundle was signed with. |
| `issuer.txt` | The certificate's OIDC issuer extension (`1.3.6.1.4.1.57264.1.1`). |
| `dsse-github-internal.sigstore.json` | GitHub's own release attestation over the same file: a **DSSE** bundle, in GitHub's internal trust domain. Used only to exercise the DSSE subject-digest branch and the trust-domain trap below. |
| `legacy-cosign-bundle.json` | Our own `cli-v0.6.0` `candle-darwin-arm64.sigstore.json`, kept precisely because it is the wrong format: cosign's **legacy** bundle (`base64Signature` / `cert` / `rekorBundle`, no `mediaType`), which `@sigstore/bundle` cannot read. Public release material, no secret in it. See the third trap below. |

## How they were made

```bash
# The artifact and its public-good bundle, from the release itself.
gh release download -R goreleaser/goreleaser --pattern 'checksums.txt'
gh release download -R goreleaser/goreleaser --pattern 'checksums.txt.sigstore.json'
mv checksums.txt fixture.bin
mv checksums.txt.sigstore.json fixture.sigstore.json

# The identity and issuer, read off the leaf certificate rather than typed from memory.
bun -e 'const b=JSON.parse(require("node:fs").readFileSync("fixture.sigstore.json","utf8"));
  require("node:fs").writeFileSync("leaf.der", Buffer.from(b.verificationMaterial.certificate.rawBytes,"base64"))'
openssl x509 -inform DER -in leaf.der -noout -text | grep -A1 -E "Subject Alternative|57264\.1\.1:"
#   URI:https://github.com/goreleaser/goreleaser/.github/workflows/release.yml@refs/tags/v2.18.0
#   1.3.6.1.4.1.57264.1.1: https://token.actions.githubusercontent.com

# The DSSE bundle for the same bytes, from GitHub's attestation API.
gh attestation download checksums.txt --owner goreleaser
mv 'sha256:5cde70ff....jsonl' dsse-github-internal.sigstore.json

# The legacy bundle: cli-v0.6.0's own, downloaded byte for byte from the release it broke.
gh release download -R candledottv/agentic cli-v0.6.0 --pattern 'candle-darwin-arm64.sigstore.json'
mv candle-darwin-arm64.sigstore.json legacy-cosign-bundle.json
```

## Three traps these fixtures exist to pin

**Trust domain, never line index.** `gh attestation download` writes one JSON document per line,
and the lines are not all in the same trust domain. Every small release asset we surveyed
(goreleaser, cli/cli, syft, uv, opa) carries exactly one attestation from that API, and it is
GitHub's own release attestation: certificate issuer `O=GitHub, Inc.` /
`CN=Fulcio Intermediate l1`, SAN `https://dotcom.releases.github.com`, no transparency-log entry.
The public-good trusted root cannot verify it at all, and it fails with
"timestamp could not be verified". A bundle has to be selected by its certificate's trust domain,
never by its position in the file. `dsse-github-internal.sigstore.json` is that bundle, kept so
the refusal is a test rather than a surprise.

**A genuine bundle does not, by itself, vouch for a given file.** For a DSSE bundle
`@sigstore/verify`'s `toSignedEntity(bundle, artifact)` ignores `artifact` entirely, so a real
attestation would happily "verify" beside a swapped binary. `verifyReleaseAsset` compares the
digest itself, before it verifies anything: a message-signature bundle's `messageDigest` and a
DSSE statement's in-toto subject digest both have to equal the file's own SHA-256.

**"cosign verified it" is not "candle can verify it".** `cosign sign-blob --bundle` writes
cosign's legacy bundle unless it is handed `--new-bundle-format`, and cosign and `gh` read both
formats, so a release signed the legacy way passes the release workflow's self-verify and both of
install.sh's verifier paths while being unreadable to the verifier compiled into every candle.
That is what shipped as `cli-v0.6.0`, and `legacy-cosign-bundle.json` is the asset it shipped.
The refusal names the format rather than answering "invalid bundle", which is a message about the
parser and not about the file.

## Refreshing them

Nothing here expires. Fulcio's leaf certificates are short-lived, but verification checks them
against the signing time recorded in the transparency log and the RFC3161 timestamp, so an old
bundle stays verifiable. What can go stale is `src/sigstore-trusted-root.json`, the root these
bundles are checked against: run `bun run refresh-sigstore-root` if verification starts failing
with an expired or unknown trust root.
