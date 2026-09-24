/**
 * Ember Phase 2 (BE-140, ED-11, helper protocols): the `candle-fido2` protocol, as one pure module.
 *
 * The helper is the only thing in the CLI that touches an authenticator. It speaks newline-delimited
 * JSON over stdin and stdout, never argv: exactly one request object on one line in, exactly one
 * response object on one line out, one operation per process, and the process exits after it.
 * Every request carries the vault id, the envelope id and a 32-byte operation digest; every
 * response is `{ok: true, ...}` or `{ok: false, code, message}`, and the CLI translates `code` into
 * the spec's error codes and never into a fallback.
 *
 * This module holds the shape of that contract and the decisions that do not need hardware: request
 * validation, the device locator, the snapshot digest, the feature checks ED-11 makes before a
 * registration, and the translation of what the backend reports into the helper's typed codes.
 * `libfido2.ts` is the one backend (`bun:ffi` over libfido2), and the tests drive this module with
 * a scripted one, so every row of the translation table is exercised without a key plugged in.
 *
 * Two identities, and only one of them is stored (helper protocols, "the credential is the
 * identity; the device id is only this run's locator"). `deviceId` is derived from what the helper
 * can see now, the AAGUID together with the enumeration path, and is valid within one enumeration
 * only; it is never written to the vault. The credential id in the envelope is the durable identity,
 * and asserting it against a named device is what proves that device holds the credential.
 */
import { sha256 } from "@noble/hashes/sha256"
import { base64, base64urlnopad, hex } from "@scure/base"

export const HELPER_PROTOCOL = 1 as const

/** The RP id every Candle security-key credential lives under (ED-11). Fixed, never configurable. */
export const RP_ID = "cli.candle.tv"
export const RP_NAME = "Candle CLI"

export type HelperOp = "info" | "register" | "assert" | "probe"

/**
 * BE-294 (D2): the most credentials one `probe` may name. A vault offers one CTAP2 envelope per
 * enrolled key, so this is far above any real vault and keeps one silent pre-flight bounded.
 */
export const PROBE_MAX_CREDENTIALS = 16

/**
 * BE-337 (D3): the additive capabilities an `info` response lists under `features`, so a CLI that
 * needs one can tell a helper that has it from an older helper that would silently drop the field
 * (the request parser ignores fields it does not know). `HELPER_PROTOCOL` stays 1: every change
 * this list names is additive on both sides.
 */
export const HELPER_FEATURES = ["exclude-list"] as const
export type HelperFeature = (typeof HELPER_FEATURES)[number]

/**
 * The helper's own typed codes. They are deliberately not the vault's `VAULT_*` codes: the helper
 * reports what the authenticator or the library said, and the CLI owns the mapping into the spec's
 * codes (`vault/fido2.ts`), so a helper built from a different revision cannot smuggle a fallback
 * in by naming a vault code the CLI would trust.
 */
export const HELPER_CODES = [
  "NO_DEVICE",
  "DEVICE_NOT_READABLE",
  "DEVICE_NOT_FOUND",
  "SNAPSHOT_CHANGED",
  "PRF_UNSUPPORTED",
  "UV_UNSUPPORTED",
  "PIN_REQUIRED",
  "PIN_INVALID",
  "BLOCKED",
  "CANCELLED",
  "NO_CREDENTIAL",
  "DEVICE_IO",
  "LIBRARY_MISSING",
  // BE-337 (D3, refusal 3): the authenticator holds a credential the register's exclude list named
  // and created nothing (`CTAP2_ERR_CREDENTIAL_EXCLUDED`). The CLI maps it to
  // `VAULT_KEY_ALREADY_ENROLLED`; an older CLI reads it as `VAULT_UNLOCK_FAILED`, also a refusal.
  "CREDENTIAL_EXCLUDED",
  "BAD_REQUEST",
  "INTERNAL",
] as const
export type HelperCode = (typeof HELPER_CODES)[number]

