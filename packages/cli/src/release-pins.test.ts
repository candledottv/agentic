/**
 * The two version pins the signed release rests on, asserted from inside the package so they
 * travel with it to the exported mirror (candledottv/agentic) and are checked by the release
 * workflow's own `bun test` before it compiles anything.
 *
 * They are guard tests: both pins are correct today and these exist to make loosening one a test
 * failure rather than a silent change in what gets compiled into a signed binary.
 */

import { expect, test } from "bun:test"
import pkg from "../package.json"

/** A version that resolves to exactly one release: no range operator, no wildcard. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Every declared range for `name`, from either dependency block. */
function declaredRanges(name: string): string[] {
  return [
    ...Object.entries((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...Object.entries((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  ]
    .filter(([declared]) => declared === name)
    .map(([, range]) => range)
}

/**
 * Ember Phase 2 (BE-136, ED-2, ED-13): the three libraries the vault's cryptography IS.
 *
 * ED-2's reasoning, which applies to all three: a KDF -- and equally a derivation stack -- compiled
 * into a signed binary must be a FIXED SET OF BYTES. A caret range means the bytes cosign attests
 * to depend on whatever was newest when the release job ran, so two builds of the same tag can
 * differ, and a derived address is the last thing that may move under an operator.
 *
 * `@scure/bip39`'s own dependencies (`@noble/hashes`, `@scure/base`) need no separate pin here: the
 * first is pinned on this list and the second is declared already.
 */
test("every library the vault's cryptography rests on is pinned to an exact version", () => {
  for (const name of ["@noble/hashes", "@noble/curves", "@scure/bip39"]) {
    const ranges = declaredRanges(name)
    // A filter that silently matched nothing would make the assertion below vacuous, and an
    // undeclared import is exactly the failure class the mirror caught the hard way (E21).
    expect(`${name}: ${ranges.length} declaration(s)`).toBe(`${name}: 1 declaration(s)`)
    const range = ranges[0] as string
    // Named in the failure so the offending entry is the message, not something to go and find.
    expect(`${name}@${range}`).toBe(`${name}@${range.replace(/^[\^~>=<]+\s*/, "")}`)
    expect(range).toMatch(EXACT)
  }
})

test("every @sigstore dependency is pinned to an exact version", () => {
  // Either block: the three verifier packages are devDependencies (they are bundled into
  // dist/index.js at build time, so the published package must not ask Node 18 to install them),
  // and a future one landing in `dependencies` must be pinned just the same.
  const entries = [
    ...Object.entries((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...Object.entries((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  ].filter(([name]) => name.startsWith("@sigstore/"))

  // The verifier's own three, at minimum: a filter that silently matched nothing would make every
  // assertion below vacuous.
  expect(entries.length).toBeGreaterThanOrEqual(3)
  for (const [name, range] of entries) {
    // Named in the failure so the offending entry is the message, not something to go and find.
    expect(`${name}@${range}`).toBe(`${name}@${range.replace(/^[\^~>=<]+\s*/, "")}`)
    expect(range).toMatch(EXACT)
  }
})

test("the CLI's .bun-version is the Bun the monorepo pins", async () => {
  const pinned = (await Bun.file(new URL("../.bun-version", import.meta.url)).text()).trim()
  expect(pinned).toMatch(EXACT)

  // The monorepo root is the second copy of this pin and therefore the thing it can drift from:
  // release.yaml and the mirror's ci.yaml both read `bun-version-file: packages/cli/.bun-version`,
  // so a monorepo bumped to a Bun the CLI does not build under would otherwise go unnoticed until
  // a release. In the exported mirror there is no second copy (its root package.json has no
  // packageManager field), and a check with nothing to compare against is skipped, not failed.
  const rootFile = Bun.file(new URL("../../../package.json", import.meta.url))
  if (!(await rootFile.exists())) return
  const root = JSON.parse(await rootFile.text()) as { packageManager?: string }
  if (root.packageManager === undefined) return
  expect(root.packageManager).toBe(`bun@${pinned}`)
})
