#!/usr/bin/env bash
# Candle CLI installer. Downloads the signed release binary for this machine into ~/.local/bin,
# checks its SHA-256 against the release's SHA256SUMS and manifest (consistency), verifies its
# Sigstore signature with cosign or gh (the actual verification; the install fails closed without
# one unless CANDLE_INSTALL_ALLOW_UNSIGNED=1), and prepends the bin dir to PATH. Usage:
#   curl -fsSL https://candle.tv/install.sh | bash
#   curl -fsSL https://candle.tv/install.sh | bash -s -- --to cli-v0.6.0 --no-modify-path
# Never uses sudo. Writes only the bin dir, a temp dir, and (unless --no-modify-path) one rc file.
set -euo pipefail

RELEASE_BASE="${CANDLE_RELEASE_BASE_URL:-https://github.com/candledottv/agentic}"
BIN_DIR="${CANDLE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION_TAG=""
MODIFY_PATH=1
FORCE=0
# Keep these two literals identical to RELEASE_IDENTITY_REGEX and RELEASE_ISSUER in
# packages/cli/src/release.ts; release.test.ts greps this file for them.
IDENTITY_REGEX='^https://github.com/candledottv/agentic/\.github/workflows/release\.yaml@refs/tags/cli-v'
ISSUER='https://token.actions.githubusercontent.com'

usage() {
  cat <<EOF
Candle CLI installer
  --to <tag>          Install a specific release (default: latest), e.g. cli-v0.6.0
                      (--version <tag> is an alias; the CLI's own flag is: candle update --to)
  --bin-dir <dir>     Where to put the binary (default: ~/.local/bin)
  --no-modify-path    Do not edit your shell rc file
  --force             Install even if Homebrew already provides candle
EOF
}

require_arg() {
  # $1: the flag name, for the message. Guards "$2" (the loop's remaining-args count) so a flag
  # given as the last argument prints usage and exits 2, instead of tripping "set -u" on "$2".
  [ "$2" -ge 2 ] || { echo "install.sh: $1 requires an argument" >&2; usage >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    # `--to` is the spelling `candle update` uses; `--version` is kept because it is what this
    # script has always taken and what is already pasted in READMEs and issues.
    --to|--version) require_arg "$1" "$#"; VERSION_TAG="$2"; shift 2 ;;
    --to=*|--version=*) VERSION_TAG="${1#*=}"; shift ;;
    --bin-dir) require_arg "$1" "$#"; BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# A leading ~ in --bin-dir or $CANDLE_INSTALL_DIR (the shell does not expand it inside a quoted
# assignment, and this runs before any quoting the caller did): expand it to $HOME ourselves.
BIN_DIR="${BIN_DIR/#\~/$HOME}"

fail() { echo "install.sh: $*" >&2; exit 1; }

# 1. Platform.
os="$(uname -s)"; machine="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) fail "Windows is not supported by install.sh yet. Run: npm i -g @candledottv/cli" ;;
  *) fail "Unsupported OS: $os. Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64" ;;
esac
case "$machine" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) fail "Unsupported architecture: $machine. Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64" ;;
esac
asset="candle-${os}-${arch}"

# 2. Tools.
command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required"
fi

