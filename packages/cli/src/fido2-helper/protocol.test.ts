/**
 * Ember Phase 2 (BE-140, helper protocols, ED-11): the `candle-fido2` protocol without a key.
 *
 * Every row of the helper's typed translation, the selection rules (one device fills itself in at
 * the CLI, several must be named, a named device is the only one touched), the snapshot check, the
 * feature detection ED-11 makes before a registration, and the one-line-in one-line-out loop over a
 * real pipe. The backend is scripted; everything above it is the code the compiled helper runs.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64, hex } from "@scure/base"
import { MAX_REQUEST_BYTES, readFirstLine, serveOnce, TERMINAL_REFUSAL } from "./io"
import {
  type AssertRequest,
  AUTHDATA_FLAG_BE,
  AUTHDATA_FLAG_BS,
  AUTHDATA_FLAG_UP,
  AUTHDATA_FLAG_UV,
  deviceIdFor,
  HELPER_CODES,
  HELPER_PROTOCOL,
  handleLine,
  handleRequest,
  type InfoResponse,
  parseRequest,
  type RegisterRequest,
  RP_ID,
  snapshotIdFor,
  unwrapCborByteString,
} from "./protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "./test-backend"

const DIGEST = base64.encode(new Uint8Array(32).fill(7))
const SALT = base64.encode(new Uint8Array(32).fill(9))
const CRED = base64.encode(new Uint8Array(48).fill(1))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"

/** Raw authenticator data for `rpId` with the given flags and a zero counter. */
export function authDataFor(rpId: string, flags: number): Uint8Array {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return out
}

const yubikey = (path: string, extra: Partial<HelperScript["devices"][number]> = {}) => ({
  path,
  product: "YubiKey 5 NFC",
  manufacturer: "Yubico",
  aaguid: AAGUID,
  extensions: ["hmac-secret", "credProtect"],
  options: { rk: true, clientPin: true, uv: false },
  ...extra,
})

function common(op: "info" | "register" | "assert") {
  return { op, vaultId: "vault-1", envelopeId: "env-1", digest: DIGEST }
}

function registerRequest(deviceId: string, extra: Partial<RegisterRequest> = {}): RegisterRequest {
  return {
    ...common("register"),
    op: "register",
    deviceId,
    rpId: RP_ID,
    userId: base64.encode(new Uint8Array(32).fill(3)),
    userName: "candle vault",
    clientDataHash: DIGEST,
    ...extra,
  }
}

function assertRequest(deviceId: string, extra: Partial<AssertRequest> = {}): AssertRequest {
  return {
    ...common("assert"),
    op: "assert",
    deviceId,
    rpId: RP_ID,
    credentialId: CRED,
    clientDataHash: DIGEST,
    salt: SALT,
    ...extra,
  }
}

function info(script: HelperScript): InfoResponse {
  const response = handleRequest({ ...common("info"), op: "info" }, scriptedBackend(script))
  if (!response.ok || response.op !== "info") throw new Error(`info failed: ${JSON.stringify(response)}`)
  return response
}

describe("request parsing", () => {
  test("refuses anything that is not one of the three operations, before any device is touched", () => {
    for (const line of [
      "nope",
      "[]",
      '{"op":"unlock"}',
      '{"op":"info"}',
      '{"op":"info","vaultId":"v","envelopeId":"e","digest":"short"}',
    ]) {
      const response = handleLine(line, () => {
        throw new Error("the backend must not be loaded for a malformed request")
      })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.code).toBe("BAD_REQUEST")
    }
  })

  test("register and assert require their fields, with fixed-length base64 checked", () => {
    expect(() => parseRequest(JSON.stringify({ ...registerRequest("d"), userId: undefined }))).toThrow("userId")
    expect(() =>
      parseRequest(JSON.stringify({ ...assertRequest("d"), salt: base64.encode(new Uint8Array(16)) })),
    ).toThrow("salt is 16 bytes")
    expect(() => parseRequest(JSON.stringify({ ...assertRequest("d"), clientDataHash: "!!" }))).toThrow("not base64")
    const parsed = parseRequest(JSON.stringify(assertRequest("d", { pin: "1234", expectSnapshot: "snap" })))
    expect(parsed.op).toBe("assert")
    if (parsed.op === "assert") {
      expect(parsed.pin).toBe("1234")
      expect(parsed.expectSnapshot).toBe("snap")
    }
  })
})

