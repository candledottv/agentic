/**
 * The owner's condition for shipping the Bun crypto shim: prove it inside a COMPILED binary, not
 * only under `bun test`. `bun test` and `bun build --compile` are the same engine, but they are
 * not the same module graph -- the shim only works if it is evaluated before any Sigstore module,
 * and a bundler is free to reorder what a test file's import order made obvious. So this builds
 * the real `candle` and runs `candle verify` against the fixture as a user would.
 *
 * It builds the binary itself (a few seconds) rather than depending on a prior `build:binary`, so
 * the proof runs on every CI run with nothing to remember.
 */

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import pkg from "../package.json"

const dir = join(import.meta.dir, "..")
const bin = join(dir, "dist-bin", "candle")
const fx = join(dir, "test-fixtures", "sigstore")
const identity = readFileSync(join(fx, "identity.txt"), "utf8").trim()
const issuer = readFileSync(join(fx, "issuer.txt"), "utf8").trim()

async function build(): Promise<void> {
  const proc = Bun.spawn(["bun", "build", "--compile", "--minify", "src/index.ts", "--outfile", bin], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`bun build --compile failed (${code}):\n${err}`)
}

async function verify(file: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(
    [bin, "verify", file, "--bundle", join(fx, "fixture.sigstore.json"), "--identity", identity, "--issuer", issuer],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err }
}

test("the compiled binary reports its version, verifies the fixture, and refuses a tampered copy", async () => {
  await build()

  // Unconditional, and here rather than in version.test.ts: this file is the only one that builds
  // the binary, so it is the only place the assertion can run at all. Wrapped in "if a binary
  // exists" beside the source-level check, it never executed.
  const versioned = Bun.spawn([bin, "--version"], { stdout: "pipe" })
  expect((await new Response(versioned.stdout).text()).trim()).toBe(pkg.version)
  expect(await versioned.exited).toBe(0)

  const ok = await verify(join(fx, "fixture.bin"))
  expect(ok.err).toBe("")
  expect(ok.code).toBe(0)
  expect(ok.out).toContain("verified:")

  // One flipped byte, written as bytes: the fixture is committed as `.bin` precisely so nothing
  // normalizes it, and a round trip through text would defeat that.
  const original = new Uint8Array(readFileSync(join(fx, "fixture.bin")))
  const tamperedBytes = new Uint8Array(original)
  tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff
  const tampered = join(dir, "dist-bin", "fixture-tampered.bin")
  await Bun.write(tampered, tamperedBytes)

  const bad = await verify(tampered)
  expect(bad.code).toBe(1)
  expect(bad.err).toContain("digest does not match")
}, 120_000)
