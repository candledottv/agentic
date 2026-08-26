import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  assetUrl,
  compareVersions,
  detectInstall,
  fetchLatest,
  latestUrl,
  platformKey,
  RELEASE_IDENTITY_REGEX,
  RELEASE_ISSUER,
  releaseIdentityUri,
} from "./release"
import { createRoutedFetch, createTestDeps } from "./test-support"

describe("compareVersions", () => {
  test("orders major, minor and patch numerically", () => {
    expect(compareVersions("0.5.0", "0.6.0")).toBe(-1)
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1)
  })
})

describe("platformKey", () => {
  test("maps node's platform and arch to the release targets", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64")
    expect(platformKey("darwin", "x64")).toBe("darwin-x64")
    expect(platformKey("linux", "x64")).toBe("linux-x64")
    expect(platformKey("linux", "arm64")).toBe("linux-arm64")
    expect(platformKey("win32", "x64")).toBeNull()
  })
})

describe("detectInstall", () => {
  test("a runtime execPath is a script install", () => {
    expect(detectInstall("/usr/local/bin/node", "/usr/local/bin/node")).toBe("script")
    expect(detectInstall("/opt/homebrew/bin/bun", "/opt/homebrew/Cellar/bun/1.2.0/bin/bun")).toBe("script")
  })
  test("a binary under a Cellar is a Homebrew install", () => {
    expect(detectInstall("/opt/homebrew/bin/candle", "/opt/homebrew/Cellar/candle/0.6.0/bin/candle")).toBe("homebrew")
    expect(detectInstall("/usr/local/bin/candle", "/usr/local/Cellar/candle/0.6.0/bin/candle")).toBe("homebrew")
  })
  test("any other binary is the installer's", () => {
    expect(detectInstall("/Users/a/.local/bin/candle", "/Users/a/.local/bin/candle")).toBe("binary")
  })
})

describe("release identity", () => {
  test("the exact identity for a version, and the regex install.sh carries", () => {
    expect(releaseIdentityUri("0.6.0")).toBe(
      "https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v0.6.0",
    )
    expect(new RegExp(RELEASE_IDENTITY_REGEX).test(releaseIdentityUri("0.6.0"))).toBe(true)
    expect(RELEASE_ISSUER).toBe("https://token.actions.githubusercontent.com")
  })
  /**
   * The identity becomes an ANCHORED REGULAR EXPRESSION in release-verify.ts, and this function is
   * what interpolates a version into it. A version read from a downloaded latest.json is attacker
   * influenced, so an unvalidated one is a pattern injection: `"version": "x|"` produced the
   * identity `...cli-vx|`, whose alternation matches every identity there is, and the compiled
   * binary printed `verified:` for a file signed by someone else entirely.
   */
  test("a version that is not three numbers is refused, not interpolated", () => {
    expect(() => releaseIdentityUri("x|")).toThrow("invalid release version: x|")
    for (const bad of ["", ".*", "0.6", "0.6.0-rc1", "1.2.3.4", "0.6.0 ", "$&"]) {
      expect(() => releaseIdentityUri(bad)).toThrow("invalid release version")
    }
    expect(releaseIdentityUri("0.6.0")).toContain("cli-v0.6.0")
    expect(releaseIdentityUri("10.20.30")).toContain("cli-v10.20.30")
  })

  test("install.sh carries the same identity regex and issuer", () => {
    const script = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8")
    expect(script).toContain(`IDENTITY_REGEX='${RELEASE_IDENTITY_REGEX}'`)
    expect(script).toContain(`ISSUER='${RELEASE_ISSUER}'`)
  })
})

describe("fetchLatest", () => {
  test("reads the manifest from the latest-release redirect", async () => {
    const manifest = {
      version: "0.6.0",
      tag: "cli-v0.6.0",
      assets: { "linux-x64": { name: "candle-linux-x64", sha256: "ab", size: 1 } },
    }
    const { fetch, calls } = createRoutedFetch({
      "/releases/latest/download/latest.json": () => Response.json(manifest),
    })
    const deps = createTestDeps({ fetch })
    const result = await fetchLatest(deps, "https://example.test")
    expect(result).toEqual({ ok: true, manifest })
    expect(calls[0]?.url).toBe("https://example.test/releases/latest/download/latest.json")
  })
  test("a network failure is a message, not a throw", async () => {
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof globalThis.fetch,
    })
    const result = await fetchLatest(deps, "https://example.test")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("ECONNREFUSED")
      expect(result.kind).toBe("unreachable")
    }
  })
  test("a manifest without a version is refused", async () => {
    const { fetch } = createRoutedFetch({ "/releases/latest/download/latest.json": () => Response.json({ tag: "x" }) })
    const result = await fetchLatest(createTestDeps({ fetch }), "https://example.test")
    expect(result.ok).toBe(false)
    // A host that answered with something that is not a manifest is not an unreachable host.
    if (!result.ok) expect(result.kind).toBe("invalid")
  })
  test("asset and latest URLs", () => {
    expect(assetUrl("https://example.test", "cli-v0.6.0", "candle-linux-x64")).toBe(
      "https://example.test/releases/download/cli-v0.6.0/candle-linux-x64",
    )
    expect(latestUrl("https://example.test")).toBe("https://example.test/releases/latest/download/latest.json")
  })
})
