/**
 * Ember Phase 2 (BE-141, ED-12, CC-12, helper protocols): the CLI's side of `candle-enclave`.
 *
 * Everything the CLI knows about the Secure Enclave goes through here, in the order the spec
 * fixes: the checked-in release policy first (a build whose policy is `omit` ships no signed
 * helper and refuses the factor, typed, whatever is on disk); then the helper is located (at
 * `CANDLE_ENCLAVE_HELPER`, beside the binary, or in Homebrew's libexec); then its code signature
 * is verified by spawning `/usr/bin/codesign` by absolute path with `--verify --strict` and an
 * explicit requirement pinning the team id and the bundle id (ED-12), refusing on any non-zero
 * exit with `VAULT_HELPER_UNTRUSTED`; only then is one operation run per process over a pipe, and
 * its typed code translated into this document's error codes and never into a fallback.
 *
 * What the signature check defends and does not (ED-12, stated rather than implied): it catches a
 * wrong or stale helper, an unsigned development build, a helper signed by another team, an older
 * helper whose designated requirement no longer matches. It does not defend against a same-user
 * attacker, who can patch this CLI or what it spawns. The helper does not check its caller.
 *
 * The KEK is the CLI's (ED-4): 32 random bytes, wrapped to the Enclave key's public key with
 * Apple's ECIES (`ecies.ts`) at enrolment, unwrapped by the Enclave behind Touch ID at every
 * unlock, used once, zeroed.
 */
import { access, constants } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import type { Deps } from "../deps"
import {
  type BiometryState,
  type BiometryType,
  ENCLAVE_ACCESS_CONTROL,
  ENCLAVE_BUNDLE_NAME,
  ENCLAVE_EXECUTABLE_RELATIVE,
  ENCLAVE_PROTOCOL,
  type EnclaveCode,
  type EnclaveCreateResponse,
  type EnclaveDecryptResponse,
  type EnclaveDeleteResponse,
  type EnclaveInfoResponse,
  type EnclaveResponse,
  type LaErrorReport,
} from "../enclave-helper/protocol"
import { compareVersions, detectInstall } from "../release"
import { canonicalBytes } from "./canonical-json"
import { b64u, KEK_BYTES, randomBytes, unb64u } from "./crypto"
import { eciesEncrypt, pointFromSpki, spkiFromPoint } from "./ecies"
import { VaultError, type VaultErrorCode } from "./errors"
import type { SecureEnclaveEnvelope } from "./format"
import { isHelperBundleId, isHelperTeamId } from "./helper-identity"
import { ownSecret, wipe } from "./hygiene"
import type { EnclaveHelperState } from "./platform"

export const ENCLAVE_HELPER_ENV = "CANDLE_ENCLAVE_HELPER"
export const CODESIGN_PATH = "/usr/bin/codesign"
/**
 * Long enough for the Touch ID sheet to sit on screen while the operator finds the sensor; past
 * it the helper is terminated and the result is `VAULT_AUTHENTICATOR_CANCELLED`, nothing derived.
 */
export const ENCLAVE_HELPER_TIMEOUT_MS = 120_000
export const CODESIGN_TIMEOUT_MS = 30_000

/**
 * What the RP id domain must serve for the synced passkey factor (BE-135, AD-2). A web asset no
 * CLI package can ship, so it is a deployment prerequisite recorded in T57; the CLI checks it
 * before the registration ceremony and says this when the association fails.
 */
export const AASA_URL = "https://cli.candle.tv/.well-known/apple-app-site-association"
export const AASA_REQUIREMENT = `The domain must serve ${AASA_URL} over HTTPS with status 200, no redirect, Content-Type application/json, and a body of {"webcredentials":{"apps":["<TEAM ID>.<bundle id>"]}} listing the signed helper's application identifier.`

export const ENCLAVE_INSTALL_SUGGESTION =
  "Install a release build of the CLI that ships the signed helper (the darwin tarball and Homebrew place candle-enclave.app beside candle), or set CANDLE_ENCLAVE_HELPER to the path of a signed candle-enclave.app. No other factor is substituted."

// ── The checked-in release policy ─────────────────────────────────────────────────────────────

