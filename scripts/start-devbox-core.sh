#!/bin/sh
set -eu

compose_file=${VIOLET_COMPOSE_FILE:-infra/compose/compose.yaml}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}

if docker info >/dev/null 2>&1; then
  docker_command=docker
elif sudo -n docker info >/dev/null 2>&1; then
  docker_command='sudo -n docker'
else
  printf 'Docker is unavailable without interactive elevation\n' >&2
  exit 1
fi

run_compose() {
  VIOLET_DATA_DIR="$data_dir" \
  VIOLET_RUNTIME_SECRETS_DIR="$runtime_secrets_dir" \
    $docker_command compose -f "$compose_file" "$@"
}

mode=${1:-auto}
if [ "$mode" = auto ]; then
  if
    [ -s "$runtime_secrets_dir/content_key" ] &&
      [ -s "$runtime_secrets_dir/database_url" ] &&
      [ -s "$runtime_secrets_dir/deepseek_api_key" ]
  then
    mode=ready
  else
    mode=sealed
  fi
fi

case "$mode" in
  ready)
    run_compose --profile sealed stop core-sealed >/dev/null 2>&1 || true
    run_compose --profile sealed create core-sealed
    run_compose up -d core
    ;;
  sealed)
    run_compose stop core >/dev/null 2>&1 || true
    run_compose --profile sealed up -d --no-deps core-sealed
    ;;
  *)
    printf 'Usage: %s [auto|ready|sealed]\n' "$0" >&2
    exit 64
    ;;
esac
