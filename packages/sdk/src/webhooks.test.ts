import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { verifyWebhookSignature } from "./webhooks"

const SECRET = "whsec_sdk_test_secret"
const BODY = JSON.stringify({ event: "launch.confirmed", clientLaunchId: "my-bot-run-42" })
const NOW_SEC = 1_754_400_000

function sign(secret: string, t: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")
  return `t=${t},v1=${v1}`
}

describe("verifyWebhookSignature", () => {
  test("a signature produced with node:crypto verifies", () => {
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC, BODY), BODY, NOW_SEC)).toBe(true)
  })

  test("pinned literal vector, so scheme drift breaks loudly", () => {
    // hmac-sha256("whsec_sdk_test_secret", "1754400000." + BODY), computed independently.
    const header = "t=1754400000,v1=de18381b7565317500fa6835a139bf132fc1ee6727dfd7a84389f3db19f37dcd"
    expect(verifyWebhookSignature(SECRET, header, BODY, NOW_SEC)).toBe(true)
  })

  test("uppercase hex digests are accepted", () => {
    const t = NOW_SEC
    const v1 = createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex").toUpperCase()
    expect(verifyWebhookSignature(SECRET, `t=${t},v1=${v1}`, BODY, NOW_SEC)).toBe(true)
  })

  test("unknown extra header keys are tolerated", () => {
    const header = `${sign(SECRET, NOW_SEC, BODY)},v2=someFutureScheme`
    expect(verifyWebhookSignature(SECRET, header, BODY, NOW_SEC)).toBe(true)
  })

  test("the wrong secret fails", () => {
    expect(verifyWebhookSignature("whsec_other", sign(SECRET, NOW_SEC, BODY), BODY, NOW_SEC)).toBe(false)
  })

  test("a tampered body fails", () => {
    const tampered = BODY.replace("my-bot-run-42", "my-bot-run-43")
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC, BODY), tampered, NOW_SEC)).toBe(false)
  })

  test("a stale timestamp fails; the tolerance boundary itself still passes", () => {
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC - 301, BODY), BODY, NOW_SEC)).toBe(false)
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC - 300, BODY), BODY, NOW_SEC)).toBe(true)
  })

  test("a future timestamp outside tolerance fails (clock-skew symmetric)", () => {
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC + 301, BODY), BODY, NOW_SEC)).toBe(false)
  })

  test("a custom tolerance is honored", () => {
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC - 11, BODY), BODY, NOW_SEC, 10)).toBe(false)
    expect(verifyWebhookSignature(SECRET, sign(SECRET, NOW_SEC - 9, BODY), BODY, NOW_SEC, 10)).toBe(true)
  })

  test("malformed headers fail instead of throwing", () => {
    const malformed = [
      null,
      undefined,
      "",
      "garbage",
      "t=,v1=",
      `t=${NOW_SEC}`,
      "v1=deadbeef",
      `t=notanumber,v1=deadbeef`,
      `t=${NOW_SEC},v1=nothex!!`,
      `t=${NOW_SEC},v1=deadbeef`, // valid shape, wrong digest length
    ]
    for (const header of malformed) {
      expect(verifyWebhookSignature(SECRET, header, BODY, NOW_SEC)).toBe(false)
    }
  })

  test("an empty secret fails", () => {
    expect(verifyWebhookSignature("", sign(SECRET, NOW_SEC, BODY), BODY, NOW_SEC)).toBe(false)
  })
})
