#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/apps/macos/.build/app/Violet.app"
EXECUTABLE="${APP_DIR}/Contents/MacOS/Violet"
OUTPUT="${1:-${ROOT_DIR}/.local-acceptance/realtime-$(date +%Y%m%d-%H%M%S).ndjson}"

if [[ $# -gt 2 || ( $# -eq 2 && "$2" != "--record-pointing" ) ]]; then
  printf 'Usage: %s [events.ndjson] [--record-pointing]\n' "$0" >&2
  exit 1
fi
if [[ "${2:-}" == "--record-pointing" ]]; then
  REPLAY_DIR="${OUTPUT%.ndjson}-pointing"
  if [[ -e "${REPLAY_DIR}" ]]; then
    printf 'Replay directory already exists; choose a new acceptance output.\n' >&2
    exit 1
  fi
fi

if [[ ! -x "${EXECUTABLE}" ]]; then
  printf 'Build the app first with: pnpm macos:app\n' >&2
  exit 1
fi

if pgrep -f "${EXECUTABLE}" >/dev/null; then
  printf 'Quit the running Violet app before starting an acceptance run.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT}")"
open -n -g \
  --stdout /dev/null \
  --stderr /dev/null \
  --env "VIOLET_ACCEPTANCE_LOG=${OUTPUT}" \
  --env "VIOLET_POINTING_REPLAY_DIR=${REPLAY_DIR:-}" \
  "${APP_DIR}"

printf 'Violet acceptance run started.\n'
printf 'Event log: %s\n' "${OUTPUT}"
printf 'Report: pnpm acceptance:report -- %q\n' "${OUTPUT}"
if [[ -n "${REPLAY_DIR:-}" ]]; then
  printf 'One-shot pointing capture armed for 15 minutes: %s/case.json\n' "${REPLAY_DIR}"
fi
