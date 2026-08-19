#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s <input.vltbk> <output.dump>\n' "$0" >&2
  exit 64
fi

if [ -z "${VIOLET_BACKUP_PRIVATE_KEY:-}" ]; then
  printf 'VIOLET_BACKUP_PRIVATE_KEY is required\n' >&2
  exit 64
fi

exec pnpm --filter @violet/backup-service exec node dist/main.js decrypt "$1" "$2"
