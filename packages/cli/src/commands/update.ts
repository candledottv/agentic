/**
 * `candle update`: replace this binary with the latest signed release, or say who else owns the
 * install (Homebrew, npm). Verification is not optional here: a downloaded binary is renamed over
 * the running one only after its SHA-256 matches both SHA256SUMS and latest.json AND its Sigstore
 * bundle verifies in process against the release workflow's identity for that exact version.
 */
import { createHash, randomBytes } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { formatBytes, stepReporter } from "../progress"
import {
  assetUrl,
  compareVersions,
  detectInstall,
  type FetchLatestResult,
  fetchLatest,
  RELEASE_ISSUER,
  type ReleaseManifest,
  releaseBaseUrl,
  releaseIdentityUri,
} from "../release"
import { verifyReleaseAsset } from "../release-verify"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { CLI_VERSION } from "../version"

const INSTALLER_LINE = "curl -fsSL https://candle.tv/install.sh | bash"

export async function update(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  // `--to`, not `--version`: `--version` is a global flag meaning "print this binary's version",
  // and dispatch strips it before a command ever sees it.
  const parsed = parseArgs(args, { valueFlags: ["--to"], booleanFlags: ["--check"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  const check = parsed.booleans.has("--check")
  const pinned = parsed.values["--to"]

  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  const method = detectInstall(deps.execPath, realExec)
  if (method === "homebrew") {
    // Replacing a Cellar binary by hand would leave brew's own metadata describing a version that
    // is no longer there, and the next `brew upgrade` would overwrite it anyway.
    if (json) {
      const payload = { current: CLI_VERSION, latest: null, updated: false, path: realExec, method }
      deps.stdout.write(`${JSON.stringify(payload)}\n`)
    } else {
      deps.stdout.write("Installed by Homebrew. Run: brew upgrade candle\n")
    }
    return 0
  }
  if (method === "script") {
    if (json) {
      const payload = { current: CLI_VERSION, latest: null, updated: false, path: realExec, method }
      deps.stdout.write(`${JSON.stringify(payload)}\n`)
    } else {
      deps.stdout.write("Installed with npm (or a dev checkout). Run: npm i -g @candledottv/cli@latest\n")
    }
    return 0
  }

  const base = releaseBaseUrl(deps.env)
  const fetched = pinned ? await fetchPinned(deps, base, pinned) : await fetchLatest(deps, base)
  if (!fetched.ok) {
    // `UPDATE_UNREACHABLE` means the release host did not answer. A host that answered with
    // something that is not a manifest is a different failure with a different fix.
    const code = fetched.kind === "invalid" ? "MANIFEST_INVALID" : "UPDATE_UNREACHABLE"
    writeLocalFailure(deps, { code, message: fetched.message }, json)
    return 1
  }
  const target = fetched.manifest

  // The identity is resolved HERE, before the version is compared, printed or used as a filename,
  // rather than at verification time. The version comes off a downloaded manifest, which is the
  // one input on this path an attacker controls, and `releaseIdentityUri` THROWS on one that is
  // not three numbers (release.ts explains what `{"version": "x|"}` used to do). Left until
  // verification, that throw would escape as an unhandled rejection -- and a version that parses
  // as 0.0.0 would first be answered with "up to date", which is a tampered manifest silently
  // suppressing an upgrade.
  let identityUri: string
  try {
    identityUri = releaseIdentityUri(target.version)
  } catch (error) {
    writeLocalFailure(
      deps,
      {
        code: "MANIFEST_INVALID",
        message: `Refusing the release manifest at ${base}: ${messageOf(error)}.`,
        suggestion: "Nothing was downloaded or installed.",
      },
      json,
    )
    return 1
  }
  const order = compareVersions(CLI_VERSION, target.version)

  if (check) {
    if (json) {
      const payload = { current: CLI_VERSION, latest: target.version, updated: false, path: realExec }
      deps.stdout.write(`${JSON.stringify(payload)}\n`)
    } else if (order < 0) {
      deps.stdout.write(`candle ${CLI_VERSION}; ${target.version} available. Run: candle update\n`)
    } else {
      deps.stdout.write(`candle ${CLI_VERSION} is up to date (latest ${target.version})\n`)
    }
    return 0
  }
  // A pinned tag is an instruction, so an older one is installed with a warning rather than
  // refused; an unpinned run never walks backwards.
  if (order === 0 || (order > 0 && !pinned)) {
    if (json) {
      const payload = { current: CLI_VERSION, latest: target.version, updated: false, path: realExec }
      deps.stdout.write(`${JSON.stringify(payload)}\n`)
    } else {
      deps.stdout.write(`candle ${CLI_VERSION} is up to date\n`)
    }
    return 0
  }
  if (order > 0 && pinned) deps.stderr.write(`Warning: ${target.version} is a downgrade from ${CLI_VERSION}\n`)

  if (!deps.platformKey) {
    writeLocalFailure(
      deps,
      {
        code: "UPDATE_UNSUPPORTED_PLATFORM",
        message: "No release binary for this platform.",
        suggestion: "Run: npm i -g @candledottv/cli@latest",
      },
      json,
    )
    return 1
  }
  // The name this platform's binary has, DERIVED from the platform rather than read off the
  // manifest. Every asset in a release is signed by the same workflow under the same identity --
  // install.sh and SHA256SUMS included -- so a manifest naming install.sh as the linux-x64 asset
  // would satisfy the checksum check AND the signature check and still leave a shell script
  // renamed over the running binary. The manifest is allowed to agree with this name and to do
  // nothing else.
  const expectedName = `candle-${deps.platformKey}`
  const asset = target.assets[deps.platformKey]
  if (!asset) {
    writeLocalFailure(
      deps,
      {
        code: "UPDATE_UNSUPPORTED_PLATFORM",
        message: `Release ${target.tag} has no asset for ${deps.platformKey}.`,
      },
      json,
    )
    return 1
  }
  if (asset.name !== expectedName) {
    writeLocalFailure(
      deps,
      {
        code: "MANIFEST_INVALID",
        message: `Release ${target.tag} names ${asset.name} as the ${deps.platformKey} asset; this platform installs ${expectedName}.`,
        suggestion: "Nothing was downloaded or installed.",
      },
      json,
    )
    return 1
  }

  // Staged progress from here down: this is where the command used to go silent for the whole
  // multi-megabyte download and both verifications -- long enough to look dead and invite a
  // Ctrl+C mid-install. Silent under --json (progress is human commentary; stdout stays owned
  // by the payload), plain lines when stderr is not a terminal.
  const steps = json
    ? stepReporter(() => {}, false)
    : stepReporter((text) => deps.stderr.write(text), process.stderr.isTTY === true)
  if (!json)
    deps.stderr.write(`Updating candle ${CLI_VERSION} -> ${target.version}
`)

  // Download the binary, SHA256SUMS and the bundle, by `expectedName`: the check above is what
  // makes the manifest's own name safe to have agreed with, and this is the name that is used.
  steps.start(`downloading ${expectedName}`)
  const download = await fetchAll(deps, base, target.tag, expectedName)
  if (!download.ok) {
    steps.fail(`downloading ${expectedName}`)
    writeLocalFailure(deps, { code: "UPDATE_UNREACHABLE", message: download.message }, json)
    return 1
  }
  const { bytes, sums, bundle } = download
  steps.done(`downloaded ${expectedName} (${formatBytes(bytes.length)})`)

  // Beside the REAL file, and later renamed over it, rather than over `execPath`: a bin entry is
  // often a symlink into a versioned directory, and replacing the link would leave the file it
  // pointed at in place and break anything else pointing at it. `realExec` is what every payload
  // reports as `path` for the same reason. The write also has to land on the same filesystem as
  // the rename target for the rename to be atomic, which "beside the real file" guarantees.
  const dir = realExec.slice(0, realExec.lastIndexOf("/")) || "."
  // Random, not derived from the version: a predictable name in a directory someone else can
  // write is a file they can plant, and the rename moves whatever is at that path at that
  // instant, not the bytes that were verified. The real `writeBytes` refuses an existing path
  // (index.ts) so a collision fails the write instead of truncating someone's file.
  const tmpPath = `${dir}/.candle-update-${target.version}-${randomBytes(6).toString("hex")}`
  try {
    await deps.writeBytes(tmpPath, bytes)
  } catch (error) {
    writeLocalFailure(deps, notWritable(dir, error), json)
    return 1
  }

  // From here the temp file exists, and every exit path below removes it except the rename that
  // succeeds. Cleanup is best effort: it is a file being abandoned either way, and a failure to
  // remove it must not replace the failure actually being reported.

  steps.start("verifying checksum")
  const actual = createHash("sha256").update(bytes).digest("hex")
  const fromSums = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === expectedName)?.[0]
  if (actual !== asset.sha256 || actual !== fromSums) {
    steps.fail("verifying checksum")
    await discard(deps, tmpPath)
    writeLocalFailure(
      deps,
      {
        code: "UPDATE_VERIFY_FAILED",
        message: `checksum mismatch for ${expectedName} (manifest ${asset.sha256}, SHA256SUMS ${fromSums ?? "missing"}, downloaded ${actual}); nothing installed.`,
      },
      json,
    )
    return 1
  }
  // `deps.verify` is the injected seam (deps.ts); the real deps leave it undefined and this is
  // the in-process verifier from Task 6, running against the trusted root compiled into this
  // binary -- no cosign, no gh, no network.
  steps.done("checksum verified")
  steps.start("verifying signature")
  const verify = deps.verify ?? verifyReleaseAsset
  const verdict = verify(bytes, bundle, identityUri, RELEASE_ISSUER)
  if (!verdict.ok) {
    steps.fail("verifying signature")
    await discard(deps, tmpPath)
    writeLocalFailure(
      deps,
      {
        code: "UPDATE_VERIFY_FAILED",
        message: `signature verification failed for ${expectedName}: ${verdict.reason}; nothing installed.`,
        suggestion: `Checked against ${identityUri}.`,
      },
      json,
    )
    return 1
  }

  steps.done("signature verified")
  steps.start("installing")
  try {
    await deps.rename(tmpPath, realExec)
  } catch (error) {
    steps.fail("installing")
    // A rename that fails is the same problem as a write that fails, reported the same way: the
    // directory is not ours to replace a file in. Letting it throw would exit through
    // `Unexpected error` with nothing on stdout and no envelope for a `--json` caller.
    await discard(deps, tmpPath)
    writeLocalFailure(deps, notWritable(dir, error), json)
    return 1
  }
  steps.done(`installed to ${realExec}`)
  if (json) {
    const payload = { current: CLI_VERSION, latest: target.version, updated: true, path: realExec }
    deps.stdout.write(`${JSON.stringify(payload)}\n`)
  } else {
    deps.stdout.write(`Updated candle ${CLI_VERSION} -> ${target.version}\n`)
  }
  return 0
}

/** The one failure `update` reports for a directory it cannot replace a file in, whether that
 * shows up on the write or on the rename. */
function notWritable(dir: string, error: unknown): { code: string; message: string; suggestion: string } {
  return {
    code: "UPDATE_NOT_WRITABLE",
    message: `Cannot write ${dir}: ${messageOf(error)}.`,
    suggestion: `Rerun the installer with --bin-dir <writable dir>: ${INSTALLER_LINE}`,
  }
}

/** Removes the abandoned temp file, swallowing whatever the removal says: the caller is already
 * reporting the failure that matters, and this must not become the error the operator sees. */
async function discard(deps: Deps, path: string): Promise<void> {
  try {
    await deps.unlink(path)
  } catch {
    // Best effort by design; see above.
  }
}

/** A pinned tag's manifest lives beside its assets, so `--to cli-v1.2.3` reads that release's own
 * latest.json rather than the newest one. Same three-field shape check `fetchLatest` makes, and
 * for the same reason: a manifest missing `tag` builds asset URLs with "undefined" in them, and
 * one missing `assets` is a TypeError at the platform lookup. */
async function fetchPinned(deps: Deps, base: string, tag: string): Promise<FetchLatestResult> {
  const url = assetUrl(base, tag, "latest.json")
  try {
    const res = await deps.fetch(url, { redirect: "follow" })
    if (!res.ok) return { ok: false, kind: "unreachable", message: `${url} answered ${res.status}` }
    const manifest = (await res.json()) as Partial<ReleaseManifest>
    const missing = [
      typeof manifest.version === "string" ? null : "version",
      typeof manifest.tag === "string" ? null : "tag",
      typeof manifest.assets === "object" && manifest.assets !== null ? null : "assets",
    ].filter((field): field is string => field !== null)
    if (missing.length > 0) {
      return { ok: false, kind: "invalid", message: `The release manifest at ${url} has no ${missing.join(", ")}` }
    }
    return { ok: true, manifest: manifest as ReleaseManifest }
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `Could not reach ${url}: ${messageOf(error)}` }
  }
}

type Download = { ok: true; bytes: Uint8Array; sums: string; bundle: unknown } | { ok: false; message: string }

/** The three files one release asset needs: the binary, the checksum list it appears in, and its
 * Sigstore bundle. Fetched together because a missing one of them is the same failure. */
async function fetchAll(deps: Deps, base: string, tag: string, name: string): Promise<Download> {
  try {
    const [bin, sums, bundle] = await Promise.all([
      deps.fetch(assetUrl(base, tag, name), { redirect: "follow" }),
      deps.fetch(assetUrl(base, tag, "SHA256SUMS"), { redirect: "follow" }),
      deps.fetch(assetUrl(base, tag, `${name}.sigstore.json`), { redirect: "follow" }),
    ])
    for (const [label, res] of [
      [name, bin],
      ["SHA256SUMS", sums],
      [`${name}.sigstore.json`, bundle],
    ] as const) {
      if (!res.ok) return { ok: false, message: `${label} answered ${res.status} at ${assetUrl(base, tag, label)}` }
    }
    return {
      ok: true,
      bytes: new Uint8Array(await bin.arrayBuffer()),
      sums: await sums.text(),
      bundle: (await bundle.json()) as unknown,
    }
  } catch (error) {
    return { ok: false, message: `Could not download ${tag}: ${messageOf(error)}` }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
