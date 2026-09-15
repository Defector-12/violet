#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${ROOT}/apps/macos/.build/app/Violet.app"
if [[ $# -ne 1 ]]; then
  printf 'Usage: bash scripts/start-test-run.sh <case-name>\n' >&2
  exit 1
fi
if pgrep -x Violet >/dev/null; then
  printf 'Violet is running. End the conversation and quit it before starting a recorded test.\n' >&2
  exit 1
fi
if [[ ! -x "${APP}/Contents/MacOS/Violet" ]]; then
  printf 'Build Violet first using the repository toolchain.\n' >&2
  exit 1
fi
cd "${ROOT}"
RUN="$(fnm exec --using=.node-version -- node scripts/test-run.mjs create human "$1")"
open -n -g \
  --env "VIOLET_TEST_RUN_DIR=${RUN}" \
  --env "VIOLET_ACCEPTANCE_LOG=${RUN}/acceptance.ndjson" \
  --env "VIOLET_POINTING_REPLAY_DIR=" \
  "${APP}"
printf 'Prepared test run: %s\n' "${RUN}"
printf 'Mac and Core must report trace.ready before a recorded conversation starts.\n'
printf 'Report: fnm exec --using=.node-version -- node scripts/test-run.mjs report %q\n' "${RUN}"
