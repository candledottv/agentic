/**
 * Ember Phase 2 (BE-141, ED-12, helper protocols; BE-135 for the passkey operations): the
 * `candle-enclave` protocol, as one pure module.
 *
 * The signed macOS helper (`app/main.swift`, a `.app` bundle built, Developer ID-signed and
 * notarized by the release job) is the only thing that touches the Secure Enclave. It speaks the
 * same shape `candle-fido2` does: newline-delimited JSON over stdin and stdout, never argv, one
 * request line in, one response line out, one operation per process. Every request carries the
 * vault id, the envelope id and a 32-byte operation digest; every response is `{ok: true, ...}` or
 * `{ok: false, code, message}`, and the CLI translates `code` into the spec's error codes and
 * never into a fallback.
 *
 * This module is the contract in TypeScript: the request validation, the response shapes and the
 * helper's typed codes. The Swift helper implements the same contract natively; the scripted
 * helper the tests spawn (`scripted-helper.ts`) runs THIS module over a backend that keeps a P-256
 * key in a file and decrypts with `vault/ecies.ts`, so every test exercises the exact packet and
 * line shapes the compiled helper has. The two implementations are kept in step by the operator
 * gate (T48), which runs the same commands against the real helper.
 *
 * Six operations. `create` makes the Enclave key (P-256, `kSecAttrTokenIDSecureEnclave`, access
 * control `privateKeyUsage` plus `biometryCurrentSet`) under a tag the CLI chose and returns its
 * public key; `decrypt` asks the Enclave to unwrap one ECIES packet with that key, which is the
 * Touch ID prompt, whose reason string is the CLI's and names the operation (ED-12); `delete`
 * removes a key a failed enrolment left behind; `info` reports what this Mac and this helper are.
 * PR G (BE-135, AD-2, CC-03's platform passkey bullet) adds two: `passkey-register` asks the
 * platform authenticator (AuthenticationServices, macOS 15 or later) for a discoverable credential
 * under the RP id with the PRF extension checked for support, and `passkey-assert` makes one
 * user-verified assertion against a stored credential id with the envelope's PRF salt and returns
 * the authenticator data and the PRF output. The helper carries no prompt for either: the system's
 * passkey sheet is the whole UI, and the CLI prints what the sheet is for on stderr beforehand.
 *
 * `info` also reports (BE-135) what the passkey gates need before any ceremony: the OS version,
 * the associated domains in the helper's own entitlements, whether a provisioning profile is
 * embedded, and Touch ID's state as LocalAuthentication actually reported it: the `LAError` code
 * by name and the biometry type, so that "not available from this session" (`systemCancel`,
 * `notInteractive`: SSH, a background agent, the lid closed) is distinct from no sensor, not
 * enrolled, and locked out.
 */
import { base64 } from "@scure/base"

export const ENCLAVE_PROTOCOL = 1 as const
export const ENCLAVE_HELPER_NAME = "candle-enclave"
export const ENCLAVE_BUNDLE_NAME = "candle-enclave.app"
/** Inside the bundle, the executable the CLI spawns. */
export const ENCLAVE_EXECUTABLE_RELATIVE = "Contents/MacOS/candle-enclave"

export type EnclaveOp = "info" | "create" | "decrypt" | "delete" | "passkey-register" | "passkey-assert"

/** The relying party id every platform passkey is registered and asserted under (CC-01, CC-03). */
export const PASSKEY_RP_ID = "cli.candle.tv" as const
/** The associated domain the helper's entitlement must carry for `PASSKEY_RP_ID` (AD-2). */
export const PASSKEY_ASSOCIATED_DOMAIN = `webcredentials:${PASSKEY_RP_ID}` as const
/** The first macOS whose platform authenticator serves the PRF extension (AD-2, CC-12). */
export const PASSKEY_MIN_OS_MAJOR = 15

/** The one access control this release enrols (ED-12 names `biometryCurrentSet` or `userPresence`; `factor add touch-id` is the former). */
export const ENCLAVE_ACCESS_CONTROL = "biometryCurrentSet" as const

