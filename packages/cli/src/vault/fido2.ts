/**
 * Ember Phase 2 (BE-140, ED-11, CC-12, helper protocols): the CLI's side of `candle-fido2`.
 *
 * Everything the CLI knows about a security key goes through here, and the shape of it is the
 * spec's: find the helper (beside the binary, or at `CANDLE_FIDO2_HELPER`), run one operation per
 * process over a pipe, translate the helper's typed code into this document's error codes and
 * NEVER into a fallback, and re-check the returned authenticator data before anything is derived.
 *
 * Selection is the operator's, not the CLI's. `info` lists the attached keys; with one attached the
 * CLI names it and says so; with several and none named it refuses (`VAULT_AUTHENTICATOR_AMBIGUOUS`)
 * and lists them with `--device <id>` beside each. There is no trying of devices in turn, on any
 * machine, ever: a PIN goes only to the device the operator named, and a named device that does
 * not hold the credential is `VAULT_CREDENTIAL_NOT_PRESENT` with nothing derived and no second
 * attempt.
 *
 * The PIN prompt is the CLI's (ED-11). It is collected on the same hidden prompt every other vault
 * secret uses and travels inside the helper's JSON request on stdin, never argv; the helper has no
 * prompt of its own. A PIN-only key needs it on every assertion, so a key that reports
 * `clientPin: true` is asked for its PIN before the helper is run.
 */
import { access, constants } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import type { Deps } from "../deps"
import { libraryInstallInstruction } from "../fido2-helper/library-paths"
import {
  AUTHDATA_FLAG_UV,
  AUTHDATA_MIN_LENGTH,
  type DeviceReport,
  HELPER_PROTOCOL,
  type HelperCode,
  type HelperResponse,
  type InfoResponse,
  type RegisterResponse,
  RP_ID,
} from "../fido2-helper/protocol"
import { detectInstall } from "../release"
import { canonicalBytes } from "./canonical-json"
import { b64u, PRF_OUTPUT_BYTES, randomBytes, unb64u } from "./crypto"
import { currentEnclaveHelper } from "./enclave"
import { VaultError, type VaultErrorCode } from "./errors"
import type { Ctap2Envelope } from "./format"
import { ownSecret, wipe } from "./hygiene"
import { HIDRAW_MESSAGE, type PlatformFacts, platformFactsFor } from "./platform"

export const HELPER_NAME = "candle-fido2"
export const HELPER_ENV = "CANDLE_FIDO2_HELPER"
/**
 * Long enough for a PIN entry the key is waiting on plus its own touch timeout (about 30 s on a
 * YubiKey), short enough that a helper wedged on a dead device is reaped. Past it the helper is
 * terminated and the result is `VAULT_AUTHENTICATOR_CANCELLED` with nothing derived.
 */
export const HELPER_TIMEOUT_MS = 90_000

export const HELPER_INSTALL_SUGGESTION =
  "Install a release build of the CLI (the installer script or Homebrew place candle-fido2 beside candle), or set CANDLE_FIDO2_HELPER to the path of a candle-fido2 executable. No other factor is substituted."

// ── Locating the helper ───────────────────────────────────────────────────────────────────────

export type HelperLocation =
  | { state: "ready"; path: string; source: "env" | "beside-binary" }
  /**
   * `installable` (BE-275 D8): whether `vault factor add security-key --install-helper` can put
   * one where this lookup would find it. True only when a release binary has no helper beside it.
   * An npm or source install ships no helper to fetch (D10), and a `CANDLE_FIDO2_HELPER` that
   * points at a non-executable wins over anything beside the binary, so installing there would
   * not be found.
   */
  | { state: "absent"; reason: string; installable: boolean }

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `CANDLE_FIDO2_HELPER` first, then `candle-fido2` beside the real binary. An npm install runs
 * under node or bun and ships no native executable, so there the helper is absent until one is
 * installed and pointed at, exactly as the PR split row says.
 */
