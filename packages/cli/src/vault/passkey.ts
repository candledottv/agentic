/**
 * Ember Phase 2 (BE-135, AD-2, CC-03's platform passkey bullet, CC-12, helper protocols): the
 * CLI's side of the synced passkey over the native macOS API.
 *
 * The passkey rides the same signed helper as the Secure Enclave (`enclave.ts`): the same release
 * policy gate, the same location rules, the same `/usr/bin/codesign` requirement pinned to what
 * the envelope recorded, the same one-operation-per-process pipe and the same typed translation,
 * never a fallback. What is added here is the gate set AD-2 names, each a typed refusal before any
 * ceremony (CC-12): macOS 15 or later, the helper's associated-domains entitlement for
 * `webcredentials:cli.candle.tv`, an embedded provisioning profile, and, at `factor add` only, a
 * reachable `apple-app-site-association` on the RP id domain that lists the helper's application
 * identifier. At unlock the system's own association check answers instead, so an unlock never
 * needs the network; a failure there is translated to the same refusal, which says what must be
 * served.
 *
 * The KEK derivation is the security key's (ED-4): HKDF-SHA-256 over the 32-byte PRF output with
 * the vault id as salt. The salt handed to the platform is the envelope's raw `prfSalt`; the
 * platform applies whatever hashing it applies (`saltDerivation: "platform"`), and T57 records how
 * that compares with a browser's PRF output as an observation, required by nothing.
 */
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import type { Deps } from "../deps"
import {
  type EnclaveInfoResponse,
  type EnclavePasskeyAssertResponse,
  type EnclavePasskeyRegisterResponse,
  PASSKEY_RP_ID,
} from "../enclave-helper/protocol"
import { b64u, PRF_OUTPUT_BYTES, unb64u } from "./crypto"
import {
  AASA_REQUIREMENT,
  AASA_URL,
  callEnclaveHelper,
  compareVersions,
  ENCLAVE_INSTALL_SUGGESTION,
  type HelperIdentity,
  helperReport,
  locateEnclaveHelper,
  requestCommon,
  verifyHelperSignature,
} from "./enclave"
import { VaultError } from "./errors"
import { userIdFor, userNameFor } from "./fido2"
import type { PlatformPasskeyEnvelope } from "./format"
import { ownSecret, wipe } from "./hygiene"
import { assertFactorAddable, type EnclaveHelperState, platformFactsFor } from "./platform"
import { authDataFlags, authDataFromAttestationObject } from "./webauthn-cbor"

export const AASA_TIMEOUT_MS = 10_000

export interface PasskeySession {
  path: string
  appPath: string
  identity: HelperIdentity
  version: string
}

type HelperDeps = Pick<Deps, "env" | "execPath" | "realpath" | "spawnHelper" | "releasePolicy" | "platform" | "arch">

/**
 * Prepares to drive an ENVELOPE's synced passkey: the policy must be `signed`, the helper present,
 * its signature must satisfy the team id and bundle id THE ENVELOPE recorded, its version at least
 * the envelope's `minVersion`, and what it reports about this Mac must pass every AD-2 gate.
 * Nothing here touches the vault, prompts, or the network.
 */
