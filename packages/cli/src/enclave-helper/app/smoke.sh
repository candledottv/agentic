#!/usr/bin/env bash
# Smoke-tests a built candle-enclave.app without a key, a keychain item or a Touch ID prompt:
#
#   smoke.sh <path to candle-enclave.app>
#
# `info` must answer ok (it reports the bundle, the Secure Enclave and Touch ID state, and never
# prompts), and an unknown operation must be a typed BAD_REQUEST refusal. CI runs this after
# build.sh on a macOS runner; it also runs by hand against a local build.
set -euo pipefail

app="${1:?usage: smoke.sh <path to candle-enclave.app>}"
helper="$app/Contents/MacOS/candle-enclave"
[ -x "$helper" ] || { echo "smoke.sh: no executable at $helper" >&2; exit 1; }

digest="$(head -c 32 /dev/zero | base64)"

info="$(printf '{"op":"info","vaultId":"smoke","envelopeId":"smoke","digest":"%s"}\n' "$digest" | "$helper")"
echo "info: $info"
case "$info" in
  *'"ok":true'*) ;;
  *) echo "smoke.sh: info did not answer ok" >&2; exit 1 ;;
esac

# The helper exits non-zero on a refusal, which is the point; capture its answer anyway.
unknown="$(printf '{"op":"nope","vaultId":"smoke","envelopeId":"smoke","digest":"%s"}\n' "$digest" | "$helper" || true)"
echo "unknown op: $unknown"
case "$unknown" in
  *'"code":"BAD_REQUEST"'*) ;;
  *) echo "smoke.sh: an unknown operation was not refused with BAD_REQUEST" >&2; exit 1 ;;
esac

echo "smoke.sh: candle-enclave answers its protocol"