describe("info: the locator and the snapshot", () => {
  test("a device id is derived from the AAGUID and the path, and is not the path", () => {
    const a = deviceIdFor({ path: "/dev/hidraw3", aaguid: AAGUID })
    const b = deviceIdFor({ path: "/dev/hidraw4", aaguid: AAGUID })
    expect(a).not.toBe(b)
    expect(a).toHaveLength(8)
    expect(a).not.toContain("/")
    // Two keys of the same model on different paths get different locators (T47's same-model row
    // is the hardware half; this is the half the locator construction can prove alone).
    const response = info({ devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")] })
    expect(new Set(response.devices.map((device) => device.deviceId)).size).toBe(2)
    expect(response.devices.every((device) => device.aaguid === AAGUID)).toBe(true)
  })

  test("the snapshot is a digest of the set, order-independent, and changes when the set does", () => {
    const one = info({ devices: [yubikey("/dev/hidraw3")] })
    const two = info({ devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")] })
    const twoReversed = info({ devices: [yubikey("/dev/hidraw4"), yubikey("/dev/hidraw3")] })
    expect(one.snapshotId).not.toBe(two.snapshotId)
    expect(two.snapshotId).toBe(twoReversed.snapshotId)
    expect(snapshotIdFor([])).toBe(info({ devices: [] }).snapshotId)
  })

  test("a device this user cannot open is listed as unreadable rather than dropped", () => {
    const response = info({ devices: [yubikey("/dev/hidraw3", { unreadable: true })] })
    expect(response.devices).toHaveLength(1)
    expect(response.devices[0]?.readable).toBe(false)
    expect(response.devices[0]?.reason).toContain("DEVICE_NOT_READABLE")
    expect(response.devices[0]?.extensions).toEqual([])
  })

  test("getInfo options are reported as true, false or null (not listed)", () => {
    const response = info({ devices: [yubikey("/dev/hidraw3", { options: { rk: true } })] })
    expect(response.devices[0]?.options).toEqual({ clientPin: null, uv: null })
  })
})

describe("selection: the named device and nothing else", () => {
  test("no device attached is NO_DEVICE", () => {
    const response = handleRequest(assertRequest("anything"), scriptedBackend({ devices: [] }))
    expect(response).toMatchObject({ ok: false, code: "NO_DEVICE" })
  })

  test("a device id not in this enumeration is DEVICE_NOT_FOUND and nothing reaches any key", () => {
    const calls: BackendLogEntry[] = []
    const script: HelperScript = { devices: [yubikey("/dev/hidraw3")] }
    const response = handleRequest(
      assertRequest("nope1234"),
      scriptedBackend(script, (entry) => calls.push(entry)),
    )
    expect(response).toMatchObject({ ok: false, code: "DEVICE_NOT_FOUND" })
    expect(calls).toEqual([])
  })

  test("a changed set between listing and use is SNAPSHOT_CHANGED with nothing sent to any key", () => {
    const calls: BackendLogEntry[] = []
    const before = info({ devices: [yubikey("/dev/hidraw3")] })
    const now: HelperScript = { devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")] }
    const id = before.devices[0]?.deviceId as string
    const response = handleRequest(
      assertRequest(id, { expectSnapshot: before.snapshotId }),
      scriptedBackend(now, (entry) => calls.push(entry)),
    )
    expect(response).toMatchObject({ ok: false, code: "SNAPSHOT_CHANGED" })
    expect(calls).toEqual([])
  })

  test("with two keys attached, only the named one receives the PIN and the assertion", () => {
    const calls: BackendLogEntry[] = []
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")],
      assert: { hmacSecret: SALT, authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)) },
    }
    const listed = info(script)
    const second = listed.devices[1] as InfoResponse["devices"][number]
    const response = handleRequest(
      assertRequest(second.deviceId, { pin: "123456", expectSnapshot: listed.snapshotId }),
      scriptedBackend(script, (entry) => calls.push(entry)),
    )
    expect(response.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ op: "assert", path: second.path, pin: "123456" })
  })

  test("a named device that is unreadable is DEVICE_NOT_READABLE", () => {
    const script: HelperScript = { devices: [yubikey("/dev/hidraw3", { unreadable: true })] }
    const id = info(script).devices[0]?.deviceId as string
    expect(handleRequest(assertRequest(id), scriptedBackend(script))).toMatchObject({
      ok: false,
      code: "DEVICE_NOT_READABLE",
    })
  })
})

describe("register: ED-11's feature detection before the key is asked anything", () => {
  test("a key without hmac-secret is PRF_UNSUPPORTED and makeCredential is never called", () => {
    const calls: BackendLogEntry[] = []
    const script: HelperScript = { devices: [yubikey("/dev/hidraw3", { extensions: ["credProtect"] })] }
    const id = info(script).devices[0]?.deviceId as string
    const response = handleRequest(
      registerRequest(id),
      scriptedBackend(script, (entry) => calls.push(entry)),
    )
    expect(response).toMatchObject({ ok: false, code: "PRF_UNSUPPORTED" })
    expect(calls).toEqual([])
  })

  test("a key with neither a PIN set nor built-in UV is UV_UNSUPPORTED, never the non-verified secret", () => {
    const calls: BackendLogEntry[] = []
    const cases: Record<string, boolean>[] = [{ clientPin: false, uv: false }, { clientPin: false }, {}]
    for (const options of cases) {
      const script: HelperScript = { devices: [yubikey("/dev/hidraw3", { options })] }
      const id = info(script).devices[0]?.deviceId as string
      const response = handleRequest(
        registerRequest(id),
        scriptedBackend(script, (entry) => calls.push(entry)),
      )
      expect(response).toMatchObject({ ok: false, code: "UV_UNSUPPORTED" })
    }
    expect(calls).toEqual([])
  })

  test("a biometric key with no PIN (uv: true, clientPin: false) is accepted", () => {
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3", { options: { clientPin: false, uv: true } })],
      register: {
        credentialId: CRED,
        aaguid: AAGUID,
        authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)),
      },
    }
    const id = info(script).devices[0]?.deviceId as string
    expect(handleRequest(registerRequest(id), scriptedBackend(script)).ok).toBe(true)
  })

  test("a successful registration reports the credential, the AAGUID, raw authData and the BE/BS flags", () => {
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3")],
      register: {
        credentialId: CRED,
        aaguid: AAGUID,
        authData: base64.encode(
          authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV | AUTHDATA_FLAG_BE | AUTHDATA_FLAG_BS),
        ),
      },
    }
    const listed = info(script)
    const response = handleRequest(
      registerRequest(listed.devices[0]?.deviceId as string, { expectSnapshot: listed.snapshotId, pin: "123456" }),
      scriptedBackend(script),
    )
    expect(response).toMatchObject({
      ok: true,
      protocol: HELPER_PROTOCOL,
      op: "register",
      credentialId: CRED,
      aaguid: AAGUID,
      attFlags: { be: true, bs: true },
      flags: { uv: true, up: true },
    })
  })
})

