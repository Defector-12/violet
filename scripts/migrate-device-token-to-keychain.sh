#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/apps/macos"
ENV_FILE="${1:-${ROOT_DIR}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'Environment file not found: %s\n' "${ENV_FILE}" >&2
  exit 1
fi

mkdir -p "${PACKAGE_DIR}/.swift-tmp"
TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
  --package-path "${PACKAGE_DIR}" \
  --product violet-credential \
  --disable-index-store \
  --jobs 4

BIN_DIR="$(
  TMPDIR="${PACKAGE_DIR}/.swift-tmp" swift build \
    --package-path "${PACKAGE_DIR}" \
    --show-bin-path
)"

node - "${ENV_FILE}" <<'NODE' | "${BIN_DIR}/violet-credential"
const { readFileSync } = require("node:fs");

const path = process.argv[2];
const lines = readFileSync(path, "utf8").split(/\r?\n/);
const values = lines
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.startsWith("export ") ? line.slice(7).trim() : line)
  .filter((line) => line.startsWith("VIOLET_DEVICE_TOKEN="))
  .map((line) => line.slice("VIOLET_DEVICE_TOKEN=".length).trim())
  .map((value) => {
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  });

if (values.length !== 1 || values[0].length < 32) {
  process.stderr.write("VIOLET_DEVICE_TOKEN is missing or invalid.\n");
  process.exit(1);
}
process.stdout.write(values[0]);
NODE
