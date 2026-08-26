import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import { CLI_VERSION } from "./version"

describe("CLI_VERSION", () => {
  test("matches package.json's version field", () => {
    expect(CLI_VERSION).toBe(pkg.version)
  })

  // The COMPILED binary's own `--version` was asserted here too, wrapped in "if a binary happens
  // to have been built already" so that the suite would need no build step. Nothing built one
  // before this file ran, in CI or locally, so that assertion never executed and the check was
  // decorative. It now lives in release-verify.compiled.test.ts, which builds the binary itself
  // and asserts unconditionally.
})
