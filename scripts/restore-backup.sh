#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  printf 'Usage: %s <input.vltbk> <output.dump> <instance-id>\n' "$0" >&2
  exit 64
fi

if [ -z "${VIOLET_BACKUP_PRIVATE_KEY:-}${VIOLET_BACKUP_PRIVATE_KEY_FILE:-}" ]; then
  printf 'VIOLET_BACKUP_PRIVATE_KEY or VIOLET_BACKUP_PRIVATE_KEY_FILE is required\n' >&2
  exit 64
fi

case "$1" in
  /*) input_path=$1 ;;
  *) input_path=$PWD/$1 ;;
esac
case "$2" in
  /*) output_path=$2 ;;
  *) output_path=$PWD/$2 ;;
esac

exec fnm exec --using=.node-version -- pnpm --filter @violet/backup-service exec \
  node dist/main.js decrypt "$input_path" "$output_path" "$3"
