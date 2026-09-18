#!/usr/bin/env bun
// Writes latest.json for a CLI release from SHA256SUMS and the asset sizes. Run by release.yaml:
//   bun scripts/release/write-manifest.mjs <version> <dist dir> [--macos-helper <archive name>]
// The optional archive is the signed macOS Secure Enclave helper (Ember Phase 2 PR F), present
// only when release-policy.json said "signed"; the manifest names it under `macosHelper`.
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]

export function assetName(platform) {
  return ["candle", platform].join("-")
}

/** The security key helper beside each binary (Ember Phase 2 PR E): one per target, same job. */
export function helperName(platform) {
  return ["candle-fido2", platform].join("-")
}

export function buildManifest(version, sha256sums, sizes, options = {}) {
  const bySum = new Map(
    sha256sums
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [sha256, name] = line.trim().split(/\s+/)
        return [name, sha256]
      }),
  )
  const assets = {}
  const helpers = {}
  for (const platform of PLATFORMS) {
    for (const [table, name] of [
      [assets, assetName(platform)],
      [helpers, helperName(platform)],
    ]) {
      const sha256 = bySum.get(name)
      if (!sha256) throw new Error(`SHA256SUMS has no entry for ${name}`)
      if (sizes[name] === undefined) throw new Error(`no size for ${name}`)
      table[platform] = { name, sha256, size: sizes[name] }
    }
  }
  // `assets` keeps its shape (the CLI's `update` and install.sh read it); `helpers` sits beside it.
  const manifest = { version, tag: `cli-v${version}`, assets, helpers }
  if (options.macosHelper) {
    const name = options.macosHelper
    const sha256 = bySum.get(name)
    if (!sha256) throw new Error(`SHA256SUMS has no entry for ${name}`)
    if (sizes[name] === undefined) throw new Error(`no size for ${name}`)
    manifest.macosHelper = { name, sha256, size: sizes[name] }
  }
  return manifest
}

if (import.meta.main) {
  const [version, dir, ...rest] = process.argv.slice(2)
  const flag = rest.indexOf("--macos-helper")
  const macosHelper = flag === -1 ? undefined : rest[flag + 1]
  if (!version || !dir || (flag !== -1 && !macosHelper)) {
    console.error("usage: write-manifest.mjs <version> <dist dir> [--macos-helper <archive name>]")
    process.exit(2)
  }
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8")
  const sizes = Object.fromEntries([
    ...PLATFORMS.flatMap((p) => [
      [assetName(p), statSync(join(dir, assetName(p))).size],
      [helperName(p), statSync(join(dir, helperName(p))).size],
    ]),
    ...(macosHelper ? [[macosHelper, statSync(join(dir, macosHelper)).size]] : []),
  ])
  writeFileSync(
    join(dir, "latest.json"),
    `${JSON.stringify(buildManifest(version, sums, sizes, { macosHelper }), null, 2)}\n`,
  )
  console.log(`wrote ${join(dir, "latest.json")}`)
}
