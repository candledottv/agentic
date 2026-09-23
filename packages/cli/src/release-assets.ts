/**
 * Downloading and checking one signed release asset, shared by `candle update` (the binary and the
 * security key helper, BE-275 D5) and `vault factor add security-key --install-helper` (the helper
 * alone, for this binary's own version, D8). One path, so the two cannot disagree about what a
 * verified asset is: the SHA-256 must match SHA256SUMS AND the manifest, and the Sigstore bundle
 * must verify in process against the release workflow's identity for that exact version. Nothing
 * here writes a file; the caller decides where verified bytes go and stages the rename.
 */
import { createHash } from "node:crypto"
import type { Deps } from "./deps"
import { assetUrl, RELEASE_ISSUER } from "./release"
import { verifyReleaseAsset } from "./release-verify"

export type AssetDownload = { ok: true; bytes: Uint8Array; bundle: unknown } | { ok: false; message: string }

/** The asset and its Sigstore bundle. Fetched together because a missing one of them is the same
 * failure: an asset without its bundle cannot be verified and so cannot be installed. */
export async function downloadReleaseAsset(
  deps: Deps,
  base: string,
  tag: string,
  name: string,
): Promise<AssetDownload> {
  try {
    const [bin, bundle] = await Promise.all([
      deps.fetch(assetUrl(base, tag, name), { redirect: "follow" }),
      deps.fetch(assetUrl(base, tag, `${name}.sigstore.json`), { redirect: "follow" }),
    ])
    for (const [label, res] of [
      [name, bin],
      [`${name}.sigstore.json`, bundle],
    ] as const) {
      if (!res.ok) return { ok: false, message: `${label} answered ${res.status} at ${assetUrl(base, tag, label)}` }
    }
    return { ok: true, bytes: new Uint8Array(await bin.arrayBuffer()), bundle: (await bundle.json()) as unknown }
  } catch (error) {
    return { ok: false, message: `Could not download ${tag}: ${messageOf(error)}` }
  }
}

export type SumsDownload = { ok: true; sums: string } | { ok: false; message: string }

/** The release's checksum list, once per release rather than once per asset. */
export async function downloadSums(deps: Deps, base: string, tag: string): Promise<SumsDownload> {
  const url = assetUrl(base, tag, "SHA256SUMS")
  try {
    const res = await deps.fetch(url, { redirect: "follow" })
    if (!res.ok) return { ok: false, message: `SHA256SUMS answered ${res.status} at ${url}` }
    return { ok: true, sums: await res.text() }
  } catch (error) {
    return { ok: false, message: `Could not download ${tag}: ${messageOf(error)}` }
  }
}

export type AssetCheck =
  | { ok: true }
  | { ok: false; stage: "checksum" | "signature"; message: string; suggestion?: string }

/**
 * The two checks, in order, on bytes already in memory. `expectedSha256` is the manifest's word;
 * `sums` is SHA256SUMS's; both have to agree with the bytes. Then the bundle, in process, against
 * the trusted root compiled into this binary: no cosign, no gh, no network. `verify` is the injected
 * seam (deps.ts); the real deps leave it undefined and the in-process verifier runs.
 */
export function checkReleaseAsset(
  deps: Pick<Deps, "verify">,
  opts: { name: string; bytes: Uint8Array; sums: string; bundle: unknown; expectedSha256: string; identityUri: string },
): AssetCheck {
  const actual = createHash("sha256").update(opts.bytes).digest("hex")
  const fromSums = opts.sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === opts.name)?.[0]
  if (actual !== opts.expectedSha256 || actual !== fromSums) {
    return {
      ok: false,
      stage: "checksum",
      message: `checksum mismatch for ${opts.name} (manifest ${opts.expectedSha256}, SHA256SUMS ${fromSums ?? "missing"}, downloaded ${actual}); nothing installed.`,
    }
  }
  const verify = deps.verify ?? verifyReleaseAsset
  const verdict = verify(opts.bytes, opts.bundle, opts.identityUri, RELEASE_ISSUER)
  if (!verdict.ok) {
    return {
      ok: false,
      stage: "signature",
      message: `signature verification failed for ${opts.name}: ${verdict.reason}; nothing installed.`,
      suggestion: `Checked against ${opts.identityUri}.`,
    }
  }
  return { ok: true }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