export async function locateFido2Helper(deps: Pick<Deps, "env" | "execPath" | "realpath">): Promise<HelperLocation> {
  const fromEnv = deps.env[HELPER_ENV]?.trim()
  if (fromEnv) {
    if (await isExecutable(fromEnv)) return { state: "ready", path: fromEnv, source: "env" }
    return {
      state: "absent",
      reason: `${HELPER_ENV} points at ${fromEnv}, which is not an executable file`,
      installable: false,
    }
  }
  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  if (detectInstall(deps.execPath, realExec) === "script") {
    return {
      state: "absent",
      reason: "this CLI is running from the npm package (or a source checkout), which ships no candle-fido2 executable",
      installable: false,
    }
  }
  const beside = join(dirname(realExec), HELPER_NAME)
  if (await isExecutable(beside)) return { state: "ready", path: beside, source: "beside-binary" }
  return { state: "absent", reason: `no ${HELPER_NAME} executable beside ${realExec}`, installable: true }
}

/**
 * The platform facts for this run, with both helpers looked for. Every vault command reads these.
 * The signed Secure Enclave helper (BE-141) is looked for on macOS only: everywhere else the
 * factor is CC-12's typed refusal before any helper is a question.
 */
export async function currentPlatformFacts(
  deps: Pick<Deps, "platform" | "arch" | "env" | "execPath" | "realpath" | "spawnHelper" | "releasePolicy">,
): Promise<PlatformFacts> {
  const location = await locateFido2Helper(deps)
  const enclave = deps.platform === "darwin" ? await currentEnclaveHelper(deps) : undefined
  return platformFactsFor(
    deps,
    location.state === "ready"
      ? { state: "ready", path: location.path }
      : { state: "absent", reason: location.reason, installable: location.installable },
    enclave,
  )
}

export function helperMissing(location: Extract<HelperLocation, { state: "absent" }>): VaultError {
  return new VaultError("VAULT_HELPER_MISSING", `The security key helper is not available: ${location.reason}.`, {
    suggestion: HELPER_INSTALL_SUGGESTION,
  })
}

// ── Running one operation ─────────────────────────────────────────────────────────────────────

/** What the injected spawn seam reports about one helper process. */
export interface HelperRun {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  /** Set when the process could not be started at all (ENOENT, EACCES, a non-executable). */
  spawnError?: string
}

/**
 * The typed translation table from the helper protocols section. It is the contract, not an
 * implementation note, and every row is asserted by a test against the real helper shape.
 * `DEVICE_NOT_READABLE` carries CC-12's `hidraw` sentence verbatim on Linux.
 */
