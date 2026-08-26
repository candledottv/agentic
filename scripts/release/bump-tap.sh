#!/usr/bin/env bash
# Rewrites Formula/candle.rb in a checkout of candledottv/homebrew-tap from the template and a
# release's SHA256SUMS, commits and pushes. Run by release.yaml after the GitHub Release exists:
#   scripts/release/bump-tap.sh <version> <dist dir with SHA256SUMS> <tap checkout dir>
set -euo pipefail
version="$1"; dist="$2"; tap="$3"
template="$(dirname "$0")/candle.rb.template"
sum_for() { awk -v a="candle-${version}-$1.tar.gz" '$2 == a {print $1}' "$dist/SHA256SUMS"; }
sha_darwin_arm64="$(sum_for darwin-arm64)"
sha_darwin_x64="$(sum_for darwin-x64)"
sha_linux_arm64="$(sum_for linux-arm64)"
sha_linux_x64="$(sum_for linux-x64)"
# Resolve and validate all four sums before touching the template: an empty sum_for result would
# otherwise make the sed below delete the placeholder instead of leaving it for the __SHA_ grep
# to catch, so that guard alone cannot fire on a missing tarball.
for pair in "darwin-arm64:$sha_darwin_arm64" "darwin-x64:$sha_darwin_x64" "linux-arm64:$sha_linux_arm64" "linux-x64:$sha_linux_x64"; do
  [ -n "${pair#*:}" ] || { echo "bump-tap.sh: no checksum for candle-${version}-${pair%%:*}.tar.gz in $dist/SHA256SUMS" >&2; exit 1; }
done
formula="$(sed \
  -e "s/__VERSION__/${version}/g" \
  -e "s/__SHA_darwin_arm64__/${sha_darwin_arm64}/" \
  -e "s/__SHA_darwin_x64__/${sha_darwin_x64}/" \
  -e "s/__SHA_linux_arm64__/${sha_linux_arm64}/" \
  -e "s/__SHA_linux_x64__/${sha_linux_x64}/" \
  "$template")"
# Second guard, kept in case a future placeholder is added without an accompanying variable above.
if echo "$formula" | grep -q "__SHA_"; then
  echo "bump-tap.sh: a tarball checksum is missing from SHA256SUMS" >&2
  exit 1
fi
mkdir -p "$tap/Formula"
printf '%s\n' "$formula" > "$tap/Formula/candle.rb"
cd "$tap"
git add Formula/candle.rb
if git diff --cached --quiet; then
  echo "formula already at ${version}"
  exit 0
fi
git -c user.name="candle-release-bot" -c user.email="release-bot@candle.tv" commit -m "candle ${version}"
git push origin HEAD
echo "tap bumped to ${version}"
