/**
 * Where CLI releases live and how this binary tells whether it is one. Everything `candle update`,
 * `doctor`'s Install and Update rows, and the identity drift test agree on lives here.
 *
 * Releases have two homes (spec 2026-10-23-candle-github, section 9, "Bridge and switch"). Every
 * version up to and including the bridge release B is released, signed and verified in
 * `candledottv/agentic`; every later version in `candledottv/cli`. The boundary is compiled in from
 * `release-homes.json` rather than read off a downloaded manifest, so a version's home and the
 * exact identity its signature must carry are decided by this binary alone: a manifest cannot
 * name its own signer, and a version can never be accepted from both homes.
 */

import homesJson from "../release-homes.json"
import type { Deps } from "./deps"

/** Three dot-separated numbers and nothing else. Deliberately stricter than `compareVersions`,
 * which is lenient about what it is handed because it only ever ORDERS versions. */
const VERSION = /^\d+\.\d+\.\d+$/

/** Whether `value` is exactly three dot-separated numbers -- the only shape trusted as a version. */
export function isPlainVersion(value: string): boolean {
  return VERSION.test(value)
}

const REPOSITORY = /^candledottv\/[a-z0-9-]+$/

/** `release-homes.json`, parsed strictly: a malformed edit fails at import (and so in every test)
 * rather than selecting a home by accident. */
export function parseReleaseHomes(value: unknown): { bridgeVersion: string; legacy: string; current: string } {
  const homes = value as Partial<Record<"bridgeVersion" | "legacy" | "current", unknown>>
  const { bridgeVersion, legacy, current } = homes ?? {}
  if (typeof bridgeVersion !== "string" || !VERSION.test(bridgeVersion)) {
    throw new Error("release-homes.json: bridgeVersion must be three dot-separated numbers")
  }
  if (typeof legacy !== "string" || !REPOSITORY.test(legacy)) throw new Error("release-homes.json: bad legacy")
  if (typeof current !== "string" || !REPOSITORY.test(current)) throw new Error("release-homes.json: bad current")
  if (legacy === current) throw new Error("release-homes.json: legacy and current must differ")
  return { bridgeVersion, legacy, current }
}

const HOMES = parseReleaseHomes(homesJson)

/** The final version released from the legacy home. Versions through it resolve to `agentic`,
 * later versions to `cli`. */
export const BRIDGE_VERSION = HOMES.bridgeVersion
export const LEGACY_RELEASE_REPOSITORY = HOMES.legacy
export const CURRENT_RELEASE_REPOSITORY = HOMES.current

export type ReleaseHome = "legacy" | "current"

export const RELEASE_ISSUER = "https://token.actions.githubusercontent.com"

export function homeRepository(home: ReleaseHome): string {
  return home === "legacy" ? LEGACY_RELEASE_REPOSITORY : CURRENT_RELEASE_REPOSITORY
}

export function homeUrl(home: ReleaseHome): string {
  return `https://github.com/${homeRepository(home)}`
}

/** The regex form, per home, for cosign users and install.sh; install.sh carries both literals
 * verbatim. */
export function identityRegex(home: ReleaseHome): string {
  return `^https://github.com/${homeRepository(home)}/\\.github/workflows/release\\.yaml@refs/tags/cli-v`
}

/** The legacy home's URL and identity regex, under the names every release before the bridge
 * code used. */
export const RELEASE_BASE_URL = homeUrl("legacy")
export const RELEASE_IDENTITY_REGEX = identityRegex("legacy")

/**
 * The home a version is released from: through the bridge, legacy; after it, current. THROWS on
 * a version that is not three numbers, for the reason `releaseIdentityUri` gives.
 */
export function releaseHomeFor(version: string): ReleaseHome {
  if (!VERSION.test(version)) throw new Error(`invalid release version: ${version}`)
  return compareVersions(version, BRIDGE_VERSION) <= 0 ? "legacy" : "current"
}

