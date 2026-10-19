/**
 * BE-1665 (spec K-10): the core's redactor. Part of T-12; the journal half is journal.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { REDACTED, Redactor, withoutFactorValue } from "./redact"

const READ_KEY = `cndl_test_${"r".repeat(43)}`
const DEVICE_TOKEN = "dt_example_device_token_value"

describe("Redactor", () => {
  test("removes every registered value wherever it appears", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    expect(redactor.text(`upstream said: bad token ${DEVICE_TOKEN} (retry)`)).toBe(
      `upstream said: bad token ${REDACTED} (retry)`,
    )
  })

  test("removes a Candle API key by shape even when it was never registered", () => {
    expect(new Redactor().text(`401 for ${READ_KEY}`)).toBe(`401 for ${REDACTED}`)
  })

  test("removes key-carrying URL parameters and Bearer tokens", () => {
    const redactor = new Redactor()
    expect(redactor.text("GET https://rpc.example/?api-key=abc123secret&cluster=main")).toBe(
      `GET https://rpc.example/?api-key=${REDACTED}&cluster=main`,
    )
    expect(redactor.text("https://x/y?foo=1&api_key=zzz")).toBe(`https://x/y?foo=1&api_key=${REDACTED}`)
    expect(redactor.text("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  test("a longer registered secret that contains a shorter one is removed whole", () => {
    const redactor = new Redactor()
    redactor.add("abcdefgh")
    redactor.add("abcdefgh-ijklmnop")
    expect(redactor.text("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED} y`)
  })

  test("short and blank values are not registered, so ordinary text survives", () => {
    const redactor = new Redactor()
    redactor.add("abc")
    redactor.add("   ")
    redactor.add(undefined)
    expect(redactor.text("abc is fine")).toBe("abc is fine")
  })

  test("value() redacts deeply, replaces forbidden fields and strips a factor's value but not its type", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    const out: unknown = redactor.value({
      type: "cards.approve",
      factor: { type: "passphrase", value: "correct horse battery staple" },
      passphrase: "also never",
      nested: { list: [`token ${DEVICE_TOKEN}`, 3, null], ok: true },
    })
    expect(out).toEqual({
      type: "cards.approve",
      factor: { type: "passphrase" },
      passphrase: REDACTED,
      nested: { list: [`token ${REDACTED}`, 3, null], ok: true },
    })
    expect(JSON.stringify(out)).not.toContain("correct horse")
  })

  test("remove() forgets a value", () => {
    const redactor = new Redactor()
    redactor.add(DEVICE_TOKEN)
    redactor.remove(DEVICE_TOKEN)
    expect(redactor.text(DEVICE_TOKEN)).toBe(DEVICE_TOKEN)
  })

  test("withoutFactorValue keeps everything but the value", () => {
    expect(withoutFactorValue({ type: "touch-id", value: "x", envelopeId: "e1" })).toEqual({
      type: "touch-id",
      envelopeId: "e1",
    })
    expect(withoutFactorValue(undefined)).toBeUndefined()
  })
})
