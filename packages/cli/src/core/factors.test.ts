/**
 * BE-1680 (spec S4 F-1 to F-3, T4-16): the factors the core accepts. A fixture machine without the
 * helper lists Touch ID under "not usable" with the CLI's reason; a security key approves a
 * transfer; an unavailable factor returns the user to the picker and never counts toward the
 * lockout. Fixtures only: fake platform facts and fake factor helpers.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { Envelope } from "../vault/format"
import type { PlatformFacts } from "../vault/platform"
import type { Card } from "./cards"
import { CORE_HELPER_REASON, factorFailureKind, factorOptions } from "./factors"
import { DEST_A, PIN_OK, PIN_WRONG, RIGHT, startKit, vaultSend } from "./s4-test-kit"

const PASSPHRASE = { id: "e1", factor: "passphrase" } as unknown as Envelope
const SECURITY_KEY = { id: "e2", factor: "passkey-prf", transport: "ctap2" } as unknown as Envelope
const TOUCH_ID = { id: "e3", factor: "secure-enclave" } as unknown as Envelope

const linuxNoHelper: PlatformFacts = {
  platform: "linux",
  arch: "x64",
  fido2Helper: { state: "absent", reason: "no candle-fido2 beside the candle binary (an npm install ships none)" },
}
const macOmitted: PlatformFacts = {
  platform: "darwin",
  arch: "arm64",
  fido2Helper: { state: "ready", path: "/opt/candle/candle-fido2" },
  enclaveHelper: {
    state: "omitted",
    reason:
      "this build's release policy omits the signed Secure Enclave helper, so the Touch ID factor is not in this build",
  },
}
const macSigned = {
  platform: "darwin",
  arch: "arm64",
  fido2Helper: { state: "ready", path: "/opt/candle/candle-fido2" },
  enclaveHelper: {
    state: "ready",
    appPath: "/opt/candle/candle-enclave.app",
    path: "/opt/candle/candle-enclave.app/Contents/MacOS/candle-enclave",
    source: "beside-binary",
    identity: { teamId: "TEAM", bundleId: "tv.candle.cli.enclave" },
    version: "1.0.0",
    secureEnclave: true,
    biometry: "available",
    associatedDomains: [],
    provisioningProfile: true,
  },
} as unknown as PlatformFacts

describe("F-1 and F-2: the picker's list (T4-16)", () => {
  test("a machine without the helper: passphrase usable first, then Touch ID and the key under not usable, with reasons", () => {
    const options = factorOptions([PASSPHRASE, SECURITY_KEY], linuxNoHelper)
    expect(options[0]).toEqual({ type: "passphrase", usable: true })
    expect(options.find((o) => o.type === "touch-id")).toEqual({
      type: "touch-id",
      usable: false,
      reason: "the Secure Enclave is macOS only",
    })
    expect(options.find((o) => o.type === "security-key")).toMatchObject({
      usable: false,
      reason: expect.stringContaining("candle-fido2"),
    })
  })

  test("a build that omits the helper says Touch ID is not in this build; a key with its helper is usable", () => {
    const options = factorOptions([PASSPHRASE, SECURITY_KEY, TOUCH_ID], macOmitted)
    expect(options.map((o) => [o.type, o.usable])).toEqual([
      ["passphrase", true],
      ["security-key", true],
      ["touch-id", false],
    ])
    expect(options[2]?.reason).toContain("not in this build")
  })

  test("F-3: even a signed helper on a Mac with an Enclave is not used by the core until V-2 passes", () => {
    const options = factorOptions([PASSPHRASE, TOUCH_ID], macSigned)
    expect(options.find((o) => o.type === "touch-id")).toEqual({
      type: "touch-id",
      usable: false,
      reason: CORE_HELPER_REASON,
    })
  })

  test("the CLI's vault errors sort into a wrong factor or an unavailable one", () => {
    expect(factorFailureKind("VAULT_UNLOCK_FAILED")).toBe("rejected")
    expect(factorFailureKind("VAULT_PIN_INVALID")).toBe("rejected")
    for (const code of [
      "VAULT_FACTOR_UNAVAILABLE",
      "VAULT_HELPER_MISSING",
      "VAULT_AUTHENTICATOR_CANCELLED",
      "VAULT_PIN_REQUIRED",
    ]) {
      expect(factorFailureKind(code)).toBe("unavailable")
    }
    expect(factorFailureKind("VAULT_BLOB_TAMPERED")).toBeUndefined()
  })
})

describe("a security key approves a transfer; an unavailable factor counts nothing (T4-16)", () => {
  const kits: { close(): Promise<void> }[] = []
  afterEach(async () => {
    for (const kit of kits.splice(0)) await kit.close()
  })

  test("the PIN rides once with the approval, and the send names itself as the reason", async () => {
    const k = await startKit()
    kits.push(k)
    const view = await k.view()
    const settings = (await view.request("settings.get")).result as { factors: { type: string; usable: boolean }[] }
    expect(settings.factors.map((f) => [f.type, f.usable])).toEqual([
      ["passphrase", true],
      ["security-key", true],
      ["touch-id", false],
    ])
    const card = (await view.request("transfer.prepare", vaultSend(DEST_A))).result as Card
    const approve = (factor: unknown) =>
      view.request("cards.approve", {
        cardId: card.cardId,
        cardHash: card.cardHash,
        confirm: { typed: "confirm" },
        factor,
      })
    expect((await approve({ type: "touch-id" })).error?.data?.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect((await approve({ type: "security-key", pin: PIN_WRONG })).error?.data?.code).toBe("FACTOR_REJECTED")
    const approved = await approve({ type: "security-key", pin: PIN_OK })
    expect(approved.result).toMatchObject({ operation: { state: "pending" } })
    expect(k.helper).toEqual([
      { type: "security-key", reason: `send 1.5 SOL to ${DEST_A}` },
      { type: "security-key", reason: `send 1.5 SOL to ${DEST_A}` },
    ])
    expect(k.trading.snapshot().approvalsLockedUntil).toBeNull()
  })

  test("with no key attached, the key is unavailable and the passphrase still works, with no lockout count", async () => {
    const k = await startKit({ securityKeyAttached: false })
    kits.push(k)
    const view = await k.view()
    const card = (await view.request("transfer.prepare", vaultSend(DEST_A))).result as Card
    const approve = (factor: unknown) =>
      view.request("cards.approve", {
        cardId: card.cardId,
        cardHash: card.cardHash,
        confirm: { typed: "confirm" },
        factor,
      })
    for (let i = 0; i < 6; i++)
      expect((await approve({ type: "security-key" })).error?.data?.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect(k.trading.snapshot().approvalsLockedUntil).toBeNull()
    expect((await approve(RIGHT)).error).toBeUndefined()
  })
})
