/**
 * Webhook signature verification for Candle webhook deliveries (Phase 2, R9).
 *
 * Every delivery carries `x-candle-signature: t=<unix seconds>,v1=<hex hmac-sha256(secret,
 * "<t>.<body>")>` where `<body>` is the EXACT raw request body string (re-serializing the
 * parsed JSON can reorder keys and break the signature; always verify the raw bytes as text).
 *
 * Implemented with `node:crypto` (`createHmac` + `timingSafeEqual`), which both Node 18+ and
 * Bun provide, so the SDK stays zero-dependency. Edge runtimes without `node:crypto` would
 * need a Web Crypto (`crypto.subtle`) implementation; that is a deliberate later concern, not
 * covered here.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Returns true only when `header` carries a well-formed `t=...,v1=...` signature whose
 * timestamp is within `toleranceSec` (default 300) of `nowSec` and whose `v1` digest matches
 * HMAC-SHA256(secret, `${t}.${body}`). Never throws on malformed input; every failure mode
 * (missing header, bad format, stale timestamp, wrong secret, tampered body) is `false`.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  if (!secret || !header) return false

  let t: string | undefined
  let v1: string | undefined
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq === -1) return false
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") t = value
    else if (key === "v1") v1 = value
    // Unknown keys (a future v2 scheme, say) are tolerated so rotation can dual-sign.
  }
  if (!t || !v1) return false
  if (!/^\d+$/.test(t)) return false
  if (!/^[0-9a-fA-F]+$/.test(v1)) return false

  const timestamp = Number(t)
  if (!Number.isSafeInteger(timestamp)) return false
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false

  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest()
  const provided = Buffer.from(v1.toLowerCase(), "hex")
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
