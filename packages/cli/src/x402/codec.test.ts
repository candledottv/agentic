import { describe, expect, test } from "bun:test"
import {
  decodeHeader,
  decodePaymentRequired,
  encodeHeader,
  encodePaymentPayload,
  type PaymentRequired,
  paymentRequiredOf,
  settlementOf,
  X402DecodeError,
} from "./codec"

const requirement = {
  scheme: "exact",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  amount: "10000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  maxTimeoutSeconds: 120,
  extra: { feePayer: "11111111111111111111111111111112", memo: `cndl:${"a".repeat(32)}`, paymentFlow: "upfront" },
}
const required: PaymentRequired = {
  x402Version: 2,
  resource: { url: "https://api.test/api/v1/markets/solana/m/forensics", description: "Token forensics, 0.01 USDC" },
  accepts: [requirement],
}

describe("x402 codec (spec 3.1, 3.2, 10.7)", () => {
  test("PAYMENT-REQUIRED round-trips", () => {
    expect(decodePaymentRequired(encodeHeader(required))).toEqual(required)
    expect(paymentRequiredOf({ "payment-required": encodeHeader(required) })).toEqual(required)
  })

  test("refuses bad base64, non-JSON, non-objects and any version but 2", () => {
    expect(() => decodeHeader("not base64!")).toThrow(X402DecodeError)
    expect(() => decodeHeader(Buffer.from("{not json").toString("base64"))).toThrow(X402DecodeError)
    expect(() => decodeHeader(encodeHeader([1, 2]))).toThrow(X402DecodeError)
    expect(() => decodePaymentRequired(encodeHeader({ ...required, x402Version: 1 }))).toThrow("x402Version")
    expect(() => decodePaymentRequired(encodeHeader({ ...required, accepts: "x" }))).toThrow(X402DecodeError)
    expect(() => decodePaymentRequired(encodeHeader({ ...required, resource: undefined }))).toThrow(X402DecodeError)
  })

  test("a v1 header name is never read: only PAYMENT-REQUIRED counts", () => {
    expect(paymentRequiredOf({ "x-payment": encodeHeader(required) })).toBeNull()
    expect(paymentRequiredOf(undefined)).toBeNull()
  })

  test("a garbage PAYMENT-REQUIRED header is not payable (fuzz)", () => {
    const samples = ["", "=", "AAAA", "e30=", encodeHeader({ x402Version: 2 }), encodeHeader("v2"), "%%%%"]
    for (let i = 0; i < 200; i++) {
      const bytes = new Uint8Array(1 + (i % 40)).map((_, j) => (i * 31 + j * 17) % 256)
      samples.push(Buffer.from(bytes).toString("base64"), Buffer.from(bytes).toString("latin1"))
    }
    for (const header of samples) expect(paymentRequiredOf({ "payment-required": header })).toBeNull()
  })

  test("PAYMENT-SIGNATURE carries the requirement exactly as offered", () => {
    const header = encodePaymentPayload({ resource: required.resource, accepted: requirement, transaction: "dHg=" })
    expect(decodeHeader(header)).toEqual({
      x402Version: 2,
      resource: required.resource,
      accepted: requirement,
      payload: { transaction: "dHg=" },
    })
  })

  test("PAYMENT-RESPONSE decodes, and an unreadable one is null", () => {
    const settled = { success: true, transaction: "sig", network: requirement.network, payer: "p" }
    expect(settlementOf({ "payment-response": encodeHeader(settled) })).toEqual(settled)
    expect(settlementOf({ "payment-response": encodeHeader({ success: "yes" }) })).toBeNull()
    expect(settlementOf({ "payment-response": "garbage" })).toBeNull()
    expect(settlementOf({})).toBeNull()
  })
})