# 7 (early). An existing Homebrew install owns its files; defer to brew unless forced.
if [ "$FORCE" -eq 0 ] && command -v candle >/dev/null 2>&1; then
  existing="$(command -v candle)"
  resolved="$(cd "$(dirname "$existing")" && pwd -P)/$(basename "$existing")"
  if [ -L "$existing" ]; then resolved="$(readlink "$existing")"; fi
  case "$resolved" in
    */Cellar/candle/*|/opt/homebrew/*|/usr/local/Cellar/*)
      echo "candle is installed by Homebrew at $existing. Run: brew upgrade candle (or rerun with --force)."
      exit 0 ;;
  esac
fi

# 3. Resolve the release.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [ -n "$VERSION_TAG" ]; then
  download_base="${RELEASE_BASE}/releases/download/${VERSION_TAG}"
else
  download_base="${RELEASE_BASE}/releases/latest/download"
fi
# Pin the protocol so a redirect cannot downgrade an https release fetch to plain http. Left empty
# for a non-https RELEASE_BASE (the fixture server in tests, and any --bin-dir-style local override).
CURL_OPTS=()
case "$RELEASE_BASE" in
  https://*) CURL_OPTS=(--proto '=https' --proto-redir '=https') ;;
esac
curl "${CURL_OPTS[@]+"${CURL_OPTS[@]}"}" -fsSL "${download_base}/latest.json" -o "$tmp/latest.json" || fail "could not fetch the release manifest from ${download_base}/latest.json"
version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -1)"
[ -n "$version" ] || fail "the release manifest has no version"

# Bind signature verification to the version actually being installed.
#
# IDENTITY_REGEX above ends at `cli-v`, so on its own it accepts a signature minted for ANY cli-v
# tag. That is a signed downgrade: ask for 0.8.0, be handed a legitimately signed 0.3.0 with known
# holes, and verification passes. `candle verify` and `candle update` already pin the exact tag
# through releaseIdentityUri(); this is the installer catching up.
#
# The version is VALIDATED before it reaches a regex, not trusted. It comes out of a downloaded
# latest.json, which is exactly the input an attacker controls, and release.ts records what an
# unvalidated one does: `{"version": "x|"}` yields an identity whose alternation matches every
# identity there is, so a file signed by an unrelated project verifies.
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "the release manifest has a malformed version: ${version}"
# A manifest describing a different version than the tag we asked for is a mismatch worth stopping
# on, not reconciling.
if [ -n "$VERSION_TAG" ] && [ "$VERSION_TAG" != "cli-v${version}" ]; then
  fail "requested ${VERSION_TAG} but the manifest at that tag describes cli-v${version}; nothing installed"
fi
identity_regex_pinned="${IDENTITY_REGEX}$(printf '%s' "$version" | sed 's/\./\\./g')\$"
identity_exact="https://github.com/candledottv/agentic/.github/workflows/release.yaml@refs/tags/cli-v${version}"

# 4. Download.
curl "${CURL_OPTS[@]+"${CURL_OPTS[@]}"}" -fsSL "${download_base}/${asset}" -o "$tmp/$asset" || fail "no release binary for ${os}-${arch} at ${download_base}/${asset}"
curl "${CURL_OPTS[@]+"${CURL_OPTS[@]}"}" -fsSL "${download_base}/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not fetch SHA256SUMS"
curl "${CURL_OPTS[@]+"${CURL_OPTS[@]}"}" -fsSL "${download_base}/${asset}.sigstore.json" -o "$tmp/$asset.sigstore.json" || fail "could not fetch the signature bundle"

# 5. Verify: the checksum against SHA256SUMS and the manifest, then the signature where a verifier exists.
actual="$(sha256 "$tmp/$asset")"
expected_sums="$(awk -v a="$asset" '$2 == a {print $1}' "$tmp/SHA256SUMS")"
# The release workflow pretty-prints latest.json, so an asset's "name" and "sha256" fields usually
# sit on different lines and a line-oriented sed can't see them together. Strip all whitespace
# first so the whole file collapses to one line, regardless of how it was printed.
expected_manifest="$(tr -d '[:space:]' < "$tmp/latest.json" | sed -n "s/.*\"${asset}\"[^}]*\"sha256\":\"\([0-9a-f]*\)\".*/\1/p")"
[ "$actual" = "$expected_sums" ] || fail "checksum mismatch for $asset (SHA256SUMS says $expected_sums, file is $actual); nothing installed"
[ -n "$expected_manifest" ] || fail "latest.json has no sha256 for $asset"
[ "$actual" = "$expected_manifest" ] || fail "checksum mismatch between SHA256SUMS and latest.json; nothing installed"

verified=0
if command -v cosign >/dev/null 2>&1; then
  # --new-bundle-format says "expect a Sigstore protobuf bundle", which is what the release
  # workflow signs and the only shape candle's own in-process verifier reads. Without the flag
  # cosign also accepts its legacy {"base64Signature","cert","rekorBundle"} shape, so a release
  # mis-signed that way (0.6.0 was) would install here and then fail every `candle update`.
  # The flag needs cosign 2.2 or newer; an older cosign rejects the unknown flag and the install
  # stops, which is the right way to be wrong.
  if ! verify_output="$(cosign verify-blob --new-bundle-format --bundle "$tmp/$asset.sigstore.json" --certificate-identity-regexp "$identity_regex_pinned" --certificate-oidc-issuer "$ISSUER" "$tmp/$asset" 2>&1)"; then
    echo "$verify_output" >&2
    fail "signature verification failed for $asset; nothing installed"
  fi
  verified=1
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # --signer-workflow, not just --repo: the repo alone accepts an attestation from ANY workflow in
  # candledottv/agentic that can mint one, while the cosign branch above pins the workflow FILE.
  # --cert-identity additionally pins the TAG, matching what the cosign branch now does, so the two
  # verifiers keep checking the same thing rather than drifting apart on which one is stricter.
  if ! verify_output="$(gh attestation verify "$tmp/$asset" --repo candledottv/agentic --signer-workflow candledottv/agentic/.github/workflows/release.yaml --cert-identity "$identity_exact" 2>&1)"; then
    echo "$verify_output" >&2
    fail "signature verification failed for $asset (gh attestation verify); nothing installed"
  fi
  verified=1
