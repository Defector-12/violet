#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/apps/macos/.build/app/Violet.app"
EXECUTABLE="${APP_DIR}/Contents/MacOS/Violet"
OUTPUT="${1:-${ROOT_DIR}/.local-acceptance/realtime-$(date +%Y%m%d-%H%M%S).ndjson}"

if [[ ! -x "${EXECUTABLE}" ]]; then
  printf 'Build the app first with: pnpm macos:app\n' >&2
  exit 1
fi

if pgrep -f "${EXECUTABLE}" >/dev/null; then
  printf 'Quit the running Violet app before starting an acceptance run.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT}")"
VIOLET_ACCEPTANCE_LOG="${OUTPUT}" nohup "${EXECUTABLE}" >/dev/null 2>&1 &

printf 'Violet acceptance run started.\n'
printf 'Event log: %s\n' "${OUTPUT}"
printf 'Report: pnpm acceptance:report -- %q\n' "${OUTPUT}"
