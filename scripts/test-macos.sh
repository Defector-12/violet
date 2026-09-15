#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="${ROOT}/apps/macos"
TMP="${PACKAGE}/.swift-tmp"
mkdir -p "${TMP}/cache" "${TMP}/config" "${TMP}/security"
if [[ "${VIOLET_SWIFTPM_DISABLE_SANDBOX:-0}" == "1" ]]; then
  set -- --disable-sandbox "$@"
fi
TMPDIR="${TMP}" swift test \
  --package-path "${PACKAGE}" \
  --cache-path "${TMP}/cache" \
  --config-path "${TMP}/config" \
  --security-path "${TMP}/security" \
  --disable-index-store -j 4 "$@"
