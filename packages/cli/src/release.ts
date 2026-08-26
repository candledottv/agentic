/**
 * Where CLI releases live and how this binary tells whether it is one. Everything `candle update`,
 * `doctor`'s Install and Update rows, and the identity drift test agree on lives here.
 */
import type { Deps } from "./deps"

export const RELEASE_BASE_URL = "https://github.com/candledottv/agentic"
/** The regex form, for cosign users and install.sh; install.sh carries this literal verbatim. */
export const RELEASE_IDENTITY_REGEX =
  "^https://github.com/candledottv/agentic/\\.github/workflows/release\\.yaml@refs/tags/cli-v"
export const RELEASE_ISSUER = "https://token.actions.githubusercontent.com"

/** Three dot-separated numbers and nothing else. Deliberately stricter than `compareVersions`,
 * which is lenient about what it is handed because it only ever ORDERS versions. */
const VERSION = /^\d+\.\d+\.\d+$/

/**
 * The exact identity a given version's signature must carry: the workflow at that version's tag.
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
  if (!VERSION.test(version)) throw new Error(`invalid release version: ${version}`)
  return `https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v${version}`
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
 * operator is not sent to check their network for a malformed release. */
export type FetchLatestResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; kind: "unreachable" | "invalid"; message: string }

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
  if (!res.ok) return { ok: false, kind: "unreachable", message: `${latestUrl(baseUrl)} answered ${res.status}` }
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

/** The base URL, with the test-only override. */
export function releaseBaseUrl(env: Record<string, string | undefined>): string {
  const override = env.CANDLE_RELEASE_BASE_URL?.trim()
  return override ? override.replace(/\/$/, "") : RELEASE_BASE_URL
}
