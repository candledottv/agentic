/**
 * `candle update`: replace this binary with the latest signed release, or say who else owns the
 * install (Homebrew, npm). Verification is not optional here: a downloaded binary is renamed over
 * the running one only after its SHA-256 matches both SHA256SUMS and latest.json AND its Sigstore
 * bundle verifies in process against the release workflow's identity for that exact version.
 *
 * An install is two files, not one (BE-275 D5): the release's security key helper, `candle-fido2`,
 * goes through the same download and the same two checks, and NOTHING is renamed until both assets
 * verify. A helper that fails anything discards both temp files and installs nothing, which is
 * exactly what install.sh does. The helper is fetched whenever the manifest declares one for this
 * platform, whether or not one is already beside the binary: there is no "is it missing" branch
 * and no remembered state, so a machine that only ever ran `candle update` (and so never had the
 * helper) is repaired by the first update that runs this code (D7).
 */
import { randomBytes } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext, Deps } from "../deps"
import { formatBytes, type StepReporter, stepReporter } from "../progress"
import {
  compareVersions,
  detectInstall,
  fetchLatest,
  fetchPinned,
  helperAssetName,
  type ReleaseAsset,
  releaseBaseUrl,
  releaseIdentityUri,
} from "../release"
import { checkReleaseAsset, downloadReleaseAsset, downloadSums, messageOf } from "../release-assets"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { HELPER_NAME } from "../vault/fido2"
import { CLI_VERSION } from "../version"

/** D9's second copy change. `verifying signature` has been its own stage since 0.8.4 (`8019923d`);
 * what this adds is naming the scheme and the pin, which is the fact a reader wants here. */