export type MacosHelperRelease = "omit" | "signed"

/**
 * `packages/cli/release-policy.json`, the one switch that decides whether a release ships the
 * signed helper. The release job reads the same file. `signed` requires a team id here, which the
 * job checks against the certificate it signs with; `omit` is the state until Apple approves the
 * AD-1 enrolment, and under it this build refuses the factor even when a helper is on disk,
 * because it has no team id to pin the signature to.
 */
export interface ReleasePolicy {
  macosHelper: { release: MacosHelperRelease; bundleId: string; teamId: string }
}

export function parseReleasePolicy(value: unknown): ReleasePolicy {
  const bad = (detail: string): never => {
    throw new Error(`release-policy.json is malformed: ${detail}`)
  }
  if (typeof value !== "object" || value === null) return bad("not an object")
  const helper = (value as { macosHelper?: unknown }).macosHelper
  if (typeof helper !== "object" || helper === null) return bad("macosHelper is missing")
  const { release, bundleId, teamId } = helper as Record<string, unknown>
  if (release !== "omit" && release !== "signed") return bad(`macosHelper.release must be "omit" or "signed"`)
  if (typeof bundleId !== "string" || !/^[a-z0-9.-]+$/i.test(bundleId)) {
    return bad("macosHelper.bundleId is not a bundle id")
  }
  if (typeof teamId !== "string") return bad("macosHelper.teamId is not a string")
  if (release === "signed" && !/^[A-Z0-9]{10}$/.test(teamId)) {
    return bad('macosHelper.release is "signed" but macosHelper.teamId is not a 10-character Apple team id')
  }
  if (release === "omit" && teamId !== "") return bad('macosHelper.release is "omit" but macosHelper.teamId is set')
  return { macosHelper: { release, bundleId, teamId } }
}

// ── Locating the helper ───────────────────────────────────────────────────────────────────────

export type EnclaveHelperLocation =
  | { state: "ready"; appPath: string; path: string; source: "env" | "beside-binary" | "libexec" }
  | { state: "absent"; reason: string }

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `<something>.app` or the executable inside it, either way answering the bundle and the executable. */
async function asBundle(candidate: string): Promise<{ appPath: string; path: string } | null> {
  const appPath = candidate.endsWith(`/${ENCLAVE_EXECUTABLE_RELATIVE}`)
    ? candidate.slice(0, -(ENCLAVE_EXECUTABLE_RELATIVE.length + 1))
    : candidate
  const path = join(appPath, ENCLAVE_EXECUTABLE_RELATIVE)
  return (await isExecutable(path)) ? { appPath, path } : null
}

/**
 * `CANDLE_ENCLAVE_HELPER` first, then the bundle beside the real binary, then Homebrew's
 * `libexec` next to its `bin`. An npm install ships no bundle, so there the helper is absent until
 * one is installed and pointed at.
 */
export async function locateEnclaveHelper(
  deps: Pick<Deps, "env" | "execPath" | "realpath">,
): Promise<EnclaveHelperLocation> {
  const fromEnv = deps.env[ENCLAVE_HELPER_ENV]?.trim()
  if (fromEnv) {
    const bundle = await asBundle(fromEnv)
    if (bundle) return { state: "ready", ...bundle, source: "env" }
    return {
      state: "absent",
      reason: `${ENCLAVE_HELPER_ENV} points at ${fromEnv}, which is not a ${ENCLAVE_BUNDLE_NAME} bundle with an executable at ${ENCLAVE_EXECUTABLE_RELATIVE}`,
    }
  }
  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  if (detectInstall(deps.execPath, realExec) === "script") {
    return {
      state: "absent",
      reason: `this CLI is running from the npm package (or a source checkout), which ships no ${ENCLAVE_BUNDLE_NAME}`,
    }
  }
  const beside = await asBundle(join(dirname(realExec), ENCLAVE_BUNDLE_NAME))
  if (beside) return { state: "ready", ...beside, source: "beside-binary" }
  const libexec = await asBundle(join(dirname(dirname(realExec)), "libexec", ENCLAVE_BUNDLE_NAME))
  if (libexec) return { state: "ready", ...libexec, source: "libexec" }
  return { state: "absent", reason: `no ${ENCLAVE_BUNDLE_NAME} beside ${realExec} or in its libexec` }
}