export function translateHelperFailure(code: string, message: string, platform: string): VaultError {
  const table: Partial<Record<HelperCode, VaultErrorCode>> = {
    NO_DEVICE: "VAULT_FACTOR_UNAVAILABLE",
    DEVICE_NOT_READABLE: "VAULT_AUTHENTICATOR_NOT_READABLE",
    DEVICE_NOT_FOUND: "VAULT_AUTHENTICATOR_CHANGED",
    SNAPSHOT_CHANGED: "VAULT_AUTHENTICATOR_CHANGED",
    PRF_UNSUPPORTED: "VAULT_PRF_UNSUPPORTED",
    UV_UNSUPPORTED: "VAULT_UV_UNSUPPORTED",
    PIN_REQUIRED: "VAULT_PIN_REQUIRED",
    PIN_INVALID: "VAULT_PIN_INVALID",
    BLOCKED: "VAULT_AUTHENTICATOR_BLOCKED",
    CANCELLED: "VAULT_AUTHENTICATOR_CANCELLED",
    NO_CREDENTIAL: "VAULT_CREDENTIAL_NOT_PRESENT",
    DEVICE_IO: "VAULT_FACTOR_UNAVAILABLE",
    LIBRARY_MISSING: "VAULT_HELPER_MISSING",
  }
  const suggestion = "Nothing was derived and no other factor was tried."
  if (code === "DEVICE_NOT_READABLE") {
    return new VaultError(
      "VAULT_AUTHENTICATOR_NOT_READABLE",
      platform === "linux" ? HIDRAW_MESSAGE : `A security key is attached but this user cannot open it: ${message}.`,
      { suggestion: "No other factor is substituted." },
    )
  }
  const mapped = table[code as HelperCode]
  if (mapped === undefined) {
    // Any code the CLI does not recognize is VAULT_UNLOCK_FAILED, never retried elsewhere.
    return new VaultError("VAULT_UNLOCK_FAILED", `The security key helper reported ${code}: ${message}.`, {
      suggestion,
    })
  }
  const detail: Partial<Record<HelperCode, string>> = {
    NO_DEVICE: "No security key is attached.",
    PRF_UNSUPPORTED: `This security key cannot serve this factor: ${message}.`,
    UV_UNSUPPORTED: `This security key cannot serve this factor: ${message}.`,
    PIN_REQUIRED: `This security key needs its PIN: ${message}.`,
    PIN_INVALID: `The security key rejected the PIN: ${message}.`,
    BLOCKED: `The security key is blocked: ${message}.`,
    CANCELLED: `The security key operation did not complete: ${message}.`,
    NO_CREDENTIAL: `The named security key does not hold this vault's credential: ${message}.`,
    DEVICE_NOT_FOUND: `The attached security keys changed: ${message}.`,
    SNAPSHOT_CHANGED: `The attached security keys changed: ${message}.`,
    DEVICE_IO: `The security key stopped answering: ${message}.`,
    // The helper itself ran; only libfido2 is absent. So the line is the helper's own (the install
    // command plus the short list of paths it checked), and the way out is that install command,
    // not a reinstall of the CLI (BE-198).
    LIBRARY_MISSING: message,
  }
  const helperSuggestion =
    code === "LIBRARY_MISSING" ? `${libraryInstallInstruction(platform)}.` : HELPER_INSTALL_SUGGESTION
  return new VaultError(mapped, detail[code as HelperCode] ?? `${message}.`, {
    suggestion: mapped === "VAULT_HELPER_MISSING" ? helperSuggestion : suggestion,
  })
}

/**
 * Runs one helper process for one request and answers with its `ok: true` response, or throws the
 * translated refusal. Process-level outcomes are typed too: a helper that could not be started is
 * `VAULT_HELPER_MISSING`; one terminated by a signal (the timeout, or the operator's interrupt) is
 * `VAULT_AUTHENTICATOR_CANCELLED`; one that printed no response line is `VAULT_UNLOCK_FAILED`; and
 * one speaking another protocol revision is `VAULT_HELPER_MISSING`, because a stale helper beside
 * a new binary is an install problem, not an authenticator problem.
 */