export async function openPasskeySession(
  deps: HelperDeps,
  helper: { teamId: string; bundleId: string; minVersion?: string },
): Promise<PasskeySession> {
  const policy = deps.releasePolicy.macosHelper
  if (policy.release === "omit") {
    throw new VaultError(
      "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      "This build's release policy omits the signed macOS helper, so it cannot drive a synced passkey factor.",
      { suggestion: "Open the vault with its passphrase. No other envelope was tried." },
    )
  }
  const location = await locateEnclaveHelper(deps)
  if (location.state === "absent") {
    throw new VaultError("VAULT_HELPER_MISSING", `The signed macOS helper is not available: ${location.reason}.`, {
      suggestion: ENCLAVE_INSTALL_SUGGESTION,
    })
  }
  const identity: HelperIdentity = { teamId: helper.teamId, bundleId: helper.bundleId }
  await verifyHelperSignature(deps, location.appPath, identity)
  const info = await callEnclaveHelper<EnclaveInfoResponse>(deps, location.path, requestCommon("-", "-", "info"))
  if (info.teamId !== identity.teamId || info.bundleId !== identity.bundleId) {
    throw new VaultError(
      "VAULT_HELPER_UNTRUSTED",
      `The helper at ${location.appPath} reports team ${info.teamId || "(none)"} and bundle id ${info.bundleId || "(none)"}, not the ${identity.teamId} / ${identity.bundleId} this envelope recorded.`,
      { suggestion: "Reinstall the CLI from a release. No other factor is substituted." },
    )
  }
  if (helper.minVersion !== undefined && compareVersions(info.version, helper.minVersion) < 0) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `The signed macOS helper at ${location.appPath} is version ${info.version}; this envelope needs ${helper.minVersion} or newer.`,
      { suggestion: "Reinstall the CLI so candle and candle-enclave.app come from the same release." },
    )
  }
  // The AD-2 gates, through the same seam `status` and `factor add` use, so the reasons are the
  // platform seam's and cannot drift from what `factor list` says.
  const ready: EnclaveHelperState = {
    state: "ready",
    appPath: location.appPath,
    path: location.path,
    source: location.source,
    identity,
    version: info.version,
    secureEnclave: info.secureEnclave,
    ...helperReport(info),
  }
  assertFactorAddable("passkey-prf", platformFactsFor(deps, undefined, ready), "platform-macos")
  return { path: location.path, appPath: location.appPath, identity, version: info.version }
}

// ── The apple-app-site-association (a deployment prerequisite, checked before registration) ──

/**
 * Fetches the RP id domain's `apple-app-site-association` and refuses, typed, unless it is what
 * macOS needs: 200 over HTTPS, no redirect, `Content-Type: application/json`, and a
 * `webcredentials.apps` list naming this helper's application identifier. The system reads the
 * file through Apple's CDN and caches its verdict, so passing here does not prove the ceremony
 * will; failing here saves the operator a passphrase and names exactly what must be served.
 */
export async function checkAppleAppSiteAssociation(
  deps: Pick<Deps, "fetch">,
  identity: HelperIdentity,
): Promise<{ appId: string }> {
  const appId = `${identity.teamId}.${identity.bundleId}`
  const refuse = (detail: string): never => {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `The domain association for the synced passkey factor is not in place: ${detail}. ${AASA_REQUIREMENT} This build's helper is ${appId}.`,
      {
        suggestion:
          "That file is a deployment prerequisite, not something this CLI can create. No other factor is substituted and nothing was written.",
      },
    )
  }
  let response: Response
  try {
    response = await deps.fetch(AASA_URL, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(AASA_TIMEOUT_MS),
    })
  } catch (error) {
    return refuse(`${AASA_URL} could not be fetched (${error instanceof Error ? error.message : String(error)})`)
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return refuse(
      `${AASA_URL} redirects (status ${response.status || "3xx"}), and macOS does not follow a redirect for this file`,
    )
  }
  if (response.status !== 200) return refuse(`${AASA_URL} answered status ${response.status}`)
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (contentType !== "application/json") {
    return refuse(`${AASA_URL} is served as ${contentType || "no Content-Type"}, not application/json`)
  }
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch {
    return refuse(`${AASA_URL} is not valid JSON`)
  }
  const apps = (body as { webcredentials?: { apps?: unknown } } | null)?.webcredentials?.apps
  if (!Array.isArray(apps)) return refuse(`${AASA_URL} has no webcredentials.apps list`)
  if (!apps.includes(appId)) {
    return refuse(
      `${AASA_URL} lists ${apps.length > 0 ? apps.map(String).join(", ") : "no application"} under webcredentials.apps, not ${appId}`,
    )
  }
  return { appId }
}

// ── Authenticator data checks the CLI makes itself (the side that does not trust the helper) ──

/**
 * Before anything is derived: the authenticator data must be for THIS relying party and must
 * carry the UV flag. The helper already refused to proceed without user verification; this is the
 * side that does not trust it (CC-03).
 */
