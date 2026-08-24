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
/**
 * Returns true only when `header` carries a well-formed `t=...,v1=...` signature whose
 * timestamp is within `toleranceSec` (default 300) of `nowSec` and whose `v1` digest matches
 * HMAC-SHA256(secret, `${t}.${body}`). Never throws on malformed input; every failure mode
 * (missing header, bad format, stale timestamp, wrong secret, tampered body) is `false`.
 */
export declare function verifyWebhookSignature(secret: string, header: string | null | undefined, body: string, nowSec: number, toleranceSec?: number): boolean;
//# sourceMappingURL=webhooks.d.ts.map