export class HelperError extends Error {
  readonly code: HelperCode
  constructor(code: HelperCode, message: string) {
    super(message)
    this.name = "HelperError"
    this.code = code
  }
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────────

export interface RequestCommon {
  op: HelperOp
  vaultId: string
  envelopeId: string
  /** 32 bytes, base64: the operation digest the CLI binds this process to. */
  digest: string
}

export interface InfoRequest extends RequestCommon {
  op: "info"
}

export interface RegisterRequest extends RequestCommon {
  op: "register"
  deviceId: string
  expectSnapshot?: string
  rpId: string
  /** base64 */
  userId: string
  userName: string
  /** base64, 32 bytes */
  clientDataHash: string
  pin?: string
  /**
   * BE-337 (D3, refusal 3): credential ids (base64) the authenticator must refuse to create a
   * second credential beside, at most `PROBE_MAX_CREDENTIALS`. Every id is handed to the device as
   * an excluded credential before it is asked to register; a device that holds one answers
   * `CREDENTIAL_EXCLUDED` and creates nothing. Optional, so an older CLI's request is unchanged.
   */
  excludeCredentialIds?: string[]
}

export interface AssertRequest extends RequestCommon {
  op: "assert"
  deviceId: string
  expectSnapshot?: string
  rpId: string
  /** base64 */
  credentialId: string
  /** base64, 32 bytes */
  clientDataHash: string
  /** base64, 32 bytes: already the ED-11 derivation of the envelope's prfSalt. */
  salt: string
  pin?: string
}

/**
 * BE-294 (D2): which attached keys hold which of the offered credentials, asked silently. There is
 * no PIN field and no salt field, and the parser refuses both: a probe asserts with user presence
 * clear, no user verification and no extension, so no secret is derived and none can be asked for.
 */
export interface ProbeRequest extends RequestCommon {
  op: "probe"
  rpId: string
  /** base64, one per offered CTAP2 envelope, at most `PROBE_MAX_CREDENTIALS`. */
  credentialIds: string[]
  /** Probe only this device (the operator's `--device`). */
  deviceId?: string
  expectSnapshot?: string
}

export type HelperRequest = InfoRequest | RegisterRequest | AssertRequest | ProbeRequest

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

export interface DeviceReport {
  deviceId: string
  path: string
  product: string
  manufacturer: string
  /** hex, 16 bytes; empty when the device could not be opened. */
  aaguid: string
  extensions: string[]
  /** CTAP2 getInfo options. `null` means the authenticator did not list the option at all. */
  options: { clientPin: boolean | null; uv: boolean | null }
  /** False when the device enumerated but this user cannot open it (the Linux `hidraw` case). */
  readable: boolean
  reason?: string
  /**
   * BE-337 (D3): CTAP2 getInfo's `maxCredentialCountInList`, the most credentials one request may
   * name in an allow or exclude list. `null` when the authenticator does not report one (or could
   * not be opened), and then one register request carries at most one excluded id.
   */
  maxCredentialCountInList: number | null
}

export interface InfoResponse {
  ok: true
  protocol: typeof HELPER_PROTOCOL
  op: "info"
  snapshotId: string
  devices: DeviceReport[]
  /** BE-337 (D3): what this helper can do beyond protocol 1's baseline. */
  features: HelperFeature[]
}

export interface RegisterResponse {
  ok: true
  protocol: typeof HELPER_PROTOCOL
  op: "register"
  /** base64 */
  credentialId: string
  /** hex */
  aaguid: string
  /** base64, the raw authenticator data (not CBOR-wrapped). */
  authData: string
  attFlags: { be: boolean; bs: boolean }
  flags: { uv: boolean; up: boolean }
  /**
   * BE-337 (D3): how many excluded credential ids reached the authenticator. The CLI compares it
   * with the count it sent, so a helper that dropped the list cannot look like one that applied it.
   */
  excluded: number
}

export interface AssertResponse {
  ok: true
  protocol: typeof HELPER_PROTOCOL
  op: "assert"
  /** base64, 32 bytes */
  hmacSecret: string
  /** base64, the raw authenticator data (not CBOR-wrapped). */
  authData: string
  flags: { uv: boolean; up: boolean }
}

/** One device's answer to a probe. The authenticator data and signature never cross the pipe. */
export interface ProbeDeviceReport {
  deviceId: string
  readable: boolean
  /** Credential ids (base64, as requested) this device answered with an assertion. */
  present: string[]
  /** Credential ids this device answered with an error other than "no credentials". */
  unknown: string[]
}

export interface ProbeResponse {
  ok: true
  protocol: typeof HELPER_PROTOCOL
  op: "probe"
  snapshotId: string
  devices: ProbeDeviceReport[]
}

export interface FailureResponse {
  ok: false
  protocol: typeof HELPER_PROTOCOL
  code: HelperCode
  message: string
}

export type HelperResponse = InfoResponse | RegisterResponse | AssertResponse | ProbeResponse | FailureResponse

// ── The backend seam ──────────────────────────────────────────────────────────────────────────

export interface EnumeratedDevice {
  path: string
  product: string
  manufacturer: string
}

export interface DeviceCapabilities {
  aaguid: Uint8Array
  extensions: string[]
  /** Every option getInfo listed, by name. */
  options: Record<string, boolean>
  /** BE-337 (D3): getInfo's `maxCredentialCountInList`; absent when the device reports none. */
  maxCredentialCountInList?: number
}

export interface MakeCredentialParams {
  rpId: string
  rpName: string
  userId: Uint8Array
  userName: string
  clientDataHash: Uint8Array
  pin?: string
  /** BE-337 (D3): every id is excluded (`fido_cred_exclude`) before the device is asked. */
  excludeCredentialIds?: Uint8Array[]
}

export interface MakeCredentialResult {
  credentialId: Uint8Array
  aaguid: Uint8Array
  /** Raw authenticator data. */
  authData: Uint8Array
}

export interface GetAssertionParams {
  rpId: string
  credentialId: Uint8Array
  clientDataHash: Uint8Array
  salt: Uint8Array
  pin?: string
}

/** BE-294 (D2): a silent assertion's inputs. No PIN, no salt, no extension. */
export interface ProbeCredentialParams {
  rpId: string
  credentialId: Uint8Array
  clientDataHash: Uint8Array
}

/** `present`: the key answered with an assertion; `absent`: no credentials; `unknown`: anything else. */
export type ProbeOutcome = "present" | "absent" | "unknown"

export interface GetAssertionResult {
  hmacSecret: Uint8Array
  /** Raw authenticator data. */
  authData: Uint8Array
}

/**
 * What a backend has to do, and all it has to do. Every method may throw `HelperError`; anything
 * else it throws is reported as `INTERNAL`. `describe` opens the device and reads getInfo, and is
 * where the Linux `hidraw` permission failure surfaces as `DEVICE_NOT_READABLE`.
 */
export interface Fido2Backend {
  enumerate(): EnumeratedDevice[]
  describe(path: string): DeviceCapabilities
  makeCredential(path: string, params: MakeCredentialParams): MakeCredentialResult
  getAssertion(path: string, params: GetAssertionParams): GetAssertionResult
  /**
   * BE-294 (D2): one `getAssertion` with `up` false, `uv` omitted, no PIN and no extensions, kept
   * apart from `getAssertion` so that shape cannot drift. Answers whether the device holds the
   * credential and nothing else.
   */
  probeCredential(path: string, params: ProbeCredentialParams): ProbeOutcome
}

// ── Authenticator data flags (WebAuthn section 6.1) ───────────────────────────────────────────

export const AUTHDATA_FLAG_UP = 0x01
export const AUTHDATA_FLAG_UV = 0x04
export const AUTHDATA_FLAG_BE = 0x08
export const AUTHDATA_FLAG_BS = 0x10
/** rpIdHash (32) + flags (1) + signCount (4). */
export const AUTHDATA_MIN_LENGTH = 37

/** The flags byte of raw authenticator data, or -1 when the data is too short to carry one. */
export function authDataFlags(authData: Uint8Array): number {
  return authData.length >= AUTHDATA_MIN_LENGTH ? (authData[32] ?? -1) : -1
}

/**
 * libfido2 hands back authenticator data CBOR-encoded (one byte string). The CLI re-checks the
 * flags byte at a fixed offset, so the helper strips that one CBOR header here rather than making
 * the CLI understand CBOR. Anything that is not a single definite-length byte string is refused.
 */
export function unwrapCborByteString(bytes: Uint8Array): Uint8Array {
  const first = bytes[0]
  if (first === undefined || first >> 5 !== 2) {
    throw new HelperError("INTERNAL", "authenticator data is not a CBOR byte string")
  }
  const info = first & 0x1f
  let length: number
  let offset: number
  if (info < 24) {
    length = info
    offset = 1
  } else if (info === 24) {
    length = bytes[1] ?? -1
    offset = 2
  } else if (info === 25) {
    length = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)
    offset = 3
  } else if (info === 26) {
    length = ((bytes[1] ?? 0) << 24) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0)
    offset = 5
  } else {
    throw new HelperError("INTERNAL", "authenticator data has an unsupported CBOR length")
  }
  if (length < 0 || offset + length !== bytes.length) {
    throw new HelperError("INTERNAL", "authenticator data CBOR length disagrees with the payload")
  }
  return bytes.slice(offset, offset + length)
}

