/**
 * Ember Phase 2 (BE-140, ED-11, CC-12): the libfido2 backend of `candle-fido2`, over `bun:ffi`.
 *
 * Why FFI rather than a C helper: the release job compiles the four `candle` binaries with
 * `bun build --compile --target=bun-<os>-<arch>` from one Ubuntu runner (E18, E24), and a helper
 * built the same way lands in that same job, signed by the same cosign step, one executable per
 * release target. A C helper linking libfido2 would need a cross toolchain per target and a build
 * matrix, which is a different job and a different signing story. This backend links libfido2
 * dynamically at run time instead: Homebrew's `libfido2` on macOS, the distribution's `libfido2`
 * package on Linux. A machine without the library is a typed `LIBRARY_MISSING` naming the install
 * command, which the CLI reports as `VAULT_HELPER_MISSING`, never as a fallback to another factor.
 *
 * What this file does with the library is exactly ED-11: registration is a discoverable credential
 * with `hmac-secret` and user verification required; every assertion carries the CLI's already
 * derived salt and user verification required; the PIN the CLI collected is passed straight to
 * libfido2 and nowhere else. Nothing here prompts, reads a terminal, or picks a device: the device
 * path it is given is the one the CLI named after the operator did.
 */

import { CString, dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi"
import { accessSync, constants } from "node:fs"
import { libraryCandidates, libraryMissingMessage } from "./library-paths"
import {
  type DeviceCapabilities,
  type EnumeratedDevice,
  type Fido2Backend,
  type GetAssertionParams,
  type GetAssertionResult,
  HelperError,
  type MakeCredentialParams,
  type MakeCredentialResult,
  type ProbeCredentialParams,
  type ProbeOutcome,
  unwrapCborByteString,
} from "./protocol"

// ── libfido2 constants (fido/err.h, fido/param.h, fido/types.h) ───────────────────────────────

const FIDO_OK = 0
const COSE_ES256 = -7
const FIDO_EXT_HMAC_SECRET = 0x01
const FIDO_OPT_FALSE = 1
const FIDO_OPT_TRUE = 2

/** The CTAP2 status codes and libfido2's own negative codes that this helper translates. */
const FIDO_ERR = {
  TIMEOUT: 0x05,
  UNSUPPORTED_EXTENSION: 0x16,
  CREDENTIAL_EXCLUDED: 0x19,
  INVALID_CREDENTIAL: 0x22,
  UNSUPPORTED_ALGORITHM: 0x26,
  OPERATION_DENIED: 0x27,
  KEY_STORE_FULL: 0x28,
  UNSUPPORTED_OPTION: 0x2b,
  INVALID_OPTION: 0x2c,
  KEEPALIVE_CANCEL: 0x2d,
  NO_CREDENTIALS: 0x2e,
  USER_ACTION_TIMEOUT: 0x2f,
  NOT_ALLOWED: 0x30,
  PIN_INVALID: 0x31,
  PIN_BLOCKED: 0x32,
  PIN_AUTH_INVALID: 0x33,
  PIN_AUTH_BLOCKED: 0x34,
  PIN_NOT_SET: 0x35,
  PIN_REQUIRED: 0x36,
  PIN_POLICY_VIOLATION: 0x37,
  ACTION_TIMEOUT: 0x3a,
  UV_BLOCKED: 0x3c,
  UV_INVALID: 0x3f,
  TX: -1,
  RX: -2,
  RX_NOT_CBOR: -3,
  RX_INVALID_CBOR: -4,
  INVALID_PARAM: -5,
  INVALID_SIG: -6,
  INVALID_ARGUMENT: -7,
  USER_PRESENCE_REQUIRED: -8,
  INTERNAL: -9,
  NOTFOUND: -10,
} as const

const SYMBOLS = {
  fido_init: { args: [FFIType.i32], returns: FFIType.void },
  fido_strerr: { args: [FFIType.i32], returns: FFIType.cstring },
  fido_dev_info_new: { args: [FFIType.u64], returns: FFIType.ptr },
  fido_dev_info_manifest: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  fido_dev_info_ptr: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  fido_dev_info_path: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_dev_info_product_string: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_dev_info_manufacturer_string: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_dev_info_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  fido_dev_new: { args: [], returns: FFIType.ptr },
  fido_dev_open: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_dev_close: { args: [FFIType.ptr], returns: FFIType.i32 },
  fido_dev_free: { args: [FFIType.ptr], returns: FFIType.void },
  fido_dev_is_fido2: { args: [FFIType.ptr], returns: FFIType.bool },
  fido_dev_get_cbor_info: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_cbor_info_new: { args: [], returns: FFIType.ptr },
  fido_cbor_info_free: { args: [FFIType.ptr], returns: FFIType.void },
  fido_cbor_info_extensions_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cbor_info_extensions_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_cbor_info_options_name_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cbor_info_options_value_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cbor_info_options_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_cbor_info_aaguid_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cbor_info_aaguid_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_cred_new: { args: [], returns: FFIType.ptr },
  fido_cred_free: { args: [FFIType.ptr], returns: FFIType.void },
  fido_cred_set_type: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_cred_set_clientdata_hash: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  fido_cred_set_rp: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_cred_set_user: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  fido_cred_set_extensions: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_cred_set_rk: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_cred_set_uv: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_dev_make_cred: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_cred_id_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cred_id_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_cred_aaguid_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cred_aaguid_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_cred_authdata_ptr: { args: [FFIType.ptr], returns: FFIType.ptr },
  fido_cred_authdata_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_assert_new: { args: [], returns: FFIType.ptr },
  fido_assert_free: { args: [FFIType.ptr], returns: FFIType.void },
  fido_assert_set_clientdata_hash: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  fido_assert_set_rp: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_assert_allow_cred: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  fido_assert_set_extensions: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_assert_set_hmac_salt: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  fido_assert_set_uv: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_assert_set_up: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fido_dev_get_assert: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fido_assert_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  fido_assert_hmac_secret_ptr: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  fido_assert_hmac_secret_len: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  fido_assert_authdata_ptr: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  fido_assert_authdata_len: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
} as const

type Lib = ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"]

/**
 * Loads one candidate. A seam only so the regression test can record exactly which paths were
 * handed to the loader from a working directory holding a file named like a candidate; the helper
 * itself always runs with the real one.
 */
export type LibraryOpener = (path: string) => Lib

const dlopenLibfido2: LibraryOpener = (path) => dlopen(path, SYMBOLS).symbols

/**
 * Opens the first library candidate that loads, or refuses with `LIBRARY_MISSING`.
 *
 * Only the absolute paths in `libraryCandidates` are ever tried. No bare soname is passed to the
 * loader, so neither dyld nor `ld.so` consults the working directory this process inherited from
 * the CLI (BE-198).
 */
export function openLibfido2(
  platform = process.platform,
  candidates = libraryCandidates(platform),
  open: LibraryOpener = dlopenLibfido2,
): Fido2Backend {
  for (const candidate of candidates) {
    try {
      const symbols = open(candidate)
      symbols.fido_init(0)
      return new Libfido2Backend(symbols, platform)
    } catch {
      // Which candidate failed, and why, is the loader's diagnostic and not the operator's
      // problem: the refusal below names the install command instead.
    }
  }
  throw new HelperError("LIBRARY_MISSING", libraryMissingMessage(platform, candidates))
}

// ── Pointer helpers ───────────────────────────────────────────────────────────────────────────

/** A NUL-terminated copy of `text`, for a `const char *` argument. The caller zeroes it if secret. */
function cstr(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  const out = new Uint8Array(encoded.length + 1)
  out.set(encoded)
  return out
}

function readString(pointer: Pointer | null): string {
  if (pointer === null || pointer === 0) return ""
  return new CString(pointer).toString()
}

/** A COPY of `length` bytes at `pointer`; the library owns the original and frees it later. */
function copyBytes(pointer: Pointer | null, length: number): Uint8Array {
  if (pointer === null || pointer === 0 || length === 0) return new Uint8Array(0)
  return new Uint8Array(toArrayBuffer(pointer, 0, length)).slice()
}

/** The pointers in a `T **` array of `count` entries. */
function readPointerArray(pointer: Pointer | null, count: number): Pointer[] {
  if (pointer === null || pointer === 0 || count === 0) return []
  const words = new BigUint64Array(toArrayBuffer(pointer, 0, count * 8))
  return Array.from(words, (word) => Number(word) as Pointer)
}

/** A `T **` holder for the `_free` functions, which take the address of the pointer to free. */
function holderOf(pointer: Pointer): Uint8Array {
  const holder = new BigUint64Array([BigInt(pointer)])
  return new Uint8Array(holder.buffer)
}

// ── Error translation (helper protocols: the typed translation table) ─────────────────────────

export function helperErrorForRc(rc: number, describe: (rc: number) => string): HelperError {
  const text = describe(rc)
  switch (rc) {
    case FIDO_ERR.PIN_REQUIRED:
      return new HelperError("PIN_REQUIRED", `the security key requires its PIN for this operation (${text})`)
    case FIDO_ERR.PIN_NOT_SET:
      return new HelperError(
        "UV_UNSUPPORTED",
        `the security key has no PIN set; set one on this key and retry (${text})`,
      )
    case FIDO_ERR.PIN_INVALID:
    case FIDO_ERR.PIN_AUTH_INVALID:
    case FIDO_ERR.PIN_POLICY_VIOLATION:
      return new HelperError("PIN_INVALID", `the security key rejected the PIN (${text})`)
    case FIDO_ERR.UV_INVALID:
      return new HelperError("PIN_INVALID", `the security key rejected user verification (${text})`)
    case FIDO_ERR.PIN_BLOCKED:
    case FIDO_ERR.PIN_AUTH_BLOCKED:
    case FIDO_ERR.UV_BLOCKED:
      return new HelperError(
        "BLOCKED",
        `the security key is blocked; unplug and replug it, or reset the key with its vendor's tool (${text})`,
      )
    case FIDO_ERR.TIMEOUT:
    case FIDO_ERR.USER_ACTION_TIMEOUT:
    case FIDO_ERR.ACTION_TIMEOUT:
    case FIDO_ERR.KEEPALIVE_CANCEL:
    case FIDO_ERR.OPERATION_DENIED:
    case FIDO_ERR.USER_PRESENCE_REQUIRED:
      return new HelperError("CANCELLED", `the operation was cancelled or timed out waiting for a touch (${text})`)
    case FIDO_ERR.NO_CREDENTIALS:
    case FIDO_ERR.INVALID_CREDENTIAL:
      return new HelperError("NO_CREDENTIAL", `the security key holds no credential for this relying party (${text})`)
    case FIDO_ERR.UNSUPPORTED_EXTENSION:
    case FIDO_ERR.UNSUPPORTED_ALGORITHM:
      return new HelperError("PRF_UNSUPPORTED", `the security key refused the hmac-secret extension (${text})`)
    case FIDO_ERR.UNSUPPORTED_OPTION:
    case FIDO_ERR.INVALID_OPTION:
      return new HelperError("UV_UNSUPPORTED", `the security key refused user verification (${text})`)
    case FIDO_ERR.TX:
    case FIDO_ERR.RX:
    case FIDO_ERR.RX_NOT_CBOR:
    case FIDO_ERR.RX_INVALID_CBOR:
    case FIDO_ERR.INTERNAL:
    case FIDO_ERR.NOTFOUND:
      return new HelperError("DEVICE_IO", `the security key stopped answering (${text})`)
    case FIDO_ERR.KEY_STORE_FULL:
      return new HelperError("INTERNAL", `the security key has no room for another discoverable credential (${text})`)
    default:
      return new HelperError("INTERNAL", `libfido2 reported ${rc}: ${text}`)
  }
}

/**
 * BE-294 (D2): what one silent assertion's return code says about a credential. Only CTAP2's
 * "no credentials" is absent; every other failure (a key enforcing credProtect level 3 or
 * `alwaysUv`, a transport error) is unknown, which costs the menu its marker and nothing else.
 */
export function probeOutcomeForRc(rc: number, assertions: number): ProbeOutcome {
  if (rc === FIDO_OK) return assertions > 0 ? "present" : "unknown"
  if (rc === FIDO_ERR.NO_CREDENTIALS) return "absent"
  return "unknown"
}

// ── The backend ───────────────────────────────────────────────────────────────────────────────

const MAX_DEVICES = 32

class Libfido2Backend implements Fido2Backend {
  constructor(
    private readonly lib: Lib,
    private readonly platform: string,
  ) {}

  private strerr(rc: number): string {
    return this.lib.fido_strerr(rc).toString()
  }

  private check(rc: number, what: string): void {
    if (rc !== FIDO_OK) {
      const failure = helperErrorForRc(rc, (code) => this.strerr(code))
      failure.message = `${what}: ${failure.message}`
      throw failure
    }
  }

  enumerate(): EnumeratedDevice[] {
    const list = this.lib.fido_dev_info_new(MAX_DEVICES)
    if (list === null) throw new HelperError("INTERNAL", "fido_dev_info_new returned NULL")
    try {
      const found = new BigUint64Array(1)
      this.check(this.lib.fido_dev_info_manifest(list, MAX_DEVICES, ptr(found)), "enumerating security keys")
      const count = Number(found[0] ?? 0n)
      const devices: EnumeratedDevice[] = []
      for (let i = 0; i < count; i++) {
        const info = this.lib.fido_dev_info_ptr(list, i)
        if (info === null) continue
        devices.push({
          path: readString(this.lib.fido_dev_info_path(info)),
          product: readString(this.lib.fido_dev_info_product_string(info)),
          manufacturer: readString(this.lib.fido_dev_info_manufacturer_string(info)),
        })
      }
      return devices
    } finally {
      this.lib.fido_dev_info_free(ptr(holderOf(list)), MAX_DEVICES)
    }
  }

  /** Opens the device, translating a Linux permission failure into the CC-12 refusal. */
  private open(path: string): Pointer {
    const dev = this.lib.fido_dev_new()
    if (dev === null) throw new HelperError("INTERNAL", "fido_dev_new returned NULL")
    const rc = this.lib.fido_dev_open(dev, ptr(cstr(path)))
    if (rc !== FIDO_OK) {
      this.lib.fido_dev_free(ptr(holderOf(dev)))
      if (this.platform === "linux" && path.startsWith("/dev/") && !this.canOpenNode(path)) {
        throw new HelperError("DEVICE_NOT_READABLE", `this user cannot open ${path}`)
      }
      throw helperErrorForRc(rc, (code) => this.strerr(code))
    }
    return dev
  }

  private canOpenNode(path: string): boolean {
    try {
      accessSync(path, constants.R_OK | constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  private close(dev: Pointer): void {
    this.lib.fido_dev_close(dev)
    this.lib.fido_dev_free(ptr(holderOf(dev)))
  }

  describe(path: string): DeviceCapabilities {
    const dev = this.open(path)
    try {
      // A U2F-only key has no getInfo. It is reported with no extensions and no options, which the
      // protocol layer refuses as PRF_UNSUPPORTED rather than trying a U2F fallback.
      if (!this.lib.fido_dev_is_fido2(dev)) return { aaguid: new Uint8Array(16), extensions: [], options: {} }
      const info = this.lib.fido_cbor_info_new()
      if (info === null) throw new HelperError("INTERNAL", "fido_cbor_info_new returned NULL")
      try {
        this.check(this.lib.fido_dev_get_cbor_info(dev, info), "reading the security key's getInfo")
        const extensionCount = Number(this.lib.fido_cbor_info_extensions_len(info))
        const extensions = readPointerArray(this.lib.fido_cbor_info_extensions_ptr(info), extensionCount).map(
          (pointer) => readString(pointer),
        )
        const optionCount = Number(this.lib.fido_cbor_info_options_len(info))
        const names = readPointerArray(this.lib.fido_cbor_info_options_name_ptr(info), optionCount).map((pointer) =>
          readString(pointer),
        )
        const values = copyBytes(this.lib.fido_cbor_info_options_value_ptr(info), optionCount)
        const options: Record<string, boolean> = {}
        names.forEach((name, index) => {
          options[name] = values[index] !== 0
        })
        const aaguid = copyBytes(
          this.lib.fido_cbor_info_aaguid_ptr(info),
          Number(this.lib.fido_cbor_info_aaguid_len(info)),
        )
        return { aaguid, extensions, options }
      } finally {
        this.lib.fido_cbor_info_free(ptr(holderOf(info)))
      }
    } finally {
      this.close(dev)
    }
  }

  makeCredential(path: string, params: MakeCredentialParams): MakeCredentialResult {
    const dev = this.open(path)
    const cred = this.lib.fido_cred_new()
    if (cred === null) {
      this.close(dev)
      throw new HelperError("INTERNAL", "fido_cred_new returned NULL")
    }
    // Every buffer handed to the library is held in this scope until the call returns, so the
    // collector cannot move it out from under a pointer the library still holds.
    const rpId = cstr(params.rpId)
    const rpName = cstr(params.rpName)
    const userName = cstr(params.userName)
    const pin = params.pin !== undefined ? cstr(params.pin) : null
    try {
      this.check(this.lib.fido_cred_set_type(cred, COSE_ES256), "setting the credential type")
      this.check(
        this.lib.fido_cred_set_clientdata_hash(cred, ptr(params.clientDataHash), params.clientDataHash.length),
        "setting the client data hash",
      )
      this.check(this.lib.fido_cred_set_rp(cred, ptr(rpId), ptr(rpName)), "setting the relying party")
      this.check(
        this.lib.fido_cred_set_user(cred, ptr(params.userId), params.userId.length, ptr(userName), ptr(userName), null),
        "setting the user",
      )
      this.check(this.lib.fido_cred_set_extensions(cred, FIDO_EXT_HMAC_SECRET), "requesting hmac-secret")
      // Discoverable (rk) and user-verified (uv), both required: ED-11's user-verified variant only.
      this.check(this.lib.fido_cred_set_rk(cred, FIDO_OPT_TRUE), "requiring a discoverable credential")
      this.check(this.lib.fido_cred_set_uv(cred, FIDO_OPT_TRUE), "requiring user verification")
      this.check(this.lib.fido_dev_make_cred(dev, cred, pin === null ? null : ptr(pin)), "registering")
      const credentialId = copyBytes(this.lib.fido_cred_id_ptr(cred), Number(this.lib.fido_cred_id_len(cred)))
      const aaguid = copyBytes(this.lib.fido_cred_aaguid_ptr(cred), Number(this.lib.fido_cred_aaguid_len(cred)))
      const authData = unwrapCborByteString(
        copyBytes(this.lib.fido_cred_authdata_ptr(cred), Number(this.lib.fido_cred_authdata_len(cred))),
      )
      return { credentialId, aaguid, authData }
    } finally {
      pin?.fill(0)
      this.lib.fido_cred_free(ptr(holderOf(cred)))
      this.close(dev)
    }
  }

  getAssertion(path: string, params: GetAssertionParams): GetAssertionResult {
    const dev = this.open(path)
    const assert = this.lib.fido_assert_new()
    if (assert === null) {
      this.close(dev)
      throw new HelperError("INTERNAL", "fido_assert_new returned NULL")
    }
    const rpId = cstr(params.rpId)
    const pin = params.pin !== undefined ? cstr(params.pin) : null
    try {
      this.check(
        this.lib.fido_assert_set_clientdata_hash(assert, ptr(params.clientDataHash), params.clientDataHash.length),
        "setting the client data hash",
      )
      this.check(this.lib.fido_assert_set_rp(assert, ptr(rpId)), "setting the relying party")
      // Exactly one allowed credential: the envelope's. The key either holds it or answers with no
      // credentials, which is the identity check the protocol section describes.
      this.check(
        this.lib.fido_assert_allow_cred(assert, ptr(params.credentialId), params.credentialId.length),
        "naming the credential",
      )
      this.check(this.lib.fido_assert_set_extensions(assert, FIDO_EXT_HMAC_SECRET), "requesting hmac-secret")
      this.check(this.lib.fido_assert_set_hmac_salt(assert, ptr(params.salt), params.salt.length), "setting the salt")
      this.check(this.lib.fido_assert_set_uv(assert, FIDO_OPT_TRUE), "requiring user verification")
      this.check(this.lib.fido_dev_get_assert(dev, assert, pin === null ? null : ptr(pin)), "asserting")
      if (Number(this.lib.fido_assert_count(assert)) === 0) {
        throw new HelperError("NO_CREDENTIAL", "the security key returned no assertion for this credential")
      }
      const hmacSecret = copyBytes(
        this.lib.fido_assert_hmac_secret_ptr(assert, 0),
        Number(this.lib.fido_assert_hmac_secret_len(assert, 0)),
      )
      const authData = unwrapCborByteString(
        copyBytes(this.lib.fido_assert_authdata_ptr(assert, 0), Number(this.lib.fido_assert_authdata_len(assert, 0))),
      )
      return { hmacSecret, authData }
    } finally {
      pin?.fill(0)
      this.lib.fido_assert_free(ptr(holderOf(assert)))
      this.close(dev)
    }
  }

  /**
   * BE-294 (D2): one `getAssertion` naming one credential, with `up` false, `uv` left unset, no
   * PIN and no extension, so no `hmac-secret` is requested and no PRF output exists. The
   * authenticator data and signature are never read; only whether an assertion came back is.
   */
  probeCredential(path: string, params: ProbeCredentialParams): ProbeOutcome {
    const dev = this.open(path)
    const assert = this.lib.fido_assert_new()
    if (assert === null) {
      this.close(dev)
      throw new HelperError("INTERNAL", "fido_assert_new returned NULL")
    }
    const rpId = cstr(params.rpId)
    try {
      this.check(
        this.lib.fido_assert_set_clientdata_hash(assert, ptr(params.clientDataHash), params.clientDataHash.length),
        "setting the client data hash",
      )
      this.check(this.lib.fido_assert_set_rp(assert, ptr(rpId)), "setting the relying party")
      this.check(
        this.lib.fido_assert_allow_cred(assert, ptr(params.credentialId), params.credentialId.length),
        "naming the credential",
      )
      this.check(this.lib.fido_assert_set_up(assert, FIDO_OPT_FALSE), "clearing user presence")
      const rc = this.lib.fido_dev_get_assert(dev, assert, null)
      return probeOutcomeForRc(rc, rc === FIDO_OK ? Number(this.lib.fido_assert_count(assert)) : 0)
    } finally {
      this.lib.fido_assert_free(ptr(holderOf(assert)))
      this.close(dev)
    }
  }
}
