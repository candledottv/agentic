#!/usr/bin/env bun
/**
 * Refreshes the Sigstore trusted root embedded in the binary. Run at every release (release.yaml)
 * and whenever a verification starts failing with an expired trust root. Uses the TUF client so
 * the root is fetched and validated the proper way rather than pulled from a static URL.
 *
 * Bun only, deliberately: `@sigstore/tuf` verifies the TUF root's own ECDSA-P256 signatures
 * through `crypto.verify(undefined, ...)`, which Bun refuses for EC keys, and `@tufjs/models`
 * swallows the refusal as an invalid signature. Without the shim below this script fails with
 * "root was signed by 0/3 keys" rather than anything about crypto. See src/bun-crypto-shim.ts.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import "../src/bun-crypto-shim"
import { TrustedRoot } from "@sigstore/protobuf-specs"
import { getTrustedRoot } from "@sigstore/tuf"

const cachePath = mkdtempSync(join(tmpdir(), "candle-tuf-"))
const root = await getTrustedRoot({ cachePath })

// TrustedRoot.toJSON, not JSON.stringify: getTrustedRoot returns the DECODED message, whose keys
// and certificates are Buffers. Plain stringification writes them as {"type":"Buffer","data":[...]}
// and TrustedRoot.fromJSON cannot read that back, so the embedded root would parse to a root with
// no certificate authorities and every verification would fail. toJSON is fromJSON's inverse.
const json = TrustedRoot.toJSON(root)
if (TrustedRoot.fromJSON(json).certificateAuthorities.length === 0) {
  throw new Error("refusing to write a trusted root with no certificate authorities")
}

const out = join(import.meta.dir, "..", "src", "sigstore-trusted-root.json")
writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`)
console.log(`wrote ${out}`)