// ── Locators ──────────────────────────────────────────────────────────────────────────────────

/**
 * This run's locator for one device: the AAGUID (a model, not an individual) together with the
 * enumeration path, hashed so the id is short enough to type after `--device`. It is valid within
 * one enumeration and is never stored: a path can be recycled by another key on this machine or
 * differ on another, and an AAGUID is shared by every key of a model.
 */
export function deviceIdFor(device: { path: string; aaguid: string }): string {
  const digest = sha256(new TextEncoder().encode(`candle-fido2/device|${device.aaguid}|${device.path}`))
  return base64urlnopad.encode(digest.slice(0, 6))
}

/** The digest of the enumerated set, which `register` and `assert` compare against `expectSnapshot`. */
export function snapshotIdFor(devices: Array<{ deviceId: string }>): string {
  const ids = devices.map((device) => device.deviceId).sort()
  return base64urlnopad.encode(sha256(new TextEncoder().encode(ids.join("\n"))))
}

// ── Feature detection (ED-11, CC-03) ──────────────────────────────────────────────────────────

export function supportsHmacSecret(device: Pick<DeviceReport, "extensions">): boolean {
  return device.extensions.includes("hmac-secret")
}

/** A PIN is set, or a built-in user-verification method is enrolled. Anything else is refused. */
export function supportsUserVerification(device: Pick<DeviceReport, "options">): boolean {
  return device.options.clientPin === true || device.options.uv === true
}

