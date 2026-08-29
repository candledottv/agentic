/**
 * Drift guard for the CLI's version, which is stated twice.
 *
 * `src/version.ts` keeps it as a hand-maintained constant rather than reading package.json,
 * deliberately: the published bundle is a single self-contained dist/index.js with no package.json
 * to read back at run time. That is a good reason for the copy to exist, and no reason at all for
 * it to be allowed to disagree.
 *
 * Nothing enforced it until now. The convention was a sentence in version.ts's own doc comment
 * ("bump this alongside package.json's version field on release"), and index.test.ts asserts
 * `--version` against the imported constant, so a mismatch is invisible to it: both sides move
 * together and the test still passes.
 *
 * The failure that shape produces is quiet and public. npm publish is version-gated on
 * package.json, so bumping only that ships a release whose own `candle --version` reports the
 * previous number, on every machine that installs it. Caught in review on 2026-08-29, one commit
 * before it would have shipped with 0.8.0.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CLI_VERSION } from "./version"

describe("CLI version", () => {
  test("version.ts agrees with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }
    expect(CLI_VERSION).toBe(pkg.version)
  })
})
