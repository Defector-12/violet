#!/bin/sh
set -eu

repo_dir=${VIOLET_REPO_DIR:-$PWD}
data_dir=${VIOLET_DATA_DIR:-/data00/violet}
runtime_secrets_dir=${VIOLET_RUNTIME_SECRETS_DIR:-/dev/shm/violet}
marker='# violet-backup'
flock_command=$(command -v flock)
env_command=$(command -v env)

case "$repo_dir:$data_dir:$runtime_secrets_dir" in
  *"'"* | *"
"*)
    printf 'Violet paths must not contain quotes or newlines\n' >&2
    exit 64
    ;;
esac

mkdir -p "$data_dir/backups"
entry="17 3 * * * cd '$repo_dir' && $flock_command -n /tmp/violet-backup.lock $env_command VIOLET_DATA_DIR='$data_dir' VIOLET_RUNTIME_SECRETS_DIR='$runtime_secrets_dir' VIOLET_BACKUP_UPLOAD=true ./scripts/backup-devbox.sh >> '$data_dir/backups/backup-cron.log' 2>&1 $marker"
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT

crontab -l 2>/dev/null | sed "\\|$marker$|d" > "$temporary" || true
printf '%s\n' "$entry" >> "$temporary"
crontab "$temporary"