export async function callHelper<T extends Exclude<HelperResponse, { ok: false }>>(
  deps: Pick<Deps, "spawnHelper" | "platform">,
  helperPath: string,
  request: Record<string, unknown>,
): Promise<T> {
  const run = await deps.spawnHelper(helperPath, JSON.stringify(request), { timeoutMs: HELPER_TIMEOUT_MS })
  if (run.spawnError !== undefined) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `Could not run the security key helper at ${helperPath}: ${run.spawnError}.`,
      {
        suggestion: HELPER_INSTALL_SUGGESTION,
      },
    )
  }
  const line = run.stdout.split("\n").find((candidate) => candidate.trim() !== "")
  let response: HelperResponse | undefined
  if (line !== undefined) {
    try {
      response = JSON.parse(line) as HelperResponse
    } catch {
      response = undefined
    }
  }
  if (response === undefined) {
    if (run.signal !== null) {
      throw new VaultError(
        "VAULT_AUTHENTICATOR_CANCELLED",
        `The security key operation was cancelled (helper terminated by ${run.signal}) and nothing was derived.`,
        { suggestion: "Run the command again and touch the key when it blinks." },
      )
    }
    const diagnostic = run.stderr.trim().split("\n")[0]?.slice(0, 200)
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The security key helper at ${helperPath} exited (${run.exitCode ?? "no code"}) without a response${diagnostic ? `: ${diagnostic}` : ""}.`,
      { suggestion: "Nothing was derived and no other factor was tried." },
    )
  }
  if (typeof response !== "object" || response === null || response.protocol !== HELPER_PROTOCOL) {
    throw new VaultError(
      "VAULT_HELPER_MISSING",
      `The security key helper at ${helperPath} speaks protocol ${String((response as { protocol?: unknown })?.protocol)}; this CLI needs protocol ${HELPER_PROTOCOL}.`,
      { suggestion: "Reinstall the CLI so candle and candle-fido2 come from the same release." },
    )
  }
  if (!response.ok) throw translateHelperFailure(String(response.code), String(response.message), deps.platform)
  return response as T
}

// ── Device selection (the operator's, never the CLI's) ────────────────────────────────────────

export function describeDeviceForList(device: DeviceReport): string {
  const product = device.product || "security key"
  return `--device ${device.deviceId}  ${product}${device.manufacturer ? ` (${device.manufacturer})` : ""}${device.readable ? "" : "  [not readable by this user]"}`
}

/**
 * Picks the device an operation will name. One attached and none named: that one, and the caller
 * prints which. Several and none named: refused, listing each with `--device <id>`. A named id
 * that is not in this enumeration: refused, listing what is. An unreadable device: CC-12's
 * `hidraw` refusal on Linux.
 */
export function selectDevice(devices: DeviceReport[], named: string | undefined, platform: string): DeviceReport {
  if (devices.length === 0) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "No security key is attached.", {
      suggestion: "Plug the key in and run the command again. No other factor is substituted.",
    })
  }
  const listing = devices.map((device) => `  ${describeDeviceForList(device)}`).join("\n")
  let chosen: DeviceReport | undefined
  if (named !== undefined) {
    chosen = devices.find((device) => device.deviceId === named)
    if (!chosen) {
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `No attached security key has the id ${named}. Ids are valid for one listing only; attached now:\n${listing}`,
        { suggestion: "Name one of the ids above with --device. No other key was tried." },
      )
    }
  } else if (devices.length > 1) {
    throw new VaultError(
      "VAULT_AUTHENTICATOR_AMBIGUOUS",
      `${devices.length} security keys are attached and none was named, so nothing was sent to any of them:\n${listing}`,
      { suggestion: "Run again with --device <id> naming the key to use." },
    )
  } else {
    chosen = devices[0] as DeviceReport
  }
  if (!chosen.readable) throw translateHelperFailure("DEVICE_NOT_READABLE", chosen.reason ?? "", platform)
  return chosen
}

// ── Derivations the CLI owns (ED-11) ──────────────────────────────────────────────────────────

/**
 * The salt handed to the authenticator: `SHA-256("WebAuthn PRF" || 0x00 || prfSalt)`, the same
 * derivation a browser's PRF extension performs, so the same credential yields the same KEK
 * whichever path is used later.
 */
export function prfSaltForAuthenticator(prfSalt: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("WebAuthn PRF")
  const input = new Uint8Array(prefix.length + 1 + prfSalt.length)
  input.set(prefix, 0)
  input[prefix.length] = 0x00
  input.set(prfSalt, prefix.length + 1)
  return sha256(input)
}

/** The 32-byte operation digest every request carries, and the client data hash of the ceremony. */
export function operationDigest(fields: {
  vaultId: string
  envelopeId: string
  op: string
  nonce: string
}): Uint8Array {
  return sha256(canonicalBytes({ purpose: "candle-fido2/operation", ...fields }))
}

/**
 * The discoverable credential's user handle, unique per envelope so that a second envelope on the
 * same key does not overwrite the first (an authenticator keeps one discoverable credential per
 * relying party and user id). Derived, not random, so it carries nothing that has to be stored.
 */
export function userIdFor(vaultId: string, envelopeId: string): Uint8Array {
  return sha256(new TextEncoder().encode(`candle-vault/v2/user|${vaultId}|${envelopeId}`))
}

export function userNameFor(vaultId: string, envelopeId: string): string {
  return `candle vault ${vaultId.slice(0, 8)} ${envelopeId}`
}

/**
 * ED-11's independent check, before anything is derived: the authenticator data must be long
 * enough to carry flags, must be for THIS relying party, and must have the UV flag set. The helper
 * already refused to proceed without user verification; this is the side that does not trust it.
 */
export function assertAuthenticatorData(authData: Uint8Array, rpId: string, what: string): void {
  if (authData.length < AUTHDATA_MIN_LENGTH) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The security key's ${what} returned truncated authenticator data; nothing was derived.`,
    )
  }
  const expected = sha256(new TextEncoder().encode(rpId))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (authData[i] ?? 0) ^ (expected[i] ?? 0)
  if (diff !== 0) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The security key's ${what} is for a different relying party than ${rpId}; nothing was derived.`,
    )
  }
  if (((authData[32] ?? 0) & AUTHDATA_FLAG_UV) === 0) {
    throw new VaultError(
      "VAULT_UNLOCK_FAILED",
      `The security key's ${what} was made without user verification (the UV flag is clear), so its output is not this envelope's key; nothing was derived.`,
      { suggestion: "This factor never falls back to the non-verified secret. Set a PIN on the key and retry." },
    )
  }
}

