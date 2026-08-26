/**
 * `candle verify`, driven through `run()`. The cryptography itself is release-verify.test.ts's
 * subject and the compiled binary is release-verify.compiled.test.ts's; what is pinned here is
 * the command around it: which arguments are a usage error, where the identity comes from when
 * nobody typed one, and that none of it costs a request (`fetch` throws in every test below).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { run } from "../index"
import { releaseIdentityUri } from "../release"
import { createCapture, createTestDeps } from "../test-support"

const fx = join(import.meta.dir, "..", "..", "test-fixtures", "sigstore")
const FILE = "/downloads/candle"
const BUNDLE = "/downloads/candle.sigstore.json"
const IDENTITY = readFileSync(join(fx, "identity.txt"), "utf8").trim()

const fixtureBytes = new Uint8Array(readFileSync(join(fx, "fixture.bin")))
const fixtureBundle = readFileSync(join(fx, "fixture.sigstore.json"), "utf8")

/** A filesystem of exactly the paths a test names: anything else throws, the way a real missing
 * file would, so a command that reads something it was not given fails loudly. */
function files(text: Record<string, string>, bytes: Record<string, Uint8Array> = {}) {
  return {
    readFile: async (path: string) => {
      const found = text[path]
      if (found === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return found
    },
    readBytes: async (path: string) => {
      const found = bytes[path]
      if (found === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return found
    },
  }
}

const unusedFetch = (() => {
  throw new Error("fetch should not be called for this test")
}) as unknown as typeof fetch

describe("verify", () => {
  test("verifies the file against the named identity and says which one, exit 0", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE, "--identity", IDENTITY],
      createTestDeps({
        fetch: unusedFetch,
        stdout,
        stderr,
        ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }),
      }),
    )
    expect(code).toBe(0)
    expect(stdout.text).toBe(`verified: ${IDENTITY} (identity from --identity)\n`)
    expect(stderr.text).toBe("")
  })

  test("--json puts exactly one JSON value on stdout", async () => {
    const stdout = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE, "--identity", IDENTITY, "--json"],
      createTestDeps({
        fetch: unusedFetch,
        stdout,
        ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }),
      }),
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual({
      ok: true,
      file: FILE,
      identity: IDENTITY,
      issuer: "https://token.actions.githubusercontent.com",
      identitySource: "identity from --identity",
    })
  })

  // The identity nobody typed. A release download directory holds latest.json beside the assets
  // it describes, so the manifest's version is the release identity the bundle has to carry.
  test("with no --identity, the release identity comes from the latest.json beside the bundle", async () => {
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE],
      createTestDeps({
        fetch: unusedFetch,
        stderr,
        ...files(
          {
            [BUNDLE]: fixtureBundle,
            "/downloads/latest.json": JSON.stringify({ version: "9.9.9", tag: "cli-v9.9.9" }),
          },
          { [FILE]: fixtureBytes },
        ),
      }),
    )
    // The fixture is not ours, so it refuses -- naming the identity it derived, which is the
    // assertion: the version reached the policy.
    expect(code).toBe(1)
    expect(stderr.text).toContain(releaseIdentityUri("9.9.9"))
  })

  /**
   * The version in a downloaded latest.json is attacker influenced, and release-verify.ts turns
   * the identity into a regular expression. `"version": "x|"` made the identity `...cli-vx|`,
   * whose alternation matches everything, and the command printed `verified:` for a file signed by
   * goreleaser. `releaseIdentityUri` now refuses the version, and the command reports it.
   */
  test("a latest.json version that is not a version is refused, and nothing is ever verified", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE],
      createTestDeps({
        fetch: unusedFetch,
        stdout,
        stderr,
        ...files(
          { [BUNDLE]: fixtureBundle, "/downloads/latest.json": JSON.stringify({ version: "x|", tag: "cli-vx|" }) },
          { [FILE]: fixtureBytes },
        ),
      }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toContain("invalid release version: x|")
    expect(stdout.text).not.toContain("verified:")
  })

  // The other provenance: a real verification whose identity nobody typed. The fixture is signed
  // by goreleaser, so this drives the same path with a --identity that matches the manifest form
  // only in where it came from -- what is asserted is the clause, which is the whole point of
  // carrying provenance rather than recomputing it.
  test("a success names where its identity came from, so a typed one and a derived one do not read alike", async () => {
    const typed = createCapture()
    expect(
      await run(
        ["verify", FILE, "--bundle", BUNDLE, "--identity", IDENTITY],
        createTestDeps({
          fetch: unusedFetch,
          stdout: typed,
          ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }),
        }),
      ),
    ).toBe(0)
    expect(typed.text).toContain("(identity from --identity)")
    expect(typed.text).not.toContain("latest.json")
  })

  test("with no --identity and no latest.json, it refuses to guess: usage error, exit 2", async () => {
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE],
      createTestDeps({ fetch: unusedFetch, stderr, ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }) }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("--identity is required")
  })

  test("altered bytes are refused with the digest as the reason, exit 1", async () => {
    const altered = new Uint8Array(fixtureBytes)
    altered[0] = (altered[0] ?? 0) ^ 0xff
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE, "--identity", IDENTITY],
      createTestDeps({
        fetch: unusedFetch,
        stdout,
        stderr,
        ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: altered }),
      }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toContain("digest does not match")
    expect(stdout.text).toBe("")
  })

  test("a missing --bundle is a usage error, exit 2, before the file is read", async () => {
    const stderr = createCapture()
    const code = await run(["verify", FILE], createTestDeps({ fetch: unusedFetch, stderr, ...files({}, {}) }))
    expect(code).toBe(2)
    expect(stderr.text).toContain("--bundle is required")
  })

  test("an unreadable file is a failure, not a crash, exit 1", async () => {
    const stderr = createCapture()
    const code = await run(
      ["verify", "/downloads/missing", "--bundle", BUNDLE, "--identity", IDENTITY],
      createTestDeps({ fetch: unusedFetch, stderr, ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }) }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toContain("Could not read /downloads/missing")
  })

  test("an unknown flag is a usage error naming it, exit 2", async () => {
    const stderr = createCapture()
    const code = await run(
      ["verify", FILE, "--bundle", BUNDLE, "--bogus"],
      createTestDeps({ fetch: unusedFetch, stderr, ...files({ [BUNDLE]: fixtureBundle }, { [FILE]: fixtureBytes }) }),
    )
    expect(code).toBe(2)
    expect(stderr.text).toContain("--bogus")
  })
})
