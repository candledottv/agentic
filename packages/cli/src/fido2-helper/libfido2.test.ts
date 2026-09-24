/**
 * Ember Phase 2 (BE-140, ED-11): the libfido2 backend against the REAL library, with no key attached.
 *
 * What this can prove without hardware: every symbol the binding declares resolves in a real
 * libfido2 (a typo or a symbol from a newer release would fail `dlopen` here, not on an operator's
 * Mac), `fido_init` and `fido_dev_info_manifest` round-trip through the FFI, an empty enumeration
 * is reported as `NO_DEVICE`, and the return-code translation table maps each CTAP status the spec
 * names to its typed code. What it cannot prove is T47, which stays a hardware gate.
 *
 * Skipped, and named as skipped, on a machine without libfido2; the PR records whether it ran.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { base64 } from "@scure/base"
import { helperErrorForRc, type LibraryOpener, openLibfido2, probeOutcomeForRc } from "./libfido2"
import { libraryCandidates, libraryInstallInstruction, libraryMissingMessage } from "./library-paths"
import { type Fido2Backend, type HelperCode, HelperError, handleRequest } from "./protocol"

let backend: Fido2Backend | null = null
let missing = ""
try {
  backend = openLibfido2()
} catch (error) {
  missing = error instanceof Error ? error.message : String(error)
}

/** The two platforms this backend is built for, as literals `openLibfido2` accepts. */
const PLATFORMS = ["darwin", "linux"] as const

describe("libfido2 through bun:ffi", () => {
  test.skipIf(backend === null)("every declared symbol resolves and an empty enumeration is NO_DEVICE", () => {
    const real = backend as Fido2Backend
    expect(real.enumerate()).toEqual([])
    const response = handleRequest(
      {
        op: "assert",
        vaultId: "v",
        envelopeId: "e",
        digest: base64.encode(new Uint8Array(32)),
        deviceId: "none",
        rpId: "cli.candle.tv",
        credentialId: base64.encode(new Uint8Array(16)),
        clientDataHash: base64.encode(new Uint8Array(32)),
        salt: base64.encode(new Uint8Array(32)),
      },
      real,
    )
    expect(response).toMatchObject({ ok: false, code: "NO_DEVICE" })
  })

  test.skipIf(backend !== null)("without the library, opening it is a typed LIBRARY_MISSING naming the install", () => {
    expect(missing).toContain("could not load libfido2")
    expect(missing).toContain(libraryInstallInstruction(process.platform).slice(0, 20))
  })

  test("a machine without the library gets LIBRARY_MISSING with the install instruction for its platform", () => {
    let thrown: unknown
    try {
      openLibfido2("linux", ["/nonexistent/libfido2.so.1"])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HelperError)
    expect((thrown as HelperError).code).toBe("LIBRARY_MISSING")
    expect(libraryInstallInstruction("darwin")).toContain("brew install libfido2")
  })

  // BE-198. The bare sonames this list used to start with went through the loader's own search,
  // and on macOS that search reads the working directory the helper inherited from the CLI.
  test("every candidate on both platforms is an absolute path, so no loader search is ever used", () => {
    for (const platform of PLATFORMS) {
      const candidates = libraryCandidates(platform)
      expect(candidates.length, platform).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(isAbsolute(candidate), `${platform}: ${candidate}`).toBe(true)
        // An absolute path that still contains a traversal segment would resolve elsewhere.
        expect(resolve(candidate), `${platform}: ${candidate}`).toBe(candidate)
      }
    }
    expect(libraryCandidates("darwin")).toContain("/opt/homebrew/lib/libfido2.dylib")
    expect(libraryCandidates("linux")).toContain("/usr/local/lib/libfido2.so.1")
  })

  test("a library planted in the working directory is never one of the paths handed to the loader", () => {
    const planted = realpathSync(mkdtempSync(join(tmpdir(), "candle-fido2-cwd-")))
    const previousCwd = process.cwd()
    const attempted: string[] = []
    try {
      // One file per candidate leaf name, exactly what an attacker would drop into a repo or a
      // downloads folder the operator runs `candle vault` from.
      for (const platform of PLATFORMS) {
        for (const candidate of libraryCandidates(platform)) {
          writeFileSync(join(planted, basename(candidate)), "planted")
        }
      }
      process.chdir(planted)
      for (const platform of PLATFORMS) {
        expect(() =>
          openLibfido2(platform, libraryCandidates(platform), (path) => {
            attempted.push(path)
            throw new Error("not loaded by this test")
          }),
        ).toThrow(HelperError)
      }
    } finally {
      process.chdir(previousCwd)
    }
    expect(attempted.length).toBe(libraryCandidates("darwin").length + libraryCandidates("linux").length)
    for (const path of attempted) {
      expect(isAbsolute(path), path).toBe(true)
      expect(resolve(path).startsWith(`${planted}/`), path).toBe(false)
    }
  })

  test("the missing-library refusal is the install instruction and the paths checked, and nothing else", () => {
    for (const platform of PLATFORMS) {
      let thrown: unknown
      try {
        openLibfido2(platform, libraryCandidates(platform), () => {
          // A loader failure carries pages of `tried:` lines; none of it may reach the operator.
          throw new Error(
            `dlopen failed\n${libraryCandidates(platform)
              .map((c) => `  tried: ${c}`)
              .join("\n")}`,
          )
        })
      } catch (error) {
        thrown = error
      }
      const message = (thrown as HelperError).message
      expect(message, platform).toBe(libraryMissingMessage(platform))
      expect(message, platform).toContain(libraryInstallInstruction(platform))
      for (const candidate of libraryCandidates(platform)) expect(message, platform).toContain(candidate)
      expect(message, platform).not.toContain("tried:")
      expect(message.length, platform).toBeLessThan(600)
    }
  })

  test("the return-code translation is the spec's table", () => {
    const describe = (rc: number) => `rc ${rc}`
    const expectCode = (rc: number, code: HelperCode) => expect(helperErrorForRc(rc, describe).code).toBe(code)
    expectCode(0x36, "PIN_REQUIRED")
    expectCode(0x35, "UV_UNSUPPORTED")
    expectCode(0x31, "PIN_INVALID")
    expectCode(0x33, "PIN_INVALID")
    expectCode(0x3f, "PIN_INVALID")
    expectCode(0x32, "BLOCKED")
    expectCode(0x34, "BLOCKED")
    expectCode(0x3c, "BLOCKED")
    expectCode(0x2f, "CANCELLED")
    expectCode(0x2d, "CANCELLED")
    expectCode(0x27, "CANCELLED")
    expectCode(0x05, "CANCELLED")
    expectCode(0x2e, "NO_CREDENTIAL")
    expectCode(0x22, "NO_CREDENTIAL")
    expectCode(0x16, "PRF_UNSUPPORTED")
    expectCode(0x2b, "UV_UNSUPPORTED")
    expectCode(-1, "DEVICE_IO")
    expectCode(-2, "DEVICE_IO")
    expectCode(-9, "DEVICE_IO")
    expectCode(0x28, "INTERNAL")
    expectCode(0x99, "INTERNAL")
    expect(helperErrorForRc(0x99, describe).message).toContain("rc 153")
  })
})

