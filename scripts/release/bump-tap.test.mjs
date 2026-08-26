/**
 * `bump-tap.sh` runs once per release, inside the release job, holding a token for
 * candledottv/homebrew-tap. Nothing else exercises it, and the two things it must not get wrong
 * are exactly the two asserted here: every placeholder in the formula template is substituted
 * with the checksum of the right tarball, and a SHA256SUMS missing one of the four tarballs stops
 * the run rather than writing a formula with a hole in it. A formula carrying `__SHA_linux_x64__`
 * where a checksum belongs is what `brew install candle` would then try to download.
 *
 * The script is run as a real `bash` subprocess against temp directories, not reimplemented: it
 * is a shell script, and what is being checked is the shell.
 */
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "bump-tap.sh")
const VERSION = "0.6.0"
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
/** A distinct, recognizable checksum per target, so a formula that substitutes the WRONG one is a
 * failure rather than four identical strings that cannot disagree. */
const sumFor = (target) =>
  target
    .replace(/[^a-z0-9]/g, "")
    .padEnd(64, "0")
    .slice(0, 64)

/** The release tarball's name, assembled rather than written out. scripts/check-agentic-skills.ts
 * reads every backticked span in this tree as a code sample, and a template literal that spells
 * the asset prefix out reads to it as a stale CLI invocation. */
const tarball = (target) => ["candle", VERSION, target].join("-").concat(".tar.gz")

/** A dist directory whose SHA256SUMS lists the release's four tarballs, minus `omit` if given. */
function makeDist(omit) {
  const dist = mkdtempSync(join(tmpdir(), "candle-tap-dist-"))
  const lines = TARGETS.filter((t) => t !== omit).map((t) => `${sumFor(t)}  ${tarball(t)}`)
  writeFileSync(join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`)
  return dist
}

/** A git repo standing in for the tap checkout. It has no remote, so the script's final `git push`
 * fails; that is deliberate and tolerated (see the positive test), because everything this script
 * decides has already happened by then. */
function makeTap() {
  const tap = mkdtempSync(join(tmpdir(), "candle-tap-"))
  const git = (...args) => spawnSync("git", args, { cwd: tap, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "test")
  writeFileSync(join(tap, "README.md"), "tap\n")
  git("add", "README.md")
  git("commit", "-qm", "init")
  return tap
}

function runBump(dist, tap) {
  return spawnSync("bash", [SCRIPT, VERSION, dist, tap], { encoding: "utf8" })
}

test("writes the formula with all four checksums substituted and commits it", () => {
  const dist = makeDist()
  const tap = makeTap()
  try {
    runBump(dist, tap)
    // The exit code is NOT asserted: `git push origin HEAD` cannot succeed against a repo with no
    // remote. What matters is the state it left behind before that.
    const formula = readFileSync(join(tap, "Formula", "candle.rb"), "utf8")
    expect(formula).not.toContain("__SHA_")
    expect(formula).not.toContain("__VERSION__")
    expect(formula).toContain(`version "${VERSION}"`)
    for (const target of TARGETS) {
      // Each checksum sits under its own platform's url, not merely somewhere in the file.
      expect(formula).toContain(`${tarball(target)}"\n      sha256 "${sumFor(target)}"`)
    }
    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: tap, encoding: "utf8" })
    expect(log.stdout.trim()).toBe(`candle ${VERSION}`)
    const named = spawnSync("git", ["show", "--stat", "--pretty=", "HEAD"], { cwd: tap, encoding: "utf8" })
    expect(named.stdout).toContain("Formula/candle.rb")
  } finally {
    rmSync(dist, { recursive: true, force: true })
    rmSync(tap, { recursive: true, force: true })
  }
})

test("a tarball missing from SHA256SUMS exits 1 and writes no formula at all", () => {
  const dist = makeDist("linux-x64")
  const tap = makeTap()
  // A pre-existing Formula directory, so "no formula" is a fact about the file rather than about
  // mkdir never having run.
  mkdirSync(join(tap, "Formula"), { recursive: true })
  try {
    const res = runBump(dist, tap)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(tarball("linux-x64"))
    expect(existsSync(join(tap, "Formula", "candle.rb"))).toBe(false)
    // And nothing was committed: the tap is still at its initial commit.
    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: tap, encoding: "utf8" })
    expect(log.stdout.trim()).toBe("init")
  } finally {
    rmSync(dist, { recursive: true, force: true })
    rmSync(tap, { recursive: true, force: true })
  }
})
