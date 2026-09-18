/**
 * TEST ONLY (Ember Phase 2, BE-141): a scripted `EnclaveBackend`, shared by the scripted helper
 * the subprocess tests spawn and by the in-process fake the command tests inject.
 *
 * The "Enclave" is a JSON file of P-256 private keys, one per key tag, so the state survives from
 * one helper process to the next the way a real Enclave key does. `decrypt` runs the real ECIES
 * (`vault/ecies.ts`) backwards, so a packet the CLI wrapped is unwrapped by the same construction
 * the Swift helper hands to the Security framework. What no script can stand in for is the
 * Security framework itself; that is T48's.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { p256 } from "@noble/curves/p256"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { hex } from "@scure/base"
import { eciesDecrypt } from "../vault/ecies"
import { wipe } from "../vault/hygiene"
import {
  type BiometryState,
  type BiometryType,
  type EnclaveBackend,
  type EnclaveCode,
  EnclaveError,
  type EnclaveInfoResponse,
  type LaErrorReport,
} from "./protocol"

export interface ScriptedFailure {
  code: EnclaveCode
  message: string
}

/** What the scripted platform authenticator says about the credentials it makes (BE-135). */
export interface ScriptedPasskey {
  /** Whether the registration result reports the PRF extension supported. Default true. */
  prfSupported?: boolean
  /** The BE flag on every authenticator data this authenticator produces. Default true (synced). */
  backupEligible?: boolean
  /** The BS flag. Default true. */
  backupState?: boolean
  /** The UV flag on assertions. Default true; false is the ED-11 non-verified case the CLI must refuse. */
  userVerified?: boolean
}

export interface EnclaveScript {
  version: string
  bundleId: string
  teamId: string
  secureEnclave: boolean
  biometry: BiometryState
  biometryReason?: string
  biometryType?: BiometryType
  laError?: LaErrorReport
  /** `major.minor.patch`; absent means the helper does not report one (a PR F helper). */
  osVersion?: string
  associatedDomains?: string[]
  provisioningProfile?: boolean
  passkey?: ScriptedPasskey
  /** The file the scripted Enclave keeps its keys in, so a subprocess sees what an earlier one made. */
  store: string
  /** Fail the named operation with this code instead of performing it. */
  fail?: Partial<Record<"create" | "decrypt" | "delete" | "passkeyRegister" | "passkeyAssert", ScriptedFailure>>
  /** A file every backend call is appended to as one JSON line. */
  log?: string
}

export interface EnclaveLogEntry {
  op: "info" | "create" | "decrypt" | "delete" | "passkey-register" | "passkey-assert"
  keyTag?: string
  label?: string
  reason?: string
  rpId?: string
  userName?: string
  /** hex */
  credentialId?: string
  /** hex */
  prfSalt?: string
}

interface StoredKey {
  privateKey: string
  publicKey: string
  label: string
}

function readStore(path: string): Record<string, StoredKey> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredKey>
}

function writeStore(path: string, keys: Record<string, StoredKey>): void {
  writeFileSync(path, JSON.stringify(keys))
}

/** The scripted platform authenticator's credentials, beside the Enclave key store (BE-135). */
interface StoredPasskey {
  /** hex, the 32-byte secret the scripted PRF is an HMAC under. */
  secret: string
  userId: string
  userName: string
}

function passkeyStorePath(store: string): string {
  return `${store}.passkeys.json`
}

function readPasskeys(store: string): Record<string, StoredPasskey> {
  const path = passkeyStorePath(store)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredPasskey>
}

function writePasskeys(store: string, passkeys: Record<string, StoredPasskey>): void {
  writeFileSync(passkeyStorePath(store), JSON.stringify(passkeys))
}

// ── Just enough CBOR to build an attestation object (test only) ───────────────────────────────

function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length]
  if (length < 0x100) return [(major << 5) | 24, length]
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff]
  throw new Error("cbor: item too long for the test encoder")
}

function cborText(text: string): number[] {
  const bytes = new TextEncoder().encode(text)
  return [...cborHead(3, bytes.length), ...bytes]
}