fi
if [ "$verified" -eq 0 ]; then
  if [ "${CANDLE_INSTALL_ALLOW_UNSIGNED:-}" != "1" ]; then
    # Named per platform, and only ways that work. This used to say "apt/dnf install cosign";
    # cosign is packaged in neither Debian/Ubuntu nor Fedora, so the one instruction a Linux user
    # was handed could only fail. Upstream ships a single static binary, and gh is the other route.
    fail "no signature verifier found, so the download is not verified and nothing was installed. This binary will hold API keys and wallet signers, so the installer stops here by default. Install one and rerun: on macOS, brew install cosign; on Linux, download cosign from https://github.com/sigstore/cosign/releases (a single binary) or run gh auth login for the GitHub CLI. To install on the checksum alone: CANDLE_INSTALL_ALLOW_UNSIGNED=1 curl -fsSL https://candle.tv/install.sh | bash"
  fi
  echo "Warning: signature not verified (CANDLE_INSTALL_ALLOW_UNSIGNED=1); the checksum matched. To verify later:"
  echo "  cosign verify-blob --new-bundle-format --bundle ${asset}.sigstore.json --certificate-identity-regexp '${IDENTITY_REGEX}' --certificate-oidc-issuer ${ISSUER} ${asset}"
fi

# 6. Install atomically. $tmp is often a different filesystem than $BIN_DIR (tmpfs on Linux), and
# mv across filesystems is a copy, not a rename, so it is not atomic and a rerun over an existing
# install could leave candle missing or truncated if interrupted mid-copy. Stage the final bytes
# inside BIN_DIR itself so the last step is a same-filesystem rename.
mkdir -p "$BIN_DIR"
# mktemp, not ".candle.new.$$": a PID is guessable and short-lived, so on a shared or
# group-writable bin dir somebody can create that exact path first and have `mv` move THEIR file
# over candle. mktemp creates the file itself and fails rather than reusing one that exists.
staged="$(mktemp "$BIN_DIR/.candle.new.XXXXXX")"
trap 'rm -rf "$tmp" "$staged"' EXIT
cp "$tmp/$asset" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$BIN_DIR/candle"

# 7. An npm-global candle elsewhere on PATH: say which one wins.
if command -v candle >/dev/null 2>&1; then
  other="$(command -v candle)"
  if [ "$other" != "$BIN_DIR/candle" ] && head -c 2 "$other" 2>/dev/null | grep -q '#!'; then
    echo "Note: another candle is on PATH at $other (an npm install). PATH order decides which runs; remove it with: npm uninstall -g @candledottv/cli"
  fi
fi

# 8. PATH. The block PREPENDS the bin dir and is appended at the END of the rc, so it runs after
# anything else the file sets: ~/.local/bin/candle beats an npm candle in /usr/local/bin.
# shellcheck disable=SC2016 # literal text for the rc file; it expands when that file is sourced, not here
export_line='export PATH="$HOME/.local/bin:$PATH"'
if [ "$BIN_DIR" != "$HOME/.local/bin" ]; then export_line="export PATH=\"$BIN_DIR:\$PATH\""; fi
# shellcheck disable=SC2016 # literal text for the "For this session" hint; $PATH is fish's own variable, not ours
fish_line="set -gx PATH $BIN_DIR \$PATH"
case ":$PATH:" in
  *":$BIN_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" -eq 0 ]; then
  case "${SHELL:-}" in
    */fish) session_line="$fish_line" ;;
    *) session_line="$export_line" ;;
  esac
  if [ "$MODIFY_PATH" -eq 1 ]; then
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc"; line="$export_line" ;;
      */fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path --prepend $BIN_DIR" ;;
      *) if [ -f "$HOME/.bashrc" ]; then rc="$HOME/.bashrc"; else rc="$HOME/.bash_profile"; fi; line="$export_line" ;;
    esac
    mkdir -p "$(dirname "$rc")"
    if ! grep -qs "# candle installer" "$rc"; then
      printf '\n# candle installer\n%s\n' "$line" >> "$rc"
      echo "Added $BIN_DIR to PATH in $rc"
    fi
  fi
  echo "For this session: $session_line"
fi

# 9. Prove it.
echo "Installed candle $version to $BIN_DIR/candle"
"$BIN_DIR/candle" --version
echo "Next: candle setup"