/**
 * The helper's own typed codes, deliberately not the vault's `VAULT_*` codes: the helper reports
 * what the Security framework or LocalAuthentication said, and the CLI owns the mapping into the
 * spec's codes (`vault/enclave.ts`), so a helper from another revision cannot name a vault code the
 * CLI would trust.
 */
export const ENCLAVE_CODES = [
  "NO_ENCLAVE",
  "BIOMETRY_UNAVAILABLE",
  /** LocalAuthentication answered `systemCancel` or `notInteractive`: no prompt can be shown from this session (BE-135). */
  "NOT_INTERACTIVE",
  "KEY_NOT_FOUND",
  "KEY_EXISTS",
  "CANCELLED",
  "AUTH_FAILED",
  "LOCKED",
  "DECRYPT_FAILED",
  "KEYCHAIN_IO",
  /** The platform passkey API is not available: macOS 14 or earlier, or a helper built without it (BE-135). */
  "PASSKEY_UNSUPPORTED",
  /** The registration result reported the PRF extension unsupported for this credential (BE-135). */
  "PRF_UNSUPPORTED",
  /** AuthenticationServices refused the RP id: the helper's entitlement or the `apple-app-site-association` did not associate it (BE-135). */
  "DOMAIN_NOT_ASSOCIATED",
  /** No passkey with the requested credential id is available to this Mac or this Apple account (BE-135). */
  "NO_CREDENTIAL",
  "BAD_REQUEST",
  "INTERNAL",
] as const
export type EnclaveCode = (typeof ENCLAVE_CODES)[number]

export class EnclaveError extends Error {
  readonly code: EnclaveCode
  constructor(code: EnclaveCode, message: string) {
    super(message)
    this.name = "EnclaveError"
    this.code = code
  }
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────────

export interface EnclaveRequestCommon {
  op: EnclaveOp
  vaultId: string
  envelopeId: string
  /** 32 bytes, base64: the operation digest the CLI binds this process to. */
  digest: string
}

export interface EnclaveInfoRequest extends EnclaveRequestCommon {
  op: "info"
}

export interface EnclaveCreateRequest extends EnclaveRequestCommon {
  op: "create"
  /** The keychain application tag, unique per envelope; the CLI derives it, the helper stores it. */
  keyTag: string
  /** Display only: the keychain item's label. */
  label: string
  accessControl: typeof ENCLAVE_ACCESS_CONTROL
}

export interface EnclaveDecryptRequest extends EnclaveRequestCommon {
  op: "decrypt"
  keyTag: string
  /** base64, the X9.63 uncompressed point the envelope recorded; the helper refuses a key whose public key differs. */
  publicKey: string
  /** base64, the ECIES packet from the envelope's `kek.ciphertext`. */
  ciphertext: string
  /** The Touch ID prompt's reason string; names the operation (ED-12). */
  reason: string
}

export interface EnclaveDeleteRequest extends EnclaveRequestCommon {
  op: "delete"
  keyTag: string
}

/**
 * One registration ceremony on the platform authenticator (BE-135). The credential is
 * discoverable, user-verified, under `rpId`, with the PRF extension checked for support; the
 * user handle is the CLI's derived per-envelope id so a second envelope does not overwrite the
 * first. `clientDataHash` is the operation digest, so the ceremony is bound to this request.
 */
export interface EnclavePasskeyRegisterRequest extends EnclaveRequestCommon {
  op: "passkey-register"
  rpId: string
  /** base64 */
  userId: string
  userName: string
  /** base64, 32 bytes */
  clientDataHash: string
}

/**
 * One user-verified assertion against a stored credential id with the envelope's raw 32-byte PRF
 * salt (BE-135). The platform applies its own salt derivation (`saltDerivation: "platform"`); the
 * CLI hands the salt over unchanged.
 */
export interface EnclavePasskeyAssertRequest extends EnclaveRequestCommon {
  op: "passkey-assert"
  rpId: string
  /** base64 */
  credentialId: string
  /** base64, 32 bytes */
  clientDataHash: string
  /** base64, 32 bytes */
  prfSalt: string
}

export type EnclaveRequest =
  | EnclaveInfoRequest
  | EnclaveCreateRequest
  | EnclaveDecryptRequest
  | EnclaveDeleteRequest
  | EnclavePasskeyRegisterRequest
  | EnclavePasskeyAssertRequest

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

/**
 * Touch ID right now, as LocalAuthentication's `canEvaluatePolicy` verdict maps (BE-135 widened
 * PR F's three states, which reported an `LAError` -4 from a non-interactive session as
 * "unavailable" with the reason "Authentication canceled"):
 *
 * - `available`: usable now.
 * - `none`: no fingerprint enrolled (`biometryNotEnrolled`).
 * - `locked-out`: too many failed attempts (`biometryLockout`); the Mac's password resets it.
 * - `not-interactive`: `systemCancel` or `notInteractive`: this process cannot show a prompt from
 *   this session (SSH, a background agent, the lid closed without a display). The sensor may well
 *   exist; `biometryType` says whether it does.
 * - `unavailable`: anything else (`biometryNotAvailable` with no sensor, `passcodeNotSet`, an
 *   unlisted code); `biometryType` and `laError` carry the detail.
 */
export type BiometryState = "available" | "unavailable" | "none" | "locked-out" | "not-interactive"

/** `LAContext.biometryType`, valid once `canEvaluatePolicy` has run. */
export type BiometryType = "touchID" | "faceID" | "opticID" | "none"

/** The `LAError` LocalAuthentication answered, by number and by its Swift case name. */
export interface LaErrorReport {
  code: number
  name: string
}

export interface EnclaveInfoResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "info"
  /** The helper's own version (its bundle's CFBundleShortVersionString), which the CLI compares to the envelope's `helper.minVersion`. */
  version: string
  /** What the helper's own code signature says; the CLI checks both against what it pinned. */
  bundleId: string
  teamId: string
  secureEnclave: boolean
  /** Touch ID right now; see `BiometryState`. */
  biometry: BiometryState
  biometryReason?: string
  /** Which sensor this Mac has, whatever the state says about using it now (BE-135). */
  biometryType?: BiometryType
  /** Present when `biometry` is not `available`: the `LAError` behind it, by name (BE-135). */
  laError?: LaErrorReport
  /** `ProcessInfo.operatingSystemVersion` as `major.minor.patch` (BE-135, the macOS 15 gate). */
  osVersion?: string
  /** `com.apple.developer.associated-domains` from the helper's own entitlements (BE-135). */
  associatedDomains?: string[]
  /** Whether `Contents/embedded.provisionprofile` exists in the bundle (BE-135). */
  provisioningProfile?: boolean
}

