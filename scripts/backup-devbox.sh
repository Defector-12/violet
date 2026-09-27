#!/usr/bin/env bash
set -euo pipefail

compose_file=${VIOLET_COMPOSE_FILE:-infra/compose/compose.yaml}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}
upload=${VIOLET_BACKUP_UPLOAD:-true}
cleanup_only=false
if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_only=true
elif [ "$#" -ne 0 ]; then
  printf 'Usage: %s [--cleanup-only]\n' "$0" >&2
  exit 64
fi
case "$upload" in
  true | false) ;;
  *)
    printf 'VIOLET_BACKUP_UPLOAD must be true or false\n' >&2
    exit 64
    ;;
esac

if docker info >/dev/null 2>&1; then
  use_sudo=false
elif sudo -n docker info >/dev/null 2>&1; then
  use_sudo=true
else
  printf 'Docker is unavailable without interactive elevation\n' >&2
  exit 1
fi

run_compose() {
  if [ "$use_sudo" = true ]; then
    sudo -n env \
      VIOLET_DATA_DIR="$data_dir" \
      VIOLET_RUNTIME_SECRETS_DIR="$runtime_secrets_dir" \
      VIOLET_BACKUP_UID="$(id -u)" \
      VIOLET_BACKUP_GID="$(id -g)" \
      docker compose -f "$compose_file" "$@"
  else
    VIOLET_DATA_DIR="$data_dir" \
    VIOLET_RUNTIME_SECRETS_DIR="$runtime_secrets_dir" \
    VIOLET_BACKUP_UID="$(id -u)" \
    VIOLET_BACKUP_GID="$(id -g)" \
      docker compose -f "$compose_file" "$@"
  fi
}

mkdir -p "$data_dir/backups"
# All official dump/upload/cleanup invocations hold the same host lock, including
# the upload after pg_dump exits. An older dump cannot arrive after a cleanup.
exec 9>"$data_dir/backups/.backup.lock"
command -v flock >/dev/null
flock -n 9 || exit 0
metadata_path=$(mktemp "$data_dir/backups/.backup-result.XXXXXX")
metadata_name=${metadata_path##*/}
cleanup=false
sql() {
  run_compose exec -T postgres psql -X -qAt --username violet --dbname violet \
    --set ON_ERROR_STOP=1 -c "$1"
}
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$cleanup" = true ]; then
    sql "UPDATE memory_deletions SET status = 'failed', failure_code = 'BACKUP_CLEANUP_FAILED'
         WHERE status = 'running'" >/dev/null || true
  fi
  rm -f "$metadata_path"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pending=$(sql "SELECT EXISTS (SELECT 1 FROM memory_deletions WHERE status IN ('pending', 'running'))")
if [ "$pending" = t ]; then
  cleanup=true
elif [ "$pending" != f ]; then
  printf 'Backup cleanup state is invalid\n' >&2
  exit 1
elif [ "$cleanup_only" = true ]; then
  exit 0
fi
if [ "$cleanup" = true ]; then
  sql "UPDATE memory_deletions SET status = 'running', failure_code = NULL
       WHERE status IN ('pending', 'running')" >/dev/null
fi

set +e
run_compose exec -T postgres \
  psql -X -qAt --username violet --dbname violet --file - <"$(dirname "$0")/backup-snapshot.sql" |
  run_compose --profile operations run --rm --no-deps -T backup >"$metadata_path"
statuses=("${PIPESTATUS[@]}")
set -e

if [ "${statuses[0]}" -ne 0 ] || [ "${statuses[1]}" -ne 0 ]; then
  backup_path=$(sed -n 's/.*"localPath":"\([^"]*\.vltbk\)".*/\1/p' "$metadata_path")
  if [ -n "$backup_path" ]; then
    rm -f "$data_dir/backups/${backup_path##*/}"
  fi
  printf 'Backup failed: pg_dump=%s encryption=%s\n' "${statuses[0]}" "${statuses[1]}" >&2
  exit 1
fi

if [ "$upload" = true ]; then
  cleanup_args=()
  if [ "$cleanup" = true ]; then cleanup_args=(--cleanup); fi
  run_compose --profile operations run --rm --no-deps -T backup-upload \
    upload-existing "/var/lib/violet/backups/$metadata_name" "${cleanup_args[@]}"
  if [ "$cleanup" = true ]; then
    sql "UPDATE memory_deletions SET status = 'complete', failure_code = NULL
         WHERE status = 'running'" >/dev/null
  fi
else
  cat "$metadata_path"
  if [ "$cleanup" = true ]; then
    printf 'Cleanup requires a verified remote backup; online deletion is preserved\n' >&2
    exit 1
  fi
fi