/**
 * Where a binary at `current` looks for something newer. Below the bridge, the legacy home, whose
 * latest stable release stays B; at or above it, the current home. A pre-bridge binary therefore
 * reaches N in two invocations (old -> B, then B -> N), and nothing a pre-bridge binary does
 * changes: it never knew about a second home and still reads agentic's latest.json.
 */
export function updateHomeFor(current: string): ReleaseHome {
  return compareVersions(current, BRIDGE_VERSION) < 0 ? "legacy" : "current"
}

/**
 * The exact identity a given version's signature must carry: the workflow at that version's tag,
 * in that version's home.
 *
 * The version is validated rather than trusted, and a bad one THROWS rather than returning
 * something unusable. `release-verify.ts` turns this string into an anchored regular expression,
 * and the version reaching it comes from a downloaded `latest.json`, which is exactly the input an
 * attacker controls. Before this check, `{"version": "x|"}` produced the identity `...cli-vx|`,
 * whose alternation matches every identity there is, and `candle verify` printed `verified:` for a
 * file signed by an unrelated project. Escaping in the verifier closes the same hole from the
 * other side; both are here because either one alone is a single point of failure.
 */
export function releaseIdentityUri(version: string): string {
  const home = releaseHomeFor(version)
  return `https://github.com/${homeRepository(home)}/.github/workflows/release.yaml@refs/tags/cli-v${version}`
}

/** `cli-v<three numbers>` and nothing else: the only tag shape `--to` accepts, because the version
 * inside it decides which home and which identity the pinned release is checked against. */
export function versionOfTag(tag: string): string | null {
  const match = /^cli-v(\d+\.\d+\.\d+)$/.exec(tag)
  return match ? (match[1] ?? null) : null
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

export type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64"

export function platformKey(platform: string, arch: string): PlatformKey | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null
  if (!os || !cpu) return null
  return `${os}-${cpu}` as PlatformKey
}

export type InstallMethod = "binary" | "homebrew" | "script"

/** A compiled binary reports its own path as execPath; a script run by node or bun reports the runtime. */
export function detectInstall(execPath: string, realExecPath: string): InstallMethod {
  const base = execPath.split("/").pop() ?? ""
  if (base === "node" || base === "bun" || base === "node.exe" || base === "bun.exe") return "script"
  if (/\/Cellar\/candle\//.test(realExecPath)) return "homebrew"
  return "binary"
}

export interface ReleaseAsset {
  name: string
  sha256: string
  size: number
}

export interface ReleaseManifest {
  version: string
  tag: string
  assets: Record<string, ReleaseAsset>
  /**
   * The `candle-fido2` security key helper per platform (Ember Phase 2 PR E). Optional because a
   * manifest from before PR E (0.10.x and earlier, reachable with `--to`) has none. The writer
   * (`write-manifest.mjs`) refuses to produce a manifest with some helpers and not others, so a
   * manifest either declares all four or predates the helper entirely (BE-275 D6).
   */
  helpers?: Record<string, ReleaseAsset>
}

/** The name the security key helper has for a platform, DERIVED from the platform rather than read
 * off the manifest, for the same reason `update` derives the binary's (see update.ts). */
export function helperAssetName(platformKey: string): string {
  return `candle-fido2-${platformKey}`
}

export function latestUrl(baseUrl: string): string {
  return `${baseUrl}/releases/latest/download/latest.json`
}

export function assetUrl(baseUrl: string, tag: string, name: string): string {
  return `${baseUrl}/releases/download/${tag}/${name}`
}

/** A failure says which KIND it is, because the two are different problems with different fixes:
 * `unreachable` is the release host not answering (network, 404), `invalid` is it answering with
 * something that is not a manifest. `candle update` reports them under different codes, so an
 * operator is not sent to check their network for a malformed release. `status` is the HTTP status
 * of an answer that was not 2xx: a 404 from the current home is how the bridge release tells
 * "nothing published there yet" apart from a network failure. */
export type FetchLatestResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; kind: "unreachable" | "invalid"; message: string; status?: number }

