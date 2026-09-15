#!/usr/bin/env bash
set -euo pipefail

compose_file=${VIOLET_COMPOSE_FILE:-infra/compose/compose.yaml}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}
upload=${VIOLET_BACKUP_UPLOAD:-true}
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
metadata_path=$(mktemp "$data_dir/backups/.backup-result.XXXXXX")
metadata_name=${metadata_path##*/}
trap 'rm -f "$metadata_path"' EXIT

set +e
run_compose exec -T postgres \
  pg_dump --username violet --dbname violet --format custom --compress=0 |
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
  run_compose --profile operations run --rm --no-deps -T backup-upload \
    upload-existing "/var/lib/violet/backups/$metadata_name"
else
  cat "$metadata_path"
fi