export interface EnclaveCreateResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "create"
  /** base64, X9.63 uncompressed P-256 point (65 bytes). */
  publicKey: string
}

export interface EnclaveDecryptResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "decrypt"
  /** base64, the unwrapped bytes. */
  plaintext: string
}

export interface EnclaveDeleteResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "delete"
  removed: boolean
}

export interface EnclavePasskeyRegisterResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "passkey-register"
  /** base64 */
  credentialId: string
  /** base64, the CBOR attestation object; the CLI reads the authenticator data and its flags out of it. */
  attestationObject: string
  /** What the registration result said about the PRF extension. False is `VAULT_PRF_UNSUPPORTED` and nothing is written. */
  prfSupported: boolean
}

export interface EnclavePasskeyAssertResponse {
  ok: true
  protocol: typeof ENCLAVE_PROTOCOL
  op: "passkey-assert"
  /** base64, the raw authenticator data; the CLI re-checks the RP id hash and the UV flag before deriving. */
  authenticatorData: string
  /** base64, 32 bytes: the PRF output for the envelope's salt. */
  prfOutput: string
}

export interface EnclaveFailureResponse {
  ok: false
  protocol: typeof ENCLAVE_PROTOCOL
  code: EnclaveCode
  message: string
}

export type EnclaveResponse =
  | EnclaveInfoResponse
  | EnclaveCreateResponse
  | EnclaveDecryptResponse
  | EnclaveDeleteResponse
  | EnclavePasskeyRegisterResponse
  | EnclavePasskeyAssertResponse
  | EnclaveFailureResponse

// ── The backend seam (what the Swift helper does natively; what the scripted helper fakes) ────

