/**
 * `candle update`'s tests. Every one of them runs through `run` rather than calling `update`
 * directly, so dispatch and the guard exemption are covered too.
 *
 * The Sigstore verifier is injected (`deps.verify`) rather than fed a real bundle: what these
 * tests pin is what update DOES with a verdict -- write beside the real binary, rename over it
 * only on a pass, remove the temp file on every other path -- and the verifier's own behavior has
 * its own suite (release-verify.test.ts, plus the compiled-binary test).
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { Deps } from "../deps"
import { run } from "../index"
import { RELEASE_ISSUER } from "../release"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse, type RouteHandler } from "../test-support"
import { CLI_VERSION } from "../version"

const NEWER = "99.0.0"
const BINARY = new TextEncoder().encode("#!/bin/sh\necho new\n")

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * The four URLs an update reads, keyed by PATH the way `createRoutedFetch` routes them. The
 * `routes` object comes back alongside the fake fetch because the fetch reads it on every call,
 * so a test can rewrite one route after the fact (the checksum case swaps SHA256SUMS).
 */
function fixture(version = NEWER) {
  const sum = sha256(BINARY)
  const manifest = {
    version,
    tag: `cli-v${version}`,
    assets: { "linux-x64": { name: "candle-linux-x64", sha256: sum, size: BINARY.length } },
  }
  const routes: Record<string, RouteHandler | RouteHandler[]> = {
    "/releases/latest/download/latest.json": () => jsonResponse(200, manifest),
    [`/releases/download/cli-v${version}/candle-linux-x64`]: () => new Response(BINARY),
    [`/releases/download/cli-v${version}/SHA256SUMS`]: () => new Response(`${sum}  candle-linux-x64\n`),
    [`/releases/download/cli-v${version}/candle-linux-x64.sigstore.json`]: () => jsonResponse(200, { fixture: true }),
  }
  return { manifest, sum, routes, ...createRoutedFetch(routes) }
}

/** A machine whose `candle` is a real binary in a writable bin dir, with every filesystem write
 * recorded instead of performed. */
function binaryDeps(fetch: typeof globalThis.fetch, extra: Partial<Deps> = {}) {
  const writes: { path: string; bytes: Uint8Array }[] = []
  const renames: { from: string; to: string }[] = []
  const unlinks: string[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch,
    stdout,
    stderr,
    execPath: "/home/u/.local/bin/candle",
    platformKey: "linux-x64",
    env: { CANDLE_RELEASE_BASE_URL: "https://example.test" },
    writeBytes: async (path, bytes) => {
      writes.push({ path, bytes })
    },
    rename: async (from, to) => {
      renames.push({ from, to })
    },
    unlink: async (path) => {
      unlinks.push(path)
    },
    ...extra,
  })
  return { deps, stdout, stderr, writes, renames, unlinks }
}

const paths = (calls: { url: string }[]) => calls.map((call) => new URL(call.url).pathname)

