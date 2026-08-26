#!/usr/bin/env bun
// Writes latest.json for a CLI release from SHA256SUMS and the asset sizes. Run by release.yaml:
//   bun scripts/release/write-manifest.mjs <version> <dist dir>
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]

export function assetName(platform) {
  return ["candle", platform].join("-")
}

export function buildManifest(version, sha256sums, sizes) {
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
  for (const platform of PLATFORMS) {
    const name = assetName(platform)
    const sha256 = bySum.get(name)
    if (!sha256) throw new Error(`SHA256SUMS has no entry for ${name}`)
    if (sizes[name] === undefined) throw new Error(`no size for ${name}`)
    assets[platform] = { name, sha256, size: sizes[name] }
  }
  return { version, tag: `cli-v${version}`, assets }
}

if (import.meta.main) {
  const [version, dir] = process.argv.slice(2)
  if (!version || !dir) {
    console.error("usage: write-manifest.mjs <version> <dist dir>")
    process.exit(2)
  }
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8")
  const sizes = Object.fromEntries(PLATFORMS.map((p) => [assetName(p), statSync(join(dir, assetName(p))).size]))
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(buildManifest(version, sums, sizes), null, 2)}\n`)
  console.log(`wrote ${join(dir, "latest.json")}`)
}
