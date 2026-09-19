/**
 * Ember Phase 2 (BE-140, helper protocols, ED-11, CC-12): the CLI's side of `candle-fido2`.
 *
 * The typed translation table (every helper code to the spec's code, an unknown code to
 * `VAULT_UNLOCK_FAILED`, the Linux `hidraw` sentence verbatim), where the helper is looked for and
 * what each absence says, the selection rules, the independent authenticator-data check, and the
 * real spawn seam driving the scripted helper over a real pipe, including the timeout that reaps a
 * helper wedged on a dead key.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import { libraryInstallInstruction, libraryMissingMessage } from "../fido2-helper/library-paths"
import {
  AUTHDATA_FLAG_UP,
  AUTHDATA_FLAG_UV,
  type DeviceReport,
  HELPER_CODES,
  HELPER_PROTOCOL,
  RP_ID,
} from "../fido2-helper/protocol"
import type { HelperScript } from "../fido2-helper/test-backend"
import { HELPER_WORKING_DIRECTORY, realSpawnHelper } from "../index"
import { createTestDeps } from "../test-support"
import { VAULT_ERROR_CODES, VaultError } from "./errors"
import {
  assertAuthenticatorData,
  callHelper,
  HELPER_ENV,
  HELPER_TIMEOUT_MS,
  locateFido2Helper,
  operationDigest,
  prfSaltForAuthenticator,
  selectDevice,
  translateHelperFailure,
  userIdFor,
} from "./fido2"
import { HIDRAW_MESSAGE } from "./platform"

setDefaultTimeout(30_000)

const unusedFetch = (async () => {
  throw new Error("no network in this file")
}) as unknown as typeof fetch

function authDataFor(rpId: string, flags: number): Uint8Array {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return out
}

const device = (overrides: Partial<DeviceReport> = {}): DeviceReport => ({
  deviceId: "abc123XY",
  path: "/dev/hidraw3",
  product: "YubiKey 5 NFC",
  manufacturer: "Yubico",
  aaguid: "2fc0579f811347eab116bb5a8db9202a",
  extensions: ["hmac-secret"],
  options: { clientPin: true, uv: false },
  readable: true,
  ...overrides,
})

describe("the typed translation table (helper protocols)", () => {
  const expected: Record<string, string> = {
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
    BAD_REQUEST: "VAULT_UNLOCK_FAILED",
    INTERNAL: "VAULT_UNLOCK_FAILED",
  }

  test("every helper code maps to a spec code, and every mapped code is one the spec lists", () => {
    for (const code of HELPER_CODES) {
      const translated = translateHelperFailure(code, "detail", "darwin")
      expect(translated, code).toBeInstanceOf(VaultError)
      expect(translated.code, code).toBe(expected[code] as never)
      expect(VAULT_ERROR_CODES).toContain(translated.code)
      // No translation ever names another factor as the way out.
      expect(`${translated.message} ${translated.suggestion ?? ""}`).not.toMatch(
        /passphrase instead|falling back|fallback to/i,
      )
    }
  })

  test("a code the CLI does not recognize is VAULT_UNLOCK_FAILED and says so", () => {
    const translated = translateHelperFailure("SOMETHING_NEW", "from a newer helper", "linux")
    expect(translated.code).toBe("VAULT_UNLOCK_FAILED")
    expect(translated.message).toContain("SOMETHING_NEW")
    expect(translated.suggestion).toContain("no other factor was tried")
  })

  // BE-198: the helper ran and only libfido2 is absent, so the way out is that install command,
  // not a reinstall of the CLI, and the human line stays the helper's own short one.
  test("LIBRARY_MISSING carries the install instruction, not the CLI reinstall advice", () => {
    for (const platform of ["darwin", "linux"]) {
      const translated = translateHelperFailure("LIBRARY_MISSING", libraryMissingMessage(platform), platform)
      expect(translated.code, platform).toBe("VAULT_HELPER_MISSING")
      expect(translated.suggestion, platform).toBe(`${libraryInstallInstruction(platform)}.`)
      expect(translated.suggestion, platform).not.toContain("CANDLE_FIDO2_HELPER")
      expect(translated.message, platform).toBe(libraryMissingMessage(platform))
      // Nothing of the loader's own diagnostics, and nothing near the 3 KB the old one printed.
      expect(translated.message, platform).not.toContain("tried:")
      expect(`${translated.message} ${translated.suggestion}`.length, platform).toBeLessThan(700)
    }
  })

  test("the Linux hidraw refusal prints CC-12's sentence verbatim; other platforms name the device", () => {
    const linux = translateHelperFailure("DEVICE_NOT_READABLE", "this user cannot open /dev/hidraw3", "linux")
    expect(linux.code).toBe("VAULT_AUTHENTICATOR_NOT_READABLE")
    expect(linux.message).toBe(HIDRAW_MESSAGE)
    expect(linux.message).not.toMatch(/sudo|root/)
    const mac = translateHelperFailure("DEVICE_NOT_READABLE", "IOHIDDeviceOpen refused", "darwin")
    expect(mac.code).toBe("VAULT_AUTHENTICATOR_NOT_READABLE")
    expect(mac.message).toContain("IOHIDDeviceOpen refused")
  })
})

describe("where the helper is looked for", () => {
  test("CANDLE_FIDO2_HELPER wins when it names an executable, and is refused by name when it does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-locate-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\nexit 0\n")
    await chmod(helper, 0o755)
    const deps = createTestDeps({ fetch: unusedFetch, env: { [HELPER_ENV]: helper } })
    expect(await locateFido2Helper(deps)).toEqual({ state: "ready", path: helper, source: "env" })

    const bogus = createTestDeps({ fetch: unusedFetch, env: { [HELPER_ENV]: join(dir, "missing") } })
    const located = await locateFido2Helper(bogus)
    expect(located.state).toBe("absent")
    if (located.state === "absent") expect(located.reason).toContain(join(dir, "missing"))
  })

  test("a compiled binary looks beside its real path; the npm package ships no helper and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-beside-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\nexit 0\n")
    await chmod(helper, 0o755)
    // Homebrew's bin/candle is a symlink into the Cellar; the helper sits beside the REAL file.
    const compiled = createTestDeps({
      fetch: unusedFetch,
      execPath: "/opt/homebrew/bin/candle",
      realpath: async () => join(dir, "candle"),
    })
    expect(await locateFido2Helper(compiled)).toEqual({ state: "ready", path: helper, source: "beside-binary" })

    const bare = createTestDeps({ fetch: unusedFetch, execPath: join(tmpdir(), "nowhere", "candle") })
    const located = await locateFido2Helper(bare)
    expect(located.state).toBe("absent")
    if (located.state === "absent") expect(located.reason).toContain("no candle-fido2 executable beside")

    // createTestDeps's defaults are an npm install: node runs dist/index.js.
    const npm = createTestDeps({ fetch: unusedFetch })
    const fromNpm = await locateFido2Helper(npm)
    expect(fromNpm.state).toBe("absent")
    if (fromNpm.state === "absent") expect(fromNpm.reason).toContain("npm package")
  })
})

describe("selection is the operator's", () => {
  test("one attached and none named is that one; several and none named is AMBIGUOUS with --device beside each", () => {
    const one = device()
    expect(selectDevice([one], undefined, "linux")).toBe(one)
    const two = [device(), device({ deviceId: "def456ZZ", path: "/dev/hidraw4" })]
    let thrown: unknown
    try {
      selectDevice(two, undefined, "linux")
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_AUTHENTICATOR_AMBIGUOUS")
    expect((thrown as VaultError).message).toContain("--device abc123XY")
    expect((thrown as VaultError).message).toContain("--device def456ZZ")
    expect((thrown as VaultError).message).toContain("nothing was sent to any of them")
  })

  test("a named id picks exactly that device; an id not in the listing is refused with the listing", () => {
    const two = [device(), device({ deviceId: "def456ZZ", path: "/dev/hidraw4" })]
    expect(selectDevice(two, "def456ZZ", "linux").path).toBe("/dev/hidraw4")
    let thrown: unknown
    try {
      selectDevice(two, "zzzzzzzz", "linux")
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect((thrown as VaultError).message).toContain("zzzzzzzz")
    expect((thrown as VaultError).suggestion).toContain("No other key was tried")
  })

  test("no device is VAULT_FACTOR_UNAVAILABLE; an unreadable one is the hidraw refusal on Linux", () => {
    let thrown: unknown
    try {
      selectDevice([], undefined, "linux")
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_FACTOR_UNAVAILABLE")
    try {
      selectDevice(
        [device({ readable: false, reason: "DEVICE_NOT_READABLE: this user cannot open /dev/hidraw3" })],
        undefined,
        "linux",
      )
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_AUTHENTICATOR_NOT_READABLE")
    expect((thrown as VaultError).message).toBe(HIDRAW_MESSAGE)
  })
})

describe("the CLI's own checks before anything is derived (ED-11)", () => {
  test("the UV flag must be set, the relying party must match, and truncated data is refused", () => {
    expect(() =>
      assertAuthenticatorData(authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV), RP_ID, "assertion"),
    ).not.toThrow()
    const clear = () => assertAuthenticatorData(authDataFor(RP_ID, AUTHDATA_FLAG_UP), RP_ID, "assertion")
    expect(clear).toThrow("UV flag is clear")
    try {
      clear()
    } catch (error) {
      expect((error as VaultError).code).toBe("VAULT_UNLOCK_FAILED")
      expect((error as VaultError).suggestion).toContain("never falls back to the non-verified secret")
    }
    expect(() => assertAuthenticatorData(authDataFor("example.com", AUTHDATA_FLAG_UV), RP_ID, "assertion")).toThrow(
      "different relying party",
    )
    expect(() => assertAuthenticatorData(new Uint8Array(36), RP_ID, "assertion")).toThrow("truncated")
  })

  test("the salt handed to the authenticator is SHA-256 of the WebAuthn PRF prefix, a zero byte and prfSalt", () => {
    const prfSalt = new Uint8Array(32).fill(0x42)
    const expected = sha256(new Uint8Array([...new TextEncoder().encode("WebAuthn PRF"), 0x00, ...prfSalt]))
    expect(prfSaltForAuthenticator(prfSalt)).toEqual(expected)
    // Not the raw salt, and stable: the same credential yields the same KEK on a later path.
    expect(prfSaltForAuthenticator(prfSalt)).not.toEqual(prfSalt)
    expect(prfSaltForAuthenticator(prfSalt)).toEqual(prfSaltForAuthenticator(Uint8Array.from(prfSalt)))
  })

  test("the operation digest is 32 bytes and differs per operation; the user id differs per envelope", () => {
    const a = operationDigest({ vaultId: "v", envelopeId: "e", op: "assert", nonce: "n" })
    const b = operationDigest({ vaultId: "v", envelopeId: "e", op: "register", nonce: "n" })
    expect(a).toHaveLength(32)
    expect(a).not.toEqual(b)
    expect(userIdFor("v", "e1")).not.toEqual(userIdFor("v", "e2"))
    expect(userIdFor("v", "e1")).toHaveLength(32)
  })
})

describe("running the helper over a real pipe", () => {
  async function scriptedHelper(script: HelperScript): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-run-"))
    await writeFile(join(dir, "script.json"), JSON.stringify(script))
    const helper = join(dir, "candle-fido2")
    const scripted = join(import.meta.dir, "..", "fido2-helper", "scripted-helper.ts")
    await writeFile(helper, `#!/bin/sh\nexec bun "${scripted}" "${join(dir, "script.json")}"\n`)
    await chmod(helper, 0o755)
    return helper
  }

  const deps = { spawnHelper: realSpawnHelper, platform: "linux" }

  test("info round-trips through the real spawn seam, and the request never rides on argv", async () => {
    const helper = await scriptedHelper({
      devices: [
        {
          path: "/dev/hidraw3",
          product: "YubiKey 5 NFC",
          manufacturer: "Yubico",
          aaguid: "00".repeat(16),
          extensions: ["hmac-secret"],
          options: { clientPin: true },
        },
      ],
    })
    const response = await callHelper(deps, helper, {
      op: "info",
      vaultId: "v",
      envelopeId: "e",
      digest: base64.encode(new Uint8Array(32)),
    })
    expect(response.ok).toBe(true)
    expect(response.protocol).toBe(HELPER_PROTOCOL)
    if (response.op === "info") expect(response.devices[0]?.product).toBe("YubiKey 5 NFC")
  })

  test("a helper that cannot be started is VAULT_HELPER_MISSING with the install instruction", async () => {
    let thrown: unknown
    try {
      await callHelper(deps, join(tmpdir(), "no-such-candle-fido2"), {
        op: "info",
        vaultId: "v",
        envelopeId: "e",
        digest: base64.encode(new Uint8Array(32)),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_HELPER_MISSING")
    expect((thrown as VaultError).suggestion).toContain("CANDLE_FIDO2_HELPER")
  })

  // BE-198, defense in depth: whatever folder the operator ran `candle` from, the helper does not
  // start in it, so nothing planted there is on any relative path a loader could resolve.
  test("the helper starts in the root directory, never the working directory the CLI was run from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-cwd-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\npwd >&2\nexit 0\n")
    await chmod(helper, 0o755)
    const previousCwd = process.cwd()
    process.chdir(dir)
    let run: Awaited<ReturnType<typeof realSpawnHelper>>
    try {
      run = await realSpawnHelper(helper, "{}", { timeoutMs: 5_000 })
    } finally {
      process.chdir(previousCwd)
    }
    expect(HELPER_WORKING_DIRECTORY).toBe("/")
    expect(run.stderr.trim()).toBe(HELPER_WORKING_DIRECTORY)
    expect(run.stderr).not.toContain(dir)
  })

  test("a helper that prints no response is VAULT_UNLOCK_FAILED, never a fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-silent-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\necho 'something went wrong' >&2\nexit 3\n")
    await chmod(helper, 0o755)
    let thrown: unknown
    try {
      await callHelper(deps, helper, {
        op: "info",
        vaultId: "v",
        envelopeId: "e",
        digest: base64.encode(new Uint8Array(32)),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_UNLOCK_FAILED")
    expect((thrown as VaultError).message).toContain("something went wrong")
  })

  test("a helper speaking another protocol revision is VAULT_HELPER_MISSING (a stale install)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-stale-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, `#!/bin/sh\necho '{"ok":true,"protocol":99,"op":"info","snapshotId":"x","devices":[]}'\n`)
    await chmod(helper, 0o755)
    let thrown: unknown
    try {
      await callHelper(deps, helper, {
        op: "info",
        vaultId: "v",
        envelopeId: "e",
        digest: base64.encode(new Uint8Array(32)),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_HELPER_MISSING")
    expect((thrown as VaultError).message).toContain("protocol 99")
  })

  test("the timeout terminates a wedged helper, and the signal is reported as a cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-fido2-wedged-"))
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\nsleep 30\n")
    await chmod(helper, 0o755)
    const run = await realSpawnHelper(helper, "{}", { timeoutMs: 300 })
    expect(run.signal).toBe("SIGTERM")
    expect(run.stdout).toBe("")
    // The same outcome through the translation: nothing derived, a cancellation.
    let thrown: unknown
    try {
      await callHelper({ spawnHelper: async () => run, platform: "linux" }, helper, { op: "info" })
    } catch (error) {
      thrown = error
    }
    expect((thrown as VaultError).code).toBe("VAULT_AUTHENTICATOR_CANCELLED")
    expect(HELPER_TIMEOUT_MS).toBeGreaterThan(30_000)
  })
})
