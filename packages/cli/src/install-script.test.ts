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
const HELPER = `candle-fido2-${os}-${arch}`
const FAKE_BINARY = '#!/bin/sh\necho "candle 9.9.9"\n'
const FAKE_HELPER = '#!/bin/sh\necho "candle-fido2 9.9.9 (protocol 1)"\n'
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

let server: ReturnType<typeof Bun.serve>
let base: string
let fixtures: Record<string, string | Uint8Array>
let fixtureTools: string
// Every request path the fixture server has seen, in order. Tests that care reset it first
// (requestPaths = []) so a later assertion is about their own run, not an earlier test's.
let requestPaths: string[] = []

beforeAll(async () => {
  // Keep host credentials and installed verifiers out of local release fixtures. Tests that
  // verify signatures explicitly supply a stub cosign or gh ahead of this tool-only PATH.
  fixtureTools = await mkdtemp(join(tmpdir(), "candle-install-tools-"))
  for (const name of [
    "awk",
    "basename",
    "bash",
    "cat",
    "chmod",
    "cp",
    "curl",
    "dirname",
    "grep",
    "head",
    "mkdir",
    "mktemp",
    "mv",
    "readlink",
    "rm",
    "sed",
    "sha256sum",
    "shasum",
    "tr",
    "uname",
  ]) {
    const executable = Bun.which(name)
    if (executable) await symlink(executable, join(fixtureTools, name))
  }
  // D3 (BE-274): python is the one of these that is routinely a pyenv SHIM -- a shell script whose
  // own resolution needs `pyenv` on the PATH, which the tool-only PATH above deliberately is not.
  // Symlinking `Bun.which("python3")` therefore produced a `python3` that could not run: the
  // `ditto` stub exited 1 three describes later, with no hint of why. So ask python where its
  // interpreter actually is and symlink THAT, which runs with no PATH at all.
  const interpreter = Bun.spawnSync(["python3", "-c", "import sys; print(sys.executable)"])
  if (interpreter.exitCode !== 0) {
    throw new Error(`python3 -c is required by the ditto stub and did not run: ${interpreter.stderr.toString()}`)
  }
  const pythonPath = interpreter.stdout.toString().trim()
  if (pythonPath === "") throw new Error("python3 answered with no sys.executable")
  await symlink(pythonPath, join(fixtureTools, "python3"))
  // One smoke check, before any test uses it: a named failure at setup beats `ditto` exiting 1
  // three describes later.
  const smoke = Bun.spawnSync([join(fixtureTools, "python3"), "-c", "print(1)"], { env: { PATH: fixtureTools } })
  if (smoke.exitCode !== 0) {
    throw new Error(`the resolved python3 does not run on the stub PATH: ${smoke.stderr.toString()}`)
  }
  fixtures = {
    [ASSET]: FAKE_BINARY,
    [HELPER]: FAKE_HELPER,
    SHA256SUMS: `${sha256(FAKE_BINARY)}  ${ASSET}\n${sha256(FAKE_HELPER)}  ${HELPER}\n`,
    // Pretty-printed, matching the real release workflow (JSON.stringify(manifest, null, 2)): the
    // asset's "name" and "sha256" land on different lines, which is the shape that broke a
    // line-oriented sed extraction of the manifest checksum (see install.sh's step 5 comment).
    "latest.json": JSON.stringify(
      {
        version: "9.9.9",
        tag: "cli-v9.9.9",
        assets: { [`${os}-${arch}`]: { name: ASSET, sha256: sha256(FAKE_BINARY), size: FAKE_BINARY.length } },
        // The security key helper (Ember Phase 2 PR E) sits beside the assets in its own map.
        helpers: { [`${os}-${arch}`]: { name: HELPER, sha256: sha256(FAKE_HELPER), size: FAKE_HELPER.length } },
      },
      null,
      2,
    ),
    [`${ASSET}.sigstore.json`]: "{}",
    [`${HELPER}.sigstore.json`]: "{}",
  }
  server = Bun.serve({
    port: 0,
    fetch(req) {
      // Both URL shapes the script uses: releases/latest/download/<name> and releases/download/<tag>/<name>.
      const pathname = new URL(req.url).pathname
      requestPaths.push(pathname)
      const name = pathname.split("/").pop() ?? ""
      const body = fixtures[name]
      // A zip fixture is bytes; the rest are text. Either is a valid body, whatever the lib typings say.
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body as BodyInit)
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  server.stop()
  await rm(fixtureTools, { recursive: true, force: true })
})

async function runInstaller(
  args: string[],
  env: Record<string, string> = {},
  stubDir?: string,
  beforeRun?: (home: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "candle-install-"))
  if (beforeRun) await beforeRun(home)
  const binDir = join(home, ".local", "bin")
  const path = stubDir ? `${stubDir}:${fixtureTools}` : fixtureTools
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

/**
 * T3 (BE-274, D3): the fixture's `python3` runs on the tool-only PATH the `ditto` stub gives it.
 *
 * The stub extracts the macOS helper's zip with `python3 -c "import zipfile..."` and `PATH` set to
 * the tool directory alone. A pyenv `python3` is a SHIM -- a shell script that re-resolves through
 * `pyenv`, which is not on that PATH -- so symlinking whatever is first on the developer's PATH
 * produced a `python3` that could not run, and the failure surfaced as `ditto` exiting 1 inside an
 * unrelated assertion. `beforeAll` resolves `sys.executable` instead; this pins that it worked.
 */
describe("T3: the stub PATH's python3", () => {
  test("is an interpreter that runs with the tool directory as its whole PATH", () => {
    const ran = Bun.spawnSync([join(fixtureTools, "python3"), "-c", "print('ok')"], { env: { PATH: fixtureTools } })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    expect(ran.stdout.toString().trim()).toBe("ok")
  })
})

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
        PATH: fixtureTools,
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

  test("the security key helper is installed beside the binary, fetched and checked like it", async () => {
    requestPaths = []
    const r = await runInstaller([])
    expect(r.code).toBe(0)
    expect(await readFile(join(r.binDir, "candle-fido2"), "utf8")).toBe(FAKE_HELPER)
    expect(r.stdout).toContain("Installed candle-fido2")
    expect(r.stdout).toContain("libfido2")
    // Both the helper and its bundle were fetched, and the unsigned warning names each asset.
    expect(requestPaths).toContain(`/releases/latest/download/${HELPER}`)
    expect(requestPaths).toContain(`/releases/latest/download/${HELPER}.sigstore.json`)
    expect(r.stdout).toContain(`signature not verified for ${HELPER}`)
    await rm(r.home, { recursive: true, force: true })
  })

  test("a release before the helper existed installs the binary alone and says so", async () => {
    const manifestBody = fixtures["latest.json"] as string
    const manifest = JSON.parse(manifestBody)
    delete manifest.helpers
    fixtures["latest.json"] = JSON.stringify(manifest)
    requestPaths = []
    const helperBody = fixtures[HELPER]
    const bundle = fixtures[`${HELPER}.sigstore.json`]
    delete fixtures[HELPER]
    delete fixtures[`${HELPER}.sigstore.json`]
    try {
      const r = await runInstaller([])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain(`has no ${HELPER} asset`)
      expect(requestPaths.some((path) => path.endsWith(HELPER))).toBe(false)
      expect(r.stdout).toContain("CLI 0.11.0 or newer")
      await expect(readFile(join(r.binDir, "candle-fido2"), "utf8")).rejects.toThrow()
      expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
      await rm(r.home, { recursive: true, force: true })
    } finally {
      fixtures["latest.json"] = manifestBody
      fixtures[HELPER] = helperBody as string
      fixtures[`${HELPER}.sigstore.json`] = bundle as string
    }
  })

  test("a declared security key helper whose download fails installs nothing", async () => {
    const original = fixtures[HELPER]
    delete fixtures[HELPER]
    try {
      const r = await runInstaller([])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`declares the security key helper ${HELPER} but it could not be downloaded`)
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await expect(readFile(join(r.binDir, "candle-fido2"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    } finally {
      fixtures[HELPER] = original as string
    }
  })

  test("a declared security key helper with a rejected signature leaves an existing install unchanged", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "candle-helper-verifier-"))
    await writeFile(join(stubDir, "cosign"), `#!/bin/sh\ncase "$*" in *candle-fido2*) exit 1;; *) exit 0;; esac\n`)
    await chmod(join(stubDir, "cosign"), 0o755)
    const r = await runInstaller([], {}, stubDir, async (home) => {
      await mkdir(join(home, ".local", "bin"), { recursive: true })
      await writeFile(join(home, ".local", "bin", "candle"), "old CLI")
      await writeFile(join(home, ".local", "bin", "candle-fido2"), "old helper")
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`signature verification failed for ${HELPER}`)
    expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe("old CLI")
    expect(await readFile(join(r.binDir, "candle-fido2"), "utf8")).toBe("old helper")
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })

  test("a helper whose checksum does not match installs nothing, binary included", async () => {
    const original = fixtures[HELPER]
    fixtures[HELPER] = '#!/bin/sh\necho "tampered"\n'
    try {
      const r = await runInstaller([])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`checksum mismatch for ${HELPER}`)
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await expect(readFile(join(r.binDir, "candle-fido2"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    } finally {
      fixtures[HELPER] = original as string
    }
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
    // The helper is verified by the same verifier, against the same pinned identity.
    expect(calls.split("\n").filter((line) => line.includes("verify-blob"))).toHaveLength(2)
    expect(calls).toContain(`/${HELPER}`)
    // Without --new-bundle-format cosign also accepts its own LEGACY bundle shape
    // ({"base64Signature","cert","rekorBundle"}), which candle's in-process verifier refuses.
    // That gap is what let 0.6.0 ship assets this installer took and `candle verify` would not.
    expect(calls).toContain("--new-bundle-format")
    expect(calls).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com")
    // Pinned to the RESOLVED version, exactly, not merely prefixed with `cli-v`. A bare prefix
    // accepts a signature minted for any cli-v tag, which is a signed downgrade: ask for 9.9.9,
    // be handed a legitimately signed 0.3.0, and verification passes. Exact, not a regexp: the
    // SAN is one string naming the workflow file and the tag, and an escaping step between the
    // version and a pattern is one more place to be silently wrong (BE-275 D2).
    expect(calls).toContain(
      "--certificate-identity https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v9.9.9",
    )
    expect(calls).not.toContain("--certificate-identity-regexp")
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
    const NO_VERIFIER_PATH = fixtureTools
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

  test("the gh fallback pins the exact certificate identity, not just the repo", async () => {
    // `--repo` alone accepts any attestation from candledottv/agentic, and this repo runs more
    // than one workflow with `id-token: write` reachable from it. The exact identity is the
    // certificate's SAN, which names the workflow FILE and the TAG in one string, so this branch
    // checks what the cosign path checks. It is the ONLY identity flag passed: gh keeps
    // --cert-identity, --cert-identity-regex, --signer-repo and --signer-workflow in one mutually
    // exclusive group, and passing two of them was the bug that broke every gh-only install
    // (BE-275 §1.1). This stub accepts anything, so the flag-compatibility check itself is the
    // real-gh replay further down; this test only pins WHAT the script asks for.
    const stubDir = await mkdtemp(join(tmpdir(), "candle-stub-gh-"))
    const log = join(stubDir, "gh.log")
    await writeFile(join(stubDir, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`)
    await chmod(join(stubDir, "gh"), 0o755)
    // No cosign anywhere on this PATH (a real one in /usr/local/bin would take the other branch),
    // and no escape hatch: this install only succeeds if the stub gh actually verified it.
    const r = await runInstaller([], { CANDLE_INSTALL_ALLOW_UNSIGNED: "", PATH: `${stubDir}:${fixtureTools}` }, stubDir)
    expect(r.code).toBe(0)
    const calls = await readFile(log, "utf8")
    expect(calls).toContain("attestation verify")
    expect(calls).toContain("--repo candledottv/agentic")
    // The tag, so this branch is not weaker than the cosign one above.
    expect(calls).toContain(
      "--cert-identity https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v9.9.9",
    )
    expect(calls).not.toContain("--signer-workflow")
    expect(calls).not.toContain("--signer-repo")
    expect(calls).not.toContain("--cert-identity-regex")
    // The helper goes through the same branch with the same pin.
    expect(calls.split("\n").filter((line) => line.includes("attestation verify"))).toHaveLength(2)
    expect(calls).toContain(`/${HELPER}`)
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
  })

  test("a manifest whose version disagrees with the requested tag installs nothing", async () => {
    // The fixture serves the same latest.json (version 9.9.9) under every tag, so asking for a
    // different tag is exactly the mismatch: the assets you were handed do not describe the
    // version you asked for, and reconciling that quietly is how a downgrade slips through.
    const r = await runInstaller(["--version", "cli-v1.2.3"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("cli-v9.9.9")
    await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
    await rm(r.home, { recursive: true, force: true })
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

/**
 * The signed Secure Enclave helper (Ember Phase 2 PR F). Whether a release carries it is the
 * manifest's word: `macosHelper` absent is a valid omission; present, the installer must deliver
 * exactly that archive or install nothing. These run on any host by stubbing `uname` (Darwin,
 * arm64) and `ditto` (python3's zipfile, which is what a Mac and an Ubuntu runner both have) on
 * the harness's stub PATH; the archive is a real zip built the same way. The macOS version floor
 * is tested here too, since this is where a Darwin release is served.
 */
describe("install.sh on macOS: the Secure Enclave helper and the version floor", () => {
  const DARWIN_ASSET = "candle-darwin-arm64"
  const DARWIN_HELPER = "candle-fido2-darwin-arm64"
  const ENCLAVE_ZIP = "candle-enclave-9.9.9.app.zip"
  const FAKE_ENCLAVE = '#!/bin/sh\necho "candle-enclave 9.9.9 (protocol 1)"\n'
  let zipBytes: Uint8Array
  let zipSha: string
  let darwinStub: string

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-enclave-zip-"))
    const zipPath = join(dir, ENCLAVE_ZIP)
    const build = Bun.spawnSync([
      "python3",
      "-c",
      [
        "import sys, zipfile",
        "z = zipfile.ZipFile(sys.argv[1], 'w')",
        "z.writestr('candle-enclave.app/Contents/Info.plist', '<plist/>')",
        "z.writestr('candle-enclave.app/Contents/MacOS/candle-enclave', sys.argv[2])",
        "z.close()",
      ].join("\n"),
      zipPath,
      FAKE_ENCLAVE,
    ])
    if (build.exitCode !== 0) throw new Error(`could not build the zip fixture: ${build.stderr.toString()}`)
    zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer())
    zipSha = createHash("sha256").update(zipBytes).digest("hex")

    darwinStub = await mkdtemp(join(tmpdir(), "candle-darwin-stub-"))
    await writeFile(
      join(darwinStub, "uname"),
      '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\n  *) exec /usr/bin/uname "$@" ;;\nesac\n',
    )
    await chmod(join(darwinStub, "uname"), 0o755)
    // ditto -x -k <zip> <dir>: extract, then restore the executable bit zipfile does not keep.
    await writeFile(
      join(darwinStub, "ditto"),
      '#!/bin/sh\n[ "$1" = "-x" ] && [ "$2" = "-k" ] || exit 2\npython3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$3" "$4" || exit 1\nchmod -R u+x "$4"/*/Contents/MacOS 2>/dev/null\nexit 0\n',
    )
    await chmod(join(darwinStub, "ditto"), 0o755)
  })

  /** Serves a darwin-arm64 release; `declared` writes macosHelper into the manifest, `served` publishes the archive. */
  async function withDarwinRelease(
    opts: { declared: boolean; served: boolean; zipBody?: Uint8Array | string },
    run: () => Promise<void>,
  ) {
    const saved = { ...fixtures }
    fixtures[DARWIN_ASSET] = FAKE_BINARY
    fixtures[DARWIN_HELPER] = FAKE_HELPER
    fixtures[`${DARWIN_ASSET}.sigstore.json`] = "{}"
    fixtures[`${DARWIN_HELPER}.sigstore.json`] = "{}"
    fixtures[`${ENCLAVE_ZIP}.sigstore.json`] = "{}"
    if (opts.served) fixtures[ENCLAVE_ZIP] = opts.zipBody ?? zipBytes
    else delete fixtures[ENCLAVE_ZIP]
    // Deduplicated: on an arm64 Mac the host's ASSET and HELPER ARE the Darwin ones, and a name
    // listed twice makes the installer's lookup return two checksums and refuse its own file.
    fixtures.SHA256SUMS = [
      ...new Set([
        `${sha256(FAKE_BINARY)}  ${DARWIN_ASSET}`,
        `${sha256(FAKE_HELPER)}  ${DARWIN_HELPER}`,
        `${zipSha}  ${ENCLAVE_ZIP}`,
        `${sha256(FAKE_BINARY)}  ${ASSET}`,
        `${sha256(FAKE_HELPER)}  ${HELPER}`,
      ]),
    ].join("\n")
    fixtures["latest.json"] = JSON.stringify(
      {
        version: "9.9.9",
        tag: "cli-v9.9.9",
        assets: { "darwin-arm64": { name: DARWIN_ASSET, sha256: sha256(FAKE_BINARY), size: FAKE_BINARY.length } },
        helpers: { "darwin-arm64": { name: DARWIN_HELPER, sha256: sha256(FAKE_HELPER), size: FAKE_HELPER.length } },
        ...(opts.declared ? { macosHelper: { name: ENCLAVE_ZIP, sha256: zipSha, size: zipBytes.length } } : {}),
      },
      null,
      2,
    )
    try {
      await run()
    } finally {
      for (const key of Object.keys(fixtures)) delete fixtures[key]
      Object.assign(fixtures, saved)
    }
  }

  test("a manifest that declares the helper: it is fetched, verified and installed as a bundle beside candle", async () => {
    await withDarwinRelease({ declared: true, served: true }, async () => {
      requestPaths = []
      const r = await runInstaller([], {}, darwinStub)
      expect(r.stderr).toBe("")
      expect(r.code).toBe(0)
      expect(requestPaths).toContain(`/releases/latest/download/${ENCLAVE_ZIP}`)
      expect(requestPaths).toContain(`/releases/latest/download/${ENCLAVE_ZIP}.sigstore.json`)
      expect(await readFile(join(r.binDir, "candle-enclave.app", "Contents", "MacOS", "candle-enclave"), "utf8")).toBe(
        FAKE_ENCLAVE,
      )
      expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
      expect(r.stdout).toContain("Installed the signed Secure Enclave helper")
      expect(r.stdout).toContain("candle vault factor add touch-id")
      await rm(r.home, { recursive: true, force: true })
    })
  })

  test("a declared helper whose download fails stops the install with nothing installed", async () => {
    await withDarwinRelease({ declared: true, served: false }, async () => {
      const r = await runInstaller([], {}, darwinStub)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`declares the Secure Enclave helper ${ENCLAVE_ZIP} but it could not be downloaded`)
      expect(r.stderr).toContain("nothing installed")
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await expect(readFile(join(r.binDir, "candle-fido2"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    })
  })

  test("a declared helper whose checksum does not match installs nothing, binary included", async () => {
    await withDarwinRelease({ declared: true, served: true, zipBody: "not the archive" }, async () => {
      const r = await runInstaller([], {}, darwinStub)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`checksum mismatch for ${ENCLAVE_ZIP}`)
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    })
  })

  test("a manifest without the helper is a valid omission: the binary installs, the archive is never requested, and the note says so", async () => {
    await withDarwinRelease({ declared: false, served: true }, async () => {
      requestPaths = []
      const r = await runInstaller([], {}, darwinStub)
      expect(r.stderr).toBe("")
      expect(r.code).toBe(0)
      expect(requestPaths.some((path) => path.includes("candle-enclave"))).toBe(false)
      expect(r.stdout).toContain("ships no signed Secure Enclave helper (its manifest declares none)")
      expect(r.stdout).toContain("arrives in a later release")
      await expect(
        readFile(join(r.binDir, "candle-enclave.app", "Contents", "MacOS", "candle-enclave")),
      ).rejects.toThrow()
      expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
      await rm(r.home, { recursive: true, force: true })
    })
  })

  test("a manifest declaring a helper under another name is refused before any download", async () => {
    const original = fixtures["latest.json"]
    await withDarwinRelease({ declared: true, served: true }, async () => {
      fixtures["latest.json"] = (fixtures["latest.json"] as string).replace(ENCLAVE_ZIP, "candle-enclave-9.9.8.app.zip")
      requestPaths = []
      const r = await runInstaller([], {}, darwinStub)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("declares a Secure Enclave helper named candle-enclave-9.9.8.app.zip")
      expect(requestPaths.some((path) => path.includes("candle-enclave"))).toBe(false)
      await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
      await rm(r.home, { recursive: true, force: true })
    })
    fixtures["latest.json"] = original as string
  })

  /** Runs `run` with a stub `sw_vers` reporting `version` on the PATH ahead of the Darwin stubs.
   * runInstaller puts its stubDir argument on PATH verbatim, so two colon-joined dirs work. */
  async function withMacosVersion(version: string, run: (stubPath: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "candle-sw-vers-"))
    await writeFile(join(dir, "sw_vers"), `#!/bin/sh\n[ "$1" = "-productVersion" ] && echo ${version}\n`)
    await chmod(join(dir, "sw_vers"), 0o755)
    try {
      await run(`${dir}:${darwinStub}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("macOS 12 is refused before any download, naming the floor and the npm package", async () => {
    // The release is served, so without the floor this install would succeed: the refusal is the check's.
    await withDarwinRelease({ declared: false, served: true }, async () => {
      await withMacosVersion("12.7.6", async (stubPath) => {
        requestPaths = []
        const r = await runInstaller([], {}, stubPath)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain("macOS 12.7.6 is too old")
        expect(r.stderr).toContain("macOS 13 (Ventura) or later")
        expect(r.stderr).toContain("npm i -g @candledottv/cli")
        expect(requestPaths).toEqual([])
        await expect(readFile(join(r.binDir, "candle"), "utf8")).rejects.toThrow()
        await rm(r.home, { recursive: true, force: true })
      })
    })
  })

  test("macOS 13 and later install, two-digit majors included", async () => {
    await withDarwinRelease({ declared: false, served: true }, async () => {
      for (const version of ["13.0", "26.0.1"]) {
        await withMacosVersion(version, async (stubPath) => {
          const r = await runInstaller([], {}, stubPath)
          expect(r.stderr).toBe("")
          expect(r.code).toBe(0)
          expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
          await rm(r.home, { recursive: true, force: true })
        })
      }
    })
  })

  // It runs the host's own platform, so only a Linux host is testing Linux here.
  test.skipIf(os !== "linux")("on Linux a declared helper is not this platform's and is never requested", async () => {
    const saved = fixtures["latest.json"]
    const manifest = JSON.parse(saved as string) as Record<string, unknown>
    fixtures["latest.json"] = JSON.stringify(
      { ...manifest, macosHelper: { name: ENCLAVE_ZIP, sha256: zipSha, size: zipBytes.length } },
      null,
      2,
    )
    try {
      requestPaths = []
      const r = await runInstaller([])
      expect(r.code).toBe(0)
      expect(requestPaths.some((path) => path.includes("candle-enclave"))).toBe(false)
      expect(await readFile(join(r.binDir, "candle"), "utf8")).toBe(FAKE_BINARY)
      await rm(r.home, { recursive: true, force: true })
    } finally {
      fixtures["latest.json"] = saved as string
    }
  })
})

/**
 * BE-275 D3 and D4 (spec `2026-09-22-cli-install-and-update-integrity-design.md`), tests 1-3.
 *
 * The stub-verifier tests above record what install.sh asks a verifier for and accept anything.
 * That is the right shape for "is the pin present", and it is structurally blind to the bug that
 * broke the public one-liner: install.sh passed `--signer-workflow` together with
 * `--cert-identity`, gh refuses that pair on argument validation before it reads a byte, and a
 * stub that exits 0 cannot see a refusal. No mock of gh can. So these tests capture the
 * installer's own verbatim argv from the stub run and replay it against whatever real `gh` is on
 * PATH, unpinned: GitHub runners preinstall one, its version floats, and the point is to notice
 * the day gh changes its mind about this flag group again, in CI and in the mirrored release job,
 * before a user does.
 *
 * Offline, no auth, no real release. The captured artifact path is gone by the time the installer
 * exits (its trap removes the temp dir), so the operand is swapped for a dummy file and a dummy
 * `--bundle` is appended: cobra validates the flag group in PreRun, and a bundle on disk keeps gh
 * from stopping at its auth check first, so the run reaches validation and then fails on the
 * bundle's bytes. That downstream failure is expected and is the proof that validation passed.
 */
describe("install.sh against the real gh", () => {
  const REAL_GH = Bun.which("gh")
  const SIGNER_WORKFLOW = "candledottv/agentic/.github/workflows/release.yaml"
  /** What gh prints when a flag fails validation: the flag-group refusal, an unknown flag, or a usage dump. */
  const VALIDATION_FAILURE = /none of the others can be|unknown flag|^Usage:/m

  /**
   * Runs the installer with a recording stub for `tool` (and nothing else verifying), and returns
   * every argv the stub saw for its verify subcommand, one array per invocation, verbatim. The
   * stub logs one invocation per line with a tab between arguments; no path or flag here contains
   * either.
   */
  async function captureVerifierArgv(tool: "gh" | "cosign"): Promise<string[][]> {
    const stubDir = await mkdtemp(join(tmpdir(), `candle-capture-${tool}-`))
    const log = join(stubDir, `${tool}.log`)
    await writeFile(
      join(stubDir, tool),
      `#!/bin/sh\nprintf '%s\\t' "$@" >> "${log}"\nprintf '\\n' >> "${log}"\nexit 0\n`,
    )
    await chmod(join(stubDir, tool), 0o755)
    const r = await runInstaller([], { CANDLE_INSTALL_ALLOW_UNSIGNED: "", PATH: `${stubDir}:${fixtureTools}` }, stubDir)
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const verb = tool === "gh" ? "attestation" : "verify-blob"
    const invocations = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t").filter((arg, i, all) => i < all.length - 1 || arg.length > 0))
      .filter((argv) => argv[0] === verb)
    await rm(r.home, { recursive: true, force: true })
    await rm(stubDir, { recursive: true, force: true })
    return invocations
  }

  /** The asset the invocation verifies: its one positional operand, by basename. */
  function assetOf(argv: string[]): string {
    const operand = argv.find((arg) => arg.endsWith(`/${ASSET}`) || arg.endsWith(`/${HELPER}`))
    expect(operand).toBeDefined()
    return (operand as string).split("/").pop() as string
  }

  /** The value install.sh passed for `flag`. */
  function flagValue(argv: string[], flag: string): string {
    const i = argv.indexOf(flag)
    expect(i).toBeGreaterThan(-1)
    return argv[i + 1] as string
  }

  /**
   * Replays a captured gh argv against the real gh, offline and logged out. Only the operand
   * changes (to a dummy artifact) and `--bundle <dummy>` is appended; every flag is verbatim.
   */
  async function replayAgainstRealGh(argv: string[]) {
    const home = await mkdtemp(join(tmpdir(), "candle-real-gh-"))
    const artifact = join(home, assetOf(argv))
    const bundle = join(home, "dummy.sigstore.json")
    await writeFile(artifact, "not a release asset\n")
    await writeFile(bundle, "{}\n")
    await mkdir(join(home, "gh-config"), { recursive: true })
    const replayed = argv.map((arg) => (arg.endsWith(`/${assetOf(argv)}`) ? artifact : arg))
    const proc = Bun.spawn([REAL_GH as string, ...replayed, "--bundle", bundle], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        GH_CONFIG_DIR: join(home, "gh-config"),
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    await rm(home, { recursive: true, force: true })
    return { code, stdout, stderr }
  }

  async function ghVersion(): Promise<string> {
    const proc = Bun.spawn([REAL_GH as string, "--version"], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.split("\n")[0] ?? "gh (version unknown)"
  }

  test.skipIf(!REAL_GH)(
    "the argv install.sh passes to gh survives the real gh's argument validation, for the binary and the helper",
    async () => {
      const invocations = await captureVerifierArgv("gh")
      expect(invocations.map(assetOf).sort()).toEqual([ASSET, HELPER].sort())
      const version = await ghVersion()
      for (const argv of invocations) {
        const r = await replayAgainstRealGh(argv)
        // gh is expected to fail here, on the dummy bundle or on being logged out: that is
        // downstream of validation and is what proves the flags parsed. What it must NOT do is
        // refuse the flags. The failure message leads with the gh version so a red run on an
        // unrelated PR names which gh changed its flag group, in its first line.
        const refused = VALIDATION_FAILURE.test(r.stderr) || VALIDATION_FAILURE.test(r.stdout)
        const report = refused
          ? `${version} refused install.sh's own gh argv for ${assetOf(argv)}:\n  gh ${argv.join(" ")}\n${r.stderr}${r.stdout}`
          : ""
        expect(report).toBe("")
      }
    },
  )

  test.skipIf(!REAL_GH)("control: the flag pair install.sh used to pass is refused by the same gh", async () => {
    // Today's shipped command until BE-279, reconstructed from the live argv plus the flag it
    // carried: --signer-workflow beside --cert-identity. If a future gh stops emitting this
    // refusal, the test above could not fail any more, and this one says so.
    const [argv] = await captureVerifierArgv("gh")
    expect(argv).toBeDefined()
    const repoAt = (argv as string[]).indexOf("--repo")
    expect(repoAt).toBeGreaterThan(-1)
    const withPair = [...(argv as string[])]
    withPair.splice(repoAt + 2, 0, "--signer-workflow", SIGNER_WORKFLOW)
    expect(withPair).toContain("--cert-identity")
    const r = await replayAgainstRealGh(withPair)
    expect(r.code).not.toBe(0)
    // Named on failure: a gh that no longer refuses the pair, or a `gh` on PATH that is not the
    // GitHub CLI (a policy wrapper that never reaches the real binary looks exactly like this).
    const report = (r.stderr + r.stdout).includes("none of the others can be")
      ? ""
      : `${await ghVersion()} did not refuse the incompatible pair:\n  gh ${withPair.join(" ")}\n${r.stderr}${r.stdout}`
    expect(report).toBe("")
  })

  test("the cosign branch and the gh branch pin the same identity, for the binary and the helper", async () => {
    // D3: the two branches are compared to each other, never to a literal. One variable feeds
    // both in install.sh today; this is what fails if a future edit gives one branch its own
    // spelling of the pin again. No real verifier is needed, only what each branch is asked.
    const cosign = await captureVerifierArgv("cosign")
    const gh = await captureVerifierArgv("gh")
    expect(cosign.map(assetOf).sort()).toEqual([ASSET, HELPER].sort())
    expect(gh.map(assetOf).sort()).toEqual([ASSET, HELPER].sort())
    for (const asset of [ASSET, HELPER]) {
      const cosignArgv = cosign.find((argv) => assetOf(argv) === asset) as string[]
      const ghArgv = gh.find((argv) => assetOf(argv) === asset) as string[]
      const cosignIdentity = flagValue(cosignArgv, "--certificate-identity")
      const ghIdentity = flagValue(ghArgv, "--cert-identity")
      expect(ghIdentity).toBe(cosignIdentity)
      // And it is the resolved release's identity, not a prefix: the fixture manifest says 9.9.9.
      expect(cosignIdentity.endsWith("@refs/tags/cli-v9.9.9")).toBe(true)
      expect(cosignIdentity.startsWith("https://github.com/candledottv/agentic/.github/workflows/release.yaml@")).toBe(
        true,
      )
    }
  })
})
