/**
 * What a signed release is allowed to contain.
 *
 * The release job runs `bun test` BEFORE it compiles the binaries, in the same working directory
 * tree, then wipes `dist-bin` so a compile-in-test leftover cannot sit under `candle-*` when the
 * pack step globs that directory. It then packs and uploads everything matching `candle-*`.
 * T49's vault parity test used to compile a 96 MB binary there, and that file shipped as an
 * asset of 0.10.0 and 0.11.0, listed in the signed SHA256SUMS and named by no documentation, no
 * manifest and no installer.
 *
 * The pack step refuses to publish a set of assets it did not build: it diffs the `candle-*`
 * names on disk against a list derived from one target list (RELEASE_TARGETS) plus the helper
 * archive the validate step actually moved (HELPER_ASSET). A source walk over test files is not
 * part of that; the next compile-in-test can always spell the output path a different way.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const pkgDir = resolve(import.meta.dir, "..")

/**
 * The release workflow, which lives in `distribution/agentic/` in the monorepo and at the
 * repository root in the exported mirror (`candledottv/agentic`). Same two candidates as
 * `vault/release-policy.test.ts`, so this guard travels with the package.
 */
function releaseWorkflow(): string {
  const candidates = [
    join(pkgDir, "..", "..", "distribution", "agentic", ".github", "workflows", "release.yaml"),
    join(pkgDir, "..", "..", ".github", "workflows", "release.yaml"),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8")
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`release.yaml not found at any of: ${candidates.join(", ")}`)
}

function releaseTargets(workflow: string): string[] {
  const match = workflow.match(/^\s+RELEASE_TARGETS:\s*(.+)$/m)
  if (!match?.[1]) throw new Error("RELEASE_TARGETS missing from release.yaml")
  return match[1].trim().split(/\s+/)
}

/** Shell `${name}` without putting a template placeholder in a quoted string (Biome). */
function shVar(name: string): string {
  return `\${${name}}`
}

function loopTargetsContaining(workflow: string, needle: string): string {
  const loops = workflow.matchAll(/for target in ([^;]+); do([\s\S]*?)\n\s*done/g)
  for (const match of loops) {
    if ((match[2] ?? "").includes(needle)) return (match[1] ?? "").trim()
  }
  throw new Error(`no target loop contains ${needle}`)
}

/** The `{ ... } | sort` that writes expected-assets.txt, extracted so the test runs that shell. */
function expectedAssetsShell(workflow: string): string {
  const lines = workflow.split("\n")
  const end = lines.findIndex((line) => line.includes("} | sort > ../expected-assets.txt"))
  if (end < 0) throw new Error("expected-assets.txt sort not found")
  let start = end
  while (start >= 0 && !/^\s+\{\s*$/.test(lines[start] ?? "")) start--
  if (start < 0) throw new Error("expected-assets generator brace not found")
  return `${lines.slice(start, end).join("\n")}\n} | sort`
}

function runExpectedAssets(workflow: string, env: { VERSION: string; HELPER_ASSET: string }): string[] {
  const result = spawnSync("bash", ["-c", expectedAssetsShell(workflow)], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TARGETS: releaseTargets(workflow).join(" "),
      VERSION: env.VERSION,
      HELPER_ASSET: env.HELPER_ASSET,
    },
  })
  if (result.status !== 0) {
    throw new Error(`expected-assets shell failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

async function platformsFromManifest(): Promise<string[]> {
  const candidates = [
    join(pkgDir, "..", "..", "distribution", "agentic", "scripts", "release", "write-manifest.mjs"),
    join(pkgDir, "..", "..", "scripts", "release", "write-manifest.mjs"),
  ]
  for (const candidate of candidates) {
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as { PLATFORMS: string[] }
      return [...mod.PLATFORMS]
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`write-manifest.mjs not found at any of: ${candidates.join(", ")}`)
}

describe("a release publishes exactly what it built", () => {
  test("the pack directory is wiped after tests and before compile; helper download stays after that", () => {
    const workflow = releaseWorkflow()
    const wipe = "rm -rf dist-bin && mkdir -p dist-bin"
    expect(workflow).toContain(wipe)
    const testAt = workflow.indexOf("run: bun test")
    const wipeAt = workflow.indexOf(wipe)
    const compileAt = workflow.indexOf(`bun build --compile --minify --target="bun-${shVar("target")}"`)
    const downloadAt = workflow.indexOf("actions/download-artifact")
    expect(testAt).toBeGreaterThan(-1)
    expect(wipeAt).toBeGreaterThan(testAt)
    expect(compileAt).toBeGreaterThan(wipeAt)
    expect(downloadAt).toBeGreaterThan(compileAt)
  })

  test("build, pack, and expected-list loops iterate the same target strings", async () => {
    const workflow = releaseWorkflow()
    const platforms = await platformsFromManifest()
    const listed = releaseTargets(workflow)
    expect(listed).toEqual(platforms)

    const build = loopTargetsContaining(workflow, `bun build --compile --minify --target="bun-${shVar("target")}"`)
    const pack = loopTargetsContaining(workflow, "tar --sort=name")
    const expected = loopTargetsContaining(
      workflow,
      `"candle-${shVar("target")}" "candle-fido2-${shVar("target")}" "candle-${shVar("VERSION")}-${shVar("target")}.tar.gz"`,
    )
    expect(build).toBe(pack)
    expect(pack).toBe(expected)
    expect(build).toBe(shVar("RELEASE_TARGETS"))
  })

  test("the pack step compares the assets on disk against the ones it expects", () => {
    const workflow = releaseWorkflow()
    expect(workflow).toContain("expected-assets.txt")
    expect(workflow).toContain("actual-assets.txt")
    expect(workflow).toMatch(/if ! diff -u [^\n]*expected-assets\.txt [^\n]*actual-assets\.txt; then/)
    expect(workflow).toMatch(/if \[ -n "\$\{HELPER_ASSET\}" \]; then printf '%s\\n' "\$\{HELPER_ASSET\}"; fi/)
    expect(workflow.indexOf("actual-assets.txt")).toBeLessThan(workflow.indexOf("sha256sum candle-*"))
  })

  test("expected assets follow HELPER_ASSET: omit has no enclave zip, signed has exactly the moved archive", () => {
    const workflow = releaseWorkflow()
    const version = "1.2.3"
    const targets = releaseTargets(workflow)
    const fromList = targets.flatMap((target) => [
      `candle-${target}`,
      `candle-fido2-${target}`,
      `candle-${version}-${target}.tar.gz`,
    ])
    // The validate step only moves this name, and only under signed. Assembled rather than
    // spelled out: check-agentic-skills reads backticked spans in distribution/agentic as CLI
    // samples, and this test's oracle should match that step rather than invent a second name.
    expect(workflow).toContain(`"$asset" = "candle-enclave-${shVar("VERSION")}.app.zip"`)
    const moved = ["candle", "enclave", `${version}.app.zip`].join("-")

    const omitted = runExpectedAssets(workflow, { VERSION: version, HELPER_ASSET: "" })
    expect(omitted).toEqual([...fromList].sort())
    expect(omitted.some((name) => name.endsWith(".app.zip"))).toBe(false)

    const signed = runExpectedAssets(workflow, { VERSION: version, HELPER_ASSET: moved })
    expect(signed).toEqual([...fromList, moved].sort())
    expect(signed.filter((name) => name.endsWith(".app.zip"))).toEqual([moved])
  })
})
