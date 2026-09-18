#!/usr/bin/env bash
# Builds candle-enclave.app, unsigned, from main.swift. Run on macOS with Xcode's command line
# tools. The release job (release.yaml, job "macos-helper") runs this and then signs, verifies,
# notarizes and staples the result; T48's operator runs it by hand for a local build.
#
#   build.sh [version] [bundle id] [out dir] [team id] [provisioning profile]
#
# With no arguments (bun run build:enclave-helper) the version is packages/cli/package.json's,
# the bundle id is release-policy.json's, the output directory is packages/cli/dist-bin, and no
# entitlements file is written. Writes <out dir>/candle-enclave.app and, when a team id is given,
# the entitlements file the signing step needs at <out dir>/candle-enclave.entitlements. Both
# architectures are compiled and combined with lipo, so one bundle serves darwin-arm64 and
# darwin-x64. A fifth argument names a Developer ID provisioning profile (BE-135, PR G): it is
# embedded as Contents/embedded.provisionprofile, which the associated-domains entitlement for
# the synced passkey factor needs; without one the bundle builds, and the CLI refuses that
# factor with a typed code because `info` reports no profile.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$(cd "$here/../../.." && pwd)"
version="${1:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package/package.json" | head -1)}"
bundle_id="${2:-$(sed -n 's/.*"bundleId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package/release-policy.json" | head -1)}"
out="${3:-$package/dist-bin}"
team_id="${4:-}"
profile="${5:-}"
[ -n "$version" ] || { echo "build.sh: no version" >&2; exit 1; }
[ -n "$bundle_id" ] || { echo "build.sh: no bundle id" >&2; exit 1; }
if [ -n "$profile" ] && [ ! -f "$profile" ]; then echo "build.sh: no provisioning profile at $profile" >&2; exit 1; fi
mkdir -p "$out"
app="$out/candle-enclave.app"

rm -rf "$app" "$out/obj"
mkdir -p "$app/Contents/MacOS" "$out/obj"
for arch in arm64 x86_64; do
  # macOS 12 stays the floor for the Secure Enclave factor; the passkey path is gated at run time
  # with #available(macOS 15) and AuthenticationServices is weak-linked by that check.
  swiftc -O -target "${arch}-apple-macos12.0" \
    -framework Security -framework LocalAuthentication -framework AuthenticationServices -framework AppKit \
    -o "$out/obj/candle-enclave-${arch}" "$here/main.swift"
done
lipo -create -output "$app/Contents/MacOS/candle-enclave" \
  "$out/obj/candle-enclave-arm64" "$out/obj/candle-enclave-x86_64"
sed -e "s/__VERSION__/${version}/g" -e "s/__BUNDLE_ID__/${bundle_id}/g" \
  "$here/Info.plist.template" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
plutil -lint "$app/Contents/Info.plist"
if [ -n "$profile" ]; then
  cp "$profile" "$app/Contents/embedded.provisionprofile"
fi
if [ -n "$team_id" ]; then
  sed -e "s/__TEAM_ID__/${team_id}/g" -e "s/__BUNDLE_ID__/${bundle_id}/g" \
    "$here/entitlements.plist.template" > "$out/candle-enclave.entitlements"
  plutil -lint "$out/candle-enclave.entitlements"
fi
rm -rf "$out/obj"
echo "built $app (version ${version}, bundle id ${bundle_id}${profile:+, provisioning profile embedded})"