describe("assert: what comes back, and every typed failure", () => {
  test("a successful assertion carries the hmac-secret output, raw authData and the flags", () => {
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3")],
      assert: { hmacSecret: SALT, authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)) },
    }
    const id = info(script).devices[0]?.deviceId as string
    const response = handleRequest(assertRequest(id, { pin: "123456" }), scriptedBackend(script))
    expect(response).toMatchObject({ ok: true, op: "assert", hmacSecret: SALT, flags: { uv: true, up: true } })
  })

  test("an assertion the key made without user verification reports uv: false, and the CLI is what refuses it", () => {
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3")],
      assert: { hmacSecret: SALT, authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP)) },
    }
    const id = info(script).devices[0]?.deviceId as string
    const response = handleRequest(assertRequest(id), scriptedBackend(script))
    expect(response).toMatchObject({ ok: true, flags: { uv: false, up: true } })
  })

  test("no hmac-secret output on an otherwise successful assertion is PRF_UNSUPPORTED", () => {
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3")],
      assert: { hmacSecret: "", authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)) },
    }
    const id = info(script).devices[0]?.deviceId as string
    expect(handleRequest(assertRequest(id), scriptedBackend(script))).toMatchObject({
      ok: false,
      code: "PRF_UNSUPPORTED",
    })
  })

  test("every backend failure code passes through typed, and an unknown throw is INTERNAL", () => {
    for (const code of HELPER_CODES) {
      const script: HelperScript = {
        devices: [yubikey("/dev/hidraw3")],
        assert: { error: { code, message: `scripted ${code}` } },
      }
      const id = info(script).devices[0]?.deviceId as string
      const response = handleRequest(assertRequest(id), scriptedBackend(script))
      expect(response).toMatchObject({ ok: false, protocol: HELPER_PROTOCOL, code, message: `scripted ${code}` })
    }
    const backend = scriptedBackend({ devices: [yubikey("/dev/hidraw3")] })
    backend.getAssertion = () => {
      throw new TypeError("boom")
    }
    const id = info({ devices: [yubikey("/dev/hidraw3")] }).devices[0]?.deviceId as string
    expect(handleRequest(assertRequest(id), backend)).toMatchObject({ ok: false, code: "INTERNAL", message: "boom" })
  })
})

