#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/apps/macos"
CONFIGURATION="${1:-debug}"
APP_DIR="${PACKAGE_DIR}/.build/app/Violet.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
WAKE_ASSETS_DIR="${PACKAGE_DIR}/.local-wake"

mkdir -p "${PACKAGE_DIR}/.swift-tmp"
"${ROOT_DIR}/scripts/fetch-wake-word-assets.sh" >/dev/null

swift_flags=()
if [[ "${VIOLET_SWIFTPM_DISABLE_SANDBOX:-0}" == "1" ]]; then
  swift_flags+=(--disable-sandbox)
fi

TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
  --package-path "${PACKAGE_DIR}" \
  --configuration "${CONFIGURATION}" \
  --product Violet \
  --disable-index-store \
  "${swift_flags[@]}" \
  --jobs 4

BIN_DIR="$(
  TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
    --package-path "${PACKAGE_DIR}" \
    --configuration "${CONFIGURATION}" \
    "${swift_flags[@]}" \
    --show-bin-path
)"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}/WakeWord/lib" "${RESOURCES_DIR}/WakeWord/model"
install -m 0755 "${BIN_DIR}/Violet" "${MACOS_DIR}/Violet"
install -m 0644 "${PACKAGE_DIR}/Resources/Violet-Info.plist" "${CONTENTS_DIR}/Info.plist"
install -m 0755 "${WAKE_ASSETS_DIR}/lib/"*.dylib "${RESOURCES_DIR}/WakeWord/lib/"
install -m 0644 "${WAKE_ASSETS_DIR}/model/"* "${RESOURCES_DIR}/WakeWord/model/"
install -m 0644 "${WAKE_ASSETS_DIR}/ENGINE-LICENSE.txt" "${RESOURCES_DIR}/WakeWord/"
install -m 0644 "${WAKE_ASSETS_DIR}/MODEL-LICENSE.md" "${RESOURCES_DIR}/WakeWord/"

plutil -lint "${CONTENTS_DIR}/Info.plist"
codesign --force --sign - "${RESOURCES_DIR}/WakeWord/lib/libonnxruntime.dylib"
codesign --force --sign - "${RESOURCES_DIR}/WakeWord/lib/libsherpa-onnx-c-api.dylib"
codesign --force --sign - "${APP_DIR}"
codesign --verify --deep --strict "${APP_DIR}"

printf '%s\n' "${APP_DIR}"