export interface EnclaveBackend {
  info(): Promise<Omit<EnclaveInfoResponse, "ok" | "protocol" | "op">>
  /** Creates the key and answers its X9.63 public point. */
  create(keyTag: string, label: string): Promise<Uint8Array>
  /** Unwraps one packet with the key under `keyTag`, after checking its public key is `publicKey`. */
  decrypt(keyTag: string, publicKey: Uint8Array, ciphertext: Uint8Array, reason: string): Promise<Uint8Array>
  delete(keyTag: string): Promise<boolean>
  /** One platform passkey registration (BE-135). */
  passkeyRegister(
    rpId: string,
    userId: Uint8Array,
    userName: string,
    clientDataHash: Uint8Array,
  ): Promise<{ credentialId: Uint8Array; attestationObject: Uint8Array; prfSupported: boolean }>
  /** One platform passkey assertion with the PRF extension (BE-135). */
  passkeyAssert(
    rpId: string,
    credentialId: Uint8Array,
    clientDataHash: Uint8Array,
    prfSalt: Uint8Array,
  ): Promise<{ authenticatorData: Uint8Array; prfOutput: Uint8Array }>
}

// ── Request handling ──────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireString(value: Record<string, unknown>, field: string): string {
  const raw = value[field]
  if (typeof raw !== "string" || raw === "") throw new EnclaveError("BAD_REQUEST", `${field} is missing or empty`)
  return raw
}

function base64Bytes(value: string, field: string, expectedLength?: number): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base64.decode(value)
  } catch {
    throw new EnclaveError("BAD_REQUEST", `${field} is not base64`)
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new EnclaveError("BAD_REQUEST", `${field} is ${bytes.length} bytes, expected ${expectedLength}`)
  }
  return bytes
}

/** Parses one request line. Every refusal is `BAD_REQUEST`, and nothing here touches the Enclave. */
export function parseEnclaveRequest(line: string): EnclaveRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new EnclaveError("BAD_REQUEST", "the request is not JSON")
  }
  if (!isRecord(value)) throw new EnclaveError("BAD_REQUEST", "the request is not a JSON object")
  const op = value.op
  if (
    op !== "info" &&
    op !== "create" &&
    op !== "decrypt" &&
    op !== "delete" &&
    op !== "passkey-register" &&
    op !== "passkey-assert"
  ) {
    throw new EnclaveError(
      "BAD_REQUEST",
      `unknown op ${JSON.stringify(op)}; this helper knows info, create, decrypt, delete, passkey-register and passkey-assert`,
    )
  }
  const common = {
    vaultId: requireString(value, "vaultId"),
    envelopeId: requireString(value, "envelopeId"),
    digest: requireString(value, "digest"),
  }
  base64Bytes(common.digest, "digest", 32)
  if (op === "info") return { op, ...common }
  if (op === "passkey-register" || op === "passkey-assert") {
    const rpId = requireString(value, "rpId")
    if (rpId !== PASSKEY_RP_ID) {
      throw new EnclaveError("BAD_REQUEST", `rpId must be ${PASSKEY_RP_ID}; this helper serves no other relying party`)
    }
    const clientDataHash = requireString(value, "clientDataHash")
    base64Bytes(clientDataHash, "clientDataHash", 32)
    if (op === "passkey-register") {
      const userId = requireString(value, "userId")
      base64Bytes(userId, "userId")
      return { op, ...common, rpId, userId, userName: requireString(value, "userName"), clientDataHash }
    }
    const credentialId = requireString(value, "credentialId")
    base64Bytes(credentialId, "credentialId")
    const prfSalt = requireString(value, "prfSalt")
    base64Bytes(prfSalt, "prfSalt", 32)
    return { op, ...common, rpId, credentialId, clientDataHash, prfSalt }
  }
  const keyTag = requireString(value, "keyTag")
  if (op === "delete") return { op, ...common, keyTag }
  if (op === "create") {
    if (value.accessControl !== ENCLAVE_ACCESS_CONTROL) {
      throw new EnclaveError(
        "BAD_REQUEST",
        `accessControl must be ${ENCLAVE_ACCESS_CONTROL}; this helper enrols no other access control`,
      )
    }
    return { op, ...common, keyTag, label: requireString(value, "label"), accessControl: ENCLAVE_ACCESS_CONTROL }
  }
  const publicKey = requireString(value, "publicKey")
  base64Bytes(publicKey, "publicKey", 65)
  const ciphertext = requireString(value, "ciphertext")
  base64Bytes(ciphertext, "ciphertext")
  return { op, ...common, keyTag, publicKey, ciphertext, reason: requireString(value, "reason") }
}