// ── The code signature check (ED-12) ──────────────────────────────────────────────────────────

export interface HelperIdentity {
  teamId: string
  bundleId: string
}

/**
 * The requirement the helper must satisfy: Apple's anchor, a Developer ID leaf issued through
 * Apple's Developer ID intermediate, THIS team, THIS bundle id. A development certificate, an
 * App Store signature, another team's Developer ID, or an ad hoc signature all fail it.
 */
export function codesignRequirement(identity: HelperIdentity): string {
  if (!isHelperTeamId(identity.teamId) || !isHelperBundleId(identity.bundleId)) {
    throw new VaultError("VAULT_HELPER_UNTRUSTED", "The helper identity has an invalid team id or bundle id.", {
      suggestion: "No helper was run and no other factor was tried.",
    })
  }
  return `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${identity.teamId}" and identifier "${identity.bundleId}"`
}

export function codesignArguments(appPath: string, identity: HelperIdentity): string[] {
  return ["--verify", "--strict", "--deep", "-R", codesignRequirement(identity), appPath]
}

/**
 * Spawns `/usr/bin/codesign` by absolute path and refuses on any non-zero exit. The requirement is
 * passed inline (the leading `=` is codesign's syntax for text rather than a file), so no file on
 * disk can substitute for what the CLI pinned.
 */
export async function verifyHelperSignature(
  deps: Pick<Deps, "spawnHelper">,
  appPath: string,
  identity: HelperIdentity,
): Promise<void> {
  const run = await deps.spawnHelper(CODESIGN_PATH, "", {
    timeoutMs: CODESIGN_TIMEOUT_MS,
    args: codesignArguments(appPath, identity),
  })
  if (run.spawnError !== undefined) {
    throw new VaultError(
      "VAULT_HELPER_UNTRUSTED",
      `Could not run ${CODESIGN_PATH} to verify the Secure Enclave helper at ${appPath}: ${run.spawnError}.`,
      { suggestion: "The helper is not used until its signature has been verified. No other factor is substituted." },
    )
  }
  if (run.exitCode !== 0) {
    const detail = run.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 200)
    throw new VaultError(
      "VAULT_HELPER_UNTRUSTED",
      `The Secure Enclave helper at ${appPath} failed the code signature check for team ${identity.teamId} and bundle id ${identity.bundleId} (codesign exit ${run.exitCode ?? run.signal ?? "unknown"}${detail ? `: ${detail}` : ""}).`,
      {
        suggestion:
          "An unsigned development build, a helper signed by another team, or a stale helper whose designated requirement no longer matches all fail here. Reinstall the CLI from a release. No other factor is substituted.",
      },
    )
  }
}

// ── Running one operation ─────────────────────────────────────────────────────────────────────

/** What the CLI says about Touch ID from the session's point of view (BE-135, constraint 5). */
export const NOT_INTERACTIVE_SUGGESTION =
  "Run the command from a Terminal window inside the logged-in session on that Mac (not over SSH, not from a background agent, not with the lid closed and no display), then retry. Nothing was derived and no other factor is substituted; the passphrase still opens the vault."

/**
 * Touch ID's state in words, from what the helper's `info` reported (BE-135). The five states are
 * kept apart on purpose: "not available from this session" (`LAError` `systemCancel` or
 * `notInteractive`, which is what a process outside the interactive login session gets on a Mac
 * that has Touch ID) is neither "no sensor", nor "not enrolled", nor "locked out", and PR F's
 * helper reported it as the first of those with the reason "Authentication canceled".
 */
