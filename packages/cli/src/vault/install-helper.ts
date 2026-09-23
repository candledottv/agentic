/**
 * `vault factor add security-key --install-helper` (BE-275 D8): put this release's `candle-fido2`
 * beside the running binary, through the same download and the same two checks `candle update`
 * uses, and install nothing on any failure.
 *
 * Why this exists: `candle update` runs the INSTALLED binary's code, so the fix that makes `update`
 * install the helper (D5) is inert until the operator has already updated once with it. The repair
 * that reaches a machine already in that state has to run on the binary the operator is holding,
 * and it is offered in the sentence that refuses them. It installs the helper for THIS binary's own
 * version, not the latest: a helper newer than the binary is the protocol mismatch fido2.ts refuses.
 *
 * Behind an explicit flag, never automatic: the default refusal is the right shape for a security
 * command, and silently acquiring a 60 MB executable from the network from inside a command that
 * otherwise touches only local state and a USB device is a real expansion of what `factor add` does.
 */
import { randomBytes } from "node:crypto"
import type { CommandContext, Deps } from "../deps"
import { formatBytes, stepReporter } from "../progress"
import { detectInstall, fetchPinned, helperAssetName, releaseBaseUrl, releaseIdentityUri } from "../release"
import { checkReleaseAsset, downloadReleaseAsset, downloadSums, messageOf } from "../release-assets"
import { CLI_VERSION } from "../version"
import { HELPER_NAME, locateFido2Helper } from "./fido2"

export type HelperInstall =
  /** A helper was already where the CLI looks; nothing was downloaded. */
  | { ok: true; path: string; installed: false }
  /** Downloaded, verified and renamed into place. */
  | { ok: true; path: string; installed: true }
  | { ok: false; message: string }

/**
 * Locates the helper and, when a release binary has none beside it, fetches this version's from
 * the release's own manifest and installs it. Progress goes to stderr as `update`'s does, and is
 * silent under `--json`. Any failure short of a verified install returns `ok: false` with the
 * reason and leaves nothing behind.
 */
export async function installHelperForThisRelease(ctx: CommandContext): Promise<HelperInstall> {
  const { deps, json } = ctx
  const location = await locateFido2Helper(deps)
  if (location.state === "ready") return { ok: true, path: location.path, installed: false }
  if (!location.installable) return { ok: false, message: location.reason }

  const realExec = await deps.realpath(deps.execPath).catch(() => deps.execPath)
  if (detectInstall(deps.execPath, realExec) === "homebrew") {
    // The Cellar is brew's; the formula places candle-fido2 there itself (D10), so a missing one
    // is a broken install brew should repair, not a file to write by hand.
    return { ok: false, message: `candle is installed by Homebrew at ${realExec}. Run: brew reinstall candle` }
  }
  if (!deps.platformKey) return { ok: false, message: "this CLI ships no security key helper for this platform" }

  const base = releaseBaseUrl(deps.env)
  const tag = `cli-v${CLI_VERSION}`
  const name = helperAssetName(deps.platformKey)
  const steps = json
    ? stepReporter(() => {}, false)
    : stepReporter((text) => deps.stderr.write(text), process.stderr.isTTY === true)

  steps.start(`reading the ${tag} release manifest`)
  const fetched = await fetchPinned(deps, base, tag)
  if (!fetched.ok) {
    steps.fail(`reading the ${tag} release manifest`)
    return { ok: false, message: fetched.message }
  }
  const asset = fetched.manifest.helpers?.[deps.platformKey]
  if (asset === undefined) {
    steps.fail(`reading the ${tag} release manifest`)
    return { ok: false, message: `release ${tag} declares no ${name}` }
  }
  // The manifest may agree with the platform-derived name and do nothing else (D5): every asset in
  // a release is signed under the same identity, so a manifest naming another file here would pass
  // both checks and leave that file beside the binary as the helper.
  if (asset.name !== name) {
    steps.fail(`reading the ${tag} release manifest`)
    return {
      ok: false,
      message: `release ${tag} names ${asset.name} as the ${deps.platformKey} security key helper; this platform installs ${name}`,
    }
  }
  steps.done(`release ${tag} declares ${name} (${formatBytes(asset.size)})`)

  steps.start(`downloading ${name}`)
  const sums = await downloadSums(deps, base, tag)
  if (!sums.ok) {
    steps.fail(`downloading ${name}`)
    return { ok: false, message: sums.message }
  }
  const download = await downloadReleaseAsset(deps, base, tag, name)
  if (!download.ok) {
    steps.fail(`downloading ${name}`)
    return { ok: false, message: download.message }
  }
  steps.done(`downloaded ${name} (${formatBytes(download.bytes.length)})`)

  // Pinned to the running binary's own version. `releaseIdentityUri` cannot throw here: CLI_VERSION
  // is this build's constant, not a downloaded string.
  steps.start("verifying checksum and signature")
  const checked = checkReleaseAsset(deps, {
    name,
    bytes: download.bytes,
    sums: sums.sums,
    bundle: download.bundle,
    expectedSha256: asset.sha256,
    identityUri: releaseIdentityUri(CLI_VERSION),
  })
  if (!checked.ok) {
    steps.fail("verifying checksum and signature")
    return { ok: false, message: `${checked.message}${checked.suggestion ? ` ${checked.suggestion}` : ""}` }
  }
  steps.done("checksum and signature verified (Sigstore, keyless; signer pinned to the release workflow)")

  // Beside the real binary, staged under an unguessable name and renamed into place, exactly as
  // `update` does and for the same reasons (update.ts).
  const dir = realExec.slice(0, realExec.lastIndexOf("/")) || "."
  const target = `${dir}/${HELPER_NAME}`
  const tmpPath = `${dir}/.candle-fido2-${CLI_VERSION}-${randomBytes(6).toString("hex")}`
  steps.start(`installing ${HELPER_NAME}`)
  try {
    await deps.writeBytes(tmpPath, download.bytes)
  } catch (error) {
    steps.fail(`installing ${HELPER_NAME}`)
    return { ok: false, message: `cannot write ${dir}: ${messageOf(error)}` }
  }
  try {
    await deps.rename(tmpPath, target)
  } catch (error) {
    steps.fail(`installing ${HELPER_NAME}`)
    await discard(deps, tmpPath)
    return { ok: false, message: `cannot write ${dir}: ${messageOf(error)}` }
  }
  steps.done(`installed ${HELPER_NAME} ${CLI_VERSION} to ${target}`)
  return { ok: true, path: target, installed: true }
}

async function discard(deps: Deps, path: string): Promise<void> {
  try {
    await deps.unlink(path)
  } catch {
    // Best effort: the failure being reported is the one that matters.
  }
}
