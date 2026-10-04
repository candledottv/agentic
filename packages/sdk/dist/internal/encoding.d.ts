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
export declare function toArrayBuffer(view: Uint8Array): ArrayBuffer;
export declare function arrayBufferToBase64(data: ArrayBuffer): string;
/** Decodes a base64 string to an `ArrayBuffer` containing exactly its bytes (no pooled-buffer slack). */
export declare function base64ToArrayBuffer(base64: string): ArrayBuffer;
export declare function toBase64(bytes: Uint8Array): string;
export declare function fromBase64(base64: string): Uint8Array;
//# sourceMappingURL=encoding.d.ts.map