export function describeBiometry(report: {
  biometry: BiometryState
  biometryReason?: string
  biometryType?: BiometryType
  laError?: LaErrorReport
}): { message: string; suggestion: string } {
  const la = report.laError ? ` (LAError ${report.laError.name}, ${report.laError.code})` : ""
  const reason = report.biometryReason ? `: ${report.biometryReason.replace(/\.$/, "")}` : ""
  switch (report.biometry) {
    case "available":
      return { message: "Touch ID is available.", suggestion: "" }
    case "none":
      return {
        message: `No fingerprint is enrolled on this Mac${reason}${la}.`,
        suggestion:
          "Enrol a fingerprint in System Settings, Touch ID & Password, then retry. Nothing was written and no other factor is substituted.",
      }
    case "locked-out":
      return {
        message: `Touch ID is locked out after too many failed attempts${reason}${la}.`,
        suggestion:
          "Unlock the Mac with its password to reset Touch ID, then retry. Nothing was written and no other factor is substituted.",
      }
    case "not-interactive":
      return {
        message: `Touch ID is not available from this session${la}: this Mac ${report.biometryType && report.biometryType !== "none" ? `has ${biometryTypeWord(report.biometryType)}, but` : "may have Touch ID, but"} no prompt can be shown to a process outside the interactive login session (SSH, a background agent, the lid closed with no display)${reason}.`,
        suggestion: NOT_INTERACTIVE_SUGGESTION,
      }
    default:
      if (report.biometryType === "none") {
        return {
          message: `This Mac has no Touch ID sensor${reason}${la}.`,
          suggestion:
            "Use a Mac with Touch ID, or a Magic Keyboard with Touch ID paired to this Mac. Nothing was written and no other factor is substituted.",
        }
      }
      return {
        message: `Touch ID is present but not usable right now${reason}${la}.`,
        suggestion:
          "Open the lid, or use a keyboard with Touch ID, or unlock the Mac with its password first, then retry. Nothing was written and no other factor is substituted.",
      }
  }
}

function biometryTypeWord(type: BiometryType): string {
  switch (type) {
    case "touchID":
      return "Touch ID"
    case "faceID":
      return "Face ID"
    case "opticID":
      return "Optic ID"
    default:
      return "no biometric sensor"
  }
}

