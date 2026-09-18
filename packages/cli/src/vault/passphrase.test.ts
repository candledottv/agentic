/**
 * BE-178, finding 1: the one whitespace rule for vault passphrases, at both ends. A chosen
 * passphrase with surrounding whitespace is refused with a message that says so; an unlock tries
 * the typed form first and the trimmed form second, which is what rescues a vault CLI 0.10.0
 * created with the spaces kept.
 */
import { describe, expect, test } from "bun:test"
import { VaultError } from "./errors"
import { assertNoSurroundingWhitespace, assertOwnPassphraseAcceptable, passphraseAttempts } from "./passphrase"

describe("BE-178 finding 1: the whitespace rule", () => {
  test("a chosen passphrase with leading or trailing whitespace is refused, and the message says so", () => {
    for (const bad of [
      " sixteen characters long",
      "sixteen characters long ",
      "\tsixteen characters long\n",
      " sixteen characters long ",
    ]) {
      expect(() => assertOwnPassphraseAcceptable(bad)).toThrow(/must not begin or end with a space/)
      let refusal: unknown
      try {
        assertNoSurroundingWhitespace(bad)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(VaultError)
      expect((refusal as VaultError).code).toBe("VAULT_UNLOCK_FAILED")
      expect((refusal as VaultError).suggestion).toContain("Nothing was written")
    }
    expect(() => assertOwnPassphraseAcceptable("sixteen characters long")).not.toThrow()
    // Spaces INSIDE the passphrase are the operator's to choose; only the ends are refused.
    expect(() => assertOwnPassphraseAcceptable("sixteen  characters   long")).not.toThrow()
  })

  test("the whitespace refusal is checked before the length floor, so the message names the real fault", () => {
    expect(() => assertOwnPassphraseAcceptable(" short ")).toThrow(/must not begin or end/)
    expect(() => assertOwnPassphraseAcceptable("short")).toThrow(/at least 16 characters/)
  })

  test("passphraseAttempts: the typed form first, the trimmed form second, nothing for whitespace alone", () => {
    expect(passphraseAttempts("abc")).toEqual(["abc"])
    expect(passphraseAttempts("abc ")).toEqual(["abc ", "abc"])
    expect(passphraseAttempts("  abc")).toEqual(["  abc", "abc"])
    expect(passphraseAttempts("\tabc\n")).toEqual(["\tabc\n", "abc"])
    expect(passphraseAttempts("   ")).toEqual([])
    expect(passphraseAttempts("")).toEqual([])
  })
})
