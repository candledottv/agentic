/**
 * x402 v2 headers, client side (spec docs/superpowers/specs/2026-10-24-candle-x402-design.md, 3.1,
 * 3.2 and 10.2): base64 of a JSON object, strict on `x402Version: 2`. The server's twin is
 * `apps/api/src/services/x402/codec.ts`; this copy exists because the CLI has no runtime
 * dependency and no cross-package import.
 *
 * A 402 is payable only when its `PAYMENT-REQUIRED` header is present and decodes here (3.2). Any
 * other 402 (the four Candle already answers: change-plan, staking, owner balance, fee leg) is the
 * ordinary error it is today. v1 names (`X-PAYMENT`, `solana-devnet`) are never read.
 */

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED"
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE"
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE"
export const SIGN_IN_WITH_X_HEADER = "SIGN-IN-WITH-X"
export const X402_VERSION = 2

export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

export interface PaymentRequirements {
  scheme: string
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

export interface PaymentRequired {
  x402Version: 2
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

export interface PaymentPayload {
  x402Version: 2
  resource?: ResourceInfo
  accepted: PaymentRequirements
  payload: { transaction: string }
}

export interface SettlementResponse {
  success: boolean
  errorReason?: string
  payer?: string
  transaction: string
  network: string
}

export class X402DecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "X402DecodeError"
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

/** Base64 JSON to an object. Throws X402DecodeError on anything else. */
export function decodeHeader(value: string): Record<string, unknown> {
  const text = value.trim()
  if (text === "" || text.length % 4 !== 0 || !BASE64.test(text)) throw new X402DecodeError("not base64")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"))
  } catch {
    throw new X402DecodeError("not JSON")
  }
  if (!isObject(parsed)) throw new X402DecodeError("not a JSON object")
  return parsed
}

function parseRequirements(value: unknown): PaymentRequirements {
  if (!isObject(value)) throw new X402DecodeError("requirements are not an object")
  const { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra } = value
  if (!isString(scheme) || !isString(network) || !isString(amount) || !isString(asset) || !isString(payTo)) {
    throw new X402DecodeError("requirements are missing a field")
  }
  if (typeof maxTimeoutSeconds !== "number" || !Number.isInteger(maxTimeoutSeconds)) {
    throw new X402DecodeError("maxTimeoutSeconds is not an integer")
  }
  if (extra !== undefined && !isObject(extra)) throw new X402DecodeError("extra is not an object")
  return { scheme, network, amount, asset, payTo, maxTimeoutSeconds, ...(extra ? { extra } : {}) }
}

/** A server's `PAYMENT-REQUIRED` header. Throws X402DecodeError unless it is x402 v2. */
export function decodePaymentRequired(header: string): PaymentRequired {
  const object = decodeHeader(header)
  if (object.x402Version !== X402_VERSION) throw new X402DecodeError("x402Version is not 2")
  const resource = object.resource
  if (!isObject(resource) || !isString(resource.url)) throw new X402DecodeError("resource is missing")
  if (!Array.isArray(object.accepts)) throw new X402DecodeError("accepts is not an array")
  if (object.error !== undefined && !isString(object.error)) throw new X402DecodeError("error is not a string")
  return {
    x402Version: X402_VERSION,
    ...(isString(object.error) ? { error: object.error } : {}),
    resource: {
      url: resource.url,
      ...(isString(resource.description) ? { description: resource.description } : {}),
      ...(isString(resource.mimeType) ? { mimeType: resource.mimeType } : {}),
    },
    accepts: object.accepts.map(parseRequirements),
    ...(isObject(object.extensions) ? { extensions: object.extensions } : {}),
  }
}

/** The `PAYMENT-REQUIRED` header of a response, decoded, or null when it is absent or not v2. */
export function paymentRequiredOf(headers: Record<string, string> | undefined): PaymentRequired | null {
  const header = headers?.[PAYMENT_REQUIRED_HEADER.toLowerCase()]
  if (header === undefined) return null
  try {
    return decodePaymentRequired(header)
  } catch {
    return null
  }
}

/** The `PAYMENT-RESPONSE` header of a response, decoded, or null when it is absent or unreadable. */
export function settlementOf(headers: Record<string, string> | undefined): SettlementResponse | null {
  const header = headers?.[PAYMENT_RESPONSE_HEADER.toLowerCase()]
  if (header === undefined) return null
  try {
    const object = decodeHeader(header)
    const { success, errorReason, payer, transaction, network } = object
    if (typeof success !== "boolean" || !isString(transaction) || !isString(network)) return null
    return {
      success,
      ...(isString(errorReason) ? { errorReason } : {}),
      ...(isString(payer) ? { payer } : {}),
      transaction,
      network,
    }
  } catch {
    return null
  }
}

/** The `PAYMENT-SIGNATURE` header: the requirement exactly as offered, and the signed transaction. */
export function encodePaymentPayload(args: {
  resource: ResourceInfo
  accepted: PaymentRequirements
  transaction: string
}): string {
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: args.resource,
    accepted: args.accepted,
    payload: { transaction: args.transaction },
  }
  return encodeHeader(payload)
}