/** The translation table from the helper's codes into the spec's; the contract, not a note. */
export function translateEnclaveFailure(code: string, message: string): VaultError {
  const table: Partial<Record<EnclaveCode, VaultErrorCode>> = {
    NO_ENCLAVE: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
    BIOMETRY_UNAVAILABLE: "VAULT_FACTOR_UNAVAILABLE",
    NOT_INTERACTIVE: "VAULT_FACTOR_UNAVAILABLE",
    KEY_NOT_FOUND: "VAULT_FACTOR_UNAVAILABLE",
    KEY_EXISTS: "VAULT_FACTOR_UNAVAILABLE",
    CANCELLED: "VAULT_AUTHENTICATOR_CANCELLED",
    AUTH_FAILED: "VAULT_UNLOCK_FAILED",
    LOCKED: "VAULT_AUTHENTICATOR_BLOCKED",
    DECRYPT_FAILED: "VAULT_UNLOCK_FAILED",
    KEYCHAIN_IO: "VAULT_FACTOR_UNAVAILABLE",
    PASSKEY_UNSUPPORTED: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
    PRF_UNSUPPORTED: "VAULT_PRF_UNSUPPORTED",
    DOMAIN_NOT_ASSOCIATED: "VAULT_FACTOR_UNAVAILABLE",
    NO_CREDENTIAL: "VAULT_CREDENTIAL_NOT_PRESENT",
  }
  const detail: Partial<Record<EnclaveCode, string>> = {
    NO_ENCLAVE: `This Mac has no Secure Enclave: ${message}.`,
    BIOMETRY_UNAVAILABLE: `Touch ID is not available right now: ${message}.`,
    NOT_INTERACTIVE: `Touch ID is not available from this session (no prompt can be shown to a process outside the interactive login session): ${message}.`,
    KEY_NOT_FOUND: `This Mac's Secure Enclave does not hold this envelope's key: ${message}.`,
    KEY_EXISTS: `The Secure Enclave already holds a key under this envelope's tag: ${message}.`,
    CANCELLED: `The prompt did not complete: ${message}.`,
    AUTH_FAILED: `Touch ID did not verify, or this Mac's enrolled fingerprints changed since the factor was added (the key is bound to the fingerprint set that existed then): ${message}.`,
    LOCKED: `Touch ID is locked out: ${message}.`,
    DECRYPT_FAILED: `The Secure Enclave could not unwrap this envelope's key: ${message}.`,
    KEYCHAIN_IO: `The keychain refused the Secure Enclave operation: ${message}.`,
    PASSKEY_UNSUPPORTED: `The platform passkey API is not available here: ${message}.`,
    PRF_UNSUPPORTED: `The platform authenticator cannot serve this factor: ${message}.`,
    DOMAIN_NOT_ASSOCIATED: `macOS did not associate the helper with cli.candle.tv: ${message}. ${AASA_REQUIREMENT}`,
    NO_CREDENTIAL: `No synced passkey with this envelope's credential id is available to this Mac or this Apple account: ${message}.`,
  }
  const suggestion: Partial<Record<EnclaveCode, string>> = {
    BIOMETRY_UNAVAILABLE:
      "Open the lid, or use a keyboard with Touch ID, or unlock the Mac with its password first. Nothing was derived and no other factor was tried; the passphrase still opens the vault.",
    NOT_INTERACTIVE: NOT_INTERACTIVE_SUGGESTION,
    KEY_NOT_FOUND:
      "An Enclave key never leaves the Mac that created it. On another Mac, open the vault with the passphrase and add a new Touch ID factor there. No other factor was tried.",
    AUTH_FAILED:
      "If the fingerprint set changed, remove this factor (candle vault factor remove <id>, with the passphrase) and add it again. No other factor was tried.",
    LOCKED: "Unlock the Mac with its password to reset Touch ID, then retry. No other factor was tried.",
    CANCELLED: "Run the command again and confirm when the prompt appears. No other factor was tried.",
    PASSKEY_UNSUPPORTED: "The synced passkey factor needs macOS 15 or later. No other factor is substituted.",
    PRF_UNSUPPORTED:
      "Nothing was written. The passkey this attempt created remains in your Passwords (System Settings, Passwords) and can be removed there. No other factor is substituted and no other derivation is tried.",
    DOMAIN_NOT_ASSOCIATED:
      "Until the domain association holds, the synced passkey factor is refused; no other factor is substituted.",
    NO_CREDENTIAL:
      "Sign in to the Apple account that holds the passkey, or open the vault with the passphrase. No other factor was tried.",
  }
  const mapped = table[code as EnclaveCode]
  if (mapped === undefined) {
    return new VaultError("VAULT_UNLOCK_FAILED", `The Secure Enclave helper reported ${code}: ${message}.`, {
      suggestion: "Nothing was derived and no other factor was tried.",
    })
  }
  return new VaultError(mapped, detail[code as EnclaveCode] ?? `${message}.`, {
    suggestion: suggestion[code as EnclaveCode] ?? "Nothing was derived and no other factor was tried.",
  })
}