export async function fetchLatest(deps: Deps, baseUrl: string): Promise<FetchLatestResult> {
  let res: Response
  try {
    res = await deps.fetch(latestUrl(baseUrl), { redirect: "follow" })
  } catch (error) {
    return {
      ok: false,
      kind: "unreachable",
      message: `Could not reach ${latestUrl(baseUrl)}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      kind: "unreachable",
      message: `${latestUrl(baseUrl)} answered ${res.status}`,
      status: res.status,
    }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, kind: "invalid", message: "The release manifest is not JSON" }
  }
  const manifest = body as Partial<ReleaseManifest>
  if (
    typeof manifest.version !== "string" ||
    typeof manifest.tag !== "string" ||
    typeof manifest.assets !== "object" ||
    manifest.assets === null
  ) {
    return { ok: false, kind: "invalid", message: "The release manifest has no version, tag or assets" }
  }
  return { ok: true, manifest: manifest as ReleaseManifest }
}

/** A pinned tag's manifest lives beside its assets, so `--to cli-v1.2.3` (and `--install-helper`,
 * which pins this binary's own version) reads that release's own latest.json rather than the newest
 * one. Same three-field shape check `fetchLatest` makes, and for the same reason: a manifest missing
 * `tag` builds asset URLs with "undefined" in them, and one missing `assets` is a TypeError at the
 * platform lookup. */
export async function fetchPinned(deps: Deps, base: string, tag: string): Promise<FetchLatestResult> {
  const url = assetUrl(base, tag, "latest.json")
  try {
    const res = await deps.fetch(url, { redirect: "follow" })
    if (!res.ok) return { ok: false, kind: "unreachable", message: `${url} answered ${res.status}`, status: res.status }
    const manifest = (await res.json()) as Partial<ReleaseManifest>
    const missing = [
      typeof manifest.version === "string" ? null : "version",
      typeof manifest.tag === "string" ? null : "tag",
      typeof manifest.assets === "object" && manifest.assets !== null ? null : "assets",
    ].filter((field): field is string => field !== null)
    if (missing.length > 0) {
      return { ok: false, kind: "invalid", message: `The release manifest at ${url} has no ${missing.join(", ")}` }
    }
    return { ok: true, manifest: manifest as ReleaseManifest }
  } catch (error) {
    return {
      ok: false,
      kind: "unreachable",
      message: `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** A home's base URL, with the test-only override. The override replaces whichever home is asked
 * for: it moves where bytes come from, never which identity they must carry, which is decided by
 * version alone. */
export function releaseBaseUrl(env: Record<string, string | undefined>, home: ReleaseHome = "legacy"): string {
  const override = env.CANDLE_RELEASE_BASE_URL?.trim()
  return override ? override.replace(/\/$/, "") : homeUrl(home)
}

/**
 * The origin check: a manifest read from `home` must name a version released from `home`, and a
 * pinned read must return the release that was pinned. Unknown or mismatched pairs fail closed.
 * Returns the refusal, or null when the manifest belongs where it was found.
 */
export function manifestHomeMismatch(manifest: ReleaseManifest, home: ReleaseHome, pinnedTag?: string): string | null {
  let versionHome: ReleaseHome
  try {
    versionHome = releaseHomeFor(manifest.version)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (manifest.tag !== `cli-v${manifest.version}`) {
    return `the manifest's tag ${manifest.tag} does not name its version ${manifest.version}`
  }
  if (pinnedTag !== undefined && manifest.tag !== pinnedTag) {
    return `asked for ${pinnedTag}, the manifest describes ${manifest.tag}`
  }
  if (versionHome !== home) {
    return `${manifest.version} is released from ${homeRepository(versionHome)}, not ${homeRepository(home)}`
  }
  return null
}