function cborBytes(bytes: Uint8Array): number[] {
  return [...cborHead(2, bytes.length), ...bytes]
}

function cborMap(entries: Array<[string, number[]]>): number[] {
  return [...cborHead(5, entries.length), ...entries.flatMap(([key, value]) => [...cborText(key), ...value])]
}

/** A `fmt: "none"` attestation object around the given authenticator data, as WebAuthn lays it out. */
export function attestationObjectAround(authData: Uint8Array): Uint8Array {
  return Uint8Array.from(
    cborMap([
      ["fmt", cborText("none")],
      ["attStmt", cborMap([])],
      ["authData", cborBytes(authData)],
    ]),
  )
}

function flagsByte(script: ScriptedPasskey | undefined, opts: { attested: boolean; uv: boolean }): number {
  let flags = 0x01
  if (opts.uv) flags |= 0x04
  if (script?.backupEligible ?? true) flags |= 0x08
  if (script?.backupState ?? true) flags |= 0x10
  if (opts.attested) flags |= 0x40
  return flags
}

/** Authenticator data: rpIdHash, flags, a zero sign count, and attested credential data when registering. */
export function scriptedAuthData(rpId: string, flags: number, attested?: { credentialId: Uint8Array }): Uint8Array {
  const head = [...sha256(new TextEncoder().encode(rpId)), flags, 0, 0, 0, 0]
  if (!attested) return Uint8Array.from(head)
  const aaguid = new Array(16).fill(0)
  const idLength = [attested.credentialId.length >> 8, attested.credentialId.length & 0xff]
  // A COSE key would follow in a real object; the CLI never reads it, and an empty map keeps the
  // object well formed for any decoder that walks it.
  return Uint8Array.from([...head, ...aaguid, ...idLength, ...attested.credentialId, 0xa0])
}

