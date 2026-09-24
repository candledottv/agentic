/**
 * BE-294 (D1, D3): the unlock factor menu as a pure function, against the spec's own §3 text.
 *
 * The end-to-end rows (the probe, the answers, `--factor`, `--device`, no TTY) run through `run()`
 * in `vault-security-key.test.ts` and `vault-passkey.test.ts`. This file pins the one shape those
 * cannot build on a single machine: two Touch ID envelopes, one drivable and one from another Mac.
 */
import { describe, expect, test } from "bun:test"
import type { Ctap2Envelope, Envelope, PlatformPasskeyEnvelope, SecureEnclaveEnvelope } from "../vault/format"
import { factorMenu, menuSafeText } from "./vault-support"

const key = (id: string, label: string, product = "YubiKey 5 NFC") =>
  ({ id, factor: "passkey-prf", transport: "ctap2", label, product }) as unknown as Ctap2Envelope
const enclave = (id: string, label: string) =>
  ({ id, factor: "secure-enclave", label }) as unknown as SecureEnclaveEnvelope
const passkey = (id: string, label: string) =>
  ({ id, factor: "passkey-prf", transport: "platform-macos", label }) as unknown as PlatformPasskeyEnvelope

describe("BE-294: factorMenu", () => {
  test("T1: the §3 menu, character for character", () => {
    const a = key("xrxbTJ8MeoA", "yubikey-a")
    const b = key("rMJOLhRyF8o", "yubikey-b")
    const menu = factorMenu({
      keys: [a, b],
      enclaves: [enclave("Zk3TqT0y1bE", "Touch ID")],
      passkeys: [],
      passphrase: true,
      unusable: [enclave("q9", "old-mbp") as unknown as Envelope],
      attached: {
        state: new Map([
          ["xrxbTJ8MeoA", "not attached"],
          ["rMJOLhRyF8o", "attached"],
        ]),
        holder: new Map([["rMJOLhRyF8o", "d1"]]),
      },
    })
    expect(menu.text).toBe(
      [
        "Unlock with:",
        "  1  yubikey-b  (security key, attached)      id rMJOLhRyF8o",
        "  2  yubikey-a  (security key, not attached)  id xrxbTJ8MeoA",
        "  3  Touch ID   (this Mac)                    id Zk3TqT0y1bE",
        "  4  Passphrase",
        "Not usable on this machine: old-mbp (Touch ID). Details: candle vault status",
        "> ",
      ].join("\n"),
    )
    // The attached row carries the device the probe found it on; the others carry none.
    expect(menu.rows[0]?.choice).toMatchObject({ kind: "security-key", preferDevice: "d1" })
    expect(menu.rows[1]?.choice).not.toHaveProperty("preferDevice")
    expect(menu.rows[3]?.choice).toEqual({ kind: "passphrase" })
    // No line ends in a space except the prompt itself.
    expect(
      menu.text
        .split("\n")
        .slice(0, -1)
        .every((line) => !line.endsWith(" ")),
    ).toBe(true)
  })

  test("without a probe answer the keys keep file order and carry no state", () => {
    const menu = factorMenu({
      keys: [key("A", "yubikey-a"), key("B", "yubikey-b")],
      enclaves: [],
      passkeys: [passkey("P", "synced passkey")],
      passphrase: false,
      unusable: [],
      attached: undefined,
    })
    expect(menu.text).toBe(
      [
        "Unlock with:",
        "  1  yubikey-a       (security key)  id A",
        "  2  yubikey-b       (security key)  id B",
        "  3  synced passkey                  id P",
        "> ",
      ].join("\n"),
    )
  })

  test("T12: an empty label falls back to the product, and two same-model keys differ by id", () => {
    const menu = factorMenu({
      keys: [key("A", ""), key("B", "   ")],
      enclaves: [enclave("E", "")],
      passkeys: [],
      passphrase: true,
      unusable: [],
      attached: undefined,
    })
    expect(menu.text).toContain("  1  YubiKey 5 NFC  (security key)  id A\n")
    expect(menu.text).toContain("  2  YubiKey 5 NFC  (security key)  id B\n")
    expect(menu.text).toContain("  3  Touch ID       (this Mac)      id E\n")
  })

  test("ten or more rows keep the columns aligned", () => {
    const keys = Array.from({ length: 10 }, (_, i) => key(`K${i}`, `key-${i}`))
    const menu = factorMenu({ keys, enclaves: [], passkeys: [], passphrase: true, unusable: [], attached: undefined })
    expect(menu.text).toContain("\n   1  key-0  (security key)  id K0\n")
    expect(menu.text).toContain("\n  11  Passphrase\n")
  })

  test("menuSafeText turns controls and every Bidi_Control character into spaces", () => {
    const bidi = "؜‎‏‪‫‬‭‮⁦⁧⁨⁩"
    expect(menuSafeText(`a\u001b[2J\nb${bidi}c\u0085d`)).toBe(`a [2J b${" ".repeat(bidi.length)}c d`)
    expect(menuSafeText("plain label")).toBe("plain label")
  })
})