// ── The two ceremonies ────────────────────────────────────────────────────────────────────────

export interface SecurityKeySession {
  helperPath: string
  device: DeviceReport
  snapshotId: string
  /** Present only when the key reported `clientPin: true` and the operator typed one. */
  pin?: string
}

type SessionDeps = Pick<Deps, "env" | "execPath" | "realpath" | "spawnHelper" | "platform" | "stderr" | "promptSecret">

/**
 * Finds the helper, lists the keys, applies the operator's selection, and collects the PIN a
 * PIN-only key will need. Nothing here touches the vault, so a refusal costs no passphrase.
 */
export async function openSecurityKeySession(
  deps: SessionDeps,
  opts: { vaultId: string; envelopeId: string; deviceFlag?: string; requireFeatures: boolean },
): Promise<SecurityKeySession> {
  const location = await locateFido2Helper(deps)
  if (location.state === "absent") throw helperMissing(location)
  const info = await callHelper<InfoResponse>(deps, location.path, {
    op: "info",
    vaultId: opts.vaultId,
    envelopeId: opts.envelopeId,
    digest: base64.encode(
      operationDigest({ vaultId: opts.vaultId, envelopeId: opts.envelopeId, op: "info", nonce: b64u(randomBytes(16)) }),
    ),
  })
  const device = selectDevice(info.devices, opts.deviceFlag, deps.platform)
  if (opts.deviceFlag === undefined) {
    deps.stderr.write(
      `Using the attached security key: ${device.product || "security key"} (--device ${device.deviceId})\n`,
    )
  }
  if (opts.requireFeatures) {
    // ED-11's two refusals at `factor add`, made in the CLI as well as in the helper, so the
    // operator is refused before typing a PIN into a key that cannot serve the factor.
    if (!device.extensions.includes("hmac-secret")) {
      throw new VaultError(
        "VAULT_PRF_UNSUPPORTED",
        `${device.product || "This security key"} does not support the hmac-secret extension, which this factor needs.`,
        { suggestion: "Use a key that supports hmac-secret (FIDO2 with PRF). No other derivation is substituted." },
      )
    }
    if (device.options.clientPin !== true && device.options.uv !== true) {
      throw new VaultError(
        "VAULT_UV_UNSUPPORTED",
        `${device.product || "This security key"} has no PIN set and no built-in user verification, and this factor uses the user-verified secret only.`,
        { suggestion: "Set a PIN on this key (its vendor's tool does that) and retry. Nothing was written." },
      )
    }
  }
  const session: SecurityKeySession = { helperPath: location.path, device, snapshotId: info.snapshotId }
  if (device.options.clientPin === true) {
    // The CLI owns the prompt (ED-11). The PIN arrives as a JavaScript string with CC-04's stated
    // lifetime caveat, the same as the passphrase, and reaches the helper inside its request only.
    const typed = await deps.promptSecret(`PIN for ${device.product || "the security key"} (input hidden): `)
    if (typed === "") {
      throw new VaultError(
        "VAULT_PIN_REQUIRED",
        "This security key needs its PIN and none was typed; nothing was sent to it.",
      )
    }
    session.pin = typed
  }
  return session
}