export function assertPlatformAuthData(authData: Uint8Array, rpId: string, what: string): void {
  if (authData.length < 37) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The synced passkey's ${what} returned truncated authenticator data; nothing was derived.`,
    )
  }
  const expected = sha256(new TextEncoder().encode(rpId))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (authData[i] ?? 0) ^ (expected[i] ?? 0)
  if (diff !== 0) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The synced passkey's ${what} is for a different relying party than ${rpId}; nothing was derived.`,
    )
  }
  if (!authDataFlags(authData).userVerified) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The synced passkey's ${what} was made without user verification (the UV flag is clear), so its output is not this envelope's key; nothing was derived.`,
      {
        suggestion:
          "This factor never falls back to a non-verified secret. Confirm with Touch ID or the account password and retry.",
      },
    )
  }
}

// ── The two ceremonies ────────────────────────────────────────────────────────────────────────

export interface RegisteredPasskey {
  /** base64url, as the envelope stores it. */
  credentialId: string
  backupEligible: boolean
  backupState: boolean
  prfSupported: boolean
}

type CeremonyDeps = Pick<Deps, "spawnHelper" | "stderr">

/** One registration: a discoverable, user-verified credential under the RP id, PRF support checked. */
export async function registerPlatformPasskey(
  deps: CeremonyDeps,
  session: PasskeySession,
  opts: { vaultId: string; envelopeId: string },
): Promise<RegisteredPasskey> {
  deps.stderr.write(
    "Confirm in the passkey sheet to create this vault's synced passkey (Touch ID or the account password).\n",
  )
  const common = requestCommon(opts.vaultId, opts.envelopeId, "passkey-register")
  const response = await callEnclaveHelper<EnclavePasskeyRegisterResponse>(deps, session.path, {
    ...common,
    rpId: PASSKEY_RP_ID,
    userId: base64.encode(userIdFor(opts.vaultId, opts.envelopeId)),
    userName: userNameFor(opts.vaultId, opts.envelopeId),
    // The operation digest is the challenge, so the ceremony is bound to this request.
    clientDataHash: common.digest,
  })
  const authData = authDataFromAttestationObject(base64.decode(response.attestationObject))
  assertPlatformAuthData(authData, PASSKEY_RP_ID, "registration")
  const flags = authDataFlags(authData)
  return {
    credentialId: b64u(base64.decode(response.credentialId)),
    backupEligible: flags.backupEligible,
    backupState: flags.backupState,
    prfSupported: response.prfSupported === true,
  }
}

/**
 * One user-verified assertion against the envelope's credential with its raw PRF salt, yielding
 * the 32-byte PRF output the KEK derives from. The caller owns the returned buffer and zeroes it.
 */
export async function assertPlatformPrf(
  deps: CeremonyDeps,
  session: PasskeySession,
  envelope: PlatformPasskeyEnvelope,
  vaultId: string,
  purpose: string,
): Promise<Uint8Array> {
  deps.stderr.write(`Confirm the synced passkey to ${purpose}.\n`)
  const common = requestCommon(vaultId, envelope.id, "passkey-assert")
  const response = await callEnclaveHelper<EnclavePasskeyAssertResponse>(deps, session.path, {
    ...common,
    rpId: envelope.rpId,
    credentialId: base64.encode(unb64u(envelope.credentialId, "credentialId")),
    clientDataHash: common.digest,
    prfSalt: base64.encode(unb64u(envelope.prfSalt, "prfSalt")),
  })
  const prfOutput = ownSecret(base64.decode(response.prfOutput))
  try {
    assertPlatformAuthData(base64.decode(response.authenticatorData), envelope.rpId, "assertion")
    if (prfOutput.length !== PRF_OUTPUT_BYTES) {
      throw new VaultError(
        "VAULT_UNLOCK_FAILED",
        `The platform authenticator returned ${prfOutput.length} bytes of PRF output; this factor needs ${PRF_OUTPUT_BYTES}. Nothing was derived.`,
      )
    }
  } catch (error) {
    wipe(prfOutput)
    throw error
  }
  return prfOutput
}
