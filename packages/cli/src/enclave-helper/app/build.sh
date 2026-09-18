#!/usr/bin/env bash
# Builds candle-enclave.app, unsigned, from main.swift. Run on macOS with Xcode's command line
# tools. The release job (release.yaml, job "macos-helper") runs this and then signs, verifies,
# notarizes and staples the result; T48's operator runs it by hand for a local build.
#
#   build.sh [version] [bundle id] [out dir] [team id]
#
# With no arguments (bun run build:enclave-helper) the version is packages/cli/package.json's,
# the bundle id is release-policy.json's, the output directory is packages/cli/dist-bin, and no
# entitlements file is written. Writes <out dir>/candle-enclave.app and, when a team id is given,
# the entitlements file the signing step needs at <out dir>/candle-enclave.entitlements. Both
# architectures are compiled and combined with lipo, so one bundle serves darwin-arm64 and
# darwin-x64.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$(cd "$here/../../.." && pwd)"
version="${1:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package/package.json" | head -1)}"
bundle_id="${2:-$(sed -n 's/.*"bundleId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package/release-policy.json" | head -1)}"
out="${3:-$package/dist-bin}"
team_id="${4:-}"
[ -n "$version" ] || { echo "build.sh: no version" >&2; exit 1; }
[ -n "$bundle_id" ] || { echo "build.sh: no bundle id" >&2; exit 1; }
mkdir -p "$out"
app="$out/candle-enclave.app"

rm -rf "$app" "$out/obj"
mkdir -p "$app/Contents/MacOS" "$out/obj"
for arch in arm64 x86_64; do
  swiftc -O -target "${arch}-apple-macos12.0" \
    -framework Security -framework LocalAuthentication \
    -o "$out/obj/candle-enclave-${arch}" "$here/main.swift"
done
lipo -create -output "$app/Contents/MacOS/candle-enclave" \
  "$out/obj/candle-enclave-arm64" "$out/obj/candle-enclave-x86_64"
sed -e "s/__VERSION__/${version}/g" -e "s/__BUNDLE_ID__/${bundle_id}/g" \
  "$here/Info.plist.template" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
plutil -lint "$app/Contents/Info.plist"
if [ -n "$team_id" ]; then
  sed -e "s/__TEAM_ID__/${team_id}/g" -e "s/__BUNDLE_ID__/${bundle_id}/g" \
    "$here/entitlements.plist.template" > "$out/candle-enclave.entitlements"
  plutil -lint "$out/candle-enclave.entitlements"
fi
rm -rf "$out/obj"
echo "built $app (version ${version}, bundle id ${bundle_id})"