export interface RegisteredCredential {
  /** base64url, as the envelope stores it. */
  credentialId: string
  aaguid: string
  backupEligible: boolean
  backupState: boolean
}

/** Registers the discoverable, user-verified, hmac-secret credential ED-11 describes. */
export async function registerCredential(
  deps: SessionDeps,
  session: SecurityKeySession,
  opts: { vaultId: string; envelopeId: string },
): Promise<RegisteredCredential> {
  deps.stderr.write(`Touch ${session.device.product || "the security key"} to register the vault's credential on it.\n`)
  const digest = operationDigest({ ...opts, op: "register", nonce: b64u(randomBytes(16)) })
  const response = await callHelper<RegisterResponse>(deps, session.helperPath, {
    op: "register",
    vaultId: opts.vaultId,
    envelopeId: opts.envelopeId,
    digest: base64.encode(digest),
    deviceId: session.device.deviceId,
    expectSnapshot: session.snapshotId,
    rpId: RP_ID,
    userId: base64.encode(userIdFor(opts.vaultId, opts.envelopeId)),
    userName: userNameFor(opts.vaultId, opts.envelopeId),
    clientDataHash: base64.encode(digest),
    ...(session.pin !== undefined ? { pin: session.pin } : {}),
  })
  const authData = base64.decode(response.authData)
  assertAuthenticatorData(authData, RP_ID, "registration")
  return {
    credentialId: b64u(base64.decode(response.credentialId)),
    aaguid: response.aaguid,
    backupEligible: response.attFlags.be,
    backupState: response.attFlags.bs,
  }
}

/**
 * One user-verified assertion against the envelope's credential, yielding the 32-byte PRF output
 * the KEK is derived from. The caller owns the returned buffer and zeroes it; it is tracked as a
 * secret for T36's seam.
 */
export async function assertPrf(
  deps: SessionDeps,
  session: SecurityKeySession,
  envelope: Ctap2Envelope,
  vaultId: string,
  purpose: string,
): Promise<Uint8Array> {
  deps.stderr.write(`Touch ${session.device.product || "the security key"} to ${purpose}.\n`)
  const digest = operationDigest({ vaultId, envelopeId: envelope.id, op: "assert", nonce: b64u(randomBytes(16)) })
  const salt = prfSaltForAuthenticator(unb64u(envelope.prfSalt, "prfSalt"))
  const response = await callHelper<Extract<HelperResponse, { op: "assert" }>>(deps, session.helperPath, {
    op: "assert",
    vaultId,
    envelopeId: envelope.id,
    digest: base64.encode(digest),
    deviceId: session.device.deviceId,
    expectSnapshot: session.snapshotId,
    rpId: envelope.rpId,
    credentialId: base64.encode(unb64u(envelope.credentialId, "credentialId")),
    clientDataHash: base64.encode(digest),
    salt: base64.encode(salt),
    ...(session.pin !== undefined ? { pin: session.pin } : {}),
  })
  const prfOutput = ownSecret(base64.decode(response.hmacSecret))
  try {
    assertAuthenticatorData(base64.decode(response.authData), envelope.rpId, "assertion")
    if (prfOutput.length !== PRF_OUTPUT_BYTES) {
      throw new VaultError(
        "VAULT_UNLOCK_FAILED",
        `The security key returned ${prfOutput.length} bytes of hmac-secret output; this factor needs ${PRF_OUTPUT_BYTES}. Nothing was derived.`,
      )
    }
  } catch (error) {
    wipe(prfOutput)
    throw error
  }
  return prfOutput
}
