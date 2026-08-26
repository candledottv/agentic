/**
 * `candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]`: checks a release
 * asset's Sigstore bundle against the trusted root embedded in this binary, and says so.
 *
 * It exists for two reasons. It is the hands-on way to check a binary someone downloaded by hand
 * or through a mirror, without cosign or gh installed. And it is how the compiled binary's own
 * verification is proved in CI: `release-verify.compiled.test.ts` builds `candle` and runs this
 * command against a real fixture, which is the only way to show that the Bun crypto shim survives
 * `bun build --compile` (bun-crypto-shim.ts explains what happens when it does not).
 *
 * It acts as no identity -- no key, no request, nothing but two files on disk -- so it is in
 * `NEVER_GUARDED` and never pays for an account check.
 */

import { dirname, join } from "node:path"
import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { RELEASE_ISSUER, releaseIdentityUri } from "../release"
import { verifyReleaseAsset } from "../release-verify"
import { writeLocalFailure, writeUsageFailure } from "../render"

const USAGE = "Usage: candle verify <file> --bundle <path> [--identity <uri>] [--issuer <url>]"

/**
 * Where the identity came from, carried alongside it rather than recovered later. The reader of
 * `verified:` has to be able to tell an identity they typed from one the command took off a
 * downloaded manifest, because only the first is a claim they made themselves.
 */
type Identity =
  | { kind: "ok"; uri: string; provenance: string }
  /** A latest.json is present but its version is not one: a refusal, never a fallback. */
  | { kind: "invalid"; message: string }
  | { kind: "absent" }

/**
 * The identity the signature must carry: the flag when given, else the release identity for the
 * version named by a `latest.json` sitting beside the bundle. That is how a release download
 * DIRECTORY is laid out -- latest.json is published beside the assets it describes, so it is
 * beside them again wherever someone downloaded them to -- and it is the case this default is
 * for. (It is not how `candle update` lays anything out: that writes one random temp name beside
 * the binary and verifies in process, passing the identity explicitly.) Absent when neither is
 * available, which is a usage error rather than a guess: verifying against the wrong identity is
 * not a weaker check, it is a different one.
 *
 * A manifest that is missing or unreadable is "absent" and falls through to the flag being
 * required. A manifest whose VERSION is malformed is different in kind and is reported: it is the
 * one input here an attacker supplies, `releaseIdentityUri` refuses it (release.ts explains what
 * `{"version": "x|"}` used to do), and swallowing that refusal into "absent" would answer a
 * tampered manifest with a usage error about a flag.
 */
async function resolveIdentity(deps: Deps, bundlePath: string, flag: string | undefined): Promise<Identity> {
  if (flag) return { kind: "ok", uri: flag, provenance: "identity from --identity" }
  let version: string
  try {
    const manifest = JSON.parse(await deps.readFile(join(dirname(bundlePath), "latest.json"))) as { version?: unknown }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) return { kind: "absent" }
    version = manifest.version
  } catch {
    return { kind: "absent" }
  }
  try {
    return {
      kind: "ok",
      uri: releaseIdentityUri(version),
      provenance: "identity from latest.json beside the bundle",
    }
  } catch (error) {
    return { kind: "invalid", message: messageOf(error) }
  }
}

export async function verify(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--bundle", "--identity", "--issuer"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}\n${USAGE}`, json)
    return 2
  }

  const file = parsed.positionals[0]
  if (parsed.positionals.length !== 1 || file === undefined) {
    writeUsageFailure(deps, `verify takes exactly one file.\n${USAGE}`, json)
    return 2
  }
  const bundlePath = parsed.values["--bundle"]
  if (!bundlePath) {
    writeUsageFailure(deps, `--bundle is required.\n${USAGE}`, json)
    return 2
  }

  const resolved = await resolveIdentity(deps, bundlePath, parsed.values["--identity"])
  if (resolved.kind === "invalid") {
    writeLocalFailure(
      deps,
      {
        code: "MANIFEST_INVALID",
        message: `Refusing ${file}: ${resolved.message}.`,
        suggestion: `The latest.json beside ${bundlePath} does not name a release version. Pass --identity to say what signature to expect.`,
      },
      json,
    )
    return 1
  }
  if (resolved.kind === "absent") {
    writeUsageFailure(
      deps,
      `--identity is required: there is no latest.json beside ${bundlePath} to take the release version from.\n${USAGE}`,
      json,
    )
    return 2
  }
  const identity = resolved.uri
  const issuer = parsed.values["--issuer"] ?? RELEASE_ISSUER

  let bytes: Uint8Array
  let bundleJson: unknown
  try {
    bytes = await deps.readBytes(file)
  } catch (error) {
    writeLocalFailure(deps, { code: "FILE_UNREADABLE", message: `Could not read ${file}: ${messageOf(error)}` }, json)
    return 1
  }
  try {
    bundleJson = JSON.parse(await deps.readFile(bundlePath))
  } catch (error) {
    writeLocalFailure(
      deps,
      { code: "BUNDLE_UNREADABLE", message: `Could not read the bundle ${bundlePath}: ${messageOf(error)}` },
      json,
    )
    return 1
  }

  const result = verifyReleaseAsset(bytes, bundleJson, identity, issuer)
  if (!result.ok) {
    // The library's own refusals already name both sides of whatever did not match, so what is
    // added is where the expectation came from, which the message otherwise leaves the reader to
    // go and look up.
    writeLocalFailure(
      deps,
      {
        code: "SIGNATURE_INVALID",
        message: `Refusing ${file}: ${result.reason}.`,
        suggestion: `Checked against ${identity} (${resolved.provenance}).`,
      },
      json,
    )
    return 1
  }

  // Success names the provenance too, not just failure. "verified:" is the line someone pastes as
  // evidence, and an identity taken off a downloaded manifest is a weaker claim than one they
  // typed; the two must not read identically.
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ok: true, file, identity, issuer, identitySource: resolved.provenance })}\n`)
  } else {
    deps.stdout.write(`verified: ${identity} (${resolved.provenance})\n`)
  }
  return 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
