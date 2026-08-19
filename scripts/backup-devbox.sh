#!/bin/sh
set -eu

compose_file=${VIOLET_COMPOSE_FILE:-infra/compose/compose.yaml}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}
upload=${VIOLET_BACKUP_UPLOAD:-true}
case "$upload" in
  true) backup_service=backup-upload ;;
  false) backup_service=backup ;;
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

run_docker() {
  if [ "$use_sudo" = true ]; then
    sudo -n docker "$@"
  else
    docker "$@"
  fi
}

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

run_compose exec -T postgres \
  pg_dump --username violet --dbname violet --format custom --compress=0 |
  run_compose --profile operations run --rm --no-deps -T "$backup_service"
