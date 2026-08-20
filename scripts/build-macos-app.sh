#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/apps/macos"
CONFIGURATION="${1:-debug}"
APP_DIR="${PACKAGE_DIR}/.build/app/Violet.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"

mkdir -p "${PACKAGE_DIR}/.swift-tmp"

TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
  --package-path "${PACKAGE_DIR}" \
  --configuration "${CONFIGURATION}" \
  --product Violet \
  --disable-index-store \
  --jobs 4

BIN_DIR="$(
  TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
    --package-path "${PACKAGE_DIR}" \
    --configuration "${CONFIGURATION}" \
    --show-bin-path
)"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}"
install -m 0755 "${BIN_DIR}/Violet" "${MACOS_DIR}/Violet"
install -m 0644 "${PACKAGE_DIR}/Resources/Violet-Info.plist" "${CONTENTS_DIR}/Info.plist"

plutil -lint "${CONTENTS_DIR}/Info.plist"
codesign --force --sign - "${APP_DIR}"
codesign --verify --deep --strict "${APP_DIR}"

printf '%s\n' "${APP_DIR}"
