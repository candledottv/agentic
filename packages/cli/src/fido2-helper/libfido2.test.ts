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
import { base64 } from "@scure/base"
import { helperErrorForRc, libraryCandidates, libraryInstallInstruction, openLibfido2 } from "./libfido2"
import { type Fido2Backend, type HelperCode, HelperError, handleRequest } from "./protocol"

let backend: Fido2Backend | null = null
let missing = ""
try {
  backend = openLibfido2()
} catch (error) {
  missing = error instanceof Error ? error.message : String(error)
}

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
    expect(libraryCandidates("darwin")[0]).toBe("libfido2.dylib")
    expect(libraryInstallInstruction("darwin")).toContain("brew install libfido2")
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