/**
 * BE-294 (D2, T13): the probe's FFI calls, against a recording stand-in for the library. What a
 * real key does with them is T47's; what this proves is the shape: `up` false, no `uv`, no PIN,
 * no extension and no salt, one credential in the allow list, and only the count read back.
 */
describe("libfido2 probeCredential", () => {
  function recordingLibrary(getAssertRc: number, count = 1) {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const returns: Record<string, unknown> = {
      fido_dev_new: 11,
      fido_assert_new: 22,
      fido_dev_get_assert: getAssertRc,
      fido_assert_count: BigInt(count),
    }
    const lib = new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: unknown[]) => {
            calls.push({ name, args })
            return name in returns ? returns[name] : 0
          },
      },
    )
    const backend = openLibfido2("darwin", ["/fake/libfido2.dylib"], (() => lib) as unknown as LibraryOpener)
    return { backend, calls }
  }
  const params = {
    rpId: "cli.candle.tv",
    credentialId: new Uint8Array(48).fill(1),
    clientDataHash: new Uint8Array(32).fill(7),
  }

  test("sets up false, and sets no uv, no extension, no salt and no PIN", () => {
    const { backend, calls } = recordingLibrary(0)
    expect(backend.probeCredential("ioreg://1", params)).toBe("present")
    const names = calls.map((call) => call.name)
    expect(calls.find((call) => call.name === "fido_assert_set_up")?.args[1]).toBe(1)
    for (const forbidden of ["fido_assert_set_uv", "fido_assert_set_extensions", "fido_assert_set_hmac_salt"]) {
      expect(names).not.toContain(forbidden)
    }
    expect(names.filter((name) => name === "fido_assert_allow_cred")).toHaveLength(1)
    expect(calls.find((call) => call.name === "fido_dev_get_assert")?.args[2]).toBeNull()
    for (const unread of ["fido_assert_authdata_ptr", "fido_assert_hmac_secret_ptr"])
      expect(names).not.toContain(unread)
    // The assertion and the device are released on every path.
    expect(names).toContain("fido_assert_free")
    expect(names).toContain("fido_dev_close")
  })

  test("no credentials is absent, and every other failure is unknown", () => {
    expect(recordingLibrary(0x2e).backend.probeCredential("ioreg://1", params)).toBe("absent")
    expect(recordingLibrary(0x22).backend.probeCredential("ioreg://1", params)).toBe("unknown")
    expect(recordingLibrary(-1).backend.probeCredential("ioreg://1", params)).toBe("unknown")
    expect(recordingLibrary(0, 0).backend.probeCredential("ioreg://1", params)).toBe("unknown")
    expect(probeOutcomeForRc(0, 1)).toBe("present")
    expect(probeOutcomeForRc(0x2e, 0)).toBe("absent")
    expect(probeOutcomeForRc(0x36, 0)).toBe("unknown")
  })
})
