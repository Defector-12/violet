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

case "$1" in
  /*) input_path=$1 ;;
  *) input_path=$PWD/$1 ;;
esac
case "$2" in
  /*) output_path=$2 ;;
  *) output_path=$PWD/$2 ;;
esac

exec pnpm --filter @violet/backup-service exec node dist/main.js decrypt "$input_path" "$output_path"