export const SIGNATURE_VERIFIED = "signature verified (Sigstore, keyless; signer pinned to the release workflow)"

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

  // The security key helper, by the same rule: its name is derived from the platform and the
  // manifest may only agree with it (D5). Absent from the manifest is silent (D6): the writer
  // refuses a manifest with some helpers and not others, so "none for this platform" means the
  // release predates the helper (reachable only with --to) and there is nothing to fetch.
  const helperName = helperAssetName(deps.platformKey)
  const helperAsset: ReleaseAsset | undefined = target.helpers?.[deps.platformKey]
  if (helperAsset !== undefined && helperAsset.name !== helperName) {
    writeLocalFailure(
      deps,
      {
        code: "MANIFEST_INVALID",
        message: `Release ${target.tag} names ${helperAsset.name} as the ${deps.platformKey} security key helper; this platform installs ${helperName}.`,
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
  // D9 (BE-241): the size comes free from the manifest (`latest.json` carries `size` per asset), and
  // it makes a slow link legible from the first second rather than after the download finishes.
  // Both assets: the helper roughly doubles the bytes on the wire, and a line that names half of
  // what then transfers is the kind of thing that looks like a hang (BE-275 D5).
  if (!json) {
    const total = asset.size + (helperAsset?.size ?? 0)
    deps.stderr.write(`Updating candle ${CLI_VERSION} -> ${target.version} (${formatBytes(total)})\n`)
  }

  // SHA256SUMS once, for both assets. Then each asset and its bundle by its platform-derived
  // name: the checks above are what make the manifest's own names safe to have agreed with, and
  // those are the names that are used.
  steps.start("downloading SHA256SUMS")
  const sums = await downloadSums(deps, base, target.tag)
  if (!sums.ok) {
    steps.fail("downloading SHA256SUMS")
    writeLocalFailure(deps, { code: "UPDATE_UNREACHABLE", message: sums.message }, json)
    return 1
  }
  steps.done("downloaded SHA256SUMS")

  // Beside the REAL file, and later renamed over it, rather than over `execPath`: a bin entry is
  // often a symlink into a versioned directory, and replacing the link would leave the file it
  // pointed at in place and break anything else pointing at it. `realExec` is what every payload
  // reports as `path` for the same reason. The write also has to land on the same filesystem as
  // the rename target for the rename to be atomic, which "beside the real file" guarantees.
  const dir = realExec.slice(0, realExec.lastIndexOf("/")) || "."
  // Every temp file written so far. From the first write on, every exit path below removes them
  // all except the renames that succeed. Cleanup is best effort: a file being abandoned either
  // way, and a failure to remove it must not replace the failure actually being reported.
  const staged: string[] = []
  const discardAll = async () => {
    for (const path of staged) await discard(deps, path)
  }

  const binary = await stage(deps, steps, {
    base,
    tag: target.tag,
    name: expectedName,
    expectedSha256: asset.sha256,
    sums: sums.sums,
    identityUri,
    dir,
    version: target.version,
    staged,
    label: "",
  })
  if (!binary.ok) {
    await discardAll()
    writeLocalFailure(deps, binary.failure, json)
    return 1
  }

  let helper: { tmpPath: string; target: string } | null = null
  if (helperAsset !== undefined) {
    // The declared helper must download and verify before anything is renamed (D5); a declared
    // helper that cannot be fetched is the same "nothing installed" as one that fails a check.
    const fetched = await stage(deps, steps, {
      base,
      tag: target.tag,
      name: helperName,
      expectedSha256: helperAsset.sha256,
      sums: sums.sums,
      identityUri,
      dir,
      version: target.version,
      staged,
      label: `${helperName} `,
    })
    if (!fetched.ok) {
      await discardAll()
      writeLocalFailure(deps, fetched.failure, json)
      return 1
    }
    helper = { tmpPath: fetched.tmpPath, target: `${dir}/${HELPER_NAME}` }
  }

  // Both verified. Binary first, helper second (D5): the window where the new binary sits beside
  // the old helper is bounded and already handled -- the helper protocol carries a version and a
  // mismatched pair is refused with "Reinstall the CLI so candle and candle-fido2 come from the
  // same release" (fido2.ts). Renaming the helper first would invert the window without closing
  // it, and would leave a machine whose primary deliverable did not move.
  steps.start("installing")
  try {
    await deps.rename(binary.tmpPath, realExec)
  } catch (error) {
    steps.fail("installing")
    // A rename that fails is the same problem as a write that fails, reported the same way: the
    // directory is not ours to replace a file in. Letting it throw would exit through
    // `Unexpected error` with nothing on stdout and no envelope for a `--json` caller.
    await discardAll()
    writeLocalFailure(deps, notWritable(dir, error), json)
    return 1
  }
  if (helper !== null) {
    try {
      await deps.rename(helper.tmpPath, helper.target)
    } catch (error) {
      steps.fail("installing")
      await discard(deps, helper.tmpPath)
      // The exact state, rather than leaving it to be inferred: the binary moved, the helper did
      // not, and the operator is told which file is where.
      const failure = notWritable(dir, error)
      writeLocalFailure(
        deps,
        {
          ...failure,
          message: `${failure.message} candle ${target.version} was installed to ${realExec}, but its security key helper could not be renamed to ${helper.target}.`,
        },
        json,
      )
      return 1
    }
  }
  steps.done(`installed to ${realExec}${helper !== null ? ` and ${helper.target}` : ""}`)
  // `helper` is one optional key on the payload, null when the release declares none for this
  // platform; nothing existing changes type or disappears.
  const helperReport = helper !== null ? { name: HELPER_NAME, updated: true } : null
  if (json) {
    const payload = {
      current: CLI_VERSION,
      latest: target.version,
      updated: true,
      path: realExec,
      helper: helperReport,
    }
    deps.stdout.write(`${JSON.stringify(payload)}\n`)
  } else {
    deps.stdout.write(`Updated candle ${CLI_VERSION} -> ${target.version}\n`)
    if (helper !== null) deps.stdout.write(`Installed ${HELPER_NAME} ${target.version} to ${helper.target}\n`)
  }
  return 0
}

type Staged =
  | { ok: true; tmpPath: string }
  | { ok: false; failure: { code: string; message: string; suggestion?: string } }

/**
 * One asset, start to verified temp file: download, write beside the real binary, check the
 * checksum, check the signature. The temp path is pushed onto `staged` as soon as it is written so
 * the caller can discard every one of them on any later failure. `label` prefixes the progress
 * lines for the second asset, so the two checksum and signature stages read apart.
 */
async function stage(
  deps: Deps,
  steps: StepReporter,
  opts: {
    base: string
    tag: string
    name: string
    expectedSha256: string
    sums: string
    identityUri: string
    dir: string
    version: string
    staged: string[]
    label: string
  },
): Promise<Staged> {
  const { name, label } = opts
  steps.start(`downloading ${name}`)
  const download = await downloadReleaseAsset(deps, opts.base, opts.tag, name)
  if (!download.ok) {
    steps.fail(`downloading ${name}`)
    return { ok: false, failure: { code: "UPDATE_UNREACHABLE", message: download.message } }
  }
  steps.done(`downloaded ${name} (${formatBytes(download.bytes.length)})`)

  // Random, not derived from the version: a predictable name in a directory someone else can
  // write is a file they can plant, and the rename moves whatever is at that path at that
  // instant, not the bytes that were verified. The real `writeBytes` refuses an existing path
  // (index.ts) so a collision fails the write instead of truncating someone's file.
  const tmpPath = `${opts.dir}/.candle-update-${opts.version}-${randomBytes(6).toString("hex")}`
  try {
    await deps.writeBytes(tmpPath, download.bytes)
  } catch (error) {
    return { ok: false, failure: notWritable(opts.dir, error) }
  }
  opts.staged.push(tmpPath)

  steps.start(`verifying ${label}checksum`)
  const checked = checkReleaseAsset(deps, {
    name,
    bytes: download.bytes,
    sums: opts.sums,
    bundle: download.bundle,
    expectedSha256: opts.expectedSha256,
    identityUri: opts.identityUri,
  })
  if (!checked.ok && checked.stage === "checksum") {
    steps.fail(`verifying ${label}checksum`)
    return { ok: false, failure: { code: "UPDATE_VERIFY_FAILED", message: checked.message } }
  }
  steps.done(`${label}checksum verified`)
  steps.start(`verifying ${label}signature`)
  if (!checked.ok) {
    steps.fail(`verifying ${label}signature`)
    return {
      ok: false,
      failure: { code: "UPDATE_VERIFY_FAILED", message: checked.message, suggestion: checked.suggestion },
    }
  }
  // D9: the done line says WHAT KIND of signature, because that is the differentiator and this is
  // where a reader looks for it. The step itself is not new; it has been its own stage since 0.8.4.
  steps.done(`${label}${SIGNATURE_VERIFIED}`)
  return { ok: true, tmpPath }
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