describe("authenticator data helpers", () => {
  test("the CBOR byte-string wrapper libfido2 returns is stripped, and anything else is refused", () => {
    const raw = authDataFor(RP_ID, AUTHDATA_FLAG_UV)
    const wrapped = new Uint8Array([0x58, raw.length, ...raw])
    expect(unwrapCborByteString(wrapped)).toEqual(raw)
    const long = new Uint8Array(300).fill(0xab)
    expect(unwrapCborByteString(new Uint8Array([0x59, 0x01, 0x2c, ...long]))).toEqual(long)
    expect(() => unwrapCborByteString(new Uint8Array([0xa1, 0x01]))).toThrow("not a CBOR byte string")
    expect(() => unwrapCborByteString(new Uint8Array([0x58, 5, 1, 2]))).toThrow("disagrees")
  })
})

describe("the loop: one line in, one line out, and never a terminal", () => {
  test("serveOnce refuses a stdin that is a terminal before reading a byte", async () => {
    let read = false
    const stdin = (async function* () {
      read = true
      yield "{}"
    })()
    const out: string[] = []
    const code = await serveOnce({ stdin, stdout: { write: (chunk) => out.push(chunk) }, stdinIsTTY: true }, () => {
      throw new Error("must not load")
    })
    expect(code).toBe(2)
    expect(read).toBe(false)
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, code: "BAD_REQUEST", message: TERMINAL_REFUSAL })
  })

  test("readFirstLine takes the first line only and refuses an oversized one", async () => {
    const stdin = (async function* () {
      yield new TextEncoder().encode('{"a":1}\n{"b"')
      yield new TextEncoder().encode(":2}\n")
    })()
    expect(await readFirstLine(stdin)).toBe('{"a":1}')
    const big = (async function* () {
      yield new Uint8Array(MAX_REQUEST_BYTES + 1).fill(0x61)
    })()
    expect(await readFirstLine(big)).toBeNull()
  })

  test("the scripted helper over a real pipe answers exactly one JSON line and exits by outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-"))
    const script: HelperScript = {
      devices: [yubikey("/dev/hidraw3")],
      assert: { hmacSecret: SALT, authData: base64.encode(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)) },
      log: join(dir, "log.jsonl"),
    }
    const scriptPath = join(dir, "script.json")
    await writeFile(scriptPath, JSON.stringify(script))
    const helper = join(import.meta.dir, "scripted-helper.ts")
    const runOnce = async (line: string) => {
      const proc = Bun.spawn(["bun", helper, scriptPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      proc.stdin.write(`${line}\n`)
      proc.stdin.end()
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return { code: await proc.exited, stdout, stderr }
    }
    const listed = await runOnce(JSON.stringify({ ...common("info"), op: "info" }))
    expect(listed.code).toBe(0)
    expect(listed.stdout.trim().split("\n")).toHaveLength(1)
    const parsed = JSON.parse(listed.stdout) as InfoResponse
    expect(parsed.devices[0]?.product).toBe("YubiKey 5 NFC")

    const asserted = await runOnce(
      JSON.stringify(
        assertRequest(parsed.devices[0]?.deviceId as string, { pin: "123456", expectSnapshot: parsed.snapshotId }),
      ),
    )
    expect(asserted.code).toBe(0)
    expect(JSON.parse(asserted.stdout)).toMatchObject({ ok: true, op: "assert", hmacSecret: SALT })
    // The PIN travelled inside the request on the pipe and reached the backend for the named path.
    const log = readFileSync(join(dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as BackendLogEntry)
    expect(log).toEqual([expect.objectContaining({ op: "assert", path: "/dev/hidraw3", pin: "123456" })])

    const refused = await runOnce("not json")
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "BAD_REQUEST" })
  })

  test("the helper sources have no prompt and no terminal read (ED-11, T47)", () => {
    const dir = import.meta.dir
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, name), "utf8")
      expect(source, name).not.toMatch(/node:readline|\/dev\/tty|promptSecret|promptLine|setRawMode/)
    }
  })
})

test("the helper's fixed relying party is the spec's", () => {
  expect(RP_ID).toBe("cli.candle.tv")
  expect(hex.encode(sha256(new TextEncoder().encode(RP_ID)))).toHaveLength(64)
})
