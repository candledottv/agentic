import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Runs the real install.sh against a local fixture server standing in for GitHub Releases. The
 * script's platform detection reads the host, so the fixture publishes assets for THIS machine's
 * os/arch and the "binary" is a shell script that prints a version, which is all `--version` needs.
 */

/**
 * Bun's default is 5s, and these are the wrong tests for it.
 *
 * Every case here spawns the real `install.sh` as a bash subprocess -- which fetches from the
 * fixture server, hashes the asset, may run a stub verifier, and writes an rc file -- and several
 * then spawn a SECOND shell to source that rc and echo `$PATH`, on top of temp-dir creation and
 * an `rm -rf`. That is process and filesystem work, not computation, so its wall time depends on
 * how loaded the machine is rather than on anything the test does.
 *
 * On a busy CI runner it crossed 5s and the suite failed with exit 143 (SIGTERM, the timeout
 * killing bash) on 2026-08-27, then passed on a re-run with no code change. A flaky security
 * check is worse than a slow one: it teaches everyone to re-run rather than read.
 *
 * Set for the file rather than per test, because the reason applies to all of them equally.
 */
setDefaultTimeout(30_000)
const SCRIPT = join(import.meta.dir, "..", "install.sh")
const os = process.platform === "darwin" ? "darwin" : "linux"
const arch = process.arch === "arm64" ? "arm64" : "x64"
const ASSET = `candle-${os}-${arch}`
const FAKE_BINARY = '#!/bin/sh\necho "candle 9.9.9"\n'
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

let server: ReturnType<typeof Bun.serve>
let base: string
let fixtures: Record<string, string>
// Every request path the fixture server has seen, in order. Tests that care reset it first
// (requestPaths = []) so a later assertion is about their own run, not an earlier test's.
let requestPaths: string[] = []