function asEnclaveError(error: unknown): EnclaveError {
  if (error instanceof EnclaveError) return error
  return new EnclaveError("INTERNAL", error instanceof Error ? error.message : String(error))
}

/** Runs one request against one backend and answers with the one response line's value. */
export async function handleEnclaveRequest(request: EnclaveRequest, backend: EnclaveBackend): Promise<EnclaveResponse> {
  try {
    switch (request.op) {
      case "info":
        return { ok: true, protocol: ENCLAVE_PROTOCOL, op: "info", ...(await backend.info()) }
      case "create": {
        const point = await backend.create(request.keyTag, request.label)
        if (point.length !== 65 || point[0] !== 0x04) {
          throw new EnclaveError(
            "INTERNAL",
            `the created key's public key is ${point.length} bytes, not an uncompressed point`,
          )
        }
        return { ok: true, protocol: ENCLAVE_PROTOCOL, op: "create", publicKey: base64.encode(point) }
      }
      case "decrypt": {
        const plaintext = await backend.decrypt(
          request.keyTag,
          base64Bytes(request.publicKey, "publicKey", 65),
          base64Bytes(request.ciphertext, "ciphertext"),
          request.reason,
        )
        return { ok: true, protocol: ENCLAVE_PROTOCOL, op: "decrypt", plaintext: base64.encode(plaintext) }
      }
      case "delete":
        return { ok: true, protocol: ENCLAVE_PROTOCOL, op: "delete", removed: await backend.delete(request.keyTag) }
      case "passkey-register": {
        const registered = await backend.passkeyRegister(
          request.rpId,
          base64Bytes(request.userId, "userId"),
          request.userName,
          base64Bytes(request.clientDataHash, "clientDataHash", 32),
        )
        return {
          ok: true,
          protocol: ENCLAVE_PROTOCOL,
          op: "passkey-register",
          credentialId: base64.encode(registered.credentialId),
          attestationObject: base64.encode(registered.attestationObject),
          prfSupported: registered.prfSupported,
        }
      }
      case "passkey-assert": {
        const asserted = await backend.passkeyAssert(
          request.rpId,
          base64Bytes(request.credentialId, "credentialId"),
          base64Bytes(request.clientDataHash, "clientDataHash", 32),
          base64Bytes(request.prfSalt, "prfSalt", 32),
        )
        if (asserted.prfOutput.length !== 32) {
          throw new EnclaveError("INTERNAL", `the PRF output is ${asserted.prfOutput.length} bytes, expected 32`)
        }
        return {
          ok: true,
          protocol: ENCLAVE_PROTOCOL,
          op: "passkey-assert",
          authenticatorData: base64.encode(asserted.authenticatorData),
          prfOutput: base64.encode(asserted.prfOutput),
        }
      }
    }
  } catch (error) {
    const failure = asEnclaveError(error)
    return { ok: false, protocol: ENCLAVE_PROTOCOL, code: failure.code, message: failure.message }
  }
}

/** One request line to one response line: parse, then load the backend, then handle. Never throws. */
export async function handleEnclaveLine(line: string, backend: () => EnclaveBackend): Promise<EnclaveResponse> {
  let request: EnclaveRequest
  try {
    request = parseEnclaveRequest(line)
  } catch (error) {
    const failure = asEnclaveError(error)
    return { ok: false, protocol: ENCLAVE_PROTOCOL, code: failure.code, message: failure.message }
  }
  let resolved: EnclaveBackend
  try {
    resolved = backend()
  } catch (error) {
    const failure = asEnclaveError(error)
    return { ok: false, protocol: ENCLAVE_PROTOCOL, code: failure.code, message: failure.message }
  }
  return handleEnclaveRequest(request, resolved)
}
