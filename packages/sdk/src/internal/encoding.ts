/**
 * Shared base64/ArrayBuffer/Uint8Array conversion helpers for this SDK's crypto modules
 * (wallet-import.ts, authorization-signature.ts, secret-store.ts). Internal only -- not
 * re-exported from index.ts -- since these are plumbing for WebCrypto/HPKE call sites, not part
 * of the SDK's public surface.
 *
 * These used to be copied near-identically in all three call sites. Consolidated here with
 * byte-identical behavior to the originals: same `Buffer.from`/`.slice` calls, just given one
 * home. Each call site keeps using whichever pair of functions matches the value shape it already
 * works with (ArrayBuffer for WebCrypto/HPKE APIs, Uint8Array for everything else).
 */

/** A `Uint8Array` sliced down to exactly its own bytes, safe to hand to WebCrypto/HPKE as an `ArrayBuffer`. */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

export function arrayBufferToBase64(data: ArrayBuffer): string {
  return Buffer.from(data).toString("base64")
}

/** Decodes a base64 string to an `ArrayBuffer` containing exactly its bytes (no pooled-buffer slack). */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, "base64")
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"))
}