// ── Request handling ──────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireString(value: Record<string, unknown>, field: string): string {
  const raw = value[field]
  if (typeof raw !== "string" || raw === "") throw new HelperError("BAD_REQUEST", `${field} is missing or empty`)
  return raw
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field]
  if (raw === undefined) return undefined
  if (typeof raw !== "string") throw new HelperError("BAD_REQUEST", `${field} is not a string`)
  return raw
}

function base64Bytes(value: string, field: string, expectedLength?: number): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base64.decode(value)
  } catch {
    throw new HelperError("BAD_REQUEST", `${field} is not base64`)
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new HelperError("BAD_REQUEST", `${field} is ${bytes.length} bytes, expected ${expectedLength}`)
  }
  return bytes
}

/** Parses one request line. Every refusal is `BAD_REQUEST`, and nothing here touches a device. */
export function parseRequest(line: string): HelperRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new HelperError("BAD_REQUEST", "the request is not JSON")
  }
  if (!isRecord(value)) throw new HelperError("BAD_REQUEST", "the request is not a JSON object")
  const op = value.op
  if (op !== "info" && op !== "register" && op !== "assert" && op !== "probe") {
    throw new HelperError(
      "BAD_REQUEST",
      `unknown op ${JSON.stringify(op)}; this helper knows info, register, assert and probe`,
    )
  }
  const common = {
    vaultId: requireString(value, "vaultId"),
    envelopeId: requireString(value, "envelopeId"),
    digest: requireString(value, "digest"),
  }
  base64Bytes(common.digest, "digest", 32)
  if (op === "info") return { op, ...common }
  if (op === "probe") return parseProbe(value, common)
  const deviceId = requireString(value, "deviceId")
  const expectSnapshot = optionalString(value, "expectSnapshot")
  const rpId = requireString(value, "rpId")
  const clientDataHash = requireString(value, "clientDataHash")
  base64Bytes(clientDataHash, "clientDataHash", 32)
  const pin = optionalString(value, "pin")
  if (op === "register") {
    const userId = requireString(value, "userId")
    base64Bytes(userId, "userId")
    const excludeCredentialIds = parseExcludeList(value)
    return {
      op,
      ...common,
      deviceId,
      ...(expectSnapshot !== undefined ? { expectSnapshot } : {}),
      rpId,
      userId,
      userName: requireString(value, "userName"),
      clientDataHash,
      ...(pin !== undefined ? { pin } : {}),
      ...(excludeCredentialIds !== undefined ? { excludeCredentialIds } : {}),
    }
  }
  const credentialId = requireString(value, "credentialId")
  base64Bytes(credentialId, "credentialId")
  const salt = requireString(value, "salt")
  base64Bytes(salt, "salt", 32)
  return {
    op,
    ...common,
    deviceId,
    ...(expectSnapshot !== undefined ? { expectSnapshot } : {}),
    rpId,
    credentialId,
    clientDataHash,
    salt,
    ...(pin !== undefined ? { pin } : {}),
  }
}

