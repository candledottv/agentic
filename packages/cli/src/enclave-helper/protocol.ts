/**
 * Ember Phase 2 (BE-141, ED-12, helper protocols): the `candle-enclave` protocol, as one pure
 * module.
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
 * Four operations. `create` makes the Enclave key (P-256, `kSecAttrTokenIDSecureEnclave`, access
 * control `privateKeyUsage` plus `biometryCurrentSet`) under a tag the CLI chose and returns its
 * public key; `decrypt` asks the Enclave to unwrap one ECIES packet with that key, which is the
 * Touch ID prompt, whose reason string is the CLI's and names the operation (ED-12); `delete`
 * removes a key a failed enrolment left behind; `info` reports what this Mac and this helper are.
 */
import { base64 } from "@scure/base"

export const ENCLAVE_PROTOCOL = 1 as const
export const ENCLAVE_HELPER_NAME = "candle-enclave"
export const ENCLAVE_BUNDLE_NAME = "candle-enclave.app"
/** Inside the bundle, the executable the CLI spawns. */
export const ENCLAVE_EXECUTABLE_RELATIVE = "Contents/MacOS/candle-enclave"

export type EnclaveOp = "info" | "create" | "decrypt" | "delete"

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
  "KEY_NOT_FOUND",
  "KEY_EXISTS",
  "CANCELLED",
  "AUTH_FAILED",
  "LOCKED",
  "DECRYPT_FAILED",
  "KEYCHAIN_IO",
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

export type EnclaveRequest = EnclaveInfoRequest | EnclaveCreateRequest | EnclaveDecryptRequest | EnclaveDeleteRequest

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

export type BiometryState = "available" | "unavailable" | "none"

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
  /** Touch ID right now: usable, present but not usable (lid closed, no sensor, locked out), or not enrolled. */
  biometry: BiometryState
  biometryReason?: string
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
  | EnclaveFailureResponse

// ── The backend seam (what the Swift helper does natively; what the scripted helper fakes) ────

export interface EnclaveBackend {
  info(): Promise<Omit<EnclaveInfoResponse, "ok" | "protocol" | "op">>
  /** Creates the key and answers its X9.63 public point. */
  create(keyTag: string, label: string): Promise<Uint8Array>
  /** Unwraps one packet with the key under `keyTag`, after checking its public key is `publicKey`. */
  decrypt(keyTag: string, publicKey: Uint8Array, ciphertext: Uint8Array, reason: string): Promise<Uint8Array>
  delete(keyTag: string): Promise<boolean>
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
  if (op !== "info" && op !== "create" && op !== "decrypt" && op !== "delete") {
    throw new EnclaveError(
      "BAD_REQUEST",
      `unknown op ${JSON.stringify(op)}; this helper knows info, create, decrypt and delete`,
    )
  }
  const common = {
    vaultId: requireString(value, "vaultId"),
    envelopeId: requireString(value, "envelopeId"),
    digest: requireString(value, "digest"),
  }
  base64Bytes(common.digest, "digest", 32)
  if (op === "info") return { op, ...common }
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
