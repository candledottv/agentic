/**
 * Writes install.sh's VERIFIER PINS block (BE-2697): the CLI release whose `candle verify` checks a
 * download's signature on a machine with no cosign and no signed-in gh, and the SHA-256 of that
 * release's binary for each platform.
 *
 * Run by hand when the pinned verifier should move (a newer `candle verify`, or a Sigstore trusted
 * root that an older binary does not carry), never in CI:
 *
 *     bun packages/cli/scripts/pin-verifier.ts              # the latest release
 *     bun packages/cli/scripts/pin-verifier.ts cli-v0.13.15 # a named one
 *
 * A pin is only as good as the file it was read from, so nothing is written on the release's word
 * alone. Each binary is downloaded and must match both its SHA256SUMS line and its latest.json
 * entry, and its Sigstore bundle must verify in process (the same code `candle verify` runs) against
 * the exact identity of that release: its home's release workflow at that tag. One platform failing
 * any of the three writes nothing.
 */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CURRENT_RELEASE_REPOSITORY,
  isPlainVersion,
  RELEASE_ISSUER,
  releaseHomeFor,
  releaseIdentityUri,
  versionOfTag,
} from "../src/release"

/** The four binaries install.sh installs, by the asset name it downloads. */
export const VERIFIER_ASSETS = ["candle-darwin-arm64", "candle-darwin-x64", "candle-linux-arm64", "candle-linux-x64"]

export const BEGIN = "# BEGIN VERIFIER PINS"
export const END = "# END VERIFIER PINS"

export interface VerifierPins {
  tag: string
  pins: Record<string, string>
}

/** The block's text, BEGIN and END lines included, in the shape install.sh's `verifier_pin` reads. */
export function renderVerifierPins({ tag, pins }: VerifierPins): string {
  const cases = VERIFIER_ASSETS.map((name) => {
    const pin = pins[name]
    if (!pin || !/^[0-9a-f]{64}$/.test(pin)) throw new Error(`no SHA-256 for ${name}`)
    return `    ${name}) echo '${pin}' ;;`
  })
  return [
    BEGIN,
    `VERIFIER_TAG='${tag}'`,
    "verifier_pin() {",
    '  case "$1" in',
    ...cases,
    "    *) echo '' ;;",
    "  esac",
    "}",
    END,
  ].join("\n")
}

/** Reads the block back out of a script. Throws when it is missing, doubled or malformed. */
export function parseVerifierPins(script: string): VerifierPins {
  const start = script.indexOf(BEGIN)
  const end = script.indexOf(END)
  if (start < 0 || end < start || script.indexOf(BEGIN, start + 1) >= 0)
    throw new Error("install.sh has no single VERIFIER PINS block")
  const block = script.slice(start, end)
  const tag = /^VERIFIER_TAG='([^']*)'$/m.exec(block)?.[1]
  if (!tag) throw new Error("the VERIFIER PINS block has no VERIFIER_TAG")
  const pins: Record<string, string> = {}
  for (const match of block.matchAll(/^ {4}([a-z0-9-]+)\) echo '([0-9a-f]{64})' ;;$/gm)) {
    pins[match[1] as string] = match[2] as string
  }
  return { tag, pins }
}

/** The script with its block replaced by `pins`'s. */
export function replaceVerifierPins(script: string, pins: VerifierPins): string {
  parseVerifierPins(script)
  const start = script.indexOf(BEGIN)
  const end = script.indexOf(END) + END.length
  return script.slice(0, start) + renderVerifierPins(pins) + script.slice(end)
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response
}

async function main(argv: string[]): Promise<void> {
  // Imported here, not at the top: it pulls in the Bun crypto shim and the Sigstore libraries, which
  // the pure helpers above (and the test that imports them) have no use for.
  const { verifyReleaseAsset } = await import("../src/release-verify")
  const base = `https://github.com/${CURRENT_RELEASE_REPOSITORY}/releases`
  let tag = argv[0]
  if (!tag) {
    const latest = (await (await fetchOk(`${base}/latest/download/latest.json`)).json()) as { tag?: unknown }
    if (typeof latest.tag !== "string") throw new Error("the latest release's latest.json names no tag")
    tag = latest.tag
  }
  const version = versionOfTag(tag)
  if (!version || !isPlainVersion(version)) throw new Error(`${tag} is not a cli-v<version> tag`)
  if (releaseHomeFor(version) !== "current") {
    throw new Error(`${tag} is released from the legacy home; pin a release from ${CURRENT_RELEASE_REPOSITORY}`)
  }
  const download = `${base}/download/${tag}`
  const manifest = (await (await fetchOk(`${download}/latest.json`)).json()) as {
    version?: unknown
    assets?: Record<string, { name?: unknown; sha256?: unknown }>
  }
  if (manifest.version !== version) throw new Error(`the latest.json at ${tag} describes ${String(manifest.version)}`)
  const sums = await (await fetchOk(`${download}/SHA256SUMS`)).text()
  const identity = releaseIdentityUri(version)
  const pins: Record<string, string> = {}
  for (const name of VERIFIER_ASSETS) {
    const bytes = new Uint8Array(await (await fetchOk(`${download}/${name}`)).arrayBuffer())
    const actual = createHash("sha256").update(bytes).digest("hex")
    const fromSums = sums
      .split("\n")
      .find((line) => line.trim().endsWith(`  ${name}`))
      ?.split(/\s+/)[0]
    const fromManifest = Object.values(manifest.assets ?? {}).find((asset) => asset.name === name)?.sha256
    if (actual !== fromSums) throw new Error(`${name}: SHA-256 ${actual}, SHA256SUMS says ${fromSums ?? "nothing"}`)
    if (actual !== fromManifest) throw new Error(`${name}: SHA-256 ${actual}, latest.json says ${String(fromManifest)}`)
    const bundle = await (await fetchOk(`${download}/${name}.sigstore.json`)).json()
    const verdict = verifyReleaseAsset(bytes, bundle, identity, RELEASE_ISSUER)
    if (!verdict.ok) throw new Error(`${name}: signature not verified against ${identity}: ${verdict.reason}`)
    console.log(`${name}  ${actual}  signature verified (${identity})`)
    pins[name] = actual
  }
  const path = join(import.meta.dir, "..", "install.sh")
  await writeFile(path, replaceVerifierPins(await readFile(path, "utf8"), { tag, pins }))
  console.log(`Wrote the VERIFIER PINS block for ${tag} to ${path}`)
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