export async function callEnclaveHelper<T extends Exclude<EnclaveResponse, { ok: false }>>(
  deps: Pick<Deps, "spawnHelper">,
  helperPath: string,
  request: Record<string, unknown>,
): Promise<T> {
  const run = await deps.spawnHelper(helperPath, JSON.stringify(request), { timeoutMs: ENCLAVE_HELPER_TIMEOUT_MS })
  if (run.spawnError !== undefined) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `Could not run the Secure Enclave helper at ${helperPath}: ${run.spawnError}.`,
      { suggestion: ENCLAVE_INSTALL_SUGGESTION },
    )
  }
  const line = run.stdout.split("\n").find((candidate) => candidate.trim() !== "")
  let response: EnclaveResponse | undefined
  if (line !== undefined) {
    try {
      response = JSON.parse(line) as EnclaveResponse
    } catch {
      response = undefined
    }
  }
  if (response === undefined) {
    if (run.signal !== null) {
      throw new VaultError(
        "VAULT_AUTHENTICATOR_CANCELLED",
        `The Secure Enclave operation was cancelled (helper terminated by ${run.signal}) and nothing was derived.`,
        { suggestion: "Run the command again and confirm with Touch ID when the prompt appears." },
      )
    }
    const diagnostic = run.stderr.trim().split("\n")[0]?.slice(0, 200)
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The Secure Enclave helper at ${helperPath} exited (${run.exitCode ?? "no code"}) without a response${diagnostic ? `: ${diagnostic}` : ""}.`,
      { suggestion: "Nothing was derived and no other factor was tried." },
    )
  }
  if (typeof response !== "object" || response === null || response.protocol !== ENCLAVE_PROTOCOL) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `The Secure Enclave helper at ${helperPath} speaks protocol ${String((response as { protocol?: unknown })?.protocol)}; this CLI needs protocol ${ENCLAVE_PROTOCOL}.`,
      { suggestion: "Reinstall the CLI so candle and candle-enclave.app come from the same release." },
    )
  }
  if (!response.ok) throw translateEnclaveFailure(String(response.code), String(response.message))
  if (run.exitCode !== 0) {
    throw new VaultError("VAULT_HELPER_MISSING", "The signed macOS helper did not complete successfully.")
  }
  return response as T
}

/** The 32-byte operation digest every request carries. */
export function enclaveOperationDigest(fields: {
  vaultId: string
  envelopeId: string
  op: string
  nonce: string
}): string {
  return base64.encode(sha256(canonicalBytes({ purpose: "candle-enclave/operation", ...fields })))
}

export function requestCommon(vaultId: string, envelopeId: string, op: string): Record<string, unknown> {
  // The nonce is not a secret, but every random buffer is tracked by the T36 seam, so it is
  // zeroed once encoded rather than left for the collector.
  const nonce = randomBytes(16)
  const digest = enclaveOperationDigest({ vaultId, envelopeId, op, nonce: b64u(nonce) })
  wipe(nonce)
  return { op, vaultId, envelopeId, digest }
}

// ── The helper's state for this run (the platform seam's input) ───────────────────────────────

type HelperDeps = Pick<Deps, "env" | "execPath" | "realpath" | "spawnHelper" | "releasePolicy">

/**
 * Policy, location, signature, then `info`: the four gates in order, each a typed state the
 * platform seam turns into CC-12's availability. `info` prompts for nothing.
 */
export async function currentEnclaveHelper(deps: HelperDeps): Promise<EnclaveHelperState> {
  const policy = deps.releasePolicy.macosHelper
  if (policy.release === "omit") {
    return {
      state: "omitted",
      reason:
        "this build's release policy omits the signed Secure Enclave helper (release-policy.json: macosHelper.release is omit), so the Touch ID factor is not in this build; it arrives in CLI 0.12.0 (PR F) once Apple approves the Developer ID enrolment and T48 has passed",
    }
  }
  const identity: HelperIdentity = { teamId: policy.teamId, bundleId: policy.bundleId }
  const location = await locateEnclaveHelper(deps)
  if (location.state === "absent") return { state: "absent", reason: location.reason }
  try {
    await verifyHelperSignature(deps, location.appPath, identity)
  } catch (error) {
    if (error instanceof VaultError && error.code === "VAULT_HELPER_UNTRUSTED") {
      return { state: "untrusted", reason: error.message }
    }
    throw error
  }
  let info: EnclaveInfoResponse
  try {
    info = await callEnclaveHelper<EnclaveInfoResponse>(deps, location.path, requestCommon("-", "-", "info"))
    if (
      info.op !== "info" ||
      typeof info.version !== "string" ||
      typeof info.secureEnclave !== "boolean" ||
      !["available", "none", "locked-out", "not-interactive", "unavailable"].includes(info.biometry)
    ) {
      throw new VaultError("VAULT_HELPER_MISSING", "Invalid helper info response.")
    }
  } catch (error) {
    if (!(error instanceof VaultError)) throw error
    // Availability is non-fatal. Never echo the helper's arbitrary output into status or JSON.
    return {
      state: "unavailable",
      code: error.code === "VAULT_HELPER_MISSING" ? "VAULT_HELPER_MISSING" : "VAULT_FACTOR_UNAVAILABLE",
      reason: `the signed macOS helper could not report its availability (${error.code}); reinstall the CLI or retry from an interactive session`,
    }
  }
  // The helper's own signature says who it is; the CLI pinned who it must be. Both must agree
  // before its answers about this Mac are believed.
  if (info.teamId !== identity.teamId || info.bundleId !== identity.bundleId) {
    return {
      state: "untrusted",
      reason: `the helper at ${location.appPath} reports team ${info.teamId || "(none)"} and bundle id ${info.bundleId || "(none)"}, not the ${identity.teamId} / ${identity.bundleId} this CLI pins`,
    }
  }
  return {
    state: "ready",
    appPath: location.appPath,
    path: location.path,
    source: location.source,
    identity,
    version: info.version,
    secureEnclave: info.secureEnclave,
    ...helperReport(info),
  }
}

/** What a verified helper's `info` said about this Mac, tolerant of a PR F helper that says less (BE-135). */
export function helperReport(info: EnclaveInfoResponse): {
  biometry: BiometryState
  biometryReason?: string
  biometryType?: BiometryType
  laError?: LaErrorReport
  osMajor?: number
  associatedDomains: string[]
  provisioningProfile: boolean
} {
  const osMajor =
    typeof info.osVersion === "string" ? Number.parseInt(info.osVersion.split(".")[0] ?? "", 10) : Number.NaN
  return {
    biometry: info.biometry,
    ...(info.biometryReason !== undefined ? { biometryReason: info.biometryReason } : {}),
    ...(info.biometryType !== undefined ? { biometryType: info.biometryType } : {}),
    ...(info.laError !== undefined
      ? { laError: { code: Number(info.laError.code), name: String(info.laError.name) } }
      : {}),
    ...(Number.isInteger(osMajor) ? { osMajor } : {}),
    associatedDomains: Array.isArray(info.associatedDomains) ? info.associatedDomains.map(String) : [],
    provisioningProfile: info.provisioningProfile === true,
  }
}

// ── Sessions and ceremonies ───────────────────────────────────────────────────────────────────

export interface EnclaveSession {
  path: string
  appPath: string
  identity: HelperIdentity
  version: string
  biometry: BiometryState
}

/** Refuse an envelope's untrusted identity before locating or spawning a helper. */
export function pinnedHelperIdentity(deps: Pick<Deps, "releasePolicy">, helper: HelperIdentity): HelperIdentity {
  const policy = deps.releasePolicy.macosHelper
  const identity = { teamId: policy.teamId, bundleId: policy.bundleId }
  if (helper.teamId !== identity.teamId || helper.bundleId !== identity.bundleId) {
    throw new VaultError(
      "VAULT_HELPER_UNTRUSTED",
      `This envelope recorded helper ${helper.teamId} / ${helper.bundleId}; this build trusts ${identity.teamId} / ${identity.bundleId}.`,
      { suggestion: "No helper was run and no other factor was tried." },
    )
  }
  return identity
}

/** Open only with this build's pinned identity and the envelope's minimum helper version. */
export async function openEnclaveSession(
  deps: HelperDeps,
  helper: { teamId: string; bundleId: string; minVersion?: string },
): Promise<EnclaveSession> {
  const policy = deps.releasePolicy.macosHelper
  if (policy.release === "omit") {
    throw new VaultError(
      "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      "This build's release policy omits the signed Secure Enclave helper, so it cannot drive a Touch ID factor.",
      { suggestion: "Open the vault with its passphrase. No other envelope was tried." },
    )
  }
  const identity = pinnedHelperIdentity(deps, helper)
  const location = await locateEnclaveHelper(deps)
  if (location.state === "absent") {
    throw new VaultError("VAULT_HELPER_MISSING", `The Secure Enclave helper is not available: ${location.reason}.`, {
      suggestion: ENCLAVE_INSTALL_SUGGESTION,
    })
  }
  await verifyHelperSignature(deps, location.appPath, identity)
  const info = await callEnclaveHelper<EnclaveInfoResponse>(deps, location.path, requestCommon("-", "-", "info"))
  if (info.teamId !== identity.teamId || info.bundleId !== identity.bundleId) {
    throw new VaultError(
      "VAULT_HELPER_UNTRUSTED",
      `The helper at ${location.appPath} reports team ${info.teamId || "(none)"} and bundle id ${info.bundleId || "(none)"}, not the ${identity.teamId} / ${identity.bundleId} this build trusts.`,
      { suggestion: "Reinstall the CLI from a release. No other factor is substituted." },
    )
  }
  if (helper.minVersion !== undefined && compareVersions(info.version, helper.minVersion) < 0) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `The Secure Enclave helper at ${location.appPath} is version ${info.version}; this envelope needs ${helper.minVersion} or newer.`,
      { suggestion: "Reinstall the CLI so candle and candle-enclave.app come from the same release." },
    )
  }
  if (!info.secureEnclave) {
    throw new VaultError("VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM", "This Mac has no Secure Enclave.", {
      suggestion: "No other factor is substituted.",
    })
  }
  return { path: location.path, appPath: location.appPath, identity, version: info.version, biometry: info.biometry }
}

/** The keychain application tag: unique per envelope, derived so nothing beyond the ids is stored. */
export function keyTagFor(vaultId: string, envelopeId: string): string {
  return `tv.candle.cli.vault.${vaultId}.${envelopeId}`
}

export async function createEnclaveKey(
  deps: Pick<Deps, "spawnHelper">,
  session: EnclaveSession,
  opts: { vaultId: string; envelopeId: string; label: string },
): Promise<{ point: Uint8Array; publicKeySpki: string }> {
  const response = await callEnclaveHelper<EnclaveCreateResponse>(deps, session.path, {
    ...requestCommon(opts.vaultId, opts.envelopeId, "create"),
    keyTag: keyTagFor(opts.vaultId, opts.envelopeId),
    label: `Candle vault ${opts.vaultId.slice(0, 8)} ${opts.envelopeId} (${opts.label})`,
    accessControl: ENCLAVE_ACCESS_CONTROL,
  })
  const point = base64.decode(response.publicKey)
  return { point, publicKeySpki: b64u(spkiFromPoint(point)) }
}

/**
 * The enrolment's wrap: a fresh 32-byte KEK, sealed to the Enclave key with Apple's ECIES. The
 * KEK is returned as a tracked secret the caller wraps the DEK under and then zeroes.
 */
export async function wrapFreshKekForEnclave(point: Uint8Array): Promise<{ kek: Uint8Array; ciphertext: string }> {
  const kek = ownSecret(randomBytes(KEK_BYTES))
  try {
    return { kek, ciphertext: b64u(await eciesEncrypt(point, kek)) }
  } catch (error) {
    wipe(kek)
    throw error
  }
}

/**
 * One Touch ID prompt: the Enclave unwraps the envelope's KEK. The reason string names the
 * operation (ED-12). Returns the 32-byte KEK as a tracked secret the caller zeroes.
 */
export async function unwrapKekWithEnclave(
  deps: Pick<Deps, "spawnHelper" | "stderr">,
  session: EnclaveSession,
  envelope: SecureEnclaveEnvelope,
  vaultId: string,
  reason: string,
): Promise<Uint8Array> {
  deps.stderr.write(`Confirm with Touch ID to ${reason}.\n`)
  const point = pointFromSpki(unb64u(envelope.publicKey, "publicKey"), "publicKey")
  const response = await callEnclaveHelper<EnclaveDecryptResponse>(deps, session.path, {
    ...requestCommon(vaultId, envelope.id, "decrypt"),
    keyTag: envelope.keyTag,
    publicKey: base64.encode(point),
    ciphertext: base64.encode(unb64u(envelope.kek.ciphertext, "kek.ciphertext")),
    reason,
  })
  const kek = ownSecret(base64.decode(response.plaintext))
  if (kek.length !== KEK_BYTES) {
    wipe(kek)
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The Secure Enclave returned ${kek.length} bytes for this envelope's key; this factor needs ${KEK_BYTES}. Nothing was derived.`,
      { suggestion: "No other factor was tried." },
    )
  }
  return kek
}

/** Best effort, for a failed enrolment: removes the key so a retry starts from nothing. */
export async function deleteEnclaveKey(
  deps: Pick<Deps, "spawnHelper">,
  session: EnclaveSession,
  opts: { vaultId: string; envelopeId: string },
): Promise<boolean> {
  try {
    const response = await callEnclaveHelper<EnclaveDeleteResponse>(deps, session.path, {
      ...requestCommon(opts.vaultId, opts.envelopeId, "delete"),
      keyTag: keyTagFor(opts.vaultId, opts.envelopeId),
    })
    return response.removed
  } catch {
    return false
  }
}
