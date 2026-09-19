/**
 * What a signed release is allowed to contain.
 *
 * The release job runs `bun test` BEFORE it compiles the binaries, in the same working directory
 * tree, and then packs and uploads everything matching `candle-*` out of `packages/cli/dist-bin`.
 * So a test that compiles a binary named `candle-something` into that directory does not just
 * leave scratch behind: it publishes it. T49's vault parity test did exactly that, and
 * `candle-vault-parity` shipped as a 96 MB asset of 0.10.0 and 0.11.0, listed in the signed
 * SHA256SUMS and named by no documentation, no manifest and no installer.
 *
 * Two guards, because either one alone can be routed around: the workflow now refuses to publish
 * a set of assets it did not build, and no test may aim a `candle-*` output at `dist-bin`.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const srcDir = resolve(import.meta.dir)
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

describe("a release publishes exactly what it built", () => {
  test("the pack step compares the assets on disk against the ones it expects", () => {
    const workflow = releaseWorkflow()
    // Two-sided on purpose: a stray file fails, and so does a MISSING expected asset, which is the
    // failure a one-sided allowlist would wave through.
    expect(workflow).toContain("expected-assets.txt")
    expect(workflow).toContain("actual-assets.txt")
    expect(workflow).toMatch(/if ! diff -u [^\n]*expected-assets\.txt [^\n]*actual-assets\.txt; then/)
    // The expected set is built from the same four targets the binaries are, plus the helper asset
    // when the policy included it, so it cannot drift from what the build produces. Regexes rather
    // than plain strings because the shell's `${...}` is a template placeholder to the linter.
    expect(workflow).toMatch(/"candle-\$\{target\}" "candle-fido2-\$\{target\}" "candle-\$\{VERSION\}-\$\{target\}/)
    expect(workflow).toMatch(/if \[ -n "\$\{HELPER_ASSET\}" \]; then printf '%s\\n' "\$\{HELPER_ASSET\}"; fi/)
    // And the check runs before the checksums are written, not after the upload.
    expect(workflow.indexOf("actual-assets.txt")).toBeLessThan(workflow.indexOf("sha256sum candle-*"))
  })

  test("no test aims a candle-* output at dist-bin, which the release would publish", () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (name.endsWith(".ts") && /"dist-bin",\s*"candle-/.test(readFileSync(path, "utf8"))) {
          offenders.push(path.slice(srcDir.length + 1))
        }
      }
    }
    walk(srcDir)
    // `release-verify.compiled.test.ts` compiles `dist-bin/candle`, which the `candle-*` glob does
    // not match, so it stays. Anything with the hyphen would ship.
    expect(offenders).toEqual([])
  })
})