beforeAll(() => {
  fixtures = {
    [ASSET]: FAKE_BINARY,
    SHA256SUMS: `${sha256(FAKE_BINARY)}  ${ASSET}\n`,
    // Pretty-printed, matching the real release workflow (JSON.stringify(manifest, null, 2)): the
    // asset's "name" and "sha256" land on different lines, which is the shape that broke a
    // line-oriented sed extraction of the manifest checksum (see install.sh's step 5 comment).
    "latest.json": JSON.stringify(
      {
        version: "9.9.9",
        tag: "cli-v9.9.9",
        assets: { [`${os}-${arch}`]: { name: ASSET, sha256: sha256(FAKE_BINARY), size: FAKE_BINARY.length } },
      },
      null,
      2,
    ),
    [`${ASSET}.sigstore.json`]: "{}",
  }
  server = Bun.serve({
    port: 0,
    fetch(req) {
      // Both URL shapes the script uses: releases/latest/download/<name> and releases/download/<tag>/<name>.
      const pathname = new URL(req.url).pathname
      requestPaths.push(pathname)
      const name = pathname.split("/").pop() ?? ""
      const body = fixtures[name]
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body)
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop())

async function runInstaller(
  args: string[],
  env: Record<string, string> = {},
  stubDir?: string,
  beforeRun?: (home: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "candle-install-"))
  if (beforeRun) await beforeRun(home)
  const binDir = join(home, ".local", "bin")
  const path = stubDir ? `${stubDir}:/usr/bin:/bin:/usr/local/bin` : "/usr/bin:/bin:/usr/local/bin"
  // Most cases install on the checksum alone through the explicit escape hatch; the fail-closed
  // test clears it, and the cosign cases exercise the real default path with a stub verifier.
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: {
      HOME: home,
      PATH: path,
      SHELL: "/bin/zsh",
      CANDLE_RELEASE_BASE_URL: base,
      CANDLE_INSTALL_DIR: binDir,
      CANDLE_INSTALL_ALLOW_UNSIGNED: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout, stderr, home, binDir }
}

// Runs the installer with SHELL set to the given shell, then sources the rc file it wrote in a
// real instance of that shell and returns the resulting PATH. This is what proves the PATH block
// install.sh appends actually works once sourced, not just that its text looks right.
async function sourcedPath(shell: "bash" | "zsh", rcFile: string) {
  const beforeRun =
    shell === "bash"
      ? async (home: string) => {
          // A fresh mkdtemp HOME has neither .bashrc nor .bash_profile, and install.sh falls back
          // to .bash_profile when .bashrc is missing (see install.sh's PATH step). Create an empty
          // .bashrc first so the choice is deterministic and matches rcFile.
          await writeFile(join(home, ".bashrc"), "")
        }
      : undefined
  const r = await runInstaller([], { SHELL: `/bin/${shell}` }, undefined, beforeRun)
  expect(r.code).toBe(0)
  const shellProc = Bun.spawn([shell, "-c", `source "$HOME/${rcFile}"; echo "$PATH"`], {
    env: { HOME: r.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
    stdout: "pipe",
  })
  const finalPath = (await new Response(shellProc.stdout).text()).trim()
  await rm(r.home, { recursive: true, force: true })
  return { finalPath, binDir: r.binDir }
}

describe("install.sh", () => {
  test("installs the platform binary, verifies its checksum, and writes the PATH block once", async () => {
    requestPaths = []
    const first = await runInstaller([])
    expect(first.stderr).toBe("")
    expect(first.code).toBe(0)
    expect(requestPaths).toContain("/releases/latest/download/latest.json")
    expect(await readFile(join(first.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
    expect(first.stdout).toContain("candle 9.9.9")
    expect(first.stdout).toContain("Next: candle setup")
    const rc = await readFile(join(first.home, ".zshrc"), "utf8")
    expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"')
    // Second run against the same HOME: the block is not duplicated.
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: {
        HOME: first.home,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        CANDLE_RELEASE_BASE_URL: base,
        CANDLE_INSTALL_DIR: first.binDir,
        CANDLE_INSTALL_ALLOW_UNSIGNED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    const rcAgain = await readFile(join(first.home, ".zshrc"), "utf8")
    expect(rcAgain.split("# candle installer").length).toBe(2)
    await rm(first.home, { recursive: true, force: true })
  })

  test("the rc block prepends: ~/.local/bin beats /usr/local/bin in a shell that sourced it (bash)", async () => {
    const { finalPath, binDir } = await sourcedPath("bash", ".bashrc")
    expect(finalPath.indexOf(binDir)).toBeGreaterThanOrEqual(0)
    expect(finalPath.indexOf(binDir)).toBeLessThan(finalPath.indexOf("/usr/local/bin"))
  })

  test.skipIf(!Bun.which("zsh"))(
    "the rc block prepends: ~/.local/bin beats /usr/local/bin in a shell that sourced it (zsh)",
    async () => {
      const { finalPath, binDir } = await sourcedPath("zsh", ".zshrc")
      expect(finalPath.indexOf(binDir)).toBeGreaterThanOrEqual(0)
      expect(finalPath.indexOf(binDir)).toBeLessThan(finalPath.indexOf("/usr/local/bin"))
    },
  )

  test("--no-modify-path leaves the rc file alone and prints the export line", async () => {
    const r = await runInstaller(["--no-modify-path"])
    expect(r.code).toBe(0)
    await expect(readFile(join(r.home, ".zshrc"), "utf8")).rejects.toThrow()
    expect(r.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"')
    await rm(r.home, { recursive: true, force: true })
  })

  test("a checksum mismatch installs nothing and exits 1", async () => {
    const good = fixtures.SHA256SUMS as string
    fixtures.SHA256SUMS = `${"0".repeat(64)}  ${ASSET}\n`
    try {
      const r = await runInstaller([])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("checksum")
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    } finally {
      fixtures.SHA256SUMS = good
    }
  })

  test("with cosign on PATH the signature is verified against the pinned identity", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "candle-stub-"))
    const log = join(stubDir, "cosign.log")
    await writeFile(join(stubDir, "cosign"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`)
    await chmod(join(stubDir, "cosign"), 0o755)
    const r = await runInstaller([], {}, stubDir)
    expect(r.code).toBe(0)
    const calls = await readFile(log, "utf8")
    expect(calls).toContain("verify-blob")
    // Without --new-bundle-format cosign also accepts its own LEGACY bundle shape
    // ({"base64Signature","cert","rekorBundle"}), which candle's in-process verifier refuses.
    // That gap is what let 0.6.0 ship assets this installer took and `candle verify` would not.
    expect(calls).toContain("--new-bundle-format")
    expect(calls).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com")
    expect(calls).toContain(
      "--certificate-identity-regexp ^https://github.com/candledottv/agentic/\\.github/workflows/release\\.yaml@refs/tags/cli-v",
    )
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })

  test("a failing verifier stops the install", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "candle-stub-"))
    await writeFile(join(stubDir, "cosign"), "#!/bin/sh\nexit 1\n")
    await chmod(join(stubDir, "cosign"), 0o755)
    const r = await runInstaller([], {}, stubDir)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("signature")
    await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })

  test("without a verifier the install fails closed, and the escape hatch is explicit", async () => {
    // Only what bash/curl/shasum need, and nothing more: a machine with a real cosign or gh
    // sitting in /usr/local/bin (a common Homebrew/local-install location) must not turn this
    // green by accident.
    const NO_VERIFIER_PATH = "/usr/bin:/bin"
    const closed = await runInstaller([], { CANDLE_INSTALL_ALLOW_UNSIGNED: "", PATH: NO_VERIFIER_PATH })
    expect(closed.code).toBe(1)
    // Remedies that actually work, named per platform. `apt install cosign` and `dnf install
    // cosign` were in this message and neither package exists in Debian, Ubuntu or Fedora: the
    // one instruction a Linux user was given did nothing but fail. Upstream ships a single
    // binary, and gh is the other way through.
    expect(closed.stderr).toContain("brew install cosign")
    expect(closed.stderr).toContain("https://github.com/sigstore/cosign/releases")
    expect(closed.stderr).toContain("gh auth login")
    expect(closed.stderr).not.toContain("apt")
    expect(closed.stderr).not.toContain("dnf")
    expect(closed.stderr).toContain("CANDLE_INSTALL_ALLOW_UNSIGNED=1")
    await expect(readFile(join(closed.binDir, "candle"), "utf8")).rejects.toThrow()
    await rm(closed.home, { recursive: true, force: true })
    const allowed = await runInstaller([], { CANDLE_INSTALL_ALLOW_UNSIGNED: "1", PATH: NO_VERIFIER_PATH })
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain("not verified")
    expect(allowed.stdout).toContain("cosign verify-blob")
    await rm(allowed.home, { recursive: true, force: true })
  })

  test("a pinned --version fetches that tag's assets", async () => {
    requestPaths = []
    const r = await runInstaller(["--version", "cli-v9.9.9"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("candle 9.9.9")
    expect(requestPaths).toContain("/releases/download/cli-v9.9.9/latest.json")
    await rm(r.home, { recursive: true, force: true })
  })

  test("--to is the same pin, in the CLI's own spelling", async () => {
    // `candle update --to <tag>` is what the CLI takes, and the two tools naming one idea
    // differently is the sort of thing nobody looks up twice. Both spellings work here; the usage
    // text leads with --to.
    requestPaths = []
    const flag = await runInstaller(["--to", "cli-v9.9.9"])
    expect(flag.code).toBe(0)
    expect(flag.stdout).toContain("candle 9.9.9")
    expect(requestPaths).toContain("/releases/download/cli-v9.9.9/latest.json")
    await rm(flag.home, { recursive: true, force: true })

    requestPaths = []
    const equals = await runInstaller(["--to=cli-v9.9.9"])
    expect(equals.code).toBe(0)
    expect(requestPaths).toContain("/releases/download/cli-v9.9.9/latest.json")
    await rm(equals.home, { recursive: true, force: true })

    const help = await runInstaller(["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("--to <tag>")
    expect(help.stdout).toContain("--version")
  })

  test("the gh fallback pins the signing workflow, not just the repo", async () => {
    // `--repo` alone accepts any attestation from candledottv/agentic, and this repo runs more
    // than one workflow with `id-token: write` reachable from it. The certificate identity the
    // cosign path checks names the workflow FILE; the gh path has to check the same thing or the
    // two verifiers do not mean the same thing.
    const stubDir = await mkdtemp(join(tmpdir(), "candle-stub-gh-"))
    const log = join(stubDir, "gh.log")
    await writeFile(join(stubDir, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`)
    await chmod(join(stubDir, "gh"), 0o755)
    // No cosign anywhere on this PATH (a real one in /usr/local/bin would take the other branch),
    // and no escape hatch: this install only succeeds if the stub gh actually verified it.
    const r = await runInstaller([], { CANDLE_INSTALL_ALLOW_UNSIGNED: "", PATH: `${stubDir}:/usr/bin:/bin` }, stubDir)
    expect(r.code).toBe(0)
    const calls = await readFile(log, "utf8")
    expect(calls).toContain("attestation verify")
    expect(calls).toContain("--repo candledottv/agentic")
    expect(calls).toContain("--signer-workflow candledottv/agentic/.github/workflows/release.yaml")
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })

  test("an existing Homebrew candle is left alone, and --force overrides it", async () => {
    // Mimic Homebrew's layout: <bin>/candle is a symlink into a Cellar directory beside it. The
    // script follows the symlink and checks the target for "Cellar/candle/", not the link itself.
    const root = await mkdtemp(join(tmpdir(), "candle-brew-"))
    const stubDir = join(root, "bin")
    await mkdir(stubDir, { recursive: true })
    const cellarBin = join(root, "Cellar", "candle", "0.0.0", "bin")
    await mkdir(cellarBin, { recursive: true })
    const cellarCandle = join(cellarBin, "candle")
    await writeFile(cellarCandle, '#!/bin/sh\necho "candle 0.0.0"\n')
    await chmod(cellarCandle, 0o755)
    await symlink(cellarCandle, join(stubDir, "candle"))

    const deferred = await runInstaller([], {}, stubDir)
    expect(deferred.code).toBe(0)
    expect(deferred.stdout).toContain("Homebrew")
    await expect(readFile(join(deferred.binDir, "candle"), "utf8")).rejects.toThrow()
    await rm(deferred.home, { recursive: true, force: true })

    const forced = await runInstaller(["--force"], {}, stubDir)
    expect(forced.code).toBe(0)
    expect(await readFile(join(forced.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
    await rm(forced.home, { recursive: true, force: true })

    await rm(root, { recursive: true, force: true })
  })

  test("an unsupported platform exits 1 naming the four supported targets", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "candle-uname-"))
    await writeFile(
      join(stubDir, "uname"),
      '#!/bin/sh\ncase "$1" in\n  -s) echo "SunOS" ;;\n  *) echo "sun4u" ;;\nesac\n',
    )
    await chmod(join(stubDir, "uname"), 0o755)
    const r = await runInstaller([], {}, stubDir)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("darwin-arm64")
    expect(r.stderr).toContain("darwin-x64")
    expect(r.stderr).toContain("linux-x64")
    expect(r.stderr).toContain("linux-arm64")
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })
})
