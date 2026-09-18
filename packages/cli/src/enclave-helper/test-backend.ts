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
import { hex } from "@scure/base"
import { eciesDecrypt } from "../vault/ecies"
import { wipe } from "../vault/hygiene"
import {
  type BiometryState,
  type EnclaveBackend,
  type EnclaveCode,
  EnclaveError,
  type EnclaveInfoResponse,
} from "./protocol"

export interface ScriptedFailure {
  code: EnclaveCode
  message: string
}

export interface EnclaveScript {
  version: string
  bundleId: string
  teamId: string
  secureEnclave: boolean
  biometry: BiometryState
  biometryReason?: string
  /** The file the scripted Enclave keeps its keys in, so a subprocess sees what an earlier one made. */
  store: string
  /** Fail the named operation with this code instead of performing it. */
  fail?: Partial<Record<"create" | "decrypt" | "delete", ScriptedFailure>>
  /** A file every backend call is appended to as one JSON line. */
  log?: string
}

export interface EnclaveLogEntry {
  op: "info" | "create" | "decrypt" | "delete"
  keyTag?: string
  label?: string
  reason?: string
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
  }
}