describe("update", () => {
  test("--check reports current and latest without writing anything", async () => {
    const f = fixture()
    const { deps, stdout, writes } = binaryDeps(f.fetch)
    const code = await run(["update", "--check"], deps)
    expect(code).toBe(0)
    expect(stdout.text).toContain(`${NEWER} available`)
    expect(stdout.text).toContain(CLI_VERSION)
    expect(writes).toHaveLength(0)
  })

  test("up to date says so and stops", async () => {
    const f = fixture(CLI_VERSION)
    const { deps, stdout, writes } = binaryDeps(f.fetch)
    expect(await run(["update"], deps)).toBe(0)
    expect(stdout.text).toContain(`candle ${CLI_VERSION} is up to date`)
    expect(writes).toHaveLength(0)
  })

  test("a newer release is downloaded next to the binary, verified, and renamed over it", async () => {
    const f = fixture()
    const seen: { bytes: Uint8Array; bundle: unknown; identityUri: string; issuer: string }[] = []
    const { deps, stdout, writes, renames } = binaryDeps(f.fetch, {
      verify: (bytes, bundle, identityUri, issuer) => {
        seen.push({ bytes, bundle, identityUri, issuer })
        return { ok: true }
      },
    })
    const code = await run(["update"], deps)
    expect(code).toBe(0)
    // What the verifier is asked is the whole point of the command: the exact bytes that were
    // written, against the identity of THAT version's release workflow.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.identityUri).toBe(
      `https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v${NEWER}`,
    )
    expect(seen[0]?.issuer).toBe(RELEASE_ISSUER)
    expect(Array.from(seen[0]?.bytes ?? [])).toEqual(Array.from(BINARY))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path.startsWith("/home/u/.local/bin/.candle-update-")).toBe(true)
    expect(Array.from(writes[0]?.bytes ?? [])).toEqual(Array.from(BINARY))
    expect(renames).toEqual([{ from: writes[0]?.path ?? "", to: "/home/u/.local/bin/candle" }])
    expect(stdout.text).toContain(`Updated candle ${CLI_VERSION} -> ${NEWER}`)
  })

  test("the temp path is unguessable, so no planted file can be renamed over the binary", async () => {
    // A path derived from the version alone is one anybody who can write the bin dir can create
    // between the verify and the rename, and the rename moves whatever is at that path, not the
    // bytes that were checked. The real `writeBytes` refuses an existing path on top of this.
    const seen = new Set<string>()
    for (let i = 0; i < 2; i++) {
      const f = fixture()
      const { deps, writes } = binaryDeps(f.fetch, { verify: () => ({ ok: true }) })
      expect(await run(["update"], deps)).toBe(0)
      const path = writes[0]?.path ?? ""
      expect(path.startsWith("/home/u/.local/bin/.candle-update-")).toBe(true)
      seen.add(path)
    }
    expect(seen.size).toBe(2)
  })

  test("a symlinked bin entry is resolved: the REAL file is what gets replaced", async () => {
    const f = fixture()
    const { deps, stdout, writes, renames } = binaryDeps(f.fetch, {
      verify: () => ({ ok: true }),
      realpath: async () => "/opt/candle/0.5.0/candle",
    })
    expect(await run(["update", "--json"], deps)).toBe(0)
    expect(writes[0]?.path.startsWith("/opt/candle/0.5.0/.candle-update-")).toBe(true)
    expect(renames).toEqual([{ from: writes[0]?.path ?? "", to: "/opt/candle/0.5.0/candle" }])
    expect(JSON.parse(stdout.text).path).toBe("/opt/candle/0.5.0/candle")
  })

  test("a checksum mismatch installs nothing and exits 1", async () => {
    const f = fixture()
    f.routes[`/releases/download/cli-v${NEWER}/SHA256SUMS`] = () =>
      new Response(`${"0".repeat(64)}  candle-linux-x64\n`)
    const { deps, stderr, renames, unlinks } = binaryDeps(f.fetch)
    expect(await run(["update"], deps)).toBe(1)
    expect(stderr.text).toContain("checksum")
    expect(renames).toHaveLength(0)
    expect(unlinks).toHaveLength(1)
  })

  test("a signature failure installs nothing, names the check, exits 1", async () => {
    const f = fixture()
    const { deps, stderr, renames, unlinks } = binaryDeps(f.fetch, {
      verify: () => ({ ok: false, reason: "no matching certificate identity" }),
    })
    expect(await run(["update"], deps)).toBe(1)
    expect(stderr.text).toContain("signature")
    expect(stderr.text).toContain("no matching certificate identity")
    expect(renames).toHaveLength(0)
    expect(unlinks).toHaveLength(1)
  })

  test("a rename that fails is a reported failure, not a throw, and leaves no temp file", async () => {
    const f = fixture()
    const { deps, stdout, stderr, unlinks } = binaryDeps(f.fetch, {
      verify: () => ({ ok: true }),
      rename: async () => {
        throw new Error("EXDEV")
      },
    })
    expect(await run(["update", "--json"], deps)).toBe(1)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("UPDATE_NOT_WRITABLE")
    expect(envelope.suggestion).toContain("--bin-dir")
    expect(unlinks).toHaveLength(1)
    expect(stderr.text).toBe("")
  })

  test("a cleanup that fails does not replace the failure being reported", async () => {
    // The temp file is already being abandoned; an unlink that throws must not become the error
    // the operator sees instead of the checksum mismatch that caused it.
    const f = fixture()
    f.routes[`/releases/download/cli-v${NEWER}/SHA256SUMS`] = () =>
      new Response(`${"0".repeat(64)}  candle-linux-x64\n`)
    const { deps, stderr } = binaryDeps(f.fetch, {
      unlink: async () => {
        throw new Error("EPERM")
      },
    })
    expect(await run(["update"], deps)).toBe(1)
    expect(stderr.text).toContain("checksum")
    expect(stderr.text).not.toContain("EPERM")
  })

  test("a manifest whose version is not a version is refused before anything is downloaded", async () => {
    // The one input here an attacker supplies. `releaseIdentityUri` throws on it (release.ts
    // explains what `{"version": "x|"}` used to do), and update must answer that with a failure,
    // not an uncaught throw -- and not with "up to date" either, which is what a lenient
    // `compareVersions` makes of a version that parses as 0.0.0.
    const routes: Record<string, RouteHandler | RouteHandler[]> = {
      "/releases/latest/download/latest.json": () =>
        jsonResponse(200, {
          version: "x|",
          tag: "cli-vx|",
          assets: { "linux-x64": { name: "c", sha256: "", size: 0 } },
        }),
    }
    const { fetch, calls } = createRoutedFetch(routes)
    const { deps, stderr, writes, renames } = binaryDeps(fetch)
    expect(await run(["update"], deps)).toBe(1)
    expect(stderr.text).toContain("invalid release version: x|")
    expect(writes).toHaveLength(0)
    expect(renames).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  test("a manifest that is readable but not a manifest is MANIFEST_INVALID, not UPDATE_UNREACHABLE", async () => {
    // The host answered. Reporting that as unreachable would send someone to check their network
    // for a release that is actually malformed.
    const { fetch } = createRoutedFetch({ "/releases/latest/download/latest.json": () => jsonResponse(200, {}) })
    const { deps, stdout } = binaryDeps(fetch)
    expect(await run(["update", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("MANIFEST_INVALID")
  })

  test("under a Homebrew Cellar it defers to brew", async () => {
    const f = fixture()
    const { deps, stdout } = binaryDeps(f.fetch, {
      execPath: "/opt/homebrew/bin/candle",
      realpath: async () => "/opt/homebrew/Cellar/candle/0.5.0/bin/candle",
    })
    expect(await run(["update"], deps)).toBe(0)
    expect(stdout.text).toContain("brew upgrade candle")
    expect(f.calls).toHaveLength(0)
  })

  test("as a script it points at npm, without asking the release host anything", async () => {
    const f = fixture()
    const { deps, stdout } = binaryDeps(f.fetch, { execPath: "/usr/local/bin/node" })
    expect(await run(["update"], deps)).toBe(0)
    expect(stdout.text).toContain("npm i -g @candledottv/cli@latest")
    expect(f.calls).toHaveLength(0)
  })

  test("an unwritable bin dir is UPDATE_NOT_WRITABLE", async () => {
    const f = fixture()
    const { deps, stderr } = binaryDeps(f.fetch, {
      writeBytes: async () => {
        throw new Error("EACCES")
      },
    })
    expect(await run(["update"], deps)).toBe(1)
    expect(stderr.text).toContain("Cannot write /home/u/.local/bin")
    expect(stderr.text).toContain("--bin-dir")
  })

  test("a platform with no release binary at all is UPDATE_UNSUPPORTED_PLATFORM", async () => {
    const f = fixture()
    const { deps, stdout } = binaryDeps(f.fetch, { platformKey: null })
    expect(await run(["update", "--json"], deps)).toBe(1)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("UPDATE_UNSUPPORTED_PLATFORM")
    expect(envelope.suggestion).toContain("npm i -g @candledottv/cli@latest")
  })

  test("a release with no asset for this platform is UPDATE_UNSUPPORTED_PLATFORM, naming both", async () => {
    const f = fixture()
    const { deps, stdout } = binaryDeps(f.fetch, { platformKey: "darwin-arm64" })
    expect(await run(["update", "--json"], deps)).toBe(1)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("UPDATE_UNSUPPORTED_PLATFORM")
    expect(envelope.message).toContain(`cli-v${NEWER}`)
    expect(envelope.message).toContain("darwin-arm64")
  })

  test("a manifest naming a different asset for this platform is refused before any download", async () => {
    // The manifest is the one input on this path an attacker supplies, and its asset name decides
    // which file gets downloaded, checked and renamed over the running binary. Every asset in a
    // release is signed by the same workflow under the same identity, install.sh included, so a
    // manifest naming install.sh here would satisfy the checksum AND the signature and still
    // leave a shell script where the binary was. `update` derives the name from the platform and
    // lets the manifest do nothing but agree with it.
    const f = fixture()
    f.manifest.assets["linux-x64"] = { name: "install.sh", sha256: f.sum, size: BINARY.length }
    const { deps, stdout, writes, renames } = binaryDeps(f.fetch)
    expect(await run(["update", "--json"], deps)).toBe(1)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("MANIFEST_INVALID")
    // Both names: the one it was offered and the one it will accept.
    expect(envelope.message).toContain("install.sh")
    expect(envelope.message).toContain("candle-linux-x64")
    expect(writes).toHaveLength(0)
    expect(renames).toHaveLength(0)
    // latest.json and nothing else: the refusal lands before the asset, SHA256SUMS or the bundle
    // is requested, so the file the manifest named is never fetched at all.
    expect(f.calls).toHaveLength(1)
  })

  test("--to pins a release, warning on a downgrade", async () => {
    const f = fixture("0.0.1")
    f.routes["/releases/download/cli-v0.0.1/latest.json"] = () => jsonResponse(200, f.manifest)
    // The unpinned URL answers something NEWER whose assets are registered nowhere, so a run that
    // read latest.json instead of the pinned tag's own manifest could not reach a rename.
    f.routes["/releases/latest/download/latest.json"] = () =>
      jsonResponse(200, { version: NEWER, tag: `cli-v${NEWER}`, assets: {} })
    const { deps, stderr, renames } = binaryDeps(f.fetch, { verify: () => ({ ok: true }) })
    expect(await run(["update", "--to", "cli-v0.0.1"], deps)).toBe(0)
    expect(stderr.text).toContain("downgrade")
    expect(renames).toHaveLength(1)
    expect(paths(f.calls)).toContain("/releases/download/cli-v0.0.1/latest.json")
    expect(paths(f.calls)).not.toContain("/releases/latest/download/latest.json")
  })

  test("a pinned manifest with no assets is MANIFEST_INVALID, naming the missing field", async () => {
    const f = fixture("0.0.1")
    f.routes["/releases/download/cli-v0.0.1/latest.json"] = () =>
      jsonResponse(200, { version: "0.0.1", tag: "cli-v0.0.1" })
    const { deps, stdout } = binaryDeps(f.fetch)
    expect(await run(["update", "--to", "cli-v0.0.1", "--json"], deps)).toBe(1)
    const envelope = JSON.parse(stdout.text)
    expect(envelope.code).toBe("MANIFEST_INVALID")
    expect(envelope.message).toContain("assets")
  })

  test("--json carries current, latest, updated and path, and failures are envelopes", async () => {
    const f = fixture()
    const { deps, stdout } = binaryDeps(f.fetch, { verify: () => ({ ok: true }) })
    expect(await run(["update", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual({
      current: CLI_VERSION,
      latest: NEWER,
      updated: true,
      path: "/home/u/.local/bin/candle",
    })
    const down = binaryDeps((async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof globalThis.fetch)
    expect(await run(["update", "--json"], down.deps)).toBe(1)
    expect(JSON.parse(down.stdout.text).code).toBe("UPDATE_UNREACHABLE")
    expect(down.stderr.text).toBe("")
  })
})