/**
 * BE-337 (D3): a register's exclude list, when the request carries one. Above
 * `PROBE_MAX_CREDENTIALS` it is refused, never truncated: a truncated list would only be caught by
 * the CLI's `excluded` count and reported under the wrong code.
 */
function parseExcludeList(value: Record<string, unknown>): string[] | undefined {
  const raw = value.excludeCredentialIds
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new HelperError("BAD_REQUEST", "excludeCredentialIds is not a list")
  if (raw.length > PROBE_MAX_CREDENTIALS) {
    throw new HelperError(
      "BAD_REQUEST",
      `excludeCredentialIds names ${raw.length} credentials; a register excludes at most ${PROBE_MAX_CREDENTIALS}`,
    )
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      throw new HelperError("BAD_REQUEST", `excludeCredentialIds[${index}] is not a non-empty string`)
    }
    base64Bytes(entry, `excludeCredentialIds[${index}]`)
    return entry
  })
}

/** BE-294 (D2): the probe's own fields. A PIN or a salt is refused, whatever its value. */
function parseProbe(
  value: Record<string, unknown>,
  common: Pick<RequestCommon, "vaultId" | "envelopeId" | "digest">,
): ProbeRequest {
  for (const field of ["pin", "salt"]) {
    if (field in value) throw new HelperError("BAD_REQUEST", `a probe carries no ${field}`)
  }
  const rpId = requireString(value, "rpId")
  const raw = value.credentialIds
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HelperError("BAD_REQUEST", "credentialIds is missing or empty")
  }
  if (raw.length > PROBE_MAX_CREDENTIALS) {
    throw new HelperError(
      "BAD_REQUEST",
      `credentialIds names ${raw.length} credentials; a probe names at most ${PROBE_MAX_CREDENTIALS}`,
    )
  }
  const credentialIds = raw.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      throw new HelperError("BAD_REQUEST", `credentialIds[${index}] is not a non-empty string`)
    }
    base64Bytes(entry, `credentialIds[${index}]`)
    return entry
  })
  const deviceId = optionalString(value, "deviceId")
  const expectSnapshot = optionalString(value, "expectSnapshot")
  return {
    op: "probe",
    ...common,
    rpId,
    credentialIds,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(expectSnapshot !== undefined ? { expectSnapshot } : {}),
  }
}

/** Enumerates and describes every device, reporting the ones this user cannot open as unreadable. */
function reportDevices(backend: Fido2Backend): DeviceReport[] {
  return backend.enumerate().map((device) => {
    try {
      const capabilities = backend.describe(device.path)
      const aaguid = hex.encode(capabilities.aaguid)
      return {
        deviceId: deviceIdFor({ path: device.path, aaguid }),
        path: device.path,
        product: device.product,
        manufacturer: device.manufacturer,
        aaguid,
        extensions: [...capabilities.extensions],
        options: {
          clientPin: capabilities.options.clientPin ?? null,
          uv: capabilities.options.uv ?? null,
        },
        readable: true,
        maxCredentialCountInList: capabilities.maxCredentialCountInList ?? null,
      }
    } catch (error) {
      const failure = asHelperError(error)
      return {
        deviceId: deviceIdFor({ path: device.path, aaguid: "" }),
        path: device.path,
        product: device.product,
        manufacturer: device.manufacturer,
        aaguid: "",
        extensions: [],
        options: { clientPin: null, uv: null },
        readable: false,
        reason: `${failure.code}: ${failure.message}`,
        maxCredentialCountInList: null,
      }
    }
  })
}

function asHelperError(error: unknown): HelperError {
  if (error instanceof HelperError) return error
  return new HelperError("INTERNAL", error instanceof Error ? error.message : String(error))
}

