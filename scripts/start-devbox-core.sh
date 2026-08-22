#!/bin/sh
set -eu

compose_file=${VIOLET_COMPOSE_FILE:-infra/compose/compose.yaml}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}
version=${VIOLET_VERSION:-0.1.0-dev}

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
      VIOLET_VERSION="$version" \
      docker compose -f "$compose_file" "$@"
  else
    VIOLET_DATA_DIR="$data_dir" \
    VIOLET_RUNTIME_SECRETS_DIR="$runtime_secrets_dir" \
    VIOLET_VERSION="$version" \
      docker compose -f "$compose_file" "$@"
  fi
}

run_docker() {
  if [ "$use_sudo" = true ]; then
    sudo -n docker "$@"
  else
    docker "$@"
  fi
}

wait_until_healthy() {
  service=$1
  container_id=$(run_compose --profile sealed ps -q "$service")
  if [ -z "$container_id" ]; then
    printf 'Container for %s was not created\n' "$service" >&2
    exit 1
  fi
  for attempt in $(seq 1 30); do
    status=$(run_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
    [ "$status" = healthy ] && return
    sleep 2
  done
  printf '%s did not become healthy\n' "$service" >&2
  exit 1
}

mode=${1:-auto}
if [ "$mode" = auto ]; then
  if
    [ -s "$runtime_secrets_dir/content_key" ] &&
      [ -s "$runtime_secrets_dir/database_url" ] &&
      [ -s "$runtime_secrets_dir/deepseek_api_key" ] &&
      [ -s "$runtime_secrets_dir/qwen_realtime_api_key" ]
  then
    mode=ready
  else
    mode=sealed
  fi
fi

case "$mode" in
  ready)
    run_compose stop core >/dev/null 2>&1 || true
    run_compose --profile sealed up -d --no-deps core-sealed
    wait_until_healthy core-sealed
    run_compose --profile sealed stop core-sealed
    run_compose rm -sf core migrate postgres lgtm
    run_compose up -d core lgtm
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