export function scriptedEnclaveBackend(
  script: EnclaveScript,
  onCall?: (entry: EnclaveLogEntry) => void,
): EnclaveBackend {
  const log = (entry: EnclaveLogEntry): void => {
    onCall?.(entry)
    if (script.log) appendFileSync(script.log, `${JSON.stringify(entry)}\n`)
  }
  const info = (): Omit<EnclaveInfoResponse, "ok" | "protocol" | "op"> => ({
    version: script.version,
    bundleId: script.bundleId,
    teamId: script.teamId,
    secureEnclave: script.secureEnclave,
    biometry: script.biometry,
    ...(script.biometryReason !== undefined ? { biometryReason: script.biometryReason } : {}),
    ...(script.biometryType !== undefined ? { biometryType: script.biometryType } : {}),
    ...(script.laError !== undefined ? { laError: script.laError } : {}),
    ...(script.osVersion !== undefined ? { osVersion: script.osVersion } : {}),
    ...(script.associatedDomains !== undefined ? { associatedDomains: script.associatedDomains } : {}),
    ...(script.provisioningProfile !== undefined ? { provisioningProfile: script.provisioningProfile } : {}),
  })
  return {
    info: async () => {
      log({ op: "info" })
      return info()
    },
    create: async (keyTag, label) => {
      log({ op: "create", keyTag, label })
      const failure = script.fail?.create
      if (failure) throw new EnclaveError(failure.code, failure.message)
      if (!script.secureEnclave) throw new EnclaveError("NO_ENCLAVE", "this Mac has no Secure Enclave")
      if (script.biometry !== "available") {
        throw new EnclaveError("BIOMETRY_UNAVAILABLE", script.biometryReason ?? "Touch ID is not available right now")
      }
      const keys = readStore(script.store)
      if (keys[keyTag]) throw new EnclaveError("KEY_EXISTS", `a key with tag ${keyTag} already exists`)
      const privateKey = p256.utils.randomPrivateKey()
      const publicKey = p256.getPublicKey(privateKey, false)
      keys[keyTag] = { privateKey: hex.encode(privateKey), publicKey: hex.encode(publicKey), label }
      writeStore(script.store, keys)
      return publicKey
    },
    decrypt: async (keyTag, publicKey, ciphertext, reason) => {
      log({ op: "decrypt", keyTag, reason })
      const failure = script.fail?.decrypt
      if (failure) throw new EnclaveError(failure.code, failure.message)
      if (script.biometry !== "available") {
        throw new EnclaveError("BIOMETRY_UNAVAILABLE", script.biometryReason ?? "Touch ID is not available right now")
      }
      const stored = readStore(script.store)[keyTag]
      if (!stored) throw new EnclaveError("KEY_NOT_FOUND", `no Secure Enclave key with tag ${keyTag} on this Mac`)
      if (stored.publicKey !== hex.encode(publicKey)) {
        throw new EnclaveError("KEY_NOT_FOUND", `the key with tag ${keyTag} on this Mac has a different public key`)
      }
      let plaintext: Uint8Array
      try {
        plaintext = await eciesDecrypt(hex.decode(stored.privateKey), ciphertext)
      } catch (error) {
        throw new EnclaveError("DECRYPT_FAILED", error instanceof Error ? error.message : String(error))
      }
      // The reference decryptor tracks its output as a secret (T36); what crosses the pipe is a
      // copy, and the tracked buffer is zeroed here as the real helper's process exit would.
      const copy = Uint8Array.from(plaintext)
      wipe(plaintext)
      return copy
    },
    delete: async (keyTag) => {
      log({ op: "delete", keyTag })
      const failure = script.fail?.delete
      if (failure) throw new EnclaveError(failure.code, failure.message)
      const keys = readStore(script.store)
      const had = keyTag in keys
      delete keys[keyTag]
      writeStore(script.store, keys)
      return had
    },
    passkeyRegister: async (rpId, userId, userName, _clientDataHash) => {
      log({ op: "passkey-register", rpId, userName })
      const failure = script.fail?.passkeyRegister
      if (failure) throw new EnclaveError(failure.code, failure.message)
      const major = Number.parseInt((script.osVersion ?? "0").split(".")[0] ?? "0", 10)
      if (major < 15) {
        throw new EnclaveError(
          "PASSKEY_UNSUPPORTED",
          `the platform passkey API needs macOS 15; this Mac runs ${script.osVersion ?? "an unknown version"}`,
        )
      }
      if (!(script.associatedDomains ?? []).includes(`webcredentials:${rpId}`)) {
        throw new EnclaveError("DOMAIN_NOT_ASSOCIATED", `this helper is not associated with ${rpId}`)
      }
      const credentialId = crypto.getRandomValues(new Uint8Array(16))
      const secret = crypto.getRandomValues(new Uint8Array(32))
      const passkeys = readPasskeys(script.store)
      passkeys[hex.encode(credentialId)] = { secret: hex.encode(secret), userId: hex.encode(userId), userName }
      writePasskeys(script.store, passkeys)
      const authData = scriptedAuthData(rpId, flagsByte(script.passkey, { attested: true, uv: true }), { credentialId })
      return {
        credentialId,
        attestationObject: attestationObjectAround(authData),
        prfSupported: script.passkey?.prfSupported ?? true,
      }
    },
    passkeyAssert: async (rpId, credentialId, _clientDataHash, prfSalt) => {
      log({ op: "passkey-assert", rpId, credentialId: hex.encode(credentialId), prfSalt: hex.encode(prfSalt) })
      const failure = script.fail?.passkeyAssert
      if (failure) throw new EnclaveError(failure.code, failure.message)
      const stored = readPasskeys(script.store)[hex.encode(credentialId)]
      if (!stored) {
        throw new EnclaveError(
          "NO_CREDENTIAL",
          "no passkey with this credential id is available to this Mac or this Apple account",
        )
      }
      // The scripted platform derivation: an HMAC under the credential's secret over the raw salt,
      // which is what "the platform applied whatever salt hashing it applies" looks like here.
      const prfOutput = hmac(sha256, hex.decode(stored.secret), prfSalt)
      const uv = script.passkey?.userVerified ?? true
      return {
        authenticatorData: scriptedAuthData(rpId, flagsByte(script.passkey, { attested: false, uv })),
        prfOutput,
      }
    },
  }
}