/**
 * Re-enumerates in THIS process (the snapshot guarantee is per process, and the spec says so),
 * compares against `expectSnapshot`, and finds the named device. Selection is by locator only;
 * nothing here looks at a credential.
 */
function selectDevice(backend: Fido2Backend, request: RegisterRequest | AssertRequest): DeviceReport {
  const devices = reportDevices(backend)
  // The snapshot first: a key unplugged between the listing and this process is "the set changed",
  // which is what the operator needs to hear, not "no key", which reads as never having had one.
  const snapshotId = snapshotIdFor(devices)
  if (request.expectSnapshot !== undefined && request.expectSnapshot !== snapshotId) {
    throw new HelperError(
      "SNAPSHOT_CHANGED",
      "the set of attached security keys changed since it was listed; nothing was sent to any key",
    )
  }
  if (devices.length === 0) throw new HelperError("NO_DEVICE", "no security key is attached")
  const device = devices.find((candidate) => candidate.deviceId === request.deviceId)
  if (!device) {
    throw new HelperError(
      "DEVICE_NOT_FOUND",
      `no attached security key has the id ${request.deviceId} in this enumeration; nothing was sent to any key`,
    )
  }
  if (!device.readable) {
    throw new HelperError("DEVICE_NOT_READABLE", device.reason ?? "this user cannot open the device")
  }
  return device
}

/**
 * BE-337 (D3): how many excluded credential ids one register request may carry to this device:
 * its `maxCredentialCountInList`, or 1 when it reports none (the platform convention). Exported so
 * the CLI refuses earlier, naming both counts, before any PIN is typed.
 */
export function excludeCapacity(device: Pick<DeviceReport, "maxCredentialCountInList">): number {
  return device.maxCredentialCountInList ?? 1
}

/** Runs one request against one backend and answers with the one response line's value. */
export function handleRequest(request: HelperRequest, backend: Fido2Backend): HelperResponse {
  try {
    switch (request.op) {
      case "info": {
        const devices = reportDevices(backend)
        return {
          ok: true,
          protocol: HELPER_PROTOCOL,
          op: "info",
          snapshotId: snapshotIdFor(devices),
          devices,
          features: [...HELPER_FEATURES],
        }
      }
      case "register": {
        const device = selectDevice(backend, request)
        // ED-11's two refusals, made before the authenticator is asked to do anything, so a key
        // that cannot serve this factor never gains a stray credential.
        if (!supportsHmacSecret(device)) {
          throw new HelperError(
            "PRF_UNSUPPORTED",
            `${device.product || "this security key"} does not support the hmac-secret extension`,
          )
        }
        if (!supportsUserVerification(device)) {
          throw new HelperError(
            "UV_UNSUPPORTED",
            `${device.product || "this security key"} has no PIN set and no built-in user verification; set a PIN on this key and retry`,
          )
        }
        // BE-337 (D3): the exclude list is checked against what the device can take BEFORE the
        // device is asked, and is never split across requests. A device that reports no
        // `maxCredentialCountInList` takes one id.
        const exclude = (request.excludeCredentialIds ?? []).map((id, index) =>
          base64Bytes(id, `excludeCredentialIds[${index}]`),
        )
        const capacity = excludeCapacity(device)
        if (exclude.length > capacity) {
          throw new HelperError(
            "BAD_REQUEST",
            `excludeCredentialIds names ${exclude.length} credentials, and ${device.product || "this security key"} takes at most ${capacity} in one request${device.maxCredentialCountInList === null ? " (it reports no maxCredentialCountInList)" : ""}; nothing was sent to it`,
          )
        }
        const result = backend.makeCredential(device.path, {
          rpId: request.rpId,
          rpName: RP_NAME,
          userId: base64Bytes(request.userId, "userId"),
          userName: request.userName,
          clientDataHash: base64Bytes(request.clientDataHash, "clientDataHash", 32),
          ...(request.pin !== undefined ? { pin: request.pin } : {}),
          ...(exclude.length > 0 ? { excludeCredentialIds: exclude } : {}),
        })
        const flags = authDataFlags(result.authData)
        if (flags < 0) throw new HelperError("INTERNAL", "the authenticator returned truncated authenticator data")
        return {
          ok: true,
          protocol: HELPER_PROTOCOL,
          op: "register",
          credentialId: base64.encode(result.credentialId),
          aaguid: hex.encode(result.aaguid),
          authData: base64.encode(result.authData),
          attFlags: { be: (flags & AUTHDATA_FLAG_BE) !== 0, bs: (flags & AUTHDATA_FLAG_BS) !== 0 },
          flags: { uv: (flags & AUTHDATA_FLAG_UV) !== 0, up: (flags & AUTHDATA_FLAG_UP) !== 0 },
          excluded: exclude.length,
        }
      }
      case "probe":
        return probe(backend, request)
      case "assert": {
        const device = selectDevice(backend, request)
        const result = backend.getAssertion(device.path, {
          rpId: request.rpId,
          credentialId: base64Bytes(request.credentialId, "credentialId"),
          clientDataHash: base64Bytes(request.clientDataHash, "clientDataHash", 32),
          salt: base64Bytes(request.salt, "salt", 32),
          ...(request.pin !== undefined ? { pin: request.pin } : {}),
        })
        const flags = authDataFlags(result.authData)
        if (flags < 0) throw new HelperError("INTERNAL", "the authenticator returned truncated authenticator data")
        if (result.hmacSecret.length === 0) {
          throw new HelperError(
            "PRF_UNSUPPORTED",
            "the authenticator returned no hmac-secret output for this credential",
          )
        }
        return {
          ok: true,
          protocol: HELPER_PROTOCOL,
          op: "assert",
          hmacSecret: base64.encode(result.hmacSecret),
          authData: base64.encode(result.authData),
          flags: { uv: (flags & AUTHDATA_FLAG_UV) !== 0, up: (flags & AUTHDATA_FLAG_UP) !== 0 },
        }
      }
    }
  } catch (error) {
    const failure = asHelperError(error)
    return { ok: false, protocol: HELPER_PROTOCOL, code: failure.code, message: failure.message }
  }
}

