/**
 * TEST ONLY (Ember Phase 2, BE-140): a scripted `Fido2Backend`, shared by the scripted helper the
 * subprocess tests spawn and by the in-process fake the command tests inject.
 *
 * Everything above the backend seam stays the real code (`protocol.ts`'s validation, selection,
 * snapshot check and feature detection, and `io.ts`'s loop when spawned), so a test that drives
 * this is exercising the shape the CLI actually talks to; only the authenticator is a script.
 */
import { appendFileSync } from "node:fs"
import { base64, hex } from "@scure/base"
import {
  type DeviceCapabilities,
  type EnumeratedDevice,
  type Fido2Backend,
  type GetAssertionParams,
  type GetAssertionResult,
  type HelperCode,
  HelperError,
  type MakeCredentialParams,
  type MakeCredentialResult,
} from "./protocol"

export interface ScriptedDevice extends EnumeratedDevice {
  /** hex, 16 bytes */
  aaguid?: string
  extensions?: string[]
  options?: Record<string, boolean>
  /** The device enumerates but cannot be opened by this user (the Linux `hidraw` case). */
  unreadable?: boolean
}

export interface ScriptedFailure {
  error: { code: HelperCode; message: string }
}

export interface ScriptedRegister {
  /** base64 */
  credentialId: string
  /** hex */
  aaguid: string
  /** base64, raw authenticator data */
  authData: string
}

export interface ScriptedAssert {
  /** base64, 32 bytes */
  hmacSecret: string
  /** base64, raw authenticator data */
  authData: string
}

export interface HelperScript {
  devices: ScriptedDevice[]
  register?: ScriptedRegister | ScriptedFailure
  assert?: ScriptedAssert | ScriptedFailure
  /** A file every backend call is appended to as one JSON line, PIN included. */
  log?: string
}

/** One entry of the script's log: what reached the (scripted) authenticator, and through which path. */
export interface BackendLogEntry {
  op: "register" | "assert"
  path: string
  rpId: string
  userName?: string
  credentialId?: string
  salt?: string
  pin: string | null
}

export function scriptedBackend(script: HelperScript, onCall?: (entry: BackendLogEntry) => void): Fido2Backend {
  const log = (entry: BackendLogEntry): void => {
    onCall?.(entry)
    if (script.log) appendFileSync(script.log, `${JSON.stringify(entry)}\n`)
  }
  return {
    enumerate: () => script.devices.map(({ path, product, manufacturer }) => ({ path, product, manufacturer })),
    describe: (path: string): DeviceCapabilities => {
      const device = script.devices.find((candidate) => candidate.path === path)
      if (!device) throw new HelperError("DEVICE_IO", `no scripted device at ${path}`)
      if (device.unreadable) throw new HelperError("DEVICE_NOT_READABLE", `this user cannot open ${path}`)
      return {
        aaguid: hex.decode(device.aaguid ?? "00".repeat(16)),
        extensions: device.extensions ?? [],
        options: device.options ?? {},
      }
    },
    makeCredential: (path: string, params: MakeCredentialParams): MakeCredentialResult => {
      log({ op: "register", path, rpId: params.rpId, userName: params.userName, pin: params.pin ?? null })
      const scripted = script.register
      if (!scripted) throw new HelperError("INTERNAL", "the script has no register result")
      if ("error" in scripted) throw new HelperError(scripted.error.code, scripted.error.message)
      return {
        credentialId: base64.decode(scripted.credentialId),
        aaguid: hex.decode(scripted.aaguid),
        authData: base64.decode(scripted.authData),
      }
    },
    getAssertion: (path: string, params: GetAssertionParams): GetAssertionResult => {
      log({
        op: "assert",
        path,
        rpId: params.rpId,
        credentialId: base64.encode(params.credentialId),
        salt: base64.encode(params.salt),
        pin: params.pin ?? null,
      })
      const scripted = script.assert
      if (!scripted) throw new HelperError("INTERNAL", "the script has no assert result")
      if ("error" in scripted) throw new HelperError(scripted.error.code, scripted.error.message)
      return { hmacSecret: base64.decode(scripted.hmacSecret), authData: base64.decode(scripted.authData) }
    },
  }
}