/**
 * BE-294 (D2): one silent assertion per readable device and offered credential. Every per-credential
 * failure is folded into `unknown` rather than failing the op, because a probe only decides a marker
 * on a menu row. An unreadable device is reported as such, with nothing asked of it.
 */
function probe(backend: Fido2Backend, request: ProbeRequest): ProbeResponse {
  const all = reportDevices(backend)
  const snapshotId = snapshotIdFor(all)
  if (request.expectSnapshot !== undefined && request.expectSnapshot !== snapshotId) {
    throw new HelperError(
      "SNAPSHOT_CHANGED",
      "the set of attached security keys changed since it was listed; nothing was sent to any key",
    )
  }
  const devices = request.deviceId === undefined ? all : all.filter((device) => device.deviceId === request.deviceId)
  const clientDataHash = base64Bytes(request.digest, "digest", 32)
  return {
    ok: true,
    protocol: HELPER_PROTOCOL,
    op: "probe",
    snapshotId,
    devices: devices.map((device) => {
      const report: ProbeDeviceReport = {
        deviceId: device.deviceId,
        readable: device.readable,
        present: [],
        unknown: [],
      }
      if (!device.readable) return report
      for (const credentialId of request.credentialIds) {
        let outcome: ProbeOutcome
        try {
          outcome = backend.probeCredential(device.path, {
            rpId: request.rpId,
            credentialId: base64Bytes(credentialId, "credentialId"),
            clientDataHash,
          })
        } catch {
          outcome = "unknown"
        }
        if (outcome === "present") report.present.push(credentialId)
        else if (outcome === "unknown") report.unknown.push(credentialId)
      }
      return report
    }),
  }
}

/** One request line to one response line: parse, then load the backend, then handle. Never throws. */
export function handleLine(line: string, backend: () => Fido2Backend): HelperResponse {
  let request: HelperRequest
  try {
    request = parseRequest(line)
  } catch (error) {
    const failure = asHelperError(error)
    return { ok: false, protocol: HELPER_PROTOCOL, code: failure.code, message: failure.message }
  }
  let resolved: Fido2Backend
  try {
    resolved = backend()
  } catch (error) {
    const failure = asHelperError(error)
    return { ok: false, protocol: HELPER_PROTOCOL, code: failure.code, message: failure.message }
  }
  return handleRequest(request, resolved)
}
